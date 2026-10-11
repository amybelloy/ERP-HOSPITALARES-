// Componentes compartilhados entre páginas.
import { api } from './api.js';
import { html, render, $, on, esc, money, badge, label } from './ui.js';
import { state } from './state.js';

/** Campo de busca de paciente com seleção. onSelect(patient) */
export function patientPicker(container, { onSelect, placeholder = 'Nome, CPF, código ou prontuário…' } = {}) {
  render(container, html`<div class="search-pick">
    <input type="search" placeholder="${placeholder}" autocomplete="off" data-pp-input>
    <div class="search-results hidden" data-pp-results></div>
    <div class="mt hidden" data-pp-selected></div>
  </div>`);
  const input = $('[data-pp-input]', container); const box = $('[data-pp-results]', container); const sel = $('[data-pp-selected]', container);
  let timer; let results = [];
  container.querySelector('.search-pick').classList.add('search');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.add('hidden'); return; }
    timer = setTimeout(async () => {
      results = await api.get('/patients', { q, limit: 10 });
      render(box, results.length
        ? html`${results.map((p, i) => html`<a role="button" tabindex="0" data-pp-i="${i}">${p.name} <span class="small muted">${p.code} · ${p.record_number} · CPF ${p.cpf || '—'}</span></a>`)}`
        : html`<div class="empty">Nenhum paciente. Cadastre em "Cadastro de pacientes".</div>`);
      box.classList.remove('hidden');
    }, 250);
  });
  on(box, 'click', '[data-pp-i]', (e, a) => {
    e.preventDefault();
    const p = results[Number(a.dataset.ppI)];
    box.classList.add('hidden'); input.value = p.name;
    render(sel, html`<div class="alert info">Paciente: <strong>${p.name}</strong> · ${p.code} · Prontuário <strong>${p.record_number}</strong></div>`);
    sel.classList.remove('hidden');
    onSelect?.(p);
  });
  return { setPatient(p) { input.value = p.name; render(sel, html`<div class="alert info">Paciente: <strong>${p.name}</strong> · ${p.code} · Prontuário <strong>${p.record_number}</strong></div>`); sel.classList.remove('hidden'); onSelect?.(p); } };
}

export const demoBanner = (text = 'MODO DE DEMONSTRAÇÃO — provedores simulados. Nenhum pagamento real é processado e nenhuma nota fiscal oficial é emitida.') =>
  (state.demoMode ? html`<div class="demo-banner">⚠ ${text}</div>` : '');

export const accountStatusCell = (a) => html`${badge(a.financial_status)}`;
export const moneyCell = (k) => (r) => money(r[k]);
export const methodLabel = (m) => label(m);
export { esc };
