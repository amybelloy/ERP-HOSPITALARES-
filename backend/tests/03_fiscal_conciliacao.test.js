'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let rec; let fiscal; let fin; let admin;
before(async () => {
  await h.setup();
  rec = await h.login('recepcao'); fiscal = await h.login('fiscal'); fin = await h.login('financeiro'); admin = await h.login('admin');
});
after(h.teardown);

async function settledAccount() {
  const { accountId } = await h.patientWithAccount(rec);
  const p = (await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'PIX', amount_cents: 50000 })).body;
  await rec.post(`/api/demo/payments/${p.id}/pix`).send({});
  return { accountId, paymentId: p.id };
}

test('Fiscal: conta não quitada não é elegível; status fiscal independe do financeiro', async () => {
  const { accountId } = await h.patientWithAccount(rec);
  const r = await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({});
  assert.equal(r.status, 422);
  const { accountId: settled } = await settledAccount();
  const acc = await h.account(rec, settled);
  assert.equal(acc.financial_status, 'QUITADA');
  assert.equal(acc.fiscal_status, 'NAO_SOLICITADA', 'quitar não emite nota');
  const elig = (await fiscal.get('/api/fiscal/eligible')).body;
  assert.ok(elig.some((e) => e.id === settled));
});

test('Fiscal: emissão em DEMONSTRAÇÃO é identificada e nunca se apresenta como oficial', async () => {
  const { accountId } = await settledAccount();
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).body;
  assert.equal(doc.mode, 'DEMONSTRACAO');
  assert.equal(doc.is_demo, true);
  const sent = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(sent.status, 'EMITIDA');
  assert.match(sent.nfse_number, /^DEMO-/);
  assert.equal((await h.account(rec, accountId)).fiscal_status, 'EMITIDA_DEMO');
  assert.equal((await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).status, 409, 'um documento ativo por conta');
});

test('12. Emissão fiscal pendente: fica PROCESSANDO e não altera o financeiro; consulta posterior conclui', async () => {
  const { accountId } = await settledAccount();
  h.registry.fiscal.DEMO_FISCAL.nextOutcome = 'PENDENTE';
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).body;
  const sent = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(sent.status, 'PROCESSANDO');
  let acc = await h.account(rec, accountId);
  assert.equal(acc.fiscal_status, 'PENDENTE');
  assert.equal(acc.financial_status, 'QUITADA');
  h.registry.fiscal.DEMO_FISCAL.nextOutcome = 'EMITIR';
  const checked = (await fiscal.post(`/api/fiscal/documents/${doc.id}/check`).send({})).body;
  assert.equal(checked.status, 'EMITIDA');
  acc = await h.account(rec, accountId);
  assert.equal(acc.fiscal_status, 'EMITIDA_DEMO');
});

test('13. Rejeição da emissão fiscal: registra motivo, permite nova tentativa e não altera quitação', async () => {
  const { accountId } = await settledAccount();
  h.registry.fiscal.DEMO_FISCAL.nextOutcome = 'REJEITAR';
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).body;
  const sent = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(sent.status, 'REJEITADA');
  assert.ok(sent.rejection_reason);
  const acc = await h.account(rec, accountId);
  assert.equal(acc.fiscal_status, 'REJEITADA');
  assert.equal(acc.financial_status, 'QUITADA');
  h.registry.fiscal.DEMO_FISCAL.nextOutcome = 'EMITIR';
  const again = await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({});
  assert.equal(again.status, 201, 'após rejeição, pode preparar novo documento');
});

test('Fiscal: falha de comunicação mantém o documento para reenvio com o mesmo número de DPS', async () => {
  const { accountId } = await settledAccount();
  h.registry.fiscal.DEMO_FISCAL.failureMode = true;
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).body;
  const sent = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(sent.status, 'FALHA_COMUNICACAO');
  h.registry.fiscal.DEMO_FISCAL.failureMode = false;
  const retry = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(retry.status, 'EMITIDA');
  assert.equal(retry.dps_number, doc.dps_number);
});

