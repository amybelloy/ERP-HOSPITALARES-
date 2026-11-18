// PRONTUÁRIO ELETRÔNICO DO PACIENTE (PEP)
// Barra do paciente fixa + árvore de itens à esquerda + conteúdo do item à direita.
import { api } from '../api.js';
import { html, render, $, $$, on, fresh, modal, toast, showError, busy, datetime, date, table, formDialog, markErrors } from '../ui.js';
import { can } from '../state.js';
import { patientBar, newsBadge, triageTag, temp, hhmm, NOTE_LABEL, RISK_LABEL, ADM_LABEL, NEWS_LABEL } from '../clinical.js';

// ------------------------------------------------------------------ lista de pacientes (entrada do PEP)
async function pepList(el, params) {
  render(el, html`
    <div class="page-head"><div><h1>Prontuário eletrônico (PEP)</h1><div class="muted">Pacientes em atendimento. Selecione para abrir o prontuário.</div></div></div>
    <div class="card"><div class="row"><input type="search" class="grow" data-q placeholder="Nome, prontuário ou nº do atendimento" value="${params.q || ''}"><button class="btn" data-search>Pesquisar</button></div></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const rows = await api.get('/clinical/patients', { q: $('[data-q]', el).value.trim() });
    render($('[data-list]', el), table([
      { label: 'Leito', render: (r) => r.bed_code || '—' }, { label: 'Paciente', render: (r) => html`<a href="#/pep/${r.appointment_id}"><strong>${r.patient_name}</strong></a>${r.allergies ? html` <span class="badge danger">⚠ alergia</span>` : ''}` },
      { label: 'Idade', render: (r) => r.age ?? '—' }, { label: 'Prontuário', key: 'record_number' }, { label: 'Atendimento', render: (r) => html`${r.number}<div class="small muted">${r.type} · ${r.sector}</div>` },
      { label: 'Risco', render: (r) => html`${triageTag(r.triage_color)} ${newsBadge(r.news_score, r.news_risk)}` },
      { label: '', render: (r) => html`<a class="btn sm primary" href="#/pep/${r.appointment_id}">Abrir</a>` },
    ], rows, { empty: 'Nenhum paciente em atendimento.' }));
  };
  on(el, 'click', '[data-search]', () => load().catch(showError));
  $('[data-q]', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') load().catch(showError); });
  await load();
}

const TREE = [
  { grp: 'Visão geral' }, { key: 'resumo', label: 'Resumo / linha do tempo' },
  { grp: 'Assistência médica' }, { key: 'evolucoes', label: 'Evoluções e anotações' }, { key: 'prescricao', label: 'Prescrição' },
  { key: 'alergias', label: 'Alergias' },
  { grp: 'Enfermagem' }, { key: 'sinais', label: 'Sinais vitais' }, { key: 'checagem', label: 'Checagem (administração)' }, { key: 'sae', label: 'SAE' },
  { key: 'escalas', label: 'Escalas (Braden, Morse, Glasgow)' }, { key: 'balanco', label: 'Balanço hídrico' }, { key: 'plantao', label: 'Passagem de plantão' },
  { grp: 'Internação' }, { key: 'movimentacoes', label: 'Movimentação de leitos' },
];

export async function pep(host, { args, params }) {
  const el = fresh(host);
  if (!args[0]) return pepList(el, params);
  const id = args[0];
  const item = TREE.some((t) => t.key === params.item) ? params.item : 'resumo';
  const ctx = await api.get(`/clinical/appointments/${id}/context`);
  const reload = () => pep(host, { args, params }).catch(showError);
  const active = ['ABERTO', 'EM_ATENDIMENTO'].includes(ctx.status);
  const sched = await api.get('/clinical/schedule', { appointment_id: id });
  const overdue = sched.filter((s) => s.overdue).length;
  render(el, html`${patientBar(ctx)}
    <div class="pep">
      <nav class="pep-tree">${TREE.map((t) => (t.grp ? html`<div class="grp">${t.grp}</div>`
    : html`<button data-item="${t.key}" class="${t.key === item ? 'active' : ''}"><span>${t.label}</span>${t.key === 'checagem' && overdue ? html`<span class="cnt">${overdue}</span>` : ''}${t.key === 'alergias' && ctx.allergies.length ? html`<span class="cnt">${ctx.allergies.length}</span>` : ''}</button>`))}
        <div class="grp">Atalhos</div><button data-go="conta"><span>Conta do atendimento</span></button></nav>
      <section data-content></section></div>`);
  on(el, 'click', '[data-item]', (e, b) => { location.hash = `#/pep/${id}?item=${b.dataset.item}`; });
  on(el, 'click', '[data-go]', () => { location.hash = `#/contas/${ctx.account_id}`; });
  const box = $('[data-content]', el);
  const sections = { resumo, evolucoes, prescricao, alergias, sinais, checagem, sae, escalas, balanco, plantao, movimentacoes };
  await sections[item](box, { id, ctx, reload, active, sched });
}

// ------------------------------------------------------------------ Resumo
async function resumo(box, { id, ctx }) {
  const tl = await api.get(`/clinical/appointments/${id}/timeline`);
  const v = ctx.last_vitals;
  render(box, html`
    <div class="grid k4 mb">
      <div class="card kpi"><div class="label">Últimos sinais vitais</div>${v ? html`<div class="value small">PA ${v.systolic ?? '—'}x${v.diastolic ?? '—'} · FC ${v.heart_rate ?? '—'}</div>
        <div class="sub">FR ${v.resp_rate ?? '—'} · SpO2 ${v.spo2 ?? '—'}% · T ${temp(v.temp_tenths)} · ${hhmm(v.measured_at)}</div><div class="mt">${newsBadge(v.news_score, v.news_risk)}</div>` : html`<div class="value small">—</div>`}</div>
      <div class="card kpi"><div class="label">Escalas</div>${ctx.scales.length ? ctx.scales.map((s) => html`<div class="sub"><strong>${s.scale}</strong> ${s.score} · ${RISK_LABEL[s.risk] || s.risk}</div>`) : html`<div class="sub">Nenhuma escala aplicada</div>`}</div>
      <div class="card kpi"><div class="label">Classificação de risco</div><div class="mt">${ctx.triage ? html`${triageTag(ctx.triage.color)}<div class="sub">${ctx.triage.chief_complaint}</div>` : html`<div class="sub">Não classificado</div>`}</div></div>
      <div class="card kpi ${ctx.allergies.length ? 'alert' : ''}"><div class="label">Alergias</div><div class="value small">${ctx.allergies.length ? ctx.allergies.map((a) => a.substance).join(', ') : 'Nenhuma'}</div></div>
    </div>
    <div class="card"><h2>Linha do tempo</h2>
      ${tl.length ? html`<div class="timeline">${tl.map((e) => html`<div class="ev"><strong>${datetime(e.at)}</strong> — ${e.title.replace(/_/g, ' ')} <span class="small muted">· ${e.who || ''}</span><div class="small">${e.detail || ''}</div></div>`)}</div>` : html`<div class="empty">Sem registros clínicos.</div>`}</div>`);
}

// ------------------------------------------------------------------ Evoluções
async function evolucoes(box, { id, reload, active }) {
  const notes = await api.get(`/clinical/appointments/${id}/notes`);
  const kinds = [
    ...(can('clinical.notes_medical') ? ['ANAMNESE', 'EVOLUCAO_MEDICA', 'SUMARIO_ALTA'] : []),
    ...(can('nursing.sae') ? ['EVOLUCAO_ENFERMAGEM'] : []),
    ...(can('nursing.notes') ? ['ANOTACAO_ENFERMAGEM'] : []),
    ...(can('clinical.notes_medical', 'nursing.notes') ? ['MULTIPROFISSIONAL'] : []),
  ];
  const roots = notes.filter((n) => !n.parent_id);
  const children = (pid) => notes.filter((n) => n.parent_id === pid).reverse();
  const noteHtml = (n, add = false) => html`<div class="note ${add ? 'addendum' : ''}"><div class="meta"><span><strong>${add ? 'Adendo' : NOTE_LABEL[n.kind]}</strong>${n.cid_code ? ` · CID ${n.cid_code}` : ''}</span>
      <span>${n.author_name}${n.council ? ` · ${n.council} ${n.council_number}/${n.council_state || ''}` : ''} · assinado em ${datetime(n.signed_at)}</span></div>
      <div class="txt">${n.text}</div>${!add && kinds.length ? html`<div class="row end"><button class="btn sm link" data-addendum="${n.id}" data-kind="${n.kind}">+ adendo</button></div>` : ''}</div>`;
  render(box, html`
    ${kinds.length ? html`<div class="card"><h2>Novo registro</h2><form data-form class="stack">
      <div class="form-grid"><div data-field="kind"><label>Tipo</label><select name="kind">${kinds.map((k) => html`<option value="${k}">${NOTE_LABEL[k]}</option>`)}</select></div>
        <div data-field="cid_code"><label>CID-10 (opcional)</label><input name="cid_code" placeholder="J18.9"></div></div>
      <div data-field="text"><label>Texto *</label><textarea name="text" rows="6" placeholder="Subjetivo, objetivo, avaliação e plano…"></textarea></div>
      <div class="row between"><span class="small muted">Registros são assinados ao salvar e não podem ser alterados; correções são feitas por adendo.</span><button class="btn primary" ${active ? '' : 'disabled'}>Assinar e salvar</button></div></form></div>` : ''}
    <div class="card"><h2>Evoluções e anotações</h2>${roots.length ? roots.map((n) => html`${noteHtml(n)}${children(n.id).map((c) => noteHtml(c, true))}`) : html`<div class="empty">Nenhum registro.</div>`}</div>`);
  const form = $('[data-form]', box);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      const fd = Object.fromEntries(new FormData(form).entries());
      try { await api.post(`/clinical/appointments/${id}/notes`, { kind: fd.kind, text: fd.text, cid_code: fd.cid_code || null }); toast('Registro assinado.', 'ok'); reload(); } catch (err) { markErrors(form, err); throw err; }
    });
  });
  on(box, 'click', '[data-addendum]', (e, b) => formDialog({ title: 'Adendo ao registro', fields: [{ name: 'text', label: 'Texto do adendo *', type: 'textarea', full: true }],
    intro: html`<div class="alert info small">O registro original permanece inalterado; o adendo fica vinculado a ele.</div>`,
    onSubmit: async (v) => { await api.post(`/clinical/appointments/${id}/notes`, { kind: kinds.includes(b.dataset.kind) ? b.dataset.kind : kinds[0], text: v.text, parent_id: b.dataset.addendum }); toast('Adendo registrado.', 'ok'); reload(); } }));
}

