'use strict';
/** Rotas REST autenticadas. Cada rota declara a permissão exigida. */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { requireAuth, requirePermission: can } = require('../middleware/auth');
const { toCSV } = require('../lib/csv');
const auth = require('../services/authService');
const patients = require('../services/patientService');
const registry = require('../services/registryService');
const appointments = require('../services/appointmentService');
const accounts = require('../services/accountService');
const payments = require('../services/paymentService');
const webhooks = require('../services/webhookService');
const fiscal = require('../services/fiscalService');
const recon = require('../services/reconciliationService');
const reports = require('../services/reportService');
const scheduling = require('../services/schedulingService');
const users = require('../services/userService');
const admin = require('../services/adminService');
const demo = require('../services/demoService');
const { audit } = require('../services/audit');
const { PERMISSIONS } = require('../lib/permissions');

const r = express.Router();
const id = (req, name = 'id') => Number(req.params[name]);

// ---------------- Autenticação ----------------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 20), standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'MUITAS_TENTATIVAS', message: 'Muitas tentativas de login. Aguarde alguns minutos.' } } });

r.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: { code: 'VALIDACAO', message: 'Informe e-mail e senha.' } });
  const s = await auth.login(email.trim(), password, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(config.session.cookieName, s.token, { httpOnly: true, sameSite: 'strict', secure: config.session.secureCookie, expires: s.expires, path: '/' });
  res.json({ user: s.user, sessionPolicy: { idleMinutes: config.session.idleMinutes, absoluteHours: config.session.absoluteHours } });
});
r.post('/auth/logout', async (req, res) => {
  await auth.logout(req.ctx.sessionToken, req.ctx);
  res.clearCookie(config.session.cookieName, { path: '/' });
  res.json({ ok: true });
});
r.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.ctx.user, demoMode: config.demoMode, sessionPolicy: { idleMinutes: config.session.idleMinutes } }));

r.use(requireAuth);

// ---------------- Painel / busca / notificações ----------------
r.get('/dashboard', async (req, res) => res.json(await admin.dashboard()));
r.get('/search', async (req, res) => res.json(await admin.globalSearch(req.query.q, req.ctx.user)));
r.get('/notifications', async (req, res) => res.json(await admin.notifications(req.ctx.user)));

// ---------------- Assistencial (PEP, leitos, triagem, prescrição, enfermagem) ----------------
r.use(require('./clinical'));

// ---------------- Pacientes / prontuário ----------------
r.get('/patients', can('patients.view'), async (req, res) => res.json((await patients.search(req.query)).map((p) => patients.present(p, req.ctx.user))));
r.post('/patients', can('patients.create'), async (req, res) => res.status(201).json(await patients.create(req.body, req.ctx)));
r.post('/patients/check-duplicates', can('patients.create'), async (req, res) => {
  const { pool } = require('../db/pool');
  const b = req.body || {};
  const cpf = b.cpf ? String(b.cpf).replace(/\D/g, '') || null : null;
  const birth = /^\d{4}-\d{2}-\d{2}$/.test(b.birth_date || '') ? b.birth_date : null;
  res.json(await patients.findDuplicates(pool, { name: String(b.name || ''), cpf, birth_date: birth }, Number(b.exclude_id) || null));
});
r.get('/patients/:id', can('patients.view'), async (req, res) => {
  const p = await patients.get(id(req));
  await audit(null, req.ctx, 'PACIENTE_CONSULTADO', 'patients', p.id, {}); // LGPD: rastreabilidade de acesso
  res.json(patients.present(p, req.ctx.user));
});
r.put('/patients/:id', can('patients.edit'), async (req, res) => res.json(await patients.update(id(req), req.body, req.ctx)));
r.get('/patients/:id/history', can('records.view'), async (req, res) => res.json(await patients.history(id(req))));
r.get('/patients/:id/documents', can('payments.view', 'fiscal.view'), async (req, res) => res.json(await patients.documents(id(req))));

// ---------------- Cadastros ----------------
for (const entity of Object.keys(registry.ENTITIES)) {
  const path = `/${entity.replace('_', '-')}`;
  r.get(path, can('registry.view', 'appointments.open', 'scheduling.view'), async (req, res) => res.json(await registry.list(entity, req.query)));
  r.get(`${path}/:id`, can('registry.view'), async (req, res) => res.json(await registry.get(entity, id(req))));
  r.post(path, can('registry.manage'), async (req, res) => res.status(201).json(await registry.create(entity, req.body, req.ctx)));
  r.put(`${path}/:id`, can('registry.manage'), async (req, res) => res.json(await registry.update(entity, id(req), req.body, req.ctx)));
}

// ---------------- Agenda ----------------
r.get('/schedulings', can('scheduling.view'), async (req, res) => res.json(await scheduling.list(req.query)));
r.post('/schedulings', can('scheduling.manage'), async (req, res) => res.status(201).json(await scheduling.create(req.body, req.ctx)));
r.post('/schedulings/:id/status', can('scheduling.manage'), async (req, res) => res.json(await scheduling.setStatus(id(req), req.body, req.ctx)));

