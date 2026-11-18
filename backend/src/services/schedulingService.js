'use strict';
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { notFound, unprocessable } = require('../lib/errors');

async function list({ date, from, to, status } = {}) {
  const params = []; const where = [];
  if (date) { params.push(date); where.push(`s.scheduled_at >= $${params.length}::date AND s.scheduled_at < ($${params.length}::date + interval '1 day')`); }
  if (from) { params.push(from); where.push(`s.scheduled_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`s.scheduled_at < ($${params.length}::date + interval '1 day')`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT s.*, p.name AS patient_name, p.code AS patient_code, pr.name AS professional_name, pc.name AS procedure_name, pc.price_cents
       FROM schedulings s JOIN patients p ON p.id = s.patient_id LEFT JOIN professionals pr ON pr.id = s.professional_id
       LEFT JOIN procedures pc ON pc.id = s.procedure_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.scheduled_at LIMIT 500`, params);
  return rows;
}

async function create(body, ctx) {
  const v = validator(body);
  const d = {
    patient_id: v.id('patient_id', { required: true, label: 'Paciente' }),
    professional_id: v.id('professional_id'),
    procedure_id: v.id('procedure_id'),
    scheduled_at: v.datetime('scheduled_at', { required: true, label: 'Data/hora' }),
    sector: v.string('sector', { max: 80 }),
    notes: v.string('notes', { max: 1000 }),
  };
  v.done();
  return withTransaction(async (c) => {
    if (d.professional_id) {
      const { rows } = await c.query(
        `SELECT id FROM schedulings WHERE professional_id = $1 AND scheduled_at = $2 AND status IN ('AGENDADO','CONFIRMADO')`, [d.professional_id, d.scheduled_at]);
      if (rows.length) throw unprocessable('Profissional já possui agendamento neste horário.');
    }
    const { rows: [s] } = await c.query(
      `INSERT INTO schedulings (patient_id, professional_id, procedure_id, scheduled_at, sector, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.patient_id, d.professional_id, d.procedure_id, d.scheduled_at, d.sector, d.notes, ctx.user.id]);
    await audit(c, ctx, 'AGENDAMENTO_CRIADO', 'schedulings', s.id, d);
    return s;
  });
}

async function setStatus(id, body, ctx) {
  const v = validator(body);
  const status = v.oneOf('status', ['CONFIRMADO', 'CANCELADO', 'FALTOU'], { required: true });
  v.done();
  return withTransaction(async (c) => {
    const { rows: [s] } = await c.query('SELECT * FROM schedulings WHERE id = $1 FOR UPDATE', [id]);
    if (!s) throw notFound('Agendamento não encontrado.');
    if (s.status === 'ATENDIDO') throw unprocessable('Agendamento já convertido em atendimento.');
    const { rows: [u] } = await c.query('UPDATE schedulings SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
    await audit(c, ctx, 'AGENDAMENTO_STATUS', 'schedulings', id, { de: s.status, para: status });
    return u;
  });
}

module.exports = { list, create, setStatus };