test('Fiscal: modo EXPORTAÇÃO prepara dados (XML DPS) e registra emissão externa', async () => {
  const { accountId } = await settledAccount();
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({ mode: 'EXPORTACAO' })).body;
  assert.equal(doc.mode, 'EXPORTACAO');
  const exp = (await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({})).body;
  assert.equal(exp.status, 'EXPORTADA');
  const data = (await fiscal.get(`/api/fiscal/documents/${doc.id}/export`)).body;
  assert.match(data.xml_dps_nao_assinado, /<DPS xmlns="http:\/\/www.sped.fazenda.gov.br\/nfse"/);
  assert.match(data.xml_dps_nao_assinado, /<vServ>500.00<\/vServ>/);
  const ext = (await fiscal.post(`/api/fiscal/documents/${doc.id}/external`).send({ nfse_number: '12345', verification_code: 'ABC' })).body;
  assert.equal(ext.status, 'EMITIDA_EXTERNAMENTE');
});

test('Estorno após nota emitida gera alerta fiscal e reabre apenas o financeiro', async () => {
  const { accountId, paymentId } = await settledAccount();
  const doc = (await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({})).body;
  await fiscal.post(`/api/fiscal/documents/${doc.id}/submit`).send({});
  await fin.post(`/api/payments/${paymentId}/refund`).send({ amount_cents: 50000, reason: 'Procedimento não realizado' });
  const acc = await h.account(rec, accountId);
  assert.equal(acc.financial_status, 'PENDENTE');
  assert.equal(acc.fiscal_status, 'EMITIDA_DEMO', 'nota não é cancelada automaticamente');
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ALERTA_FISCAL_ESTORNO'`);
  assert.ok(rows[0].n >= 1);
  const notif = (await admin.get('/api/notifications')).body;
  assert.ok(notif.some((n) => /não está\(ão\) mais quitada/.test(n.text)));
});

test('Conciliação: identifica conciliados, Pix sem conta, pendentes e estornos', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await settledAccount();
  await rec.post('/api/demo/orphan-pix').send({ amount_cents: 12345 });
  const { accountId } = await h.patientWithAccount(rec);
  await rec.post(`/api/accounts/${accountId}/payments`).send({ method: 'PIX', amount_cents: 50000 });
  const imp = await fin.post('/api/reconciliation/import').send({ from: today, to: today });
  assert.equal(imp.status, 200);
  assert.ok(imp.body.inserted > 0);
  const again = await fin.post('/api/reconciliation/import').send({ from: today, to: today });
  assert.equal(again.body.inserted, 0, 'importação idempotente');
  const run = await fin.post('/api/reconciliation/run').send({ from: today, to: today });
  assert.equal(run.status, 200);
  assert.ok(run.body.summary.CONCILIADO >= 1);
  assert.ok(run.body.summary.SEM_CONTA >= 1);
  assert.ok(run.body.summary.PENDENTE >= 1);
  assert.ok(run.body.summary.ESTORNO >= 1);
  const items = (await fin.get(`/api/reconciliation/runs/${run.body.run_id}/items?category=SEM_CONTA`)).body;
  const res = await fin.post(`/api/reconciliation/items/${items[0].id}/resolve`).send({ status: 'JUSTIFICADA', resolution_note: 'Pix identificado: adiantamento de paciente' });
  assert.equal(res.body.status, 'JUSTIFICADA');
  assert.equal((await rec.post('/api/reconciliation/run').send({ from: today, to: today })).status, 403);
});

