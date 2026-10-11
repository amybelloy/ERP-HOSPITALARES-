'use strict';
/**
 * FATURAMENTO DE CONVÊNIOS
 * Contas de convênio conferidas e fechadas são agrupadas em REMESSAS (lotes) por operadora/competência.
 * O retorno da operadora registra o valor pago e a glosa de cada conta; o valor pago entra como
 * pagamento "CONVENIO" aguardando conferência do financeiro (mesma regra de quitação das demais formas).
 */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const payments = require('./paymentService');
const { validator } = require('../lib/validate');
const { notFound, unprocessable, badRequest } = require('../lib/errors');

async function convenioAccounts(f = {}) {
  const params = []; const where = [`ap.modality = 'CONVENIO'`, `ac.financial_status <> 'CANCELADA'`];
  if (f.insurance_plan_id) { params.push(f.insurance_plan_id); where.push(`ap.insurance_plan_id = $${params.length}`); }
  if (f.billing_status) { params.push(f.billing_status); where.push(`ac.billing_status = $${params.length}`); }
  if (f.from) { params.push(f.from); where.push(`ap.opened_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`ap.opened_at < ($${params.length}::date + interval '1 day')`); }
  const { rows } = await pool.query(
    `SELECT ac.id, ac.number, ac.total_cents, ac.received_cents, (ac.total_cents - ac.received_cents) AS balance_cents, ac.financial_status,
            ac.billing_status, ac.checked_at, ap.number AS appointment_number, ap.opened_at, ap.insurance_plan_id, ip.name AS insurance_name,
            p.name AS patient_name, p.insurance_card_number, bb.number AS batch_number, bb.status AS batch_status,
            COALESCE((SELECT string_agg(ai.description, ', ') FROM account_items ai WHERE ai.account_id = ac.id AND ai.status = 'ATIVO'), '') AS procedures
       FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
       JOIN insurance_plans ip ON ip.id = ap.insurance_plan_id LEFT JOIN billing_batches bb ON bb.id = ac.billing_batch_id
      WHERE ${where.join(' AND ')} ORDER BY ip.name, ap.opened_at DESC LIMIT 500`, params);
  return rows;
}

async function createBatch(body, ctx) {
  const v = validator(body);
  const planId = v.id('insurance_plan_id', { required: true, label: 'Convênio' });
  const competence = v.string('competence', { required: true, pattern: /^\d{4}-(0[1-9]|1[0-2])$/, label: 'Competência (AAAA-MM)' });
  const notes = v.string('notes', { max: 1000 });
  const ids = Array.isArray(body.account_ids) ? [...new Set(body.account_ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (!ids.length) v.fail('account_ids', 'Selecione ao menos uma conta.');
  v.done();
  return withTransaction(async (c) => {
    const { rows: accs } = await c.query(
      `SELECT ac.*, ap.modality, ap.insurance_plan_id FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id WHERE ac.id = ANY($1) ORDER BY ac.id FOR UPDATE OF ac`, [ids]);
    if (accs.length !== ids.length) throw notFound('Conta não encontrada.');
    const problems = [];
    for (const a of accs) {
      if (a.modality !== 'CONVENIO' || String(a.insurance_plan_id) !== String(planId)) problems.push(`${a.number}: não é do convênio selecionado`);
      else if (a.billing_status !== 'FECHADA') problems.push(`${a.number}: precisa estar conferida e fechada`);
      else if (a.billing_batch_id) problems.push(`${a.number}: já está em outra remessa`);
      else if (a.total_cents - a.received_cents <= 0) problems.push(`${a.number}: sem saldo a faturar`);
    }
    if (problems.length) throw unprocessable('Contas inválidas para a remessa.', { contas: problems.join('; ') });
    const total = accs.reduce((s, a) => s + (a.total_cents - a.received_cents), 0);
    const { rows: [b] } = await c.query(
      `INSERT INTO billing_batches (insurance_plan_id, competence, total_cents, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [planId, competence, total, notes, ctx.user.id]);
    for (const a of accs) {
      await c.query('INSERT INTO billing_batch_items (batch_id, account_id, billed_cents) VALUES ($1,$2,$3)', [b.id, a.id, a.total_cents - a.received_cents]);
      await c.query('UPDATE accounts SET billing_batch_id = $2, updated_at = now() WHERE id = $1', [a.id, b.id]);
    }
    await audit(c, ctx, 'REMESSA_CRIADA', 'billing_batches', b.id, { numero: b.number, contas: accs.length, total_cents: total, competencia: competence });
    return b;
  });
}

async function lockBatch(c, id) {
  const { rows: [b] } = await c.query('SELECT * FROM billing_batches WHERE id = $1 FOR UPDATE', [id]);
  if (!b) throw notFound('Remessa não encontrada.');
  return b;
}

async function sendBatch(id, body, ctx) {
  const v = validator(body); const protocol = v.string('protocol', { max: 60, label: 'Protocolo' }); v.done();
  return withTransaction(async (c) => {
    const b = await lockBatch(c, id);
    if (b.status !== 'ABERTA') throw unprocessable('Somente remessas abertas podem ser enviadas.');
    await c.query(`UPDATE accounts SET billing_status = 'FATURADA', updated_at = now() WHERE billing_batch_id = $1`, [id]);
    const { rows: [u] } = await c.query(`UPDATE billing_batches SET status = 'ENVIADA', protocol = $2, sent_at = now() WHERE id = $1 RETURNING *`, [id, protocol]);
    await audit(c, ctx, 'REMESSA_ENVIADA', 'billing_batches', id, { numero: b.number, protocolo: protocol });
    return u;
  });
}

