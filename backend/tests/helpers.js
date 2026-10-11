'use strict';
/**
 * Infraestrutura de testes: banco PostgreSQL dedicado (TEST_DATABASE_URL), recriado a cada arquivo.
 * Usa apenas dados fictícios.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://hospital:hospital@localhost:5432/hospital_test';
process.env.DEMO_MODE = 'true';
process.env.BCRYPT_ROUNDS = '4';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { pool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');
const { seedBase, cpfWithDigits } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { registry } = require('../src/integrations');

const PASSWORD = 'Demo@12345';
let app;

async function setup() {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await seedBase({ log: () => {} });
  await pool.query(`INSERT INTO professionals (name, specialty) VALUES ('Dra. Teste', 'Cardiologia')`);
  await pool.query(`INSERT INTO procedures (code, name, category, price_cents, national_tax_code, service_list_item, iss_rate_bp)
                    VALUES ('ECO-TE', 'Ecocardiograma transesofágico', 'EXAME', 50000, '040201', '04.02', 200),
                           ('ECG', 'Eletrocardiograma', 'EXAME', 9000, '040201', '04.02', 200)`);
  // reinicia o estado dos provedores simulados
  registry.pix.DEMO_PIX.failureMode = false;
  registry.card.DEMO_CARD.failureMode = false;
  registry.fiscal.DEMO_FISCAL.failureMode = false;
  registry.fiscal.DEMO_FISCAL.nextOutcome = 'EMITIR';
  app = createApp();
  return app;
}

/** Agente autenticado (mantém cookie de sessão e envia o cabeçalho anti-CSRF). */
async function login(role) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'SaudeGestao').send({ email: `${role}@demo.local`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${role} falhou: ${res.status} ${JSON.stringify(res.body)}`);
  const wrap = (m) => (url) => agent[m](url).set('X-Requested-With', 'SaudeGestao');
  return { agent, get: wrap('get'), post: wrap('post'), put: wrap('put'), user: res.body.user };
}

let cpfSeq = 100000000;
const newCPF = () => cpfWithDigits(String(cpfSeq++));

async function procedureId(code = 'ECO-TE') {
  const { rows: [p] } = await pool.query('SELECT id FROM procedures WHERE code = $1', [code]);
  return p.id;
}

/** Cria paciente + atendimento particular com um ecocardiograma de R$ 500,00. */
async function patientWithAccount(rec, { name = 'Paciente Teste', procedures } = {}) {
  const p = await rec.post('/api/patients').send({ name: `${name} ${cpfSeq}`, cpf: newCPF(), birth_date: '1980-01-01', confirm_not_duplicate: true });
  if (p.status !== 201) throw new Error(JSON.stringify(p.body));
  const a = await rec.post('/api/appointments').send({
    patient_id: p.body.id, sector: 'Cardiologia', type: 'EXAME', modality: 'PARTICULAR',
    procedures: procedures || [{ procedure_id: await procedureId() }],
  });
  if (a.status !== 201) throw new Error(JSON.stringify(a.body));
  return { patient: p.body, appointment: a.body, accountId: a.body.account_id };
}

async function account(agent, id) { return (await agent.get(`/api/accounts/${id}`)).body; }

async function teardown() { await pool.end(); }

module.exports = { setup, login, teardown, patientWithAccount, account, procedureId, newCPF, pool, registry };
