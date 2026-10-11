'use strict';
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { recalculateAccount, lockAccount } = require('./settlementService');
const { validator } = require('../lib/validate');
const { has } = require('../middleware/auth');
const { notFound, forbidden, unprocessable, badRequest } = require('../lib/errors');

function assertEditable(account, appointment) {
  if (account.financial_status === 'CANCELADA') throw unprocessable('Conta cancelada não pode ser alterada.');
  if (account.financial_status === 'QUITADA') throw unprocessable('Conta quitada não pode ser alterada. Para corrigir, realize o estorno do pagamento de forma auditável.');
  if (account.billing_status !== 'ABERTA') throw unprocessable('Conta fechada para faturamento não pode ser alterada.');
  if (appointment && appointment.status === 'CANCELADO') throw unprocessable('Atendimento cancelado.');
}

/**
 * Lança um procedimento na conta (dentro de uma transação existente).
 * O preço vem do cadastro do procedimento; ajustes, descontos e acréscimos exigem permissão e justificativa.
 */
async function addItemTx(c, accountId, body, ctx) {
  const v = validator(body);
  const procedureId = v.id('procedure_id', { required: true, label: 'Procedimento' });
  const quantity = v.int('quantity', { min: 1, max: 999, label: 'Quantidade' }) || 1;
  const unitOverride = v.cents('unit_price_cents', { allowZero: true, label: 'Valor unitário' });
  const discount = v.cents('discount_cents', { allowZero: true, label: 'Desconto' }) || 0;
  const surcharge = v.cents('surcharge_cents', { allowZero: true, label: 'Acréscimo' }) || 0;
  const reason = v.string('adjustment_reason', { max: 500, label: 'Justificativa' });
  const professionalId = v.id('professional_id');
  v.done();

  const account = await lockAccount(c, accountId);
  const { rows: [appt] } = await c.query('SELECT * FROM appointments WHERE id = $1', [account.appointment_id]);
  assertEditable(account, appt);

  const { rows: [proc] } = await c.query('SELECT * FROM procedures WHERE id = $1', [procedureId]);
  if (!proc) throw notFound('Procedimento não encontrado.');
  if (!proc.active) throw unprocessable('Procedimento inativo não pode ser lançado.');

  const overridden = unitOverride !== null && unitOverride !== proc.price_cents;
  if ((overridden || discount > 0 || surcharge > 0)) {
    if (!has(ctx.user, 'accounts.adjust_price')) throw forbidden('Ajuste de preço, desconto ou acréscimo exige a permissão "accounts.adjust_price".');
    if (!reason || reason.length < 5) throw badRequest('Informe a justificativa do ajuste.', { adjustment_reason: 'Justificativa obrigatória (mín. 5 caracteres).' });
  }
  const unit = overridden ? unitOverride : proc.price_cents;
  const gross = unit * quantity;
  if (discount > gross) throw unprocessable('Desconto maior que o valor do item.');
  const total = gross - discount + surcharge;

  const { rows: [ap] } = await c.query(
    `INSERT INTO appointment_procedures (appointment_id, procedure_id, quantity, professional_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [appt.id, proc.id, quantity, professionalId || appt.professional_id, ctx.user.id]);
  const { rows: [item] } = await c.query(
    `INSERT INTO account_items (account_id, procedure_id, appointment_procedure_id, description, quantity, unit_price_cents,
        discount_cents, surcharge_cents, total_cents, price_overridden, adjustment_reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [accountId, proc.id, ap.id, proc.name, quantity, unit, discount, surcharge, total, overridden, reason, ctx.user.id]);
  // Qualquer alteração invalida a conferência anterior.
  await c.query('UPDATE accounts SET checked_at = NULL, checked_by = NULL WHERE id = $1', [accountId]);
  await audit(c, ctx, 'CONTA_ITEM_LANCADO', 'accounts', accountId, {
    item_id: item.id, procedimento: proc.code, quantidade: quantity, unitario_cents: unit, preco_tabela_cents: proc.price_cents,
    desconto_cents: discount, acrescimo_cents: surcharge, total_cents: total, ajuste: overridden || discount > 0 || surcharge > 0, justificativa: reason,
  });
  await recalculateAccount(c, accountId, { source: 'ITEM_LANCADO', ctx });
  return item;
}

const addItem = (accountId, body, ctx) => withTransaction((c) => addItemTx(c, accountId, body, ctx));

async function cancelItem(accountId, itemId, body, ctx) {
  const v = validator(body);
  const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' });
  v.done();
  return withTransaction(async (c) => {
    const account = await lockAccount(c, accountId);
    const { rows: [appt] } = await c.query('SELECT * FROM appointments WHERE id = $1', [account.appointment_id]);
    assertEditable(account, appt);
    const { rows: [item] } = await c.query('SELECT * FROM account_items WHERE id = $1 AND account_id = $2 FOR UPDATE', [itemId, accountId]);
    if (!item) throw notFound('Item não encontrado nesta conta.');
    if (item.status === 'CANCELADO') throw unprocessable('Item já cancelado.');
    if (account.total_cents - item.total_cents < account.received_cents) {
      throw unprocessable('O cancelamento deixaria o total menor que o valor já recebido. Estorne o pagamento antes.');
    }
    await c.query(`UPDATE account_items SET status='CANCELADO', cancel_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`, [itemId, reason, ctx.user.id]);
    if (item.appointment_procedure_id) await c.query(`UPDATE appointment_procedures SET status='CANCELADO' WHERE id=$1`, [item.appointment_procedure_id]);
    await c.query('UPDATE accounts SET checked_at = NULL, checked_by = NULL WHERE id = $1', [accountId]);
    await audit(c, ctx, 'CONTA_ITEM_CANCELADO', 'accounts', accountId, { item_id: itemId, descricao: item.description, total_cents: item.total_cents, motivo: reason });
    return recalculateAccount(c, accountId, { source: 'ITEM_CANCELADO', ctx });
  });
}

async function check(accountId, ctx) {
  return withTransaction(async (c) => {
    const account = await lockAccount(c, accountId);
    if (account.financial_status === 'CANCELADA') throw unprocessable('Conta cancelada.');
    if (account.total_cents <= 0) throw unprocessable('Conta sem itens não pode ser conferida.');
    const { rows: [a] } = await c.query('UPDATE accounts SET checked_at = now(), checked_by = $2 WHERE id = $1 RETURNING *', [accountId, ctx.user.id]);
    await audit(c, ctx, 'CONTA_CONFERIDA', 'accounts', accountId, { total_cents: a.total_cents });
    return a;
  });
}

async function setBillingStatus(accountId, status, ctx) {
  if (!['ABERTA', 'FECHADA', 'FATURADA'].includes(status)) throw badRequest('Status de faturamento inválido.');
  return withTransaction(async (c) => {
    const account = await lockAccount(c, accountId);
    if (status !== 'ABERTA' && !account.checked_at) throw unprocessable('A conta precisa ser conferida antes de ser fechada.');
    const { rows: [a] } = await c.query('UPDATE accounts SET billing_status = $2, updated_at = now() WHERE id = $1 RETURNING *', [accountId, status]);
    await audit(c, ctx, 'CONTA_FATURAMENTO', 'accounts', accountId, { de: account.billing_status, para: status });
    return a;
  });
}

async function get(accountId) {
  const { rows: [a] } = await pool.query(
    `SELECT ac.*, (ac.total_cents - ac.received_cents) AS balance_cents,
            ap.number AS appointment_number, ap.opened_at, ap.status AS appointment_status, ap.modality, ap.type, ap.sector,
            p.id AS patient_id, p.name AS patient_name, p.code AS patient_code, p.cpf AS patient_cpf, mr.record_number,
            pr.name AS professional_name, u.name AS checked_by_name, ip.name AS insurance_name
       FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
       JOIN medical_records mr ON mr.patient_id = p.id
       LEFT JOIN professionals pr ON pr.id = ap.professional_id LEFT JOIN users u ON u.id = ac.checked_by
       LEFT JOIN insurance_plans ip ON ip.id = ap.insurance_plan_id
      WHERE ac.id = $1`, [accountId]);
  if (!a) throw notFound('Conta não encontrada.');
  const { rows: items } = await pool.query(
    `SELECT ai.*, pc.code AS procedure_code, u.name AS created_by_name FROM account_items ai
       LEFT JOIN procedures pc ON pc.id = ai.procedure_id LEFT JOIN users u ON u.id = ai.created_by
      WHERE ai.account_id = $1 ORDER BY ai.id`, [accountId]);
  const { rows: payments } = await pool.query(
    `SELECT py.id, py.method, py.method_label, py.amount_cents, py.refunded_cents, py.installments, py.status, py.provider, py.provider_charge_id,
            py.confirmation_source, py.confirmed_at, py.is_demo, py.created_at, py.expires_at, py.manual_reference, py.status_reason,
            u.name AS created_by_name, cu.name AS conferred_by_name
       FROM payments py JOIN users u ON u.id = py.created_by LEFT JOIN users cu ON cu.id = py.conferred_by
      WHERE py.account_id = $1 ORDER BY py.id`, [accountId]);
  const { rows: fiscal } = await pool.query(
    `SELECT id, status, mode, is_demo, nfse_number, requested_at FROM fiscal_documents WHERE account_id = $1 ORDER BY id DESC`, [accountId]);
  return { ...a, items, payments, fiscal_documents: fiscal };
}

async function settlementHistory(accountId) {
  const { rows } = await pool.query(
    `SELECT s.*, u.name AS user_name FROM settlements s LEFT JOIN users u ON u.id = s.user_id WHERE s.account_id = $1 ORDER BY s.id`, [accountId]);
  const { rows: tx } = await pool.query(
    `SELECT t.id, t.payment_id, t.kind, t.provider, t.provider_transaction_id, t.amount_cents, t.status, t.occurred_at, t.source, t.created_at
       FROM payment_transactions t WHERE t.account_id = $1 ORDER BY t.id`, [accountId]);
  return { settlements: rows, transactions: tx };
}

/** Consulta/acompanhamento de contas (módulo Quitação e Consulta). */
async function search(f = {}) {
  const where = []; const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.from) add('ap.opened_at >= ?::date', f.from);
  if (f.to) add("ap.opened_at < (?::date + interval '1 day')", f.to);
  if (f.patient) add("(lower(p.name) LIKE '%' || lower(?) || '%')", f.patient);
  if (f.record_number) add('upper(mr.record_number) = upper(?)', f.record_number);
  if (f.appointment_number) add('upper(ap.number) = upper(?)', f.appointment_number);
  if (f.account_number) add('upper(ac.number) = upper(?)', f.account_number);
  if (f.financial_status) add('ac.financial_status = ?', f.financial_status);
  if (f.fiscal_status) add('ac.fiscal_status = ?', f.fiscal_status);
  if (f.modality) add('ap.modality = ?', f.modality);
  if (f.billing_status) add('ac.billing_status = ?', f.billing_status);
  if (f.method) add('EXISTS (SELECT 1 FROM payments x WHERE x.account_id = ac.id AND x.method = ?)', f.method);
  if (f.transaction_status) add('EXISTS (SELECT 1 FROM payments x WHERE x.account_id = ac.id AND x.status = ?)', f.transaction_status);
  if (f.user_id) {
    params.push(f.user_id);
    const i = params.length;
    where.push(`(ap.opened_by = $${i}::bigint OR EXISTS (SELECT 1 FROM payments x WHERE x.account_id = ac.id AND x.created_by = $${i}::bigint))`);
  }
  const sql = `
    SELECT ac.id, ac.number, ac.total_cents, ac.received_cents, (ac.total_cents - ac.received_cents) AS balance_cents,
           ac.financial_status, ac.fiscal_status, ac.billing_status, ac.settled_at, ac.checked_at,
           ap.id AS appointment_id, ap.number AS appointment_number, ap.opened_at, ap.modality,
           p.id AS patient_id, p.name AS patient_name, mr.record_number,
           COALESCE((SELECT string_agg(ai.description, ', ') FROM account_items ai WHERE ai.account_id = ac.id AND ai.status='ATIVO'), '') AS procedures,
           lp.method AS last_method, lp.status AS last_transaction_status, lp.confirmed_at AS last_payment_at,
           COALESCE((SELECT string_agg(DISTINCT x.method, ', ') FROM payments x WHERE x.account_id = ac.id AND x.status IN ('CONFIRMADO','ESTORNADO_PARCIAL')), '') AS methods
      FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
      JOIN medical_records mr ON mr.patient_id = p.id
      LEFT JOIN LATERAL (SELECT method, status, confirmed_at FROM payments x WHERE x.account_id = ac.id ORDER BY x.id DESC LIMIT 1) lp ON true
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ap.opened_at DESC LIMIT ${Math.min(Number(f.limit) || 200, 1000)}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = { addItem, addItemTx, cancelItem, check, setBillingStatus, get, settlementHistory, search, assertEditable };
