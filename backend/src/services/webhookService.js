'use strict';
/**
 * Recebimento de notificações (webhooks) de provedores.
 *  1. valida a autenticidade (segredo/assinatura/mTLS);
 *  2. grava o evento bruto com chave de idempotência (provider + identificador do evento);
 *  3. RECONSULTA a cobrança/transação no provedor — o payload nunca é usado como prova de pagamento;
 *  4. aplica a confirmação de forma idempotente.
 * Eventos com erro (ex.: banco indisponível) ficam com status ERRO e são reprocessados.
 */
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { systemCtx } = require('./audit');
const payments = require('./paymentService');
const { pixProvider, cardProvider, boletoProvider } = require('../integrations');
const { unauthorized, badRequest } = require('../lib/errors');

const hash = (s) => crypto.createHash('sha256').update(s || '').digest('hex');
const safeHeaders = (h) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())));

async function storeEvent(provider, eventKey, signatureValid, headers, payload, status = 'RECEBIDO') {
  const { rows } = await pool.query(
    `INSERT INTO payment_webhook_events (provider, event_key, signature_valid, headers, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ON CONSTRAINT payment_webhook_events_uq DO NOTHING RETURNING *`,
    [provider, eventKey, signatureValid, safeHeaders(headers), payload, status]);
  if (rows[0]) return { event: rows[0], isNew: true };
  const { rows: [existing] } = await pool.query('SELECT * FROM payment_webhook_events WHERE provider = $1 AND event_key = $2', [provider, eventKey]);
  return { event: existing, isNew: false };
}

async function finish(eventId, status, error = null) {
  await pool.query('UPDATE payment_webhook_events SET status = $2, error = $3, attempts = attempts + 1, processed_at = now() WHERE id = $1', [eventId, status, error]);
}

async function processEvent(event) {
  const ctx = systemCtx(`webhook:${event.provider}`);
  try {
    let r;
    if (event.payload.kind === 'pix') r = await payments.syncPixCharge(event.provider, event.payload.txid, 'WEBHOOK_VALIDADO_CONSULTA', ctx);
    else if (event.payload.kind === 'boleto') r = await payments.syncBoleto(event.provider, event.payload.ourNumber, 'WEBHOOK_VALIDADO_CONSULTA', ctx);
    else r = await payments.syncCardTransaction(event.provider, event.payload.transactionId, 'TERMINAL_PROVEDOR', ctx);
    const status = r.result === 'SEM_COBRANCA' ? 'SEM_COBRANCA' : (r.result === 'DUPLICADO' ? 'DUPLICADO' : 'PROCESSADO');
    await finish(event.id, status, r.result === 'NAO_ENCONTRADA_NO_PROVEDOR' ? 'Cobrança não encontrada na consulta ao provedor' : null);
    return { eventId: event.id, status, result: r.result };
  } catch (err) {
    await finish(event.id, 'ERRO', err.message.slice(0, 1000));
    return { eventId: event.id, status: 'ERRO', error: err.message };
  }
}

async function handlePixWebhook(providerName, { headers, rawBody, params }) {
  const provider = pixProvider(providerName);
  const valid = provider.verifyWebhook({ headers, rawBody, params });
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch (_) { body = { invalid_json: true }; }
  if (!valid) {
    await storeEvent(providerName, `invalid:${hash(rawBody)}`, false, headers, { body, kind: 'pix' }, 'INVALIDO');
    throw unauthorized('Notificação com autenticação inválida.');
  }
  if (!Array.isArray(body.pix)) throw badRequest('Formato de notificação Pix inválido.');
  const results = [];
  for (const pix of body.pix) {
    if (!pix?.txid || !pix?.endToEndId) { results.push({ status: 'IGNORADO', reason: 'pix sem txid/endToEndId' }); continue; }
    const devKey = (pix.devolucoes || []).map((d) => `${d.id}:${d.status}`).join(',');
    const key = `pix:${pix.endToEndId}${devKey ? `:dev:${hash(devKey).slice(0, 16)}` : ''}`;
    const { event, isNew } = await storeEvent(providerName, key, true, headers, { kind: 'pix', txid: pix.txid, endToEndId: pix.endToEndId, notified: pix });
    if (!isNew && event.status !== 'ERRO') {
      // Notificação repetida: não reprocessa (idempotência)
      await pool.query('UPDATE payment_webhook_events SET attempts = attempts + 1 WHERE id = $1', [event.id]);
      results.push({ eventId: event.id, status: 'DUPLICADO' });
      continue;
    }
    results.push(await processEvent(event));
  }
  return { received: true, results };
}

async function handleCardCallback(providerName, { headers, rawBody }) {
  const provider = cardProvider(providerName);
  const valid = provider.verifyCallback({ headers, rawBody });
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch (_) { body = {}; }
  if (!valid) {
    await storeEvent(providerName, `invalid:${hash(rawBody)}`, false, headers, { body, kind: 'card' }, 'INVALIDO');
    throw unauthorized('Callback com autenticação inválida.');
  }
  const transactionId = body.transactionId || body.payment_id || body.transaction_id;
  if (!transactionId) throw badRequest('Callback sem identificador da transação.');
  const key = `card:${transactionId}:${body.status || 'NA'}`;
  const { event, isNew } = await storeEvent(providerName, key, true, headers, { kind: 'card', transactionId, notified: body });
  if (!isNew && event.status !== 'ERRO') {
    await pool.query('UPDATE payment_webhook_events SET attempts = attempts + 1 WHERE id = $1', [event.id]);
    return { received: true, results: [{ eventId: event.id, status: 'DUPLICADO' }] };
  }
  return { received: true, results: [await processEvent(event)] };
}

async function handleBoletoWebhook(providerName, { headers, rawBody, params }) {
  const provider = boletoProvider(providerName);
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch (_) { body = {}; }
  if (!provider.verifyWebhook({ headers, rawBody, params })) {
    await storeEvent(providerName, `invalid:${hash(rawBody)}`, false, headers, { body, kind: 'boleto' }, 'INVALIDO');
    throw unauthorized('Notificação com autenticação inválida.');
  }
  const ourNumber = body.nossoNumero || body.bankNumber || body.ourNumber;
  if (!ourNumber) throw badRequest('Notificação sem nosso número.');
  const key = `boleto:${ourNumber}:${body.situacao || body.status || 'NA'}`;
  const { event, isNew } = await storeEvent(providerName, key, true, headers, { kind: 'boleto', ourNumber: String(ourNumber), notified: body });
  if (!isNew && event.status !== 'ERRO') {
    await pool.query('UPDATE payment_webhook_events SET attempts = attempts + 1 WHERE id = $1', [event.id]);
    return { received: true, results: [{ eventId: event.id, status: 'DUPLICADO' }] };
  }
  return { received: true, results: [await processEvent(event)] };
}

/** Reprocessa eventos que falharam (ex.: banco fora do ar). Executado periodicamente e sob demanda. */
async function retryFailed({ maxAttempts = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_webhook_events WHERE status = 'ERRO' AND signature_valid AND attempts < $1 ORDER BY id LIMIT 50`, [maxAttempts]);
  const out = [];
  for (const e of rows) out.push(await processEvent(e));
  return out;
}

async function list({ status, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, provider, event_key, signature_valid, status, error, attempts, received_at, processed_at, payload
       FROM payment_webhook_events ${status ? 'WHERE status = $2' : ''} ORDER BY id DESC LIMIT $1`, status ? [limit, status] : [limit]);
  return rows;
}

module.exports = { handlePixWebhook, handleCardCallback, handleBoletoWebhook, retryFailed, list };
