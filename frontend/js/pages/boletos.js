// EMISSÃO DE BOLETOS: emissão vinculada à conta, consulta, impressão, baixa e acompanhamento da liquidação.
import { api } from '../api.js';
import { html, render, on, fresh, money, date, datetime, badge, table, showError, formDialog, toast, toCents, centsToInput, modal } from '../ui.js';
import { can, state } from '../state.js';
import { demoBanner } from '../components.js';
import { openPaymentFlow } from '../payments.js';

export async function boletos(host, { params }) {
  const el = fresh(host);
  const reload = () => boletos(host, { params: {} }).catch(showError);
  const status = params.status || '';
  const rows = await api.get('/payments', { method: 'BOLETO', status });
  const open = rows.filter((r) => r.status === 'PENDENTE');
  render(el, html`${demoBanner('Boletos de DEMONSTRAÇÃO: código e linha digitável seguem o padrão FEBRABAN, mas não são registrados em nenhum banco.')}
    <div class="page-head"><div><h1>Emissão de boletos</h1><div class="muted">Boleto registrado no banco e vinculado à conta do atendimento. A conta é quitada quando o banco confirma a liquidação.</div></div>
      ${can('payments.receive') ? html`<button class="btn primary" data-new>+ Emitir boleto</button>` : ''}</div>
    <div class="grid k4 mb"><div class="card kpi"><div class="label">Boletos em aberto</div><div class="value">${open.length}</div><div class="sub">${money(open.reduce((s, r) => s + r.amount_cents, 0))}</div></div>
      <div class="card kpi alert"><div class="label">Vencidos sem pagamento</div><div class="value">${open.filter((r) => r.boleto_due_date && r.boleto_due_date < new Date().toISOString().slice(0, 10)).length}</div></div>
      <div class="card kpi"><div class="label">Liquidados</div><div class="value">${rows.filter((r) => r.status === 'CONFIRMADO').length}</div></div></div>
    <div class="card"><div class="row mb"><label class="small">Status</label><select data-status>${['', 'PENDENTE', 'CONFIRMADO', 'CANCELADO', 'FALHA_COMUNICACAO', 'ESTORNADO'].map((s) => html`<option value="${s}" ${s === status ? 'selected' : ''}>${s || 'Todos'}</option>`)}</select></div>
      ${table([
    { label: 'Nosso número', render: (r) => html`<span class="mono">${r.provider_charge_id}</span>${r.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}` },
    { label: 'Conta', render: (r) => html`<a href="#/contas/${r.account_id}?etapa=quitacao">${r.account_number}</a>` }, { label: 'Pagador', key: 'patient_name' },
    { label: 'Valor', class: 'money', render: (r) => money(r.amount_cents) },
    { label: 'Vencimento', render: (r) => html`${date(r.boleto_due_date)}${r.status === 'PENDENTE' && r.boleto_due_date < new Date().toISOString().slice(0, 10) ? html` <span class="badge danger">vencido</span>` : ''}` },
    { label: 'Linha digitável', render: (r) => html`<span class="mono small">${r.boleto_digitable_line || '—'}</span>` },
    { label: 'Status', render: (r) => badge(r.status) }, { label: 'Pago em', render: (r) => datetime(r.confirmed_at) },
    { label: '', render: (r) => html`<div class="btn-group">${r.boleto_digitable_line ? html`<button class="btn sm" data-print="${r.id}">Imprimir</button>` : ''}<button class="btn sm" data-flow="${r.id}">Acompanhar</button></div>` },
  ], rows, { empty: 'Nenhum boleto emitido.' })}</div>`);
  on(el, 'change', '[data-status]', (e, s) => { location.hash = `#/boletos?status=${s.value}`; });
  on(el, 'click', '[data-flow]', (e, b) => openPaymentFlow(b.dataset.flow, reload).catch(showError));
  on(el, 'click', '[data-print]', (e, b) => printBoleto(b.dataset.print).catch(showError));
  const issue = async (preselect) => {
    const accs = (await api.get('/accounts', { limit: 300 })).filter((a) => ['PENDENTE', 'PARCIAL'].includes(a.financial_status) && a.balance_cents > 0);
    const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const dlg = formDialog({ title: 'Emitir boleto', wide: true, submit: 'Registrar boleto no banco', fields: [
      { name: 'account_id', label: 'Conta do atendimento *', type: 'select', span2: true, value: preselect, options: [{ value: '', label: 'Selecione…' }, ...accs.map((a) => ({ value: a.id, label: `${a.number} — ${a.patient_name} — saldo ${money(a.balance_cents)}` }))] },
      { name: 'amount', label: 'Valor (R$) *', value: '' }, { name: 'due_date', label: 'Vencimento *', type: 'date', value: due }],
    intro: html`<div class="alert info small">O pagador é o paciente da conta (nome, CPF e endereço do cadastro). Boletos pagos são confirmados pelo banco e quitam a conta automaticamente.</div>`,
    onSubmit: async (v) => {
      const cents = toCents(v.amount);
      if (!cents || Number.isNaN(cents)) throw new Error('Valor inválido.');
      const p = await api.post(`/accounts/${v.account_id}/payments`, { method: 'BOLETO', amount_cents: cents, due_date: v.due_date });
      toast('Boleto registrado.', 'ok'); reload(); printBoleto(p.id).catch(showError);
    } });
    const sel = dlg.body.querySelector('[name=account_id]'); const amt = dlg.body.querySelector('[name=amount]');
    const fill = () => { const a = accs.find((x) => String(x.id) === sel.value); if (a) amt.value = centsToInput(a.balance_cents); };
    sel.addEventListener('change', fill); fill();
  };
  on(el, 'click', '[data-new]', () => issue().catch(showError));
  if (params.conta && can('payments.receive')) issue(params.conta).catch(showError);
}

