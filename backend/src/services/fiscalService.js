'use strict';
/**
 * MÓDULO FISCAL — NFS-e
 * Status fiscal é independente do financeiro:
 *   - conta quitada NÃO implica nota emitida;
 *   - nota emitida NÃO implica conta quitada.
 * Modos:
 *   INTEGRACAO   -> envia ao provedor fiscal configurado (NFS-e Nacional);
 *   EXPORTACAO   -> apenas prepara os dados (JSON/XML DPS) para emissão em outro sistema;
 *   DEMONSTRACAO -> quando a integração não está configurada: simulação SEM validade fiscal.
 */
const config = require('../config');
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { fiscalProvider } = require('../integrations');
const { buildDpsXml } = require('../integrations/fiscal/dps');
const { validator } = require('../lib/validate');
const { isValidCPF, isValidCNPJ } = require('../lib/docs');
const { notFound, unprocessable, conflict } = require('../lib/errors');

const ACCOUNT_STATUS = {
  PREPARADA: 'PREPARADA', ENVIADA: 'PENDENTE', PROCESSANDO: 'PENDENTE', EMITIDA: 'EMITIDA', REJEITADA: 'REJEITADA',
  CANCELADA: 'CANCELADA', EXPORTADA: 'EXPORTADA', EMITIDA_EXTERNAMENTE: 'EMITIDA_EXTERNAMENTE', FALHA_COMUNICACAO: 'FALHA_COMUNICACAO',
};

