'use strict';
/**
 * PRESCRIÇÃO E CHECAGEM (administração à beira-leito)
 *  - Prescrição gera o aprazamento automático (horários) conforme a frequência e a validade.
 *  - Itens que coincidem com alergias registradas exigem justificativa explícita do prescritor.
 *  - Checagem exige confirmação da identidade do paciente (prontuário/pulseira), não permite
 *    checar duas vezes, nem item suspenso, nem com antecedência excessiva; atraso é sinalizado.
 */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { loadAppointment } = require('./clinicalService');
const { notFound, unprocessable } = require('../lib/errors');

const KINDS = ['MEDICAMENTO', 'SOLUCAO', 'CUIDADO', 'DIETA', 'PROCEDIMENTO'];
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const EARLY_LIMIT_MIN = 60;   // checagem antecipada máxima
const LATE_LIMIT_MIN = 60;    // após isso, a checagem é marcada como atrasada

function parseItem(raw, idx) {
  const v = validator(raw || {});
  const it = {
    kind: v.oneOf('kind', KINDS, { required: true, label: `Item ${idx + 1}: tipo` }),
    description: v.string('description', { required: true, min: 2, max: 200, label: `Item ${idx + 1}: descrição` }),
    dose: v.string('dose', { max: 60, label: 'Dose' }),
    route: v.string('route', { max: 30, label: 'Via' }),
    frequency_hours: v.int('frequency_hours', { min: 1, max: 168, label: `Item ${idx + 1}: frequência (h)` }),
    if_needed: v.bool('if_needed', { def: false }),
    first_dose_at: v.datetime('first_dose_at', { label: 'Primeira dose' }),
    instructions: v.string('instructions', { max: 300 }),
    allergy_override_reason: v.string('allergy_override_reason', { max: 500 }),
  };
  if (['MEDICAMENTO', 'SOLUCAO'].includes(it.kind) && !it.if_needed && !it.frequency_hours) v.fail('frequency_hours', `Item ${idx + 1}: informe a frequência ou marque "se necessário".`);
  if (['MEDICAMENTO', 'SOLUCAO'].includes(it.kind) && (!it.dose || !it.route)) v.fail('dose', `Item ${idx + 1}: dose e via são obrigatórias para medicamentos.`);
  v.done();
  return it;
}

async function create(appointmentId, body, ctx) {
  const v = validator(body);
  const validHours = v.int('valid_hours', { min: 1, max: 72, label: 'Validade (h)' }) || 24;
  const notes = v.string('notes', { max: 2000 });
  if (!Array.isArray(body.items) || !body.items.length) v.fail('items', 'Inclua ao menos um item na prescrição.');
  v.done();
  const items = body.items.map(parseItem);

  return withTransaction(async (c) => {
    const appt = await loadAppointment(c, appointmentId, { lock: true });
    const { rows: allergies } = await c.query('SELECT substance, severity FROM patient_allergies WHERE patient_id = $1 AND active', [appt.patient_id]);
    const conflicts = [];
    items.forEach((it, i) => {
      if (!['MEDICAMENTO', 'SOLUCAO'].includes(it.kind)) return;
      const hit = allergies.filter((a) => norm(it.description).includes(norm(a.substance)));
      if (hit.length && (!it.allergy_override_reason || it.allergy_override_reason.trim().length < 10)) {
        conflicts.push({ item: i + 1, description: it.description, allergies: hit.map((a) => `${a.substance} (${a.severity})`) });
      }
      it.allergy_hit = hit.map((a) => a.substance);
    });
    if (conflicts.length) {
      throw unprocessable('ALERTA DE ALERGIA: o paciente possui alergia registrada a componente prescrito. Revise ou justifique (mín. 10 caracteres).', { allergy_conflicts: conflicts });
    }
    const { rows: [u] } = await c.query('SELECT professional_id FROM users WHERE id = $1', [ctx.user.id]);
    const from = new Date(); const until = new Date(from.getTime() + validHours * 3600 * 1000);
    const { rows: [p] } = await c.query(
      `INSERT INTO prescriptions (appointment_id, prescriber_id, professional_id, valid_from, valid_until, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [appointmentId, ctx.user.id, u.professional_id, from, until, notes]);
    let scheduled = 0;
    for (const it of items) {
      const { rows: [row] } = await c.query(
        `INSERT INTO prescription_items (prescription_id, kind, description, dose, route, frequency_hours, if_needed, first_dose_at, instructions, allergy_override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [p.id, it.kind, it.description, it.dose, it.route, it.frequency_hours, it.if_needed, it.first_dose_at, it.instructions, it.allergy_override_reason]);
      // Aprazamento automático
      if (!it.if_needed && it.frequency_hours) {
        let t = it.first_dose_at ? new Date(it.first_dose_at) : new Date(from);
        if (t < from) t = new Date(from);
        while (t < until) {
          await c.query('INSERT INTO administrations (prescription_item_id, appointment_id, scheduled_at) VALUES ($1,$2,$3)', [row.id, appointmentId, t]);
          scheduled++;
          t = new Date(t.getTime() + it.frequency_hours * 3600 * 1000);
        }
      }
      if (it.allergy_hit?.length) await audit(c, ctx, 'PRESCRICAO_ALERGIA_JUSTIFICADA', 'prescriptions', p.id, { item: it.description, alergias: it.allergy_hit, justificativa: it.allergy_override_reason });
    }
    await audit(c, ctx, 'PRESCRICAO_CRIADA', 'appointments', appointmentId, { prescricao_id: p.id, itens: items.length, horarios: scheduled, validade_h: validHours });
    return { ...p, scheduled };
  });
}

