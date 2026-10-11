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

async function prepare(accountId, body, ctx) {
  const v = validator(body);
  let mode = v.oneOf('mode', ['INTEGRACAO', 'EXPORTACAO']);
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
    const { rows: [acc] } = await c.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!acc) throw notFound('Conta não encontrada.');
    if (settings.fiscal.requireSettled && acc.financial_status !== 'QUITADA') {
      throw unprocessable(`Conta com status financeiro ${acc.financial_status}. A política configurada exige conta QUITADA para emissão.`);
    }
    const { rows: active } = await c.query(`SELECT id, status FROM fiscal_documents WHERE account_id = $1 AND status NOT IN ('REJEITADA','CANCELADA')`, [accountId]);
    if (active.length) throw conflict(`Já existe documento fiscal ativo para esta conta (#${active[0].id}, ${active[0].status}).`);

    const { rows: [pt] } = await c.query('SELECT * FROM patients WHERE id = $1', [acc.patient_id]);
    const { rows: items } = await c.query(
      `SELECT ai.*, pr.national_tax_code, pr.service_list_item, pr.nbs_code, pr.iss_rate_bp, pr.code
         FROM account_items ai LEFT JOIN procedures pr ON pr.id = ai.procedure_id WHERE ai.account_id = $1 AND ai.status = 'ATIVO'`, [accountId]);
    const inst = settings.institution;
    const errors = {};
    if (!pt.cpf || !isValidCPF(pt.cpf)) errors.tomador_cpf = 'Tomador sem CPF válido. Atualize o cadastro do paciente.';
    if (!inst.cnpj || !isValidCNPJ(inst.cnpj)) errors.prestador_cnpj = 'CNPJ do prestador não configurado (Configurações > Instituição).';
    if (!inst.cityIbgeCode) errors.prestador_municipio = 'Código IBGE do município do prestador não configurado.';
    const codes = [...new Set(items.map((i) => i.national_tax_code || ''))];
    if (codes.includes('')) errors.servico = 'Há procedimentos sem código de tributação nacional configurado.';
    else if (codes.length > 1) errors.servico = 'Itens com códigos de tributação distintos. Emita documentos separados ou ajuste o cadastro.';
    if (Object.keys(errors).length) throw unprocessable('Dados fiscais incompletos.', errors);

    const taker = { name: pt.name, cpf: pt.cpf, email: pt.email, zipCode: pt.zip_code, address: pt.address, addressNumber: pt.address_number,
      district: pt.district, city: pt.city, cityIbgeCode: pt.city_ibge_code, state: pt.state };
    const service = {
      nationalTaxCode: codes[0], serviceListItem: items[0].service_list_item, nbsCode: items[0].nbs_code, issRateBp: items[0].iss_rate_bp,
      description: items.map((i) => `${i.description} (x${i.quantity})`).join('; ').slice(0, 1000),
      items: items.map((i) => ({ code: i.code, description: i.description, quantity: i.quantity, total_cents: i.total_cents })),
    };
    const providerData = { name: inst.name, cnpj: inst.cnpj, municipalRegistration: inst.municipalRegistration, cityIbgeCode: inst.cityIbgeCode,
      city: inst.city, state: inst.state, simplesNacional: !!inst.simplesNacional };

    const { rows: [doc] } = await c.query(
      `INSERT INTO fiscal_documents (account_id, mode, provider, is_demo, status, amount_cents, taker, service, provider_data, requested_by)
       VALUES ($1,$2,$3,$4,'PREPARADA',$5,$6,$7,$8,$9) RETURNING *`,
      [accountId, mode, providerName, isDemo, acc.total_cents, taker, service, providerData, ctx.user.id]);
    await syncAccount(c, doc, ctx);
    return doc;
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
  if (f.from) { params.push(f.from); where.push(`fd.requested_at >= $${params.length}::date`); }
  if (f.to) { params.push(f.to); where.push(`fd.requested_at < ($${params.length}::date + interval '1 day')`); }
  const { rows } = await pool.query(
    `SELECT fd.id, fd.account_id, fd.mode, fd.provider, fd.is_demo, fd.status, fd.dps_number, fd.amount_cents, fd.nfse_number, fd.verification_code,
            fd.rejection_reason, fd.requested_at, fd.processed_at, fd.cancelled_at, fd.taker->>'name' AS taker_name,
            ac.number AS account_number, ac.financial_status
       FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fd.id DESC LIMIT 300`, params);
  return rows;
}

module.exports = { eligible, prepare, submit, check, registerExternal, cancel, get, exportData, list, getSettings };
