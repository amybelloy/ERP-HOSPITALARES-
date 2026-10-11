'use strict';
/** CRUD genérico e auditado para cadastros auxiliares (profissionais, fornecedores, convênios, procedimentos). */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { isValidCNPJ, isValidCPF } = require('../lib/docs');
const { notFound, conflict } = require('../lib/errors');

const ENTITIES = {
  professionals: {
    search: ['name', 'council_number', 'specialty'],
    parse(v) {
      const d = {
        name: v.string('name', { required: true, max: 160, min: 3, label: 'Nome' }),
        kind: v.oneOf('kind', ['MEDICO', 'ENFERMEIRO', 'TECNICO', 'FISIOTERAPEUTA', 'PSICOLOGO', 'NUTRICIONISTA', 'OUTRO'], { label: 'Tipo' }),
        council: v.string('council', { max: 20, label: 'Conselho' }),
        council_number: v.string('council_number', { max: 20 }),
        council_state: v.string('council_state', { max: 2, min: 2 }),
        specialty: v.string('specialty', { max: 120 }),
        cpf: v.digits('cpf', { length: 11, label: 'CPF' }),
        email: v.string('email', { max: 160 }),
        phone: v.string('phone', { max: 30 }),
        active: v.bool('active'),
      };
      if (d.cpf && !isValidCPF(d.cpf)) v.fail('cpf', 'CPF inválido.');
      return d;
    },
  },
  suppliers: {
    search: ['name', 'trade_name', 'cnpj'],
    parse(v) {
      const d = {
        name: v.string('name', { required: true, max: 160, min: 3, label: 'Razão social' }),
        trade_name: v.string('trade_name', { max: 160 }),
        cnpj: v.digits('cnpj', { length: 14, label: 'CNPJ' }),
        category: v.string('category', { max: 80 }),
        email: v.string('email', { max: 160 }),
        phone: v.string('phone', { max: 30 }),
        active: v.bool('active'),
      };
      if (d.cnpj && !isValidCNPJ(d.cnpj)) v.fail('cnpj', 'CNPJ inválido.');
      return d;
    },
  },
  insurance_plans: {
    search: ['name', 'ans_code'],
    parse(v) {
      const d = {
        name: v.string('name', { required: true, max: 160, label: 'Nome' }),
        ans_code: v.string('ans_code', { max: 20, label: 'Registro ANS' }),
        cnpj: v.digits('cnpj', { length: 14, label: 'CNPJ' }),
        plan_type: v.string('plan_type', { max: 80 }),
        phone: v.string('phone', { max: 30 }),
        email: v.string('email', { max: 160 }),
        active: v.bool('active'),
      };
      if (d.cnpj && !isValidCNPJ(d.cnpj)) v.fail('cnpj', 'CNPJ inválido.');
      return d;
    },
  },
  procedures: {
    search: ['name', 'code', 'category'],
    parse(v) {
      return {
        code: v.string('code', { required: true, max: 30, label: 'Código' }),
        name: v.string('name', { required: true, max: 200, label: 'Nome' }),
        category: v.string('category', { max: 80, label: 'Categoria' }),
        description: v.string('description', { max: 2000 }),
        price_cents: v.cents('price_cents', { required: true, allowZero: true, label: 'Preço particular' }),
        active: v.bool('active'),
        service_list_item: v.string('service_list_item', { max: 10, label: 'Item LC 116' }),
        national_tax_code: v.string('national_tax_code', { max: 10, label: 'Código de tributação nacional' }),
        nbs_code: v.string('nbs_code', { max: 12 }),
        iss_rate_bp: v.int('iss_rate_bp', { min: 0, max: 10000, label: 'Alíquota ISS (pontos-base)' }),
        tuss_code: v.string('tuss_code', { max: 20, label: 'Código TUSS' }),
        billing_notes: v.string('billing_notes', { max: 2000 }),
      };
    },
  },
};

function parse(entity, body) {
  const v = validator(body);
  const data = ENTITIES[entity].parse(v);
  v.done();
  for (const k of Object.keys(data)) if (body[k] === undefined) delete data[k]; // ausente = mantém valor atual / padrão do banco
  if (data.active === null) delete data.active;
  return data;
}

async function list(entity, { q, active } = {}) {
  const def = ENTITIES[entity];
  const params = []; const where = [];
  if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`(${def.search.map((c) => `lower(${c}::text) LIKE $1`).join(' OR ')})`); }
  if (active === 'true' || active === 'false') { params.push(active === 'true'); where.push(`active = $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM ${entity} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name LIMIT 500`, params);
  return rows;
}

async function get(entity, id) {
  const { rows: [r] } = await pool.query(`SELECT * FROM ${entity} WHERE id = $1`, [id]);
  if (!r) throw notFound();
  return r;
}

async function create(entity, body, ctx) {
  const data = parse(entity, body);
  const cols = Object.keys(data);
  return withTransaction(async (c) => {
    try {
      const { rows: [r] } = await c.query(`INSERT INTO ${entity} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => data[k]));
      await audit(c, ctx, 'CADASTRO_CRIADO', entity, r.id, data);
      return r;
    } catch (e) {
      if (e.code === '23505') throw conflict('Registro duplicado (código/documento já cadastrado).');
      throw e;
    }
  });
}

async function update(entity, id, body, ctx) {
  const data = parse(entity, body);
  const cols = Object.keys(data);
  return withTransaction(async (c) => {
    const { rows: [old] } = await c.query(`SELECT * FROM ${entity} WHERE id = $1 FOR UPDATE`, [id]);
    if (!old) throw notFound();
    if (!cols.length) return old;
    try {
      const { rows: [r] } = await c.query(`UPDATE ${entity} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => data[k])]);
      const changes = Object.fromEntries(cols.filter((k) => String(old[k] ?? '') !== String(r[k] ?? '')).map((k) => [k, { de: old[k], para: r[k] }]));
      await audit(c, ctx, 'CADASTRO_ALTERADO', entity, id, changes);
      return r;
    } catch (e) {
      if (e.code === '23505') throw conflict('Registro duplicado (código/documento já cadastrado).');
      throw e;
    }
  });
}

module.exports = { list, get, create, update, ENTITIES };
