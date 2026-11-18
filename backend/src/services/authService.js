'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { pool } = require('../db/pool');
const { audit } = require('./audit');
const { unauthorized } = require('../lib/errors');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Hash fixo para comparar mesmo quando o usuário não existe (evita enumeração por tempo de resposta)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

async function login(email, password, meta) {
  const { rows } = await pool.query(
    `SELECT u.*, r.code AS role_code, r.name AS role_name, r.permissions
       FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`, [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  const ctx = { user: user ? { id: user.id, email: user.email } : null, actor: email, ...meta };

  if (!user || !user.active) {
    await audit(null, ctx, 'LOGIN_FALHA', 'users', user?.id, { motivo: user ? 'inativo' : 'usuario_inexistente' });
    throw unauthorized('E-mail ou senha inválidos.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await audit(null, ctx, 'LOGIN_BLOQUEADO', 'users', user.id, {});
    throw unauthorized('Usuário temporariamente bloqueado por tentativas inválidas. Tente mais tarde.');
  }
  if (!ok) {
    const failed = user.failed_logins + 1;
    const lock = failed >= config.security.maxFailedLogins;
    await pool.query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock, String(config.security.lockMinutes)]);
    await audit(null, ctx, 'LOGIN_FALHA', 'users', user.id, { tentativas: failed, bloqueado: lock });
    throw unauthorized('E-mail ou senha inválidos.');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.session.absoluteHours * 3600 * 1000);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [sha256(token), user.id, expires, meta.ip, meta.userAgent ? String(meta.userAgent).slice(0, 300) : null]);
  await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  await audit(null, ctx, 'LOGIN', 'users', user.id, {});
  return { token, expires, user: publicUser(user) };
}

/** Valida sessão: expiração absoluta + inatividade. Renova last_seen_at. */
async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.name, u.email, u.active,
            r.code AS role_code, r.name AS role_name, r.permissions
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL`, [sha256(token)]);
  const s = rows[0];
  if (!s || !s.active) return null;
  const now = Date.now();
  const idleLimit = new Date(s.last_seen_at).getTime() + config.session.idleMinutes * 60 * 1000;
  if (new Date(s.expires_at).getTime() < now || idleLimit < now) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.session_id]);
    return null;
  }
  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
  return { sessionId: s.session_id, user: publicUser(s) };
}

async function logout(token, ctx) {
  if (!token) return;
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
  await audit(null, ctx, 'LOGOUT', 'users', ctx.user?.id, {});
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role_code, roleName: u.role_name, permissions: u.permissions };
}

const hashPassword = (p) => bcrypt.hash(p, config.security.bcryptRounds);

/** Política mínima de senha */
function checkPasswordPolicy(p) {
  return typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

module.exports = { login, resolveSession, logout, hashPassword, checkPasswordPolicy, sha256 };
