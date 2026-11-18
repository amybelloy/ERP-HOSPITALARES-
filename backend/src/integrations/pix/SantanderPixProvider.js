'use strict';
/**
 * ADAPTADOR PIX — SANTANDER (API Pix padrão Banco Central)
 *
 * Requisitos (contratação junto ao Santander / portal do desenvolvedor):
 *   - Client ID / Client Secret (OAuth2 client_credentials)
 *   - Certificado digital de cliente para mTLS (cadastrado no portal)
 *   - Chave Pix recebedora da instituição
 *   - URLs base e de token do ambiente (sandbox ou produção) — CONFIRMAR na documentação vigente
 *   - Cadastro do webhook (PUT /webhook/{chave}) apontando para:
 *       https://SEU_DOMINIO/api/webhooks/pix/SANTANDER_PIX/{PIX_WEBHOOK_SECRET}
 *     O Santander entrega webhooks via mTLS: configure o proxy reverso (nginx) para validar
 *     o certificado do banco e repassar o cabeçalho X-Client-Verify: SUCCESS.
 *
 * Endpoints utilizados (padrão BACEN, versão 2.x):
 *   PUT   /cob/{txid}                         criar cobrança imediata
 *   GET   /cob/{txid}                         consultar cobrança (status + pix recebidos)
 *   PATCH /cob/{txid}                         remover cobrança
 *   GET   /pix?inicio=&fim=                   pix recebidos no período (conciliação)
 *   PUT   /pix/{e2eid}/devolucao/{id}         solicitar devolução
 */
const crypto = require('crypto');
const config = require('../../config');
const { PixProvider } = require('./PixProvider');
const { buildAgent, request } = require('../http');
const { toCents, centsToDecimal } = require('../../lib/money');
const { notConfigured, providerError } = require('../../lib/errors');

const REQUIRED = {
  SANTANDER_PIX_BASE_URL: 'baseUrl', SANTANDER_PIX_TOKEN_URL: 'tokenUrl', SANTANDER_CLIENT_ID: 'clientId',
  SANTANDER_CLIENT_SECRET: 'clientSecret', SANTANDER_CERT_PATH: 'certPath', SANTANDER_KEY_PATH: 'keyPath',
  SANTANDER_PIX_KEY: 'pixKey', PIX_WEBHOOK_SECRET: null,
};

class SantanderPixProvider extends PixProvider {
  constructor(cfg = config.pix.santander) {
    super();
    this.cfg = cfg;
    this.token = null;
    this.tokenExp = 0;
    this.agent = null;
  }

  get name() { return 'SANTANDER_PIX'; }

  status() {
    const missing = Object.entries(REQUIRED).filter(([env, key]) => (key ? !this.cfg[key] : !config.pix.webhookSecret)).map(([env]) => env);
    return { configured: missing.length === 0, missing };
  }

  _ensure() {
    const st = this.status();
    if (!st.configured) throw notConfigured(`Integração Pix Santander não configurada. Variáveis ausentes: ${st.missing.join(', ')}`);
    if (!this.agent) this.agent = buildAgent({ certPath: this.cfg.certPath, keyPath: this.cfg.keyPath, passphrase: this.cfg.certPassphrase });
  }

  async _auth() {
    this._ensure();
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await request(this.cfg.tokenUrl, {
      method: 'POST', agent: this.agent, timeoutMs: this.cfg.timeoutMs,
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (res.status !== 200 || !res.body?.access_token) throw providerError('Santander: falha na autenticação OAuth.', { status: res.status });
    this.token = res.body.access_token;
    this.tokenExp = Date.now() + Number(res.body.expires_in || 300) * 1000;
    return this.token;
  }

  async _call(method, path, body) {
    const token = await this._auth();
    const res = await request(`${this.cfg.baseUrl}${path}`, {
      method, body, agent: this.agent, timeoutMs: this.cfg.timeoutMs, headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (res.status >= 400) throw providerError(`Santander: erro ${res.status} em ${method} ${path}`, res.body);
    return res.body;
  }

  _normalizeCharge(c) {
    if (!c) return null;
    return {
      txid: c.txid,
      status: c.status,
      amountCents: toCents(c.valor?.original || '0'),
      copyPaste: c.pixCopiaECola || null,
      location: c.loc?.location || c.location || null,
      expiresAt: c.calendario?.criacao ? new Date(new Date(c.calendario.criacao).getTime() + Number(c.calendario.expiracao || 0) * 1000).toISOString() : null,
      pix: (c.pix || []).map((p) => this._normalizePix(p, c.txid)),
      raw: c,
    };
  }

  _normalizePix(p, txid) {
    return {
      endToEndId: p.endToEndId, txid: p.txid || txid || null, amountCents: toCents(p.valor), paidAt: p.horario,
      refunds: (p.devolucoes || []).map((d) => ({ id: d.id, rtrId: d.rtrId, amountCents: toCents(d.valor), status: d.status, requestedAt: d.horario?.solicitacao })),
    };
  }

  async createCharge({ txid, amountCents, expiresIn, debtor, description }) {
    const body = {
      calendario: { expiracao: expiresIn },
      valor: { original: centsToDecimal(amountCents), modalidadeAlteracao: 0 },
      chave: this.cfg.pixKey,
      solicitacaoPagador: (description || '').slice(0, 140),
    };
    if (debtor?.cpf && debtor?.name) body.devedor = { cpf: debtor.cpf, nome: debtor.name.slice(0, 200) };
    return this._normalizeCharge(await this._call('PUT', `/cob/${txid}`, body));
  }

  async getCharge(txid) { return this._normalizeCharge(await this._call('GET', `/cob/${txid}`)); }

  async cancelCharge(txid) {
    return this._normalizeCharge(await this._call('PATCH', `/cob/${txid}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }));
  }

  async requestRefund({ endToEndId, refundId, amountCents, reason }) {
    const r = await this._call('PUT', `/pix/${endToEndId}/devolucao/${refundId}`, { valor: centsToDecimal(amountCents), descricao: (reason || '').slice(0, 140) });
    return { refundId: r.id, rtrId: r.rtrId, status: r.status, amountCents: toCents(r.valor) };
  }

  async listReceived({ from, to }) {
    const out = [];
    let page = 0; let pages = 1;
    while (page < pages) {
      const qs = `inicio=${encodeURIComponent(new Date(from).toISOString())}&fim=${encodeURIComponent(new Date(to).toISOString())}&paginacao.paginaAtual=${page}&paginacao.itensPorPagina=100`;
      const r = await this._call('GET', `/pix?${qs}`);
      (r?.pix || []).forEach((p) => out.push(this._normalizePix(p)));
      pages = r?.parametros?.paginacao?.quantidadeDePaginas || 1;
      page++;
    }
    return out;
  }

  /**
   * Autenticidade do webhook:
   *  1) segredo no caminho da URL cadastrada no banco (comparação em tempo constante);
   *  2) opcionalmente, cabeçalho do proxy reverso que validou o mTLS do Santander.
   * Mesmo autêntico, o conteúdo do webhook NÃO é usado para quitar: a cobrança é reconsultada via API.
   */
  verifyWebhook({ headers, params }) {
    const secret = config.pix.webhookSecret;
    const given = params?.secret || '';
    if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return false;
    if (config.pix.requireMtlsHeader && headers['x-client-verify'] !== 'SUCCESS') return false;
    return true;
  }
}

module.exports = { SantanderPixProvider };
