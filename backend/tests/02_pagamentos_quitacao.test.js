'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const config = require('../src/config');

let rec; let caixa; let fin;
before(async () => { await h.setup(); rec = await h.login('recepcao'); caixa = await h.login('caixa'); fin = await h.login('financeiro'); });
after(h.teardown);

const pay = (agent, accountId, body) => agent.post(`/api/accounts/${accountId}/payments`).send(body);

test('5. Pagamento integral por Pix confirmado via webhook validado + consulta ao provedor -> QUITADA', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 });
  assert.equal(p.status, 201);
  assert.equal(p.body.status, 'PENDENTE');
  assert.ok(p.body.pix_copy_paste.startsWith('000201'));
  assert.ok(p.body.pix_qr_code.startsWith('data:image/png'));
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE', 'criar cobrança não quita');

  const sim = await rec.post(`/api/demo/payments/${p.body.id}/pix`).send({});
  assert.equal(sim.status, 200);
  assert.equal(sim.body.payment.status, 'CONFIRMADO');
  assert.equal(sim.body.payment.confirmation_source, 'WEBHOOK_VALIDADO_CONSULTA');
  const acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'QUITADA');
  assert.equal(acc.received_cents, 50000);
  assert.equal(acc.balance_cents, 0);
  assert.ok(acc.settled_at);
  const hist = (await rec.get(`/api/accounts/${accountId}/settlement`)).body;
  assert.equal(hist.settlements.at(-1).event, 'QUITACAO');
  assert.equal(hist.settlements.at(-1).source, 'WEBHOOK_VALIDADO_CONSULTA');
  // Conta quitada não aceita nova cobrança
  assert.equal((await pay(rec, accountId, { method: 'PIX', amount_cents: 100 })).status, 422);
});

test('5b. Webhook com assinatura inválida é rejeitado e não confirma nada', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  const body = JSON.stringify({ pix: [{ endToEndId: 'E123FALSO', txid: p.provider_charge_id, valor: '500.00', horario: new Date().toISOString() }] });
  const r = await require('supertest')(require('../src/app').createApp()).post('/api/webhooks/pix/DEMO_PIX')
    .set('content-type', 'application/json').set('x-demo-signature', 'f'.repeat(64)).send(body);
  assert.equal(r.status, 401);
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
});

test('5c. Webhook autêntico, mas sem pagamento no provedor (payload forjado), não quita', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  const wh = h.registry.pix.DEMO_PIX.buildWebhook([{ endToEndId: 'E999NAOEXISTE', txid: p.provider_charge_id, amountCents: 50000, paidAt: new Date().toISOString() }]);
  const r = await require('supertest')(require('../src/app').createApp()).post('/api/webhooks/pix/DEMO_PIX').set(wh.headers).send(wh.body);
  assert.equal(r.status, 200);
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE', 'payload não é prova de pagamento: consulta ao provedor não mostra o Pix');
});

test('6. Pagamento integral por cartão confirmado pelo terminal -> QUITADA', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = await pay(caixa, accountId, { method: 'CARTAO_CREDITO', amount_cents: 50000, installments: 2, card_mode: 'TERMINAL' });
  assert.equal(p.status, 201);
  assert.equal(p.body.status, 'PROCESSANDO');
  const sim = await caixa.post(`/api/demo/payments/${p.body.id}/card`).send({ outcome: 'APROVADA' });
  assert.equal(sim.body.payment.status, 'CONFIRMADO');
  assert.equal(sim.body.payment.confirmation_source, 'TERMINAL_PROVEDOR');
  const acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'QUITADA');
  assert.equal(acc.balance_cents, 0);
});

