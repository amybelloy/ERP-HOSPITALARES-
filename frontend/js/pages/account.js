// Conta do atendimento em 3 etapas:
//   1. Lançamento da conta (atendimento + itens lançados)
//   2. Dados da conta / quitação (seleção da conta, pagamentos, histórico)
//   3. Nota fiscal (dados para emissão e em nome de quem sai a nota)
import { api } from '../api.js';
import { html, render, $, $$, on, money, date, datetime, badge, label, table, modal, toast, showError, busy, toCents, formDialog, cpf, fresh, markErrors } from '../ui.js';
import { can } from '../state.js';
import { demoBanner } from '../components.js';
import { openReceive, openPaymentFlow, openConfer, openRefund, openReassign, openReceipt } from '../payments.js';

// ------------------------------------------------------------------ lista de contas
export async function accounts(host, { params }) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Conta do atendimento</h1><div class="muted">Localize a conta pelo número, atendimento ou paciente</div></div></div>
    <div class="card"><div class="filters">
      <div><label>Nº da conta</label><input data-f="account_number"></div><div><label>Nº do atendimento</label><input data-f="appointment_number"></div>
      <div><label>Paciente</label><input data-f="patient"></div><div><button class="btn" data-load>Pesquisar</button></div></div></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const f = {}; el.querySelectorAll('[data-f]').forEach((i) => { f[i.dataset.f] = i.value.trim(); });
    const rows = await api.get('/accounts', { ...f, limit: 100 });
    render($('[data-list]', el), table([
      { label: 'Conta', render: (a) => html`<a href="#/contas/${a.id}"><strong>${a.number}</strong></a>` },
      { label: 'Atendimento', render: (a) => html`${a.appointment_number}<div class="small muted">${datetime(a.opened_at)}</div>` },
      { label: 'Paciente', key: 'patient_name' }, { label: 'Procedimentos', render: (a) => a.procedures || '—' },
      { label: 'Total', class: 'money', render: (a) => money(a.total_cents) }, { label: 'Saldo', class: 'money', render: (a) => money(a.balance_cents) },
      { label: 'Financeiro', render: (a) => badge(a.financial_status) }, { label: 'Fiscal', render: (a) => badge(a.fiscal_status) },
      { label: '', render: (a) => html`<div class="btn-group"><a class="btn sm" href="#/contas/${a.id}?etapa=lancamento">Lançamento</a><a class="btn sm" href="#/contas/${a.id}?etapa=quitacao">Quitação</a><a class="btn sm" href="#/contas/${a.id}?etapa=nota">Nota fiscal</a></div>` },
    ], rows));
  };
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
  if (params.receipt) openReceipt(params.receipt).catch(showError);
}

// ------------------------------------------------------------------ detalhe em etapas
const STEPS = [
  { key: 'lancamento', n: 1, title: 'Lançamento da conta', sub: 'Atendimento e itens lançados' },
  { key: 'quitacao', n: 2, title: 'Dados da conta / Quitação', sub: 'Recebimentos e situação financeira' },
  { key: 'nota', n: 3, title: 'Nota fiscal', sub: 'Dados para emissão e tomador' },
];

const ro = (lbl, value, cls = '', strong = false) => html`<div class="${cls}"><label>${lbl}</label><div class="ro ${strong ? 'strong' : ''}" title="${value ?? ''}">${value ?? '—'}</div></div>`;
const hourOf = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');

export async function accountDetail(host, { args, params }) {
  const id = args[0];
  const step = STEPS.some((s) => s.key === params.etapa) ? params.etapa : 'lancamento';
  const go = (k) => { location.hash = `#/contas/${id}?etapa=${k}`; };
  const reload = () => accountDetail(host, { args, params }).catch(showError);
  const el = fresh(host);
  const a = await api.get(`/accounts/${id}`);
  const activeDoc = a.fiscal_documents.find((d) => !['REJEITADA', 'CANCELADA'].includes(d.status));
  const done = {
    lancamento: !!a.checked_at || a.billing_status !== 'ABERTA',
    quitacao: a.financial_status === 'QUITADA',
    nota: !!activeDoc && ['EMITIDA', 'EMITIDA_EXTERNAMENTE'].includes(activeDoc.status),
  };
  const stepSub = {
    lancamento: `${a.items.filter((i) => i.status === 'ATIVO').length} item(ns) · ${money(a.total_cents)}`,
    quitacao: `${label(a.financial_status)} · saldo ${money(a.balance_cents)}`,
    nota: label(a.fiscal_status),
  };
  render(el, html`
    ${a.payments.some((p) => p.is_demo) ? demoBanner('Esta conta possui pagamentos de DEMONSTRAÇÃO (provedor simulado). Nenhum valor real foi movimentado.') : ''}
    <div class="page-head"><div><h1>Conta ${a.number} · ${a.patient_name}</h1>
      <div class="muted">Atendimento <strong>${a.appointment_number}</strong> · Prontuário ${a.record_number} · ${label(a.modality)}</div></div>
      <div class="row">${badge(a.financial_status)} ${badge(a.fiscal_status)} ${badge(a.billing_status)}</div></div>
    <nav class="stepper">${STEPS.map((s) => html`<button data-step="${s.key}" class="${s.key === step ? 'active' : ''} ${done[s.key] ? 'done' : ''}">
      <span class="n">${done[s.key] ? '✓' : s.n}</span><span><span class="t">${s.title}</span><br><span class="s">${stepSub[s.key] || s.sub}</span></span></button>`)}</nav>
    <div data-step-body></div>`);
  on(el, 'click', '[data-step]', (e, b) => go(b.dataset.step));
  const body = $('[data-step-body]', el);
  if (step === 'lancamento') await stepLaunch(body, a, { reload, go });
  else if (step === 'quitacao') await stepSettlement(body, a, { reload, go });
  else await stepInvoice(body, a, { reload, go });
}