// ------------------------------------------------------------------ Prescrição
const ROUTES = ['VO', 'EV', 'IM', 'SC', 'SL', 'Inalatória', 'Tópica', 'Retal', 'SNE', 'Ocular'];
const itemRow = (i) => html`<div class="rx-item" data-rx="${i}">
  <div><label>Tipo</label><select name="kind"><option value="MEDICAMENTO">Medicamento</option><option value="SOLUCAO">Solução</option><option value="CUIDADO">Cuidado</option><option value="DIETA">Dieta</option><option value="PROCEDIMENTO">Procedimento</option></select></div>
  <div><label>Descrição *</label><input name="description" placeholder="Ex.: Ceftriaxona 1 g"></div>
  <div><label>Dose</label><input name="dose"></div>
  <div><label>Via</label><select name="route"><option value="">—</option>${ROUTES.map((r) => html`<option>${r}</option>`)}</select></div>
  <div><label>De x em x h</label><input name="frequency_hours" type="number" min="1"></div>
  <div><label>SN</label><input type="checkbox" name="if_needed"></div>
  <div><label>Orientações</label><input name="instructions"></div>
  <div><button type="button" class="btn sm danger" data-rm="${i}">×</button></div></div>`;

async function prescricao(box, { id, ctx, reload, active }) {
  const list = await api.get(`/clinical/appointments/${id}/prescriptions`);
  const writer = can('prescription.write');
  render(box, html`
    ${writer ? html`<div class="card"><div class="row between"><h2>Prescrições</h2><button class="btn primary" data-new ${active ? '' : 'disabled'}>+ Nova prescrição</button></div>
      ${ctx.allergies.length ? html`<div class="alert danger">⚠ Paciente alérgico a: <strong>${ctx.allergies.map((a) => `${a.substance} (${a.severity.toLowerCase()})`).join(', ')}</strong></div>` : ''}</div>` : ''}
    ${list.length ? list.map((p) => html`<div class="card"><div class="row between"><div><strong>Prescrição #${p.id}</strong> · ${p.prescriber_name}${p.council ? ` · ${p.council} ${p.council_number}` : ''}
        <div class="small muted">Validade: ${datetime(p.valid_from)} → ${datetime(p.valid_until)}${p.notes ? ` · ${p.notes}` : ''}</div></div>
        <div><span class="badge ${p.status === 'ATIVA' && !p.expired ? 'ok' : 'danger'}">${p.expired ? 'VENCIDA' : p.status}</span>${writer && p.status === 'ATIVA' ? html` <button class="btn sm danger" data-susp-p="${p.id}">Suspender prescrição</button>` : ''}</div></div>
      ${table([{ label: 'Tipo', key: 'kind' }, { label: 'Item', render: (i) => html`<strong>${i.description}</strong>${i.allergy_override_reason ? html`<div class="small"><span class="badge danger">alergia justificada</span> ${i.allergy_override_reason}</div>` : ''}${i.instructions ? html`<div class="small muted">${i.instructions}</div>` : ''}` },
        { label: 'Dose / via', render: (i) => [i.dose, i.route].filter(Boolean).join(' · ') || '—' },
        { label: 'Frequência', render: (i) => (i.if_needed ? `SN${i.frequency_hours ? ` (mín. ${i.frequency_hours} h)` : ''}` : i.frequency_hours ? `${i.frequency_hours}/${i.frequency_hours} h` : 'contínuo') },
        { label: 'Administrações', render: (i) => `${i.done}/${i.total}` },
        { label: 'Status', render: (i) => html`<span class="badge ${i.status === 'ATIVO' ? 'ok' : 'danger'}">${i.status}</span>${i.suspended_reason ? html`<div class="small muted">${i.suspended_reason}</div>` : ''}` },
        { label: '', render: (i) => (writer && i.status === 'ATIVO' && p.status === 'ATIVA' ? html`<button class="btn sm" data-susp-i="${i.id}">Suspender</button>` : '') }], p.items)}</div>`)
    : html`<div class="card empty">Nenhuma prescrição.</div>`}`);

  on(box, 'click', '[data-susp-i]', (e, b) => formDialog({ title: 'Suspender item', fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/clinical/prescription-items/${b.dataset.suspI}/suspend`, v); toast('Item suspenso; horários pendentes cancelados.', 'ok'); reload(); } }));
  on(box, 'click', '[data-susp-p]', (e, b) => formDialog({ title: 'Suspender prescrição', fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/clinical/prescriptions/${b.dataset.suspP}/suspend`, v); toast('Prescrição suspensa.', 'ok'); reload(); } }));
  on(box, 'click', '[data-new]', () => {
    const body = document.createElement('div');
    let n = 0;
    render(body, html`<div class="form-grid mb"><div><label>Validade (horas)</label><input name="valid_hours" type="number" value="24" min="1" max="72"></div>
      <div class="span2"><label>Observações</label><input name="notes"></div></div><div data-items>${itemRow(n++)}</div>
      <button type="button" class="btn sm" data-add>+ Adicionar item</button><div data-alert class="mt"></div>`);
    on(body, 'click', '[data-add]', () => { const tmp = document.createElement('div'); render(tmp, itemRow(n++)); $('[data-items]', body).append(...tmp.children); });
    on(body, 'click', '[data-rm]', (e, b) => { if ($$('[data-rx]', body).length > 1) b.closest('[data-rx]').remove(); });
    const collect = (overrides = {}) => $$('[data-rx]', body).map((r, idx) => {
      const g = (k) => r.querySelector(`[name=${k}]`);
      return { kind: g('kind').value, description: g('description').value.trim(), dose: g('dose').value.trim() || null, route: g('route').value || null,
        frequency_hours: g('frequency_hours').value || null, if_needed: g('if_needed').checked, instructions: g('instructions').value.trim() || null,
        allergy_override_reason: overrides[idx + 1] || null };
    });
    let overrides = {};
    modal({ title: 'Nova prescrição', wide: true, body, actions: [{ label: 'Cancelar' }, { label: 'Assinar prescrição', class: 'primary', onClick: async () => {
      $$('.field-error', body).forEach((x) => x.remove());
      try {
        const r = await api.post(`/clinical/appointments/${id}/prescriptions`, { valid_hours: body.querySelector('[name=valid_hours]').value, notes: body.querySelector('[name=notes]').value || null, items: collect(overrides) });
        toast(`Prescrição assinada. ${r.scheduled} horário(s) aprazado(s).`, 'ok'); reload();
      } catch (err) {
        const conflicts = err.details?.allergy_conflicts;
        if (conflicts) {
          render($('[data-alert]', body), html`<div class="alert danger"><strong>ALERTA DE ALERGIA</strong>${conflicts.map((c) => html`<div class="mt">Item ${c.item}: ${c.description} — alergia a ${c.allergies.join(', ')}
            <input class="mt" data-ovr="${c.item}" placeholder="Justificativa clínica para manter (mín. 10 caracteres) ou remova o item"></div>`)}</div>`);
          $$('[data-ovr]', body).forEach((i) => i.addEventListener('input', () => { overrides[i.dataset.ovr] = i.value; }));
          overrides = {};
        }
        throw err;
      }
    } }] });
  });
}

