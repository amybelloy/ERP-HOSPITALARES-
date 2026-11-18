import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, label, table, toast, showError, busy, daysAgo, today, fresh } from '../ui.js';
import { can, state } from '../state.js';
import { patientPicker } from '../components.js';

export async function appointments(host, { params }) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Atendimentos</h1><div class="muted">Cada atendimento tem identificador e conta próprios</div></div>
      ${can('appointments.open') ? html`<a class="btn primary" href="#/atendimentos/novo">+ Abrir atendimento</a>` : ''}</div>
    <div class="card"><div class="filters">
      <div><label>De</label><input type="date" data-from value="${params.q ? '' : daysAgo(30)}"></div><div><label>Até</label><input type="date" data-to value="${params.q ? '' : today()}"></div>
      <div><label>Número / paciente</label><input data-q value="${params.q || ''}"></div>
      <div><label>Status</label><select data-status><option value="">Todos</option>${['ABERTO', 'EM_ATENDIMENTO', 'FINALIZADO', 'CANCELADO'].map((s) => html`<option value="${s}">${label(s)}</option>`)}</select></div>
      <div><button class="btn" data-load>Filtrar</button></div></div></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const rows = await api.get('/appointments', { from: $('[data-from]', el).value, to: $('[data-to]', el).value, q: $('[data-q]', el).value.trim(), status: $('[data-status]', el).value });
    render($('[data-list]', el), table([
      { label: 'Atendimento', render: (a) => html`<strong>${a.number}</strong><div class="small muted">${datetime(a.opened_at)}</div>` },
      { label: 'Paciente', render: (a) => html`<a href="#/pacientes/${a.patient_id}">${a.patient_name}</a><div class="small muted">Prontuário ${a.record_number}</div>` },
      { label: 'Tipo', render: (a) => html`${label(a.type)} · ${a.sector}<div class="small muted">${label(a.modality)}</div>` },
      { label: 'Profissional', render: (a) => a.professional_name || '—' },
      { label: 'Aberto por', key: 'opened_by_name' },
      { label: 'Status', render: (a) => badge(a.status) },
      { label: 'Conta', render: (a) => html`<a href="#/contas/${a.account_id}">${a.account_number}</a> ${badge(a.financial_status)}<div class="small muted">${money(a.total_cents)}</div>` },
      { label: '', render: (a) => html`<div class="btn-group">
        ${a.status === 'ABERTO' && can('appointments.open') ? html`<button class="btn sm" data-st="EM_ATENDIMENTO" data-id="${a.id}">Iniciar</button>` : ''}
        ${['ABERTO', 'EM_ATENDIMENTO'].includes(a.status) && can('appointments.open') ? html`<button class="btn sm" data-st="FINALIZADO" data-id="${a.id}">Finalizar</button>` : ''}
        ${a.status !== 'CANCELADO' && can('appointments.cancel') ? html`<button class="btn sm danger" data-cancel="${a.id}">Cancelar</button>` : ''}</div>` },
    ], rows));
  };
  on(el, 'click', '[data-st]', (e, b) => busy(b, async () => { await api.post(`/appointments/${b.dataset.id}/status`, { status: b.dataset.st }); await load(); }));
  on(el, 'click', '[data-cancel]', (e, b) => busy(b, async () => {
    // eslint-disable-next-line no-alert
    const reason = window.prompt('Motivo do cancelamento do atendimento (obrigatório):');
    if (!reason) return;
    await api.post(`/appointments/${b.dataset.cancel}/cancel`, { reason }); toast('Atendimento cancelado.', 'ok'); await load();
  }));
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  await load();
}

