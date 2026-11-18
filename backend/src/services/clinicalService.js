'use strict';
/**
 * ASSISTENCIAL — prontuário eletrônico (PEP), leitos, classificação de risco,
 * sinais vitais, evoluções e alergias.
 * Registros clínicos são imutáveis: correções são feitas por adendo.
 */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { validator } = require('../lib/validate');
const { has } = require('../middleware/auth');
const { news2, TRIAGE_COLORS } = require('../lib/clinicalScores');
const { notFound, unprocessable, forbidden } = require('../lib/errors');

const ACTIVE = ['ABERTO', 'EM_ATENDIMENTO'];

async function loadAppointment(db, id, { lock = false, requireActive = true } = {}) {
  const { rows: [a] } = await db.query(`SELECT * FROM appointments WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!a) throw notFound('Atendimento não encontrado.');
  if (requireActive && !ACTIVE.includes(a.status)) throw unprocessable(`Atendimento ${a.status.toLowerCase()}: não aceita novos registros assistenciais.`);
  return a;
}

// ------------------------------------------------------------------ cabeçalho do paciente (barra do paciente)
async function context(appointmentId) {
  const { rows: [c] } = await pool.query(
    `SELECT a.id AS appointment_id, a.number AS appointment_number, a.type, a.modality, a.status, a.sector, a.opened_at, a.finished_at,
            p.id AS patient_id, p.name AS patient_name, p.social_name, p.code AS patient_code, p.sex, p.birth_date,
            date_part('year', age(p.birth_date))::int AS age, mr.record_number, ip.name AS insurance_name, pr.name AS professional_name,
            b.id AS bed_id, b.code AS bed_code, cu.name AS unit_name, cu.id AS unit_id,
            (SELECT min(created_at) FROM bed_movements m WHERE m.appointment_id = a.id AND m.kind = 'INTERNACAO') AS admitted_at,
            ac.id AS account_id
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN medical_records mr ON mr.id = a.medical_record_id
       JOIN accounts ac ON ac.appointment_id = a.id
       LEFT JOIN insurance_plans ip ON ip.id = a.insurance_plan_id LEFT JOIN professionals pr ON pr.id = a.professional_id
       LEFT JOIN beds b ON b.current_appointment_id = a.id LEFT JOIN care_units cu ON cu.id = b.unit_id
      WHERE a.id = $1`, [appointmentId]);
  if (!c) throw notFound('Atendimento não encontrado.');
  const [allergies, vitals, triage, scales] = await Promise.all([
    pool.query('SELECT id, substance, reaction, severity FROM patient_allergies WHERE patient_id = $1 AND active ORDER BY severity DESC, substance', [c.patient_id]),
    pool.query('SELECT * FROM vital_signs WHERE appointment_id = $1 ORDER BY measured_at DESC LIMIT 1', [appointmentId]),
    pool.query('SELECT color, chief_complaint, created_at, status FROM triages WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1', [appointmentId]),
    pool.query(`SELECT DISTINCT ON (scale) scale, score, risk, created_at FROM nursing_scales WHERE appointment_id = $1 ORDER BY scale, created_at DESC`, [appointmentId]),
  ]);
  const days = c.admitted_at ? Math.floor((Date.now() - new Date(c.admitted_at).getTime()) / 86400000) : null;
  return { ...c, days_admitted: days, allergies: allergies.rows, last_vitals: vitals.rows[0] || null, triage: triage.rows[0] || null, scales: scales.rows };
}

// ------------------------------------------------------------------ pacientes em atendimento (painéis)
async function activePatients({ unit_id: unitId, q } = {}) {
  const params = []; const where = [`a.status IN ('ABERTO','EM_ATENDIMENTO')`];
  if (unitId) { params.push(unitId); where.push(`b.unit_id = $${params.length}`); }
  if (q) { params.push(q); where.push(`(lower(p.name) LIKE '%' || lower($${params.length}) || '%' OR upper(a.number) = upper($${params.length}) OR upper(mr.record_number) = upper($${params.length}))`); }
  const { rows } = await pool.query(
    `SELECT a.id AS appointment_id, a.number, a.type, a.sector, a.opened_at, p.id AS patient_id, p.name AS patient_name,
            date_part('year', age(p.birth_date))::int AS age, p.sex, mr.record_number, b.code AS bed_code, cu.name AS unit_name, cu.id AS unit_id,
            (SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id = p.id AND al.active) AS allergies,
            lv.news_score, lv.news_risk, lv.measured_at AS last_vitals_at,
            tr.color AS triage_color,
            (SELECT count(*)::int FROM administrations ad WHERE ad.appointment_id = a.id AND ad.status = 'PENDENTE'
                AND ad.scheduled_at < now() - interval '30 minutes') AS overdue,
            (SELECT count(*)::int FROM administrations ad WHERE ad.appointment_id = a.id AND ad.status = 'PENDENTE'
                AND ad.scheduled_at BETWEEN now() - interval '30 minutes' AND now() + interval '2 hours') AS due_soon,
            (SELECT risk FROM nursing_scales s WHERE s.appointment_id = a.id AND s.scale = 'BRADEN' ORDER BY created_at DESC LIMIT 1) AS braden_risk,
            (SELECT risk FROM nursing_scales s WHERE s.appointment_id = a.id AND s.scale = 'MORSE' ORDER BY created_at DESC LIMIT 1) AS morse_risk,
            EXISTS (SELECT 1 FROM nursing_care_plans cp WHERE cp.appointment_id = a.id AND cp.status = 'ATIVO') AS has_sae,
            EXISTS (SELECT 1 FROM prescriptions pr WHERE pr.appointment_id = a.id AND pr.status = 'ATIVA' AND pr.valid_until > now()) AS has_prescription
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN medical_records mr ON mr.id = a.medical_record_id
       LEFT JOIN beds b ON b.current_appointment_id = a.id LEFT JOIN care_units cu ON cu.id = b.unit_id
       LEFT JOIN LATERAL (SELECT news_score, news_risk, measured_at FROM vital_signs v WHERE v.appointment_id = a.id ORDER BY measured_at DESC LIMIT 1) lv ON true
       LEFT JOIN LATERAL (SELECT color FROM triages t WHERE t.appointment_id = a.id ORDER BY id DESC LIMIT 1) tr ON true
      WHERE ${where.join(' AND ')}
      ORDER BY cu.name NULLS LAST, b.code NULLS LAST, a.opened_at LIMIT 300`, params);
  return rows;
}

// ------------------------------------------------------------------ alergias
async function listAllergies(patientId) {
  const { rows } = await pool.query(
    `SELECT al.*, u.name AS created_by_name FROM patient_allergies al LEFT JOIN users u ON u.id = al.created_by WHERE al.patient_id = $1 ORDER BY al.active DESC, al.id DESC`, [patientId]);
  return rows;
}
async function addAllergy(patientId, body, ctx) {
  const v = validator(body);
  const substance = v.string('substance', { required: true, min: 2, max: 120, label: 'Substância/alérgeno' });
  const reaction = v.string('reaction', { max: 200, label: 'Reação' });
  const severity = v.oneOf('severity', ['LEVE', 'MODERADA', 'GRAVE']) || 'MODERADA';
  v.done();
  return withTransaction(async (c) => {
    const { rows: [p] } = await c.query('SELECT id FROM patients WHERE id = $1', [patientId]);
    if (!p) throw notFound('Paciente não encontrado.');
    const { rows: [a] } = await c.query(
      'INSERT INTO patient_allergies (patient_id, substance, reaction, severity, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [patientId, substance, reaction, severity, ctx.user.id]);
    await audit(c, ctx, 'ALERGIA_REGISTRADA', 'patients', patientId, { substancia: substance, gravidade: severity });
    return a;
  });
}
async function deactivateAllergy(id, body, ctx) {
  const v = validator(body); const reason = v.string('reason', { required: true, min: 5, max: 300, label: 'Motivo' }); v.done();
  return withTransaction(async (c) => {
    const { rows: [a] } = await c.query('UPDATE patient_allergies SET active = false WHERE id = $1 AND active RETURNING *', [id]);
    if (!a) throw notFound('Alergia não encontrada ou já inativa.');
    await audit(c, ctx, 'ALERGIA_INATIVADA', 'patients', a.patient_id, { substancia: a.substance, motivo: reason });
    return a;
  });
}

// ------------------------------------------------------------------ sinais vitais
async function addVitals(appointmentId, body, ctx) {
  const v = validator(body);
  const d = {
    systolic: v.int('systolic', { min: 30, max: 300, label: 'PA sistólica' }),
    diastolic: v.int('diastolic', { min: 10, max: 200, label: 'PA diastólica' }),
    heart_rate: v.int('heart_rate', { min: 10, max: 300, label: 'FC' }),
    resp_rate: v.int('resp_rate', { min: 2, max: 80, label: 'FR' }),
    spo2: v.int('spo2', { min: 30, max: 100, label: 'SpO2' }),
    glucose: v.int('glucose', { min: 10, max: 1000, label: 'Glicemia' }),
    pain_score: v.int('pain_score', { min: 0, max: 10, label: 'Dor' }),
    on_oxygen: v.bool('on_oxygen', { def: false }),
    consciousness: v.oneOf('consciousness', ['A', 'C', 'V', 'P', 'U']) || 'A',
    measured_at: v.datetime('measured_at') || new Date().toISOString(),
  };
  // temperatura em °C com vírgula/ponto -> décimos (parsing textual, sem float)
  if (body.temperature != null && body.temperature !== '') {
    const m = /^(\d{2})(?:[.,](\d))?$/.exec(String(body.temperature).trim());
    if (!m) v.fail('temperature', 'Temperatura inválida (ex.: 36,5).');
    else d.temp_tenths = Number(m[1]) * 10 + Number(m[2] || 0);
    if (d.temp_tenths && (d.temp_tenths < 250 || d.temp_tenths > 450)) v.fail('temperature', 'Temperatura fora da faixa 25–45 °C.');
  }
  if (body.weight_kg != null && body.weight_kg !== '') {
    const m = /^(\d{1,3})(?:[.,](\d{1,3}))?$/.exec(String(body.weight_kg).trim());
    if (!m) v.fail('weight_kg', 'Peso inválido.'); else d.weight_grams = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  }
  if (d.systolic && d.diastolic && d.diastolic >= d.systolic) v.fail('diastolic', 'PA diastólica deve ser menor que a sistólica.');
  if (new Date(d.measured_at) > new Date(Date.now() + 5 * 60000)) v.fail('measured_at', 'Horário de aferição no futuro.');
  const measuredCount = ['systolic', 'heart_rate', 'resp_rate', 'spo2', 'temp_tenths', 'glucose', 'pain_score'].filter((k) => d[k] != null).length;
  if (!measuredCount) v.fail('systolic', 'Informe ao menos um sinal vital.');
  v.done();
  const n = news2(d);
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId);
    const { rows: [row] } = await c.query(
      `INSERT INTO vital_signs (appointment_id, systolic, diastolic, heart_rate, resp_rate, temp_tenths, spo2, on_oxygen, consciousness, glucose, pain_score,
         weight_grams, news_score, news_risk, measured_at, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [appointmentId, d.systolic, d.diastolic, d.heart_rate, d.resp_rate, d.temp_tenths ?? null, d.spo2, d.on_oxygen, d.consciousness, d.glucose, d.pain_score,
        d.weight_grams ?? null, n.complete ? n.score : null, n.complete ? n.risk : null, d.measured_at, ctx.user.id]);
    await audit(c, ctx, 'SINAIS_VITAIS', 'appointments', appointmentId, { news: n.complete ? n.score : 'incompleto', risco: n.complete ? n.risk : null });
    return { ...row, news: n };
  });
}
async function listVitals(appointmentId) {
  const { rows } = await pool.query(
    `SELECT v.*, u.name AS user_name FROM vital_signs v JOIN users u ON u.id = v.user_id WHERE v.appointment_id = $1 ORDER BY v.measured_at DESC LIMIT 200`, [appointmentId]);
  return rows;
}

