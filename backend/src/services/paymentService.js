'use strict';
/**
 * RECEBIMENTO E CONFIRMAÇÃO DE PAGAMENTOS
 *
 * Regra de ouro: um pagamento só passa a CONFIRMADO quando há confirmação confiável:
 *   - Pix: cobrança reconsultada no provedor com status CONCLUIDA e o endToEndId presente;
 *   - Cartão via terminal: transação reconsultada no provedor com status APROVADA;
 *   - Dinheiro / cartão sem integração: conferência manual por OUTRO usuário autorizado.
 * Clicar em "Receber" apenas cria a cobrança/intenção (PENDENTE / PROCESSANDO / AGUARDANDO_CONFERENCIA).
 */
const QRCode = require('qrcode');
const config = require('../config');
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { recalculateAccount, lockAccount } = require('./settlementService');
const { pixProvider, cardProvider } = require('../integrations');
const { newTxid } = require('../integrations/pix/PixProvider');
const { validator } = require('../lib/validate');
const { has } = require('../middleware/auth');
const { notFound, unprocessable, forbidden, AppError } = require('../lib/errors');
const { formatBRL } = require('../lib/money');

const IN_FLIGHT = ['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA'];
const CARD_METHODS = ['CARTAO_CREDITO', 'CARTAO_DEBITO'];

