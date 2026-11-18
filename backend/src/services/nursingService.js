'use strict';
/** ÁREA DE ENFERMAGEM: escalas, SAE, balanço hídrico e passagem de plantão. */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { loadAppointment } = require('./clinicalService');
const { scoreScale, SCALES, NURSING_DIAGNOSES } = require('../lib/clinicalScores');
const { badRequest } = require('../lib/errors');

async function addScale(appointmentId, body, ctx) {
  const v = validator(body); const scale = v.oneOf('scale', Object.keys(SCALES), { required: true, label: 'Escala' }); v.done();
  let r;
  try { r = scoreScale(scale, body.answers); } catch (e) { throw badRequest(e.message, e.details); }
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId);
    const { rows: [s] } = await c.query(
      `INSERT INTO nursing_scales (appointment_id, scale, answers, score, risk, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [appointmentId, scale, body.answers, r.score, r.risk, ctx.user.id]);
    await audit(c, ctx, 'ESCALA_APLICADA', 'appointments', appointmentId, { escala: scale, escore: r.score, risco: r.risk });
    return s;
  });
}
async function listScales(appointmentId) {
  const { rows } = await pool.query(`SELECT s.*, u.name AS user_name FROM nursing_scales s JOIN users u ON u.id = s.user_id WHERE s.appointment_id = $1 ORDER BY s.created_at DESC`, [appointmentId]);
  return rows;
}
const scaleDefinitions = () => ({ scales: SCALES, diagnoses: NURSING_DIAGNOSES });

// ---------------- SAE
async function getCarePlan(appointmentId) {
  const { rows } = await pool.query(
    `SELECT cp.*, u.name AS author_name, pr.council, pr.council_number FROM nursing_care_plans cp JOIN users u ON u.id = cp.author_id
       LEFT JOIN professionals pr ON pr.id = cp.professional_id WHERE cp.appointment_id = $1 ORDER BY cp.id DESC`, [appointmentId]);
  return { active: rows.find((r) => r.status === 'ATIVO') || null, history: rows };
}
async function saveCarePlan(appointmentId, body, ctx) {
  const v = validator(body);
  const history = v.string('history', { max: 5000, label: 'Histórico de enfermagem', trim: false });
  const goals = v.string('goals', { max: 3000, label: 'Resultados esperados', trim: false });
  const clean = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : []);
  const diagnoses = clean(body.diagnoses); const interventions = clean(body.interventions);
  if (!diagnoses.length) v.fail('diagnoses', 'Informe ao menos um diagnóstico de enfermagem.');
  if (!interventions.length) v.fail('interventions', 'Informe ao menos uma intervenção.');
  if ([...diagnoses, ...interventions].some((x) => x.length > 300)) v.fail('interventions', 'Cada item deve ter até 300 caracteres.');
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId, { lock: true });
    await c.query(`UPDATE nursing_care_plans SET status = 'SUBSTITUIDO' WHERE appointment_id = $1 AND status = 'ATIVO'`, [appointmentId]);
    const { rows: [u] } = await c.query('SELECT professional_id FROM users WHERE id = $1', [ctx.user.id]);
    const { rows: [cp] } = await c.query(
      `INSERT INTO nursing_care_plans (appointment_id, history, diagnoses, goals, interventions, author_id, professional_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [appointmentId, history, diagnoses, goals, interventions, ctx.user.id, u.professional_id]);
    await audit(c, ctx, 'SAE_REGISTRADA', 'appointments', appointmentId, { diagnosticos: diagnoses.length, intervencoes: interventions.length });
    return cp;
  });
}

// ---------------- balanço hídrico
async function addFluid(appointmentId, body, ctx) {
  const v = validator(body);
  const direction = v.oneOf('direction', ['ENTRADA', 'SAIDA'], { required: true, label: 'Tipo' });
  const kind = v.string('kind', { required: true, max: 40, label: 'Via/origem' });
  const volume = v.int('volume_ml', { required: true, min: 1, max: 20000, label: 'Volume (mL)' });
  const at = v.datetime('recorded_at') || new Date().toISOString();
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId);
    const { rows: [f] } = await c.query(
      'INSERT INTO fluid_balance (appointment_id, direction, kind, volume_ml, recorded_at, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [appointmentId, direction, kind, volume, at, ctx.user.id]);
    await audit(c, ctx, 'BALANCO_HIDRICO', 'appointments', appointmentId, { tipo: direction, via: kind, ml: volume });
    return f;
  });
}
async function fluidSummary(appointmentId, { hours = 24 } = {}) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const { rows } = await pool.query(
    `SELECT f.*, u.name AS user_name FROM fluid_balance f JOIN users u ON u.id = f.user_id
      WHERE f.appointment_id = $1 AND f.recorded_at >= now() - ($2 || ' hours')::interval ORDER BY f.recorded_at DESC`, [appointmentId, String(h)]);
  const sum = (d) => rows.filter((r) => r.direction === d).reduce((a, r) => a + r.volume_ml, 0);
  const inMl = sum('ENTRADA'); const outMl = sum('SAIDA');
  return { hours: h, entries: rows, in_ml: inMl, out_ml: outMl, balance_ml: inMl - outMl };
}

// ---------------- passagem de plantão (SBAR)
async function addHandoff(appointmentId, body, ctx) {
  const v = validator(body);
  const shift = v.oneOf('shift', ['MANHA', 'TARDE', 'NOITE'], { required: true, label: 'Plantão' });
  const d = {
    situation: v.string('situation', { required: true, min: 3, max: 3000, label: 'S — Situação', trim: false }),
    background: v.string('background', { max: 3000, trim: false }),
    assessment: v.string('assessment', { max: 3000, trim: false }),
    recommendation: v.string('recommendation', { max: 3000, trim: false }),
  };
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId);
    const { rows: [h] } = await c.query(
      `INSERT INTO shift_handoffs (appointment_id, shift, situation, background, assessment, recommendation, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [appointmentId, shift, d.situation, d.background, d.assessment, d.recommendation, ctx.user.id]);
    await audit(c, ctx, 'PASSAGEM_PLANTAO', 'appointments', appointmentId, { plantao: shift });
    return h;
  });
}
async function listHandoffs({ appointment_id: appointmentId, unit_id: unitId, hours = 24 } = {}) {
  const params = [String(Math.min(Number(hours) || 24, 168))]; const where = [`h.created_at >= now() - ($1 || ' hours')::interval`];
  if (appointmentId) { params.push(appointmentId); where.push(`h.appointment_id = $${params.length}`); }
  if (unitId) { params.push(unitId); where.push(`b.unit_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT h.*, u.name AS author_name, a.number AS appointment_number, p.name AS patient_name, b.code AS bed_code
       FROM shift_handoffs h JOIN users u ON u.id = h.author_id JOIN appointments a ON a.id = h.appointment_id JOIN patients p ON p.id = a.patient_id
       LEFT JOIN beds b ON b.current_appointment_id = a.id WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC LIMIT 300`, params);
  return rows;
}

module.exports = { addScale, listScales, scaleDefinitions, getCarePlan, saveCarePlan, addFluid, fluidSummary, addHandoff, listHandoffs };
