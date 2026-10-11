import { api, setUnauthorizedHandler } from './api.js';
import { state, can } from './state.js';
import { html, raw, render, $, esc, toast, showError } from './ui.js';
import * as pages from './pages/index.js';

// Ícones (SVG inline, sem dependências externas)
const I = {
  home: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h4"/>',
  steth: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>',
  kit: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M12 10v7M8.5 13.5h7"/>',
  money: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5v11"/>',
  invoice: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7M9 8h3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};
const icon = (k) => raw(`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`);

/**
 * Menu por áreas (como nos ERPs hospitalares de mercado). `keywords` alimenta a pesquisa do menu.
 */
const MENU = [
  { id: 'inicio', label: 'Painel inicial', icon: 'home', path: '/painel', page: pages.dashboard, keywords: 'inicio home dashboard' },
  { id: 'cadastros', label: 'Cadastros', icon: 'id', keywords: 'cadastro registro', items: [
    { path: '/pacientes', label: 'Cadastro de pacientes', perm: ['patients.view'], page: pages.patients, keywords: 'paciente cpf' },
    { path: '/prontuarios', label: 'Prontuários e histórico', perm: ['records.view'], page: pages.records, keywords: 'historico prontuario' },
    { path: '/profissionais', label: 'Cadastro de médicos e profissionais', perm: ['registry.view'], page: pages.registry('professionals'), keywords: 'medico crm coren enfermeiro' },
    { path: '/fornecedores', label: 'Cadastro de fornecedores', perm: ['registry.view'], page: pages.registry('suppliers'), keywords: 'fornecedor cnpj' },
    { path: '/convenios', label: 'Convênios e planos', perm: ['registry.view'], page: pages.registry('insurance_plans'), keywords: 'convenio plano operadora ans' },
    { path: '/procedimentos', label: 'Procedimentos e exames', perm: ['registry.view'], page: pages.registry('procedures'), keywords: 'exame tabela preco tuss' },
  ] },
  { id: 'atendimento', label: 'Atendimento', icon: 'steth', keywords: 'recepcao', items: [
    { path: '/agendamento', label: 'Agendamento', perm: ['scheduling.view'], page: pages.scheduling, keywords: 'agenda marcar' },
    { path: '/atendimentos', label: 'Atendimentos', perm: ['appointments.view'], page: pages.appointments, keywords: 'abertura atendimento' },
    { path: '/atendimentos/novo', label: 'Abrir novo atendimento', perm: ['appointments.open'], page: pages.newAppointment, keywords: 'novo abrir' },
  ] },
  { id: 'clinica', label: 'Clínica e Assistencial', icon: 'kit', keywords: 'medica medico parte medica clinica assistencial saude', items: [
    { path: '/pep', label: 'Prontuário eletrônico (PEP)', perm: ['clinical.view'], page: pages.pep, keywords: 'evolucao prescricao anamnese medico alergia' },
    { path: '/leitos', label: 'Mapa de leitos', perm: ['beds.view'], page: pages.beds, keywords: 'internacao leito ocupacao alta' },
    { path: '/triagem', label: 'Classificação de risco', perm: ['triage.perform', 'clinical.view'], page: pages.triage, keywords: 'triagem pronto socorro urgencia manchester' },
    { path: '/enfermagem', label: 'Área de enfermagem', perm: ['nursing.vitals', 'nursing.administer', 'nursing.sae'], page: pages.nursing, keywords: 'enfermeiro checagem sae plantao sinais vitais' },
  ] },
  { id: 'financeiro', label: 'Financeiro', icon: 'money', keywords: 'financeiro dinheiro pagamento', items: [
    { path: '/contas', label: 'Lançamento de contas', perm: ['accounts.view'], page: pages.accounts, keywords: 'conta atendimento lancamento' },
    { path: '/caixa', label: 'Pagamentos (recebimento e caixa)', perm: ['payments.view'], page: pages.cashier, keywords: 'receber caixa pix cartao dinheiro' },
    { path: '/quitacao', label: 'Quitação de contas', perm: ['settlement.view'], page: pages.settlement, keywords: 'quitar quitada' },
    { path: '/receber', label: 'Contas a receber', perm: ['accounts.view'], page: pages.receivables, keywords: 'receber saldo' },
    { path: '/contas-abertas', label: 'Contas em aberto (sem pagamento)', perm: ['accounts.view'], page: pages.openAccounts, keywords: 'aberto pendente sem pagamento' },
    { path: '/contas-fechadas', label: 'Contas fechadas', perm: ['accounts.view'], page: pages.closedAccounts, keywords: 'fechada quitada encerrada' },
    { path: '/fiscal', label: 'Emissão de notas fiscais', perm: ['fiscal.view'], page: pages.fiscal, keywords: 'nfse nota fiscal' },
    { path: '/boletos', label: 'Emissão de boletos', perm: ['payments.view'], page: pages.boletos, keywords: 'boleto banco linha digitavel' },
    { path: '/conciliacao', label: 'Conciliação bancária', perm: ['reconciliation.view'], page: pages.reconciliation, keywords: 'extrato banco' },
    { path: '/relatorios', label: 'Relatórios financeiros', perm: ['reports.view'], page: pages.reports, keywords: 'relatorio csv' },
  ] },
  { id: 'faturamento', label: 'Faturamento', icon: 'invoice', keywords: 'faturamento convenio operadora', items: [
    { path: '/faturamento', label: 'Contas de convênio', perm: ['billing.view'], page: pages.convenioBilling, keywords: 'convenio guia plano' },
    { path: '/remessas', label: 'Remessas e retorno (glosas)', perm: ['billing.view'], page: pages.batches, keywords: 'lote remessa glosa retorno' },
    { path: '/fechamento', label: 'Conferência e fechamento de contas', perm: ['billing.view'], page: pages.billing, keywords: 'conferir fechar' },
  ] },
  { id: 'admin', label: 'Administração', icon: 'gear', keywords: 'apoio ti sistema', items: [
    { path: '/usuarios', label: 'Usuários e permissões', perm: ['users.manage'], page: pages.users, keywords: 'usuario perfil senha acesso' },
    { path: '/auditoria', label: 'Auditoria', perm: ['audit.view'], page: pages.audit, keywords: 'log historico' },
    { path: '/configuracoes', label: 'Configurações e integrações', perm: ['settings.manage'], page: pages.settings, keywords: 'santander getnet integracao' },
  ] },
];
const ROUTES = MENU.flatMap((g) => (g.items ? g.items.map((i) => ({ ...i, group: g })) : [{ ...g, group: g }]));

