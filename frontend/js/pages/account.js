import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, label, table, modal, toast, showError, busy, toCents, formDialog, cpf, fresh } from '../ui.js';
import { can } from '../state.js';
import { demoBanner } from '../components.js';
import { openReceive, openPaymentFlow, openConfer, openRefund, openReassign, openReceipt } from '../payments.js';

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
      { label: 'Status', render: (a) => badge(a.financial_status) },
    ], rows));
  };
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
  if (params.receipt) openReceipt(params.receipt).catch(showError);
}

function itemsTable(a, editable) {
  return table([
    { label: 'Código', render: (i) => i.procedure_code || '—' },
    { label: 'Procedimento', render: (i) => html`${i.description}${i.price_overridden || i.discount_cents || i.surcharge_cents ? html`<div class="small muted">Ajuste: ${i.adjustment_reason}</div>` : ''}${i.status === 'CANCELADO' ? html`<div class="small">Cancelado: ${i.cancel_reason}</div>` : ''}` },
    { label: 'Qtd', render: (i) => i.quantity },
    { label: 'Valor unitário', class: 'money', render: (i) => money(i.unit_price_cents) },
    { label: 'Desconto', class: 'money', render: (i) => (i.discount_cents ? money(i.discount_cents) : '—') },
    { label: 'Acréscimo', class: 'money', render: (i) => (i.surcharge_cents ? money(i.surcharge_cents) : '—') },
    { label: 'Total', class: 'money', render: (i) => money(i.total_cents) },
    { label: 'Lançado por', render: (i) => html`<span class="small">${i.created_by_name}<br>${datetime(i.created_at)}</span>` },
    { label: '', render: (i) => (editable && i.status === 'ATIVO' && can('accounts.remove_item') ? html`<button class="btn sm danger" data-rm-item="${i.id}">Remover item</button>` : '') },
  ], a.items, { empty: 'Nenhum procedimento lançado.', rowClass: (i) => (i.status === 'CANCELADO' ? 'cancelled' : '') });
}

