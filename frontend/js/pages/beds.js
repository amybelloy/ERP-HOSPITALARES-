// Mapa / painel de leitos: ocupação por unidade, internação, transferência, alta e higienização.
import { api } from '../api.js';
import { html, render, on, fresh, modal, toast, showError, formDialog, setWidth, $$ } from '../ui.js';
import { can } from '../state.js';
import { BED_LABEL, NEWS_LABEL } from '../clinical.js';

export async function beds(host) {
  const el = fresh(host);
  const reload = () => beds(host).catch(showError);
  const map = await api.get('/clinical/beds');
  const s = map.summary;
  render(el, html`
    <div class="page-head"><div><h1>Mapa de leitos</h1><div class="muted">Ocupação em tempo real por unidade de internação</div></div>
      <button class="btn" data-refresh>Atualizar</button></div>
    <div class="grid k4 mb">
      <div class="card kpi"><div class="label">Taxa de ocupação</div><div class="value">${map.occupancy_pct}%</div><div class="bar mt"><span data-w="${map.occupancy_pct}"></span></div></div>
      <div class="card kpi"><div class="label">Livres</div><div class="value">${s.LIVRE || 0}</div><div class="sub">de ${map.total} leitos</div></div>
      <div class="card kpi"><div class="label">Ocupados</div><div class="value">${s.OCUPADO || 0}</div></div>
      <div class="card kpi"><div class="label">Em higienização</div><div class="value">${s.HIGIENIZACAO || 0}</div></div>
      <div class="card kpi"><div class="label">Bloqueados / manutenção</div><div class="value">${(s.MANUTENCAO || 0) + (s.BLOQUEADO || 0)}</div></div>
    </div>
    <div class="legend mb"><span class="lg-l">Livre</span><span class="lg-o">Ocupado</span><span class="lg-h">Higienização</span><span class="lg-r">Reservado</span><span class="lg-m">Manutenção/bloqueado</span></div>
    <div class="bed-units">${map.units.map((u) => html`<div class="card"><div class="row between"><h2>${u.name}</h2><span class="small muted">${u.beds.filter((b) => b.status === 'OCUPADO').length}/${u.beds.length} ocupados</span></div>
      <div class="bed-grid">${u.beds.map((b) => html`<div class="bed ${b.status}" data-bed="${b.id}" tabindex="0">
        <div class="code"><span>${b.code}</span>${b.allergies ? html`<span title="Alergia registrada">⚠</span>` : ''}</div>
        <div class="st">${BED_LABEL[b.status]}${b.status !== 'OCUPADO' && b.hours_in_status ? ` · ${b.hours_in_status} h` : ''}</div>
        ${b.status === 'OCUPADO' ? html`<div class="pt">${b.patient_name}</div><div class="small muted">${b.age ?? '—'} anos · ${b.sex || ''} · ${b.appointment_number}</div>
          ${b.news_risk ? html`<div><span class="news ${b.news_risk}">NEWS ${NEWS_LABEL[b.news_risk]}</span></div>` : ''}` : html`<div class="small muted">${b.notes || ''}</div>`}
      </div>`)}</div></div>`)}</div>`);
  $$('[data-w]', el).forEach((x) => setWidth(x, Number(x.dataset.w)));
  on(el, 'click', '[data-refresh]', reload);
  const allBeds = map.units.flatMap((u) => u.beds.map((b) => ({ ...b, unit: u.name })));
  on(el, 'click', '[data-bed]', (e, t) => openBed(allBeds.find((b) => String(b.id) === t.dataset.bed), allBeds, reload).catch(showError));
}