test('6b. Cartão sem integração exige NSU e conferência por outro usuário', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  assert.equal((await pay(caixa, accountId, { method: 'CARTAO_DEBITO', amount_cents: 50000, card_mode: 'MANUAL' })).status, 400);
  const p = (await pay(caixa, accountId, { method: 'CARTAO_DEBITO', amount_cents: 50000, card_mode: 'MANUAL', manual_reference: 'NSU 123456' })).body;
  assert.equal(p.status, 'AGUARDANDO_CONFERENCIA');
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
  const c = await fin.post(`/api/payments/${p.id}/confer`).send({ approve: true, note: 'Conferido com relatório da maquininha' });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'CONFIRMADO');
  assert.equal(c.body.confirmation_source, 'CONFERENCIA_MANUAL');
  assert.equal((await h.account(rec, accountId)).financial_status, 'QUITADA');
});

test('7. Pagamento parcial mantém a conta PARCIAL; pagamentos divididos quitam ao completar', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p1 = (await pay(rec, accountId, { method: 'PIX', amount_cents: 20000 })).body;
  await rec.post(`/api/demo/payments/${p1.id}/pix`).send({});
  let acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'PARCIAL');
  assert.equal(acc.received_cents, 20000);
  assert.equal(acc.balance_cents, 30000);
  // não permite cobrar acima do saldo
  assert.equal((await pay(rec, accountId, { method: 'PIX', amount_cents: 30001 })).status, 422);
  const p2 = (await pay(caixa, accountId, { method: 'CARTAO_DEBITO', amount_cents: 30000, card_mode: 'TERMINAL' })).body;
  // enquanto o cartão processa, saldo disponível para nova cobrança é zero
  assert.equal((await pay(rec, accountId, { method: 'PIX', amount_cents: 1 })).status, 422);
  await caixa.post(`/api/demo/payments/${p2.id}/card`).send({ outcome: 'APROVADA' });
  acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'QUITADA');
  assert.equal(acc.received_cents, 50000);
  const events = (await rec.get(`/api/accounts/${accountId}/settlement`)).body.settlements.map((s) => s.event);
  assert.deepEqual(events, ['PAGAMENTO_PARCIAL', 'QUITACAO']);
});

test('8. Pagamento rejeitado não quita a conta', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(caixa, accountId, { method: 'CARTAO_CREDITO', amount_cents: 50000, card_mode: 'TERMINAL' })).body;
  const sim = await caixa.post(`/api/demo/payments/${p.id}/card`).send({ outcome: 'NEGADA' });
  assert.equal(sim.body.payment.status, 'REJEITADO');
  const acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'PENDENTE');
  assert.equal(acc.received_cents, 0);
  // Conferência manual rejeitada também não quita
  const m = (await pay(caixa, accountId, { method: 'DINHEIRO', amount_cents: 50000 })).body;
  const rj = await fin.post(`/api/payments/${m.id}/confer`).send({ approve: false, note: 'Valor não encontrado no caixa' });
  assert.equal(rj.body.status, 'REJEITADO');
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
});

