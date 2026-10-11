'use strict';
/**
 * Dados iniciais e DADOS FICTÍCIOS de demonstração.
 * Nenhum dado real de paciente é utilizado. CPFs/CNPJs são gerados apenas com dígitos verificadores válidos.
 */
const { pool } = require('./pool');
const { DEFAULT_ROLES } = require('../lib/permissions');
const { hashPassword } = require('../services/authService');

function cpfWithDigits(base9) {
  const d = base9.split('').map(Number);
  const calc = (arr) => { const s = arr.reduce((a, n, i) => a + n * (arr.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  d.push(calc(d)); d.push(calc(d));
  return d.join('');
}
function cnpjWithDigits(base12) {
  const d = base12.split('').map(Number);
  const calc = (arr) => { const w = arr.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = arr.reduce((a, n, i) => a + n * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  d.push(calc(d)); d.push(calc(d));
  return d.join('');
}

async function seedBase({ log = console.log } = {}) {
  for (const r of DEFAULT_ROLES) {
    await pool.query(`INSERT INTO roles (code, name, permissions) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET permissions = EXCLUDED.permissions, name = EXCLUDED.name`, [r.code, r.name, r.permissions]);
  }
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (n > 0) { log('Usuários já existem — seed de usuários ignorado.'); return false; }

  const password = process.env.SEED_PASSWORD || 'Demo@12345';
  const hash = await hashPassword(password);
  const users = [
    ['Administrador(a) Demo', 'admin@demo.local', 'admin'],
    ['Recepção Demo', 'recepcao@demo.local', 'recepcao'],
    ['Caixa Demo', 'caixa@demo.local', 'caixa'],
    ['Faturamento Demo', 'faturamento@demo.local', 'faturamento'],
    ['Financeiro Demo', 'financeiro@demo.local', 'financeiro'],
    ['Fiscal Demo', 'fiscal@demo.local', 'fiscal'],
  ];
  for (const [name, email, role] of users) {
    await pool.query('INSERT INTO users (name, email, password_hash, role_id) SELECT $1,$2,$3,id FROM roles WHERE code = $4', [name, email, hash, role]);
  }
  await pool.query(`INSERT INTO settings (key, value) VALUES ('institution', $1), ('fiscal', $2) ON CONFLICT (key) DO NOTHING`, [
    { name: 'Hospital Demonstração (fictício)', cnpj: cnpjWithDigits('112223330001'), municipalRegistration: '0000000', cityIbgeCode: '3550308',
      city: 'São Paulo', state: 'SP', address: 'Rua Fictícia, 100', phone: '(11) 0000-0000', simplesNacional: false },
    { defaultMode: 'INTEGRACAO', requireSettled: true },
  ]);
  log(`Usuários de demonstração criados (senha: ${process.env.SEED_PASSWORD ? '[definida em SEED_PASSWORD]' : password}).`);
  return true;
}

async function seedDemoData({ log = console.log } = {}) {
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM procedures');
  if (n > 0) { log('Cadastros já existem — dados de demonstração ignorados.'); return; }

  await pool.query(`INSERT INTO professionals (name, kind, council, council_number, council_state, specialty) VALUES
    ('Dra. Ana Exemplo', 'MEDICO', 'CRM', '000001', 'SP', 'Cardiologia'),
    ('Dr. Bruno Fictício', 'MEDICO', 'CRM', '000002', 'SP', 'Clínica médica'),
    ('Enf. Carla Modelo', 'ENFERMEIRO', 'COREN', '000003', 'SP', 'Enfermagem')`);
  await pool.query(`INSERT INTO insurance_plans (name, ans_code, plan_type) VALUES
    ('Convênio Demonstração Saúde', '000000', 'Coletivo empresarial'), ('Plano Fictício Total', '000001', 'Individual')`);
  await pool.query(`INSERT INTO suppliers (name, trade_name, cnpj, category) VALUES
    ('Distribuidora Fictícia de Materiais Ltda', 'DistriDemo', $1, 'Materiais médicos'), ('Laboratório Modelo S.A.', 'LabModelo', $2, 'Laboratório de apoio')`,
  [cnpjWithDigits('445556660001'), cnpjWithDigits('778889990001')]);
  await pool.query(`INSERT INTO procedures (code, name, category, description, price_cents, service_list_item, national_tax_code, nbs_code, iss_rate_bp, tuss_code) VALUES
    ('ECO-TE', 'Ecocardiograma transesofágico', 'EXAME', 'Ecocardiograma por via transesofágica', 50000, '04.02', '040201', '123012100', 200, '40901114'),
    ('ECO-TT', 'Ecocardiograma transtorácico', 'EXAME', 'Ecocardiograma convencional', 32000, '04.02', '040201', '123012100', 200, '40901106'),
    ('ECG', 'Eletrocardiograma', 'EXAME', 'ECG de repouso 12 derivações', 9000, '04.02', '040201', '123012100', 200, '40101010'),
    ('CONS-CARD', 'Consulta cardiológica', 'CONSULTA', 'Consulta em consultório', 35000, '04.01', '040101', '123011100', 200, '10101012'),
    ('HEMO', 'Hemograma completo', 'LABORATORIO', 'Hemograma com contagem de plaquetas', 4500, '04.02', '040201', '123012100', 200, '40304361'),
    ('RX-TORAX', 'Raio-X de tórax (PA e perfil)', 'IMAGEM', 'Radiografia de tórax', 12000, '04.02', '040201', '123012100', 200, '40805026')`);
  const { rows: [pt] } = await pool.query(
    `INSERT INTO patients (name, cpf, birth_date, sex, phone, email, zip_code, address, address_number, district, city, city_ibge_code, state)
     VALUES ('Paciente de Demonstração', $1, '1980-05-20', 'F', '(11) 90000-0000', 'paciente.demo@exemplo.invalid', '01000000', 'Rua Exemplo', '10', 'Centro', 'São Paulo', '3550308', 'SP') RETURNING id`,
    [cpfWithDigits('123456789')]);
  await pool.query('INSERT INTO medical_records (patient_id) VALUES ($1)', [pt.id]);
  const more = [['José Fictício da Silva', '987654321', '1965-11-02', 'M'], ['Maria Modelo Souza', '111444777', '1992-03-15', 'F']];
  for (const [name, base, birth, sex] of more) {
    const { rows: [p] } = await pool.query(`INSERT INTO patients (name, cpf, birth_date, sex, city, state) VALUES ($1,$2,$3,$4,'São Paulo','SP') RETURNING id`, [name, cpfWithDigits(base), birth, sex]);
    await pool.query('INSERT INTO medical_records (patient_id) VALUES ($1)', [p.id]);
  }

  // Histórico: atendimentos anteriores do mesmo paciente (25/07, 25/08, 25/09), já quitados em dinheiro com conferência.
  const appointments = require('../services/appointmentService');
  const payments = require('../services/paymentService');
  const ctxOf = async (email) => { const { rows: [u] } = await pool.query('SELECT u.id, u.email, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE email = $1', [email]); return { user: u, ip: 'seed' }; };
  const rec = await ctxOf('recepcao@demo.local');
  const fin = await ctxOf('financeiro@demo.local');
  const { rows: [eco] } = await pool.query(`SELECT id FROM procedures WHERE code = 'ECO-TT'`);
  const { rows: [doc] } = await pool.query(`SELECT id FROM professionals ORDER BY id LIMIT 1`);
  const year = new Date().getFullYear();
  for (const md of ['07-25', '08-25', '09-25']) {
    const a = await appointments.open({ patient_id: pt.id, professional_id: doc.id, sector: 'Cardiologia', type: 'EXAME', modality: 'PARTICULAR', procedures: [{ procedure_id: eco.id }] }, rec);
    const p = await payments.start(a.account_id, { method: 'DINHEIRO', amount_cents: 32000 }, rec);
    await payments.confer(p.id, { approve: true, note: 'Conferência de caixa (dados de demonstração)' }, fin);
    await pool.query(`UPDATE appointments SET opened_at = $2, status = 'FINALIZADO', finished_at = $2 WHERE id = $1`, [a.id, `${year}-${md}T10:00:00-03:00`]);
  }
  // Atendimento de 01/10: Ecocardiograma transesofágico (R$ 500,00), ainda pendente de pagamento.
  const { rows: [ecoTe] } = await pool.query(`SELECT id FROM procedures WHERE code = 'ECO-TE'`);
  const a4 = await appointments.open({ patient_id: pt.id, professional_id: doc.id, sector: 'Cardiologia', type: 'EXAME', modality: 'PARTICULAR', procedures: [{ procedure_id: ecoTe.id }] }, rec);
  await pool.query('UPDATE appointments SET opened_at = $2 WHERE id = $1', [a4.id, `${year}-10-01T09:30:00-03:00`]);
  log('Dados fictícios de demonstração criados.');
}

module.exports = { seedBase, seedDemoData, cpfWithDigits, cnpjWithDigits };

if (require.main === module) {
  (async () => {
    await seedBase();
    if (process.env.SEED_DEMO_DATA !== 'false') await seedDemoData();
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