// ------------------------------------------------------------------ evoluções / anotações
const NOTE_PERMS = {
  ANAMNESE: ['clinical.notes_medical'], EVOLUCAO_MEDICA: ['clinical.notes_medical'], SUMARIO_ALTA: ['clinical.notes_medical'],
  EVOLUCAO_ENFERMAGEM: ['nursing.sae'], ANOTACAO_ENFERMAGEM: ['nursing.notes'], MULTIPROFISSIONAL: ['clinical.notes_medical', 'nursing.notes'],
};
async function addNote(appointmentId, body, ctx) {
  const v = validator(body);
  const kind = v.oneOf('kind', Object.keys(NOTE_PERMS), { required: true, label: 'Tipo de registro' });
  const text = v.string('text', { required: true, min: 5, max: 20000, label: 'Texto', trim: false });
  const cid = v.string('cid_code', { max: 10, pattern: /^[A-Z]\d{2}(\.?\d{0,2})?$/i, label: 'CID-10' });
  const parentId = v.id('parent_id');
  v.done();
  // Evolução de enfermagem é privativa do enfermeiro (SAE); anotação pode ser feita pelo técnico.
  if (!NOTE_PERMS[kind].some((p) => has(ctx.user, p))) throw forbidden(`Seu perfil não pode registrar "${kind.replace(/_/g, ' ').toLowerCase()}".`);
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId, { requireActive: !['SUMARIO_ALTA'].includes(kind) && !parentId });
    if (parentId) {
      const { rows: [p] } = await c.query('SELECT appointment_id FROM clinical_notes WHERE id = $1', [parentId]);
      if (!p || String(p.appointment_id) !== String(appointmentId)) throw unprocessable('Registro original não pertence a este atendimento.');
    }
    const { rows: [u] } = await c.query('SELECT professional_id FROM users WHERE id = $1', [ctx.user.id]);
    const { rows: [n] } = await c.query(
      `INSERT INTO clinical_notes (appointment_id, kind, text, cid_code, parent_id, author_id, professional_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [appointmentId, kind, text, cid ? cid.toUpperCase() : null, parentId, ctx.user.id, u.professional_id]);
    await audit(c, ctx, parentId ? 'PEP_ADENDO' : 'PEP_REGISTRO', 'appointments', appointmentId, { tipo: kind, nota_id: n.id });
    return n;
  });
}
async function listNotes(appointmentId) {
  const { rows } = await pool.query(
    `SELECT n.*, u.name AS author_name, pr.council, pr.council_number, pr.council_state
       FROM clinical_notes n JOIN users u ON u.id = n.author_id LEFT JOIN professionals pr ON pr.id = n.professional_id
      WHERE n.appointment_id = $1 ORDER BY n.signed_at DESC`, [appointmentId]);
  return rows;
}

// ------------------------------------------------------------------ classificação de risco
async function createTriage(body, ctx) {
  const v = validator(body);
  const appointmentId = v.id('appointment_id', { required: true, label: 'Atendimento' });
  const color = v.oneOf('color', Object.keys(TRIAGE_COLORS), { required: true, label: 'Classificação' });
  const complaint = v.string('chief_complaint', { required: true, min: 3, max: 300, label: 'Queixa principal' });
  const flowchart = v.string('flowchart', { max: 120, label: 'Fluxograma' });
  const discriminator = v.string('discriminator', { max: 200, label: 'Discriminador' });
  const pain = v.int('pain_score', { min: 0, max: 10, label: 'Dor' });
  const notes = v.string('notes', { max: 2000 });
  v.done();
  const result = await withTransaction(async (c) => {
    await loadAppointment(c, appointmentId);
    const { rows: [t] } = await c.query(
      `INSERT INTO triages (appointment_id, color, target_minutes, chief_complaint, flowchart, discriminator, pain_score, notes, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [appointmentId, color, TRIAGE_COLORS[color].target, complaint, flowchart, discriminator, pain, notes, ctx.user.id]);
    await audit(c, ctx, 'CLASSIFICACAO_RISCO', 'appointments', appointmentId, { cor: color, queixa: complaint });
    return t;
  });
  // Sinais vitais aferidos na triagem (opcional)
  if (body.vitals && Object.values(body.vitals).some((x) => x !== null && x !== '')) result.vitals = await addVitals(appointmentId, body.vitals, ctx);
  return result;
}