async function list(appointmentId) {
  const { rows: ps } = await pool.query(
    `SELECT p.*, u.name AS prescriber_name, pr.council, pr.council_number FROM prescriptions p JOIN users u ON u.id = p.prescriber_id
       LEFT JOIN professionals pr ON pr.id = p.professional_id WHERE p.appointment_id = $1 ORDER BY p.id DESC`, [appointmentId]);
  if (!ps.length) return [];
  const { rows: items } = await pool.query(
    `SELECT i.*, (SELECT count(*)::int FROM administrations a WHERE a.prescription_item_id = i.id AND a.status = 'ADMINISTRADO') AS done,
            (SELECT count(*)::int FROM administrations a WHERE a.prescription_item_id = i.id) AS total
       FROM prescription_items i WHERE i.prescription_id = ANY($1) ORDER BY i.id`, [ps.map((p) => p.id)]);
  return ps.map((p) => ({ ...p, expired: p.status === 'ATIVA' && new Date(p.valid_until) < new Date(), items: items.filter((i) => i.prescription_id === p.id) }));
}

async function suspendItem(itemId, body, ctx) {
  const v = validator(body); const reason = v.string('reason', { required: true, min: 5, max: 300, label: 'Motivo' }); v.done();
  return withTransaction(async (c) => {
    const { rows: [it] } = await c.query(
      `SELECT i.*, p.appointment_id FROM prescription_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.id = $1 FOR UPDATE OF i`, [itemId]);
    if (!it) throw notFound('Item não encontrado.');
    if (it.status === 'SUSPENSO') throw unprocessable('Item já suspenso.');
    await c.query(`UPDATE prescription_items SET status = 'SUSPENSO', suspended_reason = $2 WHERE id = $1`, [itemId, reason]);
    const { rowCount } = await c.query(`UPDATE administrations SET status = 'SUSPENSO', reason = $2 WHERE prescription_item_id = $1 AND status = 'PENDENTE'`, [itemId, `Suspenso: ${reason}`]);
    await audit(c, ctx, 'PRESCRICAO_ITEM_SUSPENSO', 'appointments', it.appointment_id, { item: it.description, motivo: reason, horarios_suspensos: rowCount });
    return { ok: true, suspended: rowCount };
  });
}

