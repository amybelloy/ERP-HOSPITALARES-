'use strict';
/** TERMINAL DE CARTÃO DE DEMONSTRAÇÃO — simula aprovação/negação. Nenhuma cobrança real. */
const crypto = require('crypto');
const config = require('../../config');
const { pool } = require('../../db/pool');
const { CardProvider } = require('./CardProvider');
const { providerError } = require('../../lib/errors');

class DemoCardProvider extends CardProvider {
  constructor() { super(); this.failureMode = false; }
  get name() { return 'DEMO_CARD'; }
  get isDemo() { return true; }
  status() { return { configured: true, missing: [], demo: true }; }

  _checkFailure() { if (this.failureMode) throw providerError('DEMONSTRAÇÃO: terminal de cartão sem comunicação.'); }

  async startTransaction({ reference, amountCents, type, installments }) {
    this._checkFailure();
    const transactionId = `DEMO-CARD-${crypto.randomBytes(8).toString('hex')}`;
    await pool.query(
      `INSERT INTO demo_provider_state (kind, external_id, amount_cents, status, data) VALUES ('CARD',$1,$2,'PROCESSANDO',$3)`,
      [transactionId, amountCents, { reference, type, installments }]);
    return { transactionId, status: 'PROCESSANDO', amountCents, raw: { demo: true } };
  }

  async getTransaction(transactionId) {
    this._checkFailure();
    const { rows } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind='CARD' AND external_id = $1`, [transactionId]);
    const r = rows[0];
    if (!r) return null;
    return { transactionId, status: r.status, amountCents: r.amount_cents, nsu: r.data.nsu || null, authorizationCode: r.data.authorizationCode || null,
      brand: r.data.brand || null, cardLast4: r.data.cardLast4 || null, message: r.data.message || null, raw: { demo: true, ...r.data } };
  }

  async cancelTransaction({ transactionId }) {
    this._checkFailure();
    await pool.query(`UPDATE demo_provider_state SET status = 'CANCELADA', updated_at = now() WHERE kind='CARD' AND external_id = $1`, [transactionId]);
    return { status: 'CANCELADA', cancelId: `CANC-${transactionId}` };
  }

  verifyCallback({ headers, rawBody }) {
    const sig = headers['x-demo-signature'];
    if (!sig || !rawBody) return false;
    const expected = crypto.createHmac('sha256', config.card.callbackSecret).update(rawBody).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  /** Simula o portador inserindo o cartão e o terminal respondendo. */
  async simulateResult(transactionId, outcome) {
    const approved = outcome === 'APROVADA';
    const data = approved
      ? { nsu: String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), authorizationCode: crypto.randomBytes(3).toString('hex').toUpperCase(), brand: 'DEMO', cardLast4: '0000', message: 'APROVADA (DEMONSTRAÇÃO)' }
      : { message: 'NEGADA (DEMONSTRAÇÃO) — saldo insuficiente simulado' };
    const { rowCount } = await pool.query(
      `UPDATE demo_provider_state SET status = $2, data = data || $3::jsonb, updated_at = now() WHERE kind='CARD' AND external_id = $1 AND status = 'PROCESSANDO'`,
      [transactionId, approved ? 'APROVADA' : 'NEGADA', JSON.stringify(data)]);
    if (!rowCount) throw providerError('DEMONSTRAÇÃO: transação não está em processamento.');
    const body = JSON.stringify({ transactionId, status: approved ? 'APROVADA' : 'NEGADA' });
    const signature = crypto.createHmac('sha256', config.card.callbackSecret).update(body).digest('hex');
    return { body, headers: { 'content-type': 'application/json', 'x-demo-signature': signature } };
  }
}

module.exports = { DemoCardProvider };
