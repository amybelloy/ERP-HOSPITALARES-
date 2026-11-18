'use strict';
/**
 * QUITAÇÃO AUTOMÁTICA
 * -------------------
 * O status financeiro de uma conta NUNCA é definido manualmente: ele é sempre
 * DERIVADO do total dos itens ativos e da soma dos pagamentos efetivamente confirmados
 * (confirmação vinda do provedor/terminal ou conferência manual autorizada),
 * descontados os estornos confirmados.
 *
 *   recebido = Σ (valor - estornado) dos pagamentos CONFIRMADO / ESTORNADO_PARCIAL / ESTORNADO
 *   saldo    = total - recebido
 *   status   = PENDENTE (recebido = 0) | PARCIAL (0 < recebido < total) | QUITADA (recebido = total > 0)
 *
 * Sempre executado dentro de uma transação, com a linha da conta bloqueada (SELECT ... FOR UPDATE).
 */
const { audit } = require('./audit');
const { notFound, unprocessable } = require('../lib/errors');

const COUNTED_STATUSES = ['CONFIRMADO', 'ESTORNADO_PARCIAL', 'ESTORNADO'];

async function lockAccount(client, accountId) {
  const { rows } = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  if (!rows[0]) throw notFound('Conta não encontrada.');
  return rows[0];
}

async function computeTotals(client, accountId) {
  const { rows: [t] } = await client.query(
    `SELECT COALESCE(SUM(total_cents),0)::bigint AS total FROM account_items WHERE account_id = $1 AND status = 'ATIVO'`, [accountId]);
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(SUM(amount_cents - refunded_cents),0)::bigint AS received
       FROM payments WHERE account_id = $1 AND status = ANY($2)`, [accountId, COUNTED_STATUSES]);
  return { total: Number(t.total), received: Number(r.received) };
}

function deriveStatus(total, received) {
  if (received === 0) return 'PENDENTE';
  if (received < total) return 'PARCIAL';
  if (received === total) return 'QUITADA';
  return 'EXCEDENTE';
}

function eventFor(prev, next) {
  if (next === 'QUITADA') return 'QUITACAO';
  if (prev === 'QUITADA') return 'REABERTURA';
  if (next === 'PARCIAL') return 'PAGAMENTO_PARCIAL';
  return 'ATUALIZACAO';
}

/**
 * Recalcula totais e status da conta. Registra histórico em `settlements` quando o status muda.
 * @param {object} opts { source, paymentId, ctx, notes }
 */
async function recalculateAccount(client, accountId, { source = 'RECALCULO', paymentId = null, ctx = null, notes = null } = {}) {
  const account = await lockAccount(client, accountId);
  if (account.financial_status === 'CANCELADA') return account;

  const { total, received } = await computeTotals(client, accountId);
  const status = deriveStatus(total, received);
  if (status === 'EXCEDENTE') {
    // Nunca deve acontecer: as operações verificam o saldo antes. Aborta a transação inteira.
    throw unprocessable('Operação resultaria em valor recebido maior que o total da conta.', { total, received });
  }

  const changed = status !== account.financial_status || total !== account.total_cents || received !== account.received_cents;
  if (!changed) return account;

  const { rows: [updated] } = await client.query(
    `UPDATE accounts SET total_cents = $2, received_cents = $3, financial_status = $4::varchar,
            settled_at = CASE WHEN $4::varchar = 'QUITADA' THEN COALESCE(settled_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE id = $1 RETURNING *`, [accountId, total, received, status]);

  if (status !== account.financial_status || received !== account.received_cents) {
    const event = status === account.financial_status ? 'ATUALIZACAO' : eventFor(account.financial_status, status);
    await client.query(
      `INSERT INTO settlements (account_id, event, previous_status, new_status, total_cents, received_cents, balance_cents, source, payment_id, user_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [accountId, event, account.financial_status, status, total, received, total - received, source, paymentId, ctx?.user?.id || null, notes]);
    await audit(client, ctx, `CONTA_${event}`, 'accounts', accountId, {
      de: account.financial_status, para: status, total_cents: total, recebido_cents: received, saldo_cents: total - received, origem: source, pagamento_id: paymentId,
    });
  }
  return updated;
}

module.exports = { recalculateAccount, lockAccount, computeTotals, deriveStatus, COUNTED_STATUSES };
