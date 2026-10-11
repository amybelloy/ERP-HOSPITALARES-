'use strict';
/**
 * Dinheiro é sempre representado em centavos inteiros.
 * A conversão de texto para centavos é feita por parsing de string, sem aritmética de ponto flutuante.
 */
const { badRequest } = require('./errors');

/** Aceita: 500, "500", "500.00", "500,00", "1.234,56", "1234.5". Retorna centavos (inteiro). */
function toCents(value, field = 'valor') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest(`${field} inválido.`);
    value = value.toFixed(2); // apenas formatação de entrada, o cálculo segue por string
  }
  if (typeof value !== 'string') throw badRequest(`${field} inválido.`);
  let s = value.trim().replace(/^R\$\s*/i, '');
  if (!s) throw badRequest(`${field} obrigatório.`);
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw badRequest(`${field} inválido: "${value}".`);
  const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw badRequest(`${field} fora do limite.`);
  return cents;
}

/** Valida um inteiro de centavos vindo da API. */
function assertCents(value, field = 'valor', { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw badRequest(`${field} deve ser um inteiro positivo em centavos.`);
  }
  return value;
}

/** Centavos -> "500.00" (formato decimal com ponto, ex.: API Pix). */
function centsToDecimal(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Centavos -> "R$ 1.234,56" */
function formatBRL(cents) {
  const [int, dec] = centsToDecimal(Math.abs(cents)).split('.');
  const withDots = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}R$ ${withDots},${dec}`;
}

module.exports = { toCents, assertCents, centsToDecimal, formatBRL };