// ---------------- Atendimentos ----------------
r.get('/appointments', can('appointments.view'), async (req, res) => res.json(await appointments.list(req.query)));
r.post('/appointments', can('appointments.open'), async (req, res) => res.status(201).json(await appointments.open(req.body, req.ctx)));
r.get('/appointments/:id', can('appointments.view'), async (req, res) => res.json(await appointments.get(id(req))));
r.post('/appointments/:id/status', can('appointments.open'), async (req, res) => res.json(await appointments.setStatus(id(req), req.body.status, req.ctx)));
r.post('/appointments/:id/cancel', can('appointments.cancel'), async (req, res) => res.json(await appointments.cancel(id(req), req.body, req.ctx)));

// ---------------- Contas ----------------
r.get('/accounts', can('accounts.view', 'settlement.view'), async (req, res) => res.json(await accounts.search(req.query)));
r.get('/accounts/:id', can('accounts.view'), async (req, res) => {
  const a = await accounts.get(id(req));
  if (!req.ctx.user.permissions.includes('patients.view_sensitive')) a.patient_cpf = a.patient_cpf ? '***' : null;
  res.json(a);
});
r.post('/accounts/:id/items', can('accounts.edit_items'), async (req, res) => res.status(201).json(await accounts.addItem(id(req), req.body, req.ctx)));
r.post('/accounts/:id/items/:itemId/cancel', can('accounts.remove_item'), async (req, res) => res.json(await accounts.cancelItem(id(req), id(req, 'itemId'), req.body, req.ctx)));
r.post('/accounts/:id/check', can('accounts.check'), async (req, res) => res.json(await accounts.check(id(req), req.ctx)));
r.post('/accounts/:id/billing', can('billing.manage'), async (req, res) => res.json(await accounts.setBillingStatus(id(req), req.body.status, req.ctx)));
r.get('/accounts/:id/settlement', can('settlement.view'), async (req, res) => res.json(await accounts.settlementHistory(id(req))));
r.post('/accounts/:id/payments', can('payments.receive'), async (req, res) => res.status(201).json(await payments.start(id(req), req.body, req.ctx)));

// ---------------- Pagamentos ----------------
r.get('/payments', can('payments.view'), async (req, res) => res.json(await payments.list(req.query)));
r.get('/payments/:id', can('payments.view'), async (req, res) => res.json(await payments.getPayment(id(req))));
r.post('/payments/:id/refresh', can('payments.receive', 'payments.view'), async (req, res) => res.json(await payments.refresh(id(req), req.ctx)));
r.post('/payments/:id/confer', can('payments.confer'), async (req, res) => res.json(await payments.confer(id(req), req.body, req.ctx)));
r.post('/payments/:id/cancel', can('payments.receive'), async (req, res) => res.json(await payments.cancel(id(req), req.body, req.ctx)));
r.post('/payments/:id/refund', can('payments.refund'), async (req, res) => res.json(await payments.refund(id(req), req.body, req.ctx)));
r.post('/payments/:id/reassign', can('payments.reassign'), async (req, res) => res.json(await payments.reassign(id(req), req.body, req.ctx)));
r.get('/payments/:id/receipt', can('payments.view'), async (req, res) => {
  const rc = await payments.receipt(id(req));
  await audit(null, req.ctx, 'COMPROVANTE_CONSULTADO', 'payments', rc.payment_id, {});
  res.json(rc);
});
r.get('/webhook-events', can('settings.manage', 'reconciliation.view'), async (req, res) => res.json(await webhooks.list(req.query)));
r.post('/webhook-events/retry', can('settings.manage', 'reconciliation.manage'), async (req, res) => res.json(await webhooks.retryFailed()));

// ---------------- Fiscal ----------------
r.get('/fiscal/eligible', can('fiscal.view'), async (req, res) => res.json(await fiscal.eligible()));
r.get('/fiscal/documents', can('fiscal.view'), async (req, res) => res.json(await fiscal.list(req.query)));
r.get('/fiscal/documents/:id', can('fiscal.view'), async (req, res) => res.json(await fiscal.get(id(req))));
r.get('/fiscal/documents/:id/export', can('fiscal.manage'), async (req, res) => {
  const data = await fiscal.exportData(id(req));
  await audit(null, req.ctx, 'FISCAL_EXPORTACAO_DOWNLOAD', 'fiscal_documents', id(req), {});
  if (req.query.format === 'xml') { res.type('application/xml').attachment(`dps-${id(req)}.xml`).send(data.xml_dps_nao_assinado); return; }
  res.json(data);
});
r.get('/fiscal/accounts/:id/preview', can('fiscal.view'), async (req, res) => res.json(await fiscal.preview(id(req))));
r.put('/fiscal/documents/:id', can('fiscal.manage'), async (req, res) => res.json(await fiscal.updateDraft(id(req), req.body, req.ctx)));
r.post('/fiscal/accounts/:id/prepare', can('fiscal.manage'), async (req, res) => res.status(201).json(await fiscal.prepare(id(req), req.body, req.ctx)));
r.post('/fiscal/documents/:id/submit', can('fiscal.manage'), async (req, res) => res.json(await fiscal.submit(id(req), req.ctx)));
r.post('/fiscal/documents/:id/check', can('fiscal.manage', 'fiscal.view'), async (req, res) => res.json(await fiscal.check(id(req), req.ctx)));
r.post('/fiscal/documents/:id/external', can('fiscal.manage'), async (req, res) => res.json(await fiscal.registerExternal(id(req), req.body, req.ctx)));
r.post('/fiscal/documents/:id/cancel', can('fiscal.cancel'), async (req, res) => res.json(await fiscal.cancel(id(req), req.body, req.ctx)));

