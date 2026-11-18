import { api } from '../api.js';
import { html, render, $, on, money, datetime, badge, table, modal, toast, showError, today, busy, fresh } from '../ui.js';
import { can } from '../state.js';
import { patientPicker } from '../components.js';

export async function scheduling(host, { params }) {
  const el = fresh(host);
  const manage = can('scheduling.manage');
  render(el, html`
    <div class="page-head"><div><h1>Agendamento</h1><div class="muted">Agenda de consultas e exames</div></div>${manage ? html`<button class="btn primary" data-new>+ Novo agendamento</button>` : ''}</div>
    <div class="card"><div class="filters"><div><label>Data</label><input type="date" data-date value="${params.date || today()}"></div>
      <div><label>Status</label><select data-status><option value="">Todos</option>${['AGENDADO', 'CONFIRMADO', 'ATENDIDO', 'CANCELADO', 'FALTOU'].map((s) => html`<option value="${s}">${s}</option>`)}</select></div>
      <div><button class="btn" data-load>Atualizar</button></div></div></div>
    <div class="card" data-list></div>`);
  const load = async () => {
    const rows = await api.get('/schedulings', { date: $('[data-date]', el).value, status: $('[data-status]', el).value });
    render($('[data-list]', el), table([
      { label: 'Horário', render: (s) => datetime(s.scheduled_at) },
      { label: 'Paciente', render: (s) => html`<a href="#/pacientes/${s.patient_id}">${s.patient_name}</a><div class="small muted">${s.patient_code}</div>` },
      { label: 'Profissional', render: (s) => s.professional_name || '—' },
      { label: 'Procedimento', render: (s) => (s.procedure_name ? html`${s.procedure_name} <span class="small muted">${money(s.price_cents)}</span>` : '—') },
      { label: 'Setor', render: (s) => s.sector || '—' },
      { label: 'Status', render: (s) => badge(s.status) },
      { label: '', render: (s) => (manage && ['AGENDADO', 'CONFIRMADO'].includes(s.status) ? html`<div class="btn-group">
          ${can('appointments.open') ? html`<a class="btn sm primary" href="#/atendimentos/novo?patient=${s.patient_id}&scheduling=${s.id}${s.procedure_id ? `&procedure=${s.procedure_id}` : ''}${s.professional_id ? `&professional=${s.professional_id}` : ''}">Iniciar atendimento</a>` : ''}
          ${s.status === 'AGENDADO' ? html`<button class="btn sm" data-st="CONFIRMADO" data-id="${s.id}">Confirmar</button>` : ''}
          <button class="btn sm" data-st="FALTOU" data-id="${s.id}">Faltou</button>
          <button class="btn sm danger" data-st="CANCELADO" data-id="${s.id}">Cancelar</button></div>` : (s.appointment_id ? html`<span class="small muted">Atendimento gerado</span>` : '')) },
    ], rows, { empty: 'Nenhum agendamento para o filtro.' }));
  };
  on(el, 'click', '[data-st]', (e, b) => busy(b, async () => { await api.post(`/schedulings/${b.dataset.id}/status`, { status: b.dataset.st }); toast('Agendamento atualizado.', 'ok'); await load(); }));
  $('[data-load]', el).addEventListener('click', () => load().catch(showError));
  $('[data-date]', el).addEventListener('change', () => load().catch(showError));
  $('[data-new]', el)?.addEventListener('click', async () => {
    const [profs, procs] = await Promise.all([api.get('/professionals', { active: 'true' }), api.get('/procedures', { active: 'true' })]);
    let patient = null;
    const body = document.createElement('div');
    render(body, html`<div class="stack"><div><label>Paciente *</label><div data-pp></div></div>
      <div class="form-grid">
        <div><label>Data e hora *</label><input type="datetime-local" name="scheduled_at"></div>
        <div><label>Profissional</label><select name="professional_id"><option value="">—</option>${profs.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
        <div><label>Procedimento</label><select name="procedure_id"><option value="">—</option>${procs.map((p) => html`<option value="${p.id}">${p.name} (${money(p.price_cents)})</option>`)}</select></div>
        <div><label>Setor</label><input name="sector" placeholder="Ex.: Cardiologia"></div>
        <div class="full"><label>Observações</label><textarea name="notes"></textarea></div></div></div>`);
    patientPicker($('[data-pp]', body), { onSelect: (p) => { patient = p; } });
    modal({ title: 'Novo agendamento', wide: true, body, actions: [{ label: 'Cancelar' }, { label: 'Agendar', class: 'primary', onClick: async () => {
      if (!patient) throw new Error('Selecione o paciente.');
      const v = (n) => body.querySelector(`[name=${n}]`).value || null;
      const at = v('scheduled_at');
      await api.post('/schedulings', { patient_id: patient.id, scheduled_at: at ? new Date(at).toISOString() : null, professional_id: v('professional_id'), procedure_id: v('procedure_id'), sector: v('sector'), notes: v('notes') });
      toast('Agendamento criado.', 'ok'); await load();
    } }] });
  });
  await load();
}
