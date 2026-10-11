'use strict';
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { isValidCPF, maskCPF } = require('../lib/docs');
const { conflict, notFound } = require('../lib/errors');
const { has } = require('../middleware/auth');

const FIELDS = ['name', 'social_name', 'cpf', 'birth_date', 'sex', 'mother_name', 'phone', 'email', 'zip_code', 'address', 'address_number',
  'district', 'city', 'city_ibge_code', 'state', 'insurance_plan_id', 'insurance_card_number', 'active'];

function parse(body, { partial = false } = {}) {
  const v = validator(body);
  const data = {
    name: v.string('name', { required: !partial, max: 160, min: 3, label: 'Nome' }),
    social_name: v.string('social_name', { max: 160 }),
    cpf: v.digits('cpf', { length: 11, label: 'CPF' }),
    birth_date: v.date('birth_date', { label: 'Data de nascimento' }),
    sex: v.oneOf('sex', ['F', 'M', 'O'], { label: 'Sexo' }),
    mother_name: v.string('mother_name', { max: 160 }),
    phone: v.string('phone', { max: 30 }),
    email: v.string('email', { max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, label: 'E-mail' }),
    zip_code: v.digits('zip_code', { length: 8, label: 'CEP' }),
    address: v.string('address', { max: 200 }),
    address_number: v.string('address_number', { max: 20 }),
    district: v.string('district', { max: 100 }),
    city: v.string('city', { max: 100 }),
    city_ibge_code: v.digits('city_ibge_code', { length: 7, label: 'Código IBGE' }),
    state: v.string('state', { max: 2, min: 2, pattern: /^[A-Za-z]{2}$/, label: 'UF' }),
    insurance_plan_id: v.id('insurance_plan_id'),
    insurance_card_number: v.string('insurance_card_number', { max: 40 }),
    active: v.bool('active'),
  };
  if (data.cpf && !isValidCPF(data.cpf)) v.fail('cpf', 'CPF inválido.');
  if (data.birth_date && new Date(data.birth_date) > new Date()) v.fail('birth_date', 'Data de nascimento no futuro.');
  if (data.state) data.state = data.state.toUpperCase();
  v.done();
  if (partial) for (const k of Object.keys(data)) if (body[k] === undefined) delete data[k];
  if (data.active === null) delete data.active;
  return data;
}

/** Minimização: oculta dados pessoais para perfis sem `patients.view_sensitive`. */
function present(p, user) {
  if (!p) return p;
  if (has(user, 'patients.view_sensitive')) return p;
  return { ...p, cpf: maskCPF(p.cpf), phone: p.phone ? '(**) *****-' + String(p.phone).slice(-4) : null, email: p.email ? '***' : null,
    address: null, address_number: null, zip_code: null, mother_name: null, masked: true };
}

/** Possíveis duplicidades: mesmo CPF, ou nome muito semelhante + mesma data de nascimento. */
async function findDuplicates(db, { name, cpf, birth_date }, excludeId = null) {
  const { rows } = await db.query(
    `SELECT p.id, p.code, p.name, p.birth_date, p.cpf, mr.record_number,
            CASE WHEN $2::text IS NOT NULL AND p.cpf = $2 THEN 'CPF_IGUAL' ELSE 'NOME_E_NASCIMENTO' END AS reason
       FROM patients p LEFT JOIN medical_records mr ON mr.patient_id = p.id
      WHERE ($4::bigint IS NULL OR p.id <> $4)
        AND (($2::text IS NOT NULL AND p.cpf = $2)
          OR ($3::date IS NOT NULL AND p.birth_date = $3 AND similarity(lower(p.name), lower($1)) > 0.55)
          OR ($3::date IS NULL AND $2::text IS NULL AND similarity(lower(p.name), lower($1)) > 0.85))
      LIMIT 10`, [name || '', cpf || null, birth_date || null, excludeId]);
  return rows;
}

async function create(body, ctx) {
  const data = parse(body);
  return withTransaction(async (c) => {
    const dups = await findDuplicates(c, data);
    if (dups.some((d) => d.reason === 'CPF_IGUAL')) throw conflict('Já existe paciente com este CPF.', { duplicates: dups });
    if (dups.length && !body.confirm_not_duplicate) {
      throw conflict('Possível cadastro duplicado. Verifique os pacientes semelhantes ou confirme que é uma nova pessoa.', { duplicates: dups, possibleDuplicate: true });
    }
    const cols = FIELDS.filter((f) => data[f] !== undefined && data[f] !== null);
    const { rows: [p] } = await c.query(
      `INSERT INTO patients (${cols.join(',')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, $${cols.length + 1}) RETURNING *`,
      [...cols.map((f) => data[f]), ctx.user.id]);
    // Prontuário único do paciente, criado junto ao cadastro.
    const { rows: [mr] } = await c.query('INSERT INTO medical_records (patient_id) VALUES ($1) RETURNING *', [p.id]);
    await audit(c, ctx, 'PACIENTE_CRIADO', 'patients', p.id, { code: p.code, prontuario: mr.record_number, duplicidade_confirmada: !!dups.length });
    return { ...p, record_number: mr.record_number, medical_record_id: mr.id };
  });
}

