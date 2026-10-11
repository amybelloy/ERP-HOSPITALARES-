'use strict';
/**
 * ADAPTADOR NFS-e NACIONAL (Sefin Nacional / ADN) — estrutura
 *
 * Requisitos:
 *   - Município do prestador aderente ao padrão nacional (ou uso do emissor nacional);
 *   - Certificado digital A1 (ICP-Brasil) do CNPJ prestador, em PFX, armazenado no SERVIDOR;
 *   - URL do ambiente (produção restrita para testes / produção);
 *   - Assinatura XML-DSig da DPS (enveloped, RSA-SHA256, C14N) — ver método `signDps`.
 *
 * Fluxo (API REST, mTLS com o certificado do prestador):
 *   POST /nfse                 { dpsXmlGZipB64 }   -> chaveAcesso / idDps (síncrono) ou erros
 *   GET  /nfse/{chaveAcesso}                       -> NFS-e autorizada (XML)
 *   POST /nfse/{chaveAcesso}/eventos               -> evento de cancelamento (e101101)
 * Confirme rotas e leiautes na documentação técnica vigente do Portal Nacional da NFS-e.
 */
const zlib = require('zlib');
const config = require('../../config');
const { FiscalProvider } = require('./FiscalProvider');
const { buildDpsXml } = require('./dps');
const { buildAgent, request } = require('../http');
const { notConfigured, providerError } = require('../../lib/errors');

class NfseNacionalProvider extends FiscalProvider {
  constructor(cfg = config.fiscal.nfseNacional) { super(); this.cfg = cfg; this.agent = null; this.signer = null; }
  get name() { return 'NFSE_NACIONAL'; }

  status() {
    const missing = [];
    if (!this.cfg.baseUrl) missing.push('NFSE_NACIONAL_BASE_URL');
    if (!this.cfg.certPath) missing.push('NFSE_CERT_PATH');
    if (!this.cfg.certPassphrase) missing.push('NFSE_CERT_PASSPHRASE');
    if (!this.signer) missing.push('assinador XML-DSig (registrar com setSigner)');
    return { configured: missing.length === 0, missing };
  }

  /** Registra a função de assinatura XML-DSig: (xml: string, pfx: {path, passphrase}) => Promise<string xmlAssinado> */
  setSigner(fn) { this.signer = fn; }

  _ensure() {
    const st = this.status();
    if (!st.configured) throw notConfigured(`Integração NFS-e Nacional não configurada. Pendências: ${st.missing.join(', ')}`);
    if (!this.agent) this.agent = buildAgent({ pfxPath: this.cfg.certPath, passphrase: this.cfg.certPassphrase });
  }

  async signDps(xml) { return this.signer(xml, { path: this.cfg.certPath, passphrase: this.cfg.certPassphrase }); }

  async emit(doc) {
    this._ensure();
    const signed = await this.signDps(buildDpsXml(doc, { environment: this.cfg.environment }));
    const res = await request(`${this.cfg.baseUrl}/nfse`, {
      method: 'POST', agent: this.agent, timeoutMs: this.cfg.timeoutMs,
      body: { dpsXmlGZipB64: zlib.gzipSync(Buffer.from(signed, 'utf8')).toString('base64') },
    });
    if (res.status === 201 || res.status === 200) {
      const xml = res.body?.nfseXmlGZipB64 ? zlib.gunzipSync(Buffer.from(res.body.nfseXmlGZipB64, 'base64')).toString('utf8') : null;
      const nNFSe = xml ? (/<nNFSe>(\d+)<\/nNFSe>/.exec(xml) || [])[1] : null;
      return { status: 'EMITIDA', accessKey: res.body?.chaveAcesso, nfseNumber: nNFSe, protocol: res.body?.idDps, xml, raw: res.body };
    }
    if (res.status >= 400 && res.status < 500) {
      const errs = (res.body?.erros || res.body?.erro || []).map?.((e) => `${e.Codigo || e.codigo}: ${e.Descricao || e.descricao}`) || [];
      return { status: 'REJEITADA', rejectionReason: errs.join(' | ') || `HTTP ${res.status}`, raw: res.body };
    }
    throw providerError(`NFS-e Nacional: erro ${res.status}`, res.body);
  }

  async check(doc) {
    this._ensure();
    if (!doc.access_key) return { status: doc.status };
    const res = await request(`${this.cfg.baseUrl}/nfse/${doc.access_key}`, { agent: this.agent, timeoutMs: this.cfg.timeoutMs });
    if (res.status === 200) return { status: 'EMITIDA', raw: res.body };
    if (res.status === 404) return { status: 'PROCESSANDO' };
    throw providerError(`NFS-e Nacional: erro ${res.status} na consulta`, res.body);
  }

  async cancel(doc, reason) {
    this._ensure();
    // O evento de cancelamento também é um XML assinado (pedRegEvento). Montagem simplificada; ajustar ao leiaute.
    const evt = `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infPedReg><tpAmb>${this.cfg.environment}</tpAmb><chNFSe>${doc.access_key}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>${String(reason).slice(0, 255)}</xMotivo></e101101></infPedReg></pedRegEvento>`;
    const signed = await this.signDps(evt);
    const res = await request(`${this.cfg.baseUrl}/nfse/${doc.access_key}/eventos`, {
      method: 'POST', agent: this.agent, timeoutMs: this.cfg.timeoutMs,
      body: { pedidoRegistroEventoXmlGZipB64: zlib.gzipSync(Buffer.from(signed)).toString('base64') },
    });
    if (res.status === 201 || res.status === 200) return { status: 'CANCELADA', raw: res.body };
    return { status: 'ERRO', rejectionReason: JSON.stringify(res.body), raw: res.body };
  }
}

module.exports = { NfseNacionalProvider };
