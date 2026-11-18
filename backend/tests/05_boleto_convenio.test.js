'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { buildBoleto, santanderFreeField, dueFactor } = require('../src/lib/boleto');

let rec; let fin; let fat;
before(async () => { await h.setup(); [rec, fin, fat] = await Promise.all(['recepcao', 'financeiro', 'faturamento'].map((r) => h.login(r))); });
after(h.teardown);

test('Boleto: código de barras e linha digitável FEBRABAN', () => {
  assert.equal(dueFactor('2025-02-22'), '1000');
  assert.equal(dueFactor('2025-02-21'), '9999');
  const b = buildBoleto({ amountCents: 50000, dueDate: '2026-10-14', freeField: santanderFreeField({ beneficiaryCode: '1234567', ourNumber: '123' }) });
  assert.equal(b.barcode.length, 44);
  assert.equal(b.digitableLine.replace(/\D/g, '').length, 47);
  assert.equal(b.barcode.slice(9, 19), '0000050000');
  assert.equal(b.digitableLine.split(' ')[3], b.barcode[4], 'DV geral repetido no 4º campo');
});

test('Boleto: emissão não quita; pagamento confirmado pelo banco quita (idempotente)', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  assert.equal((await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'BOLETO', amount_cents: 50000, due_date: '2000-01-01' })).status, 400);
  const p = (await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'BOLETO', amount_cents: 50000 })).body;
  assert.equal(p.status, 'PENDENTE');
  assert.equal(p.boleto_barcode.length, 44);
  assert.ok(p.boleto_digitable_line);
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
  const sim = (await rec.post(`/api/demo/payments/${p.id}/boleto`).send({})).body;
  assert.equal(sim.payment.status, 'CONFIRMADO');
  assert.equal((await h.account(rec, accountId)).financial_status, 'QUITADA');
  const st = require('supertest')(require('../src/app').createApp());
  const again = await st.post('/api/webhooks/boleto/DEMO_BOLETO').set(sim.webhookHeaders).send(sim.webhookBody);
  assert.equal(again.body.results[0].status, 'DUPLICADO');
  const bad = await st.post('/api/webhooks/boleto/DEMO_BOLETO').set('content-type', 'application/json').set('x-demo-signature', '0'.repeat(64)).send(sim.webhookBody);
  assert.equal(bad.status, 401);
  assert.equal((await h.account(rec, accountId)).received_cents, 50000);
});

test('Boleto: cancelamento (baixa) e falha do banco não quitam', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'BOLETO', amount_cents: 50000 })).body;
  const c = await rec.post(`/api/payments/${p.id}/cancel`).send({ reason: 'Paciente pagará no cartão' });
  assert.equal(c.body.status, 'CANCELADO');
  h.registry.boleto.DEMO_BOLETO.failureMode = true;
  const f = await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'BOLETO', amount_cents: 50000 });
  h.registry.boleto.DEMO_BOLETO.failureMode = false;
  assert.equal(f.status, 502);
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
});

test('Convênio: remessa exige conta fechada; retorno com glosa vira repasse a conferir', async () => {
  const { rows: [plan] } = await h.pool.query(`INSERT INTO insurance_plans (name) VALUES ('Convênio Teste') RETURNING id`);
  const p = (await rec.post('/api/patients').send({ name: 'Beneficiário Teste', cpf: h.newCPF(), confirm_not_duplicate: true })).body;
  const a = (await rec.post('/api/appointments').send({ patient_id: p.id, sector: 'Exames', type: 'EXAME', modality: 'CONVENIO', insurance_plan_id: plan.id,
    procedures: [{ procedure_id: await h.procedureId() }] })).body;
  const create = (ids) => fat.post('/api/billing/batches').send({ insurance_plan_id: plan.id, competence: '2026-10', account_ids: ids });
  assert.equal((await create([a.account_id])).status, 422, 'conta não fechada');
  await fat.post(`/api/accounts/${a.account_id}/check`).send({});
  await fat.post(`/api/accounts/${a.account_id}/billing`).send({ status: 'FECHADA' });
  assert.equal((await rec.post('/api/billing/batches').send({ insurance_plan_id: plan.id, competence: '2026-10', account_ids: [a.account_id] })).status, 403);
  const b = await create([a.account_id]);
  assert.equal(b.status, 201); assert.equal(b.body.total_cents, 50000);
  assert.equal((await create([a.account_id])).status, 422, 'já está em remessa');
  assert.equal((await fat.post(`/api/accounts/${a.account_id}/billing`).send({ status: 'ABERTA' })).status, 422, 'não reabre conta em remessa');
  assert.equal((await fat.post(`/api/billing/batches/${b.body.id}/return`).send({ items: [{ account_id: a.account_id, paid_cents: 40000 }] })).status, 422, 'retorno antes do envio');
  assert.equal((await fat.post(`/api/billing/batches/${b.body.id}/send`).send({ protocol: 'PROT-1' })).body.status, 'ENVIADA');
  assert.equal((await fat.post(`/api/billing/batches/${b.body.id}/return`).send({ items: [{ account_id: a.account_id, paid_cents: 40000, glosa_cents: 10000 }] })).status, 400, 'glosa sem motivo');
  assert.equal((await fat.post(`/api/billing/batches/${b.body.id}/return`).send({ items: [{ account_id: a.account_id, paid_cents: 45000, glosa_cents: 10000, glosa_reason: 'x' }] })).status, 422, 'pago + glosa > faturado');
  const ret = await fat.post(`/api/billing/batches/${b.body.id}/return`).send({ items: [{ account_id: a.account_id, paid_cents: 40000, glosa_cents: 10000, glosa_reason: 'Procedimento sem autorização prévia' }] });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.status, 'RETORNO_REGISTRADO'); assert.equal(ret.body.glosa_cents, 10000);
  assert.equal((await h.account(rec, a.account_id)).financial_status, 'PENDENTE', 'repasse ainda não conferido');
  const payId = ret.body.items[0].payment_id;
  assert.equal((await fin.post(`/api/payments/${payId}/confer`).send({ approve: true, note: 'Crédito do convênio no extrato' })).status, 200);
  const acc = await h.account(rec, a.account_id);
  assert.equal(acc.financial_status, 'PARCIAL'); assert.equal(acc.balance_cents, 10000, 'saldo = glosa');
});
