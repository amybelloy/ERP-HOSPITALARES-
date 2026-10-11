'use strict';
/**
 * CONCILIAÇÃO FINANCEIRA
 * Compara os pagamentos registrados no sistema com as transações informadas pelo banco/provedor
 * (importadas via API do provedor ou arquivo CSV). Divergências são registradas para análise e
 * NUNCA apagam os registros originais.
 */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { pixProvider } = require('../integrations');
const { parseCSV } = require('../lib/csv');
const { toCents } = require('../lib/money');
const { validator } = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');

const dayStart = (d) => new Date(`${d}T00:00:00.000Z`);
const dayEnd = (d) => new Date(`${d}T23:59:59.999Z`);

async function insertEntry(c, e, ctx, batch) {
  const { rowCount } = await c.query(
    `INSERT INTO bank_statement_entries (provider, external_id, kind, txid, amount_cents, occurred_at, description, raw, import_batch, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT ON CONSTRAINT bank_statement_entries_uq DO NOTHING`,
    [e.provider, e.externalId, e.kind, e.txid || null, e.amountCents, e.occurredAt, e.description || null, e.raw || null, batch, ctx.user?.id || null]);
  return rowCount;
}

/** Importa as transações do provedor Pix (GET /pix) para o período. */
async function importFromProvider(body, ctx) {
  const v = validator(body);
  const from = v.date('from', { required: true, label: 'Data inicial' });
  const to = v.date('to', { required: true, label: 'Data final' });
  v.done();
  const provider = pixProvider();
  const received = await provider.listReceived({ from: dayStart(from), to: dayEnd(to) });
  const batch = `API-${provider.name}-${Date.now()}`;
  let inserted = 0;
  await withTransaction(async (c) => {
    for (const p of received) {
      inserted += await insertEntry(c, { provider: provider.name, externalId: p.endToEndId, kind: 'CREDITO', txid: p.txid, amountCents: p.amountCents, occurredAt: p.paidAt, raw: p }, ctx, batch);
      for (const r of p.refunds || []) {
        if (r.status === 'DEVOLVIDO') inserted += await insertEntry(c, { provider: provider.name, externalId: r.id, kind: 'DEVOLUCAO', txid: p.txid, amountCents: r.amountCents, occurredAt: r.requestedAt || p.paidAt, raw: { ...r, endToEndId: p.endToEndId } }, ctx, batch);
      }
    }
    await audit(c, ctx, 'CONCILIACAO_IMPORTACAO_API', 'bank_statement_entries', batch, { provedor: provider.name, periodo: { from, to }, lidos: received.length, novos: inserted });
  });
  return { batch, read: received.length, inserted };
}

/**
 * Importa extrato CSV. Colunas: external_id;txid;valor;data;tipo[;descricao]
 * tipo = CREDITO | DEVOLUCAO ; valor = 500,00 ; data = ISO 8601
 */
async function importCSV(body, ctx) {
  const v = validator(body);
  const provider = v.string('provider', { required: true, max: 30, label: 'Provedor' });
  const csv = v.string('csv', { required: true, max: 5_000_000, label: 'Arquivo CSV', trim: false });
  v.done();
  const rows = parseCSV(csv);
  if (!rows.length) throw badRequest('Arquivo sem linhas.');
  const errors = [];
  const entries = rows.map((r, i) => {
    try {
      const kind = (r.tipo || 'CREDITO').toUpperCase();
      if (!['CREDITO', 'DEVOLUCAO'].includes(kind)) throw new Error('tipo inválido');
      if (!r.external_id) throw new Error('external_id obrigatório');
      const d = new Date(r.data);
      if (Number.isNaN(d.getTime())) throw new Error('data inválida');
      return { provider, externalId: r.external_id, kind, txid: r.txid || null, amountCents: toCents(r.valor), occurredAt: d.toISOString(), description: r.descricao, raw: r };
    } catch (e) { errors.push({ linha: i + 2, erro: e.message }); return null; }
  });
  if (errors.length) throw badRequest('Erros no arquivo.', { linhas: errors.slice(0, 50) });
  const batch = `CSV-${provider}-${Date.now()}`;
  let inserted = 0;
  await withTransaction(async (c) => {
    for (const e of entries) inserted += await insertEntry(c, e, ctx, batch);
    await audit(c, ctx, 'CONCILIACAO_IMPORTACAO_CSV', 'bank_statement_entries', batch, { provedor: provider, linhas: entries.length, novos: inserted });
  });
  return { batch, read: entries.length, inserted };
}

