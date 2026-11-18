'use strict';
const { pool } = require('../db/pool');

/**
 * Registra uma operação na trilha de auditoria (tabela somente-inserção).
 * `ctx` = { user, ip, userAgent } — normalmente vindo de req.ctx.
 * `db` permite gravar dentro da mesma transação da operação auditada.
 */
async function audit(db, ctx, action, entity, entityId, details = {}) {
  const c = ctx || {};
  await (db || pool).query(
    `INSERT INTO audit_logs (user_id, user_email, action, entity, entity_id, details, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c.user?.id || null, c.user?.email || c.actor || null, action, entity, entityId == null ? null : String(entityId),
      details, c.ip || null, c.userAgent ? String(c.userAgent).slice(0, 300) : null],
  );
}

/** Contexto para operações iniciadas pelo sistema (webhooks, rotinas). */
const systemCtx = (actor = 'sistema') => ({ user: null, actor, ip: null, userAgent: null });

module.exports = { audit, systemCtx };