// ------------------------------------------------------------------ ETAPA 1 — Lançamento da conta
async function stepLaunch(el, a, { reload, go }) {
  const editable = !['QUITADA', 'CANCELADA'].includes(a.financial_status) && a.billing_status === 'ABERTA' && a.appointment_status !== 'CANCELADO';
  const active = a.items.filter((i) => i.status === 'ATIVO');
  const groupTotals = {};
  active.forEach((i) => { const g = i.procedure_group || 'OUTROS'; groupTotals[g] = (groupTotals[g] || 0) + i.total_cents; });
  render(el, html`
    <div class="card"><div class="section-title">Atendimento</div>
      <div class="ficha">
        ${ro('Atendimento', a.appointment_number, '', true)}
        ${ro('Paciente', a.patient_name, 'c6', true)}
        ${ro('Dt. atend.', date(a.opened_at))}
        ${ro('Hr. atend.', hourOf(a.opened_at), 'c1')}
        ${ro('Status', label(a.appointment_status), 'c1')}
        ${ro('Convênio', a.modality === 'CONVENIO' ? a.insurance_name : 'PARTICULAR', 'c4')}
        ${ro('Carteira', a.insurance_card_number || '—')}
        ${ro('Prontuário', a.record_number)}
        ${ro('Cód. paciente', a.patient_code)}
        ${ro('Conta', a.number, '', true)}
        ${ro('Tipo', label(a.type))}
        ${ro('Setor', a.sector, 'c3')}
        ${ro('Prestador responsável', a.professional_name || '—', 'c4')}
        ${ro('Aberto por', a.opened_by_name || '—', 'c3')}
        <div class="c2"><label>Fecha conta?</label><div class="ro"><input type="checkbox" data-close-account ${a.billing_status !== 'ABERTA' ? 'checked' : ''} ${can('billing.manage') && a.financial_status !== 'CANCELADA' ? '' : 'disabled'}> ${label(a.billing_status)}</div></div>
        ${a.appointment_notes ? ro('Observações', a.appointment_notes, 'c12') : ''}
      </div></div>

    <div class="card"><div class="row between"><div class="section-title">Itens lançados</div><div class="small muted">Clique em um item para ver os detalhes</div></div>
      ${a.items.length ? html`<div class="table-wrap"><table class="grid-items"><thead><tr>
          <th>Grupo</th><th>Proced.</th><th>Descrição</th><th class="right">Qtde</th><th class="money">Vl. unit.</th><th class="money">Desc.</th><th class="money">Acrésc.</th>
          <th>Setor</th><th>Prestador</th><th class="money">Valor</th><th></th></tr></thead>
        <tbody>${a.items.map((i, idx) => html`<tr data-row="${idx}" class="${i.status === 'CANCELADO' ? 'cancelled' : ''}">
          <td>${i.procedure_group || '—'}</td><td>${i.procedure_code || '—'}</td><td>${i.description}${i.price_overridden || i.discount_cents || i.surcharge_cents ? html` <span class="badge warn">ajuste</span>` : ''}</td>
          <td class="right">${i.quantity}</td><td class="money">${money(i.unit_price_cents)}</td><td class="money">${i.discount_cents ? money(i.discount_cents) : '—'}</td>
          <td class="money">${i.surcharge_cents ? money(i.surcharge_cents) : '—'}</td><td>${i.item_sector || '—'}</td><td>${i.professional_name || '—'}</td>
          <td class="money">${money(i.total_cents)}</td>
          <td>${editable && i.status === 'ATIVO' && can('accounts.remove_item') ? html`<button class="btn sm danger" data-rm-item="${i.id}">Remover</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<div class="empty">Nenhum procedimento lançado.</div>`}
      <div class="ficha mt" data-item-detail>${itemDetail(a.items.find((i) => i.status === 'ATIVO') || a.items[0], a)}</div>
      <div class="ficha mt">
        ${Object.entries(groupTotals).map(([g, v]) => ro(`Grupo ${g}`, money(v)))}
        ${ro('Descontos', money(active.reduce((s, i) => s + i.discount_cents, 0)))}
        ${ro('Acréscimos', money(active.reduce((s, i) => s + i.surcharge_cents, 0)))}
        ${ro('Valor total da conta', money(a.total_cents), '', true)}
        ${ro('Conferência', a.checked_at ? `Conferida por ${a.checked_by_name} em ${datetime(a.checked_at)}` : 'Não conferida', 'c4')}
      </div>
      <div class="toolbar">
        ${editable && can('accounts.edit_items') ? html`<button class="btn" data-add>+ Lançar procedimento</button>` : ''}
        ${can('accounts.check') && a.financial_status !== 'CANCELADA' && a.total_cents > 0 ? html`<button class="btn" data-check>Conferir conta</button>` : ''}
        <button class="btn" data-print>Simular conta / demonstrativo</button>
        <button class="btn" data-hist>Histórico da conta</button>
        <span class="grow"></span>
        <button class="btn primary" data-next>Próximo: dados da conta / quitação →</button>
      </div>
      ${a.financial_status === 'QUITADA' ? html`<p class="small muted">Conta quitada: itens bloqueados. Correções exigem estorno auditável.</p>` : ''}
    </div>`);

  on(el, 'click', '[data-row]', (e, tr) => {
    if (e.target.closest('button')) return;
    $$('[data-row]', el).forEach((r) => r.classList.toggle('selected', r === tr));
    render($('[data-item-detail]', el), itemDetail(a.items[Number(tr.dataset.row)], a));
  });
  $('[data-row]', el)?.classList.add('selected');
  on(el, 'click', '[data-next]', () => go('quitacao'));
  on(el, 'click', '[data-print]', () => printStatement(a));
  on(el, 'click', '[data-hist]', () => openSettlementHistory(a.id).catch(showError));
  on(el, 'click', '[data-check]', (e, b) => busy(b, async () => { await api.post(`/accounts/${a.id}/check`); toast('Conta conferida.', 'ok'); reload(); }));
  on(el, 'change', '[data-close-account]', async (e, cb) => {
    try { await api.post(`/accounts/${a.id}/billing`, { status: cb.checked ? 'FECHADA' : 'ABERTA' }); toast(cb.checked ? 'Conta fechada.' : 'Conta reaberta para lançamentos.', 'ok'); reload(); } catch (err) { cb.checked = !cb.checked; showError(err); }
  });
  on(el, 'click', '[data-rm-item]', (e, b) => formDialog({
    title: 'Remover item da conta', intro: html`<div class="alert warn">O item não é apagado: fica registrado como cancelado, com motivo e usuário.</div>`,
    fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }], submit: 'Cancelar item',
    onSubmit: async (v) => { await api.post(`/accounts/${a.id}/items/${b.dataset.rmItem}/cancel`, { reason: v.reason }); toast('Item cancelado.', 'ok'); reload(); },
  }));
  on(el, 'click', '[data-add]', () => addItemDialog(a, reload).catch(showError));
}