// ------------------------------------------------------------------ Alergias
async function alergias(box, { ctx, reload }) {
  const list = await api.get(`/clinical/patients/${ctx.patient_id}/allergies`);
  render(box, html`<div class="card"><div class="row between"><h2>Alergias e reações adversas</h2>${can('clinical.allergies') ? html`<button class="btn primary" data-new>+ Registrar alergia</button>` : ''}</div>
    ${table([{ label: 'Substância', render: (a) => html`<strong>${a.substance}</strong>` }, { label: 'Reação', render: (a) => a.reaction || '—' },
      { label: 'Gravidade', render: (a) => html`<span class="badge ${a.severity === 'GRAVE' ? 'danger' : a.severity === 'MODERADA' ? 'warn' : 'info'}">${a.severity}</span>` },
      { label: 'Registro', render: (a) => html`${a.created_by_name || '—'} · ${datetime(a.created_at)}` }, { label: 'Situação', render: (a) => (a.active ? html`<span class="badge danger">Ativa</span>` : html`<span class="badge">Inativa</span>`) },
      { label: '', render: (a) => (a.active && can('clinical.allergies') ? html`<button class="btn sm" data-off="${a.id}">Inativar</button>` : '') }], list, { empty: 'Nenhuma alergia registrada.' })}
    <p class="small muted">Alergias ativas aparecem na barra do paciente e são verificadas automaticamente na prescrição.</p></div>`);
  on(box, 'click', '[data-new]', () => formDialog({ title: 'Registrar alergia', fields: [
    { name: 'substance', label: 'Substância / alérgeno *', required: true }, { name: 'reaction', label: 'Reação' },
    { name: 'severity', label: 'Gravidade', type: 'select', value: 'MODERADA', options: [{ value: 'LEVE', label: 'Leve' }, { value: 'MODERADA', label: 'Moderada' }, { value: 'GRAVE', label: 'Grave' }] }],
  onSubmit: async (v) => { await api.post(`/clinical/patients/${ctx.patient_id}/allergies`, v); toast('Alergia registrada.', 'ok'); reload(); } }));
  on(box, 'click', '[data-off]', (e, b) => formDialog({ title: 'Inativar alergia', fields: [{ name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
    onSubmit: async (v) => { await api.post(`/clinical/allergies/${b.dataset.off}/deactivate`, v); toast('Alergia inativada.', 'ok'); reload(); } }));
}

// ------------------------------------------------------------------ Sinais vitais
async function sinais(box, { id, reload, active }) {
  const rows = await api.get(`/clinical/appointments/${id}/vitals`);
  render(box, html`
    ${can('nursing.vitals') ? html`<div class="card"><h2>Registrar sinais vitais</h2><form data-form class="form-grid">
      ${[['systolic', 'PA sistólica (mmHg)'], ['diastolic', 'PA diastólica (mmHg)'], ['heart_rate', 'FC (bpm)'], ['resp_rate', 'FR (irpm)'], ['spo2', 'SpO2 (%)']].map(([n, l]) => html`<div data-field="${n}"><label>${l}</label><input name="${n}" type="number"></div>`)}
      <div data-field="temperature"><label>Temperatura (°C)</label><input name="temperature" placeholder="36,5"></div>
      <div data-field="glucose"><label>Glicemia (mg/dL)</label><input name="glucose" type="number"></div>
      <div data-field="pain_score"><label>Dor (0–10)</label><input name="pain_score" type="number" min="0" max="10"></div>
      <div data-field="weight_kg"><label>Peso (kg)</label><input name="weight_kg" placeholder="70,5"></div>
      <div><label>Consciência (ACVPU)</label><select name="consciousness"><option value="A">A — Alerta</option><option value="C">C — Confusão nova</option><option value="V">V — Voz</option><option value="P">P — Dor</option><option value="U">U — Sem resposta</option></select></div>
      <div><label>O2 suplementar</label><select name="on_oxygen"><option value="false">Não</option><option value="true">Sim</option></select></div>
      <div class="full row end"><button class="btn primary" ${active ? '' : 'disabled'}>Registrar</button></div></form></div>` : ''}
    <div class="card"><h2>Histórico</h2>${table([
    { label: 'Data/hora', render: (v) => datetime(v.measured_at) }, { label: 'PA', render: (v) => (v.systolic ? `${v.systolic}x${v.diastolic ?? '—'}` : '—') },
    { label: 'FC', render: (v) => v.heart_rate ?? '—' }, { label: 'FR', render: (v) => v.resp_rate ?? '—' }, { label: 'SpO2', render: (v) => (v.spo2 != null ? `${v.spo2}%${v.on_oxygen ? ' (O2)' : ''}` : '—') },
    { label: 'Temp.', render: (v) => temp(v.temp_tenths) }, { label: 'Glic.', render: (v) => v.glucose ?? '—' }, { label: 'Dor', render: (v) => v.pain_score ?? '—' },
    { label: 'Consc.', key: 'consciousness' }, { label: 'NEWS', render: (v) => newsBadge(v.news_score, v.news_risk) }, { label: 'Por', key: 'user_name' },
  ], rows, { empty: 'Nenhuma aferição.' })}</div>`);
  const form = $('[data-form]', box);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      const fd = Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => v !== ''));
      fd.on_oxygen = fd.on_oxygen === 'true';
      try {
        const r = await api.post(`/clinical/appointments/${id}/vitals`, fd);
        const n = r.news;
        toast(n.complete ? `NEWS ${n.score} (${NEWS_LABEL[n.risk]}). ${n.action}` : 'Sinais registrados (NEWS requer FR, SpO2, PA, FC e temperatura).', n.complete && ['MEDIO', 'ALTO'].includes(n.risk) ? 'error' : 'ok');
        reload();
      } catch (err) { markErrors(form, err); throw err; }
    });
  });
}