test('9. Notificação de pagamento recebida duas vezes não gera recebimento duplicado', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 20000 })).body;
  const sim = (await rec.post(`/api/demo/payments/${p.id}/pix`).send({})).body;
  const st = require('supertest')(require('../src/app').createApp());
  for (let i = 0; i < 3; i++) {
    const again = await st.post('/api/webhooks/pix/DEMO_PIX').set(sim.webhookHeaders).send(sim.webhookBody);
    assert.equal(again.status, 200);
    assert.equal(again.body.results[0].status, 'DUPLICADO');
  }
  // E também em concorrência
  await Promise.all([1, 2, 3].map(() => st.post('/api/webhooks/pix/DEMO_PIX').set(sim.webhookHeaders).send(sim.webhookBody)));
  await rec.post(`/api/payments/${p.id}/refresh`).send({}); // consulta manual também é idempotente
  const acc = await h.account(rec, accountId);
  assert.equal(acc.received_cents, 20000);
  assert.equal(acc.financial_status, 'PARCIAL');
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM payment_transactions WHERE payment_id = $1 AND kind = 'LIQUIDACAO'`, [p.id]);
  assert.equal(rows[0].n, 1);
});

test('10. Pagamento associado por engano a outra conta é reatribuído de forma auditável', async () => {
  const a = await h.patientWithAccount(rec, { name: 'Paciente A' });
  const b = await h.patientWithAccount(rec, { name: 'Paciente B' });
  const p = (await pay(rec, a.accountId, { method: 'PIX', amount_cents: 50000 })).body;
  await rec.post(`/api/demo/payments/${p.id}/pix`).send({});
  assert.equal((await h.account(rec, a.accountId)).financial_status, 'QUITADA');

  assert.equal((await rec.post(`/api/payments/${p.id}/reassign`).send({ target_account_id: b.accountId, reason: 'Pagamento era do paciente B' })).status, 403);
  assert.equal((await fin.post(`/api/payments/${p.id}/reassign`).send({ target_account_id: b.accountId, reason: 'curto' })).status, 400);
  const r = await fin.post(`/api/payments/${p.id}/reassign`).send({ target_account_id: b.accountId, reason: 'Recepção lançou o Pix na conta do paciente A por engano' });
  assert.equal(r.status, 200);
  const accA = await h.account(rec, a.accountId); const accB = await h.account(rec, b.accountId);
  assert.equal(accA.financial_status, 'PENDENTE'); assert.equal(accA.received_cents, 0);
  assert.equal(accB.financial_status, 'QUITADA'); assert.equal(accB.received_cents, 50000);
  const sA = (await rec.get(`/api/accounts/${a.accountId}/settlement`)).body.settlements.map((s) => s.event);
  assert.deepEqual(sA, ['QUITACAO', 'REABERTURA']);
  const { rows } = await h.pool.query(`SELECT * FROM audit_logs WHERE action = 'PAGAMENTO_REATRIBUIDO' AND entity_id = $1`, [String(p.id)]);
  assert.equal(rows.length, 1);

  // Não reatribui para conta que ficaria com valor recebido acima do total
  const c = await h.patientWithAccount(rec, { procedures: [{ procedure_id: await h.procedureId('ECG') }] });
  const bad = await fin.post(`/api/payments/${p.id}/reassign`).send({ target_account_id: c.accountId, reason: 'Teste de valor maior que o saldo' });
  assert.equal(bad.status, 422);
  assert.equal((await h.account(rec, c.accountId)).financial_status, 'PENDENTE');
});

test('10b. Pix liquidado com valor diferente do cobrado vira DIVERGENTE e não quita', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  const sim = await rec.post(`/api/demo/payments/${p.id}/pix`).send({ amount_cents: 49000 });
  assert.equal(sim.body.payment.status, 'DIVERGENTE');
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
});

test('11. Estorno de pagamento reabre a conta e é auditável', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  await rec.post(`/api/demo/payments/${p.id}/pix`).send({});
  assert.equal((await fin.post(`/api/payments/${p.id}/refund`).send({ amount_cents: 60000, reason: 'Valor maior' })).status, 422);
  const r1 = await fin.post(`/api/payments/${p.id}/refund`).send({ amount_cents: 10000, reason: 'Exame parcialmente não realizado' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.payment.status, 'ESTORNADO_PARCIAL');
  let acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'PARCIAL');
  assert.equal(acc.received_cents, 40000);
  const r2 = await fin.post(`/api/payments/${p.id}/refund`).send({ amount_cents: 40000, reason: 'Exame cancelado pelo paciente' });
  assert.equal(r2.body.payment.status, 'ESTORNADO');
  acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'PENDENTE');
  assert.equal(acc.received_cents, 0);
  const ev = (await rec.get(`/api/accounts/${accountId}/settlement`)).body.settlements.map((s) => s.event);
  assert.deepEqual(ev, ['QUITACAO', 'REABERTURA', 'ATUALIZACAO']);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PAGAMENTO_ESTORNADO' AND entity_id = $1`, [String(p.id)]);
  assert.equal(rows[0].n, 2);
  // Estorno de dinheiro (manual) também funciona
  const { accountId: acc2 } = await h.patientWithAccount(rec);
  const m = (await pay(caixa, acc2, { method: 'DINHEIRO', amount_cents: 50000 })).body;
  await fin.post(`/api/payments/${m.id}/confer`).send({ approve: true });
  const rm = await fin.post(`/api/payments/${m.id}/refund`).send({ amount_cents: 50000, reason: 'Devolução em espécie ao paciente' });
  assert.equal(rm.body.payment.status, 'ESTORNADO');
  assert.equal((await h.account(rec, acc2)).financial_status, 'PENDENTE');
});

