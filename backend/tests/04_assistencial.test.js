'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { news2, scoreScale } = require('../src/lib/clinicalScores');

let rec; let med; let enf; let tec;
let bedA; let bedB;
before(async () => {
  await h.setup();
  [rec, med, enf, tec] = await Promise.all(['recepcao', 'medico', 'enfermagem', 'tecnico'].map((r) => h.login(r)));
  await h.pool.query(`INSERT INTO care_units (code, name, kind) VALUES ('CLM', 'Clínica Médica', 'ENFERMARIA')`);
  const { rows } = await h.pool.query(`INSERT INTO beds (unit_id, code) SELECT id, unnest(ARRAY['101','102','103','104','105','106','107','108','109','110']) FROM care_units RETURNING id`);
  [bedA, bedB] = rows.map((r) => r.id);
  // reservados para o teste de movimentação
  await h.pool.query(`UPDATE beds SET status = 'RESERVADO' WHERE id = ANY($1)`, [[bedA, bedB]]);
});
after(h.teardown);

async function inpatient({ withBed = true } = {}) {
  const { patient, appointment } = await h.patientWithAccount(rec, { procedures: [] });
  if (withBed) {
    const { rows: [free] } = await h.pool.query(`SELECT id FROM beds WHERE status = 'LIVRE' ORDER BY id LIMIT 1`);
    const r = await enf.post('/api/clinical/beds/admit').send({ appointment_id: appointment.id, bed_id: free.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return { patient, appointment, id: appointment.id };
}

test('Escores: NEWS2, Braden, Morse e Glasgow', () => {
  const ok = news2({ resp_rate: 16, spo2: 98, on_oxygen: false, systolic: 120, heart_rate: 80, consciousness: 'A', temp_tenths: 365 });
  assert.equal(ok.score, 0); assert.equal(ok.risk, 'BAIXO'); assert.ok(ok.complete);
  const bad = news2({ resp_rate: 26, spo2: 90, on_oxygen: true, systolic: 88, heart_rate: 135, consciousness: 'V', temp_tenths: 395 });
  assert.equal(bad.score, 3 + 3 + 2 + 3 + 3 + 3 + 2); assert.equal(bad.risk, 'ALTO');
  assert.equal(news2({ resp_rate: 16, spo2: 98, systolic: 120, heart_rate: 80, consciousness: 'P', temp_tenths: 365 }).risk, 'BAIXO_MEDIO');
  assert.deepEqual(scoreScale('BRADEN', { percepcao_sensorial: 2, umidade: 2, atividade: 1, mobilidade: 2, nutricao: 2, friccao_cisalhamento: 1 }), { score: 10, risk: 'ALTO' });
  assert.deepEqual(scoreScale('MORSE', { historico_queda: 25, diagnostico_secundario: 15, auxilio_deambulacao: 0, terapia_endovenosa: 20, marcha: 0, estado_mental: 0 }), { score: 60, risk: 'ALTO' });
  assert.deepEqual(scoreScale('GLASGOW', { abertura_ocular: 4, resposta_verbal: 5, resposta_motora: 6 }), { score: 15, risk: 'LEVE' });
  assert.throws(() => scoreScale('MORSE', { historico_queda: 10 }));
});

test('Leitos: internação, bloqueio de duplicidade, transferência, alta e higienização', async () => {
  const p = await inpatient({ withBed: false });
  await h.pool.query(`UPDATE beds SET status = 'LIVRE' WHERE id = $1`, [bedB]);
  assert.equal((await rec.post('/api/clinical/beds/admit').send({ appointment_id: p.id, bed_id: bedA })).status, 403, 'recepção não interna');
  assert.equal((await enf.post('/api/clinical/beds/admit').send({ appointment_id: p.id, bed_id: bedA })).status, 200);
  const q = await inpatient({ withBed: false });
  assert.equal((await enf.post('/api/clinical/beds/admit').send({ appointment_id: q.id, bed_id: bedA })).status, 422, 'leito ocupado');
  assert.equal((await enf.post('/api/clinical/beds/admit').send({ appointment_id: p.id, bed_id: bedB })).status, 422, 'paciente já internado');
  assert.equal((await enf.post('/api/clinical/beds/transfer').send({ appointment_id: p.id, to_bed_id: bedB, reason: 'Isolamento de contato' })).status, 200);
  let map = (await enf.get('/api/clinical/beds')).body;
  const st = (id) => map.units[0].beds.find((b) => b.id === id).status;
  assert.equal(st(bedA), 'HIGIENIZACAO'); assert.equal(st(bedB), 'OCUPADO');
  assert.equal((await enf.post(`/api/clinical/beds/${bedB}/status`).send({ status: 'LIVRE' })).status, 422, 'não libera leito ocupado');
  assert.equal((await med.post('/api/clinical/beds/discharge').send({ appointment_id: p.id, reason: 'Alta melhorada' })).status, 200);
  map = (await enf.get('/api/clinical/beds')).body;
  assert.equal(st(bedB), 'HIGIENIZACAO');
  await enf.post(`/api/clinical/beds/${bedA}/status`).send({ status: 'LIVRE' });
  await enf.post(`/api/clinical/beds/${bedB}/status`).send({ status: 'LIVRE' });
  assert.equal((await enf.post(`/api/clinical/appointments/${p.id}/vitals`).send({ heart_rate: 80 })).status, 422, 'após alta não aceita registros');
  const mov = (await enf.get(`/api/clinical/appointments/${p.id}/movements`)).body.map((m) => m.kind);
  assert.deepEqual(mov, ['INTERNACAO', 'TRANSFERENCIA', 'ALTA']);
});

test('Classificação de risco: fila ordenada por prioridade e sinais vitais na triagem', async () => {
  const a = await inpatient({ withBed: false }); const b = await inpatient({ withBed: false });
  assert.equal((await rec.post('/api/clinical/triage').send({ appointment_id: a.id, color: 'VERDE', chief_complaint: 'Dor de garganta' })).status, 403);
  await enf.post('/api/clinical/triage').send({ appointment_id: a.id, color: 'VERDE', chief_complaint: 'Dor de garganta' });
  const t2 = await enf.post('/api/clinical/triage').send({ appointment_id: b.id, color: 'LARANJA', chief_complaint: 'Dor torácica', pain_score: 8,
    vitals: { systolic: 150, diastolic: 95, heart_rate: 112, resp_rate: 22, spo2: 95, temperature: '36,8' } });
  assert.equal(t2.status, 201);
  assert.equal(t2.body.target_minutes, 10);
  assert.ok(t2.body.vitals.news.score > 0);
  const queue = (await enf.get('/api/clinical/triage')).body.filter((t) => [a.id, b.id].includes(Number(t.appointment_id)));
  assert.equal(queue[0].color, 'LARANJA');
  assert.equal((await med.post(`/api/clinical/triage/${t2.body.id}/status`).send({ status: 'EM_ATENDIMENTO' })).status, 200);
});

test('Sinais vitais: validação, temperatura sem ponto flutuante e NEWS calculado', async () => {
  const p = await inpatient();
  assert.equal((await rec.post(`/api/clinical/appointments/${p.id}/vitals`).send({ heart_rate: 80 })).status, 403);
  assert.equal((await tec.post(`/api/clinical/appointments/${p.id}/vitals`).send({ systolic: 80, diastolic: 120 })).status, 400);
  assert.equal((await tec.post(`/api/clinical/appointments/${p.id}/vitals`).send({})).status, 400);
  const r = await tec.post(`/api/clinical/appointments/${p.id}/vitals`).send({ systolic: 120, diastolic: 80, heart_rate: 80, resp_rate: 16, spo2: 97, temperature: '36,5', weight_kg: '70,5' });
  assert.equal(r.status, 201);
  assert.equal(r.body.temp_tenths, 365); assert.equal(r.body.weight_grams, 70500); assert.equal(r.body.news_score, 0);
  const ctx = (await enf.get(`/api/clinical/appointments/${p.id}/context`)).body;
  assert.equal(ctx.last_vitals.news_risk, 'BAIXO');
  assert.ok(ctx.bed_code);
});

test('PEP: permissões por tipo de registro e imutabilidade (adendo)', async () => {
  const p = await inpatient();
  assert.equal((await enf.post(`/api/clinical/appointments/${p.id}/notes`).send({ kind: 'EVOLUCAO_MEDICA', text: 'Tentativa indevida' })).status, 403);
  assert.equal((await tec.post(`/api/clinical/appointments/${p.id}/notes`).send({ kind: 'EVOLUCAO_ENFERMAGEM', text: 'Evolução é privativa do enfermeiro' })).status, 403);
  assert.equal((await tec.post(`/api/clinical/appointments/${p.id}/notes`).send({ kind: 'ANOTACAO_ENFERMAGEM', text: 'Paciente aceitou dieta.' })).status, 201);
  const n = await med.post(`/api/clinical/appointments/${p.id}/notes`).send({ kind: 'EVOLUCAO_MEDICA', text: 'Evolução estável.', cid_code: 'j18.9' });
  assert.equal(n.status, 201); assert.equal(n.body.cid_code, 'J18.9');
  await assert.rejects(h.pool.query('UPDATE clinical_notes SET text = $1 WHERE id = $2', ['alterado', n.body.id]), /imutável/);
  const ad = await med.post(`/api/clinical/appointments/${p.id}/notes`).send({ kind: 'EVOLUCAO_MEDICA', text: 'Adendo: corrigir dose citada.', parent_id: n.body.id });
  assert.equal(ad.status, 201);
  const tl = (await med.get(`/api/clinical/appointments/${p.id}/timeline`)).body;
  assert.ok(tl.some((e) => e.type === 'NOTA'));
  await med.get(`/api/clinical/appointments/${p.id}/context`);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PEP_ACESSO' AND entity_id = $1`, [String(p.id)]);
  assert.equal(rows[0].n, 1, 'acesso ao PEP é auditado');
});

test('Prescrição: só médico prescreve, alerta de alergia e aprazamento automático', async () => {
  const p = await inpatient();
  await enf.post(`/api/clinical/patients/${p.patient.id}/allergies`).send({ substance: 'Dipirona', severity: 'GRAVE', reaction: 'Anafilaxia' });
  const items = [{ kind: 'MEDICAMENTO', description: 'Dipirona sódica 1 g', dose: '1 g', route: 'EV', frequency_hours: 6 }];
  assert.equal((await enf.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ items })).status, 403, 'enfermagem não prescreve');
  const blocked = await med.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ items });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.details.allergy_conflicts[0].allergies[0], 'Dipirona (GRAVE)');
  const noDose = await med.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ items: [{ kind: 'MEDICAMENTO', description: 'Omeprazol 40 mg', frequency_hours: 24 }] });
  assert.equal(noDose.status, 400);
  const ok = await med.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ valid_hours: 24, items: [
    { kind: 'MEDICAMENTO', description: 'Ceftriaxona 1 g', dose: '1 g', route: 'EV', frequency_hours: 12 },
    { kind: 'MEDICAMENTO', description: 'Ondansetrona 4 mg', dose: '4 mg', route: 'EV', frequency_hours: 8, if_needed: true },
    { kind: 'DIETA', description: 'Dieta branda' },
  ] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.scheduled, 2, '24h / 12h = 2 horários; SN e dieta não são aprazados');
  const justified = await med.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ items: [{ ...items[0], allergy_override_reason: 'Dessensibilização conduzida pela alergologia' }] });
  assert.equal(justified.status, 201);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PRESCRICAO_ALERGIA_JUSTIFICADA'`);
  assert.equal(rows[0].n, 1);
});

