'use strict';
/**
 * Escalas e escores clínicos de uso consagrado (cálculo determinístico, testável).
 * São ferramentas de apoio: não substituem a avaliação profissional.
 */

/** NEWS2 (National Early Warning Score 2) — escala 1 de SpO2. temp em décimos de °C. */
function news2({ resp_rate: rr, spo2, on_oxygen: o2, systolic: sbp, heart_rate: hr, consciousness, temp_tenths: t }) {
  const parts = {};
  if (rr != null) parts.fr = rr <= 8 ? 3 : rr <= 11 ? 1 : rr <= 20 ? 0 : rr <= 24 ? 2 : 3;
  if (spo2 != null) parts.spo2 = spo2 <= 91 ? 3 : spo2 <= 93 ? 2 : spo2 <= 95 ? 1 : 0;
  parts.o2 = o2 ? 2 : 0;
  if (sbp != null) parts.pas = sbp <= 90 ? 3 : sbp <= 100 ? 2 : sbp <= 110 ? 1 : sbp <= 219 ? 0 : 3;
  if (hr != null) parts.fc = hr <= 40 ? 3 : hr <= 50 ? 1 : hr <= 90 ? 0 : hr <= 110 ? 1 : hr <= 130 ? 2 : 3;
  parts.consciencia = consciousness && consciousness !== 'A' ? 3 : 0;
  if (t != null) parts.temp = t <= 350 ? 3 : t <= 360 ? 1 : t <= 380 ? 0 : t <= 390 ? 1 : 2;
  const measured = ['fr', 'spo2', 'pas', 'fc', 'temp'].filter((k) => parts[k] !== undefined).length;
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const anyThree = Object.values(parts).some((v) => v === 3);
  const risk = score >= 7 ? 'ALTO' : score >= 5 ? 'MEDIO' : anyThree ? 'BAIXO_MEDIO' : 'BAIXO';
  const action = {
    ALTO: 'Avaliação médica de emergência imediata; considerar UTI; monitorização contínua.',
    MEDIO: 'Avaliação médica urgente; monitorização no mínimo de hora em hora.',
    BAIXO_MEDIO: 'Avaliação médica urgente do parâmetro alterado; monitorização no mínimo de hora em hora.',
    BAIXO: score > 0 ? 'Avaliação pelo enfermeiro; monitorização a cada 4–6 h.' : 'Monitorização mínima a cada 12 h.',
  }[risk];
  return { score, risk, parts, complete: measured === 5, action };
}

const range = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const SCALES = {
  BRADEN: {
    title: 'Escala de Braden (risco de lesão por pressão)',
    items: {
      percepcao_sensorial: { label: 'Percepção sensorial', min: 1, max: 4 },
      umidade: { label: 'Umidade', min: 1, max: 4 },
      atividade: { label: 'Atividade', min: 1, max: 4 },
      mobilidade: { label: 'Mobilidade', min: 1, max: 4 },
      nutricao: { label: 'Nutrição', min: 1, max: 4 },
      friccao_cisalhamento: { label: 'Fricção e cisalhamento', min: 1, max: 3 },
    },
    risk: (s) => (s <= 9 ? 'MUITO_ALTO' : s <= 12 ? 'ALTO' : s <= 14 ? 'MODERADO' : s <= 18 ? 'BAIXO' : 'SEM_RISCO'),
  },
  MORSE: {
    title: 'Escala de Morse (risco de queda)',
    items: {
      historico_queda: { label: 'Histórico de queda (0 ou 25)', allowed: [0, 25] },
      diagnostico_secundario: { label: 'Diagnóstico secundário (0 ou 15)', allowed: [0, 15] },
      auxilio_deambulacao: { label: 'Auxílio na deambulação (0, 15 ou 30)', allowed: [0, 15, 30] },
      terapia_endovenosa: { label: 'Terapia endovenosa / dispositivo (0 ou 20)', allowed: [0, 20] },
      marcha: { label: 'Marcha (0, 10 ou 20)', allowed: [0, 10, 20] },
      estado_mental: { label: 'Estado mental (0 ou 15)', allowed: [0, 15] },
    },
    risk: (s) => (s >= 45 ? 'ALTO' : s >= 25 ? 'MODERADO' : 'BAIXO'),
  },
  GLASGOW: {
    title: 'Escala de Coma de Glasgow',
    items: {
      abertura_ocular: { label: 'Abertura ocular', min: 1, max: 4 },
      resposta_verbal: { label: 'Resposta verbal', min: 1, max: 5 },
      resposta_motora: { label: 'Resposta motora', min: 1, max: 6 },
    },
    risk: (s) => (s <= 8 ? 'GRAVE' : s <= 12 ? 'MODERADO' : 'LEVE'),
  },
};

/** Valida respostas e calcula escore/risco. Lança Error com mensagens por item. */
function scoreScale(scale, answers) {
  const def = SCALES[scale];
  if (!def) throw new Error('Escala inexistente.');
  const errors = {};
  let score = 0;
  for (const [k, it] of Object.entries(def.items)) {
    const v = Number(answers?.[k]);
    const ok = it.allowed ? it.allowed.includes(v) : range(v, it.min, it.max);
    if (!ok) errors[k] = `${it.label}: valor inválido.`;
    else score += v;
  }
  if (Object.keys(errors).length) { const e = new Error('Respostas inválidas.'); e.details = errors; throw e; }
  return { score, risk: def.risk(score) };
}

/** Protocolo de classificação de risco por cores (tempo-alvo de atendimento em minutos). */
const TRIAGE_COLORS = {
  VERMELHO: { label: 'Emergência', target: 0, priority: 1 },
  LARANJA: { label: 'Muito urgente', target: 10, priority: 2 },
  AMARELO: { label: 'Urgente', target: 60, priority: 3 },
  VERDE: { label: 'Pouco urgente', target: 120, priority: 4 },
  AZUL: { label: 'Não urgente', target: 240, priority: 5 },
};

/** Diagnósticos de enfermagem frequentes (catálogo inicial editável na SAE). */
const NURSING_DIAGNOSES = [
  'Risco de queda', 'Risco de lesão por pressão', 'Risco de infecção', 'Dor aguda', 'Dor crônica',
  'Ansiedade', 'Mobilidade física prejudicada', 'Integridade da pele prejudicada', 'Padrão respiratório ineficaz',
  'Troca de gases prejudicada', 'Débito cardíaco diminuído', 'Volume de líquidos deficiente', 'Volume de líquidos excessivo',
  'Nutrição desequilibrada: menor que as necessidades corporais', 'Déficit no autocuidado para banho',
  'Eliminação urinária prejudicada', 'Constipação', 'Hipertermia', 'Risco de glicemia instável', 'Conhecimento deficiente',
  'Padrão de sono prejudicado', 'Risco de sangramento', 'Confusão aguda', 'Risco de aspiração',
];

module.exports = { news2, SCALES, scoreScale, TRIAGE_COLORS, NURSING_DIAGNOSES };
