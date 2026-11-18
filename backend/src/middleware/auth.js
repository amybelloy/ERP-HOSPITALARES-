'use strict';
const config = require('../config');
const { resolveSession } = require('../services/authService');
const { unauthorized, forbidden } = require('../lib/errors');

/** Monta o contexto da requisição (usuário, IP, user-agent) para auditoria. */
async function sessionContext(req, _res, next) {
  const token = req.cookies?.[config.session.cookieName];
  const session = await resolveSession(token);
  req.ctx = { user: session?.user || null, sessionToken: token, ip: req.ip, userAgent: req.get('user-agent') };
  next();
}

function requireAuth(req, _res, next) {
  if (!req.ctx?.user) return next(unauthorized('Sessão expirada ou inexistente. Faça login novamente.'));
  next();
}

const has = (user, perm) => !!user && Array.isArray(user.permissions) && user.permissions.includes(perm);

/** Exige ao menos uma das permissões informadas. */
function requirePermission(...perms) {
  return (req, _res, next) => {
    if (!req.ctx?.user) return next(unauthorized());
    if (!perms.some((p) => has(req.ctx.user, p))) return next(forbidden(`Permissão necessária: ${perms.join(' ou ')}.`));
    next();
  };
}

/**
 * Proteção CSRF complementar ao cookie SameSite=Strict:
 * requisições que alteram estado precisam do cabeçalho X-Requested-With (não enviável por formulários de outro site).
 */
function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'SaudeGestao') return next(forbidden('Requisição sem cabeçalho de proteção CSRF.'));
  next();
}

module.exports = { sessionContext, requireAuth, requirePermission, csrfGuard, has };