test('Conciliação: importação CSV de extrato e detecção de valor divergente', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { paymentId } = await settledAccount();
  const { rows: [t] } = await h.pool.query(`SELECT provider_transaction_id FROM payment_transactions WHERE payment_id = $1 AND kind='LIQUIDACAO'`, [paymentId]);
  const csv = `external_id;txid;valor;data;tipo\n${t.provider_transaction_id};X;499,00;${new Date().toISOString()};CREDITO`;
  const imp = await fin.post('/api/reconciliation/import-csv').send({ provider: 'EXTRATO_CSV', csv });
  assert.equal(imp.status, 200);
  const run = (await fin.post('/api/reconciliation/run').send({ from: today, to: today })).body;
  assert.ok(run.summary.VALOR_DIVERGENTE >= 1);
});

test('Relatórios: JSON e CSV (exportação exige permissão)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await fin.get(`/api/reports/recebimentos-forma?from=${today}&to=${today}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.some((x) => x.forma === 'PIX'));
  const csv = await fin.get(`/api/reports/contas-status?from=${today}&to=${today}&status=QUITADA&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Conta;Atendimento;Paciente/);
  const fat = await h.login('faturamento');
  assert.equal((await fat.get(`/api/reports/contas-status?from=${today}&to=${today}&format=csv`)).status, 403);
});

test('Comprovante interno é diferenciado de documento fiscal', async () => {
  const { paymentId } = await settledAccount();
  const rc = (await rec.get(`/api/payments/${paymentId}/receipt`)).body;
  assert.equal(rc.document_type, 'COMPROVANTE_INTERNO_RECEBIMENTO');
  assert.match(rc.disclaimer, /NÃO é documento fiscal/);
  assert.equal(rc.amount_cents, 50000);
  assert.ok(rc.transaction_id);
});

test('Nota fiscal: prévia sugere o paciente como tomador e permite emitir em nome de outra pessoa/empresa', async () => {
  const { accountId } = await settledAccount();
  const pv = (await fiscal.get(`/api/fiscal/accounts/${accountId}/preview`)).body;
  assert.equal(pv.taker.personType, 'F');
  assert.match(pv.taker.name, /Paciente Teste/);
  assert.equal(pv.taxes.baseCents, 50000);
  assert.equal(pv.taxes.issCents, 1000, 'ISS 2% de R$ 500,00');
  assert.equal(pv.eligible, true);

  const bad = await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({ taker: { personType: 'J', name: 'Empresa X', document: '11111111111111' } });
  assert.equal(bad.status, 400);
  const cnpj = '11222333000181';
  const doc = await fiscal.post(`/api/fiscal/accounts/${accountId}/prepare`).send({
    taker: { personType: 'J', name: 'Empresa Responsável Ltda', document: cnpj, email: 'fin@empresa.exemplo', city: 'Niterói', state: 'rj' },
    observations: 'Pagamento pela empresa do paciente',
  });
  assert.equal(doc.status, 201);
  assert.equal(doc.body.taker.cnpj, cnpj);
  assert.equal(doc.body.taker.state, 'RJ');
  assert.equal(doc.body.taker_is_patient, false);
  // Edição do tomador enquanto PREPARADA
  const upd = await fiscal.put(`/api/fiscal/documents/${doc.body.id}`).send({ taker: { personType: 'F', name: 'Responsável Financeiro', document: h.newCPF() }, observations: 'Responsável legal' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.taker.name, 'Responsável Financeiro');
  const exp = (await fiscal.get(`/api/fiscal/documents/${doc.body.id}/export`)).body;
  assert.match(exp.xml_dps_nao_assinado, /<xNome>Responsável Financeiro<\/xNome>/);
  assert.match(exp.xml_dps_nao_assinado, /<xInfComp>Responsável legal<\/xInfComp>/);
  const sent = (await fiscal.post(`/api/fiscal/documents/${doc.body.id}/submit`).send({})).body;
  assert.equal(sent.status, 'EMITIDA');
  assert.equal((await fiscal.put(`/api/fiscal/documents/${doc.body.id}`).send({ observations: 'x' })).status, 422, 'não altera após envio');
  assert.equal((await rec.put(`/api/fiscal/documents/${doc.body.id}`).send({})).status, 403);
});
