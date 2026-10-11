// Componentes assistenciais compartilhados: barra do paciente, rótulos clínicos.
import { html, date, datetime } from './ui.js';

export const TRIAGE = {
  VERMELHO: { label: 'Emergência', target: 'imediato' }, LARANJA: { label: 'Muito urgente', target: '10 min' },
  AMARELO: { label: 'Urgente', target: '60 min' }, VERDE: { label: 'Pouco urgente', target: '120 min' }, AZUL: { label: 'Não urgente', target: '240 min' },
};
export const NEWS_LABEL = { BAIXO: 'Baixo', BAIXO_MEDIO: 'Baixo-médio', MEDIO: 'Médio', ALTO: 'Alto' };
export const RISK_LABEL = { MUITO_ALTO: 'Muito alto', ALTO: 'Alto', MODERADO: 'Moderado', BAIXO: 'Baixo', SEM_RISCO: 'Sem risco', GRAVE: 'Grave', LEVE: 'Leve' };
export const NOTE_LABEL = { ANAMNESE: 'Anamnese', EVOLUCAO_MEDICA: 'Evolução médica', EVOLUCAO_ENFERMAGEM: 'Evolução de enfermagem',
  ANOTACAO_ENFERMAGEM: 'Anotação de enfermagem', MULTIPROFISSIONAL: 'Evolução multiprofissional', SUMARIO_ALTA: 'Sumário de alta' };
export const BED_LABEL = { LIVRE: 'Livre', OCUPADO: 'Ocupado', HIGIENIZACAO: 'Em higienização', MANUTENCAO: 'Manutenção', RESERVADO: 'Reservado', BLOQUEADO: 'Bloqueado' };
export const ADM_LABEL = { PENDENTE: 'Pendente', ADMINISTRADO: 'Administrado', NAO_ADMINISTRADO: 'Não administrado', SUSPENSO: 'Suspenso' };

export const newsBadge = (score, risk) => (risk ? html`<span class="news ${risk}" title="NEWS2">NEWS ${score} · ${NEWS_LABEL[risk]}</span>` : html`<span class="muted small">NEWS —</span>`);
export const triageTag = (color) => (color ? html`<span class="tri-label"><span class="tri ${color}"></span>${TRIAGE[color].label}</span>` : '');
export const temp = (t) => (t == null ? '—' : `${Math.floor(t / 10)},${t % 10} °C`);
export const hhmm = (d) => (d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');

/** Barra do paciente (cabeçalho fixo de contexto clínico, com alergias em destaque). */
export function patientBar(c) {
  return html`<div class="patient-bar">
    <span class="pname">${c.social_name || c.patient_name}</span>
    <span class="pb"><b>Idade</b>${c.age ?? '—'} anos · ${c.sex || '—'}</span>
    <span class="pb"><b>Prontuário</b>${c.record_number}</span>
    <span class="pb"><b>Atendimento</b>${c.appointment_number}</span>
    <span class="pb"><b>Leito</b>${c.bed_code ? `${c.bed_code} · ${c.unit_name}` : '—'}</span>
    <span class="pb"><b>Entrada</b>${date(c.opened_at)}${c.days_admitted != null ? ` (D${c.days_admitted})` : ''}</span>
    <span class="pb"><b>Convênio</b>${c.insurance_name || 'Particular'}</span>
    <span class="pb"><b>Médico</b>${c.professional_name || '—'}</span>
    ${c.triage ? html`<span class="pb">${triageTag(c.triage.color)}</span>` : ''}
    <span class="pb">${c.last_vitals ? newsBadge(c.last_vitals.news_score, c.last_vitals.news_risk) : ''}</span>
    ${c.allergies.length ? html`<span class="allergy" title="${c.allergies.map((a) => `${a.substance}: ${a.reaction || ''}`).join(' | ')}">⚠ ALERGIA: ${c.allergies.map((a) => a.substance).join(', ')}</span>`
    : html`<span class="noallergy">Sem alergias registradas</span>`}
    ${c.status !== 'ABERTO' && c.status !== 'EM_ATENDIMENTO' ? html`<span class="allergy">ATENDIMENTO ${c.status}${c.finished_at ? ` em ${datetime(c.finished_at)}` : ''}</span>` : ''}
  </div>`;
}
