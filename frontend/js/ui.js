// Utilitários de interface. Sem estilos/handlers inline (compatível com CSP estrita).
import { ApiError } from './api.js';

// ------------------------------------------------------------------ templates
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(val).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
};
/** Template com escape automático. Use raw() para HTML confiável. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return raw(out);
}
export const render = (el, tpl) => { el.innerHTML = typeof tpl === 'string' ? tpl : tpl[RAW]; return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

// ------------------------------------------------------------------ formatos
export function money(cents) {
  if (cents === null || cents === undefined || cents === '') return '—';
  const n = Number(cents); const neg = n < 0; const a = Math.abs(n);
  const int = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${int},${String(a % 100).padStart(2, '0')}`;
}
/** "1.234,56" | "500" | "500.5" -> centavos (parsing por texto, sem float) */
export function toCents(str) {
  let s = String(str ?? '').trim().replace(/^R\$\s*/i, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}
export const centsToInput = (c) => (c == null ? '' : `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`);
export const date = (d) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('pt-BR') : '—');
export const datetime = (d) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const cpf = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : (v || '—'); };

const LABELS = {
  PENDENTE: 'Pendente', PARCIAL: 'Parcialmente paga', QUITADA: 'Quitada', CANCELADA: 'Cancelada',
  PROCESSANDO: 'Processando', AGUARDANDO_CONFERENCIA: 'Aguardando conferência', CONFIRMADO: 'Confirmado', REJEITADO: 'Rejeitado',
  CANCELADO: 'Cancelado', EXPIRADO: 'Expirado', ESTORNADO: 'Estornado', ESTORNADO_PARCIAL: 'Estornado parcial', DIVERGENTE: 'Divergente',
  FALHA_COMUNICACAO: 'Falha de comunicação', NAO_SOLICITADA: 'Não solicitada', PREPARADA: 'Preparada', ENVIADA: 'Enviada',
  EMITIDA: 'Emitida', EMITIDA_DEMO: 'Emitida (DEMO)', REJEITADA: 'Rejeitada', EXPORTADA: 'Exportada', EMITIDA_EXTERNAMENTE: 'Emitida externamente',
  ABERTO: 'Aberto', EM_ATENDIMENTO: 'Em atendimento', FINALIZADO: 'Finalizado', ABERTA: 'Aberta', FECHADA: 'Fechada', FATURADA: 'Faturada',
  AGENDADO: 'Agendado', CONFIRMADO_AG: 'Confirmado', ATENDIDO: 'Atendido', FALTOU: 'Faltou', RESOLVIDA: 'Resolvida', JUSTIFICADA: 'Justificada',
  EM_ANALISE: 'Em análise', CONCILIADO: 'Conciliado', SEM_CONTA: 'Sem conta', SEM_TRANSACAO_BANCARIA: 'Sem transação bancária',
  VALOR_DIVERGENTE: 'Valor divergente', DUPLICADA: 'Duplicada', ESTORNO: 'Estorno', PIX: 'Pix', CARTAO_CREDITO: 'Cartão de crédito',
  CARTAO_DEBITO: 'Cartão de débito', DINHEIRO: 'Dinheiro', OUTRO: 'Outro', BOLETO: 'Boleto', CONVENIO: 'Repasse de convênio', PARTICULAR: 'Particular', CONVENIO: 'Convênio',
  PROCESSADO: 'Processado', DUPLICADO: 'Duplicado', ERRO: 'Erro', INVALIDO: 'Inválido', SEM_COBRANCA: 'Sem cobrança', RECEBIDO: 'Recebido',
  WEBHOOK_VALIDADO_CONSULTA: 'Webhook validado + consulta ao banco', CONSULTA_PROVEDOR: 'Consulta ao provedor', TERMINAL_PROVEDOR: 'Terminal/adquirente',
  CONFERENCIA_MANUAL: 'Conferência manual autorizada', ATIVO: 'Ativo', INATIVO: 'Inativo',
  EXAME: 'Exame', CONSULTA: 'Consulta', AMBULATORIAL: 'Ambulatorial', URGENCIA: 'Urgência', INTERNACAO: 'Internação', INTEGRACAO: 'Integração', EXPORTACAO: 'Exportação', DEMONSTRACAO: 'Demonstração',
};
export const label = (s) => LABELS[s] || s || '—';
const TONE = {
  ok: ['ATIVO', 'QUITADA', 'CONFIRMADO', 'EMITIDA', 'EMITIDA_EXTERNAMENTE', 'FINALIZADO', 'ATENDIDO', 'RESOLVIDA', 'CONCILIADO', 'PROCESSADO', 'FATURADA', 'JUSTIFICADA'],
  warn: ['PARCIAL', 'PROCESSANDO', 'AGUARDANDO_CONFERENCIA', 'PENDENTE', 'ENVIADA', 'PREPARADA', 'EXPORTADA', 'EM_ANALISE', 'ESTORNADO_PARCIAL', 'ABERTA', 'SEM_TRANSACAO_BANCARIA', 'DUPLICADO'],
  danger: ['INATIVO', 'REJEITADO', 'REJEITADA', 'DIVERGENTE', 'FALHA_COMUNICACAO', 'CANCELADA', 'CANCELADO', 'ESTORNADO', 'ERRO', 'INVALIDO', 'SEM_CONTA', 'VALOR_DIVERGENTE', 'DUPLICADA', 'FALTOU'],
  info: ['ABERTO', 'EM_ATENDIMENTO', 'AGENDADO', 'FECHADA', 'ESTORNO', 'EXPIRADO'],
  demo: ['EMITIDA_DEMO', 'DEMONSTRACAO'],
};
export function badge(status, text) {
  const tone = Object.entries(TONE).find(([, list]) => list.includes(status))?.[0] || '';
  return html`<span class="badge ${tone}">${text || label(status)}</span>`;
}
export const demoBadge = (isDemo) => (isDemo ? html` <span class="badge demo" title="Simulação — nenhum valor real">DEMO</span>` : '');

