import { api } from '../api.js';
import { html, render, $, on, money, date, datetime, badge, label, table, formDialog, toast, cpf, showError, fresh } from '../ui.js';
import { can } from '../state.js';
import { patientPicker } from '../components.js';

const UF = ['', 'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

async function patientFields(p = {}) {
  let plans = [];
  try { plans = await api.get('/insurance-plans', { active: 'true' }); } catch (_) { /* sem permissão */ }
  return [
    { name: 'name', label: 'Nome completo', required: true, value: p.name, span2: true },
    { name: 'social_name', label: 'Nome social', value: p.social_name },
    { name: 'cpf', label: 'CPF', value: p.masked ? '' : p.cpf, placeholder: '000.000.000-00', help: p.masked ? 'Oculto para seu perfil' : '' },
    { name: 'birth_date', label: 'Data de nascimento', type: 'date', value: p.birth_date },
    { name: 'sex', label: 'Sexo', type: 'select', value: p.sex, options: [{ value: '', label: '—' }, { value: 'F', label: 'Feminino' }, { value: 'M', label: 'Masculino' }, { value: 'O', label: 'Outro' }] },
    { name: 'mother_name', label: 'Nome da mãe', value: p.mother_name, span2: true },
    { name: 'phone', label: 'Telefone', value: p.phone },
    { name: 'email', label: 'E-mail', type: 'email', value: p.email },
    { name: 'zip_code', label: 'CEP', value: p.zip_code },
    { name: 'address', label: 'Endereço', value: p.address, span2: true },
    { name: 'address_number', label: 'Número', value: p.address_number },
    { name: 'district', label: 'Bairro', value: p.district },
    { name: 'city', label: 'Cidade', value: p.city },
    { name: 'city_ibge_code', label: 'Código IBGE do município', value: p.city_ibge_code, help: 'Usado na NFS-e' },
    { name: 'state', label: 'UF', type: 'select', value: p.state, options: UF.map((u) => ({ value: u, label: u || '—' })) },
    { name: 'insurance_plan_id', label: 'Convênio', type: 'select', value: p.insurance_plan_id, options: [{ value: '', label: 'Particular / nenhum' }, ...plans.map((x) => ({ value: x.id, label: x.name }))] },
    { name: 'insurance_card_number', label: 'Nº carteirinha', value: p.insurance_card_number },
  ];
}

const clean = (v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));

export async function openPatientForm(p, onSaved) {
  const fields = await patientFields(p || {});
  const dlg = formDialog({
    title: p ? `Editar paciente ${p.code}` : 'Novo paciente', wide: true, fields, submit: p ? 'Salvar alterações' : 'Cadastrar',
    onSubmit: async (v) => {
      const body = clean(v);
      if (p) {
        if (p.masked) delete body.cpf;
        const r = await api.put(`/patients/${p.id}`, body); toast('Cadastro atualizado.', 'ok'); onSaved?.(r);
        return;
      }
      try {
        const r = await api.post('/patients', body);
        toast(`Paciente ${r.code} cadastrado. Prontuário ${r.record_number}.`, 'ok'); onSaved?.(r);
      } catch (e) {
        if (e.details?.possibleDuplicate) {
          const list = e.details.duplicates.map((d) => `${d.name} (${d.code}, prontuário ${d.record_number}, nasc. ${date(d.birth_date)})`).join('\n');
          // eslint-disable-next-line no-alert
          if (window.confirm(`Possível cadastro duplicado:\n\n${list}\n\nConfirmar que é uma pessoa diferente e cadastrar mesmo assim?`)) {
            const r = await api.post('/patients', { ...body, confirm_not_duplicate: true });
            toast(`Paciente ${r.code} cadastrado.`, 'ok'); onSaved?.(r); return;
          }
        }
        throw e;
      }
    },
  });
  return dlg;
}