async function getSettings(db = pool) {
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key IN ('institution','fiscal')`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { institution: m.institution || {}, fiscal: { defaultMode: 'INTEGRACAO', requireSettled: true, ...(m.fiscal || {}) } };
}

async function syncAccount(c, doc, ctx) {
  const st = ACCOUNT_STATUS[doc.status] + (doc.is_demo && doc.status === 'EMITIDA' ? '_DEMO' : '');
  await c.query('UPDATE accounts SET fiscal_status = $2, updated_at = now() WHERE id = $1', [doc.account_id, st]);
  await audit(c, ctx, `FISCAL_${doc.status}`, 'fiscal_documents', doc.id, { conta_id: doc.account_id, modo: doc.mode, demo: doc.is_demo, numero: doc.nfse_number, motivo: doc.rejection_reason || undefined });
}

async function eligible() {
  const { rows } = await pool.query(
    `SELECT ac.id, ac.number, ac.total_cents, ac.received_cents, ac.financial_status, ac.fiscal_status, ac.settled_at,
            ap.number AS appointment_number, p.name AS patient_name, p.cpf IS NOT NULL AS has_cpf,
            COALESCE((SELECT string_agg(ai.description, ', ') FROM account_items ai WHERE ai.account_id = ac.id AND ai.status='ATIVO'), '') AS procedures
       FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id JOIN patients p ON p.id = ac.patient_id
      WHERE ac.financial_status = 'QUITADA'
        AND NOT EXISTS (SELECT 1 FROM fiscal_documents fd WHERE fd.account_id = ac.id AND fd.status NOT IN ('REJEITADA','CANCELADA'))
      ORDER BY ac.settled_at DESC LIMIT 300`);
  return rows;
}

const pct = (cents, bp) => (bp ? Math.round((cents * bp) / 10000) : 0); // inteiros: centavos × pontos-base

/** Tomador padrão = paciente da conta. */
function takerFromPatient(pt) {
  return {
    personType: 'F', name: pt.name, cpf: pt.cpf, cnpj: null, email: pt.email, phone: pt.phone, zipCode: pt.zip_code,
    address: pt.address, addressNumber: pt.address_number, district: pt.district, city: pt.city, cityIbgeCode: pt.city_ibge_code,
    state: pt.state, municipalRegistration: null,
  };
}

/** Valida o tomador informado na tela (pode ser o paciente, um responsável ou uma empresa). */
function parseTaker(input) {
  const v = validator(input || {});
  const personType = v.oneOf('personType', ['F', 'J'], { required: true, label: 'Tipo de pessoa' });
  const name = v.string('name', { required: true, min: 3, max: 150, label: 'Nome do tomador' });
  const document = v.digits('document', { required: true, label: 'CPF/CNPJ' });
  const t = {
    personType, name,
    cpf: personType === 'F' ? document : null,
    cnpj: personType === 'J' ? document : null,
    email: v.string('email', { max: 160, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, label: 'E-mail' }),
    phone: v.string('phone', { max: 30 }),
    zipCode: v.digits('zipCode', { length: 8, label: 'CEP' }),
    address: v.string('address', { max: 200 }),
    addressNumber: v.string('addressNumber', { max: 20 }),
    district: v.string('district', { max: 100 }),
    city: v.string('city', { max: 100 }),
    cityIbgeCode: v.digits('cityIbgeCode', { length: 7, label: 'Código IBGE' }),
    state: v.string('state', { max: 2 }),
    municipalRegistration: v.string('municipalRegistration', { max: 30, label: 'Inscrição municipal' }),
  };
  if (document) {
    if (personType === 'F' && !isValidCPF(document)) v.fail('document', 'CPF inválido.');
    if (personType === 'J' && !isValidCNPJ(document)) v.fail('document', 'CNPJ inválido.');
  }
  v.done();
  if (t.state) t.state = t.state.toUpperCase();
  return t;
}

function computeTaxes(amountCents, items, service, taker, fiscalSettings) {
  const discount = items.reduce((a, i) => a + Number(i.discount_cents), 0);
  const surcharge = items.reduce((a, i) => a + Number(i.surcharge_cents), 0);
  const base = amountCents;
  const iss = pct(base, service.issRateBp);
  // IR retido na fonte só se aplica a tomador pessoa jurídica (alíquota configurável)
  const ir = taker?.personType === 'J' ? pct(base, fiscalSettings.irRateBp || 0) : 0;
  const ibs = pct(base, fiscalSettings.ibsRateBp || 0);
  const cbs = pct(base, fiscalSettings.cbsRateBp || 0);
  return { discountCents: discount, surchargeCents: surcharge, baseCents: base, issCents: iss, irCents: ir, ibsCents: ibs, cbsCents: cbs,
    subtotalCents: base, totalCents: base, netCents: base - ir };
}

/** Monta o rascunho da nota a partir da conta: tomador padrão, serviço, prestador e impostos. */
async function buildDraft(db, accountId, settings) {
  const { rows: [acc] } = await db.query(
    `SELECT ac.*, ap.number AS appointment_number FROM accounts ac JOIN appointments ap ON ap.id = ac.appointment_id WHERE ac.id = $1`, [accountId]);
  if (!acc) throw notFound('Conta não encontrada.');
  const { rows: [pt] } = await db.query('SELECT * FROM patients WHERE id = $1', [acc.patient_id]);
  const { rows: items } = await db.query(
    `SELECT ai.*, pr.national_tax_code, pr.service_list_item, pr.nbs_code, pr.iss_rate_bp, pr.code, pr.category
       FROM account_items ai LEFT JOIN procedures pr ON pr.id = ai.procedure_id WHERE ai.account_id = $1 AND ai.status = 'ATIVO' ORDER BY ai.id`, [accountId]);
  const inst = settings.institution;
  const codes = [...new Set(items.map((i) => i.national_tax_code || ''))];
  const service = {
    nationalTaxCode: codes[0] || null, serviceListItem: items[0]?.service_list_item || null, nbsCode: items[0]?.nbs_code || null,
    issRateBp: items[0]?.iss_rate_bp ?? null, cnae: inst.cnae || null,
    description: items.map((i) => `${i.description} (x${i.quantity})`).join('; ').slice(0, 1000),
    items: items.map((i) => ({ code: i.code, group: i.category, description: i.description, quantity: i.quantity, total_cents: i.total_cents })),
  };
  const providerData = { name: inst.name, cnpj: inst.cnpj, municipalRegistration: inst.municipalRegistration, cityIbgeCode: inst.cityIbgeCode,
    city: inst.city, state: inst.state, simplesNacional: !!inst.simplesNacional, cnae: inst.cnae || null };
  const errors = {};
  if (!inst.cnpj || !isValidCNPJ(inst.cnpj)) errors.prestador_cnpj = 'CNPJ do prestador não configurado (Configurações > Instituição).';
  if (!inst.cityIbgeCode) errors.prestador_municipio = 'Código IBGE do município do prestador não configurado.';
  if (!items.length) errors.servico = 'Conta sem procedimentos.';
  else if (codes.includes('')) errors.servico = 'Há procedimentos sem código de tributação nacional configurado.';
  else if (codes.length > 1) errors.servico = 'Itens com códigos de tributação distintos. Emita documentos separados ou ajuste o cadastro.';
  return { acc, patient: pt, items, service, providerData, errors, defaultTaker: takerFromPatient(pt) };
}

/** Dados para a tela de nota fiscal antes de criar o documento (tomador sugerido = paciente). */
async function preview(accountId) {
  const settings = await getSettings();
  const d = await buildDraft(pool, accountId, settings);
  const taker = d.defaultTaker;
  return {
    account: { id: d.acc.id, number: d.acc.number, appointment_number: d.acc.appointment_number, total_cents: d.acc.total_cents,
      received_cents: d.acc.received_cents, financial_status: d.acc.financial_status, fiscal_status: d.acc.fiscal_status },
    patient: { id: d.patient.id, code: d.patient.code, name: d.patient.name },
    taker, service: d.service, provider_data: d.providerData, items: d.items.map((i) => ({ code: i.code, group: i.category, description: i.description, quantity: i.quantity, unit_price_cents: i.unit_price_cents, total_cents: i.total_cents })),
    taxes: computeTaxes(d.acc.total_cents, d.items, d.service, taker, settings.fiscal),
    eligible: !settings.fiscal.requireSettled || d.acc.financial_status === 'QUITADA',
    require_settled: settings.fiscal.requireSettled,
    default_mode: settings.fiscal.defaultMode,
    integration_demo: (() => { try { return fiscalProvider().isDemo; } catch (_) { return true; } })(),
    errors: d.errors,
  };
}

async function prepare(accountId, body, ctx) {
  const v = validator(body);
  let mode = v.oneOf('mode', ['INTEGRACAO', 'EXPORTACAO']);
  const observations = v.string('observations', { max: 1000, label: 'Observações' });
  v.done();
  const settings = await getSettings();
  mode = mode || settings.fiscal.defaultMode || 'INTEGRACAO';

  let providerName; let isDemo = false;
  if (mode === 'EXPORTACAO') providerName = 'EXPORTACAO';
  else {
    const p = fiscalProvider();
    providerName = p.name; isDemo = p.isDemo;
    if (isDemo) mode = 'DEMONSTRACAO';
  }

  return withTransaction(async (c) => {
    const { rows: [lock] } = await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!lock) throw notFound('Conta não encontrada.');
    if (settings.fiscal.requireSettled && lock.financial_status !== 'QUITADA') {
      throw unprocessable(`Conta com status financeiro ${lock.financial_status}. A política configurada exige conta QUITADA para emissão.`);
    }
    const { rows: active } = await c.query(`SELECT id, status FROM fiscal_documents WHERE account_id = $1 AND status NOT IN ('REJEITADA','CANCELADA')`, [accountId]);
    if (active.length) throw conflict(`Já existe documento fiscal ativo para esta conta (#${active[0].id}, ${active[0].status}).`);

    const d = await buildDraft(c, accountId, settings);
    // Tomador: informado na tela (em nome de quem sai a nota) ou, por padrão, o paciente.
    const taker = body.taker ? parseTaker(body.taker) : d.defaultTaker;
    const takerIsPatient = !body.taker || (taker.personType === 'F' && taker.cpf === d.patient.cpf);
    const errors = { ...d.errors };
    if (!body.taker && (!taker.cpf || !isValidCPF(taker.cpf))) errors.tomador_cpf = 'Tomador sem CPF válido. Informe os dados do tomador ou atualize o cadastro do paciente.';
    if (Object.keys(errors).length) throw unprocessable('Dados fiscais incompletos.', errors);
    const service = { ...d.service, taxes: computeTaxes(d.acc.total_cents, d.items, d.service, taker, settings.fiscal) };

    const { rows: [doc] } = await c.query(
      `INSERT INTO fiscal_documents (account_id, mode, provider, is_demo, status, amount_cents, taker, service, provider_data, requested_by, observations, taker_is_patient)
       VALUES ($1,$2,$3,$4,'PREPARADA',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [accountId, mode, providerName, isDemo, d.acc.total_cents, taker, service, d.providerData, ctx.user.id, observations, takerIsPatient]);
    await syncAccount(c, doc, ctx);
    if (!takerIsPatient) await audit(c, ctx, 'FISCAL_TOMADOR_DIFERENTE_DO_PACIENTE', 'fiscal_documents', doc.id, { tomador: taker.name, tipo: taker.personType });
    return doc;
  });
}

/** Altera tomador/observações enquanto o documento ainda não foi enviado. */
async function updateDraft(docId, body, ctx) {
  const v = validator(body);
  const observations = v.string('observations', { max: 1000, label: 'Observações' });
  v.done();
  const settings = await getSettings();
  return withTransaction(async (c) => {
    const d = await lockDoc(c, docId);
    if (d.status !== 'PREPARADA') throw unprocessable('Somente documentos PREPARADOS (ainda não enviados) podem ser alterados.');
    const taker = body.taker ? parseTaker(body.taker) : d.taker;
    const { rows: [pt] } = await c.query('SELECT p.cpf FROM accounts ac JOIN patients p ON p.id = ac.patient_id WHERE ac.id = $1', [d.account_id]);
    const { rows: items } = await c.query(`SELECT discount_cents, surcharge_cents FROM account_items WHERE account_id = $1 AND status = 'ATIVO'`, [d.account_id]);
    const service = { ...d.service, taxes: computeTaxes(d.amount_cents, items, d.service, taker, settings.fiscal) };
    const { rows: [u] } = await c.query(
      `UPDATE fiscal_documents SET taker = $2, service = $3, observations = $4, taker_is_patient = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [docId, taker, service, observations ?? d.observations, taker.personType === 'F' && taker.cpf === pt.cpf]);
    await audit(c, ctx, 'FISCAL_DADOS_ALTERADOS', 'fiscal_documents', docId, { tomador: taker.name, documento_tipo: taker.personType });
    return u;
  });
}