// ------------------------------------------------------------------ Checagem
export function openCheck(row, onDone) {
  formDialog({
    title: `Checagem — ${row.description}`,
    intro: html`<div class="alert info"><strong>${row.patient_name}</strong> · ${row.bed_code || ''} · horário ${datetime(row.scheduled_at)}<br>${[row.dose, row.route].filter(Boolean).join(' · ')} ${row.instructions || ''}
      <div class="small mt">Confira os 9 certos: paciente, medicamento, dose, via, horário, registro, ação, forma e resposta.</div></div>`,
    fields: [
      { name: 'confirm_patient', label: 'Leitura da pulseira (prontuário ou código do paciente) *', required: true, placeholder: 'PRT000000' },
      { name: 'status', label: 'Resultado', type: 'select', options: [{ value: 'ADMINISTRADO', label: 'Administrado' }, { value: 'NAO_ADMINISTRADO', label: 'Não administrado' }] },
      { name: 'lot', label: 'Lote (opcional)' },
      { name: 'reason', label: 'Observação / motivo (obrigatório se não administrado ou com atraso)', type: 'textarea', full: true },
    ],
    submit: 'Checar',
    onSubmit: async (v) => { await api.post(`/clinical/administrations/${row.id}/check`, v); toast('Checagem registrada.', 'ok'); onDone?.(); },
  });
}