/** Executa a conciliação do período e grava cada achado em bank_reconciliation. */
async function run(body, ctx) {
  const v = validator(body);
  const from = v.date('from', { required: true, label: 'Data inicial' });
  const to = v.date('to', { required: true, label: 'Data final' });
  v.done();
  const start = dayStart(from); const end = dayEnd(to);

  return withTransaction(async (c) => {
    const { rows: [runRow] } = await c.query('INSERT INTO reconciliation_runs (period_start, period_end, created_by) VALUES ($1,$2,$3) RETURNING *', [from, to, ctx.user.id]);
    const items = [];
    const push = (it) => items.push(it);

    const { rows: credits } = await c.query(`SELECT * FROM bank_statement_entries WHERE kind = 'CREDITO' AND occurred_at BETWEEN $1 AND $2`, [start, end]);
    const { rows: refundsStmt } = await c.query(`SELECT * FROM bank_statement_entries WHERE kind = 'DEVOLUCAO' AND occurred_at BETWEEN $1 AND $2`, [start, end]);
    // Liquidações eletrônicas registradas (exclui manuais: dinheiro / cartão sem TEF não aparecem no extrato Pix)
    const { rows: liq } = await c.query(
      `SELECT t.*, py.amount_cents AS payment_amount, py.status AS payment_status, py.provider_charge_id
         FROM payment_transactions t JOIN payments py ON py.id = t.payment_id
        WHERE t.kind IN ('LIQUIDACAO','LIQUIDACAO_DUPLICADA','DIVERGENCIA') AND t.provider <> 'MANUAL' AND py.method = 'PIX'
          AND t.occurred_at BETWEEN $1 AND $2`, [start, end]);
    const liqByE2E = new Map(liq.map((t) => [t.provider_transaction_id, t]));

    // Duplicidades no extrato por txid
    const byTxid = new Map();
    for (const e of credits) if (e.txid) byTxid.set(e.txid, [...(byTxid.get(e.txid) || []), e]);

    for (const e of credits) {
      const t = liqByE2E.get(e.external_id);
      if (!t) {
        const { rows: [py] } = e.txid ? await c.query('SELECT * FROM payments WHERE provider_charge_id = $1', [e.txid]) : { rows: [] };
        push({ category: 'SEM_CONTA', statement_entry_id: e.id, payment_id: py?.id || null, account_id: py?.account_id || null, found_cents: e.amount_cents,
          description: py ? `Crédito no banco para cobrança ${e.txid}, mas sem liquidação registrada no sistema (status do pagamento: ${py.status}).` : 'Crédito recebido no banco sem cobrança/conta associada.' });
        continue;
      }
      if ((byTxid.get(e.txid) || []).length > 1) {
        push({ category: 'DUPLICADA', statement_entry_id: e.id, payment_id: t.payment_id, account_id: t.account_id, expected_cents: t.payment_amount, found_cents: e.amount_cents,
          description: `Mais de um crédito no banco para a mesma cobrança (${e.txid}).` });
        continue;
      }
      if (e.amount_cents !== t.amount_cents || t.kind === 'DIVERGENCIA' || t.kind === 'LIQUIDACAO_DUPLICADA') {
        push({ category: t.kind === 'LIQUIDACAO_DUPLICADA' ? 'DUPLICADA' : 'VALOR_DIVERGENTE', statement_entry_id: e.id, payment_id: t.payment_id, account_id: t.account_id,
          expected_cents: t.payment_amount, found_cents: e.amount_cents, difference_cents: e.amount_cents - t.payment_amount,
          description: t.kind === 'LIQUIDACAO' ? 'Valor do extrato difere do valor registrado.' : `Liquidação marcada para análise (${t.kind}).` });
        continue;
      }
      push({ category: 'CONCILIADO', statement_entry_id: e.id, payment_id: t.payment_id, account_id: t.account_id, expected_cents: t.amount_cents, found_cents: e.amount_cents, description: 'Conferido.' });
    }

    const stmtIds = new Set(credits.map((e) => e.external_id));
    for (const t of liq) {
      if (!stmtIds.has(t.provider_transaction_id)) {
        push({ category: 'SEM_TRANSACAO_BANCARIA', payment_id: t.payment_id, account_id: t.account_id, expected_cents: t.amount_cents,
          description: `Pagamento confirmado no sistema (${t.provider_transaction_id}) sem crédito correspondente no extrato importado.` });
      }
    }

    const { rows: pend } = await c.query(
      `SELECT id, account_id, amount_cents, status FROM payments WHERE status IN ('PENDENTE','PROCESSANDO','AGUARDANDO_CONFERENCIA','DIVERGENTE','FALHA_COMUNICACAO')
          AND created_at BETWEEN $1 AND $2`, [start, end]);
    for (const p of pend) push({ category: 'PENDENTE', payment_id: p.id, account_id: p.account_id, expected_cents: p.amount_cents, description: `Pagamento em status ${p.status}.` });

    const { rows: refundsSys } = await c.query(
      `SELECT t.* FROM payment_transactions t WHERE t.kind = 'ESTORNO' AND t.occurred_at BETWEEN $1 AND $2`, [start, end]);
    const refundStmtIds = new Set(refundsStmt.map((r) => r.external_id));
    for (const r of refundsSys) {
      const inBank = refundStmtIds.has(r.provider_transaction_id) || r.provider === 'MANUAL';
      push({ category: 'ESTORNO', payment_id: r.payment_id, account_id: r.account_id, expected_cents: r.amount_cents, found_cents: inBank ? r.amount_cents : null,
        description: inBank ? `Estorno ${r.provider_transaction_id} registrado.` : `Estorno ${r.provider_transaction_id} registrado no sistema e não localizado no extrato.` });
    }
    const sysRefundIds = new Set(refundsSys.map((r) => r.provider_transaction_id));
    for (const r of refundsStmt) {
      if (!sysRefundIds.has(r.external_id)) push({ category: 'ESTORNO', statement_entry_id: r.id, found_cents: r.amount_cents, description: `Devolução ${r.external_id} no banco sem registro no sistema.` });
    }

    for (const it of items) {
      await c.query(
        `INSERT INTO bank_reconciliation (run_id, category, statement_entry_id, payment_id, account_id, expected_cents, found_cents, difference_cents, description, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [runRow.id, it.category, it.statement_entry_id || null, it.payment_id || null, it.account_id || null, it.expected_cents ?? null, it.found_cents ?? null,
          it.difference_cents ?? null, it.description, it.category === 'CONCILIADO' ? 'RESOLVIDA' : 'ABERTA']);
    }
    const summary = items.reduce((acc, it) => ({ ...acc, [it.category]: (acc[it.category] || 0) + 1 }), {});
    await c.query('UPDATE reconciliation_runs SET summary = $2 WHERE id = $1', [runRow.id, summary]);
    await audit(c, ctx, 'CONCILIACAO_EXECUTADA', 'reconciliation_runs', runRow.id, { periodo: { from, to }, resumo: summary });
    return { run_id: runRow.id, summary };
  });
}

async function runs() {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS created_by_name, (SELECT count(*) FROM bank_reconciliation b WHERE b.run_id = r.id AND b.status IN ('ABERTA','EM_ANALISE'))::int AS open_items
       FROM reconciliation_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT 50`);
  return rows;
}

async function items(runId, { category, status } = {}) {
  const params = [runId]; const where = ['b.run_id = $1'];
  if (category) { params.push(category); where.push(`b.category = $${params.length}`); }
  if (status) { params.push(status); where.push(`b.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT b.*, ac.number AS account_number, se.external_id, se.txid, se.occurred_at AS statement_date, u.name AS resolved_by_name
       FROM bank_reconciliation b LEFT JOIN accounts ac ON ac.id = b.account_id LEFT JOIN bank_statement_entries se ON se.id = b.statement_entry_id
       LEFT JOIN users u ON u.id = b.resolved_by WHERE ${where.join(' AND ')} ORDER BY b.category, b.id`, params);
  return rows;
}

async function resolve(itemId, body, ctx) {
  const v = validator(body);
  const status = v.oneOf('status', ['EM_ANALISE', 'RESOLVIDA', 'JUSTIFICADA'], { required: true, label: 'Status' });
  const note = v.string('resolution_note', { required: true, min: 5, max: 1000, label: 'Parecer' });
  v.done();
  return withTransaction(async (c) => {
    const { rows: [it] } = await c.query('SELECT * FROM bank_reconciliation WHERE id = $1 FOR UPDATE', [itemId]);
    if (!it) throw notFound('Item de conciliação não encontrado.');
    const { rows: [u] } = await c.query(
      `UPDATE bank_reconciliation SET status = $2::varchar, resolution_note = $3, resolved_by = $4, resolved_at = CASE WHEN $2::varchar = 'EM_ANALISE' THEN NULL ELSE now() END WHERE id = $1 RETURNING *`,
      [itemId, status, note, ctx.user.id]);
    await audit(c, ctx, 'CONCILIACAO_ITEM_TRATADO', 'bank_reconciliation', itemId, { de: it.status, para: status, parecer: note, categoria: it.category });
    return u;
  });
}

async function statement({ from, to }) {
  const { rows } = await pool.query(
    `SELECT * FROM bank_statement_entries WHERE ($1::date IS NULL OR occurred_at >= $1::date) AND ($2::date IS NULL OR occurred_at < $2::date + interval '1 day')
      ORDER BY occurred_at DESC LIMIT 500`, [from || null, to || null]);
  return rows;
}

module.exports = { importFromProvider, importCSV, run, runs, items, resolve, statement };
