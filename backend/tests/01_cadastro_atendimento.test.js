'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let rec; let caixa; let fiscal;
before(async () => { await h.setup(); rec = await h.login('recepcao'); caixa = await h.login('caixa'); fiscal = await h.login('fiscal'); });
after(h.teardown);

test('1. Cadastro de paciente novo cria paciente e prontuário único', async () => {
  const cpf = h.newCPF();
  const r = await rec.post('/api/patients').send({ name: 'Fulana de Teste', cpf, birth_date: '1990-02-03', sex: 'F' });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^PAC\d{6}$/);
  assert.match(r.body.record_number, /^PRT\d{6}$/);
  const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM medical_records WHERE patient_id = $1', [r.body.id]);
  assert.equal(rows[0].n, 1);
  const dup = await rec.post('/api/patients').send({ name: 'Outra Pessoa', cpf });
  assert.equal(dup.status, 409, 'CPF repetido deve ser bloqueado');
});

test('1b. Validação no servidor e detecção de possível duplicidade por nome + nascimento', async () => {
  const bad = await rec.post('/api/patients').send({ name: 'X', cpf: '11111111111' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.cpf);
  await rec.post('/api/patients').send({ name: 'Joana Duplicada Silva', birth_date: '1975-07-07' });
  const similar = await rec.post('/api/patients').send({ name: 'Joana Duplicada da Silva', birth_date: '1975-07-07' });
  assert.equal(similar.status, 409);
  assert.equal(similar.body.error.details.possibleDuplicate, true);
  const confirmed = await rec.post('/api/patients').send({ name: 'Joana Duplicada da Silva', birth_date: '1975-07-07', confirm_not_duplicate: true });
  assert.equal(confirmed.status, 201);
});

test('2. Pesquisa de paciente existente por nome, CPF, código e prontuário', async () => {
  const cpf = h.newCPF();
  const p = (await rec.post('/api/patients').send({ name: 'Beltrano Pesquisável', cpf })).body;
  for (const q of ['Pesquisável', cpf, p.code, p.record_number]) {
    const r = await rec.get(`/api/patients?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.some((x) => x.id === p.id), `deve encontrar por ${q}`);
  }
  // Minimização: caixa não vê CPF completo
  const masked = await caixa.get(`/api/patients?q=${encodeURIComponent('Pesquisável')}`);
  assert.match(masked.body[0].cpf, /^\*\*\*\./);
});

test('3. Múltiplos atendimentos para o mesmo paciente reutilizam o prontuário e têm contas independentes', async () => {
  const p = (await rec.post('/api/patients').send({ name: 'Paciente Retorno', cpf: h.newCPF() })).body;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const a = await rec.post('/api/appointments').send({ patient_id: p.id, sector: 'Cardiologia', type: 'EXAME', modality: 'PARTICULAR' });
    assert.equal(a.status, 201);
    assert.equal(a.body.record_number, p.record_number);
    ids.push(a.body);
  }
  assert.equal(new Set(ids.map((a) => a.id)).size, 4);
  assert.equal(new Set(ids.map((a) => a.account_id)).size, 4);
  const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM medical_records WHERE patient_id = $1', [p.id]);
  assert.equal(rows[0].n, 1, 'não cria prontuário novo no retorno');
  const hist = await rec.get(`/api/patients/${p.id}/history`);
  assert.equal(hist.body.length, 4);
});

test('4. Lançamento de exame de R$ 500,00 preenche o valor do cadastro', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const acc = await h.account(rec, accountId);
  assert.equal(acc.items.length, 1);
  assert.equal(acc.items[0].description, 'Ecocardiograma transesofágico');
  assert.equal(acc.items[0].unit_price_cents, 50000);
  assert.equal(acc.total_cents, 50000);
  assert.equal(acc.received_cents, 0);
  assert.equal(acc.balance_cents, 50000);
  assert.equal(acc.financial_status, 'PENDENTE');
});

test('4b. Ajuste de preço exige permissão e justificativa', async () => {
  const { accountId } = await h.patientWithAccount(rec, { procedures: [] });
  const r = await rec.post(`/api/accounts/${accountId}/items`).send({ procedure_id: await h.procedureId(), unit_price_cents: 40000, adjustment_reason: 'cortesia' });
  assert.equal(r.status, 403, 'recepção não pode alterar preço');
  const fat = await h.login('faturamento');
  const semMotivo = await fat.post(`/api/accounts/${accountId}/items`).send({ procedure_id: await h.procedureId(), discount_cents: 5000 });
  assert.equal(semMotivo.status, 400);
  const ok = await fat.post(`/api/accounts/${accountId}/items`).send({ procedure_id: await h.procedureId(), discount_cents: 5000, adjustment_reason: 'Desconto autorizado pela gerência' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.total_cents, 45000);
});

test('15. Usuário sem permissão é bloqueado (403) e sem sessão é rejeitado (401)', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const anon = await require('supertest')(require('../src/app').createApp()).get('/api/patients');
  assert.equal(anon.status, 401);
  assert.equal((await caixa.post('/api/patients').send({ name: 'Não Pode' })).status, 403);
  assert.equal((await rec.get('/api/users')).status, 403);
  assert.equal((await rec.get('/api/audit')).status, 403);
  assert.equal((await fiscal.post(`/api/accounts/${accountId}/payments`).send({ method: 'PIX', amount_cents: 50000 })).status, 403);
  const p = (await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'DINHEIRO', amount_cents: 50000 })).body;
  assert.equal((await rec.post(`/api/payments/${p.id}/confer`).send({ approve: true })).status, 403, 'recepção não confere pagamento');
  assert.equal((await rec.post(`/api/payments/${p.id}/refund`).send({ amount_cents: 100, reason: 'tentativa' })).status, 403);
  // Mesmo usuário não pode conferir o próprio recebimento (segregação de funções)
  const own = (await caixa.post(`/api/accounts/${accountId}/payments`).send({ method: 'DINHEIRO', amount_cents: 1 }));
  assert.equal(own.status, 422, 'saldo já comprometido com cobrança em andamento');
  const acc2 = await h.patientWithAccount(rec);
  const p2 = (await caixa.post(`/api/accounts/${acc2.accountId}/payments`).send({ method: 'DINHEIRO', amount_cents: 50000 })).body;
  const self = await caixa.post(`/api/payments/${p2.id}/confer`).send({ approve: true });
  assert.equal(self.status, 403);
  assert.equal((await h.account(rec, acc2.accountId)).financial_status, 'PENDENTE');
  // Requisição sem cabeçalho anti-CSRF é recusada
  const noCsrf = await rec.agent.post('/api/patients').send({ name: 'CSRF Teste' });
  assert.equal(noCsrf.status, 403);
});

test('Exclusão direta de pagamentos/contas é bloqueada no banco', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  await assert.rejects(h.pool.query('DELETE FROM accounts WHERE id = $1', [accountId]), /Exclusão não permitida/);
  await assert.rejects(h.pool.query('UPDATE audit_logs SET action = $1', ['X']), /imutável/);
  // Quitação manual de status sem pagamento é impedida pela restrição de integridade
  await assert.rejects(h.pool.query(`UPDATE accounts SET financial_status = 'QUITADA' WHERE id = $1`, [accountId]), /accounts_settled_consistency/);
});