async function checagem(box, { id, reload, active, sched }) {
  const presc = await api.get(`/clinical/appointments/${id}/prescriptions`);
  const sn = presc.filter((p) => p.status === 'ATIVA').flatMap((p) => p.items.filter((i) => i.if_needed && i.status === 'ATIVO'));
  const admin = can('nursing.administer');
  render(box, html`<div class="card"><h2>Aprazamento e checagem</h2>
    ${table([{ label: 'Horário', render: (r) => html`<strong>${hhmm(r.scheduled_at)}</strong><div class="small muted">${date(r.scheduled_at)}</div>` },
      { label: 'Item', render: (r) => html`${r.description}<div class="small muted">${[r.dose, r.route].filter(Boolean).join(' · ')} ${r.instructions || ''}</div>` },
      { label: 'Status', render: (r) => html`<span class="badge ${r.status === 'ADMINISTRADO' ? 'ok' : r.status === 'PENDENTE' ? (r.overdue ? 'danger' : 'warn') : 'danger'}">${ADM_LABEL[r.status]}${r.overdue ? ' (atrasado)' : ''}</span>${r.reason ? html`<div class="small muted">${r.reason}</div>` : ''}` },
      { label: 'Checado por', render: (r) => (r.performed_by_name ? html`${r.performed_by_name}<div class="small muted">${datetime(r.performed_at)}${r.is_late ? ' · atraso' : ''}${r.lot ? ` · lote ${r.lot}` : ''}</div>` : '—') },
      { label: '', render: (r) => (admin && active && r.status === 'PENDENTE' ? html`<button class="btn sm primary" data-check="${r.id}">Checar</button>` : '') }],
    sched, { empty: 'Nenhum horário aprazado nas próximas/últimas 12 h.', rowClass: (r) => (r.overdue ? 'overdue' : '') })}</div>
    <div class="card"><h2>Itens "se necessário" (SN)</h2>${table([{ label: 'Item', render: (i) => html`<strong>${i.description}</strong><div class="small muted">${[i.dose, i.route].filter(Boolean).join(' · ')} ${i.instructions || ''}</div>` },
      { label: 'Intervalo mínimo', render: (i) => (i.frequency_hours ? `${i.frequency_hours} h` : '—') }, { label: 'Doses', key: 'done' },
      { label: '', render: (i) => (admin && active ? html`<button class="btn sm" data-sn="${i.id}">Registrar dose</button>` : '') }], sn, { empty: 'Nenhum item SN ativo.' })}</div>`);
  on(box, 'click', '[data-check]', (e, b) => openCheck({ ...sched.find((s) => String(s.id) === b.dataset.check) }, reload));
  on(box, 'click', '[data-sn]', (e, b) => formDialog({ title: 'Dose "se necessário"', fields: [
    { name: 'confirm_patient', label: 'Leitura da pulseira *', required: true }, { name: 'reason', label: 'Indicação (ex.: febre 38,4 °C) *', required: true }, { name: 'lot', label: 'Lote' }],
  onSubmit: async (v) => { await api.post(`/clinical/prescription-items/${b.dataset.sn}/administer`, v); toast('Dose registrada.', 'ok'); reload(); } }));
}