export async function patients(host, { params }) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Cadastro de pacientes</h1><div class="muted">Pesquise por nome, CPF, código interno ou número de prontuário</div></div>
      ${can('patients.create') ? html`<button class="btn primary" data-new>+ Novo paciente</button>` : ''}</div>
    <div class="card"><div class="row"><input type="search" class="grow" data-q placeholder="Pesquisar…" value="${params.q || ''}"><button class="btn" data-search>Pesquisar</button></div></div>
    <div class="card" data-results></div>`);
  const load = async () => {
    const rows = await api.get('/patients', { q: $('[data-q]', el).value.trim() });
    render($('[data-results]', el), table([
      { label: 'Código', render: (p) => html`<a href="#/pacientes/${p.id}">${p.code}</a>` },
      { label: 'Nome', render: (p) => html`<a href="#/pacientes/${p.id}">${p.name}</a>${p.social_name ? html`<div class="small muted">Nome social: ${p.social_name}</div>` : ''}` },
      { label: 'CPF', render: (p) => cpf(p.cpf) },
      { label: 'Nascimento', render: (p) => date(p.birth_date) },
      { label: 'Prontuário', key: 'record_number' },
      { label: 'Último atendimento', render: (p) => datetime(p.last_appointment_at) },
      { label: '', render: (p) => (can('appointments.open') ? html`<a class="btn sm" href="#/atendimentos/novo?patient=${p.id}">Abrir atendimento</a>` : '') },
    ], rows));
  };
  $('[data-search]', el).addEventListener('click', () => load().catch(showError));
  $('[data-q]', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') load().catch(showError); });
  $('[data-new]', el)?.addEventListener('click', () => openPatientForm(null, (p) => { location.hash = `#/pacientes/${p.id}`; }));
  await load();
  if (params.novo && can('patients.create')) openPatientForm(null, (p) => { location.hash = `#/pacientes/${p.id}`; });
}

function historyTable(rows) {
  return table([
    { label: 'Atendimento', render: (a) => html`<strong>${a.number}</strong><div class="small muted">${datetime(a.opened_at)}</div>` },
    { label: 'Tipo / setor', render: (a) => html`${label(a.type)} · ${a.sector}<div class="small muted">${label(a.modality)}${a.professional_name ? ` · ${a.professional_name}` : ''}</div>` },
    { label: 'Procedimentos', render: (a) => a.procedures || '—' },
    { label: 'Conta', render: (a) => html`<a href="#/contas/${a.account_id}">${a.account_number}</a>` },
    { label: 'Total', class: 'money', render: (a) => money(a.total_cents) },
    { label: 'Recebido', class: 'money', render: (a) => money(a.received_cents) },
    { label: 'Saldo', class: 'money', render: (a) => money(a.balance_cents) },
    { label: 'Financeiro', render: (a) => badge(a.financial_status) },
    { label: 'Fiscal', render: (a) => badge(a.fiscal_status) },
    { label: 'Pagamentos', render: (a) => (a.payments.length ? a.payments.map((p) => html`<div class="small">${label(p.method)} ${money(p.amount_cents)} ${badge(p.status)}${p.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}</div>`) : html`<span class="muted small">—</span>`) },
  ], rows, { empty: 'Nenhum atendimento registrado.' });
}

