// FATURAMENTO DE CONVÊNIOS: contas de convênio, geração de remessas, envio e retorno (pagamento e glosa).
import { api } from '../api.js';
import { html, render, $, $$, on, fresh, money, datetime, badge, table, showError, busy, toast, formDialog, modal, toCents, centsToInput } from '../ui.js';
import { can } from '../state.js';

const BATCH = { ABERTA: ['Aberta', 'warn'], ENVIADA: ['Enviada', 'info'], RETORNO_REGISTRADO: ['Retorno registrado', 'ok'], CANCELADA: ['Cancelada', 'danger'] };
const batchBadge = (s) => html`<span class="badge ${BATCH[s][1]}">${BATCH[s][0]}</span>`;

export async function convenioBilling(host, { params }) {
  const el = fresh(host);
  const reload = () => convenioBilling(host, { params }).catch(showError);
  const plans = await api.get('/insurance-plans', { active: 'true' });
  const f = { insurance_plan_id: params.convenio || '', billing_status: params.situacao || '' };
  const rows = await api.get('/billing/convenio-accounts', f);
  const manage = can('billing.manage');
  const byPlan = {};
  rows.forEach((r) => { byPlan[r.insurance_name] = (byPlan[r.insurance_name] || 0) + r.balance_cents; });
  render(el, html`<div class="page-head"><div><h1>Faturamento de convênios</h1><div class="muted">Contas de atendimentos por convênio: conferir, fechar e enviar em remessa à operadora</div></div>
      <a class="btn" href="#/remessas">Ver remessas</a></div>
    <div class="card"><div class="filters">
      <div><label>Convênio</label><select data-f="convenio"><option value="">Todos</option>${plans.map((p) => html`<option value="${p.id}" ${String(p.id) === f.insurance_plan_id ? 'selected' : ''}>${p.name}</option>`)}</select></div>
      <div><label>Situação da conta</label><select data-f="situacao"><option value="">Todas</option>${[['ABERTA', 'Aberta (em lançamento)'], ['FECHADA', 'Fechada (pronta p/ remessa)'], ['FATURADA', 'Faturada (enviada)']].map(([v, l]) => html`<option value="${v}" ${v === f.billing_status ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div><button class="btn" data-filter>Filtrar</button></div></div></div>
    <div class="grid k4 mb">${Object.entries(byPlan).map(([n, v]) => html`<div class="card kpi"><div class="label">${n}</div><div class="value">${money(v)}</div><div class="sub">saldo a faturar/receber</div></div>`)}</div>
    <div class="card"><div class="row between mb"><h2>Contas</h2>${manage ? html`<button class="btn primary" data-batch>Gerar remessa com selecionadas</button>` : ''}</div>
      ${table([
    { label: '', render: (a) => (a.billing_status === 'FECHADA' && !a.batch_number && a.balance_cents > 0 ? html`<input type="checkbox" data-sel="${a.id}" data-plan="${a.insurance_plan_id}">` : '') },
    { label: 'Conta', render: (a) => html`<a href="#/contas/${a.id}"><strong>${a.number}</strong></a>` },
    { label: 'Convênio', render: (a) => html`${a.insurance_name}<div class="small muted">Carteira ${a.insurance_card_number || '—'}</div>` },
    { label: 'Paciente / atendimento', render: (a) => html`${a.patient_name}<div class="small muted">${a.appointment_number} · ${datetime(a.opened_at)}</div>` },
    { label: 'Procedimentos', render: (a) => a.procedures || '—' },
    { label: 'Valor', class: 'money', render: (a) => money(a.total_cents) }, { label: 'Saldo', class: 'money', render: (a) => money(a.balance_cents) },
    { label: 'Conferida', render: (a) => (a.checked_at ? html`<span class="badge ok">Sim</span>` : html`<span class="badge warn">Não</span>`) },
    { label: 'Situação', render: (a) => html`${badge(a.billing_status)}${a.batch_number ? html`<div class="small">${a.batch_number} · ${BATCH[a.batch_status][0]}</div>` : ''}` },
    { label: 'Financeiro', render: (a) => badge(a.financial_status) },
    { label: '', render: (a) => (manage && !a.batch_number ? html`<div class="btn-group">
        ${!a.checked_at ? html`<button class="btn sm" data-check="${a.id}">Conferir</button>` : ''}
        ${a.billing_status === 'ABERTA' && a.checked_at ? html`<button class="btn sm" data-close="${a.id}">Fechar conta</button>` : ''}
        ${a.billing_status === 'FECHADA' ? html`<button class="btn sm" data-reopen="${a.id}">Reabrir</button>` : ''}</div>` : '') },
  ], rows, { empty: 'Nenhuma conta de convênio no filtro.' })}</div>`);
  const go = () => { location.hash = `#/faturamento?${new URLSearchParams({ convenio: $('[data-f=convenio]', el).value, situacao: $('[data-f=situacao]', el).value })}`; };
  on(el, 'click', '[data-filter]', go);
  on(el, 'click', '[data-check]', (e, b) => busy(b, async () => { await api.post(`/accounts/${b.dataset.check}/check`); toast('Conta conferida.', 'ok'); reload(); }));
  on(el, 'click', '[data-close]', (e, b) => busy(b, async () => { await api.post(`/accounts/${b.dataset.close}/billing`, { status: 'FECHADA' }); toast('Conta fechada para faturamento.', 'ok'); reload(); }));
  on(el, 'click', '[data-reopen]', (e, b) => busy(b, async () => { await api.post(`/accounts/${b.dataset.reopen}/billing`, { status: 'ABERTA' }); reload(); }));
  on(el, 'click', '[data-batch]', () => {
    const sel = $$('[data-sel]:checked', el);
    if (!sel.length) return toast('Selecione contas fechadas (sem remessa).', 'warn');
    const plansSel = [...new Set(sel.map((s) => s.dataset.plan))];
    if (plansSel.length > 1) return toast('Selecione contas de um único convênio por remessa.', 'warn');
    const d = new Date();
    return formDialog({ title: `Gerar remessa — ${sel.length} conta(s)`, fields: [
      { name: 'competence', label: 'Competência (AAAA-MM)', value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }, { name: 'notes', label: 'Observações', type: 'textarea', full: true }],
    onSubmit: async (v) => { const b = await api.post('/billing/batches', { insurance_plan_id: plansSel[0], account_ids: sel.map((s) => s.dataset.sel), ...v }); toast(`Remessa ${b.number} gerada.`, 'ok'); location.hash = '#/remessas'; } });
  });
}

export async function batches(host) {
  const el = fresh(host);
  const reload = () => batches(host).catch(showError);
  const rows = await api.get('/billing/batches');
  const manage = can('billing.manage');
  render(el, html`<div class="page-head"><div><h1>Remessas de convênio</h1><div class="muted">Lotes enviados às operadoras, retorno de pagamento e glosas</div></div><a class="btn" href="#/faturamento">Contas de convênio</a></div>
    <div class="card">${table([
    { label: 'Remessa', render: (b) => html`<strong>${b.number}</strong><div class="small muted">competência ${b.competence}</div>` }, { label: 'Convênio', key: 'insurance_name' },
    { label: 'Contas', key: 'accounts' }, { label: 'Faturado', class: 'money', render: (b) => money(b.total_cents) },
    { label: 'Pago', class: 'money', render: (b) => (b.status === 'RETORNO_REGISTRADO' ? money(b.paid_cents) : '—') },
    { label: 'Glosa', class: 'money', render: (b) => (b.status === 'RETORNO_REGISTRADO' ? html`<span class="${b.glosa_cents ? 'badge danger' : ''}">${money(b.glosa_cents)}</span>` : '—') },
    { label: 'Situação', render: (b) => html`${batchBadge(b.status)}${b.protocol ? html`<div class="small muted">prot. ${b.protocol}</div>` : ''}` },
    { label: 'Datas', render: (b) => html`<span class="small">Criada ${datetime(b.created_at)}${b.sent_at ? html`<br>Enviada ${datetime(b.sent_at)}` : ''}${b.returned_at ? html`<br>Retorno ${datetime(b.returned_at)}` : ''}</span>` },
    { label: '', render: (b) => html`<div class="btn-group"><button class="btn sm" data-open="${b.id}">Detalhes</button>
      ${manage && b.status === 'ABERTA' ? html`<button class="btn sm primary" data-send="${b.id}">Enviar</button><button class="btn sm danger" data-cancel="${b.id}">Cancelar</button>` : ''}
      ${manage && b.status === 'ENVIADA' ? html`<button class="btn sm primary" data-return="${b.id}">Registrar retorno</button>` : ''}</div>` },
  ], rows, { empty: 'Nenhuma remessa. Gere a partir de "Contas de convênio".' })}</div>`);
  on(el, 'click', '[data-send]', (e, b) => formDialog({ title: 'Enviar remessa à operadora', fields: [{ name: 'protocol', label: 'Protocolo de envio (portal da operadora)' }],
    intro: html`<div class="alert info small">O envio eletrônico no padrão TISS depende do portal/webservice de cada operadora. Registre aqui o protocolo recebido.</div>`,
    onSubmit: async (v) => { await api.post(`/billing/batches/${b.dataset.send}/send`, v); toast('Remessa enviada.', 'ok'); reload(); } }));
  on(el, 'click', '[data-cancel]', (e, b) => formDialog({ title: 'Cancelar remessa', fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/billing/batches/${b.dataset.cancel}/cancel`, v); toast('Remessa cancelada; contas liberadas.', 'ok'); reload(); } }));
  on(el, 'click', '[data-open]', (e, b) => busy(b, async () => {
    const d = await api.get(`/billing/batches/${b.dataset.open}`);
    modal({ title: `Remessa ${d.number} — ${d.insurance_name}`, wide: true, body: html`${table([
      { label: 'Conta', render: (i) => html`<a href="#/contas/${i.account_id}">${i.account_number}</a>` }, { label: 'Paciente', render: (i) => html`${i.patient_name}<div class="small muted">Carteira ${i.insurance_card_number || '—'}</div>` },
      { label: 'Faturado', class: 'money', render: (i) => money(i.billed_cents) }, { label: 'Pago', class: 'money', render: (i) => (i.paid_cents != null ? money(i.paid_cents) : '—') },
      { label: 'Glosa', class: 'money', render: (i) => (i.glosa_cents ? html`${money(i.glosa_cents)}<div class="small muted">${i.glosa_reason}</div>` : '—') },
      { label: 'Repasse', render: (i) => (i.payment_status ? badge(i.payment_status) : '—') }, { label: 'Conta', render: (i) => badge(i.financial_status) }], d.items)}
      <p class="small muted">O repasse do convênio entra como pagamento "aguardando conferência"; o financeiro confere com o extrato para a conta ser atualizada.</p>` });
  }));
  on(el, 'click', '[data-return]', (e, b) => busy(b, async () => {
    const d = await api.get(`/billing/batches/${b.dataset.return}`);
    const body = document.createElement('div');
    render(body, html`<p class="small muted">Informe, por conta, o valor pago pela operadora e a glosa (com motivo).</p>
      <table class="grid-items"><thead><tr><th>Conta</th><th>Paciente</th><th class="money">Faturado</th><th>Pago (R$)</th><th>Glosa (R$)</th><th>Motivo da glosa</th></tr></thead>
      <tbody>${d.items.map((i) => html`<tr data-item="${i.account_id}"><td>${i.account_number}</td><td>${i.patient_name}</td><td class="money">${money(i.billed_cents)}</td>
        <td><input name="paid" value="${centsToInput(i.billed_cents)}"></td><td><input name="glosa" value="0,00"></td><td><input name="reason"></td></tr>`)}</tbody></table>`);
    modal({ title: `Retorno da remessa ${d.number}`, wide: true, body, actions: [{ label: 'Cancelar' }, { label: 'Registrar retorno', class: 'primary', onClick: async () => {
      const items = $$('[data-item]', body).map((tr) => ({ account_id: Number(tr.dataset.item), paid_cents: toCents(tr.querySelector('[name=paid]').value) ?? 0,
        glosa_cents: toCents(tr.querySelector('[name=glosa]').value) ?? 0, glosa_reason: tr.querySelector('[name=reason]').value.trim() || null }));
      if (items.some((i) => Number.isNaN(i.paid_cents) || Number.isNaN(i.glosa_cents))) throw new Error('Valores inválidos.');
      await api.post(`/billing/batches/${d.id}/return`, { items }); toast('Retorno registrado. Repasses aguardam conferência do financeiro.', 'ok'); reload();
    } }] });
  }));
}