async function triageQueue() {
  const { rows } = await pool.query(
    `SELECT t.*, a.number AS appointment_number, p.name AS patient_name, date_part('year', age(p.birth_date))::int AS age, u.name AS nurse_name,
            floor(extract(epoch FROM (COALESCE(t.called_at, now()) - t.created_at)) / 60)::int AS wait_minutes
       FROM triages t JOIN appointments a ON a.id = t.appointment_id JOIN patients p ON p.id = a.patient_id JOIN users u ON u.id = t.user_id
      WHERE t.status IN ('AGUARDANDO','EM_ATENDIMENTO') AND t.id = (SELECT max(id) FROM triages x WHERE x.appointment_id = t.appointment_id)
      ORDER BY CASE t.color WHEN 'VERMELHO' THEN 1 WHEN 'LARANJA' THEN 2 WHEN 'AMARELO' THEN 3 WHEN 'VERDE' THEN 4 ELSE 5 END, t.created_at`);
  return rows.map((r) => ({ ...r, overdue: r.status === 'AGUARDANDO' && r.wait_minutes > r.target_minutes }));
}

async function setTriageStatus(id, status, ctx) {
  if (!['EM_ATENDIMENTO', 'ATENDIDO', 'EVADIU'].includes(status)) throw unprocessable('Status inválido.');
  return withTransaction(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM triages WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Classificação não encontrada.');
    const { rows: [u] } = await c.query(
      `UPDATE triages SET status = $2::varchar, called_at = CASE WHEN $2::varchar = 'EM_ATENDIMENTO' THEN COALESCE(called_at, now()) ELSE called_at END WHERE id = $1 RETURNING *`, [id, status]);
    if (status === 'EM_ATENDIMENTO') await c.query(`UPDATE appointments SET status = 'EM_ATENDIMENTO' WHERE id = $1 AND status = 'ABERTO'`, [t.appointment_id]);
    await audit(c, ctx, 'CLASSIFICACAO_STATUS', 'appointments', t.appointment_id, { de: t.status, para: status });
    return u;
  });
}