export async function newAppointment(host, { params }) {
  const el = fresh(host);
  const [profs, procs, plans] = await Promise.all([
    api.get('/professionals', { active: 'true' }), api.get('/procedures', { active: 'true' }), api.get('/insurance-plans', { active: 'true' }),
  ]);
  let patient = null; const items = [];
  const now = new Date();
  render(el, html`
    <div class="page-head"><div><h1>Abertura de atendimento</h1><div class="muted">Pesquise o paciente, informe os dados e lance os procedimentos</div></div></div>
    <div class="grid c2">
      <div class="card"><h2>1. Paciente</h2><div data-pp></div>
        <p class="small muted mt">Paciente novo? <a href="#/pacientes?novo=1">Cadastre aqui</a>. O prontuário existente é sempre reutilizado.</p></div>
      <div class="card"><h2>2. Dados do atendimento</h2>
        <div class="form-grid">
          <div><label>Data e hora</label><input value="${now.toLocaleString('pt-BR')}" disabled></div>
          <div><label>Usuário responsável</label><input value="${state.user.name}" disabled></div>
          <div><label>Profissional responsável</label><select name="professional_id"><option value="">—</option>${profs.map((p) => html`<option value="${p.id}" ${String(p.id) === params.professional ? 'selected' : ''}>${p.name}${p.specialty ? ` (${p.specialty})` : ''}</option>`)}</select></div>
          <div><label>Setor *</label><input name="sector" value="Ambulatório"></div>
          <div><label>Tipo de atendimento *</label><select name="type">${['EXAME', 'CONSULTA', 'AMBULATORIAL', 'URGENCIA', 'INTERNACAO'].map((t) => html`<option value="${t}">${label(t)}</option>`)}</select></div>
          <div><label>Modalidade *</label><select name="modality"><option value="PARTICULAR">Particular</option><option value="CONVENIO">Convênio</option></select></div>
          <div class="hidden" data-plan><label>Convênio *</label><select name="insurance_plan_id"><option value="">—</option>${plans.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
          <div><label>Status inicial</label><input value="Aberto" disabled></div>
          <div class="full"><label>Observações</label><textarea name="notes"></textarea></div>
        </div></div>
    </div>
    <div class="card"><h2>3. Procedimentos / exames solicitados</h2>
      <div class="row"><select data-proc class="grow"><option value="">Selecione o procedimento…</option>${procs.map((p) => html`<option value="${p.id}">${p.code} — ${p.name} (${money(p.price_cents)})</option>`)}</select>
        <input type="number" min="1" value="1" data-qty class="qty"><button class="btn" data-add>Adicionar</button></div>
      <div data-items class="mt"></div>
      <p class="small muted">O valor é preenchido automaticamente pelo cadastro. Ajustes de preço/desconto só por usuários autorizados, na tela da conta.</p>
    </div>
    <div class="row end mt"><a class="btn" href="#/atendimentos">Cancelar</a><button class="btn primary" data-open>Abrir atendimento e conta</button></div>`);

  const renderItems = () => render($('[data-items]', el), table([
    { label: 'Código', render: (i) => i.p.code }, { label: 'Procedimento', render: (i) => i.p.name }, { label: 'Qtd', render: (i) => i.qty },
    { label: 'Valor unitário', class: 'money', render: (i) => money(i.p.price_cents) }, { label: 'Total', class: 'money', render: (i) => money(i.p.price_cents * i.qty) },
    { label: '', render: (i) => html`<button class="btn sm danger" data-rm="${items.indexOf(i)}">Remover</button>` },
  ], items, { empty: 'Nenhum procedimento adicionado (pode ser lançado depois na conta).' }));
  renderItems();
  $('[name=modality]', el).addEventListener('change', (e) => $('[data-plan]', el).classList.toggle('hidden', e.target.value !== 'CONVENIO'));
  $('[data-add]', el).addEventListener('click', () => {
    const p = procs.find((x) => String(x.id) === $('[data-proc]', el).value);
    if (!p) return toast('Selecione um procedimento.', 'warn');
    items.push({ p, qty: Math.max(1, Number($('[data-qty]', el).value) || 1) }); renderItems();
  });
  on(el, 'click', '[data-rm]', (e, b) => { items.splice(Number(b.dataset.rm), 1); renderItems(); });
  const picker = patientPicker($('[data-pp]', el), { onSelect: (p) => { patient = p; } });
  if (params.patient) {
    try { const p = await api.get(`/patients/${params.patient}`); picker.setPatient(p); } catch (e) { showError(e); }
  }
  if (params.procedure) {
    const p = procs.find((x) => String(x.id) === params.procedure);
    if (p) { items.push({ p, qty: 1 }); renderItems(); }
  }
  $('[data-open]', el).addEventListener('click', (e) => busy(e.target, async () => {
    if (!patient) throw new Error('Selecione o paciente.');
    const v = (n) => $(`[name=${n}]`, el).value || null;
    const r = await api.post('/appointments', {
      patient_id: patient.id, professional_id: v('professional_id'), sector: v('sector'), type: v('type'), modality: v('modality'),
      insurance_plan_id: v('modality') === 'CONVENIO' ? v('insurance_plan_id') : null, notes: v('notes'),
      scheduling_id: params.scheduling || null, procedures: items.map((i) => ({ procedure_id: i.p.id, quantity: i.qty })),
    });
    toast(`Atendimento ${r.number} aberto. Conta ${r.account_number} criada.`, 'ok');
    location.hash = `#/contas/${r.account_id}`;
  }));
}