function paymentsTable(a) {
  return table([
    { label: '#', render: (p) => html`<a role="button" tabindex="0" data-flow="${p.id}">${p.id}</a>` },
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

export async function accountDetail(host, { args }) {
  const el = fresh(host);
  const id = args[0];
  const reload = () => accountDetail(host, { args }).catch(showError);
  const a = await api.get(`/accounts/${id}`);
  const editable = !['QUITADA', 'CANCELADA'].includes(a.financial_status) && a.billing_status === 'ABERTA' && a.appointment_status !== 'CANCELADO';
  const hasDemo = a.payments.some((p) => p.is_demo);
  render(el, html`
    ${hasDemo ? demoBanner('Esta conta possui pagamentos de DEMONSTRAÇÃO (provedor simulado). Nenhum valor real foi movimentado.') : ''}
    <div class="page-head"><div><h1>Conta ${a.number}</h1>
      <div class="muted">Atendimento <strong>${a.appointment_number}</strong> · ${datetime(a.opened_at)} · ${label(a.type)} · ${a.sector} · ${label(a.modality)}${a.insurance_name ? ` (${a.insurance_name})` : ''}</div>
      <div class="muted">Paciente <a href="#/pacientes/${a.patient_id}">${a.patient_name}</a> · ${a.patient_code} · Prontuário ${a.record_number}${a.professional_name ? ` · ${a.professional_name}` : ''}</div></div>
      <div class="row">${badge(a.financial_status)} <span class="small muted">Fiscal:</span> ${badge(a.fiscal_status)} <span class="small muted">Faturamento:</span> ${badge(a.billing_status)}</div></div>

    <div class="card">
      <div class="totals">
        <div class="t"><div class="l">Valor total</div><div class="v">${money(a.total_cents)}</div></div>
        <div class="t"><div class="l">Total recebido</div><div class="v">${money(a.received_cents)}</div></div>
        <div class="t balance ${a.balance_cents === 0 && a.total_cents > 0 ? 'zero' : ''}"><div class="l">Saldo devedor</div><div class="v">${money(a.balance_cents)}</div></div>
        <div class="t"><div class="l">Status financeiro</div><div class="v small">${badge(a.financial_status)}</div><div class="small muted">${a.settled_at ? `Quitada em ${datetime(a.settled_at)}` : ''}</div></div>
        <div class="t"><div class="l">Conferência</div><div class="v small">${a.checked_at ? html`<span class="badge ok">Conferida</span>` : html`<span class="badge warn">Não conferida</span>`}</div><div class="small muted">${a.checked_at ? `${a.checked_by_name} · ${datetime(a.checked_at)}` : ''}</div></div>
      </div>
      <div class="btn-group mt">
        ${editable && can('accounts.edit_items') ? html`<button class="btn" data-add>+ Adicionar procedimento</button>` : ''}
        ${can('accounts.check') && a.financial_status !== 'CANCELADA' ? html`<button class="btn" data-check>Conferir conta</button>` : ''}
        ${can('payments.receive') && ['PENDENTE', 'PARCIAL'].includes(a.financial_status) && a.total_cents > 0 ? html`<button class="btn primary" data-receive>Receber</button>` : ''}
        <button class="btn" data-go="pay">Consultar pagamentos</button>
        ${can('settlement.view') ? html`<button class="btn" data-settlement>Consultar quitação</button>` : ''}
        ${can('fiscal.view') ? html`<button class="btn" data-go="fiscal">Consultar documentos fiscais</button>` : ''}
        <button class="btn" data-print>Imprimir demonstrativo</button>
      </div>
      ${a.financial_status === 'QUITADA' ? html`<p class="small muted">Conta quitada: itens bloqueados. Correções exigem estorno auditável.</p>` : ''}
    </div>

    <div class="card"><h2>Procedimentos lançados</h2>${itemsTable(a, editable)}</div>
    <div class="card" id="sec-pay"><h2>Pagamentos</h2>${paymentsTable(a)}</div>
    <div class="card" id="sec-fiscal"><h2>Documentos fiscais</h2>
      ${table([{ label: '#', key: 'id' }, { label: 'Modo', render: (d) => label(d.mode) }, { label: 'Status', render: (d) => html`${badge(d.status)}${d.is_demo ? html` <span class="badge demo">DEMO — sem validade fiscal</span>` : ''}` },
        { label: 'Número', render: (d) => d.nfse_number || '—' }, { label: 'Solicitado', render: (d) => datetime(d.requested_at) }], a.fiscal_documents, { empty: 'Nenhum documento fiscal. Status fiscal é independente da quitação.' })}
      ${can('fiscal.view') ? html`<a class="btn sm mt" href="#/fiscal">Ir para o módulo fiscal</a>` : ''}</div>`);

  on(el, 'click', '[data-add]', async () => {
    const procs = await api.get('/procedures', { active: 'true' });
    const adjust = can('accounts.adjust_price');
    formDialog({
      title: 'Adicionar procedimento', wide: true,
      fields: [
        { name: 'procedure_id', label: 'Procedimento', type: 'select', required: true, span2: true, options: [{ value: '', label: 'Selecione…' }, ...procs.map((p) => ({ value: p.id, label: `${p.code} — ${p.name} (${money(p.price_cents)})` }))] },
        { name: 'quantity', label: 'Quantidade', type: 'number', value: 1 },
        ...(adjust ? [
          { name: 'unit_price', label: 'Valor unitário (vazio = tabela)', placeholder: 'tabela' },
          { name: 'discount', label: 'Desconto (R$)' }, { name: 'surcharge', label: 'Acréscimo (R$)' },
          { name: 'adjustment_reason', label: 'Justificativa do ajuste', type: 'textarea', full: true },
        ] : []),
      ],
      intro: adjust ? null : html`<div class="alert info small">O valor será o do cadastro do procedimento. Ajustes exigem perfil autorizado.</div>`,
      submit: 'Lançar',
      onSubmit: async (v) => {
        const body = { procedure_id: v.procedure_id, quantity: v.quantity };
        if (adjust) {
          if (v.unit_price) body.unit_price_cents = toCents(v.unit_price);
          if (v.discount) body.discount_cents = toCents(v.discount);
          if (v.surcharge) body.surcharge_cents = toCents(v.surcharge);
          body.adjustment_reason = v.adjustment_reason;
        }
        await api.post(`/accounts/${id}/items`, body); toast('Procedimento lançado.', 'ok'); reload();
      },
    });
  });
  on(el, 'click', '[data-rm-item]', (e, b) => {
    formDialog({ title: 'Remover item da conta', intro: html`<div class="alert warn">O item não é apagado: fica registrado como cancelado, com motivo e usuário.</div>`,
      fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }], submit: 'Cancelar item',
      onSubmit: async (v) => { await api.post(`/accounts/${id}/items/${b.dataset.rmItem}/cancel`, { reason: v.reason }); toast('Item cancelado.', 'ok'); reload(); } });
  });
  on(el, 'click', '[data-check]', (e, b) => busy(b, async () => { await api.post(`/accounts/${id}/check`); toast('Conta conferida.', 'ok'); reload(); }));
  on(el, 'click', '[data-receive]', () => openReceive(a, reload));
  on(el, 'click', '[data-flow]', (e, b) => openPaymentFlow(b.dataset.flow, reload).catch(showError));
  on(el, 'click', '[data-confer]', (e, b) => openConfer(a.payments.find((p) => String(p.id) === b.dataset.confer), reload));
  on(el, 'click', '[data-refund]', (e, b) => openRefund(a.payments.find((p) => String(p.id) === b.dataset.refund), reload));
  on(el, 'click', '[data-reassign]', (e, b) => openReassign(a.payments.find((p) => String(p.id) === b.dataset.reassign), reload));
  on(el, 'click', '[data-receipt]', (e, b) => openReceipt(b.dataset.receipt).catch(showError));
  on(el, 'click', '[data-go]', (e, b) => document.getElementById(b.dataset.go === 'pay' ? 'sec-pay' : 'sec-fiscal').scrollIntoView({ behavior: 'smooth' }));
  on(el, 'click', '[data-settlement]', () => openSettlementHistory(id).catch(showError));
  on(el, 'click', '[data-print]', () => printStatement(a));
}

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
    <table class="mt"><thead><tr><th>Procedimento</th><th>Qtd</th><th class="money">Unitário</th><th class="money">Desc.</th><th class="money">Acrésc.</th><th class="money">Total</th></tr></thead>
      <tbody>${a.items.filter((i) => i.status === 'ATIVO').map((i) => html`<tr><td>${i.description}</td><td>${i.quantity}</td><td class="money">${money(i.unit_price_cents)}</td><td class="money">${money(i.discount_cents)}</td><td class="money">${money(i.surcharge_cents)}</td><td class="money">${money(i.total_cents)}</td></tr>`)}</tbody></table>
    <table class="mt"><tbody><tr><th>Total da conta</th><td class="money">${money(a.total_cents)}</td></tr><tr><th>Total recebido</th><td class="money">${money(a.received_cents)}</td></tr><tr><th>Saldo devedor</th><td class="money"><strong>${money(a.balance_cents)}</strong></td></tr></tbody></table>
    <h3 class="mt">Pagamentos</h3>
    <table><tbody>${a.payments.map((p) => html`<tr><td>${label(p.method)}${p.is_demo ? ' (DEMONSTRAÇÃO)' : ''}</td><td>${label(p.status)}</td><td>${datetime(p.confirmed_at)}</td><td class="money">${money(p.amount_cents - p.refunded_cents)}</td></tr>`)}</tbody></table>
  </div>`, actions: [{ label: 'Fechar' }, { label: 'Imprimir', class: 'primary', closes: false, onClick: () => { window.print(); return false; } }] });
}