// ------------------------------------------------------------------ leitos
async function bedMap() {
  const { rows: units } = await pool.query('SELECT * FROM care_units WHERE active ORDER BY name');
  const { rows: beds } = await pool.query(
    `SELECT b.*, a.number AS appointment_number, p.name AS patient_name, p.sex, date_part('year', age(p.birth_date))::int AS age,
            floor(extract(epoch FROM (now() - b.status_since)) / 3600)::int AS hours_in_status,
            (SELECT news_risk FROM vital_signs v WHERE v.appointment_id = a.id ORDER BY measured_at DESC LIMIT 1) AS news_risk,
            (SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id = p.id AND al.active) AS allergies
       FROM beds b LEFT JOIN appointments a ON a.id = b.current_appointment_id LEFT JOIN patients p ON p.id = a.patient_id
      ORDER BY b.unit_id, b.code`);
  const summary = beds.reduce((acc, b) => ({ ...acc, [b.status]: (acc[b.status] || 0) + 1 }), {});
  const total = beds.length;
  return { units: units.map((u) => ({ ...u, beds: beds.filter((b) => b.unit_id === u.id) })), summary, total,
    occupancy_pct: total ? Math.round(((summary.OCUPADO || 0) * 100) / total) : 0 };
}

async function lockBed(c, id) {
  const { rows: [b] } = await c.query('SELECT * FROM beds WHERE id = $1 FOR UPDATE', [id]);
  if (!b) throw notFound('Leito não encontrado.');
  return b;
}

