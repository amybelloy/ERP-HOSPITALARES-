'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { sessionContext, csrfGuard } = require('./middleware/auth');
const { AppError } = require('./lib/errors');
const apiRoutes = require('./routes/api');
const webhookRoutes = require('./routes/webhooks');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: { 'img-src': ["'self'", 'data:'], 'script-src': ["'self'"], 'style-src': ["'self'"], 'connect-src': ["'self'"] },
    },
    hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', demoMode: config.demoMode }));

  // Webhooks: corpo bruto, sem cookies/sessão e sem CSRF
  app.use('/api/webhooks', webhookRoutes);

  app.use('/api', express.json({ limit: '6mb' }), cookieParser(), sessionContext, csrfGuard, (req, res, next) => {
    res.set('Cache-Control', 'no-store'); // dados sensíveis não devem ficar em cache
    next();
  }, apiRoutes);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NAO_ENCONTRADO', message: 'Rota inexistente.' } }));

  // Frontend estático
  const front = path.resolve(__dirname, '../../frontend');
  app.use(express.static(front, { index: 'index.html', maxAge: config.env === 'production' ? '1h' : 0 }));

  // Tratamento de erros
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'JSON_INVALIDO', message: 'JSON inválido.' } });
    if (err.code === 'P0001') return res.status(422).json({ error: { code: 'OPERACAO_BLOQUEADA', message: err.message } });
    if (err.code === '23514') return res.status(422).json({ error: { code: 'INTEGRIDADE', message: 'Operação violaria uma regra de integridade financeira.', details: { constraint: err.constraint } } });
    if (err.code === '23505') return res.status(409).json({ error: { code: 'DUPLICADO', message: 'Registro duplicado.' } });
    if (err.code === '22P02') return res.status(400).json({ error: { code: 'VALIDACAO', message: 'Parâmetro inválido.' } });
    console.error('[ERRO]', err);
    res.status(500).json({ error: { code: 'ERRO_INTERNO', message: 'Erro interno. A operação não foi concluída.' } });
  });

  return app;
}

module.exports = { createApp };