async function suspendPrescription(id, body, ctx) {
  const v = validator(body); const reason = v.string('reason', { required: true, min: 5, max: 300, label: 'Motivo' }); v.done();
  return withTransaction(async (c) => {
    const { rows: [p] } = await c.query('SELECT * FROM prescriptions WHERE id = $1 FOR UPDATE', [id]);
    if (!p) throw notFound('Prescrição não encontrada.');
    if (p.status !== 'ATIVA') throw unprocessable('Prescrição não está ativa.');
    await c.query(`UPDATE prescriptions SET status = 'SUSPENSA', suspended_reason = $2 WHERE id = $1`, [id, reason]);
    await c.query(`UPDATE prescription_items SET status = 'SUSPENSO', suspended_reason = $2 WHERE prescription_id = $1 AND status = 'ATIVO'`, [id, reason]);
    await c.query(`UPDATE administrations SET status = 'SUSPENSO', reason = $2 WHERE prescription_item_id IN (SELECT id FROM prescription_items WHERE prescription_id = $1) AND status = 'PENDENTE'`, [id, `Suspenso: ${reason}`]);
    await audit(c, ctx, 'PRESCRICAO_SUSPENSA', 'appointments', p.appointment_id, { prescricao_id: id, motivo: reason });
    return { ok: true };
  });
}

/** Aprazamento (mapa de horários) para checagem — por atendimento ou por unidade. */
async function schedule({ appointment_id: appointmentId, unit_id: unitId, from, to } = {}) {
  const params = []; const where = [];
  if (appointmentId) { params.push(appointmentId); where.push(`ad.appointment_id = $${params.length}`); }
  if (unitId) { params.push(unitId); where.push(`b.unit_id = $${params.length}`); }
  params.push(from || new Date(Date.now() - 12 * 3600 * 1000).toISOString()); where.push(`ad.scheduled_at >= $${params.length}`);
  params.push(to || new Date(Date.now() + 12 * 3600 * 1000).toISOString()); where.push(`ad.scheduled_at <= $${params.length}`);
  const { rows } = await pool.query(
    `SELECT ad.*, i.kind, i.description, i.dose, i.route, i.frequency_hours, i.instructions, i.allergy_override_reason, p.status AS prescription_status,
            a.number AS appointment_number, pa.name AS patient_name, b.code AS bed_code, u.name AS performed_by_name,
            (ad.status = 'PENDENTE' AND ad.scheduled_at < now() - interval '30 minutes') AS overdue
       FROM administrations ad JOIN prescription_items i ON i.id = ad.prescription_item_id JOIN prescriptions p ON p.id = i.prescription_id
       JOIN appointments a ON a.id = ad.appointment_id JOIN patients pa ON pa.id = a.patient_id
       LEFT JOIN beds b ON b.current_appointment_id = a.id LEFT JOIN users u ON u.id = ad.performed_by
      WHERE ${where.join(' AND ')} ORDER BY ad.scheduled_at, b.code NULLS LAST, i.id LIMIT 1000`, params);
  return rows;
}

async function verifyIdentity(c, appointmentId, confirm) {
  const { rows: [pid] } = await c.query(
    `SELECT mr.record_number, p.code, p.name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN medical_records mr ON mr.id = a.medical_record_id WHERE a.id = $1`, [appointmentId]);
  const typed = String(confirm || '').trim().toUpperCase();
  if (!typed || ![pid.record_number, pid.code].includes(typed)) {
    throw unprocessable('Identificação do paciente não confere. Leia a pulseira (prontuário ou código do paciente) antes de checar.', { confirm_patient: 'Identificação não confere.' });
  }
  return pid;
}