async function admit(body, ctx) {
  const v = validator(body);
  const appointmentId = v.id('appointment_id', { required: true, label: 'Atendimento' });
  const bedId = v.id('bed_id', { required: true, label: 'Leito' });
  const reason = v.string('reason', { max: 500 });
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId, { lock: true });
    const { rows: occ } = await c.query('SELECT code FROM beds WHERE current_appointment_id = $1', [appointmentId]);
    if (occ.length) throw unprocessable(`Paciente já está no leito ${occ[0].code}. Use transferência.`);
    const bed = await lockBed(c, bedId);
    if (!['LIVRE', 'RESERVADO'].includes(bed.status)) throw unprocessable(`Leito ${bed.code} está ${bed.status.toLowerCase()}.`);
    await c.query(`UPDATE beds SET status = 'OCUPADO', current_appointment_id = $2, status_since = now() WHERE id = $1`, [bedId, appointmentId]);
    await c.query(`UPDATE appointments SET status = 'EM_ATENDIMENTO' WHERE id = $1 AND status = 'ABERTO'`, [appointmentId]);
    await c.query(`INSERT INTO bed_movements (appointment_id, kind, to_bed_id, reason, user_id) VALUES ($1,'INTERNACAO',$2,$3,$4)`, [appointmentId, bedId, reason, ctx.user.id]);
    await audit(c, ctx, 'LEITO_INTERNACAO', 'beds', bedId, { atendimento_id: appointmentId, leito: bed.code });
    return { ok: true };
  });
}