async function lockDoc(c, id) {
  const { rows: [d] } = await c.query('SELECT * FROM fiscal_documents WHERE id = $1 FOR UPDATE', [id]);
  if (!d) throw notFound('Documento fiscal não encontrado.');
  return d;
}

async function applyResult(docId, r, ctx) {
  return withTransaction(async (c) => {
    await lockDoc(c, docId);
    const { rows: [d] } = await c.query(
      `UPDATE fiscal_documents SET status = $2::varchar, nfse_number = COALESCE($3, nfse_number), verification_code = COALESCE($4, verification_code),
              access_key = COALESCE($5, access_key), protocol = COALESCE($6, protocol), official_url = COALESCE($7, official_url),
              xml_document = COALESCE($8, xml_document), rejection_reason = $9,
              processed_at = CASE WHEN $2::varchar IN ('EMITIDA','REJEITADA') THEN now() ELSE processed_at END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [docId, r.status, r.nfseNumber || null, r.verificationCode || null, r.accessKey || null, r.protocol || null, r.officialUrl || null, r.xml || null, r.rejectionReason || null]);
    await syncAccount(c, d, ctx);
    return d;
  });
}

async function submit(docId, ctx) {
  const doc = await withTransaction(async (c) => {
    const d = await lockDoc(c, docId);
    if (!['PREPARADA', 'FALHA_COMUNICACAO'].includes(d.status)) throw unprocessable(`Documento em status ${d.status} não pode ser enviado.`);
    if (d.mode === 'EXPORTACAO') {
      const xml = buildDpsXml(d, { environment: config.fiscal.nfseNacional.environment });
      const { rows: [u] } = await c.query(`UPDATE fiscal_documents SET status = 'EXPORTADA', xml_document = $2, updated_at = now() WHERE id = $1 RETURNING *`, [docId, xml]);
      await syncAccount(c, u, ctx);
      return u;
    }
    const { rows: [u] } = await c.query(`UPDATE fiscal_documents SET status = 'ENVIADA', updated_at = now() WHERE id = $1 RETURNING *`, [docId]);
    await syncAccount(c, u, ctx);
    return u;
  });
  if (doc.mode === 'EXPORTACAO') return doc;

  try {
    const r = await fiscalProvider(doc.provider).emit(doc);
    return applyResult(docId, r, ctx);
  } catch (err) {
    // Reenvio usa o MESMO número de DPS, o que torna a emissão idempotente no ambiente fiscal.
    return applyResult(docId, { status: 'FALHA_COMUNICACAO', rejectionReason: `Falha de comunicação: ${err.message}. Consulte/reenvie.` }, ctx);
  }
}

async function check(docId, ctx) {
  const { rows: [d] } = await pool.query('SELECT * FROM fiscal_documents WHERE id = $1', [docId]);
  if (!d) throw notFound('Documento fiscal não encontrado.');
  if (!['ENVIADA', 'PROCESSANDO'].includes(d.status)) return d;
  const r = await fiscalProvider(d.provider).check(d);
  if (r.status === d.status) return d;
  return applyResult(docId, r, ctx);
}

async function registerExternal(docId, body, ctx) {
  const v = validator(body);
  const number = v.string('nfse_number', { required: true, max: 30, label: 'Número da NFS-e' });
  const code = v.string('verification_code', { max: 60, label: 'Código de verificação' });
  const url = v.string('official_url', { max: 400, pattern: /^https:\/\//, label: 'Link oficial' });
  v.done();
  return withTransaction(async (c) => {
    const d = await lockDoc(c, docId);
    if (d.status !== 'EXPORTADA') throw unprocessable('Somente documentos exportados podem receber o registro de emissão externa.');
    const { rows: [u] } = await c.query(
      `UPDATE fiscal_documents SET status = 'EMITIDA_EXTERNAMENTE', nfse_number = $2, verification_code = $3, official_url = $4, processed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`, [docId, number, code, url]);
    await syncAccount(c, u, ctx);
    return u;
  });
}

async function cancel(docId, body, ctx) {
  const v = validator(body);
  const reason = v.string('reason', { required: true, min: 15, max: 255, label: 'Justificativa' });
  v.done();
  const { rows: [d] } = await pool.query('SELECT * FROM fiscal_documents WHERE id = $1', [docId]);
  if (!d) throw notFound('Documento fiscal não encontrado.');
  if (['CANCELADA', 'REJEITADA'].includes(d.status)) throw unprocessable('Documento já está cancelado/rejeitado.');
  if (['ENVIADA', 'PROCESSANDO'].includes(d.status)) throw unprocessable('Aguarde o resultado do processamento antes de cancelar.');
  if (d.status === 'EMITIDA') {
    const r = await fiscalProvider(d.provider).cancel(d, reason);
    if (r.status !== 'CANCELADA') throw unprocessable(`Cancelamento não homologado: ${r.rejectionReason || r.status}`);
  }
  return withTransaction(async (c) => {
    await lockDoc(c, docId);
    const { rows: [u] } = await c.query(
      `UPDATE fiscal_documents SET status = 'CANCELADA', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [docId, ctx.user.id, d.status === 'EMITIDA_EXTERNAMENTE' ? `${reason} [cancelamento realizado no sistema emissor externo]` : reason]);
    await syncAccount(c, u, ctx);
    return u;
  });
}