/** Checagem de um horário aprazado. */
async function check(adminId, body, ctx) {
  const v = validator(body);
  const status = v.oneOf('status', ['ADMINISTRADO', 'NAO_ADMINISTRADO'], { required: true, label: 'Resultado' });
  const reason = v.string('reason', { max: 500, label: 'Justificativa' });
  const lot = v.string('lot', { max: 40, label: 'Lote' });
  if (status === 'NAO_ADMINISTRADO' && !reason) v.fail('reason', 'Informe o motivo da não administração.');
  v.done();
  return withTransaction(async (c) => {
    const { rows: [ad] } = await c.query(
      `SELECT ad.*, i.status AS item_status, i.description, p.status AS prescription_status
         FROM administrations ad JOIN prescription_items i ON i.id = ad.prescription_item_id JOIN prescriptions p ON p.id = i.prescription_id
        WHERE ad.id = $1 FOR UPDATE OF ad`, [adminId]);
    if (!ad) throw notFound('Horário não encontrado.');
    if (ad.status !== 'PENDENTE') throw unprocessable(`Horário já ${ad.status === 'SUSPENSO' ? 'suspenso' : 'checado'}.`);
    if (ad.item_status !== 'ATIVO' || ad.prescription_status !== 'ATIVA') throw unprocessable('Item/prescrição suspenso ou encerrado: não pode ser checado.');
    await loadAppointment(c, ad.appointment_id);
    await verifyIdentity(c, ad.appointment_id, body.confirm_patient);
    const now = new Date();
    const diffMin = (now.getTime() - new Date(ad.scheduled_at).getTime()) / 60000;
    if (status === 'ADMINISTRADO' && diffMin < -EARLY_LIMIT_MIN) throw unprocessable(`Checagem antecipada demais (mais de ${EARLY_LIMIT_MIN} min antes do horário).`);
    const late = diffMin > LATE_LIMIT_MIN;
    if (late && status === 'ADMINISTRADO' && !reason) throw unprocessable('Administração com atraso: informe a justificativa.', { reason: 'Justificativa obrigatória para atraso.' });
    const { rows: [u] } = await c.query(
      `UPDATE administrations SET status = $2, performed_at = now(), performed_by = $3, is_late = $4, reason = $5, lot = $6 WHERE id = $1 RETURNING *`,
      [adminId, status, ctx.user.id, late, reason, lot]);
    await audit(c, ctx, status === 'ADMINISTRADO' ? 'CHECAGEM_ADMINISTRADO' : 'CHECAGEM_NAO_ADMINISTRADO', 'appointments', ad.appointment_id,
      { item: ad.description, horario: ad.scheduled_at, atraso: late, motivo: reason });
    return u;
  });
}

/** Dose "se necessário" (SN/ACM): registra administração não aprazada. */
async function administerIfNeeded(itemId, body, ctx) {
  const v = validator(body); const reason = v.string('reason', { required: true, min: 3, max: 300, label: 'Indicação' }); const lot = v.string('lot', { max: 40 }); v.done();
  return withTransaction(async (c) => {
    const { rows: [it] } = await c.query(
      `SELECT i.*, p.appointment_id, p.status AS prescription_status FROM prescription_items i JOIN prescriptions p ON p.id = i.prescription_id WHERE i.id = $1 FOR UPDATE OF i`, [itemId]);
    if (!it) throw notFound('Item não encontrado.');
    if (!it.if_needed) throw unprocessable('Item não é "se necessário": utilize o aprazamento.');
    if (it.status !== 'ATIVO' || it.prescription_status !== 'ATIVA') throw unprocessable('Item/prescrição suspenso ou encerrado.');
    await loadAppointment(c, it.appointment_id);
    await verifyIdentity(c, it.appointment_id, body.confirm_patient);
    const { rows: [last] } = await c.query(`SELECT max(performed_at) AS t FROM administrations WHERE prescription_item_id = $1 AND status = 'ADMINISTRADO'`, [itemId]);
    if (it.frequency_hours && last.t && Date.now() - new Date(last.t).getTime() < it.frequency_hours * 3600 * 1000) {
      throw unprocessable(`Intervalo mínimo de ${it.frequency_hours} h entre doses ainda não atingido.`);
    }
    const { rows: [ad] } = await c.query(
      `INSERT INTO administrations (prescription_item_id, appointment_id, scheduled_at, status, performed_at, performed_by, reason, lot)
       VALUES ($1,$2,now(),'ADMINISTRADO',now(),$3,$4,$5) RETURNING *`, [itemId, it.appointment_id, ctx.user.id, reason, lot]);
    await audit(c, ctx, 'CHECAGEM_SE_NECESSARIO', 'appointments', it.appointment_id, { item: it.description, indicacao: reason });
    return ad;
  });
}

module.exports = { create, list, suspendItem, suspendPrescription, schedule, check, administerIfNeeded };
