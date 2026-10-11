'use strict';
/**
 * ADAPTADOR BOLETO — SANTANDER (API de Cobrança / registro de boletos) — estrutura.
 * Requisitos: convênio de cobrança, código do beneficiário, carteira, credenciais OAuth2 e certificado mTLS.
 * Os caminhos abaixo são PONTOS DE AJUSTE: confirme na documentação da API de cobrança contratada.
 */
const crypto = require('crypto');
const config = require('../../config');
const { BoletoProvider } = require('./BoletoProvider');
const { buildAgent, request } = require('../http');
const { toCents, centsToDecimal } = require('../../lib/money');
const { notConfigured, providerError } = require('../../lib/errors');

const MAP = { ATIVO: 'REGISTRADO', REGISTRADO: 'REGISTRADO', LIQUIDADO: 'PAGO', PAGO: 'PAGO', BAIXADO: 'BAIXADO', CANCELADO: 'BAIXADO' };

class SantanderBoletoProvider extends BoletoProvider {
  constructor(cfg = config.boleto.santander) { super(); this.cfg = cfg; this.token = null; this.exp = 0; this.agent = null; }
  get name() { return 'SANTANDER_BOLETO'; }
  status() {
    const req = { SANTANDER_BOLETO_BASE_URL: 'baseUrl', SANTANDER_BOLETO_TOKEN_URL: 'tokenUrl', SANTANDER_CLIENT_ID: 'clientId', SANTANDER_CLIENT_SECRET: 'clientSecret',
      SANTANDER_CERT_PATH: 'certPath', SANTANDER_KEY_PATH: 'keyPath', SANTANDER_BOLETO_WORKSPACE: 'workspaceId', SANTANDER_BOLETO_BENEFICIARIO: 'beneficiaryCode' };
    const missing = Object.entries(req).filter(([, k]) => !this.cfg[k]).map(([e]) => e);
    if (!config.boleto.webhookSecret) missing.push('BOLETO_WEBHOOK_SECRET');
    return { configured: !missing.length, missing };
  }
  _ensure() {
    const st = this.status();
    if (!st.configured) throw notConfigured(`Boleto Santander não configurado. Variáveis ausentes: ${st.missing.join(', ')}`);
    if (!this.agent) this.agent = buildAgent({ certPath: this.cfg.certPath, keyPath: this.cfg.keyPath, passphrase: this.cfg.certPassphrase });
  }
  async _auth() {
    this._ensure();
    if (this.token && Date.now() < this.exp - 60000) return this.token;
    const body = `client_id=${encodeURIComponent(this.cfg.clientId)}&client_secret=${encodeURIComponent(this.cfg.clientSecret)}&grant_type=client_credentials`;
    const r = await request(this.cfg.tokenUrl, { method: 'POST', agent: this.agent, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMs: this.cfg.timeoutMs });
    if (r.status !== 200 || !r.body?.access_token) throw providerError('Santander (boleto): falha na autenticação.');
    this.token = r.body.access_token; this.exp = Date.now() + Number(r.body.expires_in || 900) * 1000;
    return this.token;
  }
  async _call(method, path, body) {
    const token = await this._auth();
    const r = await request(`${this.cfg.baseUrl}${path}`, { method, body, agent: this.agent, timeoutMs: this.cfg.timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'X-Application-Key': this.cfg.clientId } });
    if (r.status === 404) return null;
    if (r.status >= 400) throw providerError(`Santander (boleto): erro ${r.status}`, r.body);
    return r.body;
  }
  _norm(b, ourNumber) {
    if (!b) return null;
    return { ourNumber: b.bankNumber || ourNumber, status: MAP[String(b.status || '').toUpperCase()] || 'REGISTRADO', amountCents: b.nominalValue ? toCents(String(b.nominalValue)) : null,
      dueDate: b.dueDate, barcode: b.barCode || b.barcode, digitableLine: b.digitableLine, paidAmountCents: b.paidValue ? toCents(String(b.paidValue)) : null,
      paidAt: b.paymentDate || null, raw: b };
  }
  // PONTO DE AJUSTE: rota de registro conforme a API de cobrança contratada
  async register({ ourNumber, amountCents, dueDate, payer, description }) {
    const b = await this._call('POST', `/workspaces/${this.cfg.workspaceId}/bank_slips`, {
      environment: this.cfg.environment, nsuCode: ourNumber, nsuDate: new Date().toISOString().slice(0, 10), covenantCode: this.cfg.beneficiaryCode,
      bankNumber: ourNumber, dueDate, issueDate: new Date().toISOString().slice(0, 10), nominalValue: centsToDecimal(amountCents),
      payer: { name: payer?.name, documentType: 'CPF', documentNumber: payer?.cpf, address: payer?.address || 'NAO INFORMADO', neighborhood: payer?.district || 'NAO INFORMADO',
        city: payer?.city || 'NAO INFORMADO', state: payer?.state || 'SP', zipCode: payer?.zipCode || '00000000' },
      documentKind: 'DUPLICATA_MERCANTIL', paymentType: 'REGISTRO', messages: [String(description || '').slice(0, 100)],
    });
    return this._norm(b, ourNumber);
  }
  async getBoleto(ourNumber) { return this._norm(await this._call('GET', `/workspaces/${this.cfg.workspaceId}/bank_slips/${ourNumber}`), ourNumber); }
  async cancel(ourNumber) { return this._norm(await this._call('PATCH', `/workspaces/${this.cfg.workspaceId}/bank_slips`, { covenantCode: this.cfg.beneficiaryCode, bankNumber: ourNumber, operation: 'BAIXAR' }), ourNumber); }
  verifyWebhook({ params }) {
    const s = config.boleto.webhookSecret; const g = params?.secret || '';
    return !!s && g.length === s.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(s));
  }
}
module.exports = { SantanderBoletoProvider };