function itemDetail(i, a) {
  if (!i) return html``;
  return html`${ro('Grupo de faturamento', i.procedure_group || '—', 'c3')}${ro('Procedimento', `${i.procedure_code || ''} ${i.description}`, 'c5')}
    ${ro('Valor do item', money(i.total_cents), '', true)}${ro('Situação', label(i.status === 'ATIVO' ? 'ATIVO' : 'CANCELADO'))}
    ${ro('Prestador', i.professional_name || a.professional_name || '—', 'c3')}${ro('Setor / setor exec.', i.item_sector || a.sector, 'c3')}
    ${ro('Lançado por', `${i.created_by_name} · ${datetime(i.created_at)}`, 'c3')}${ro('Ajuste / motivo', i.adjustment_reason || i.cancel_reason || '—', 'c3')}`;
}

async function addItemDialog(a, reload) {
  const procs = await api.get('/procedures', { active: 'true' });
  const adjust = can('accounts.adjust_price');
  formDialog({
    title: 'Lançar procedimento', wide: true,
    fields: [
      { name: 'procedure_id', label: 'Procedimento', type: 'select', required: true, span2: true, options: [{ value: '', label: 'Selecione…' }, ...procs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name} (${money(p.price_cents)})` }))] },
      { name: 'quantity', label: 'Quantidade', type: 'number', value: 1 },
      ...(adjust ? [
        { name: 'unit_price', label: 'Valor unitário (vazio = tabela)', placeholder: 'tabela' },
        { name: 'discount', label: 'Desconto (R$)' }, { name: 'surcharge', label: 'Acréscimo (R$)' },
        { name: 'adjustment_reason', label: 'Justificativa do ajuste', type: 'textarea', full: true },
      ] : []),
    ],
    intro: adjust ? null : html`<div class="alert info small">O valor é preenchido pelo cadastro do procedimento. Ajustes exigem perfil autorizado.</div>`,
    submit: 'Lançar',
    onSubmit: async (v) => {
      const body = { procedure_id: v.procedure_id, quantity: v.quantity };
      if (adjust) {
        if (v.unit_price) body.unit_price_cents = toCents(v.unit_price);
        if (v.discount) body.discount_cents = toCents(v.discount);
        if (v.surcharge) body.surcharge_cents = toCents(v.surcharge);
        body.adjustment_reason = v.adjustment_reason;
      }
      await api.post(`/accounts/${a.id}/items`, body); toast('Procedimento lançado.', 'ok'); reload();
    },
  });
}

// ------------------------------------------------------------------ ETAPA 2 — Dados da conta / Quitação
async function stepSettlement(el, a, { reload, go }) {
  const [others, hist] = await Promise.all([
    api.get('/accounts', { patient_id: a.patient_id, limit: 50 }).catch(() => []),
    can('settlement.view') ? api.get(`/accounts/${a.id}/settlement`) : Promise.resolve({ settlements: [], transactions: [] }),
  ]);
  render(el, html`
    <div class="card"><div class="section-title">Contas do paciente — selecione a conta</div>
      <div class="table-wrap"><table class="grid-items"><thead><tr><th>Conta</th><th>Atendimento</th><th>Data</th><th>Procedimentos</th><th class="money">Total</th><th class="money">Recebido</th><th class="money">Saldo</th><th>Financeiro</th><th>Fiscal</th></tr></thead>
        <tbody>${others.map((o) => html`<tr data-acc="${o.id}" class="${o.id === a.id ? 'current' : ''}"><td>${o.number}</td><td>${o.appointment_number}</td><td>${date(o.opened_at)}</td><td>${o.procedures || '—'}</td>
          <td class="money">${money(o.total_cents)}</td><td class="money">${money(o.received_cents)}</td><td class="money">${money(o.balance_cents)}</td><td>${badge(o.financial_status)}</td><td>${badge(o.fiscal_status)}</td></tr>`)}</tbody></table></div></div>

    <div class="card"><div class="section-title">Dados da conta ${a.number}</div>
      <div class="totals">
        <div class="t"><div class="l">Valor total</div><div class="v">${money(a.total_cents)}</div></div>
        <div class="t"><div class="l">Total recebido</div><div class="v">${money(a.received_cents)}</div></div>
        <div class="t balance ${a.balance_cents === 0 && a.total_cents > 0 ? 'zero' : ''}"><div class="l">Saldo devedor</div><div class="v">${money(a.balance_cents)}</div></div>
        <div class="t"><div class="l">Status financeiro</div><div class="v small">${badge(a.financial_status)}</div><div class="small muted">${a.settled_at ? `Quitada em ${datetime(a.settled_at)}` : ''}</div></div>
        <div class="t"><div class="l">Status fiscal</div><div class="v small">${badge(a.fiscal_status)}</div><div class="small muted">independente da quitação</div></div>
      </div>
      <div class="toolbar">
        ${can('payments.receive') && ['PENDENTE', 'PARCIAL'].includes(a.financial_status) && a.total_cents > 0 ? html`<button class="btn primary" data-receive>Receber</button>` : ''}
        <button class="btn" data-back>← Lançamento</button>
        <span class="grow"></span>
        <button class="btn primary" data-next>Próximo: nota fiscal →</button>
      </div></div>

    <div class="card"><div class="section-title">Pagamentos</div>${paymentsTable(a)}</div>
    ${can('settlement.view') ? html`<div class="card"><div class="section-title">Histórico da quitação</div>
      ${table([{ label: 'Data', render: (s) => datetime(s.created_at) }, { label: 'Evento', key: 'event' }, { label: 'De → Para', render: (s) => html`${badge(s.previous_status)} → ${badge(s.new_status)}` },
        { label: 'Recebido', class: 'money', render: (s) => money(s.received_cents) }, { label: 'Saldo', class: 'money', render: (s) => money(s.balance_cents) },
        { label: 'Origem da confirmação', render: (s) => label(s.source) }, { label: 'Usuário', render: (s) => s.user_name || 'sistema (provedor)' }], hist.settlements, { empty: 'Nenhuma movimentação financeira ainda.' })}</div>` : ''}`);

  on(el, 'click', '[data-acc]', (e, tr) => { location.hash = `#/contas/${tr.dataset.acc}?etapa=quitacao`; });
  on(el, 'click', '[data-next]', () => go('nota'));
  on(el, 'click', '[data-back]', () => go('lancamento'));
  on(el, 'click', '[data-receive]', () => openReceive(a, reload));
  on(el, 'click', '[data-flow]', (e, b) => openPaymentFlow(b.dataset.flow, reload).catch(showError));
  const find = (v) => a.payments.find((p) => String(p.id) === v);
  on(el, 'click', '[data-confer]', (e, b) => openConfer(find(b.dataset.confer), reload));
  on(el, 'click', '[data-refund]', (e, b) => openRefund(find(b.dataset.refund), reload));
  on(el, 'click', '[data-reassign]', (e, b) => openReassign(find(b.dataset.reassign), reload));
  on(el, 'click', '[data-receipt]', (e, b) => openReceipt(b.dataset.receipt).catch(showError));
}

function paymentsTable(a) {
  return table([
    { label: '#', key: 'id' },
    { label: 'Forma', render: (p) => html`${label(p.method)}${p.installments > 1 ? ` ${p.installments}x` : ''}${p.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}<div class="small muted">${p.provider}</div>` },
    { label: 'Valor', class: 'money', render: (p) => html`${money(p.amount_cents)}${p.refunded_cents ? html`<div class="small">estornado ${money(p.refunded_cents)}</div>` : ''}` },
    { label: 'Status', render: (p) => html`${badge(p.status)}${p.status_reason ? html`<div class="small muted">${p.status_reason}</div>` : ''}` },
    { label: 'Confirmação', render: (p) => (p.confirmed_at ? html`<span class="small">${label(p.confirmation_source)}<br>${datetime(p.confirmed_at)}</span>` : '—') },
    { label: 'Registrado por', render: (p) => html`<span class="small">${p.created_by_name}${p.conferred_by_name ? html`<br>conferido: ${p.conferred_by_name}` : ''}</span>` },
    { label: '', render: (p) => html`<div class="btn-group">
      ${['PENDENTE', 'PROCESSANDO'].includes(p.status) ? html`<button class="btn sm" data-flow="${p.id}">Acompanhar</button>` : ''}
      ${p.status === 'AGUARDANDO_CONFERENCIA' && can('payments.confer') ? html`<button class="btn sm primary" data-confer="${p.id}">Conferir</button>` : ''}
      ${['CONFIRMADO', 'ESTORNADO_PARCIAL', 'ESTORNADO'].includes(p.status) ? html`<button class="btn sm" data-receipt="${p.id}">Comprovante</button>` : ''}
      ${['CONFIRMADO', 'ESTORNADO_PARCIAL'].includes(p.status) && can('payments.refund') ? html`<button class="btn sm danger" data-refund="${p.id}">Estornar</button>` : ''}
      ${p.status === 'CONFIRMADO' && !p.refunded_cents && can('payments.reassign') ? html`<button class="btn sm" data-reassign="${p.id}">Reatribuir</button>` : ''}
    </div>` },
  ], a.payments, { empty: 'Nenhum pagamento registrado.' });
}

// ------------------------------------------------------------------ ETAPA 3 — Nota fiscal
const UFS = ['', 'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

function takerFields(t, editable) {
  const dis = editable ? '' : 'readonly';
  const inp = (name, value, extra = '') => html`<input name="${name}" value="${value ?? ''}" ${dis} ${extra}>`;
  return html`
    <div class="c2" data-field="personType"><label>Tipo pessoa</label><select name="personType" ${editable ? '' : 'disabled'}><option value="F" ${t.personType !== 'J' ? 'selected' : ''}>Física</option><option value="J" ${t.personType === 'J' ? 'selected' : ''}>Jurídica</option></select></div>
    <div class="c6" data-field="name"><label>Nome do cliente (tomador) *</label>${inp('name', t.name)}</div>
    <div class="c4" data-field="document"><label data-doc-label>${t.personType === 'J' ? 'CNPJ' : 'CPF'} *</label>${inp('document', t.personType === 'J' ? t.cnpj : t.cpf)}</div>
    <div class="c6" data-field="address"><label>Endereço</label>${inp('address', t.address)}</div>
    <div class="c2" data-field="addressNumber"><label>Número</label>${inp('addressNumber', t.addressNumber)}</div>
    <div class="c4" data-field="district"><label>Bairro</label>${inp('district', t.district)}</div>
    <div class="c4" data-field="city"><label>Cidade</label>${inp('city', t.city)}</div>
    <div class="c2" data-field="cityIbgeCode"><label>Cód. IBGE</label>${inp('cityIbgeCode', t.cityIbgeCode)}</div>
    <div class="c1" data-field="state"><label>UF</label><select name="state" ${editable ? '' : 'disabled'}>${UFS.map((u) => html`<option value="${u}" ${u === (t.state || '') ? 'selected' : ''}>${u || '—'}</option>`)}</select></div>
    <div class="c2" data-field="zipCode"><label>CEP</label>${inp('zipCode', t.zipCode)}</div>
    <div class="c3" data-field="phone"><label>Telefone</label>${inp('phone', t.phone)}</div>
    <div class="c4" data-field="email"><label>E-mail do cliente</label>${inp('email', t.email, 'type="email"')}</div>
    <div class="c3" data-field="municipalRegistration"><label>Nr. inscrição municipal</label>${inp('municipalRegistration', t.municipalRegistration)}</div>`;
}

function readTaker(form) {
  const v = (n) => { const x = form.querySelector(`[name=${n}]`); return x && x.value.trim() !== '' ? x.value.trim() : null; };
  return { personType: v('personType'), name: v('name'), document: v('document'), address: v('address'), addressNumber: v('addressNumber'),
    district: v('district'), city: v('city'), cityIbgeCode: v('cityIbgeCode'), state: v('state'), zipCode: v('zipCode'), phone: v('phone'),
    email: v('email'), municipalRegistration: v('municipalRegistration') };
}

function taxBar(t, amount) {
  const x = t || { discountCents: 0, surchargeCents: 0, baseCents: amount, issCents: 0, irCents: 0, ibsCents: 0, cbsCents: 0, subtotalCents: amount, totalCents: amount };
  return html`<div class="taxbar ficha">
    ${ro('Valor desconto', money(x.discountCents))}${ro('Valor acréscimo', money(x.surchargeCents))}${ro('Base de cálculo', money(x.baseCents))}
    ${ro('Vl. ISS', money(x.issCents))}${ro('Vl. IR', money(x.irCents))}${ro('Vl. IBS', money(x.ibsCents))}${ro('Vl. CBS', money(x.cbsCents))}
    ${ro('Subtotal', money(x.subtotalCents))}${ro('Total da NF', money(x.totalCents), '', true)}</div>`;
}

async function stepInvoice(el, a, { reload, go }) {
  if (!can('fiscal.view')) { render(el, html`<div class="card"><div class="alert danger">Seu perfil não tem acesso ao módulo fiscal.</div></div>`); return; }
  const pv = await api.get(`/fiscal/accounts/${a.id}/preview`);
  const docs = await api.get('/fiscal/documents', { account_id: a.id });
  const activeRow = docs.find((d) => !['REJEITADA', 'CANCELADA'].includes(d.status));
  const doc = activeRow ? await api.get(`/fiscal/documents/${activeRow.id}`) : null;
  const manage = can('fiscal.manage');
  const editable = manage && (!doc || doc.status === 'PREPARADA');
  const taker = doc ? doc.taker : pv.taker;
  const isPatient = doc ? doc.taker_is_patient : true;
  const svc = doc ? doc.service : pv.service;
  const demo = doc ? doc.is_demo : pv.integration_demo;
  const items = pv.items;

  render(el, html`
    ${demo ? html`<div class="demo-banner">⚠ Emissão em DEMONSTRAÇÃO: nada é transmitido à prefeitura/Ambiente Nacional e nenhuma NFS-e oficial é gerada.</div>` : ''}
    ${!pv.eligible && !doc ? html`<div class="alert warn mb">A conta está <strong>${label(a.financial_status)}</strong>. A política fiscal exige conta quitada para emitir a nota. <a href="#/contas/${a.id}?etapa=quitacao">Ir para a quitação</a>.</div>` : ''}
    ${Object.keys(pv.errors || {}).length && !doc ? html`<div class="alert danger mb">${Object.values(pv.errors).join(' ')}</div>` : ''}
    <div class="card"><div class="nf-layout"><form data-nf class="stack">
      <div class="section-title">Nota fiscal de serviço</div>
      <div class="ficha">
        ${ro('Nr. nota (DPS)', doc ? doc.dps_number : 'gerado ao gravar', '', true)}
        ${ro('Série', doc ? doc.dps_series : '1', 'c1')}
        ${ro('Dt. emissão', doc?.processed_at ? date(doc.processed_at) : '—')}
        ${ro('Cód. pac.', pv.patient.code)}
        ${ro('Atendimento', a.appointment_number)}
        ${ro('Conta', a.number)}
        ${ro('Modo', doc ? label(doc.mode) : '—', 'c2')}
      </div>
      <div class="section-title mt">Em nome de quem sai a nota</div>
      <div class="taker-choice">
        <label><input type="radio" name="takerKind" value="patient" ${isPatient ? 'checked' : ''} ${editable ? '' : 'disabled'}> Paciente (${pv.patient.name})</label>
        <label><input type="radio" name="takerKind" value="other" ${isPatient ? '' : 'checked'} ${editable ? '' : 'disabled'}> Outra pessoa ou empresa (responsável financeiro, empregador, convênio…)</label>
      </div>
      <div class="ficha" data-taker>${takerFields(taker, editable)}</div>
      <div class="section-title mt">Serviço</div>
      <div class="ficha">
        ${ro('CNAE', svc.cnae || pv.provider_data.cnae || '—')}
        ${ro('Nat. serviço (LC 116)', svc.serviceListItem || '—')}
        ${ro('Cód. tributação nacional', svc.nationalTaxCode || '—')}
        ${ro('Alíquota ISS', svc.issRateBp != null ? `${(svc.issRateBp / 100).toFixed(2)}%` : '—', 'c2')}
        ${ro('Prestador', `${pv.provider_data.name || '—'} · CNPJ ${pv.provider_data.cnpj || '—'}`, 'c4')}
        <div class="c12"><label>Observações</label><textarea name="observations" ${editable ? '' : 'readonly'}>${doc?.observations || ''}</textarea></div>
      </div>
      <div class="table-wrap mt"><table class="grid-items"><thead><tr><th>Grupo de fat.</th><th>Descrição</th><th class="right">Qtde</th><th class="money">Valor total</th></tr></thead>
        <tbody>${items.map((i) => html`<tr><td>${i.group || '—'}</td><td>${i.code || ''} ${i.description}</td><td class="right">${i.quantity}</td><td class="money">${money(i.total_cents)}</td></tr>`)}</tbody></table></div>
      <div class="mt">${taxBar(doc ? svc.taxes : pv.taxes, a.total_cents)}</div>
      <div class="section-title mt">Retorno da NFS-e</div>
      <div class="ficha">
        ${ro('Número da NFS-e', doc?.nfse_number || '—', 'c3', true)}
        ${ro('Código de verificação / chave', doc?.access_key || doc?.verification_code || '—', 'c6')}
        ${ro('Situação da nota', doc ? label(doc.status) : 'Não solicitada', 'c3', true)}
        ${doc?.rejection_reason ? ro('Motivo', doc.rejection_reason, 'c12') : ''}
      </div>
    </form>

    <aside class="side-actions">
      <div class="section-title">Ações</div>
      ${!doc && manage ? html`
        <label class="small">Forma de emissão</label>
        <select data-mode><option value="INTEGRACAO" ${pv.default_mode !== 'EXPORTACAO' ? 'selected' : ''}>Emitir NFS-e por integração${pv.integration_demo ? ' (demo)' : ''}</option><option value="EXPORTACAO" ${pv.default_mode === 'EXPORTACAO' ? 'selected' : ''}>Só preparar dados p/ outro sistema</option></select>
        <button class="btn primary" data-prepare-emit ${pv.eligible ? '' : 'disabled'}>Gravar e emitir</button>
        <button class="btn" data-prepare ${pv.eligible ? '' : 'disabled'}>Somente gravar (conferir depois)</button>` : ''}
      ${doc && doc.status === 'PREPARADA' && manage ? html`<button class="btn" data-save>Gravar alterações</button><button class="btn primary" data-submit>${doc.mode === 'EXPORTACAO' ? 'Gerar exportação' : 'Emitir nota fiscal'}</button>` : ''}
      ${doc && doc.status === 'FALHA_COMUNICACAO' && manage ? html`<button class="btn primary" data-submit>Reenviar</button>` : ''}
      ${doc && ['ENVIADA', 'PROCESSANDO'].includes(doc.status) ? html`<button class="btn primary" data-check>Consultar resultado</button>` : ''}
      ${doc ? html`<button class="btn" data-print-nf>Imprimir nota fiscal</button>` : ''}
      ${doc && manage && ['PREPARADA', 'EXPORTADA', 'EMITIDA_EXTERNAMENTE'].includes(doc.status) ? html`<a class="btn" href="/api/fiscal/documents/${doc.id}/export?format=xml">Baixar XML (DPS)</a>` : ''}
      ${doc && manage && doc.status === 'EXPORTADA' ? html`<button class="btn" data-ext>Registrar nº emitido externamente</button>` : ''}
      ${doc && can('fiscal.cancel') && ['EMITIDA', 'EMITIDA_EXTERNAMENTE', 'PREPARADA', 'EXPORTADA'].includes(doc.status) ? html`<button class="btn danger" data-cancel>Cancelar nota fiscal</button>` : ''}
      <button class="btn" disabled title="A NFS-e não admite carta de correção: use cancelamento e nova emissão">Carta de correção</button>
      <hr>
      <button class="btn" data-back>← Dados da conta / quitação</button>
      ${docs.length > (doc ? 1 : 0) ? html`<div class="section-title mt">Documentos anteriores</div>${docs.filter((d) => d.id !== doc?.id).map((d) => html`<div class="small">#${d.id} ${badge(d.status)} ${d.taker_name}</div>`)}` : ''}
    </aside></div></div>`);

  const form = $('[data-nf]', el);
  const takerBox = $('[data-taker]', el);
  // Troca paciente/outro: paciente preenche com o cadastro; "outro" limpa para digitar
  on(form, 'change', '[name=takerKind]', (e, r) => {
    render(takerBox, takerFields(r.value === 'patient' ? pv.taker : { personType: 'F' }, editable));
  });
  on(form, 'change', '[name=personType]', (e, s) => { $('[data-doc-label]', form).textContent = `${s.value === 'J' ? 'CNPJ' : 'CPF'} *`; });
  const payload = () => ({ taker: readTaker(form), observations: form.querySelector('[name=observations]').value.trim() || null });
  const prepare = async (emit, btn) => busy(btn, async () => {
    $$('.field-error', form).forEach((x) => x.remove());
    try {
      const d = await api.post(`/fiscal/accounts/${a.id}/prepare`, { ...payload(), mode: $('[data-mode]', el).value });
      if (emit) {
        const r = await api.post(`/fiscal/documents/${d.id}/submit`);
        toast(`Nota: ${label(r.status)}${r.is_demo ? ' (DEMONSTRAÇÃO — sem validade fiscal)' : ''}`, ['REJEITADA', 'FALHA_COMUNICACAO'].includes(r.status) ? 'error' : 'ok');
      } else toast('Dados da nota gravados.', 'ok');
      reload();
    } catch (err) { markErrors(form, err); throw err; }
  });
  on(el, 'click', '[data-prepare-emit]', (e, b) => prepare(true, b));
  on(el, 'click', '[data-prepare]', (e, b) => prepare(false, b));
  on(el, 'click', '[data-save]', (e, b) => busy(b, async () => {
    try { await api.put(`/fiscal/documents/${doc.id}`, payload()); toast('Alterações gravadas.', 'ok'); reload(); } catch (err) { markErrors(form, err); throw err; }
  }));
  on(el, 'click', '[data-submit]', (e, b) => busy(b, async () => {
    if (doc.status === 'PREPARADA' && editable) await api.put(`/fiscal/documents/${doc.id}`, payload());
    const r = await api.post(`/fiscal/documents/${doc.id}/submit`);
    toast(`Nota: ${label(r.status)}${r.is_demo ? ' (DEMONSTRAÇÃO)' : ''}`, ['REJEITADA', 'FALHA_COMUNICACAO'].includes(r.status) ? 'error' : 'ok'); reload();
  }));
  on(el, 'click', '[data-check]', (e, b) => busy(b, async () => { const r = await api.post(`/fiscal/documents/${doc.id}/check`); toast(`Situação: ${label(r.status)}`); reload(); }));
  on(el, 'click', '[data-ext]', () => formDialog({ title: 'Registrar emissão realizada em outro sistema',
    fields: [{ name: 'nfse_number', label: 'Número da NFS-e', required: true }, { name: 'verification_code', label: 'Código de verificação' }, { name: 'official_url', label: 'Link oficial (https://…)', full: true }],
    onSubmit: async (v) => { await api.post(`/fiscal/documents/${doc.id}/external`, v); toast('Emissão externa registrada.', 'ok'); reload(); } }));
  on(el, 'click', '[data-cancel]', () => formDialog({ title: 'Cancelar nota fiscal', intro: html`<div class="alert warn">Para NFS-e emitida, o cancelamento é enviado ao serviço fiscal e segue as regras do município/Ambiente Nacional.</div>`,
    fields: [{ name: 'reason', label: 'Justificativa (mín. 15 caracteres)', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/fiscal/documents/${doc.id}/cancel`, v); toast('Nota cancelada.', 'ok'); reload(); } }));
  on(el, 'click', '[data-print-nf]', () => printInvoice(doc, a, items));
  on(el, 'click', '[data-back]', () => go('quitacao'));
}

function printInvoice(d, a, items) {
  const t = d.taker; const x = d.service.taxes || {};
  const official = ['EMITIDA', 'EMITIDA_EXTERNAMENTE'].includes(d.status) && !d.is_demo;
  modal({ title: 'Nota fiscal de serviço', wide: true, body: html`<div class="print-area print-doc">
    <div class="doc-title">${official ? 'ESPELHO DA NFS-e' : 'PRÉVIA DA NOTA FISCAL DE SERVIÇO'}</div>
    ${d.is_demo ? html`<div class="watermark">DEMONSTRAÇÃO — SEM VALIDADE FISCAL</div>` : ''}
    ${!official ? html`<div class="disclaimer">Documento informativo. ${d.status === 'EXPORTADA' ? 'Dados preparados para emissão em outro sistema.' : 'A NFS-e oficial é o documento autorizado pelo serviço fiscal.'}</div>` : html`<div class="disclaimer">A via oficial (DANFSe) deve ser obtida no portal/serviço fiscal${d.official_url ? ` — ${d.official_url}` : ''}.</div>`}
    <dl class="kv"><dt>Prestador</dt><dd>${d.provider_data.name} · CNPJ ${d.provider_data.cnpj} · IM ${d.provider_data.municipalRegistration || '—'}</dd>
      <dt>Tomador</dt><dd>${t.name} · ${t.personType === 'J' ? `CNPJ ${t.cnpj}` : `CPF ${cpf(t.cpf)}`}</dd>
      <dt>Endereço</dt><dd>${[t.address, t.addressNumber, t.district, t.city, t.state, t.zipCode].filter(Boolean).join(', ') || '—'}</dd>
      <dt>E-mail</dt><dd>${t.email || '—'}</dd>
      <dt>NFS-e / DPS</dt><dd>${d.nfse_number || '—'} · DPS ${d.dps_number} série ${d.dps_series} · ${label(d.status)}</dd>
      <dt>Verificação</dt><dd class="mono">${d.access_key || d.verification_code || '—'}</dd>
      <dt>Atendimento / conta</dt><dd>${a.appointment_number} · ${a.number}</dd>
      <dt>Serviço</dt><dd>LC 116 ${d.service.serviceListItem || '—'} · cTribNac ${d.service.nationalTaxCode || '—'} · CNAE ${d.service.cnae || '—'}</dd></dl>
    <table class="mt"><thead><tr><th>Descrição</th><th>Qtde</th><th class="money">Valor</th></tr></thead><tbody>${items.map((i) => html`<tr><td>${i.description}</td><td>${i.quantity}</td><td class="money">${money(i.total_cents)}</td></tr>`)}</tbody></table>
    <table class="mt"><tbody><tr><th>Base de cálculo</th><td class="money">${money(x.baseCents ?? d.amount_cents)}</td><th>ISS</th><td class="money">${money(x.issCents || 0)}</td><th>IR</th><td class="money">${money(x.irCents || 0)}</td></tr>
      <tr><th>IBS</th><td class="money">${money(x.ibsCents || 0)}</td><th>CBS</th><td class="money">${money(x.cbsCents || 0)}</td><th>Total da NF</th><td class="money"><strong>${money(d.amount_cents)}</strong></td></tr></tbody></table>
    ${d.observations ? html`<p><strong>Observações:</strong> ${d.observations}</p>` : ''}
  </div>`, actions: [{ label: 'Fechar' }, { label: 'Imprimir', class: 'primary', closes: false, onClick: () => { window.print(); return false; } }] });
}

// ------------------------------------------------------------------ compartilhados
export async function openSettlementHistory(accountId) {
  const h = await api.get(`/accounts/${accountId}/settlement`);
  modal({ title: 'Histórico de quitação', wide: true, body: html`
    <h3>Mudanças de status financeiro</h3>
    ${table([{ label: 'Data', render: (s) => datetime(s.created_at) }, { label: 'Evento', key: 'event' }, { label: 'De → Para', render: (s) => html`${badge(s.previous_status)} → ${badge(s.new_status)}` },
      { label: 'Recebido', class: 'money', render: (s) => money(s.received_cents) }, { label: 'Saldo', class: 'money', render: (s) => money(s.balance_cents) },
      { label: 'Origem', render: (s) => label(s.source) }, { label: 'Usuário', render: (s) => s.user_name || 'sistema (provedor)' }], h.settlements, { empty: 'Sem eventos.' })}
    <h3 class="mt">Transações confirmadas (provedor / conferência)</h3>
    ${table([{ label: 'Data', render: (t) => datetime(t.occurred_at) }, { label: 'Tipo', key: 'kind' }, { label: 'Pagamento', key: 'payment_id' },
      { label: 'ID da transação', render: (t) => html`<span class="mono">${t.provider_transaction_id}</span>` }, { label: 'Valor', class: 'money', render: (t) => money(t.amount_cents) },
      { label: 'Status', key: 'status' }, { label: 'Origem', render: (t) => label(t.source) }], h.transactions, { empty: 'Sem transações.' })}` });
}

function printStatement(a) {
  modal({ title: 'Demonstrativo da conta', wide: true, body: html`<div class="print-area print-doc">
    <div class="doc-title">DEMONSTRATIVO DE CONTA — ${a.number}</div>
    <div class="disclaimer">Demonstrativo informativo. Não é documento fiscal nem comprovante de pagamento.</div>
    <dl class="kv"><dt>Paciente</dt><dd>${a.patient_name} · ${a.patient_code} · CPF ${cpf(a.patient_cpf)}</dd><dt>Prontuário</dt><dd>${a.record_number}</dd>
      <dt>Atendimento</dt><dd>${a.appointment_number} · ${datetime(a.opened_at)}</dd><dt>Status</dt><dd>${label(a.financial_status)}</dd></dl>
    <table class="mt"><thead><tr><th>Grupo</th><th>Procedimento</th><th>Qtd</th><th class="money">Unitário</th><th class="money">Desc.</th><th class="money">Acrésc.</th><th class="money">Total</th></tr></thead>
      <tbody>${a.items.filter((i) => i.status === 'ATIVO').map((i) => html`<tr><td>${i.procedure_group || ''}</td><td>${i.description}</td><td>${i.quantity}</td><td class="money">${money(i.unit_price_cents)}</td><td class="money">${money(i.discount_cents)}</td><td class="money">${money(i.surcharge_cents)}</td><td class="money">${money(i.total_cents)}</td></tr>`)}</tbody></table>
    <table class="mt"><tbody><tr><th>Total da conta</th><td class="money">${money(a.total_cents)}</td></tr><tr><th>Total recebido</th><td class="money">${money(a.received_cents)}</td></tr><tr><th>Saldo devedor</th><td class="money"><strong>${money(a.balance_cents)}</strong></td></tr></tbody></table>
    <h3 class="mt">Pagamentos</h3>
    <table><tbody>${a.payments.map((p) => html`<tr><td>${label(p.method)}${p.is_demo ? ' (DEMONSTRAÇÃO)' : ''}</td><td>${label(p.status)}</td><td>${datetime(p.confirmed_at)}</td><td class="money">${money(p.amount_cents - p.refunded_cents)}</td></tr>`)}</tbody></table>
  </div>`, actions: [{ label: 'Fechar' }, { label: 'Imprimir', class: 'primary', closes: false, onClick: () => { window.print(); return false; } }] });
}
