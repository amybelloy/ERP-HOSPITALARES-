'use strict';
/** Painel, pesquisa global, notificações, configurações e auditoria. */
const { pool, withTransaction } = require('../db/pool');
const { audit } = require('./audit');
const { has } = require('../middleware/auth');
const { statusAll } = require('../integrations');
const { validator } = require('../lib/validate');
const { isValidCNPJ } = require('../lib/docs');
const { badRequest } = require('../lib/errors');
const config = require('../config');

async function dashboard() {
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const today = `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
  const [appts, received, pending, partial, conferences, fiscal, sched, recon] = await Promise.all([
    q(`SELECT count(*)::int AS n FROM appointments WHERE opened_at >= ${today}`),
    q(`SELECT COALESCE(SUM(amount_cents - refunded_cents),0)::bigint AS v, count(*)::int AS n FROM payments WHERE confirmed_at >= ${today}`),
    q(`SELECT count(*)::int AS n, COALESCE(SUM(total_cents - received_cents),0)::bigint AS v FROM accounts WHERE financial_status = 'PENDENTE' AND total_cents > 0`),
    q(`SELECT count(*)::int AS n, COALESCE(SUM(total_cents - received_cents),0)::bigint AS v FROM accounts WHERE financial_status = 'PARCIAL'`),
    q(`SELECT count(*)::int AS n FROM payments WHERE status = 'AGUARDANDO_CONFERENCIA'`),
    q(`SELECT count(*) FILTER (WHERE status IN ('ENVIADA','PROCESSANDO','PREPARADA'))::int AS pend, count(*) FILTER (WHERE status = 'REJEITADA')::int AS rej FROM fiscal_documents`),
    q(`SELECT count(*)::int AS n FROM schedulings WHERE scheduled_at >= ${today} AND scheduled_at < ${today} + interval '1 day' AND status IN ('AGENDADO','CONFIRMADO')`),
    q(`SELECT count(*)::int AS n FROM bank_reconciliation WHERE status IN ('ABERTA','EM_ANALISE')`),
  ]);
  const { rows: byMethod } = await pool.query(
    `SELECT method, COALESCE(SUM(amount_cents - refunded_cents),0)::bigint AS v FROM payments WHERE confirmed_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`);
  const { rows: last } = await pool.query(
    `SELECT a.id, a.number, a.opened_at, p.name AS patient_name, ac.id AS account_id, ac.financial_status, ac.total_cents, ac.received_cents
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN accounts ac ON ac.appointment_id = a.id ORDER BY a.opened_at DESC LIMIT 8`);
  return {
    demoMode: config.demoMode,
    appointmentsToday: appts.n, receivedToday: { cents: received.v, count: received.n },
    pendingAccounts: { count: pending.n, cents: pending.v }, partialAccounts: { count: partial.n, cents: partial.v },
    awaitingConference: conferences.n, fiscalPending: fiscal.pend, fiscalRejected: fiscal.rej, schedulesToday: sched.n, reconciliationOpen: recon.n,
    receivedByMethod30d: byMethod, lastAppointments: last,
  };
}

async function globalSearch(q, user) {
  const term = String(q || '').trim();
  if (term.length < 2) return { patients: [], appointments: [], accounts: [] };
  const digits = term.replace(/\D/g, '');
  const out = { patients: [], appointments: [], accounts: [] };
  if (has(user, 'patients.view')) {
    out.patients = (await pool.query(
      `SELECT p.id, p.name, p.code, mr.record_number FROM patients p JOIN medical_records mr ON mr.patient_id = p.id
        WHERE lower(p.name) LIKE '%' || lower($1) || '%' OR upper(p.code) = upper($1) OR upper(mr.record_number) = upper($1) OR ($2 <> '' AND p.cpf = $2)
        ORDER BY p.name LIMIT 8`, [term, digits.length === 11 ? digits : ''])).rows;
  }
  if (has(user, 'appointments.view')) {
    out.appointments = (await pool.query(
      `SELECT a.id, a.number, a.opened_at, p.name AS patient_name FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE upper(a.number) LIKE upper($1) || '%' ORDER BY a.id DESC LIMIT 5`, [term])).rows;
  }
  if (has(user, 'accounts.view')) {
    out.accounts = (await pool.query(
      `SELECT ac.id, ac.number, ac.financial_status, p.name AS patient_name FROM accounts ac JOIN patients p ON p.id = ac.patient_id
        WHERE upper(ac.number) LIKE upper($1) || '%' ORDER BY ac.id DESC LIMIT 5`, [term])).rows;
  }
  return out;
}

async function notifications(user) {
  const list = [];
  const n = async (sql) => Number((await pool.query(sql)).rows[0].n);
  if (has(user, 'payments.confer')) {
    const c = await n(`SELECT count(*) AS n FROM payments WHERE status = 'AGUARDANDO_CONFERENCIA'`);
    if (c) list.push({ level: 'warning', text: `${c} pagamento(s) aguardando conferência`, link: '#/quitacao?transaction_status=AGUARDANDO_CONFERENCIA' });
  }
  if (has(user, 'payments.view')) {
    const d = await n(`SELECT count(*) AS n FROM payments WHERE status IN ('DIVERGENTE','FALHA_COMUNICACAO')`);
    if (d) list.push({ level: 'danger', text: `${d} pagamento(s) com divergência ou falha de comunicação`, link: '#/quitacao?transaction_status=DIVERGENTE' });
  }
  if (has(user, 'settings.manage') || has(user, 'reconciliation.view')) {
    const w = await n(`SELECT count(*) AS n FROM payment_webhook_events WHERE status IN ('ERRO','INVALIDO') AND received_at > now() - interval '7 days'`);
    if (w) list.push({ level: 'danger', text: `${w} notificação(ões) de pagamento com erro/inválidas (7 dias)`, link: '#/configuracoes' });
  }
  if (has(user, 'fiscal.view')) {
    const r = await n(`SELECT count(*) AS n FROM fiscal_documents WHERE status IN ('REJEITADA','FALHA_COMUNICACAO') AND updated_at > now() - interval '30 days'`);
    if (r) list.push({ level: 'danger', text: `${r} documento(s) fiscal(is) rejeitado(s)/com falha`, link: '#/fiscal' });
    const e = await n(`SELECT count(*) AS n FROM accounts WHERE financial_status = 'QUITADA' AND fiscal_status IN ('NAO_SOLICITADA','REJEITADA','CANCELADA')`);
    if (e) list.push({ level: 'info', text: `${e} conta(s) quitada(s) elegível(is) para emissão fiscal`, link: '#/fiscal' });
    const a = await n(`SELECT count(*) AS n FROM fiscal_documents fd JOIN accounts ac ON ac.id = fd.account_id WHERE fd.status IN ('EMITIDA','EMITIDA_EXTERNAMENTE') AND ac.financial_status <> 'QUITADA'`);
    if (a) list.push({ level: 'warning', text: `${a} nota(s) emitida(s) para conta(s) que não está(ão) mais quitada(s) (estorno)`, link: '#/fiscal' });
  }
  if (has(user, 'reconciliation.view')) {
    const r = await n(`SELECT count(*) AS n FROM bank_reconciliation WHERE status IN ('ABERTA','EM_ANALISE') AND category <> 'CONCILIADO'`);
    if (r) list.push({ level: 'warning', text: `${r} divergência(s) de conciliação em aberto`, link: '#/conciliacao' });
  }
  return list;
}

async function getSettings() {
  const { rows } = await pool.query('SELECT key, value, updated_at FROM settings ORDER BY key');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function updateSettings(key, body, ctx) {
  let value;
  if (key === 'institution') {
    const v = validator(body);
    value = {
      name: v.string('name', { required: true, max: 160, label: 'Nome' }),
      cnpj: v.digits('cnpj', { length: 14, label: 'CNPJ' }),
      municipalRegistration: v.string('municipalRegistration', { max: 30 }),
      cityIbgeCode: v.digits('cityIbgeCode', { length: 7, label: 'Código IBGE' }),
      city: v.string('city', { max: 100 }),
      state: v.string('state', { max: 2 }),
      address: v.string('address', { max: 200 }),
      phone: v.string('phone', { max: 30 }),
      simplesNacional: v.bool('simplesNacional', { def: false }),
    };
    if (value.cnpj && !isValidCNPJ(value.cnpj)) v.fail('cnpj', 'CNPJ inválido.');
    v.done();
  } else if (key === 'fiscal') {
    const v = validator(body);
    value = { defaultMode: v.oneOf('defaultMode', ['INTEGRACAO', 'EXPORTACAO'], { required: true }), requireSettled: v.bool('requireSettled', { def: true }) };
    v.done();
  } else throw badRequest('Configuração inexistente.');
  return withTransaction(async (c) => {
    await c.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, value, ctx.user.id]);
    await audit(c, ctx, 'CONFIGURACAO_ALTERADA', 'settings', key, value);
    return value;
  });
}

function integrations() {
  return { ...statusAll(), manualPaymentsRequireConference: config.manualPaymentsRequireConference,
    webhookUrls: { pix: '/api/webhooks/pix/{PROVEDOR}/{PIX_WEBHOOK_SECRET}', card: '/api/webhooks/card/{PROVEDOR}' } };
}

async function auditLogs({ entity, entity_id, user_id, action, from, to, limit = 200 }) {
  const params = []; const where = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (entity) add('a.entity = ?', entity);
  if (entity_id) add('a.entity_id = ?', String(entity_id));
  if (user_id) add('a.user_id = ?', user_id);
  if (action) add("a.action ILIKE '%' || ? || '%'", action);
  if (from) add('a.occurred_at >= ?::date', from);
  if (to) add("a.occurred_at < (?::date + interval '1 day')", to);
  const { rows } = await pool.query(
    `SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`, params);
  return rows;
}

module.exports = { dashboard, globalSearch, notifications, getSettings, updateSettings, integrations, auditLogs };
