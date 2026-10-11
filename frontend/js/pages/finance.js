import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, label, table, showError, busy, toast, today, daysAgo, fresh } from '../ui.js';
import { can } from '../state.js';
import { demoBanner } from '../components.js';
import { openConfer, openPaymentFlow, openReceipt } from '../payments.js';
import { openSettlementHistory } from './account.js';

// ------------------------------------------------------------------ 11. Recebimento e caixa
export async function cashier(host) {
  const el = fresh(host);
  render(el, html`${demoBanner()}
    <div class="page-head"><div><h1>Recebimento e caixa</h1><div class="muted">Movimento do dia, cobranças em andamento e conferências pendentes</div></div>
      <div class="row"><label class="small">Data</label><input type="date" data-date value="${today()}"></div></div>
    <div data-summary></div>
    <div class="card"><h2>Aguardando conferência</h2><div data-confer></div></div>
    <div class="card"><h2>Cobranças em andamento</h2><div data-inflight></div></div>
    <div class="card"><h2>Movimento do dia</h2><div data-day></div></div>`);
  const load = async () => {
    const d = $('[data-date]', el).value;
    const [day, awaiting, pend, proc] = await Promise.all([
      api.get('/payments', { from: d, to: d }), api.get('/payments', { status: 'AGUARDANDO_CONFERENCIA' }),
      api.get('/payments', { status: 'PENDENTE' }), api.get('/payments', { status: 'PROCESSANDO' }),
    ]);
    const confirmed = day.filter((p) => ['CONFIRMADO', 'ESTORNADO_PARCIAL', 'ESTORNADO'].includes(p.status));
    const byMethod = {};
    confirmed.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount_cents - p.refunded_cents; });
    render($('[data-summary]', el), html`<div class="grid k4 mb">
      <div class="card kpi"><div class="label">Total confirmado no dia</div><div class="value">${money(Object.values(byMethod).reduce((a, b) => a + b, 0))}</div><div class="sub">${confirmed.length} pagamento(s)</div></div>
      ${Object.entries(byMethod).map(([m, v]) => html`<div class="card kpi"><div class="label">${label(m)}</div><div class="value">${money(v)}</div></div>`)}</div>`);
    const cols = [
      { label: '#', key: 'id' }, { label: 'Data', render: (p) => datetime(p.created_at) }, { label: 'Conta', render: (p) => html`<a href="#/contas/${p.account_id}">${p.account_number}</a>` },
      { label: 'Paciente', key: 'patient_name' }, { label: 'Forma', render: (p) => html`${label(p.method)}${p.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}` },
      { label: 'Valor', class: 'money', render: (p) => money(p.amount_cents) }, { label: 'Status', render: (p) => badge(p.status) }, { label: 'Registrado por', key: 'created_by_name' },
    ];
    render($('[data-confer]', el), table([...cols, { label: '', render: (p) => (can('payments.confer') ? html`<button class="btn sm primary" data-confer="${p.id}">Conferir</button>` : '') }], awaiting, { empty: 'Nenhum pagamento aguardando conferência.' }));
    render($('[data-inflight]', el), table([...cols, { label: '', render: (p) => html`<button class="btn sm" data-flow="${p.id}">Acompanhar</button>` }], [...pend, ...proc], { empty: 'Nenhuma cobrança em andamento.' }));
    render($('[data-day]', el), table([...cols, { label: 'Confirmação', render: (p) => (p.confirmed_at ? html`<span class="small">${label(p.confirmation_source)}<br>${datetime(p.confirmed_at)}</span>` : '—') },
      { label: '', render: (p) => (p.confirmed_at ? html`<button class="btn sm" data-receipt="${p.id}">Comprovante</button>` : '') }], day, { empty: 'Sem movimento na data.' }));
    el._awaiting = awaiting;
  };
  on(el, 'click', '[data-confer]', (e, b) => openConfer({ ...el._awaiting.find((p) => String(p.id) === b.dataset.confer) }, () => load().catch(showError)));
  on(el, 'click', '[data-flow]', (e, b) => openPaymentFlow(b.dataset.flow, () => load().catch(showError)).catch(showError));
  on(el, 'click', '[data-receipt]', (e, b) => openReceipt(b.dataset.receipt).catch(showError));
  $('[data-date]', el).addEventListener('change', () => load().catch(showError));
  await load();
}