// ------------------------------------------------------------------ SAE
async function sae(box, { id, reload, active }) {
  const [plan, defs] = await Promise.all([api.get(`/nursing/appointments/${id}/care-plan`), api.get('/nursing/definitions')]);
  const a = plan.active;
  const canEdit = can('nursing.sae') && active;
  render(box, html`
    ${a ? html`<div class="card"><h2>SAE vigente</h2><div class="small muted mb">${a.author_name}${a.council ? ` · ${a.council} ${a.council_number}` : ''} · ${datetime(a.created_at)}</div>
      ${a.history ? html`<h3>Histórico de enfermagem</h3><p class="txt">${a.history}</p>` : ''}
      <h3>Diagnósticos de enfermagem</h3><ul>${a.diagnoses.map((d) => html`<li>${d}</li>`)}</ul>
      ${a.goals ? html`<h3>Resultados esperados</h3><p>${a.goals}</p>` : ''}
      <h3>Intervenções / prescrição de enfermagem</h3><ul>${a.interventions.map((d) => html`<li>${d}</li>`)}</ul></div>` : html`<div class="card"><div class="alert warn">Nenhuma SAE elaborada para este atendimento.</div></div>`}
    ${canEdit ? html`<div class="card"><h2>${a ? 'Atualizar SAE (substitui a vigente)' : 'Elaborar SAE'}</h2><form data-form class="stack">
      <div data-field="history"><label>Histórico / avaliação de enfermagem</label><textarea name="history">${a?.history || ''}</textarea></div>
      <div data-field="diagnoses"><label>Diagnósticos de enfermagem *</label><div class="chips">${defs.diagnoses.map((d) => html`<label><input type="checkbox" name="dx" value="${d}" ${a?.diagnoses.includes(d) ? 'checked' : ''}>${d}</label>`)}</div>
        <input class="mt" name="dx_other" placeholder="Outros diagnósticos (separe por ;)" value="${(a?.diagnoses || []).filter((d) => !defs.diagnoses.includes(d)).join('; ')}"></div>
      <div data-field="goals"><label>Resultados esperados</label><textarea name="goals">${a?.goals || ''}</textarea></div>
      <div data-field="interventions"><label>Intervenções de enfermagem * (uma por linha)</label><textarea name="interventions" rows="6">${(a?.interventions || []).join('\n')}</textarea></div>
      <div class="row end"><button class="btn primary">Salvar SAE</button></div></form></div>` : ''}
    ${plan.history.length > 1 ? html`<div class="card"><h2>Versões anteriores</h2>${plan.history.filter((h) => h.status !== 'ATIVO').map((h) => html`<div class="small">${datetime(h.created_at)} · ${h.author_name} · ${h.diagnoses.join(', ')}</div>`)}</div>` : ''}`);
  const form = $('[data-form]', box);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      const diagnoses = [...$$('[name=dx]:checked', form).map((c) => c.value), ...form.querySelector('[name=dx_other]').value.split(';').map((s) => s.trim()).filter(Boolean)];
      const interventions = form.querySelector('[name=interventions]').value.split('\n').map((s) => s.trim()).filter(Boolean);
      try { await api.post(`/nursing/appointments/${id}/care-plan`, { history: form.querySelector('[name=history]').value, goals: form.querySelector('[name=goals]').value, diagnoses, interventions }); toast('SAE salva.', 'ok'); reload(); } catch (err) { markErrors(form, err); throw err; }
    });
  });
}