async function update(id, body, ctx) {
  const data = parse(body, { partial: true });
  return withTransaction(async (c) => {
    const { rows: [old] } = await c.query('SELECT * FROM patients WHERE id = $1 FOR UPDATE', [id]);
    if (!old) throw notFound('Paciente não encontrado.');
    if (data.cpf && data.cpf !== old.cpf) {
      const { rows } = await c.query('SELECT id FROM patients WHERE cpf = $1 AND id <> $2', [data.cpf, id]);
      if (rows.length) throw conflict('Já existe outro paciente com este CPF.');
    }
    const cols = Object.keys(data).filter((k) => FIELDS.includes(k));
    if (!cols.length) return old;
    const { rows: [p] } = await c.query(
      `UPDATE patients SET ${cols.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...cols.map((f) => data[f])]);
    const changes = Object.fromEntries(cols.filter((f) => String(old[f] ?? '') !== String(p[f] ?? '')).map((f) => [f, f === 'cpf' ? 'alterado' : { de: old[f], para: p[f] }]));
    await audit(c, ctx, 'PACIENTE_ALTERADO', 'patients', id, { alteracoes: changes });
    return p;
  });
}

async function search({ q, limit = 30 }) {
  const term = (q || '').trim();
  const digits = term.replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT p.*, mr.record_number, mr.id AS medical_record_id,
            (SELECT max(opened_at) FROM appointments a WHERE a.patient_id = p.id) AS last_appointment_at
       FROM patients p JOIN medical_records mr ON mr.patient_id = p.id
      WHERE $1 = ''
         OR lower(p.name) LIKE '%' || lower($1) || '%'
         OR similarity(lower(p.name), lower($1)) > 0.4
         OR ($2 <> '' AND p.cpf = $2)
         OR upper(p.code) = upper($1)
         OR upper(mr.record_number) = upper($1)
      ORDER BY (upper(p.code) = upper($1) OR upper(mr.record_number) = upper($1) OR p.cpf = $2) DESC,
               similarity(lower(p.name), lower($1)) DESC, p.name
      LIMIT $3`, [term, digits.length === 11 ? digits : '', Math.min(Number(limit) || 30, 100)]);
  return rows;
}

async function get(id) {
  const { rows: [p] } = await pool.query(
    `SELECT p.*, mr.record_number, mr.id AS medical_record_id, ip.name AS insurance_name
       FROM patients p JOIN medical_records mr ON mr.patient_id = p.id LEFT JOIN insurance_plans ip ON ip.id = p.insurance_plan_id
      WHERE p.id = $1`, [id]);
  if (!p) throw notFound('Paciente não encontrado.');
  return p;
}

/** Histórico: todos os atendimentos do paciente, cada um com sua conta e pagamentos. */
async function history(id) {
  const { rows } = await pool.query(
    `SELECT a.id, a.number, a.opened_at, a.status, a.type, a.modality, a.sector, pr.name AS professional_name,
            ac.id AS account_id, ac.number AS account_number, ac.total_cents, ac.received_cents,
            (ac.total_cents - ac.received_cents) AS balance_cents, ac.financial_status, ac.fiscal_status,
            COALESCE((SELECT json_agg(json_build_object('id', py.id, 'method', py.method, 'amount_cents', py.amount_cents,
                      'refunded_cents', py.refunded_cents, 'status', py.status, 'confirmed_at', py.confirmed_at, 'is_demo', py.is_demo) ORDER BY py.id)
                      FROM payments py WHERE py.account_id = ac.id), '[]') AS payments,
            COALESCE((SELECT string_agg(ai.description, ', ') FROM account_items ai WHERE ai.account_id = ac.id AND ai.status='ATIVO'), '') AS procedures
       FROM appointments a
       JOIN accounts ac ON ac.appointment_id = a.id
       LEFT JOIN professionals pr ON pr.id = a.professional_id
      WHERE a.patient_id = $1 ORDER BY a.opened_at DESC`, [id]);
  return rows;
}

/** Documentos administrativos: comprovantes internos e documentos fiscais do paciente. */
async function documents(id) {
  const { rows: receipts } = await pool.query(
    `SELECT py.id, py.method, py.amount_cents, py.confirmed_at, py.is_demo, ac.number AS account_number, a.number AS appointment_number
       FROM payments py JOIN accounts ac ON ac.id = py.account_id JOIN appointments a ON a.id = ac.appointment_id
      WHERE ac.patient_id = $1 AND py.status IN ('CONFIRMADO','ESTORNADO_PARCIAL','ESTORNADO') ORDER BY py.confirmed_at DESC`, [id]);
  const { rows: fiscal } = await pool.query(
    `SELECT fd.id, fd.status, fd.mode, fd.is_demo, fd.nfse_number, fd.amount_cents, fd.requested_at, ac.number AS account_number
       FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id WHERE ac.patient_id = $1 ORDER BY fd.requested_at DESC`, [id]);
  return { receipts, fiscal };
}

module.exports = { create, update, search, get, history, documents, present, findDuplicates, parse };
