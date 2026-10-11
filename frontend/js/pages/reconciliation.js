import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, label, table, showError, busy, toast, formDialog, today, daysAgo, readFileText, toCents, fresh } from '../ui.js';
import { can, state } from '../state.js';

const CATS = ['', 'SEM_CONTA', 'SEM_TRANSACAO_BANCARIA', 'VALOR_DIVERGENTE', 'DUPLICADA', 'PENDENTE', 'ESTORNO', 'CONCILIADO'];

export async function reconciliation(host) {
  const el = fresh(host);
  const manage = can('reconciliation.manage');
  render(el, html`
    <div class="page-head"><div><h1>Conciliação bancária</h1><div class="muted">Compara pagamentos do sistema com as transações do banco/provedor. Divergências nunca apagam registros.</div></div></div>
    ${manage ? html`<div class="card"><h2>1. Importar transações do banco</h2><div class="filters">
      <div><label>De</label><input type="date" data-from value="${daysAgo(7)}"></div><div><label>Até</label><input type="date" data-to value="${today()}"></div>
      <div><button class="btn" data-import>Importar via API do provedor</button></div>
      <div><label>ou arquivo CSV (external_id;txid;valor;data;tipo)</label><input type="file" accept=".csv,text/csv" data-csv></div>
      <div><button class="btn" data-import-csv>Importar CSV</button></div></div>
      <h2 class="mt">2. Executar conciliação</h2><button class="btn primary" data-run>Conciliar período</button>
      ${state.demoMode && can('demo.simulate') ? html`<span class="small muted"> · Demonstração: </span><button class="btn sm demo" data-orphan>Simular Pix recebido sem cobrança</button>` : ''}</div>` : ''}
    <div class="card"><h2>Execuções</h2><div data-runs></div></div>
    <div class="card hidden" data-items-card><div class="row between"><h2 data-items-title>Itens</h2><select data-cat>${CATS.map((c) => html`<option value="${c}">${c ? label(c) : 'Todas as categorias'}</option>`)}</select></div><div data-items></div></div>`);
  let currentRun = null;
  const loadRuns = async () => {
    const runs = await api.get('/reconciliation/runs');
    render($('[data-runs]', el), table([{ label: '#', key: 'id' }, { label: 'Período', render: (r) => `${r.period_start.slice(0, 10)} a ${r.period_end.slice(0, 10)}` },
      { label: 'Resumo', render: (r) => Object.entries(r.summary || {}).map(([k, v]) => html`${badge(k, `${label(k)}: ${v}`)} `) },
      { label: 'Em aberto', key: 'open_items' }, { label: 'Executado', render: (r) => html`${datetime(r.created_at)}<div class="small muted">${r.created_by_name || ''}</div>` },
      { label: '', render: (r) => html`<button class="btn sm" data-open="${r.id}">Ver itens</button>` }], runs, { empty: 'Nenhuma conciliação executada.' }));
  };
  const loadItems = async () => {
    const items = await api.get(`/reconciliation/runs/${currentRun}/items`, { category: $('[data-cat]', el).value });
    $('[data-items-card]', el).classList.remove('hidden');
    $('[data-items-title]', el).textContent = `Itens da conciliação #${currentRun}`;
    render($('[data-items]', el), table([{ label: 'Categoria', render: (i) => badge(i.category) }, { label: 'Conta', render: (i) => (i.account_id ? html`<a href="#/contas/${i.account_id}">${i.account_number}</a>` : '—') },
      { label: 'Pagamento', render: (i) => i.payment_id || '—' }, { label: 'Transação banco', render: (i) => (i.external_id ? html`<span class="mono">${i.external_id}</span><div class="small muted">${datetime(i.statement_date)}</div>` : '—') },
      { label: 'Esperado', class: 'money', render: (i) => money(i.expected_cents) }, { label: 'Encontrado', class: 'money', render: (i) => money(i.found_cents) },
      { label: 'Descrição', key: 'description' }, { label: 'Status', render: (i) => html`${badge(i.status)}${i.resolution_note ? html`<div class="small muted">${i.resolution_note} — ${i.resolved_by_name || ''}</div>` : ''}` },
      { label: '', render: (i) => (manage && ['ABERTA', 'EM_ANALISE'].includes(i.status) ? html`<button class="btn sm" data-resolve="${i.id}">Tratar</button>` : '') }], items));
  };
  on(el, 'click', '[data-open]', (e, b) => { currentRun = b.dataset.open; loadItems().catch(showError); });
  $('[data-cat]', el).addEventListener('change', () => loadItems().catch(showError));
  on(el, 'click', '[data-resolve]', (e, b) => formDialog({ title: 'Tratar divergência', fields: [
    { name: 'status', label: 'Situação', type: 'select', options: [{ value: 'EM_ANALISE', label: 'Em análise' }, { value: 'RESOLVIDA', label: 'Resolvida' }, { value: 'JUSTIFICADA', label: 'Justificada' }] },
    { name: 'resolution_note', label: 'Parecer *', type: 'textarea', full: true }],
  onSubmit: async (v) => { await api.post(`/reconciliation/items/${b.dataset.resolve}/resolve`, v); toast('Item atualizado.', 'ok'); await loadItems(); await loadRuns(); } }));
  const period = () => ({ from: $('[data-from]', el).value, to: $('[data-to]', el).value });
  on(el, 'click', '[data-import]', (e, b) => busy(b, async () => { const r = await api.post('/reconciliation/import', period()); toast(`${r.read} transação(ões) lida(s), ${r.inserted} nova(s).`, 'ok'); }));
  on(el, 'click', '[data-import-csv]', (e, b) => busy(b, async () => {
    const f = $('[data-csv]', el).files[0]; if (!f) throw new Error('Selecione o arquivo CSV.');
    const r = await api.post('/reconciliation/import-csv', { provider: 'EXTRATO_CSV', csv: await readFileText(f) });
    toast(`${r.read} linha(s), ${r.inserted} nova(s).`, 'ok');
  }));
  on(el, 'click', '[data-run]', (e, b) => busy(b, async () => { const r = await api.post('/reconciliation/run', period()); toast('Conciliação executada.', 'ok'); currentRun = r.run_id; await loadRuns(); await loadItems(); }));
  on(el, 'click', '[data-orphan]', (e, b) => formDialog({ title: 'Simular Pix sem cobrança (demonstração)', fields: [{ name: 'amount', label: 'Valor (R$)', value: '150,00' }],
    onSubmit: async (v) => { await api.post('/demo/orphan-pix', { amount_cents: toCents(v.amount) }); toast('Pix simulado no "banco". Importe e concilie para ver a divergência.', 'ok'); } }));
  await loadRuns();
}
