import { api, setUnauthorizedHandler } from './api.js';
import { state, can } from './state.js';
import { html, render, $, esc, toast, showError } from './ui.js';
import * as pages from './pages/index.js';

const MENU = [
  { group: 'Geral' },
  { n: 1, path: '/painel', label: 'Painel inicial', page: pages.dashboard },
  { group: 'Cadastros' },
  { n: 2, path: '/pacientes', label: 'Cadastro de pacientes', perm: ['patients.view'], page: pages.patients },
  { n: 3, path: '/prontuarios', label: 'Prontuários e histórico', perm: ['records.view'], page: pages.records },
  { n: 4, path: '/profissionais', label: 'Médicos e profissionais', perm: ['registry.view'], page: pages.registry('professionals') },
  { n: 5, path: '/fornecedores', label: 'Fornecedores', perm: ['registry.view'], page: pages.registry('suppliers') },
  { n: 6, path: '/convenios', label: 'Convênios e planos', perm: ['registry.view'], page: pages.registry('insurance_plans') },
  { n: 7, path: '/procedimentos', label: 'Procedimentos e exames', perm: ['registry.view'], page: pages.registry('procedures') },
  { group: 'Atendimento' },
  { n: 8, path: '/agendamento', label: 'Agendamento', perm: ['scheduling.view'], page: pages.scheduling },
  { n: 9, path: '/atendimentos', label: 'Atendimento', perm: ['appointments.view'], page: pages.appointments },
  { n: 10, path: '/contas', label: 'Conta do atendimento', perm: ['accounts.view'], page: pages.accounts },
  { group: 'Financeiro' },
  { n: 11, path: '/caixa', label: 'Recebimento e caixa', perm: ['payments.view'], page: pages.cashier },
  { n: 12, path: '/quitacao', label: 'Quitação de contas', perm: ['settlement.view'], page: pages.settlement },
  { n: 13, path: '/receber', label: 'Contas a receber', perm: ['accounts.view'], page: pages.receivables },
  { n: 14, path: '/faturamento', label: 'Faturamento', perm: ['billing.view'], page: pages.billing },
  { n: 15, path: '/fiscal', label: 'Notas fiscais (NFS-e)', perm: ['fiscal.view'], page: pages.fiscal },
  { n: 16, path: '/conciliacao', label: 'Conciliação bancária', perm: ['reconciliation.view'], page: pages.reconciliation },
  { n: 17, path: '/relatorios', label: 'Relatórios financeiros', perm: ['reports.view'], page: pages.reports },
  { group: 'Administração' },
  { n: 18, path: '/usuarios', label: 'Usuários e permissões', perm: ['users.manage'], page: pages.users },
  { n: 19, path: '/auditoria', label: 'Auditoria', perm: ['audit.view'], page: pages.audit },
  { n: 20, path: '/configuracoes', label: 'Configurações e integrações', perm: ['settings.manage'], page: pages.settings },
];

// Rotas de detalhe (não aparecem no menu)
const DETAIL = [
  { re: /^\/pacientes\/(\d+)$/, page: pages.patientDetail, perm: ['patients.view'], menu: '/pacientes' },
  { re: /^\/atendimentos\/novo$/, page: pages.newAppointment, perm: ['appointments.open'], menu: '/atendimentos' },
  { re: /^\/contas\/(\d+)$/, page: pages.accountDetail, perm: ['accounts.view'], menu: '/contas' },
];

const view = () => $('#view');

function renderMenu(active) {
  const items = MENU.filter((m) => m.group || !m.perm || can(...m.perm));
  // remove grupos vazios
  const visible = items.filter((m, i) => !m.group || (items[i + 1] && !items[i + 1].group));
  render($('#menu'), html`${visible.map((m) => (m.group
    ? html`<div class="group">${m.group}</div>`
    : html`<a href="#${m.path}" class="${active === m.path ? 'active' : ''}"><span class="num">${m.n}</span>${m.label}</a>`))}`);
}

