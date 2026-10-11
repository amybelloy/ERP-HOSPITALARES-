'use strict';
/**
 * Boleto bancário — código de barras (44 posições) e linha digitável (47 dígitos), padrão FEBRABAN.
 * Usado pelo provedor de DEMONSTRAÇÃO; em produção o banco devolve código e linha no registro.
 */

function mod10(num) {
  let sum = 0; let w = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = Number(num[i]) * w;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p; w = w === 2 ? 1 : 2;
  }
  return String((10 - (sum % 10)) % 10);
}

function mod11Barcode(num) {
  let sum = 0; let w = 2;
  for (let i = num.length - 1; i >= 0; i--) { sum += Number(num[i]) * w; w = w === 9 ? 2 : w + 1; }
  const dv = 11 - (sum % 11);
  return String(dv === 0 || dv === 10 || dv === 11 ? 1 : dv);
}

/** Fator de vencimento: dias desde 07/10/1997; reinicia em 1000 a partir de 22/02/2025. */
function dueFactor(dueDate) {
  const base = Date.UTC(1997, 9, 7);
  const [y, m, d] = String(dueDate).split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - base) / 86400000);
  if (days < 1000) throw new Error('Data de vencimento inválida.');
  return String(days <= 9999 ? days : ((days - 10000) % 9000) + 1000).padStart(4, '0');
}

/**
 * @param {object} p { bank: '033', amountCents, dueDate: 'AAAA-MM-DD', freeField: 25 dígitos }
 */
function buildBoleto({ bank = '033', amountCents, dueDate, freeField }) {
  if (!/^\d{25}$/.test(freeField)) throw new Error('Campo livre deve ter 25 dígitos.');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 99999999999) throw new Error('Valor inválido para boleto.');
  const factor = dueFactor(dueDate);
  const value = String(amountCents).padStart(10, '0');
  const partial = `${bank}9${factor}${value}${freeField}`; // 43 dígitos (sem DV)
  const dv = mod11Barcode(partial);
  const barcode = `${bank}9${dv}${factor}${value}${freeField}`;
  const f1 = `${bank}9${freeField.slice(0, 5)}`; const f2 = freeField.slice(5, 15); const f3 = freeField.slice(15, 25);
  const c1 = f1 + mod10(f1); const c2 = f2 + mod10(f2); const c3 = f3 + mod10(f3);
  const line = `${c1.slice(0, 5)}.${c1.slice(5)} ${c2.slice(0, 5)}.${c2.slice(5)} ${c3.slice(0, 5)}.${c3.slice(5)} ${dv} ${factor}${value}`;
  return { barcode, digitableLine: line };
}

/** Campo livre no layout do Santander: 9 + beneficiário(7) + nosso número(13) + IOS(1) + carteira(3). */
const santanderFreeField = ({ beneficiaryCode, ourNumber, wallet = '101' }) =>
  `9${String(beneficiaryCode).padStart(7, '0')}${String(ourNumber).padStart(13, '0')}0${String(wallet).padStart(3, '0')}`;

module.exports = { buildBoleto, santanderFreeField, mod10, mod11Barcode, dueFactor };
