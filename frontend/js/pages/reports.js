import { api } from '../api.js';
import { html, render, $, money, table, showError, busy, today, daysAgo, label, datetime, fresh } from '../ui.js';
import { can } from '../state.js';

const STATUS = { 'contas-status': ['PENDENTE', 'PARCIAL', 'QUITADA', 'CANCELADA'], 'notas-fiscais': ['EMITIDA', 'PROCESSANDO', 'REJEITADA', 'CANCELADA', 'PREPARADA', 'EXPORTADA', 'EMITIDA_EXTERNAMENTE'] };
const fmt = (k, v) => (k.endsWith('_cents') ? money(v) : (/(_at|ultima|occurred)/.test(k) && v ? datetime(v) : (typeof v === 'boolean' ? (v ? 'Sim' : 'Não') : v)));

export async function reports(host) {
  const el = fresh(host);
  const list = await api.get('/reports');
  render(el, html`
    <div class="page-head"><div><h1>Relatórios financeiros</h1></div></div>
    <div class="card"><div class="filters">
      <div class="span2"><label>Relatório</label><select data-type>${list.map((r) => html`<option value="${r.key}">${r.title}</option>`)}</select></div>
      <div><label>De</label><input type="date" data-from value="${daysAgo(30)}"></div><div><label>Até</label><input type="date" data-to value="${today()}"></div>
      <div data-status-wrap class="hidden"><label>Status</label><select data-status></select></div>
      <div class="btn-group"><button class="btn primary" data-run>Gerar</button>${can('reports.export') ? html`<button class="btn" data-csv>Exportar CSV</button>` : ''}</div></div></div>
    <div class="card" data-out></div>`);
  const type = () => $('[data-type]', el).value;
  const updStatus = () => {
    const st = STATUS[type()];
    $('[data-status-wrap]', el).classList.toggle('hidden', !st);
    render($('[data-status]', el), html`<option value="">Todos</option>${(st || []).map((s) => html`<option value="${s}">${label(s)}</option>`)}`);
  };
  const q = () => ({ from: $('[data-from]', el).value, to: $('[data-to]', el).value, status: $('[data-status]', el).value });
  const run = async () => {
    const r = await api.get(`/reports/${type()}`, q());
    const keys = r.rows.length ? Object.keys(r.rows[0]) : [];
    render($('[data-out]', el), html`<h2>${r.title}</h2>${table(keys.map((k) => ({ label: k.replace(/_cents$/, ' (R$)').replace(/_/g, ' '), class: k.endsWith('_cents') ? 'money' : '', render: (row) => fmt(k, row[k]) })), r.rows)}`);
  };
  $('[data-type]', el).addEventListener('change', updStatus);
  $('[data-run]', el).addEventListener('click', (e) => busy(e.target, run));
  $('[data-csv]', el)?.addEventListener('click', () => { window.location.href = `/api/reports/${type()}${api.qs({ ...q(), format: 'csv' })}`; });
  updStatus();
  await run().catch(showError);
}
