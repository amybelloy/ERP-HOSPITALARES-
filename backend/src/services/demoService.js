'use strict';
/**
 * SIMULAÇÕES DO MODO DE DEMONSTRAÇÃO
 * Simulam o "lado de fora" (banco, terminal, prefeitura). As simulações NÃO alteram a conta diretamente:
 * elas mudam o estado do provedor simulado e disparam o MESMO fluxo de webhook/consulta usado em produção.
 */
const config = require('../config');
const { pool } = require('../db/pool');
const { registry } = require('../integrations');
const webhooks = require('./webhookService');
const payments = require('./paymentService');
const { audit } = require('./audit');
const { notConfigured, notFound, unprocessable } = require('../lib/errors');
const { validator } = require('../lib/validate');

function ensureDemo() {
  if (!config.demoMode) throw notConfigured('Modo de demonstração desativado.');
}

async function simulatePix(paymentId, body, ctx) {
  ensureDemo();
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (p.provider !== 'DEMO_PIX') throw unprocessable('Simulação disponível apenas para cobranças do provedor de DEMONSTRAÇÃO.');
  const outcome = body.outcome || 'PAGAR';
  const provider = registry.pix.DEMO_PIX;
  await audit(null, ctx, 'DEMO_SIMULACAO_PIX', 'payments', paymentId, { outcome });
  if (outcome === 'EXPIRAR') {
    await provider.simulateExpiration(p.provider_charge_id);
    return payments.refresh(paymentId, ctx);
  }
  const webhook = await provider.simulatePayment(p.provider_charge_id, { amountCents: body.amount_cents });
  const result = await webhooks.handlePixWebhook('DEMO_PIX', { headers: webhook.headers, rawBody: webhook.body, params: {} });
  return { webhook: result, payment: await payments.getPayment(paymentId), webhookBody: webhook.body, webhookHeaders: webhook.headers };
}

async function simulateCard(paymentId, body, ctx) {
  ensureDemo();
  const { rows: [p] } = await pool.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p) throw notFound('Pagamento não encontrado.');
  if (p.provider !== 'DEMO_CARD') throw unprocessable('Simulação disponível apenas para o terminal de DEMONSTRAÇÃO.');
  const outcome = body.outcome === 'NEGADA' ? 'NEGADA' : 'APROVADA';
  await audit(null, ctx, 'DEMO_SIMULACAO_CARTAO', 'payments', paymentId, { outcome });
  const cb = await registry.card.DEMO_CARD.simulateResult(p.provider_charge_id, outcome);
  const result = await webhooks.handleCardCallback('DEMO_CARD', { headers: cb.headers, rawBody: cb.body });
  return { callback: result, payment: await payments.getPayment(paymentId) };
}

async function setFailure(body, ctx) {
  ensureDemo();
  const v = validator(body);
  const target = v.oneOf('target', ['pix', 'card', 'fiscal'], { required: true });
  const enabled = v.bool('enabled', { def: false });
  v.done();
  const map = { pix: registry.pix.DEMO_PIX, card: registry.card.DEMO_CARD, fiscal: registry.fiscal.DEMO_FISCAL };
  map[target].failureMode = enabled;
  await audit(null, ctx, 'DEMO_FALHA_PROVEDOR', 'demo', target, { enabled });
  return state();
}

async function setFiscalOutcome(body, ctx) {
  ensureDemo();
  const v = validator(body);
  const outcome = v.oneOf('outcome', ['EMITIR', 'PENDENTE', 'REJEITAR'], { required: true });
  v.done();
  registry.fiscal.DEMO_FISCAL.nextOutcome = outcome;
  await audit(null, ctx, 'DEMO_RESULTADO_FISCAL', 'demo', 'fiscal', { outcome });
  return state();
}

async function orphanPix(body, ctx) {
  ensureDemo();
  const v = validator(body);
  const amount = v.cents('amount_cents', { required: true });
  v.done();
  const p = await registry.pix.DEMO_PIX.simulateOrphanPix(amount);
  await audit(null, ctx, 'DEMO_PIX_SEM_COBRANCA', 'demo', p.endToEndId, { amount });
  return p;
}

function state() {
  if (!config.demoMode) return { demoMode: false };
  return {
    demoMode: true,
    pixFailure: registry.pix.DEMO_PIX.failureMode,
    cardFailure: registry.card.DEMO_CARD.failureMode,
    fiscalFailure: registry.fiscal.DEMO_FISCAL.failureMode,
    fiscalNextOutcome: registry.fiscal.DEMO_FISCAL.nextOutcome,
  };
}

module.exports = { simulatePix, simulateCard, setFailure, setFiscalOutcome, orphanPix, state };