// ------------------------------------------------------------------ 12. Quitação e consulta
export async function settlement(host, { params }) {
  const el = fresh(host);
  let users = [];
  if (can('users.manage')) { try { users = await api.get('/users'); } catch (_) { /* */ } }
  const opt = (list) => list.map((s) => html`<option value="${s}" ${params.transaction_status === s || params.financial_status === s ? 'selected' : ''}>${label(s)}</option>`);
  render(el, html`
    <div class="page-head"><div><h1>Quitação de contas</h1><div class="muted">Localize e acompanhe a quitação. O status é calculado automaticamente a partir dos pagamentos confirmados.</div></div></div>
    <div class="card"><div class="filters">
      <div><label>De</label><input type="date" data-f="from" value="${params.transaction_status ? '' : daysAgo(30)}"></div><div><label>Até</label><input type="date" data-f="to" value="${params.transaction_status ? '' : today()}"></div>
      <div><label>Paciente</label><input data-f="patient"></div><div><label>Nº prontuário</label><input data-f="record_number"></div>
      <div><label>Nº atendimento</label><input data-f="appointment_number"></div><div><label>Nº conta</label><input data-f="account_number"></div>
      <div><label>Forma de pagamento</label><select data-f="method"><option value="">Todas</option>${opt(['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO', 'OUTRO'])}</select></div>
      <div><label>Status da transação</label><select data-f="transaction_status"><option value="">Todos</option>${opt(['PENDENTE', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA', 'CONFIRMADO', 'REJEITADO', 'CANCELADO', 'EXPIRADO', 'ESTORNADO', 'ESTORNADO_PARCIAL', 'DIVERGENTE', 'FALHA_COMUNICACAO'])}</select></div>
      <div><label>Status da conta</label><select data-f="financial_status"><option value="">Todos</option>${opt(['PENDENTE', 'PARCIAL', 'QUITADA', 'CANCELADA'])}</select></div>
      ${users.length ? html`<div><label>Usuário responsável</label><select data-f="user_id"><option value="">Todos</option>${users.map((u) => html`<option value="${u.id}">${u.name}</option>`)}</select></div>` : ''}
      <div><button class="btn primary" data-load>Filtrar</button></div></div></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const f = {}; el.querySelectorAll('[data-f]').forEach((i) => { f[i.dataset.f] = i.value.trim(); });
    const rows = await api.get('/accounts', f);
    const tot = rows.reduce((a, r) => ({ t: a.t + r.total_cents, r: a.r + r.received_cents }), { t: 0, r: 0 });
    render($('[data-list]', el), html`<div class="row between mb"><div class="small muted">${rows.length} conta(s)</div><div class="small">Total ${money(tot.t)} · Recebido ${money(tot.r)} · Saldo <strong>${money(tot.t - tot.r)}</strong></div></div>
      ${table([
    { label: 'Paciente', render: (a) => html`<a href="#/pacientes/${a.patient_id}">${a.patient_name}</a><div class="small muted">${a.record_number}</div>` },
    { label: 'Atendimento', render: (a) => html`${a.appointment_number}<div class="small muted">${datetime(a.opened_at)}</div>` },
    { label: 'Procedimento', render: (a) => a.procedures || '—' },
    { label: 'Valor total', class: 'money', render: (a) => money(a.total_cents) }, { label: 'Valor recebido', class: 'money', render: (a) => money(a.received_cents) },
    { label: 'Saldo devedor', class: 'money', render: (a) => money(a.balance_cents) },
    { label: 'Forma de pagamento', render: (a) => (a.methods ? a.methods.split(', ').map(label).join(', ') : '—') },
    { label: 'Data do pagamento', render: (a) => datetime(a.last_payment_at) },
    { label: 'Status da conta', render: (a) => badge(a.financial_status) },
    { label: 'Status da transação', render: (a) => (a.last_transaction_status ? badge(a.last_transaction_status) : '—') },
    { label: 'Status fiscal', render: (a) => badge(a.fiscal_status) },
    { label: 'Ações', render: (a) => html`<div class="btn-group"><a class="btn sm" href="#/contas/${a.id}">Detalhes / comprovantes</a><button class="btn sm" data-hist="${a.id}">Histórico</button></div>` },
  ], rows)}`);
  };
  on(el, 'click', '[data-hist]', (e, b) => openSettlementHistory(b.dataset.hist).catch(showError));
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
}

// ------------------------------------------------------------------ 13. Contas a receber
export async function receivables(host) {
  const el = fresh(host);
  render(el, html`<div class="page-head"><div><h1>Contas a receber</h1><div class="muted">Contas com saldo devedor (pendentes e parcialmente pagas)</div></div></div><div data-c></div>`);
  const [pend, part] = await Promise.all([api.get('/accounts', { financial_status: 'PENDENTE' }), api.get('/accounts', { financial_status: 'PARCIAL' })]);
  const rows = [...part, ...pend].filter((a) => a.balance_cents > 0);
  const now = Date.now();
  const age = (a) => Math.floor((now - new Date(a.opened_at).getTime()) / 86400000);
  const buckets = { '0-7 dias': 0, '8-30 dias': 0, '31-90 dias': 0, '> 90 dias': 0 };
  rows.forEach((a) => { const d = age(a); buckets[d <= 7 ? '0-7 dias' : d <= 30 ? '8-30 dias' : d <= 90 ? '31-90 dias' : '> 90 dias'] += a.balance_cents; });
  render($('[data-c]', el), html`<div class="grid k4 mb">${Object.entries(buckets).map(([k, v]) => html`<div class="card kpi"><div class="label">${k}</div><div class="value">${money(v)}</div></div>`)}</div>
    <div class="card">${table([
    { label: 'Conta', render: (a) => html`<a href="#/contas/${a.id}">${a.number}</a>` }, { label: 'Paciente', key: 'patient_name' },
    { label: 'Abertura', render: (a) => html`${datetime(a.opened_at)}<div class="small muted">${age(a)} dia(s)</div>` }, { label: 'Modalidade', render: (a) => label(a.modality) },
    { label: 'Total', class: 'money', render: (a) => money(a.total_cents) }, { label: 'Recebido', class: 'money', render: (a) => money(a.received_cents) },
    { label: 'Saldo', class: 'money', render: (a) => html`<strong>${money(a.balance_cents)}</strong>` }, { label: 'Status', render: (a) => badge(a.financial_status) },
  ], rows, { empty: 'Nenhuma conta com saldo em aberto.' })}</div>`);
}

// ------------------------------------------------------------------ 14. Faturamento
export async function billing(host) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Faturamento</h1><div class="muted">Conferência e fechamento de contas (particular e convênio)</div></div></div>
    <div class="card"><div class="filters">
      <div><label>De</label><input type="date" data-f="from" value="${daysAgo(30)}"></div><div><label>Até</label><input type="date" data-f="to" value="${today()}"></div>
      <div><label>Modalidade</label><select data-f="modality"><option value="">Todas</option><option value="PARTICULAR">Particular</option><option value="CONVENIO">Convênio</option></select></div>
      <div><label>Situação</label><select data-f="billing_status"><option value="">Todas</option><option value="ABERTA">Aberta</option><option value="FECHADA">Fechada</option><option value="FATURADA">Faturada</option></select></div>
      <div><button class="btn primary" data-load>Filtrar</button></div></div>
      <p class="small muted">Para convênios, a remessa eletrônica (padrão TISS) é uma etapa futura; aqui as contas são conferidas e fechadas para envio.</p></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const f = {}; el.querySelectorAll('[data-f]').forEach((i) => { f[i.dataset.f] = i.value; });
    const rows = (await api.get('/accounts', f)).filter((a) => a.financial_status !== 'CANCELADA');
    render($('[data-list]', el), table([
      { label: 'Conta', render: (a) => html`<a href="#/contas/${a.id}">${a.number}</a>` }, { label: 'Paciente', key: 'patient_name' }, { label: 'Modalidade', render: (a) => label(a.modality) },
      { label: 'Procedimentos', render: (a) => a.procedures || '—' }, { label: 'Total', class: 'money', render: (a) => money(a.total_cents) },
      { label: 'Conferida', render: (a) => (a.checked_at ? html`<span class="badge ok">Sim</span>` : html`<span class="badge warn">Não</span>`) },
      { label: 'Financeiro', render: (a) => badge(a.financial_status) }, { label: 'Faturamento', render: (a) => badge(a.billing_status) },
      { label: '', render: (a) => (can('billing.manage') ? html`<div class="btn-group">
        ${!a.checked_at && can('accounts.check') ? html`<button class="btn sm" data-check="${a.id}">Conferir</button>` : ''}
        ${a.billing_status === 'ABERTA' ? html`<button class="btn sm" data-bill="${a.id}" data-st="FECHADA">Fechar</button>` : ''}
        ${a.billing_status === 'FECHADA' ? html`<button class="btn sm primary" data-bill="${a.id}" data-st="FATURADA">Marcar faturada</button><button class="btn sm" data-bill="${a.id}" data-st="ABERTA">Reabrir</button>` : ''}</div>` : '') },
    ], rows));
  };
  on(el, 'click', '[data-check]', (e, b) => busy(b, async () => { await api.post(`/accounts/${b.dataset.check}/check`); toast('Conta conferida.', 'ok'); await load(); }));
  on(el, 'click', '[data-bill]', (e, b) => busy(b, async () => { await api.post(`/accounts/${b.dataset.bill}/billing`, { status: b.dataset.st }); toast('Situação atualizada.', 'ok'); await load(); }));
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
}