// ------------------------------------------------------------------ Escalas
async function escalas(box, { id, reload, active }) {
  const [rows, defs] = await Promise.all([api.get(`/nursing/appointments/${id}/scales`), api.get('/nursing/definitions')]);
  const canApply = can('nursing.scales') && active;
  const opts = (it) => (it.allowed || Array.from({ length: it.max - it.min + 1 }, (_, i) => it.min + i));
  render(box, html`
    ${canApply ? html`<div class="card"><h2>Aplicar escala</h2><div class="row mb"><select data-scale>${Object.entries(defs.scales).map(([k, s]) => html`<option value="${k}">${s.title}</option>`)}</select></div>
      <form data-form class="form-grid"></form></div>` : ''}
    <div class="card"><h2>Avaliações</h2>${table([{ label: 'Data', render: (s) => datetime(s.created_at) }, { label: 'Escala', key: 'scale' }, { label: 'Escore', render: (s) => html`<strong>${s.score}</strong>` },
      { label: 'Risco', render: (s) => html`<span class="badge ${['ALTO', 'MUITO_ALTO', 'GRAVE'].includes(s.risk) ? 'danger' : s.risk === 'MODERADO' ? 'warn' : 'ok'}">${RISK_LABEL[s.risk] || s.risk}</span>` }, { label: 'Por', key: 'user_name' }], rows, { empty: 'Nenhuma escala aplicada.' })}</div>`);
  const form = $('[data-form]', box);
  if (!form) return;
  const draw = () => {
    const k = $('[data-scale]', box).value; const s = defs.scales[k];
    render(form, html`${Object.entries(s.items).map(([name, it]) => html`<div data-field="${name}"><label>${it.label}</label><select name="${name}">${opts(it).map((o) => html`<option>${o}</option>`)}</select></div>`)}
      <div class="full row end"><button class="btn primary">Calcular e registrar</button></div>`);
  };
  $('[data-scale]', box).addEventListener('change', draw); draw();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      const answers = Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, Number(v)]));
      const r = await api.post(`/nursing/appointments/${id}/scales`, { scale: $('[data-scale]', box).value, answers });
      toast(`${r.scale}: ${r.score} — risco ${RISK_LABEL[r.risk] || r.risk}.`, 'ok'); reload();
    });
  });
}