// ------------------------------------------------------------------ tabela
/** columns: [{ label, render: (row) => tpl|string, class }] */
export function table(columns, rows, { empty = 'Nenhum registro encontrado.', rowClass } = {}) {
  if (!rows?.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => html`<th class="${c.class || ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr class="${rowClass ? rowClass(r) : ''}">${columns.map((c) => html`<td class="${c.class || ''}">${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

// ------------------------------------------------------------------ feedback
export function toast(message, type = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 4000);
}

export function errorText(err) {
  if (err instanceof ApiError) {
    const det = err.details && typeof err.details === 'object' && !Array.isArray(err.details)
      ? Object.entries(err.details).filter(([, v]) => typeof v === 'string').map(([, v]) => v) : [];
    return [err.message, ...det].join(' ');
  }
  return err?.message || String(err);
}
export const showError = (err) => toast(errorText(err), 'error');

/** Executa ação assíncrona com botão desabilitado e tratamento de erro. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { showError(e); return undefined; } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------------ modal
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  render(back, html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <header><h2>${title}</h2><button class="x no-print" data-close aria-label="Fechar">×</button></header>
    <div class="body"></div>
    <footer class="no-print">${actions.map((a, i) => html`<button class="btn ${a.class || ''}" data-act="${i}">${a.label}</button>`)}</footer>
  </div>`);
  const bodyEl = $('.body', back);
  if (body instanceof Node) bodyEl.appendChild(body); else render(bodyEl, body || '');
  if (!actions.length) $('footer', back).classList.add('hidden');
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.addEventListener('click', async (e) => {
    if (e.target === back || e.target.closest('[data-close]')) return close();
    const b = e.target.closest('[data-act]');
    if (b) {
      const a = actions[Number(b.dataset.act)];
      await busy(b, async () => { const keep = await a.onClick?.({ close, body: bodyEl, button: b }); if (keep !== false && a.closes !== false) close(); });
    }
  });
  document.body.appendChild(back);
  return { el: back, body: bodyEl, close };
}

export function confirmDialog(message, { title = 'Confirmar', ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({ title, body: html`<p>${message}</p>`, onClose: () => { if (!done) resolve(false); },
      actions: [{ label: 'Cancelar', onClick: () => {} }, { label: ok, class: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } }] });
  });
}

/**
 * Formulário em modal. fields: [{ name, label, type, options, required, value, placeholder, help, full }]
 * onSubmit(values) -> se lançar erro, mostra e mantém aberto.
 */
export function formDialog({ title, fields, submit = 'Salvar', onSubmit, wide = false, intro }) {
  const form = document.createElement('form');
  form.className = 'form-grid';
  render(form, html`${intro ? html`<div class="full">${intro}</div>` : ''}${fields.map(fieldHtml)}`);
  form.addEventListener('submit', (e) => e.preventDefault());
  return modal({ title, wide, body: form, actions: [
    { label: 'Cancelar' },
    { label: submit, class: 'primary', onClick: async () => {
      $$('.field-error', form).forEach((x) => x.remove());
      const values = readForm(form, fields);
      try { await onSubmit(values); } catch (err) { markErrors(form, err); throw err; }
    } },
  ] });
}

export function fieldHtml(f) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const cls = f.full ? 'full' : (f.span2 ? 'span2' : '');
  const req = f.required ? ' *' : '';
  let input;
  if (f.type === 'select') {
    input = html`<select id="${id}" name="${f.name}">${(f.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(f.value ?? '') ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  } else if (f.type === 'textarea') {
    input = html`<textarea id="${id}" name="${f.name}" placeholder="${f.placeholder || ''}">${f.value ?? ''}</textarea>`;
  } else if (f.type === 'checkbox') {
    input = html`<div><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? raw('checked') : ''}> <span class="small">${f.checkLabel || ''}</span></div>`;
  } else {
    input = html`<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${f.value ?? ''}" placeholder="${f.placeholder || ''}" ${f.step ? raw(`step="${esc(f.step)}"`) : ''}>`;
  }
  return html`<div class="${cls}" data-field="${f.name}"><label for="${id}">${f.label}${req}</label>${input}${f.help ? html`<div class="small muted">${f.help}</div>` : ''}</div>`;
}

export function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    const el = form.querySelector(`[name="${f.name}"]`);
    if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'money') { const c = toCents(el.value); out[f.name] = c === null ? null : c; }
    else out[f.name] = el.value === '' ? null : el.value;
  }
  return out;
}

export function markErrors(form, err) {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== 'object') return;
  for (const [k, msg] of Object.entries(err.details)) {
    if (typeof msg !== 'string') continue;
    const wrap = form.querySelector(`[data-field="${k}"]`) || form.querySelector(`[data-field="${k.replace(/_cents$/, '')}"]`);
    if (wrap) { const d = document.createElement('div'); d.className = 'field-error'; d.textContent = msg; wrap.appendChild(d); }
  }
}

/** Lê arquivo de texto (CSV) escolhido pelo usuário. */
export const readFileText = (file) => new Promise((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsText(file, 'utf-8');
});

export function setWidth(el, pct) { el.style.width = `${Math.max(0, Math.min(100, pct))}%`; }

/** Substitui o conteúdo do host por um container novo (descarta listeners de renderizações anteriores). */
export function fresh(host) {
  const d = document.createElement('div');
  host.replaceChildren(d);
  return d;
}