test('Checagem beira-leito: identidade, duplicidade, antecipação, SN e suspensão', async () => {
  const p = await inpatient();
  const first = new Date(Date.now() - 5 * 60000).toISOString();
  await med.post(`/api/clinical/appointments/${p.id}/prescriptions`).send({ valid_hours: 24, items: [
    { kind: 'MEDICAMENTO', description: 'Ceftriaxona 1 g', dose: '1 g', route: 'EV', frequency_hours: 12, first_dose_at: first },
    { kind: 'MEDICAMENTO', description: 'Paracetamol 750 mg', dose: '750 mg', route: 'VO', frequency_hours: 6, if_needed: true },
  ] });
  const sched = (await tec.get(`/api/clinical/schedule?appointment_id=${p.id}&from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400e3).toISOString())}`)).body;
  assert.equal(sched.length, 2);
  const [now1, later] = sched;
  assert.equal((await rec.post(`/api/clinical/administrations/${now1.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: p.patient.record_number })).status, 403);
  const wrong = await tec.post(`/api/clinical/administrations/${now1.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: 'PRT999999' });
  assert.equal(wrong.status, 422, 'pulseira errada');
  const ok = await tec.post(`/api/clinical/administrations/${now1.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: p.patient.record_number, lot: 'L123' });
  assert.equal(ok.status, 200); assert.equal(ok.body.is_late, false);
  assert.equal((await tec.post(`/api/clinical/administrations/${now1.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: p.patient.record_number })).status, 422, 'não checa duas vezes');
  assert.equal((await tec.post(`/api/clinical/administrations/${later.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: p.patient.code })).status, 422, 'antecipação > 60 min');
  assert.equal((await tec.post(`/api/clinical/administrations/${later.id}/check`).send({ status: 'NAO_ADMINISTRADO', confirm_patient: p.patient.code })).status, 400, 'motivo obrigatório');
  // SN
  const presc = (await med.get(`/api/clinical/appointments/${p.id}/prescriptions`)).body[0];
  const sn = presc.items.find((i) => i.if_needed);
  assert.equal((await tec.post(`/api/clinical/prescription-items/${sn.id}/administer`).send({ reason: 'Febre 38,4 °C', confirm_patient: p.patient.record_number })).status, 201);
  assert.equal((await tec.post(`/api/clinical/prescription-items/${sn.id}/administer`).send({ reason: 'Febre persistente', confirm_patient: p.patient.record_number })).status, 422, 'intervalo mínimo');
  // Suspensão pelo médico bloqueia horários pendentes
  const cef = presc.items.find((i) => !i.if_needed);
  assert.equal((await med.post(`/api/clinical/prescription-items/${cef.id}/suspend`).send({ reason: 'Troca de antibiótico' })).body.suspended, 1);
  assert.equal((await tec.post(`/api/clinical/administrations/${later.id}/check`).send({ status: 'ADMINISTRADO', confirm_patient: p.patient.code })).status, 422);
});

test('Enfermagem: escalas, SAE (privativa do enfermeiro), balanço hídrico e passagem de plantão', async () => {
  const p = await inpatient();
  const br = await enf.post(`/api/nursing/appointments/${p.id}/scales`).send({ scale: 'BRADEN', answers: { percepcao_sensorial: 3, umidade: 3, atividade: 2, mobilidade: 2, nutricao: 3, friccao_cisalhamento: 2 } });
  assert.equal(br.status, 201); assert.equal(br.body.score, 15); assert.equal(br.body.risk, 'BAIXO');
  assert.equal((await enf.post(`/api/nursing/appointments/${p.id}/scales`).send({ scale: 'GLASGOW', answers: { abertura_ocular: 9 } })).status, 400);
  const sae = { diagnoses: ['Risco de queda'], interventions: ['Manter grades elevadas', 'Orientar acompanhante'], goals: 'Ausência de quedas' };
  assert.equal((await tec.post(`/api/nursing/appointments/${p.id}/care-plan`).send(sae)).status, 403);
  assert.equal((await enf.post(`/api/nursing/appointments/${p.id}/care-plan`).send(sae)).status, 201);
  assert.equal((await enf.post(`/api/nursing/appointments/${p.id}/care-plan`).send({ ...sae, diagnoses: ['Risco de queda', 'Dor aguda'] })).status, 201);
  const plan = (await enf.get(`/api/nursing/appointments/${p.id}/care-plan`)).body;
  assert.equal(plan.active.diagnoses.length, 2); assert.equal(plan.history.length, 2);
  await tec.post(`/api/nursing/appointments/${p.id}/fluids`).send({ direction: 'ENTRADA', kind: 'Soro fisiológico', volume_ml: 1000 });
  await tec.post(`/api/nursing/appointments/${p.id}/fluids`).send({ direction: 'SAIDA', kind: 'Diurese', volume_ml: 650 });
  const fb = (await enf.get(`/api/nursing/appointments/${p.id}/fluids`)).body;
  assert.equal(fb.balance_ml, 350);
  assert.equal((await tec.post(`/api/nursing/appointments/${p.id}/handoffs`).send({ shift: 'NOITE', situation: 'x x x' })).status, 403);
  assert.equal((await enf.post(`/api/nursing/appointments/${p.id}/handoffs`).send({ shift: 'NOITE', situation: 'Estável, sem queixas', recommendation: 'Reavaliar dor às 06h' })).status, 201);
  const panel = (await enf.get('/api/clinical/patients')).body.find((r) => Number(r.appointment_id) === p.id);
  assert.equal(panel.has_sae, true); assert.equal(panel.braden_risk, 'BAIXO');
});