async function inFlightCents(c, accountId, excludePaymentId = null) {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM payments WHERE account_id = $1 AND status = ANY($2) AND ($3::bigint IS NULL OR id <> $3)`,
    [accountId, IN_FLIGHT, excludePaymentId]);
  return Number(r.s);
}

async function lockPayment(c, paymentId) {
  const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  // Ordem de bloqueio padronizada: conta -> pagamento (evita deadlock)
  await lockAccount(c, p.account_id);
  const { rows: [locked] } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
  if (locked.account_id !== p.account_id) throw new AppError(409, 'CONCORRENCIA', 'Pagamento foi alterado concorrentemente. Tente novamente.');
  return locked;
}

// ---------------------------------------------------------------------------
// Início do recebimento
// ---------------------------------------------------------------------------
async function start(accountId, body, ctx) {
  const v = validator(body);
  const method = v.oneOf('method', ['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO', 'OUTRO'], { required: true, label: 'Forma de pagamento' });
  const amount = v.cents('amount_cents', { required: true, label: 'Valor' });
  const installments = v.int('installments', { min: 1, max: 12 }) || 1;
  const cardMode = v.oneOf('card_mode', ['TERMINAL', 'MANUAL']) || 'TERMINAL';
  const manualReference = v.string('manual_reference', { max: 100, label: 'NSU / autorização' });
  const methodLabel = v.string('method_label', { max: 80, label: 'Descrição do meio' });
  if (CARD_METHODS.includes(method) && cardMode === 'MANUAL' && !manualReference) v.fail('manual_reference', 'Informe o NSU/código de autorização do comprovante do terminal.');
  if (method === 'OUTRO' && !methodLabel) v.fail('method_label', 'Descreva o meio de pagamento.');
  if (method === 'CARTAO_DEBITO' && installments > 1) v.fail('installments', 'Débito não permite parcelamento.');
  v.done();

  const usesProvider = method === 'PIX' || (CARD_METHODS.includes(method) && cardMode === 'TERMINAL');
  const provider = method === 'PIX' ? pixProvider() : (usesProvider ? cardProvider() : null);
  const txid = method === 'PIX' ? newTxid() : null;

  // 1) Registra a intenção dentro de transação, validando o saldo disponível
  const payment = await withTransaction(async (c) => {
    const account = await lockAccount(c, accountId);
    if (account.financial_status === 'CANCELADA') throw unprocessable('Conta cancelada.');
    if (account.financial_status === 'QUITADA') throw unprocessable('Conta já quitada.');
    const balance = account.total_cents - account.received_cents;
    if (balance <= 0) throw unprocessable('Conta sem saldo devedor.');
    const available = balance - await inFlightCents(c, accountId);
    if (amount > available) {
      throw unprocessable(`Valor (${formatBRL(amount)}) maior que o saldo disponível para cobrança (${formatBRL(available)}). Verifique cobranças em andamento.`);
    }
    let status; let providerName;
    if (usesProvider) { status = method === 'PIX' ? 'PENDENTE' : 'PROCESSANDO'; providerName = provider.name; }
    else { status = 'AGUARDANDO_CONFERENCIA'; providerName = 'MANUAL'; }
    const { rows: [p] } = await c.query(
      `INSERT INTO payments (account_id, method, method_label, amount_cents, installments, status, provider, provider_charge_id, manual_reference, is_demo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [accountId, method, methodLabel, amount, installments, status, providerName, txid, manualReference, !!provider?.isDemo, ctx.user.id]);
    await audit(c, ctx, 'RECEBIMENTO_INICIADO', 'payments', p.id, { conta_id: accountId, metodo: method, valor_cents: amount, provedor: providerName, modo_cartao: CARD_METHODS.includes(method) ? cardMode : undefined });
    return p;
  });

  if (!usesProvider) {
    if (!config.manualPaymentsRequireConference && method === 'DINHEIRO') {
      return confer(payment.id, { approve: true, note: 'Conferência dispensada por configuração' }, ctx, { skipSecondUser: true });
    }
    return getPayment(payment.id);
  }

  // 2) Chama o provedor fora da transação (não segura bloqueio durante I/O externo)
  try {
    if (method === 'PIX') {
      const { rows: [acc] } = await pool.query(
        'SELECT ac.number, p.name, p.cpf FROM accounts ac JOIN patients p ON p.id = ac.patient_id WHERE ac.id = $1', [accountId]);
      const charge = await provider.createCharge({
        txid, amountCents: amount, expiresIn: config.pix.chargeExpirationSeconds,
        debtor: { name: acc.name, cpf: acc.cpf }, description: `Conta ${acc.number}`,
      });
      await pool.query(`UPDATE payments SET pix_copy_paste = $2, pix_location = $3, expires_at = $4, updated_at = now() WHERE id = $1`,
        [payment.id, charge.copyPaste, charge.location, charge.expiresAt]);
    } else {
      const t = await provider.startTransaction({ reference: `PAG-${payment.id}`, amountCents: amount, type: method === 'CARTAO_DEBITO' ? 'DEBITO' : 'CREDITO', installments });
      await pool.query('UPDATE payments SET provider_charge_id = $2, updated_at = now() WHERE id = $1', [payment.id, t.transactionId]);
    }
  } catch (err) {
    await pool.query(`UPDATE payments SET status = 'FALHA_COMUNICACAO', status_reason = $2, updated_at = now() WHERE id = $1`, [payment.id, err.message.slice(0, 500)]);
    await audit(null, ctx, 'RECEBIMENTO_FALHA_PROVEDOR', 'payments', payment.id, { erro: err.message });
    const e = new AppError(err.status || 502, err.code || 'FALHA_PROVEDOR',
      `Não foi possível comunicar com o provedor de pagamento. Nenhum valor foi confirmado. Detalhe: ${err.message}`);
    e.details = { payment_id: payment.id };
    throw e;
  }
  return getPayment(payment.id);
}

// ---------------------------------------------------------------------------
// Aplicação de confirmação vinda do provedor (Pix ou cartão)
// ---------------------------------------------------------------------------
/**
 * Registra uma liquidação confirmada. Idempotente: a mesma transação do provedor nunca é contada duas vezes.
 * @returns {{result: 'CONFIRMADO'|'DUPLICADO'|'DIVERGENTE'|'LIQUIDACAO_EXTRA'|'IGNORADO', payment}}
 */
