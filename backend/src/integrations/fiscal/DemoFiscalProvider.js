'use strict';
/**
 * PROVEDOR FISCAL DE DEMONSTRAÇÃO
 * NÃO transmite nada a nenhuma prefeitura ou ao Ambiente Nacional. NÃO gera nota oficial.
 * Todo retorno é identificado como DEMONSTRAÇÃO e o documento é gravado com is_demo = true.
 */
const crypto = require('crypto');
const { FiscalProvider } = require('./FiscalProvider');
const { providerError } = require('../../lib/errors');

class DemoFiscalProvider extends FiscalProvider {
  constructor() { super(); this.nextOutcome = 'EMITIR'; this.failureMode = false; } // EMITIR | PENDENTE | REJEITAR
  get name() { return 'DEMO_FISCAL'; }
  get isDemo() { return true; }
  status() { return { configured: true, missing: [], demo: true }; }

  async emit(doc) {
    if (this.failureMode) throw providerError('DEMONSTRAÇÃO: falha de comunicação simulada com o serviço fiscal.');
    const outcome = this.nextOutcome;
    if (outcome === 'REJEITAR') {
      return { status: 'REJEITADA', rejectionReason: 'DEMONSTRAÇÃO: rejeição simulada — E0712 Código de tributação nacional inválido para o município (exemplo).', raw: { demo: true } };
    }
    const protocol = `DEMO-PROT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    if (outcome === 'PENDENTE') return { status: 'PROCESSANDO', protocol, raw: { demo: true, pendingChecks: 0 } };
    return this._issued(doc, protocol);
  }

  _issued(doc, protocol) {
    return {
      status: 'EMITIDA', protocol,
      nfseNumber: `DEMO-${String(doc.dps_number).padStart(6, '0')}`,
      verificationCode: `DEMO${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      accessKey: null, officialUrl: null,
      raw: { demo: true, aviso: 'SIMULAÇÃO — SEM VALIDADE FISCAL' },
    };
  }

  async check(doc) {
    if (this.failureMode) throw providerError('DEMONSTRAÇÃO: falha de comunicação simulada com o serviço fiscal.');
    if (doc.status !== 'PROCESSANDO') return { status: doc.status };
    if (this.nextOutcome === 'PENDENTE') return { status: 'PROCESSANDO', protocol: doc.protocol };
    if (this.nextOutcome === 'REJEITAR') return { status: 'REJEITADA', rejectionReason: 'DEMONSTRAÇÃO: rejeição simulada no processamento assíncrono.' };
    return this._issued(doc, doc.protocol);
  }

  async cancel() { return { status: 'CANCELADA', raw: { demo: true } }; }
}

module.exports = { DemoFiscalProvider };
