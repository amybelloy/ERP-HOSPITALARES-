'use strict';
/**
 * Registro de provedores. Escolha via variáveis de ambiente (PIX_PROVIDER, CARD_PROVIDER, FISCAL_PROVIDER).
 * Os provedores de demonstração só são instanciados com DEMO_MODE=true.
 */
const config = require('../config');
const { DemoPixProvider } = require('./pix/DemoPixProvider');
const { SantanderPixProvider } = require('./pix/SantanderPixProvider');
const { DemoCardProvider } = require('./card/DemoCardProvider');
const { GetnetProvider } = require('./card/GetnetProvider');
const { DemoBoletoProvider } = require('./boleto/DemoBoletoProvider');
const { SantanderBoletoProvider } = require('./boleto/SantanderBoletoProvider');
const { DemoFiscalProvider } = require('./fiscal/DemoFiscalProvider');
const { NfseNacionalProvider } = require('./fiscal/NfseNacionalProvider');
const { notConfigured } = require('../lib/errors');

const registry = { pix: {}, card: {}, fiscal: {}, boleto: {} };

function init() {
  registry.pix = { SANTANDER_PIX: new SantanderPixProvider() };
  registry.card = { GETNET: new GetnetProvider() };
  registry.fiscal = { NFSE_NACIONAL: new NfseNacionalProvider() };
  registry.boleto = { SANTANDER_BOLETO: new SantanderBoletoProvider() };
  if (config.demoMode) {
    registry.pix.DEMO_PIX = new DemoPixProvider();
    registry.card.DEMO_CARD = new DemoCardProvider();
    registry.fiscal.DEMO_FISCAL = new DemoFiscalProvider();
    registry.boleto.DEMO_BOLETO = new DemoBoletoProvider();
  }
}
init();

function get(kind, name) {
  const p = registry[kind][name];
  if (!p) throw notConfigured(`Provedor ${kind} "${name}" indisponível${name?.startsWith('DEMO') ? ' (DEMO_MODE desativado)' : ''}.`);
  return p;
}

const pixProvider = (name = config.pix.provider) => get('pix', name);
const cardProvider = (name = config.card.provider) => get('card', name);
const fiscalProvider = (name = config.fiscal.provider) => get('fiscal', name);
const boletoProvider = (name = config.boleto.provider) => get('boleto', name);

function statusAll() {
  const describe = (kind, active) => Object.entries(registry[kind]).map(([name, p]) => ({ name, active: name === active, demo: p.isDemo, ...p.status() }));
  return {
    demoMode: config.demoMode,
    pix: describe('pix', config.pix.provider),
    card: describe('card', config.card.provider),
    fiscal: describe('fiscal', config.fiscal.provider),
    boleto: describe('boleto', config.boleto.provider),
  };
}

module.exports = { pixProvider, cardProvider, fiscalProvider, boletoProvider, statusAll, registry, init };