async function transfer(body, ctx) {
  const v = validator(body);
  const appointmentId = v.id('appointment_id', { required: true, label: 'Atendimento' });
  const toBedId = v.id('to_bed_id', { required: true, label: 'Leito de destino' });
  const reason = v.string('reason', { required: true, min: 5, max: 500, label: 'Motivo' });
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId, { lock: true });
    const { rows: [from] } = await c.query('SELECT * FROM beds WHERE current_appointment_id = $1 FOR UPDATE', [appointmentId]);
    if (!from) throw unprocessable('Paciente não está internado em leito.');
    if (from.id === toBedId) throw unprocessable('Leito de destino igual ao atual.');
    const to = await lockBed(c, toBedId);
    if (!['LIVRE', 'RESERVADO'].includes(to.status)) throw unprocessable(`Leito ${to.code} está ${to.status.toLowerCase()}.`);
    await c.query(`UPDATE beds SET status = 'HIGIENIZACAO', current_appointment_id = NULL, status_since = now() WHERE id = $1`, [from.id]);
    await c.query(`UPDATE beds SET status = 'OCUPADO', current_appointment_id = $2, status_since = now() WHERE id = $1`, [toBedId, appointmentId]);
    await c.query(`INSERT INTO bed_movements (appointment_id, kind, from_bed_id, to_bed_id, reason, user_id) VALUES ($1,'TRANSFERENCIA',$2,$3,$4,$5)`, [appointmentId, from.id, toBedId, reason, ctx.user.id]);
    await audit(c, ctx, 'LEITO_TRANSFERENCIA', 'beds', toBedId, { atendimento_id: appointmentId, de: from.code, para: to.code, motivo: reason });
    return { ok: true };
  });
}

async function discharge(body, ctx) {
  const v = validator(body);
  const appointmentId = v.id('appointment_id', { required: true, label: 'Atendimento' });
  const kind = v.oneOf('kind', ['ALTA', 'OBITO']) || 'ALTA';
  const reason = v.string('reason', { required: true, min: 3, max: 500, label: 'Tipo/motivo da alta' });
  v.done();
  return withTransaction(async (c) => {
    await loadAppointment(c, appointmentId, { lock: true });
    const { rows: [bed] } = await c.query('SELECT * FROM beds WHERE current_appointment_id = $1 FOR UPDATE', [appointmentId]);
    if (bed) await c.query(`UPDATE beds SET status = 'HIGIENIZACAO', current_appointment_id = NULL, status_since = now() WHERE id = $1`, [bed.id]);
    // Itens pendentes deixam de ser administrados após a alta
    await c.query(`UPDATE administrations SET status = 'SUSPENSO', reason = 'Alta do paciente' WHERE appointment_id = $1 AND status = 'PENDENTE'`, [appointmentId]);
    await c.query(`UPDATE prescriptions SET status = 'ENCERRADA' WHERE appointment_id = $1 AND status = 'ATIVA'`, [appointmentId]);
    await c.query(`UPDATE appointments SET status = 'FINALIZADO', finished_at = now() WHERE id = $1`, [appointmentId]);
    await c.query(`INSERT INTO bed_movements (appointment_id, kind, from_bed_id, reason, user_id) VALUES ($1,$2,$3,$4,$5)`, [appointmentId, kind, bed?.id || null, reason, ctx.user.id]);
    await audit(c, ctx, kind === 'OBITO' ? 'OBITO_REGISTRADO' : 'ALTA_HOSPITALAR', 'appointments', appointmentId, { leito: bed?.code, motivo: reason });
    return { ok: true };
  });
}

