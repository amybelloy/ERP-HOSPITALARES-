'use strict';
/**
 * Endpoints públicos de notificação (sem sessão de usuário; autenticados por segredo/assinatura/mTLS).
 * O corpo é lido em formato bruto para validação de assinatura.
 */
const express = require('express');
const webhooks = require('../services/webhookService');

const r = express.Router();
const raw = express.raw({ type: '*/*', limit: '1mb' });

async function pix(req, res) {
  const result = await webhooks.handlePixWebhook(req.params.provider, {
    headers: req.headers, rawBody: req.body?.length ? req.body.toString('utf8') : '', params: req.params,
  });
  res.status(200).json(result);
}

// BACEN: o PSP acrescenta "/pix" ao final da URL cadastrada
r.post('/pix/:provider{/:secret}/pix', raw, pix);
r.post('/pix/:provider{/:secret}', raw, pix);

r.post('/card/:provider', raw, async (req, res) => {
  const result = await webhooks.handleCardCallback(req.params.provider, { headers: req.headers, rawBody: req.body?.length ? req.body.toString('utf8') : '' });
  res.status(200).json(result);
});

module.exports = r;
