// ÁREA DE ENFERMAGEM: painel da unidade, checagem (aprazamento) e passagem de plantão.
import { api } from '../api.js';
import { html, render, $, on, fresh, showError, datetime, table } from '../ui.js';
import { newsBadge, triageTag, RISK_LABEL, ADM_LABEL, hhmm } from '../clinical.js';
import { openCheck } from './pep.js';

export async function nursing(host, { params }) {
  const el = fresh(host);
  const map = await api.get('/clinical/beds');
  const unitId = params.unidade || '';
  const tab = params.aba || 'painel';
  const go = (p) => { location.hash = `#/enfermagem?${new URLSearchParams({ unidade: unitId, aba: tab, ...p })}`; };
  render(el, html`
    <div class="page-head"><div><h1>Área de enfermagem</h1><div class="muted">Painel assistencial da unidade, checagem de medicamentos e passagem de plantão</div></div>
      <div class="row"><label class="small">Unidade</label><select data-unit><option value="">Todas</option>${map.units.map((u) => html`<option value="${u.id}" ${String(u.id) === unitId ? 'selected' : ''}>${u.name}</option>`)}</select></div></div>
    <div class="tabs">${[['painel', 'Painel de pacientes'], ['checagem', 'Checagem / aprazamento'], ['plantao', 'Passagem de plantão']].map(([k, l]) => html`<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>
    <div data-body></div>`);
  on(el, 'change', '[data-unit]', (e, s) => go({ unidade: s.value }));
  on(el, 'click', '[data-tab]', (e, b) => go({ aba: b.dataset.tab }));
  const body = $('[data-body]', el);

  if (tab === 'painel') {
    const rows = await api.get('/clinical/patients', { unit_id: unitId });
    const alerts = { news: rows.filter((r) => ['MEDIO', 'ALTO'].includes(r.news_risk)).length, overdue: rows.reduce((a, r) => a + r.overdue, 0),
      due: rows.reduce((a, r) => a + r.due_soon, 0), nosae: rows.filter((r) => r.bed_code && !r.has_sae).length };
    render(body, html`<div class="grid k4 mb">
      <div class="card kpi"><div class="label">Pacientes</div><div class="value">${rows.length}</div></div>
      <div class="card kpi ${alerts.news ? 'alert' : ''}"><div class="label">NEWS médio/alto</div><div class="value">${alerts.news}</div><div class="sub">deterioração clínica</div></div>
      <div class="card kpi ${alerts.overdue ? 'alert' : ''}"><div class="label">Medicações atrasadas</div><div class="value">${alerts.overdue}</div><div class="sub">${alerts.due} nas próximas 2 h</div></div>
      <div class="card kpi ${alerts.nosae ? 'alert' : ''}"><div class="label">Internados sem SAE</div><div class="value">${alerts.nosae}</div></div></div>
      <div class="card">${table([
    { label: 'Leito', render: (r) => html`<strong>${r.bed_code || '—'}</strong><div class="small muted">${r.unit_name || r.sector}</div>` },
    { label: 'Paciente', render: (r) => html`<a href="#/pep/${r.appointment_id}">${r.patient_name}</a>${r.allergies ? html` <span class="badge danger" title="Alergia">⚠ alergia</span>` : ''}<div class="small muted">${r.age ?? '—'} anos · ${r.record_number} · ${r.number}</div>` },
    { label: 'Risco', render: (r) => html`${triageTag(r.triage_color)} ${newsBadge(r.news_score, r.news_risk)}<div class="small muted">SSVV: ${datetime(r.last_vitals_at)}</div>` },
    { label: 'Medicações', render: (r) => html`${r.overdue ? html`<span class="badge danger">${r.overdue} atrasada(s)</span> ` : ''}${r.due_soon ? html`<span class="badge warn">${r.due_soon} em 2 h</span>` : ''}${!r.overdue && !r.due_soon ? html`<span class="muted small">—</span>` : ''}` },
    { label: 'Braden', render: (r) => (r.braden_risk ? html`<span class="badge ${['ALTO', 'MUITO_ALTO'].includes(r.braden_risk) ? 'danger' : r.braden_risk === 'MODERADO' ? 'warn' : 'ok'}">${RISK_LABEL[r.braden_risk]}</span>` : html`<span class="badge warn">não avaliado</span>`) },
    { label: 'Morse', render: (r) => (r.morse_risk ? html`<span class="badge ${r.morse_risk === 'ALTO' ? 'danger' : r.morse_risk === 'MODERADO' ? 'warn' : 'ok'}">${RISK_LABEL[r.morse_risk]}</span>` : html`<span class="badge warn">não avaliado</span>`) },
    { label: 'SAE / prescrição', render: (r) => html`${r.has_sae ? html`<span class="badge ok">SAE</span>` : html`<span class="badge warn">sem SAE</span>`} ${r.has_prescription ? html`<span class="badge ok">prescrição</span>` : html`<span class="badge warn">sem prescrição</span>`}` },
    { label: '', render: (r) => html`<a class="btn sm" href="#/pep/${r.appointment_id}">Abrir PEP</a>` },
  ], rows, { empty: 'Nenhum paciente em atendimento nesta unidade.' })}</div>`);
  } else if (tab === 'checagem') {
    const from = new Date(Date.now() - 6 * 3600e3).toISOString(); const to = new Date(Date.now() + 6 * 3600e3).toISOString();
    const rows = await api.get('/clinical/schedule', { unit_id: unitId, from, to });
    render(body, html`<div class="card"><p class="small muted">Horários das últimas 6 h e próximas 6 h. Atrasados em vermelho. A checagem exige a leitura da pulseira (prontuário ou código do paciente).</p>
      ${table([
    { label: 'Horário', render: (r) => html`<strong>${hhmm(r.scheduled_at)}</strong>` },
    { label: 'Leito / paciente', render: (r) => html`<strong>${r.bed_code || '—'}</strong> ${r.patient_name}<div class="small muted">${r.appointment_number}</div>` },
    { label: 'Item', render: (r) => html`${r.description}<div class="small muted">${[r.dose, r.route, r.frequency_hours ? `${r.frequency_hours}/${r.frequency_hours} h` : ''].filter(Boolean).join(' · ')}${r.instructions ? ` · ${r.instructions}` : ''}</div>` },
    { label: 'Status', render: (r) => html`<span class="badge ${r.status === 'ADMINISTRADO' ? 'ok' : r.status === 'PENDENTE' ? (r.overdue ? 'danger' : 'warn') : 'danger'}">${ADM_LABEL[r.status]}${r.overdue ? ' (atrasado)' : ''}</span>${r.performed_by_name ? html`<div class="small muted">${r.performed_by_name} ${hhmm(r.performed_at)}${r.is_late ? ' · com atraso' : ''}</div>` : ''}` },
    { label: '', render: (r) => (r.status === 'PENDENTE' ? html`<button class="btn sm primary" data-check="${r.id}">Checar</button>` : '') },
  ], rows, { empty: 'Nenhum horário aprazado no período.', rowClass: (r) => (r.overdue ? 'overdue' : '') })}</div>`);
    on(body, 'click', '[data-check]', (e, b) => openCheck(rows.find((r) => String(r.id) === b.dataset.check), () => go({})));
  } else {
    const rows = await api.get('/nursing/handoffs', { unit_id: unitId, hours: 24 });
    render(body, html`<div class="card"><p class="small muted">Passagens de plantão (SBAR) registradas nas últimas 24 h. Para registrar, abra o PEP do paciente → Passagem de plantão.</p>
      ${rows.length ? rows.map((h) => html`<div class="note"><div class="meta"><span><strong>${h.bed_code || '—'} · ${h.patient_name}</strong> · plantão ${h.shift.toLowerCase()}</span><span>${h.author_name} · ${datetime(h.created_at)}</span></div>
        <div class="txt"><strong>S:</strong> ${h.situation}${h.background ? html`\n<strong>B:</strong> ${h.background}` : ''}${h.assessment ? html`\n<strong>A:</strong> ${h.assessment}` : ''}${h.recommendation ? html`\n<strong>R:</strong> ${h.recommendation}` : ''}</div></div>`) : html`<div class="empty">Nenhuma passagem de plantão nas últimas 24 h.</div>`}</div>`);
  }
}
