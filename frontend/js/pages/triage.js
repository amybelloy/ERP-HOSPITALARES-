// Classificação de risco (pronto atendimento): fila por prioridade de cor e tempo-alvo.
import { api } from '../api.js';
import { html, render, $, on, fresh, toast, showError, busy, datetime, table, markErrors } from '../ui.js';
import { can } from '../state.js';
import { TRIAGE, triageTag } from '../clinical.js';

const FLOWCHARTS = ['Dor torácica', 'Dispneia', 'Dor abdominal', 'Cefaleia', 'Febre', 'Trauma', 'Mal-estar em adulto', 'Problemas em extremidades',
  'Convulsão', 'Sangramento', 'Alteração do nível de consciência', 'Gestante', 'Criança irritadiça', 'Outro'];

export async function triage(host) {
  const el = fresh(host);
  const reload = () => triage(host).catch(showError);
  const [queue, active] = await Promise.all([api.get('/clinical/triage'), api.get('/clinical/patients')]);
  const pending = active.filter((p) => !p.triage_color && !p.bed_code);
  render(el, html`
    <div class="page-head"><div><h1>Classificação de risco</h1><div class="muted">Protocolo por cores · ordem de atendimento por prioridade e chegada</div></div><button class="btn" data-refresh>Atualizar</button></div>
    <div class="legend mb">${Object.entries(TRIAGE).map(([c, t]) => html`<span>${triageTag(c)} <span class="muted">${t.target}</span></span>`)}</div>
    ${can('triage.perform') ? html`<div class="card"><h2>Classificar paciente</h2>
      <form data-form class="stack">
        <div class="form-grid">
          <div class="span2" data-field="appointment_id"><label>Atendimento aguardando classificação *</label><select name="appointment_id"><option value="">Selecione…</option>${pending.map((p) => html`<option value="${p.appointment_id}">${p.number} — ${p.patient_name} (${p.age ?? '—'} anos)</option>`)}</select></div>
          <div data-field="flowchart"><label>Fluxograma (queixa)</label><select name="flowchart"><option value="">—</option>${FLOWCHARTS.map((f) => html`<option>${f}</option>`)}</select></div>
          <div data-field="pain_score"><label>Dor (0–10)</label><input name="pain_score" type="number" min="0" max="10"></div>
          <div class="full" data-field="chief_complaint"><label>Queixa principal *</label><input name="chief_complaint"></div>
          <div class="full" data-field="discriminator"><label>Discriminador</label><input name="discriminator" placeholder="Ex.: dor precordial intensa, SpO2 < 90%, febre alta…"></div>
        </div>
        <div data-field="color"><label>Classificação *</label><div class="triage-colors">${Object.entries(TRIAGE).map(([c, t]) => html`<label class="tc-${c}"><input type="radio" name="color" value="${c}"><strong>${c}</strong><small>${t.label} · ${t.target}</small></label>`)}</div></div>
        <div><label>Sinais vitais na triagem</label><div class="form-grid">
          <div><label>PA sistólica</label><input name="systolic" type="number"></div><div><label>PA diastólica</label><input name="diastolic" type="number"></div>
          <div><label>FC (bpm)</label><input name="heart_rate" type="number"></div><div><label>FR (irpm)</label><input name="resp_rate" type="number"></div>
          <div><label>SpO2 (%)</label><input name="spo2" type="number"></div><div><label>Temperatura (°C)</label><input name="temperature" placeholder="36,5"></div>
          <div><label>Glicemia</label><input name="glucose" type="number"></div>
          <div><label>Consciência</label><select name="consciousness"><option value="A">Alerta</option><option value="C">Confusão nova</option><option value="V">Responde à voz</option><option value="P">Responde à dor</option><option value="U">Não responde</option></select></div>
        </div></div>
        <div class="row end"><button class="btn primary" type="submit">Registrar classificação</button></div>
      </form>
      ${!pending.length ? html`<p class="small muted">Nenhum atendimento aberto aguardando classificação. Abra o atendimento (tipo Urgência) em "Atendimento".</p>` : ''}</div>` : ''}
    <div class="card"><h2>Fila de atendimento</h2>
      ${table([
    { label: 'Classificação', render: (t) => triageTag(t.color) },
    { label: 'Paciente', render: (t) => html`<a href="#/pep/${t.appointment_id}">${t.patient_name}</a><div class="small muted">${t.appointment_number} · ${t.age ?? '—'} anos</div>` },
    { label: 'Queixa', render: (t) => html`${t.chief_complaint}<div class="small muted">${t.flowchart || ''} ${t.discriminator ? `· ${t.discriminator}` : ''}</div>` },
    { label: 'Chegada', render: (t) => datetime(t.created_at) },
    { label: 'Espera', render: (t) => html`<strong>${t.wait_minutes} min</strong> / meta ${t.target_minutes} min${t.overdue ? html` <span class="badge danger">acima da meta</span>` : ''}` },
    { label: 'Status', render: (t) => html`<span class="badge ${t.status === 'EM_ATENDIMENTO' ? 'info' : 'warn'}">${t.status === 'EM_ATENDIMENTO' ? 'Em atendimento' : 'Aguardando'}</span>` },
    { label: '', render: (t) => html`<div class="btn-group">${t.status === 'AGUARDANDO' ? html`<button class="btn sm primary" data-st="EM_ATENDIMENTO" data-id="${t.id}">Chamar</button>` : html`<button class="btn sm" data-st="ATENDIDO" data-id="${t.id}">Concluir</button>`}
      <button class="btn sm danger" data-st="EVADIU" data-id="${t.id}">Evasão</button></div>` },
  ], queue, { empty: 'Fila vazia.', rowClass: (t) => `row-${t.color} ${t.overdue ? 'overdue' : ''}` })}</div>`);

  on(el, 'click', '[data-refresh]', reload);
  on(el, 'click', '[data-st]', (e, b) => busy(b, async () => { await api.post(`/clinical/triage/${b.dataset.id}/status`, { status: b.dataset.st }); reload(); }));
  const form = $('[data-form]', el);
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form).entries());
    const vitals = Object.fromEntries(['systolic', 'diastolic', 'heart_rate', 'resp_rate', 'spo2', 'temperature', 'glucose', 'consciousness'].map((k) => [k, fd[k] || null]));
    if (!vitals.systolic && !vitals.heart_rate && !vitals.resp_rate && !vitals.spo2 && !vitals.temperature && !vitals.glucose) delete vitals.consciousness;
    form.querySelectorAll('.field-error').forEach((x) => x.remove());
    try {
      const r = await api.post('/clinical/triage', { appointment_id: fd.appointment_id || null, color: fd.color || null, chief_complaint: fd.chief_complaint, flowchart: fd.flowchart || null,
        discriminator: fd.discriminator || null, pain_score: fd.pain_score || null, vitals });
      toast(`Classificado como ${r.color}.${r.vitals?.news?.complete ? ` NEWS ${r.vitals.news.score}.` : ''}`, 'ok'); reload();
    } catch (err) { markErrors(form, err); showError(err); }
  });
}