// ---------------- Conciliação ----------------
r.get('/reconciliation/runs', can('reconciliation.view'), async (req, res) => res.json(await recon.runs()));
r.get('/reconciliation/runs/:id/items', can('reconciliation.view'), async (req, res) => res.json(await recon.items(id(req), req.query)));
r.get('/reconciliation/statement', can('reconciliation.view'), async (req, res) => res.json(await recon.statement(req.query)));
r.post('/reconciliation/import', can('reconciliation.manage'), async (req, res) => res.json(await recon.importFromProvider(req.body, req.ctx)));
r.post('/reconciliation/import-csv', can('reconciliation.manage'), async (req, res) => res.json(await recon.importCSV(req.body, req.ctx)));
r.post('/reconciliation/run', can('reconciliation.manage'), async (req, res) => res.json(await recon.run(req.body, req.ctx)));
r.post('/reconciliation/items/:id/resolve', can('reconciliation.manage'), async (req, res) => res.json(await recon.resolve(id(req), req.body, req.ctx)));

// ---------------- Relatórios ----------------
r.get('/reports', can('reports.view'), (req, res) => res.json(reports.list()));
r.get('/reports/:type', can('reports.view'), async (req, res) => {
  if (req.query.format === 'csv') {
    if (!req.ctx.user.permissions.includes('reports.export')) return res.status(403).json({ error: { code: 'SEM_PERMISSAO', message: 'Exportação exige a permissão reports.export.' } });
    const out = await reports.run(req.params.type, req.query);
    await audit(null, req.ctx, 'RELATORIO_EXPORTADO', 'reports', req.params.type, { from: req.query.from, to: req.query.to, linhas: out.rows.length });
    res.type('text/csv; charset=utf-8').attachment(`${req.params.type}_${req.query.from}_${req.query.to}.csv`).send(toCSV(out.def.columns, out.rows));
    return;
  }
  const out = await reports.run(req.params.type, req.query);
  res.json({ type: out.type, title: out.title, rows: out.rows });
});

// ---------------- Usuários e permissões ----------------
r.get('/users', can('users.manage'), async (req, res) => res.json(await users.list()));
r.post('/users', can('users.manage'), async (req, res) => res.status(201).json(await users.create(req.body, req.ctx)));
r.put('/users/:id', can('users.manage'), async (req, res) => res.json(await users.update(id(req), req.body, req.ctx)));
r.get('/roles', can('users.manage'), async (req, res) => res.json({ roles: await users.roles(), permissions: PERMISSIONS }));
r.put('/roles/:id', can('users.manage'), async (req, res) => res.json(await users.updateRole(id(req), req.body, req.ctx)));

// ---------------- Auditoria ----------------
r.get('/audit', can('audit.view'), async (req, res) => res.json(await admin.auditLogs(req.query)));

// ---------------- Configurações e integrações ----------------
r.get('/settings', can('settings.manage', 'fiscal.manage'), async (req, res) => res.json(await admin.getSettings()));
r.put('/settings/:key', can('settings.manage'), async (req, res) => res.json(await admin.updateSettings(req.params.key, req.body, req.ctx)));
r.get('/integrations', can('settings.manage', 'payments.receive', 'fiscal.view'), (req, res) => res.json(admin.integrations()));

// ---------------- Demonstração ----------------
r.get('/demo/state', (req, res) => res.json(demo.state()));
r.post('/demo/payments/:id/pix', can('demo.simulate'), async (req, res) => res.json(await demo.simulatePix(id(req), req.body, req.ctx)));
r.post('/demo/payments/:id/card', can('demo.simulate'), async (req, res) => res.json(await demo.simulateCard(id(req), req.body, req.ctx)));
r.post('/demo/failure', can('demo.simulate'), async (req, res) => res.json(await demo.setFailure(req.body, req.ctx)));
r.post('/demo/fiscal-outcome', can('demo.simulate'), async (req, res) => res.json(await demo.setFiscalOutcome(req.body, req.ctx)));
r.post('/demo/orphan-pix', can('demo.simulate'), async (req, res) => res.json(await demo.orphanPix(req.body, req.ctx)));

module.exports = r;