let currentCleanup = null;
async function route() {
  if (!state.user) return;
  const hash = location.hash.slice(1) || '/painel';
  const [path, query] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  if (currentCleanup) { try { currentCleanup(); } catch (_) { /* */ } currentCleanup = null; }

  let entry = MENU.find((m) => m.path === path);
  let args = [];
  let menuPath = path;
  if (!entry) {
    const d = DETAIL.find((x) => x.re.test(path));
    if (d) { entry = d; args = path.match(d.re).slice(1); menuPath = d.menu; }
  }
  renderMenu(menuPath);
  const el = view();
  if (!entry) { render(el, html`<div class="card empty">Página não encontrada.</div>`); return; }
  if (entry.perm && !can(...entry.perm)) { render(el, html`<div class="card"><div class="alert danger">Você não tem permissão para acessar este módulo.</div></div>`); return; }
  render(el, html`<div class="waiting"><div class="spinner"></div> Carregando…</div>`);
  try {
    const cleanup = await entry.page(el, { args, params });
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (e) {
    showError(e);
    render(el, html`<div class="card"><div class="alert danger">${e.message}</div></div>`);
  }
  el.scrollTop = 0;
}

// ---------------------------------------------------------------- busca global
function setupSearch() {
  const input = $('#global-search'); const box = $('#search-results');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.add('hidden'); return; }
    timer = setTimeout(async () => {
      try {
        const r = await api.get('/search', { q });
        const groups = [
          ['Pacientes', r.patients.map((p) => html`<a href="#/pacientes/${p.id}">${p.name} <span class="muted small">${p.code} · ${p.record_number}</span></a>`)],
          ['Atendimentos', r.appointments.map((a) => html`<a href="#/atendimentos?q=${a.number}">${a.number} <span class="muted small">${a.patient_name}</span></a>`)],
          ['Contas', r.accounts.map((a) => html`<a href="#/contas/${a.id}">${a.number} <span class="muted small">${a.patient_name}</span></a>`)],
        ].filter(([, l]) => l.length);
        render(box, groups.length ? html`${groups.map(([t, l]) => html`<div class="sr-group">${t}</div>${l}`)}` : html`<div class="empty">Nada encontrado.</div>`);
        box.classList.remove('hidden');
      } catch (e) { showError(e); }
    }, 250);
  });
  box.addEventListener('click', () => { box.classList.add('hidden'); input.value = ''; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.add('hidden'); });
}

// ---------------------------------------------------------------- notificações
async function loadNotifications() {
  if (!state.user) return;
  try {
    const list = await api.get('/notifications');
    const c = $('#bell-count');
    c.textContent = list.length; c.classList.toggle('hidden', !list.length);
    render($('#notif-panel'), list.length
      ? html`${list.map((n) => html`<a href="${n.link}"><span class="badge ${n.level === 'danger' ? 'danger' : n.level === 'warning' ? 'warn' : 'info'}">●</span> ${n.text}</a>`)}`
      : html`<div class="empty">Sem notificações.</div>`);
  } catch (_) { /* silencioso */ }
}

// ---------------------------------------------------------------- sessão
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  const minutes = state.sessionIdleMinutes || 30;
  idleTimer = setTimeout(async () => {
    toast('Sessão encerrada por inatividade.', 'warn');
    await logout();
  }, minutes * 60 * 1000);
}

function showLogin() {
  state.user = null;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  render(view(), '');
}

async function startApp(user, policy) {
  state.user = user;
  state.sessionIdleMinutes = policy?.idleMinutes;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = user.name;
  $('#user-role').textContent = user.roleName;
  $('#user-avatar').textContent = user.name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  try { state.demoMode = (await api.get('/demo/state')).demoMode; } catch (_) { state.demoMode = false; }
  loadNotifications();
  resetIdle();
  route();
}

async function logout() {
  try { await api.post('/auth/logout'); } catch (_) { /* */ }
  showLogin();
}

function setupLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error'); err.classList.add('hidden');
    const btn = $('#login-btn'); btn.disabled = true;
    try {
      const r = await api.post('/auth/login', { email: $('#email').value, password: $('#password').value });
      $('#password').value = '';
      await startApp(r.user, r.sessionPolicy);
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove('hidden');
    } finally { btn.disabled = false; }
  });
}

async function boot() {
  setupLogin();
  fetch('/health').then((r) => r.json()).then((h) => $('#demo-users').classList.toggle('hidden', !h.demoMode)).catch(() => {});
  setupSearch();
  setUnauthorizedHandler(() => { if (state.user) toast('Sessão expirada. Faça login novamente.', 'warn'); showLogin(); });
  $('#logout').addEventListener('click', logout);
  $('#bell').addEventListener('click', () => $('#notif-panel').classList.toggle('hidden'));
  $('#notif-panel').addEventListener('click', () => $('#notif-panel').classList.add('hidden'));
  ['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (state.user) resetIdle(); }, { passive: true }));
  window.addEventListener('hashchange', route);
  setInterval(loadNotifications, 60000);
  try {
    const me = await api.get('/auth/me');
    await startApp(me.user, me.sessionPolicy);
  } catch (_) { showLogin(); }
}

window.addEventListener('error', (e) => console.error(esc(e.message)));
boot();