export async function patientDetail(host, { args, params }) {
  const el = fresh(host);
  const id = args[0];
  const p = await api.get(`/patients/${id}`);
  const tab = params.tab || 'dados';
  render(el, html`
    <div class="page-head"><div><h1>${p.name}</h1><div class="muted">${p.code} · Prontuário <strong>${p.record_number}</strong>${p.masked ? ' · dados pessoais ocultos para seu perfil' : ''}</div></div>
      <div class="btn-group">
        ${can('patients.edit') ? html`<button class="btn" data-edit>Editar cadastro</button>` : ''}
        ${can('appointments.open') ? html`<a class="btn primary" href="#/atendimentos/novo?patient=${p.id}">Abrir novo atendimento</a>` : ''}
      </div></div>
    <div class="tabs">
      <button data-tab="dados" class="${tab === 'dados' ? 'active' : ''}">Dados cadastrais</button>
      ${can('records.view') ? html`<button data-tab="historico" class="${tab === 'historico' ? 'active' : ''}">Histórico de atendimentos e contas</button>` : ''}
      ${can('payments.view', 'fiscal.view') ? html`<button data-tab="documentos" class="${tab === 'documentos' ? 'active' : ''}">Documentos administrativos</button>` : ''}
    </div>
    <div data-content></div>`);
  const content = $('[data-content]', el);
  const show = async (t) => {
    el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'dados') {
      render(content, html`<div class="card"><dl class="kv">
        <dt>Nome</dt><dd>${p.name}</dd><dt>Nome social</dt><dd>${p.social_name || '—'}</dd>
        <dt>CPF</dt><dd>${cpf(p.cpf)}</dd><dt>Nascimento</dt><dd>${date(p.birth_date)}</dd><dt>Sexo</dt><dd>${p.sex || '—'}</dd>
        <dt>Mãe</dt><dd>${p.mother_name || '—'}</dd><dt>Telefone</dt><dd>${p.phone || '—'}</dd><dt>E-mail</dt><dd>${p.email || '—'}</dd>
        <dt>Endereço</dt><dd>${[p.address, p.address_number, p.district, p.city, p.state].filter(Boolean).join(', ') || '—'}</dd>
        <dt>Convênio</dt><dd>${p.insurance_name || 'Particular'} ${p.insurance_card_number ? `· ${p.insurance_card_number}` : ''}</dd>
        <dt>Cadastro</dt><dd>${datetime(p.created_at)} · atualizado ${datetime(p.updated_at)}</dd>
      </dl></div>`);
    } else if (t === 'historico') {
      const rows = await api.get(`/patients/${id}/history`);
      render(content, html`<div class="card"><h2>Prontuário ${p.record_number} — ${rows.length} atendimento(s)</h2><p class="small muted">Cada atendimento é independente e possui conta própria, mas todos pertencem ao mesmo prontuário.</p>${historyTable(rows)}</div>`);
    } else {
      const d = await api.get(`/patients/${id}/documents`);
      render(content, html`<div class="grid c2">
        <div class="card"><h2>Comprovantes internos de recebimento</h2><p class="small muted">Não são documentos fiscais.</p>
          ${table([{ label: 'Data', render: (r) => datetime(r.confirmed_at) }, { label: 'Conta', key: 'account_number' }, { label: 'Forma', render: (r) => label(r.method) },
            { label: 'Valor', class: 'money', render: (r) => money(r.amount_cents) }, { label: '', render: (r) => html`<a class="btn sm" href="#/contas?receipt=${r.id}">Ver</a>${r.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}` }], d.receipts)}</div>
        <div class="card"><h2>Documentos fiscais</h2>
          ${table([{ label: 'Data', render: (r) => datetime(r.requested_at) }, { label: 'Conta', key: 'account_number' }, { label: 'Número', render: (r) => r.nfse_number || '—' },
            { label: 'Status', render: (r) => html`${badge(r.status)}${r.is_demo ? html` <span class="badge demo">DEMO</span>` : ''}` }, { label: 'Valor', class: 'money', render: (r) => money(r.amount_cents) }], d.fiscal)}</div>
      </div>`);
    }
  };
  on(el, 'click', '[data-tab]', (e, b) => show(b.dataset.tab).catch(showError));
  $('[data-edit]', el)?.addEventListener('click', () => openPatientForm(p, () => patientDetail(host, { args, params })));
  await show(tab);
}

export async function records(host) {
  const el = fresh(host);
  render(el, html`
    <div class="page-head"><div><h1>Prontuários e histórico de atendimentos</h1><div class="muted">Um prontuário por paciente; cada retorno gera um novo atendimento vinculado a ele.</div></div></div>
    <div class="card"><label>Paciente</label><div data-picker></div></div>
    <div data-history></div>`);
  patientPicker($('[data-picker]', el), {
    onSelect: async (p) => {
      const rows = await api.get(`/patients/${p.id}/history`);
      render($('[data-history]', el), html`<div class="card"><div class="row between"><h2>Prontuário ${p.record_number} · ${p.name}</h2><a class="btn sm" href="#/pacientes/${p.id}">Ficha do paciente</a></div>
        <div class="timeline">${rows.map((a) => html`<div class="ev"><strong>${date(a.opened_at)}</strong> — ${a.number} · ${label(a.type)} · ${a.sector} ${badge(a.financial_status)}
          <div class="small muted">${a.procedures || 'sem procedimentos'} · Conta <a href="#/contas/${a.account_id}">${a.account_number}</a> · ${money(a.total_cents)} (saldo ${money(a.balance_cents)})</div></div>`)}</div>
        ${rows.length ? '' : html`<div class="empty">Sem atendimentos.</div>`}</div>`);
    },
  });
}