async function cancelBatch(id, body, ctx) {
  const v = validator(body); const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' }); v.done();
  return withTransaction(async (c) => {
    const b = await lockBatch(c, id);
    if (b.status !== 'ABERTA') throw unprocessable('Somente remessas ainda não enviadas podem ser canceladas.');
    await c.query('UPDATE accounts SET billing_batch_id = NULL, updated_at = now() WHERE billing_batch_id = $1', [id]);
    const { rows: [u] } = await c.query(`UPDATE billing_batches SET status = 'CANCELADA', notes = concat_ws(' | ', notes, $2::text) WHERE id = $1 RETURNING *`, [id, `Cancelada: ${reason}`]);
    await audit(c, ctx, 'REMESSA_CANCELADA', 'billing_batches', id, { motivo: reason });
    return u;
  });
}

/** Retorno da operadora: valor pago e glosa por conta. */
async function registerReturn(id, body, ctx) {
  if (!Array.isArray(body.items) || !body.items.length) throw badRequest('Informe o retorno de cada conta.');
  const parsed = body.items.map((it, i) => {
    const v = validator(it);
    const r = { account_id: v.id('account_id', { required: true }), paid_cents: v.cents('paid_cents', { required: true, allowZero: true, label: `Conta ${i + 1}: valor pago` }),
      glosa_cents: v.cents('glosa_cents', { allowZero: true, label: `Conta ${i + 1}: glosa` }) || 0, glosa_reason: v.string('glosa_reason', { max: 500, label: 'Motivo da glosa' }) };
    if (r.glosa_cents > 0 && !r.glosa_reason) v.fail('glosa_reason', `Conta ${i + 1}: informe o motivo da glosa.`);
    v.done();
    return r;
  });
  // 1) valida e grava o retorno dentro de transação
  const batch = await withTransaction(async (c) => {
    const b = await lockBatch(c, id);
    if (b.status !== 'ENVIADA') throw unprocessable('O retorno só pode ser registrado para remessas enviadas.');
    const { rows: items } = await c.query('SELECT i.*, ac.number AS account_number FROM billing_batch_items i JOIN accounts ac ON ac.id = i.account_id WHERE i.batch_id = $1 FOR UPDATE OF i', [id]);
    if (parsed.length !== items.length || items.some((it) => !parsed.find((p) => p.account_id === Number(it.account_id)))) {
      throw unprocessable('Informe o retorno de todas as contas da remessa.');
    }
    let paid = 0; let glosa = 0;
    for (const it of items) {
      const p = parsed.find((x) => x.account_id === Number(it.account_id));
      if (p.paid_cents + p.glosa_cents > it.billed_cents) throw unprocessable(`Conta ${it.account_number}: pago + glosa maior que o valor faturado.`);
      await c.query('UPDATE billing_batch_items SET paid_cents = $2, glosa_cents = $3, glosa_reason = $4 WHERE id = $1', [it.id, p.paid_cents, p.glosa_cents, p.glosa_reason]);
      paid += p.paid_cents; glosa += p.glosa_cents;
    }
    const { rows: [u] } = await c.query(`UPDATE billing_batches SET status = 'RETORNO_REGISTRADO', paid_cents = $2, glosa_cents = $3, returned_at = now() WHERE id = $1 RETURNING *`, [id, paid, glosa]);
    await audit(c, ctx, 'REMESSA_RETORNO', 'billing_batches', id, { pago_cents: paid, glosa_cents: glosa });
    return u;
  });
  // 2) cria os repasses como pagamentos aguardando conferência do financeiro
  for (const p of parsed.filter((x) => x.paid_cents > 0)) {
    const pay = await payments.start(p.account_id, { method: 'CONVENIO', amount_cents: p.paid_cents, manual_reference: `Remessa ${batch.number}`, method_label: 'Repasse de convênio' }, ctx);
    await pool.query('UPDATE billing_batch_items SET payment_id = $3 WHERE batch_id = $1 AND account_id = $2', [id, p.account_id, pay.id]);
  }
  return get(id);
}

async function list() {
  const { rows } = await pool.query(
    `SELECT b.*, ip.name AS insurance_name, u.name AS created_by_name, (SELECT count(*)::int FROM billing_batch_items i WHERE i.batch_id = b.id) AS accounts
       FROM billing_batches b JOIN insurance_plans ip ON ip.id = b.insurance_plan_id JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 200`);
  return rows;
}

async function get(id) {
  const { rows: [b] } = await pool.query(
    `SELECT b.*, ip.name AS insurance_name FROM billing_batches b JOIN insurance_plans ip ON ip.id = b.insurance_plan_id WHERE b.id = $1`, [id]);
  if (!b) throw notFound('Remessa não encontrada.');
  const { rows: items } = await pool.query(
    `SELECT i.*, ac.number AS account_number, ac.financial_status, ap.number AS appointment_number, p.name AS patient_name, p.insurance_card_number, py.status AS payment_status
       FROM billing_batch_items i JOIN accounts ac ON ac.id = i.account_id JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
       LEFT JOIN payments py ON py.id = i.payment_id WHERE i.batch_id = $1 ORDER BY i.id`, [id]);
  return { ...b, items };
}

module.exports = { convenioAccounts, createBatch, sendBatch, cancelBatch, registerReturn, list, get };
