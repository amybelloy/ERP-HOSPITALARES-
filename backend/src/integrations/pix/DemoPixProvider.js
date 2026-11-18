'use strict';
/**
 * PROVEDOR PIX DE DEMONSTRAÇÃO
 * Simula o lado do banco: cobranças, pagamentos, devoluções e webhooks assinados.
 * NENHUM dinheiro é movimentado. Todo pagamento criado por este provedor é marcado como is_demo.
 */
const crypto = require('crypto');
const config = require('../../config');
const { pool } = require('../../db/pool');
const { PixProvider } = require('./PixProvider');
const { buildPixPayload } = require('../../lib/brcode');
const { centsToDecimal } = require('../../lib/money');
const { providerError } = require('../../lib/errors');

class DemoPixProvider extends PixProvider {
  constructor() { super(); this.failureMode = false; }
  get name() { return 'DEMO_PIX'; }
  get isDemo() { return true; }
  status() { return { configured: true, missing: [], demo: true }; }

  _checkFailure() {
    if (this.failureMode) throw providerError('DEMONSTRAÇÃO: falha simulada de comunicação com o banco (timeout).');
  }

  async createCharge({ txid, amountCents, expiresIn }) {
    this._checkFailure();
    const copyPaste = buildPixPayload({
      pixKey: 'pix-demonstracao@exemplo.invalid', amount: centsToDecimal(amountCents),
      merchantName: 'DEMONSTRACAO SEM VALOR', merchantCity: 'DEMO', txid,
    });
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    await pool.query(
      `INSERT INTO demo_provider_state (kind, external_id, amount_cents, status, data) VALUES ('PIX',$1,$2,'ATIVA',$3)`,
      [txid, amountCents, { pix: [], expiresAt }]);
    return { txid, status: 'ATIVA', amountCents, copyPaste, location: null, expiresAt, raw: { demo: true } };
  }

  async _get(txid) {
    const { rows } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind = 'PIX' AND external_id = $1`, [txid]);
    return rows[0];
  }

  async getCharge(txid) {
    this._checkFailure();
    const row = await this._get(txid);
    if (!row) return null;
    return { txid, status: row.status, amountCents: row.amount_cents, pix: row.data.pix || [], expiresAt: row.data.expiresAt, raw: { demo: true, ...row.data } };
  }

  async cancelCharge(txid) {
    this._checkFailure();
    await pool.query(`UPDATE demo_provider_state SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR', updated_at = now() WHERE kind='PIX' AND external_id = $1 AND status = 'ATIVA'`, [txid]);
    return this.getCharge(txid);
  }

  async requestRefund({ endToEndId, refundId, amountCents }) {
    this._checkFailure();
    const { rows } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind='PIX' AND data->'pix' @> $1::jsonb`, [JSON.stringify([{ endToEndId }])]);
    const row = rows[0];
    if (!row) throw providerError('DEMONSTRAÇÃO: Pix não encontrado no provedor.');
    const pix = row.data.pix.map((p) => (p.endToEndId === endToEndId
      ? { ...p, refunds: [...(p.refunds || []), { id: refundId, rtrId: `D${crypto.randomBytes(15).toString('hex').slice(0, 31)}`, amountCents, status: 'DEVOLVIDO', requestedAt: new Date().toISOString() }] }
      : p));
    await pool.query('UPDATE demo_provider_state SET data = $2, updated_at = now() WHERE id = $1', [row.id, { ...row.data, pix }]);
    return { refundId, status: 'DEVOLVIDO', amountCents };
  }

  async listReceived({ from, to }) {
    this._checkFailure();
    const { rows } = await pool.query(`SELECT * FROM demo_provider_state WHERE kind IN ('PIX','PIX_ORPHAN')`);
    const out = [];
    for (const r of rows) {
      for (const p of r.data.pix || []) {
        const d = new Date(p.paidAt);
        if (d >= new Date(from) && d <= new Date(to)) out.push({ ...p, txid: r.kind === 'PIX' ? r.external_id : null });
      }
    }
    return out;
  }

  verifyWebhook({ headers, rawBody }) {
    const sig = headers['x-demo-signature'];
    if (!sig || !rawBody) return false;
    const expected = crypto.createHmac('sha256', config.pix.demoWebhookSecret).update(rawBody).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  // ------------------- Operações exclusivas da simulação -------------------

  /** Simula o pagador quitando a cobrança no app do banco. Retorna o corpo do webhook que o "banco" enviaria. */
  async simulatePayment(txid, { amountCents } = {}) {
    const row = await this._get(txid);
    if (!row) throw providerError('DEMONSTRAÇÃO: cobrança inexistente.');
    if (row.status !== 'ATIVA') throw providerError(`DEMONSTRAÇÃO: cobrança não está ativa (${row.status}).`);
    const e2e = `E${'00000000'}${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}${crypto.randomBytes(6).toString('hex')}`.slice(0, 32);
    const paid = { endToEndId: e2e, amountCents: amountCents || row.amount_cents, paidAt: new Date().toISOString(), refunds: [] };
    await pool.query(`UPDATE demo_provider_state SET status = 'CONCLUIDA', data = $2, updated_at = now() WHERE id = $1`,
      [row.id, { ...row.data, pix: [...(row.data.pix || []), paid] }]);
    return this.buildWebhook([{ ...paid, txid }]);
  }

  async simulateExpiration(txid) {
    await pool.query(`UPDATE demo_provider_state SET status = 'REMOVIDA_PELO_PSP', updated_at = now() WHERE kind='PIX' AND external_id = $1 AND status='ATIVA'`, [txid]);
  }

  /** Pix recebido sem cobrança correspondente (para demonstrar a conciliação). */
  async simulateOrphanPix(amountCents) {
    const e2e = `E00000000${Date.now()}${crypto.randomBytes(4).toString('hex')}`.slice(0, 32);
    const paid = { endToEndId: e2e, amountCents, paidAt: new Date().toISOString(), refunds: [] };
    await pool.query(`INSERT INTO demo_provider_state (kind, external_id, amount_cents, status, data) VALUES ('PIX_ORPHAN',$1,$2,'CONCLUIDA',$3)`,
      [e2e, amountCents, { pix: [paid] }]);
    return paid;
  }

  buildWebhook(pixList) {
    const body = JSON.stringify({ pix: pixList.map((p) => ({ endToEndId: p.endToEndId, txid: p.txid, valor: centsToDecimal(p.amountCents), horario: p.paidAt })) });
    const signature = crypto.createHmac('sha256', config.pix.demoWebhookSecret).update(body).digest('hex');
    return { body, headers: { 'content-type': 'application/json', 'x-demo-signature': signature } };
  }
}

module.exports = { DemoPixProvider };