// ------------------------------------------------------------------ Balanço hídrico
async function balanco(box, { id, reload, active }) {
  const f = await api.get(`/nursing/appointments/${id}/fluids`, { hours: 24 });
  render(box, html`<div class="grid k4 mb">
      <div class="card kpi"><div class="label">Entradas (24 h)</div><div class="big-number">${f.in_ml} mL</div></div>
      <div class="card kpi"><div class="label">Saídas (24 h)</div><div class="big-number">${f.out_ml} mL</div></div>
      <div class="card kpi ${Math.abs(f.balance_ml) > 1500 ? 'alert' : ''}"><div class="label">Balanço</div><div class="big-number">${f.balance_ml > 0 ? '+' : ''}${f.balance_ml} mL</div></div></div>
    ${can('nursing.fluids') ? html`<div class="card"><h2>Registrar</h2><form data-form class="form-grid">
      <div><label>Tipo</label><select name="direction"><option value="ENTRADA">Entrada</option><option value="SAIDA">Saída</option></select></div>
      <div data-field="kind"><label>Via / origem *</label><input name="kind" list="fluid-kinds"><datalist id="fluid-kinds">${['Oral', 'Soro / infusão EV', 'Dieta enteral', 'Hemoderivado', 'Diurese', 'Dreno', 'Vômito', 'Evacuação', 'Sonda gástrica'].map((k) => html`<option value="${k}">`)}</datalist></div>
      <div data-field="volume_ml"><label>Volume (mL) *</label><input name="volume_ml" type="number" min="1"></div>
      <div class="row end"><button class="btn primary" ${active ? '' : 'disabled'}>Registrar</button></div></form></div>` : ''}
    <div class="card">${table([{ label: 'Data/hora', render: (e) => datetime(e.recorded_at) }, { label: 'Tipo', render: (e) => html`<span class="badge ${e.direction === 'ENTRADA' ? 'info' : 'warn'}">${e.direction}</span>` },
      { label: 'Via/origem', key: 'kind' }, { label: 'Volume', class: 'money', render: (e) => `${e.volume_ml} mL` }, { label: 'Por', key: 'user_name' }], f.entries, { empty: 'Sem registros nas últimas 24 h.' })}</div>`);
  const form = $('[data-form]', box);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      try { await api.post(`/nursing/appointments/${id}/fluids`, Object.fromEntries(new FormData(form).entries())); toast('Registrado.', 'ok'); reload(); } catch (err) { markErrors(form, err); throw err; }
    });
  });
}

// ------------------------------------------------------------------ Passagem de plantão
async function plantao(box, { id, reload, active }) {
  const rows = await api.get('/nursing/handoffs', { appointment_id: id, hours: 168 });
  const h = new Date().getHours(); const shift = h < 13 ? 'MANHA' : h < 19 ? 'TARDE' : 'NOITE';
  render(box, html`
    ${can('nursing.handoff') ? html`<div class="card"><h2>Registrar passagem de plantão (SBAR)</h2><form data-form class="stack">
      <div class="form-grid"><div><label>Plantão</label><select name="shift">${['MANHA', 'TARDE', 'NOITE'].map((s) => html`<option value="${s}" ${s === shift ? 'selected' : ''}>${s === 'MANHA' ? 'Manhã' : s === 'TARDE' ? 'Tarde' : 'Noite'}</option>`)}</select></div></div>
      <div data-field="situation"><label>S — Situação *</label><textarea name="situation" placeholder="Estado atual, queixas, intercorrências do plantão"></textarea></div>
      <div><label>B — Breve histórico</label><textarea name="background" placeholder="Diagnóstico, procedimentos, dispositivos, alergias"></textarea></div>
      <div><label>A — Avaliação</label><textarea name="assessment" placeholder="Sinais vitais, escalas, riscos, pendências"></textarea></div>
      <div><label>R — Recomendação</label><textarea name="recommendation" placeholder="O que o próximo plantão deve fazer/observar"></textarea></div>
      <div class="row end"><button class="btn primary" ${active ? '' : 'disabled'}>Registrar</button></div></form></div>` : ''}
    <div class="card"><h2>Passagens registradas (7 dias)</h2>${rows.length ? rows.map((x) => html`<div class="note"><div class="meta"><span><strong>Plantão ${x.shift.toLowerCase()}</strong></span><span>${x.author_name} · ${datetime(x.created_at)}</span></div>
      <div class="txt"><strong>S:</strong> ${x.situation}${x.background ? html`\n<strong>B:</strong> ${x.background}` : ''}${x.assessment ? html`\n<strong>A:</strong> ${x.assessment}` : ''}${x.recommendation ? html`\n<strong>R:</strong> ${x.recommendation}` : ''}</div></div>`) : html`<div class="empty">Nenhuma passagem registrada.</div>`}</div>`);
  const form = $('[data-form]', box);
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      try { await api.post(`/nursing/appointments/${id}/handoffs`, Object.fromEntries(new FormData(form).entries())); toast('Passagem de plantão registrada.', 'ok'); reload(); } catch (err) { markErrors(form, err); throw err; }
    });
  });
}

// ------------------------------------------------------------------ Movimentações
async function movimentacoes(box, { id }) {
  const rows = await api.get(`/clinical/appointments/${id}/movements`);
  render(box, html`<div class="card"><h2>Movimentação de leitos</h2>${table([{ label: 'Data', render: (m) => datetime(m.created_at) }, { label: 'Tipo', key: 'kind' },
    { label: 'De', render: (m) => m.from_bed || '—' }, { label: 'Para', render: (m) => m.to_bed || '—' }, { label: 'Motivo', render: (m) => m.reason || '—' }, { label: 'Usuário', render: (m) => m.user_name || '—' }],
  rows, { empty: 'Paciente não internado em leito. Use o Mapa de leitos para internar.' })}</div>`);
}
