'use strict';
/**
 * ADAPTADOR GETNET (estrutura)
 *
 * A Getnet oferece diferentes produtos para pagamento presencial. O caminho correto depende do contrato:
 *   a) TEF (pinpad conectado ao computador do caixa, normalmente via gerenciador TEF homologado);
 *   b) POS Android com integração por API/deeplink ("pagamento integrado");
 *   c) API em nuvem que envia a cobrança a um terminal cadastrado.
 *
 * Este adaptador implementa o contrato CardProvider para o cenário (c)/(b) com chamadas HTTP
 * autenticadas por OAuth2. Os caminhos abaixo são PONTOS DE AJUSTE: devem ser confirmados com a
 * documentação/homologação fornecida pela Getnet para o produto contratado.
 * Enquanto as variáveis não estiverem definidas, o sistema usa o registro MANUAL (com conferência).
 */
const crypto = require('crypto');
const config = require('../../config');
const { CardProvider } = require('./CardProvider');
const { request } = require('../http');
const { notConfigured, providerError } = require('../../lib/errors');

const REQUIRED = { GETNET_BASE_URL: 'baseUrl', GETNET_CLIENT_ID: 'clientId', GETNET_CLIENT_SECRET: 'clientSecret', GETNET_SELLER_ID: 'sellerId', GETNET_TERMINAL_ID: 'terminalId' };

// Mapeamento de status do provedor -> status normalizado (ajustar conforme documentação)
const STATUS_MAP = { APPROVED: 'APROVADA', AUTHORIZED: 'APROVADA', CONFIRMED: 'APROVADA', DENIED: 'NEGADA', DECLINED: 'NEGADA', ERROR: 'NEGADA',
  CANCELED: 'CANCELADA', CANCELLED: 'CANCELADA', PENDING: 'PROCESSANDO', WAITING: 'PROCESSANDO' };

class GetnetProvider extends CardProvider {
  constructor(cfg = config.card.getnet) { super(); this.cfg = cfg; this.token = null; this.tokenExp = 0; }
  get name() { return 'GETNET'; }

  status() {
    const missing = Object.entries(REQUIRED).filter(([, k]) => !this.cfg[k]).map(([env]) => env);
    return { configured: missing.length === 0, missing };
  }

  _ensure() {
    const st = this.status();
    if (!st.configured) throw notConfigured(`Integração Getnet não configurada. Variáveis ausentes: ${st.missing.join(', ')}`);
  }

  async _auth() {
    this._ensure();
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await request(`${this.cfg.baseUrl}/auth/oauth/v2/token`, {
      method: 'POST', timeoutMs: this.cfg.timeoutMs, body: 'scope=oob&grant_type=client_credentials',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (res.status !== 200 || !res.body?.access_token) throw providerError('Getnet: falha na autenticação.', { status: res.status });
    this.token = res.body.access_token;
    this.tokenExp = Date.now() + Number(res.body.expires_in || 3600) * 1000;
    return this.token;
  }

  async _call(method, path, body) {
    const token = await this._auth();
    const res = await request(`${this.cfg.baseUrl}${path}`, {
      method, body, timeoutMs: this.cfg.timeoutMs, headers: { Authorization: `Bearer ${token}`, seller_id: this.cfg.sellerId },
    });
    if (res.status === 404) return null;
    if (res.status >= 400) throw providerError(`Getnet: erro ${res.status} em ${method} ${path}`, res.body);
    return res.body;
  }

  _normalize(t) {
    if (!t) return null;
    return {
      transactionId: t.payment_id || t.transaction_id || t.id,
      status: STATUS_MAP[String(t.status || '').toUpperCase()] || 'PROCESSANDO',
      amountCents: Number(t.amount),
      nsu: t.nsu || t.acquirer_transaction_id || null,
      authorizationCode: t.authorization_code || null,
      brand: t.brand || null,
      cardLast4: t.last_four_digits || null,
      message: t.status_details || t.message || null,
      raw: t,
    };
  }

  // PONTO DE AJUSTE: caminho do endpoint de envio ao terminal
  async startTransaction({ reference, amountCents, type, installments }) {
    const t = await this._call('POST', '/v1/pos/payments', {
      seller_id: this.cfg.sellerId, terminal_id: this.cfg.terminalId, order_id: reference, amount: amountCents, currency: 'BRL',
      payment_type: type === 'DEBITO' ? 'DEBIT' : 'CREDIT', installments: installments || 1,
    });
    return this._normalize(t);
  }

  async getTransaction(transactionId) { return this._normalize(await this._call('GET', `/v1/pos/payments/${encodeURIComponent(transactionId)}`)); }

  async cancelTransaction({ transactionId, amountCents }) {
    const r = await this._call('POST', `/v1/pos/payments/${encodeURIComponent(transactionId)}/cancel`, { amount: amountCents });
    return { status: STATUS_MAP[String(r?.status || '').toUpperCase()] || 'PROCESSANDO', cancelId: r?.cancel_request_id || r?.id };
  }

  /** Callback assinado com HMAC-SHA256 (segredo CARD_CALLBACK_SECRET). Ajustar ao esquema de assinatura do contrato. */
  verifyCallback({ headers, rawBody }) {
    const sig = headers['x-signature'] || '';
    if (!rawBody || !sig) return false;
    const expected = crypto.createHmac('sha256', config.card.callbackSecret).update(rawBody).digest('hex');
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
}

module.exports = { GetnetProvider };
