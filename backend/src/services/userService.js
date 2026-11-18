'use strict';
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { hashPassword, checkPasswordPolicy } = require('./authService');
const { validator } = require('../lib/validate');
const { ALL } = require('../lib/permissions');
const { notFound, conflict, badRequest, unprocessable } = require('../lib/errors');

async function list() {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.active, u.last_login_at, u.locked_until, u.created_at, r.id AS role_id, r.code AS role_code, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.name`);
  return rows;
}

async function roles() {
  const { rows } = await pool.query('SELECT * FROM roles ORDER BY name');
  return rows;
}

async function create(body, ctx) {
  const v = validator(body);
  const name = v.string('name', { required: true, max: 160, min: 3, label: 'Nome' });
  const email = v.string('email', { required: true, max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, label: 'E-mail' });
  const password = v.string('password', { required: true, max: 200, label: 'Senha', trim: false });
  const roleId = v.id('role_id', { required: true, label: 'Perfil' });
  if (password && !checkPasswordPolicy(password)) v.fail('password', 'A senha deve ter ao menos 10 caracteres, com letras e números.');
  v.done();
  const hash = await hashPassword(password);
  return withTransaction(async (c) => {
    try {
      const { rows: [u] } = await c.query('INSERT INTO users (name, email, password_hash, role_id) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role_id, active', [name, email, hash, roleId]);
      await audit(c, ctx, 'USUARIO_CRIADO', 'users', u.id, { email, role_id: roleId });
      return u;
    } catch (e) {
      if (e.code === '23505') throw conflict('E-mail já cadastrado.');
      if (e.code === '23503') throw badRequest('Perfil inexistente.');
      throw e;
    }
  });
}

async function update(id, body, ctx) {
  const v = validator(body);
  const name = v.string('name', { max: 160, min: 3 });
  const roleId = v.id('role_id');
  const active = v.bool('active');
  const password = v.string('password', { max: 200, trim: false });
  if (password && !checkPasswordPolicy(password)) v.fail('password', 'A senha deve ter ao menos 10 caracteres, com letras e números.');
  v.done();
  if (Number(id) === ctx.user.id && (active === false || roleId)) throw unprocessable('Você não pode desativar ou alterar o perfil do próprio usuário.');
  const hash = password ? await hashPassword(password) : null;
  return withTransaction(async (c) => {
    const { rows: [old] } = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!old) throw notFound('Usuário não encontrado.');
    const { rows: [u] } = await c.query(
      `UPDATE users SET name = COALESCE($2, name), role_id = COALESCE($3, role_id), active = COALESCE($4, active),
              password_hash = COALESCE($5, password_hash), failed_logins = CASE WHEN $5 IS NULL THEN failed_logins ELSE 0 END,
              locked_until = CASE WHEN $5 IS NULL THEN locked_until ELSE NULL END, updated_at = now()
        WHERE id = $1 RETURNING id, name, email, role_id, active`, [id, name, roleId, active, hash]);
    if (active === false || hash || roleId) await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, ctx, 'USUARIO_ALTERADO', 'users', id, { nome: name || undefined, role_id: roleId || undefined, ativo: active ?? undefined, senha_alterada: !!hash });
    return u;
  });
}

async function updateRole(id, body, ctx) {
  const perms = Array.isArray(body.permissions) ? body.permissions : null;
  if (!perms || perms.some((p) => !ALL.includes(p))) throw badRequest('Lista de permissões inválida.');
  return withTransaction(async (c) => {
    const { rows: [old] } = await c.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [id]);
    if (!old) throw notFound('Perfil não encontrado.');
    if (old.code === 'admin' && !perms.includes('users.manage')) throw unprocessable('O perfil Administração deve manter a permissão de gerenciar usuários.');
    const { rows: [r] } = await c.query('UPDATE roles SET permissions = $2 WHERE id = $1 RETURNING *', [id, perms]);
    await audit(c, ctx, 'PERFIL_ALTERADO', 'roles', id, { adicionadas: perms.filter((p) => !old.permissions.includes(p)), removidas: old.permissions.filter((p) => !perms.includes(p)) });
    return r;
  });
}

module.exports = { list, roles, create, update, updateRole };