async function get(docId) {
  const { rows: [d] } = await pool.query(
    `SELECT fd.*, ac.number AS account_number, ac.financial_status, ap.number AS appointment_number, u.name AS requested_by_name
       FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id JOIN appointments ap ON ap.id = ac.appointment_id
       JOIN users u ON u.id = fd.requested_by WHERE fd.id = $1`, [docId]);
  if (!d) throw notFound('Documento fiscal não encontrado.');
  return d;
}

async function exportData(docId) {
  const d = await get(docId);
  const xml = d.xml_document || buildDpsXml(d, { environment: config.fiscal.nfseNacional.environment });
  return {
    aviso: d.is_demo ? 'DEMONSTRAÇÃO — dados sem validade fiscal.' : 'Dados preparados para emissão. Este arquivo NÃO é uma NFS-e.',
    dps: { numero: d.dps_number, serie: d.dps_series, valor_cents: d.amount_cents, prestador: d.provider_data, tomador: d.taker, servico: d.service },
    xml_dps_nao_assinado: xml,
  };
}

async function list(f = {}) {
  const where = []; const params = [];
  if (f.status) { params.push(f.status); where.push(`fd.status = $${params.length}`); }
  if (f.account_id) { params.push(f.account_id); where.push(`fd.account_id = $${params.length}`); }
  if (f.from) { params.push(f.from); where.push(`fd.requested_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`fd.requested_at < ($${params.length}::date + interval '1 day')`); }
  const { rows } = await pool.query(
    `SELECT fd.id, fd.account_id, fd.mode, fd.provider, fd.is_demo, fd.status, fd.dps_number, fd.amount_cents, fd.nfse_number, fd.verification_code,
            fd.rejection_reason, fd.requested_at, fd.processed_at, fd.cancelled_at, fd.taker->>'name' AS taker_name, fd.taker_is_patient,
            ac.number AS account_number, ac.financial_status
       FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fd.id DESC LIMIT 300`, params);
  return rows;
}

module.exports = { eligible, preview, updateDraft, prepare, submit, check, registerExternal, cancel, get, exportData, list, getSettings };
