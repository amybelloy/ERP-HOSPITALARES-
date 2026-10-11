'use strict';
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { addItemTx } = require('./accountService');
const { recalculateAccount } = require('./settlementService');
const { validator } = require('../lib/validate');
const { notFound, unprocessable } = require('../lib/errors');

const TYPES = ['AMBULATORIAL', 'EXAME', 'URGENCIA', 'INTERNACAO', 'CONSULTA'];

/**
 * Abre um novo atendimento para um paciente existente.
 * Reutiliza o prontuário do paciente (nunca cria outro) e cria a conta própria do atendimento.
 */
async function open(body, ctx) {
  const v = validator(body);
  const patientId = v.id('patient_id', { required: true, label: 'Paciente' });
  const professionalId = v.id('professional_id', { label: 'Profissional' });
  const sector = v.string('sector', { required: true, max: 80, label: 'Setor' });
  const type = v.oneOf('type', TYPES, { required: true, label: 'Tipo de atendimento' });
  const modality = v.oneOf('modality', ['PARTICULAR', 'CONVENIO'], { required: true, label: 'Modalidade' });
  const insurancePlanId = v.id('insurance_plan_id', { label: 'Convênio' });
  const notes = v.string('notes', { max: 2000 });
  const schedulingId = v.id('scheduling_id');
  if (modality === 'CONVENIO' && !insurancePlanId) v.fail('insurance_plan_id', 'Informe o convênio.');
  const procedures = Array.isArray(body.procedures) ? body.procedures : [];
  v.done();

  return withTransaction(async (c) => {
    const { rows: [patient] } = await c.query(
      'SELECT p.*, mr.id AS medical_record_id, mr.record_number FROM patients p JOIN medical_records mr ON mr.patient_id = p.id WHERE p.id = $1', [patientId]);
    if (!patient) throw notFound('Paciente não encontrado.');
    if (!patient.active) throw unprocessable('Paciente inativo.');
    if (professionalId) {
      const { rows } = await c.query('SELECT active FROM professionals WHERE id = $1', [professionalId]);
      if (!rows[0]?.active) throw unprocessable('Profissional inexistente ou inativo.');
    }
    const { rows: [appt] } = await c.query(
      `INSERT INTO appointments (patient_id, medical_record_id, professional_id, sector, type, modality, insurance_plan_id, opened_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [patientId, patient.medical_record_id, professionalId, sector, type, modality, modality === 'CONVENIO' ? insurancePlanId : null, ctx.user.id, notes]);
    const { rows: [account] } = await c.query('INSERT INTO accounts (appointment_id, patient_id) VALUES ($1,$2) RETURNING *', [appt.id, patientId]);
    await audit(c, ctx, 'ATENDIMENTO_ABERTO', 'appointments', appt.id, {
      numero: appt.number, paciente_id: patientId, prontuario: patient.record_number, conta: account.number, modalidade: modality,
    });
    for (const p of procedures) await addItemTx(c, account.id, p, ctx);
    if (schedulingId) {
      await c.query(`UPDATE schedulings SET status = 'ATENDIDO', appointment_id = $2 WHERE id = $1 AND patient_id = $3`, [schedulingId, appt.id, patientId]);
    }
    return { ...appt, record_number: patient.record_number, account_id: account.id, account_number: account.number };
  });
}

async function list(f = {}) {
  const where = []; const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.patient_id) add('a.patient_id = ?', f.patient_id);
  if (f.status) add('a.status = ?', f.status);
  if (f.from) add('a.opened_at >= ?::date', f.from);
  if (f.to) add("a.opened_at < (?::date + interval '1 day')", f.to);
  if (f.q) add("(upper(a.number) = upper(?) OR lower(p.name) LIKE '%' || lower(?) || '%')", f.q);
  const { rows } = await pool.query(
    `SELECT a.*, p.name AS patient_name, p.code AS patient_code, mr.record_number, pr.name AS professional_name, u.name AS opened_by_name,
            ac.id AS account_id, ac.number AS account_number, ac.total_cents, ac.received_cents, ac.financial_status, ac.fiscal_status
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN medical_records mr ON mr.id = a.medical_record_id
       JOIN accounts ac ON ac.appointment_id = a.id JOIN users u ON u.id = a.opened_by
       LEFT JOIN professionals pr ON pr.id = a.professional_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.opened_at DESC LIMIT 200`, params);
  return rows;
}

async function get(id) {
  const { rows: [a] } = await pool.query(
    `SELECT a.*, p.name AS patient_name, p.code AS patient_code, mr.record_number, pr.name AS professional_name, u.name AS opened_by_name,
            ac.id AS account_id, ac.number AS account_number, ip.name AS insurance_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN medical_records mr ON mr.id = a.medical_record_id
       JOIN accounts ac ON ac.appointment_id = a.id JOIN users u ON u.id = a.opened_by
       LEFT JOIN professionals pr ON pr.id = a.professional_id LEFT JOIN insurance_plans ip ON ip.id = a.insurance_plan_id
      WHERE a.id = $1`, [id]);
  if (!a) throw notFound('Atendimento não encontrado.');
  return a;
}

async function setStatus(id, status, ctx) {
  if (!['EM_ATENDIMENTO', 'FINALIZADO'].includes(status)) throw unprocessable('Status inválido.');
  return withTransaction(async (c) => {
    const { rows: [a] } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    if (!a) throw notFound('Atendimento não encontrado.');
    if (a.status === 'CANCELADO' || a.status === 'FINALIZADO') throw unprocessable(`Atendimento ${a.status.toLowerCase()}.`);
    const { rows: [u] } = await c.query(
      `UPDATE appointments SET status = $2::varchar, finished_at = CASE WHEN $2::varchar = 'FINALIZADO' THEN now() ELSE finished_at END WHERE id = $1 RETURNING *`, [id, status]);
    await audit(c, ctx, 'ATENDIMENTO_STATUS', 'appointments', id, { de: a.status, para: status });
    return u;
  });
}

/** Cancela o atendimento e sua conta — somente se não houver valores recebidos nem cobranças em andamento. */
async function cancel(id, body, ctx) {
  const v = validator(body);
  const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' });
  v.done();
  return withTransaction(async (c) => {
    const { rows: [a] } = await c.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id]);
    if (!a) throw notFound('Atendimento não encontrado.');
    if (a.status === 'CANCELADO') throw unprocessable('Atendimento já cancelado.');
    const { rows: [acc] } = await c.query('SELECT * FROM accounts WHERE appointment_id = $1 FOR UPDATE', [id]);
    await recalculateAccount(c, acc.id, { ctx });
    const { rows: [fresh] } = await c.query('SELECT * FROM accounts WHERE id = $1', [acc.id]);
    if (fresh.received_cents > 0) throw unprocessable('Há valores recebidos nesta conta. Estorne os pagamentos antes de cancelar o atendimento.');
    const { rows: open } = await c.query(`SELECT id FROM payments WHERE account_id = $1 AND status IN ('PENDENTE','PROCESSANDO','AGUARDANDO_CONFERENCIA')`, [acc.id]);
    if (open.length) throw unprocessable('Há cobranças em andamento. Cancele-as antes de cancelar o atendimento.');
    await c.query(`UPDATE appointments SET status = 'CANCELADO', cancel_reason = $2 WHERE id = $1`, [id, reason]);
    await c.query(`UPDATE accounts SET financial_status = 'CANCELADA', updated_at = now() WHERE id = $1`, [acc.id]);
    await c.query(
      `INSERT INTO settlements (account_id, event, previous_status, new_status, total_cents, received_cents, balance_cents, source, user_id, notes)
       VALUES ($1,'CANCELAMENTO',$2,'CANCELADA',$3,$4,$5,'CANCELAMENTO_ATENDIMENTO',$6,$7)`,
      [acc.id, fresh.financial_status, fresh.total_cents, fresh.received_cents, fresh.total_cents - fresh.received_cents, ctx.user.id, reason]);
    await audit(c, ctx, 'ATENDIMENTO_CANCELADO', 'appointments', id, { motivo: reason, conta: acc.number });
    return { ok: true };
  });
}

module.exports = { open, list, get, setStatus, cancel, TYPES };