export async function printBoleto(paymentId) {
  const p = await api.get(`/payments/${paymentId}`);
  const acc = await api.get(`/accounts/${p.account_id}`);
  const inst = p.institution || {};
  modal({ title: 'Boleto bancário', wide: true, body: html`<div class="print-area print-doc boleto">
    ${p.is_demo ? html`<div class="watermark">DEMONSTRAÇÃO — BOLETO NÃO REGISTRADO, NÃO PAGUE</div>` : ''}
    <div class="bol-head"><strong>Banco Santander | 033-7</strong><span class="mono bol-line">${p.boleto_digitable_line}</span></div>
    <table class="bol"><tbody>
      <tr><td colspan="3"><small>Local de pagamento</small>Pagável em qualquer banco até o vencimento</td><td><small>Vencimento</small><strong>${date(p.boleto_due_date)}</strong></td></tr>
      <tr><td colspan="3"><small>Beneficiário</small>${inst.name || '—'} · CNPJ ${inst.cnpj || '—'}</td><td><small>Nosso número</small>${p.provider_charge_id}</td></tr>
      <tr><td><small>Data do documento</small>${date(p.created_at)}</td><td><small>Nº documento</small>${acc.number}</td><td><small>Espécie</small>R$</td><td><small>(=) Valor do documento</small><strong>${money(p.amount_cents)}</strong></td></tr>
      <tr><td colspan="4"><small>Instruções</small>Referente ao atendimento ${acc.appointment_number}. Não receber após 30 dias do vencimento.</td></tr>
      <tr><td colspan="4"><small>Pagador</small>${acc.patient_name} · CPF ${acc.patient_cpf || '—'}</td></tr>
    </tbody></table>
    <div class="small muted mt">Código de barras (44 posições): <span class="mono">${p.boleto_barcode}</span></div>
    <div class="disclaimer">${p.is_demo ? 'Documento de demonstração, sem validade bancária.' : 'A confirmação do pagamento é feita pelo banco; o comprovante interno fica disponível após a liquidação.'}</div>
  </div>`, actions: [{ label: 'Fechar' }, { label: 'Copiar linha digitável', closes: false, onClick: async () => { await navigator.clipboard?.writeText(p.boleto_digitable_line.replace(/\D/g, '')); toast('Linha copiada.', 'ok'); return false; } },
    { label: 'Imprimir', class: 'primary', closes: false, onClick: () => { window.print(); return false; } }] });

}
