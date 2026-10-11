'use strict';
/** BOLETO DE DEMONSTRAÇÃO — gera código/linha no padrão FEBRABAN, mas o boleto NÃO é registrado em banco algum. */
const crypto = require('crypto');
const config = require('../../config');
const { pool } = require('../../db/pool');
const { BoletoProvider } = require('./BoletoProvider');
const { buildBoleto, santanderFreeField } = require('../../lib/boleto');
const { providerError } = require('../../lib/errors');

class DemoBoletoProvider extends BoletoProvider {
  constructor() { super(); this.failureMode = false; }
  get name() { return 'DEMO_BOLETO'; }
  get isDemo() { return true; }
  status() { return { configured: true, missing: [], demo: true }; }
  _check() { if (this.failureMode) throw providerError('DEMONSTRAÇÃO: falha simulada de comunicação com o banco (boleto).'); }

  async register({ ourNumber, amountCents, dueDate }) {
    this._check();
    const b = buildBoleto({ bank: '033', amountCents, dueDate, freeField: santanderFreeField({ beneficiaryCode: '0000000', ourNumber }) });
    await pool.query(`INSERT INTO demo_provider_state (kind, external_id, amount_cents, status, data) VALUES ('BOLETO',$1,$2,'REGISTRADO',$3)`,
      [ourNumber, amountCents, { dueDate, ...b }]);
    return { ourNumber, status: 'REGISTRADO', amountCents, dueDate, ...b, raw: { demo: true } };
  }

  async getBoleto(ourNumber) {
    this._check();
    const { rows: [r] } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind='BOLETO' AND external_id = $1`, [ourNumber]);
    if (!r) return null;
    return { ourNumber, status: r.status, amountCents: r.amount_cents, dueDate: r.data.dueDate, barcode: r.data.barcode, digitableLine: r.data.digitableLine,
      paidAmountCents: r.data.paidAmountCents || null, paidAt: r.data.paidAt || null, raw: { demo: true } };
  }

  async cancel(ourNumber) {
    this._check();
    await pool.query(`UPDATE demo_provider_state SET status = 'BAIXADO', updated_at = now() WHERE kind='BOLETO' AND external_id = $1 AND status = 'REGISTRADO'`, [ourNumber]);
    return this.getBoleto(ourNumber);
  }

  verifyWebhook({ headers, rawBody }) {
    const sig = headers['x-demo-signature'];
    if (!sig || !rawBody) return false;
    const exp = crypto.createHmac('sha256', config.pix.demoWebhookSecret).update(rawBody).digest('hex');
    return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
  }

  /** Simula o pagamento do boleto pelo pagador e devolve o webhook que o "banco" enviaria. */
  async simulatePayment(ourNumber, { amountCents } = {}) {
    const { rows: [r] } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind='BOLETO' AND external_id = $1`, [ourNumber]);
    if (!r || r.status !== 'REGISTRADO') throw providerError('DEMONSTRAÇÃO: boleto inexistente ou não está em aberto.');
    const paid = { paidAmountCents: amountCents || r.amount_cents, paidAt: new Date().toISOString() };
    await pool.query(`UPDATE demo_provider_state SET status = 'PAGO', data = data || $2::jsonb, updated_at = now() WHERE id = $1`, [r.id, JSON.stringify(paid)]);
    const body = JSON.stringify({ nossoNumero: ourNumber, situacao: 'LIQUIDADO' });
    return { body, headers: { 'content-type': 'application/json', 'x-demo-signature': crypto.createHmac('sha256', config.pix.demoWebhookSecret).update(body).digest('hex') } };
  }
}
module.exports = { DemoBoletoProvider };