async function setBedStatus(bedId, body, ctx) {
  const v = validator(body);
  const status = v.oneOf('status', ['LIVRE', 'HIGIENIZACAO', 'MANUTENCAO', 'RESERVADO', 'BLOQUEADO'], { required: true, label: 'Status' });
  const notes = v.string('notes', { max: 200 });
  v.done();
  return withTransaction(async (c) => {
    const bed = await lockBed(c, bedId);
    if (bed.status === 'OCUPADO') throw unprocessable('Leito ocupado: use transferência ou alta.');
    const { rows: [u] } = await c.query('UPDATE beds SET status = $2, notes = $3, status_since = now() WHERE id = $1 RETURNING *', [bedId, status, notes]);
    await audit(c, ctx, 'LEITO_STATUS', 'beds', bedId, { de: bed.status, para: status, obs: notes });
    return u;
  });
}

async function movements(appointmentId) {
  const { rows } = await pool.query(
    `SELECT m.*, fb.code AS from_bed, tb.code AS to_bed, u.name AS user_name FROM bed_movements m
       LEFT JOIN beds fb ON fb.id = m.from_bed_id LEFT JOIN beds tb ON tb.id = m.to_bed_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.appointment_id = $1 ORDER BY m.id`, [appointmentId]);
  return rows;
}

/** Linha do tempo do PEP (resumo): eventos clínicos em ordem cronológica. */
async function timeline(appointmentId) {
  const { rows } = await pool.query(
    `SELECT 'NOTA' AS type, n.signed_at AS at, n.kind AS title, left(n.text, 240) AS detail, u.name AS who FROM clinical_notes n JOIN users u ON u.id = n.author_id WHERE n.appointment_id = $1
     UNION ALL SELECT 'SINAIS', v.measured_at, 'Sinais vitais', concat('PA ', v.systolic, 'x', v.diastolic, ' · FC ', v.heart_rate, ' · FR ', v.resp_rate, ' · SpO2 ', v.spo2, ' · NEWS ', COALESCE(v.news_score::text, '—')), u.name FROM vital_signs v JOIN users u ON u.id = v.user_id WHERE v.appointment_id = $1
     UNION ALL SELECT 'TRIAGEM', t.created_at, concat('Classificação ', t.color), t.chief_complaint, u.name FROM triages t JOIN users u ON u.id = t.user_id WHERE t.appointment_id = $1
     UNION ALL SELECT 'PRESCRICAO', p.created_at, 'Prescrição', concat((SELECT count(*) FROM prescription_items i WHERE i.prescription_id = p.id), ' item(ns) · ', p.status), u.name FROM prescriptions p JOIN users u ON u.id = p.prescriber_id WHERE p.appointment_id = $1
     UNION ALL SELECT 'ADMINISTRACAO', ad.performed_at, concat('Checagem: ', ad.status), i.description, u.name FROM administrations ad JOIN prescription_items i ON i.id = ad.prescription_item_id JOIN users u ON u.id = ad.performed_by WHERE ad.appointment_id = $1 AND ad.performed_at IS NOT NULL
     UNION ALL SELECT 'ESCALA', s.created_at, concat(s.scale, ' = ', s.score), s.risk, u.name FROM nursing_scales s JOIN users u ON u.id = s.user_id WHERE s.appointment_id = $1
     UNION ALL SELECT 'LEITO', m.created_at, m.kind, m.reason, u.name FROM bed_movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.appointment_id = $1
     ORDER BY 2 DESC LIMIT 300`, [appointmentId]);
  return rows;
}

module.exports = {
  context, activePatients, listAllergies, addAllergy, deactivateAllergy, addVitals, listVitals, addNote, listNotes,
  createTriage, triageQueue, setTriageStatus, bedMap, admit, transfer, discharge, setBedStatus, movements, timeline, loadAppointment,
};