test('14. Falha de comunicação com o banco não confirma pagamento e o webhook é reprocessado depois', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  h.registry.pix.DEMO_PIX.failureMode = true;
  const fail = await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 });
  assert.equal(fail.status, 502);
  const { rows: [fp] } = await h.pool.query('SELECT status FROM payments WHERE id = $1', [fail.body.error.details.payment_id]);
  assert.equal(fp.status, 'FALHA_COMUNICACAO');
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
  h.registry.pix.DEMO_PIX.failureMode = false;

  // Cobrança criada; webhook chega mas a CONSULTA ao banco falha -> evento ERRO, conta não quita
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  assert.equal(p.status, 'PENDENTE');
  const wh = await h.registry.pix.DEMO_PIX.simulatePayment(p.provider_charge_id);
  h.registry.pix.DEMO_PIX.failureMode = true;
  const st = require('supertest')(require('../src/app').createApp());
  const r = await st.post('/api/webhooks/pix/DEMO_PIX').set(wh.headers).send(wh.body);
  assert.equal(r.body.results[0].status, 'ERRO');
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
  h.registry.pix.DEMO_PIX.failureMode = false;
  // Consulta de status também falha de forma segura enquanto o banco está fora (testado acima); com o banco de volta, confirma.
  const ref = await rec.post(`/api/payments/${p.id}/refresh`).send({});
  assert.equal(ref.body.payment.status, 'CONFIRMADO');
  assert.equal((await h.account(rec, accountId)).financial_status, 'QUITADA');
});

test('14b. Reprocessamento após falha confirma uma única vez', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  const wh = await h.registry.pix.DEMO_PIX.simulatePayment(p.provider_charge_id);
  h.registry.pix.DEMO_PIX.failureMode = true;
  const st = require('supertest')(require('../src/app').createApp());
  await st.post('/api/webhooks/pix/DEMO_PIX').set(wh.headers).send(wh.body);
  assert.equal((await h.account(rec, accountId)).financial_status, 'PENDENTE');
  h.registry.pix.DEMO_PIX.failureMode = false;
  const admin = await h.login('admin');
  const retry = await admin.post('/api/webhook-events/retry').send({});
  assert.equal(retry.status, 200);
  assert.ok(retry.body.some((e) => e.result === 'CONFIRMADO'));
  await admin.post('/api/webhook-events/retry').send({});
  await st.post('/api/webhooks/pix/DEMO_PIX').set(wh.headers).send(wh.body);
  const acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'QUITADA');
  assert.equal(acc.received_cents, 50000);
});

test('Cancelamento de cobrança verifica o provedor antes (não cancela Pix já pago)', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await pay(rec, accountId, { method: 'PIX', amount_cents: 50000 })).body;
  await h.registry.pix.DEMO_PIX.simulatePayment(p.provider_charge_id); // pagou, mas webhook "perdido"
  const c = await rec.post(`/api/payments/${p.id}/cancel`).send({ reason: 'Paciente desistiu' });
  assert.equal(c.status, 422);
  assert.equal((await h.account(rec, accountId)).financial_status, 'QUITADA', 'a consulta ao provedor confirmou o pagamento');
  assert.ok(config.demoMode);
});