// Rotas de detalhe (não aparecem no menu)
const DETAIL = [
  { re: /^\/pacientes\/(\d+)$/, page: pages.patientDetail, perm: ['patients.view'], menu: '/pacientes' },
  { re: /^\/contas\/(\d+)$/, page: pages.accountDetail, perm: ['accounts.view'], menu: '/contas' },
  { re: /^\/pep\/(\d+)$/, page: pages.pep, perm: ['clinical.view'], menu: '/pep' },
];

const view = () => $('#view');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const allowed = (i) => !i.perm || can(...i.perm);
let openGroups = new Set();
try { openGroups = new Set(JSON.parse(localStorage.getItem('sg_menu_open') || '[]')); } catch (_) { /* armazenamento indisponível */ }
const saveOpen = () => { try { localStorage.setItem('sg_menu_open', JSON.stringify([...openGroups])); } catch (_) { /* */ } };
let activePath = '';

function renderMenu(active) {
  activePath = active;
  const q = norm($('#menu-search')?.value);
  const box = $('#menu');
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = ROUTES.filter(allowed).filter((r) => {
      const hay = norm(`${r.label} ${r.keywords || ''} ${r.group.label} ${r.group.keywords || ''}`);
      return terms.every((t) => hay.includes(t));
    });
    render(box, hits.length ? html`<div class="group">Resultados</div>${hits.map((r) => html`<a href="#${r.path}" class="${active === r.path ? 'active' : ''}">
        ${icon(r.group.icon)}<span class="lbl">${r.label}<span class="small sub">${r.group.label}</span></span></a>`)}`
      : html`<div class="menu-empty">Nenhuma área encontrada.</div>`);
    return;
  }
  render(box, html`${MENU.map((g) => {
    if (!g.items) return allowed(g) ? html`<a href="#${g.path}" class="top ${active === g.path ? 'active' : ''}">${icon(g.icon)}<span class="lbl">${g.label}</span></a>` : '';
    const items = g.items.filter(allowed);
    if (!items.length) return '';
    const containsActive = items.some((i) => i.path === active);
    const open = openGroups.has(g.id) || containsActive;
    return html`<div class="mgroup ${open ? 'open' : ''}">
      <button class="mhead ${containsActive ? 'has-active' : ''}" data-group="${g.id}" title="${g.label}">${icon(g.icon)}<span class="lbl">${g.label}</span><span class="chev">▸</span></button>
      <div class="mitems">${items.map((i) => html`<a href="#${i.path}" class="${active === i.path ? 'active' : ''}"><span class="lbl">${i.label}</span></a>`)}</div></div>`;
  })}`);
}

function setupMenu() {
  const input = $('#menu-search');
  input.addEventListener('input', () => renderMenu(activePath));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = $('#menu a'); if (first) { location.hash = first.getAttribute('href'); input.value = ''; renderMenu(activePath); } }
    if (e.key === 'Escape') { input.value = ''; renderMenu(activePath); }
  });
  $('#menu').addEventListener('click', (e) => {
    const h = e.target.closest('[data-group]');
    if (h) {
      const id = h.dataset.group;
      if (openGroups.has(id)) openGroups.delete(id); else openGroups.add(id);
      saveOpen(); renderMenu(activePath);
      if ($('#app').classList.contains('collapsed')) $('#app').classList.remove('collapsed');
      return;
    }
    if (e.target.closest('a') && input.value) { input.value = ''; setTimeout(() => renderMenu(activePath)); }
  });
  $('#menu-toggle').addEventListener('click', () => {
    $('#app').classList.toggle('collapsed');
    try { localStorage.setItem('sg_menu_collapsed', $('#app').classList.contains('collapsed') ? '1' : ''); } catch (_) { /* */ }
  });
  try { if (localStorage.getItem('sg_menu_collapsed')) $('#app').classList.add('collapsed'); } catch (_) { /* */ }
  // Atalho: Ctrl+K / "/" focam a pesquisa do menu
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName))) {
      e.preventDefault(); $('#app').classList.remove('collapsed'); input.focus();
    }
  });
}

let currentCleanup = null;
async function route() {
  if (!state.user) return;
  const hash = location.hash.slice(1) || '/painel';
  const [path, query] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  if (currentCleanup) { try { currentCleanup(); } catch (_) { /* */ } currentCleanup = null; }

  let entry = ROUTES.find((m) => m.path === path);
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
  setupMenu();
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