async function applyConfirmation(c, paymentId, { providerTransactionId, amountCents, occurredAt, source, raw }, ctx) {
  const payment = await lockPayment(c, paymentId);
  const { rows: [acc] } = await c.query('SELECT * FROM accounts WHERE id = $1', [payment.account_id]);

  // Idempotência
  const { rows: dup } = await c.query(
    `SELECT id FROM payment_transactions WHERE provider = $1 AND kind IN ('LIQUIDACAO','LIQUIDACAO_DUPLICADA','DIVERGENCIA') AND provider_transaction_id = $2`,
    [payment.provider, providerTransactionId]);
  if (dup.length) return { result: 'DUPLICADO', payment };

  const insertTx = (kind, status) => c.query(
    `INSERT INTO payment_transactions (payment_id, account_id, appointment_id, kind, provider, provider_transaction_id, amount_cents, status, occurred_at, source, raw, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT ON CONSTRAINT payment_transactions_idem_uq DO NOTHING RETURNING id`,
    [payment.id, payment.account_id, acc.appointment_id, kind, payment.provider, providerTransactionId, amountCents, status, occurredAt || new Date(), source, raw || null, ctx?.user?.id || null]);

  if (['CONFIRMADO', 'ESTORNADO', 'ESTORNADO_PARCIAL'].includes(payment.status)) {
    // Uma segunda liquidação para a mesma cobrança: dinheiro a mais. Não conta; vai para análise/devolução.
    await insertTx('LIQUIDACAO_DUPLICADA', 'EM_ANALISE');
    await audit(c, ctx, 'PAGAMENTO_LIQUIDACAO_EXTRA', 'payments', payment.id, { transacao: providerTransactionId, valor_cents: amountCents });
    return { result: 'LIQUIDACAO_EXTRA', payment };
  }
  if (!['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA', 'FALHA_COMUNICACAO', 'EXPIRADO', 'CANCELADO', 'DIVERGENTE'].includes(payment.status)) {
    return { result: 'IGNORADO', payment };
  }

  const balance = acc.total_cents - acc.received_cents;
  let divergence = null;
  if (amountCents !== payment.amount_cents) divergence = `Valor liquidado (${formatBRL(amountCents)}) difere do valor cobrado (${formatBRL(payment.amount_cents)}).`;
  else if (acc.financial_status === 'CANCELADA') divergence = 'Pagamento recebido para conta cancelada.';
  else if (amountCents > balance) divergence = `Valor liquidado excede o saldo devedor atual (${formatBRL(balance)}).`;

  if (divergence) {
    await insertTx('DIVERGENCIA', 'EM_ANALISE');
    const { rows: [p] } = await c.query(`UPDATE payments SET status = 'DIVERGENTE', status_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`, [payment.id, divergence]);
    await audit(c, ctx, 'PAGAMENTO_DIVERGENTE', 'payments', payment.id, { motivo: divergence, transacao: providerTransactionId });
    return { result: 'DIVERGENTE', payment: p };
  }

  await insertTx('LIQUIDACAO', 'CONFIRMADA');
  const { rows: [p] } = await c.query(
    `UPDATE payments SET status = 'CONFIRMADO', confirmation_source = $2, confirmed_at = $3, status_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
    [payment.id, source, occurredAt || new Date()]);
  await audit(c, ctx, 'PAGAMENTO_CONFIRMADO', 'payments', payment.id, { origem: source, transacao: providerTransactionId, valor_cents: amountCents, conta_id: payment.account_id });
  await recalculateAccount(c, payment.account_id, { source, paymentId: payment.id, ctx });
  return { result: 'CONFIRMADO', payment: p };
}

async function markStatus(c, paymentId, status, reason, kind, providerTxId, ctx) {
  const payment = await lockPayment(c, paymentId);
  if (!IN_FLIGHT.includes(payment.status) && payment.status !== 'FALHA_COMUNICACAO') return payment;
  const { rows: [acc] } = await c.query('SELECT appointment_id FROM accounts WHERE id = $1', [payment.account_id]);
  if (kind) {
    await c.query(
      `INSERT INTO payment_transactions (payment_id, account_id, appointment_id, kind, provider, provider_transaction_id, amount_cents, status, occurred_at, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10) ON CONFLICT ON CONSTRAINT payment_transactions_idem_uq DO NOTHING`,
      [payment.id, payment.account_id, acc.appointment_id, kind, payment.provider, providerTxId || `${kind}-${payment.id}`, payment.amount_cents, status, 'CONSULTA_PROVEDOR', ctx?.user?.id || null]);
  }
  const { rows: [p] } = await c.query(`UPDATE payments SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`, [paymentId, status, reason]);
  await audit(c, ctx, `PAGAMENTO_${status}`, 'payments', paymentId, { motivo: reason });
  return p;
}

// ---------------------------------------------------------------------------
// Pix: processa uma cobrança a partir da CONSULTA ao provedor (nunca do payload do webhook)
// ---------------------------------------------------------------------------
async function syncPixCharge(providerName, txid, source, ctx) {
  const provider = pixProvider(providerName);
  const { rows: [payment] } = await pool.query('SELECT * FROM payments WHERE provider = $1 AND provider_charge_id = $2', [providerName, txid]);
  if (!payment) return { result: 'SEM_COBRANCA' };
  const charge = await provider.getCharge(txid); // pode lançar erro de comunicação
  if (!charge) return { result: 'NAO_ENCONTRADA_NO_PROVEDOR', payment };

  const results = [];
  for (const pix of charge.pix || []) {
    results.push(await withTransaction((c) => applyConfirmation(c, payment.id, {
      providerTransactionId: pix.endToEndId, amountCents: pix.amountCents, occurredAt: pix.paidAt, source, raw: { endToEndId: pix.endToEndId, txid },
    }, ctx)));
    for (const r of pix.refunds || []) {
      if (r.status === 'DEVOLVIDO') results.push(await withTransaction((c) => applyRefund(c, payment.id, { refundId: r.id, amountCents: r.amountCents, source, raw: r }, ctx)));
    }
  }
  if (!charge.pix?.length && ['REMOVIDA_PELO_PSP', 'REMOVIDA_PELO_USUARIO_RECEBEDOR'].includes(charge.status)) {
    const status = charge.status === 'REMOVIDA_PELO_PSP' ? 'EXPIRADO' : 'CANCELADO';
    results.push({ result: status, payment: await withTransaction((c) => markStatus(c, payment.id, status, `Cobrança ${charge.status} no provedor`, 'CANCELAMENTO', `${status}-${txid}`, ctx)) });
  }
  return { result: results.length ? results[results.length - 1].result : 'SEM_ALTERACAO', results, chargeStatus: charge.status };
}

// ---------------------------------------------------------------------------
// Cartão: processa a transação a partir da CONSULTA ao provedor/terminal
// ---------------------------------------------------------------------------
async function syncCardTransaction(providerName, transactionId, source, ctx) {
  const provider = cardProvider(providerName);
  const { rows: [payment] } = await pool.query('SELECT * FROM payments WHERE provider = $1 AND provider_charge_id = $2', [providerName, transactionId]);
  if (!payment) return { result: 'SEM_COBRANCA' };
  const t = await provider.getTransaction(transactionId);
  if (!t) return { result: 'NAO_ENCONTRADA_NO_PROVEDOR', payment };
  if (t.status === 'APROVADA') {
    return withTransaction((c) => applyConfirmation(c, payment.id, {
      providerTransactionId: t.nsu ? `NSU-${t.nsu}` : transactionId, amountCents: t.amountCents, source,
      raw: { transactionId, nsu: t.nsu, authorizationCode: t.authorizationCode, brand: t.brand, cardLast4: t.cardLast4 },
    }, ctx));
  }
  if (t.status === 'NEGADA') {
    const p = await withTransaction((c) => markStatus(c, payment.id, 'REJEITADO', t.message || 'Transação negada pelo emissor/adquirente', 'REJEICAO', `NEG-${transactionId}`, ctx));
    return { result: 'REJEITADO', payment: p };
  }
  if (t.status === 'CANCELADA' && IN_FLIGHT.includes(payment.status)) {
    const p = await withTransaction((c) => markStatus(c, payment.id, 'CANCELADO', 'Transação cancelada no terminal', 'CANCELAMENTO', `CANC-${transactionId}`, ctx));
    return { result: 'CANCELADO', payment: p };
  }
  return { result: 'PROCESSANDO', payment };
}

/** Botão "Consultar status": reconsulta o provedor para o pagamento. */
async function refresh(paymentId, ctx) {
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (!p.provider_charge_id || p.provider === 'MANUAL') return { result: 'SEM_INTEGRACAO', payment: await getPayment(paymentId) };
  const r = p.method === 'PIX'
    ? await syncPixCharge(p.provider, p.provider_charge_id, 'CONSULTA_PROVEDOR', ctx)
    : await syncCardTransaction(p.provider, p.provider_charge_id, 'TERMINAL_PROVEDOR', ctx);
  return { result: r.result, payment: await getPayment(paymentId) };
}

// ---------------------------------------------------------------------------
// Conferência manual (dinheiro, cartão sem TEF, outros)
// ---------------------------------------------------------------------------
async function confer(paymentId, body, ctx, { skipSecondUser = false } = {}) {
  const v = validator(body);
  const approve = v.bool('approve');
  const note = v.string('note', { max: 500, label: 'Observação' });
  if (approve === null) v.fail('approve', 'Informe se aprova ou rejeita a conferência.');
  if (approve === false && !note) v.fail('note', 'Informe o motivo da rejeição.');
  v.done();
  if (!skipSecondUser && !has(ctx.user, 'payments.confer')) throw forbidden('Conferência exige a permissão "payments.confer".');

  return withTransaction(async (c) => {
    const payment = await lockPayment(c, paymentId);
    if (payment.status !== 'AGUARDANDO_CONFERENCIA') throw unprocessable('Pagamento não está aguardando conferência.');
    if (!skipSecondUser && payment.created_by === ctx.user.id) {
      throw forbidden('A conferência deve ser feita por um usuário diferente de quem registrou o recebimento (segregação de funções).');
    }
    const conferredBy = skipSecondUser ? null : ctx.user.id;
    if (!approve) {
      await c.query(`UPDATE payments SET status='REJEITADO', status_reason=$2, conferred_by=$3, conferred_at=now(), updated_at=now() WHERE id=$1`, [paymentId, note, conferredBy]);
      await audit(c, ctx, 'PAGAMENTO_CONFERENCIA_REJEITADA', 'payments', paymentId, { motivo: note });
      return getPaymentTx(c, paymentId);
    }
    await c.query('UPDATE payments SET conferred_by = $2, conferred_at = now() WHERE id = $1', [paymentId, conferredBy]);
    const r = await applyConfirmation(c, paymentId, {
      providerTransactionId: `MANUAL-${paymentId}`, amountCents: payment.amount_cents, source: 'CONFERENCIA_MANUAL',
      raw: { referencia: payment.manual_reference, observacao: note },
    }, ctx);
    if (r.result !== 'CONFIRMADO') throw unprocessable(`Não foi possível confirmar: ${r.payment.status_reason || r.result}`);
    return getPaymentTx(c, paymentId);
  });
}

// ---------------------------------------------------------------------------
// Cancelamento de cobrança não liquidada
// ---------------------------------------------------------------------------
async function cancel(paymentId, body, ctx) {
  const v = validator(body);
  const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' });
  v.done();
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (![...IN_FLIGHT, 'FALHA_COMUNICACAO'].includes(p.status)) throw unprocessable('Somente cobranças não liquidadas podem ser canceladas. Para valores confirmados utilize o estorno.');

  if (p.provider_charge_id && p.provider !== 'MANUAL' && p.status !== 'FALHA_COMUNICACAO') {
    // Antes de cancelar, verifica se o pagador já pagou (evita cancelar uma cobrança liquidada)
    const r = await refresh(paymentId, ctx);
    if (r.payment.status === 'CONFIRMADO') throw unprocessable('A cobrança já foi liquidada no provedor; o pagamento foi confirmado e não pode ser cancelado.');
    if (!IN_FLIGHT.includes(r.payment.status)) return r.payment;
    if (p.method === 'PIX') await pixProvider(p.provider).cancelCharge(p.provider_charge_id);
    else await cardProvider(p.provider).cancelTransaction({ transactionId: p.provider_charge_id, amountCents: p.amount_cents });
  }
  await withTransaction((c) => markStatus(c, paymentId, 'CANCELADO', reason, 'CANCELAMENTO', `CANC-${paymentId}`, ctx));
  return getPayment(paymentId);
}

// ---------------------------------------------------------------------------
// Estorno / devolução
// ---------------------------------------------------------------------------
async function applyRefund(c, paymentId, { refundId, amountCents, source, raw }, ctx) {
  const payment = await lockPayment(c, paymentId);
  const { rows: [acc] } = await c.query('SELECT * FROM accounts WHERE id = $1', [payment.account_id]);
  const { rows: ins } = await c.query(
    `INSERT INTO payment_transactions (payment_id, account_id, appointment_id, kind, provider, provider_transaction_id, amount_cents, status, occurred_at, source, raw, created_by)
     VALUES ($1,$2,$3,'ESTORNO',$4,$5,$6,'CONFIRMADO',now(),$7,$8,$9) ON CONFLICT ON CONSTRAINT payment_transactions_idem_uq DO NOTHING RETURNING id`,
    [payment.id, payment.account_id, acc.appointment_id, payment.provider, refundId, amountCents, source, raw || null, ctx?.user?.id || null]);
  if (!ins.length) return { result: 'DUPLICADO', payment };
  if (!['CONFIRMADO', 'ESTORNADO_PARCIAL'].includes(payment.status)) throw unprocessable('Pagamento não está confirmado.');
  const refunded = payment.refunded_cents + amountCents;
  if (refunded > payment.amount_cents) throw unprocessable('Estorno maior que o valor do pagamento.');
  const status = refunded === payment.amount_cents ? 'ESTORNADO' : 'ESTORNADO_PARCIAL';
  const { rows: [p] } = await c.query(`UPDATE payments SET refunded_cents = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *`, [paymentId, refunded, status]);
  await audit(c, ctx, 'PAGAMENTO_ESTORNADO', 'payments', paymentId, { valor_cents: amountCents, total_estornado_cents: refunded, origem: source, referencia: refundId });
  await recalculateAccount(c, payment.account_id, { source: `ESTORNO_${source}`, paymentId, ctx });
  const { rows: fiscal } = await c.query(`SELECT id, status FROM fiscal_documents WHERE account_id = $1 AND status IN ('EMITIDA','EMITIDA_EXTERNAMENTE','PROCESSANDO')`, [payment.account_id]);
  if (fiscal.length) {
    await audit(c, ctx, 'ALERTA_FISCAL_ESTORNO', 'fiscal_documents', fiscal[0].id, { aviso: 'Pagamento estornado em conta com documento fiscal emitido/pendente. Avalie cancelamento/substituição conforme legislação.' });
  }
  return { result: 'ESTORNADO', payment: p };
}

async function refund(paymentId, body, ctx) {
  const v = validator(body);
  const amount = v.cents('amount_cents', { required: true, label: 'Valor do estorno' });
  const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' });
  v.done();
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (!['CONFIRMADO', 'ESTORNADO_PARCIAL'].includes(p.status)) throw unprocessable('Somente pagamentos confirmados podem ser estornados.');
  if (amount > p.amount_cents - p.refunded_cents) throw unprocessable('Valor do estorno maior que o saldo estornável do pagamento.');

  await audit(null, ctx, 'ESTORNO_SOLICITADO', 'payments', paymentId, { valor_cents: amount, motivo: reason });

  if (p.provider === 'MANUAL') {
    // Devolução em espécie / estorno manual: operação manual autorizada e auditada.
    await withTransaction((c) => applyRefund(c, paymentId, { refundId: `MANUAL-EST-${paymentId}-${Date.now()}`, amountCents: amount, source: 'MANUAL_AUTORIZADO', raw: { motivo: reason } }, ctx));
    return { status: 'ESTORNADO', payment: await getPayment(paymentId) };
  }
  if (p.method === 'PIX') {
    const { rows: [tx] } = await pool.query(`SELECT provider_transaction_id FROM payment_transactions WHERE payment_id = $1 AND kind = 'LIQUIDACAO'`, [paymentId]);
    const refundId = `D${paymentId}x${Date.now()}`.slice(0, 35);
    const r = await pixProvider(p.provider).requestRefund({ endToEndId: tx.provider_transaction_id, refundId, amountCents: amount, reason });
    if (r.status === 'DEVOLVIDO') {
      await withTransaction((c) => applyRefund(c, paymentId, { refundId, amountCents: amount, source: 'CONSULTA_PROVEDOR', raw: r }, ctx));
      return { status: 'ESTORNADO', payment: await getPayment(paymentId) };
    }
    return { status: r.status, message: 'Devolução solicitada ao banco. A conta será atualizada quando o provedor confirmar a devolução.', payment: await getPayment(paymentId) };
  }
  // Cartão via terminal/adquirente
  const r = await cardProvider(p.provider).cancelTransaction({ transactionId: p.provider_charge_id, amountCents: amount });
  if (r.status === 'CANCELADA') {
    await withTransaction((c) => applyRefund(c, paymentId, { refundId: r.cancelId || `CANC-${paymentId}-${Date.now()}`, amountCents: amount, source: 'TERMINAL_PROVEDOR', raw: r }, ctx));
    return { status: 'ESTORNADO', payment: await getPayment(paymentId) };
  }
  return { status: r.status, message: 'Cancelamento solicitado à adquirente; aguardando confirmação.', payment: await getPayment(paymentId) };
}

// ---------------------------------------------------------------------------
// Reatribuição: pagamento associado por engano à conta errada
// ---------------------------------------------------------------------------
async function reassign(paymentId, body, ctx) {
  const v = validator(body);
  const targetId = v.id('target_account_id', { required: true, label: 'Conta de destino' });
  const reason = v.string('reason', { required: true, min: 10, max: 500, label: 'Justificativa' });
  v.done();
  return withTransaction(async (c) => {
    const { rows: [p0] } = await c.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (!p0) throw notFound('Pagamento não encontrado.');
    if (p0.account_id === targetId) throw unprocessable('Conta de destino é a mesma conta de origem.');
    // Bloqueia as duas contas em ordem crescente de id (evita deadlock)
    const [first, second] = [p0.account_id, targetId].sort((a, b) => a - b);
    await lockAccount(c, first); await lockAccount(c, second);
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (p.status !== 'CONFIRMADO' || p.refunded_cents > 0) throw unprocessable('Somente pagamentos confirmados e sem estorno podem ser reatribuídos.');
    const { rows: [target] } = await c.query('SELECT * FROM accounts WHERE id = $1', [targetId]);
    const { rows: [source] } = await c.query('SELECT * FROM accounts WHERE id = $1', [p.account_id]);
    if (target.financial_status === 'CANCELADA') throw unprocessable('Conta de destino cancelada.');
    const targetBalance = target.total_cents - target.received_cents - await inFlightCents(c, targetId);
    if (p.amount_cents > targetBalance) throw unprocessable(`O pagamento (${formatBRL(p.amount_cents)}) excede o saldo disponível da conta de destino (${formatBRL(targetBalance)}).`);
    const { rows: fiscal } = await c.query(`SELECT id FROM fiscal_documents WHERE account_id = $1 AND status IN ('EMITIDA','EMITIDA_EXTERNAMENTE','PROCESSANDO','ENVIADA')`, [source.id]);
    if (fiscal.length) throw unprocessable('A conta de origem possui documento fiscal emitido/em processamento. Trate o documento fiscal antes de reatribuir.');

    await c.query('UPDATE payments SET account_id = $2, updated_at = now() WHERE id = $1', [paymentId, targetId]);
    await c.query(
      `INSERT INTO payment_transactions (payment_id, account_id, appointment_id, kind, provider, provider_transaction_id, amount_cents, status, occurred_at, source, raw, created_by)
       VALUES ($1,$2,$3,'REATRIBUICAO',$4,$5,$6,'CONCLUIDA',now(),'REATRIBUICAO_AUTORIZADA',$7,$8)`,
      [paymentId, targetId, target.appointment_id, p.provider, `REATR-${paymentId}-${Date.now()}`, p.amount_cents,
        { de_conta: source.number, para_conta: target.number, justificativa: reason }, ctx.user.id]);
    await audit(c, ctx, 'PAGAMENTO_REATRIBUIDO', 'payments', paymentId, { de_conta_id: source.id, para_conta_id: targetId, valor_cents: p.amount_cents, justificativa: reason });
    await recalculateAccount(c, source.id, { source: 'REATRIBUICAO_SAIDA', paymentId, ctx, notes: reason });
    await recalculateAccount(c, targetId, { source: 'REATRIBUICAO_ENTRADA', paymentId, ctx, notes: reason });
    return getPaymentTx(c, paymentId);
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
async function getPaymentTx(db, paymentId) {
  const { rows: [p] } = await db.query(
    `SELECT py.*, ac.number AS account_number, ac.financial_status, ac.total_cents AS account_total_cents, ac.received_cents AS account_received_cents,
            u.name AS created_by_name, cu.name AS conferred_by_name
       FROM payments py JOIN accounts ac ON ac.id = py.account_id JOIN users u ON u.id = py.created_by LEFT JOIN users cu ON cu.id = py.conferred_by
      WHERE py.id = $1`, [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (p.pix_copy_paste && IN_FLIGHT.includes(p.status)) p.pix_qr_code = await QRCode.toDataURL(p.pix_copy_paste, { margin: 1, width: 240 });
  const { rows: tx } = await db.query('SELECT id, kind, provider_transaction_id, amount_cents, status, occurred_at, source FROM payment_transactions WHERE payment_id = $1 ORDER BY id', [paymentId]);
  return { ...p, transactions: tx };
}
const getPayment = (id) => getPaymentTx(pool, id);

/** Dados do COMPROVANTE INTERNO de recebimento (não é documento fiscal nem comprovante bancário). */
async function receipt(paymentId) {
  const p = await getPayment(paymentId);
  if (!['CONFIRMADO', 'ESTORNADO_PARCIAL', 'ESTORNADO'].includes(p.status)) throw unprocessable('Comprovante disponível apenas para pagamentos confirmados.');
  const { rows: [info] } = await pool.query(
    `SELECT ac.number AS account_number, ap.number AS appointment_number, pa.name AS patient_name, pa.code AS patient_code, mr.record_number
       FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients pa ON pa.id = ac.patient_id JOIN medical_records mr ON mr.patient_id = pa.id
      WHERE ac.id = $1`, [p.account_id]);
  const { rows: [inst] } = await pool.query(`SELECT value FROM settings WHERE key = 'institution'`);
  const liq = p.transactions.find((t) => t.kind === 'LIQUIDACAO');
  return {
    document_type: 'COMPROVANTE_INTERNO_RECEBIMENTO',
    disclaimer: 'Comprovante interno de recebimento. NÃO é documento fiscal e NÃO substitui o comprovante bancário/da adquirente.',
    is_demo: p.is_demo,
    institution: inst?.value || {},
    ...info,
    payment_id: p.id, method: p.method, method_label: p.method_label, installments: p.installments,
    amount_cents: p.amount_cents, refunded_cents: p.refunded_cents, status: p.status,
    confirmed_at: p.confirmed_at, confirmation_source: p.confirmation_source,
    transaction_id: liq?.provider_transaction_id || null, provider: p.provider, provider_charge_id: p.provider_charge_id,
    received_by: p.created_by_name, conferred_by: p.conferred_by_name,
  };
}

async function list(f = {}) {
  const where = []; const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.status) add('py.status = ?', f.status);
  if (f.method) add('py.method = ?', f.method);
  if (f.account_id) add('py.account_id = ?', f.account_id);
  if (f.from) add('py.created_at >= ?::date', f.from);
  if (f.to) add("py.created_at < (?::date + interval '1 day')", f.to);
  const { rows } = await pool.query(
    `SELECT py.id, py.account_id, py.method, py.amount_cents, py.refunded_cents, py.status, py.provider, py.confirmation_source, py.confirmed_at, py.created_at, py.is_demo,
            ac.number AS account_number, pa.name AS patient_name, u.name AS created_by_name
       FROM payments py JOIN accounts ac ON ac.id = py.account_id JOIN patients pa ON pa.id = ac.patient_id JOIN users u ON u.id = py.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY py.id DESC LIMIT 300`, params);
  return rows;
}

module.exports = { start, applyConfirmation, applyRefund, syncPixCharge, syncCardTransaction, refresh, confer, cancel, refund, reassign, getPayment, receipt, list, IN_FLIGHT };