async function openBed(b, allBeds, reload) {
  const manage = can('beds.manage');
  const free = allBeds.filter((x) => ['LIVRE', 'RESERVADO'].includes(x.status) && x.id !== b.id);
  if (b.status === 'OCUPADO') {
    modal({ title: `Leito ${b.code} — ${b.patient_name}`, body: html`<p>${b.unit} · Atendimento ${b.appointment_number}</p>`, actions: [
      { label: 'Abrir prontuário (PEP)', class: 'primary', onClick: () => { location.hash = `#/pep/${b.current_appointment_id}`; } },
      ...(manage ? [
        { label: 'Transferir', onClick: () => formDialog({ title: `Transferir ${b.patient_name}`, fields: [
          { name: 'to_bed_id', label: 'Leito de destino', type: 'select', options: free.map((x) => ({ value: x.id, label: `${x.unit} — ${x.code}` })) },
          { name: 'reason', label: 'Motivo *', type: 'textarea', full: true }],
        onSubmit: async (v) => { await api.post('/clinical/beds/transfer', { appointment_id: b.current_appointment_id, ...v }); toast('Paciente transferido.', 'ok'); reload(); } }) },
        { label: 'Alta / óbito', class: 'danger', onClick: () => formDialog({ title: `Saída do leito — ${b.patient_name}`, fields: [
          { name: 'kind', label: 'Tipo', type: 'select', options: [{ value: 'ALTA', label: 'Alta hospitalar' }, { value: 'OBITO', label: 'Óbito' }] },
          { name: 'reason', label: 'Tipo/motivo (ex.: alta melhorada, a pedido, transferência externa) *', type: 'textarea', full: true }],
        intro: html`<div class="alert warn">A alta encerra prescrições ativas, suspende horários pendentes e envia o leito para higienização.</div>`,
        onSubmit: async (v) => { await api.post('/clinical/beds/discharge', { appointment_id: b.current_appointment_id, ...v }); toast('Saída registrada.', 'ok'); reload(); } }) },
      ] : []),
    ] });
    return;
  }
  const actions = [];
  if (manage && ['LIVRE', 'RESERVADO'].includes(b.status)) {
    actions.push({ label: 'Internar paciente', class: 'primary', onClick: async () => {
      const pts = (await api.get('/clinical/patients')).filter((p) => !p.bed_code);
      formDialog({ title: `Internar no leito ${b.code}`, fields: [
        { name: 'appointment_id', label: 'Atendimento em aberto (sem leito)', type: 'select', options: pts.length ? pts.map((p) => ({ value: p.appointment_id, label: `${p.number} — ${p.patient_name}` })) : [{ value: '', label: 'Nenhum atendimento aberto sem leito' }] },
        { name: 'reason', label: 'Motivo / diagnóstico de internação', type: 'textarea', full: true }],
      intro: html`<div class="small muted">O atendimento deve ser aberto antes em "Atendimento" (tipo Internação, Urgência etc.).</div>`,
      onSubmit: async (v) => { await api.post('/clinical/beds/admit', { bed_id: b.id, ...v }); toast('Paciente internado.', 'ok'); reload(); } });
    } });
  }
  if (manage) {
    const next = { LIVRE: ['RESERVADO', 'MANUTENCAO', 'BLOQUEADO'], HIGIENIZACAO: ['LIVRE', 'MANUTENCAO'], MANUTENCAO: ['LIVRE', 'BLOQUEADO'], BLOQUEADO: ['LIVRE'], RESERVADO: ['LIVRE'] }[b.status] || [];
    next.forEach((st) => actions.push({ label: st === 'LIVRE' && b.status === 'HIGIENIZACAO' ? 'Higienização concluída → liberar' : `Marcar como ${BED_LABEL[st].toLowerCase()}`,
      onClick: async () => { await api.post(`/clinical/beds/${b.id}/status`, { status: st }); toast('Leito atualizado.', 'ok'); reload(); } }));
  }
  modal({ title: `Leito ${b.code} — ${BED_LABEL[b.status]}`, body: html`<p>${b.unit}${b.notes ? ` · ${b.notes}` : ''}</p>${actions.length ? '' : html`<p class="muted">Sem ações disponíveis para seu perfil.</p>`}`, actions });
}

