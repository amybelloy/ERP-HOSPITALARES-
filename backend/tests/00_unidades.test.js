'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toCents, formatBRL, centsToDecimal } = require('../src/lib/money');
const { isValidCPF, isValidCNPJ, maskCPF } = require('../src/lib/docs');
const { crc16, buildPixPayload } = require('../src/lib/brcode');
const { deriveStatus } = require('../src/services/settlementService');
const { toCSV } = require('../src/lib/csv');

test('Dinheiro em centavos sem ponto flutuante', () => {
  assert.equal(toCents('500,00'), 50000);
  assert.equal(toCents('1.234,56'), 123456);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents('R$ 10,5'), 1050);
  assert.throws(() => toCents('10,555'));
  assert.throws(() => toCents('-5'));
  assert.equal(formatBRL(123456), 'R$ 1.234,56');
  assert.equal(centsToDecimal(50000), '500.00');
});

test('Derivação de status financeiro', () => {
  assert.equal(deriveStatus(50000, 0), 'PENDENTE');
  assert.equal(deriveStatus(50000, 20000), 'PARCIAL');
  assert.equal(deriveStatus(50000, 50000), 'QUITADA');
  assert.equal(deriveStatus(50000, 50001), 'EXCEDENTE');
});

test('CPF/CNPJ e mascaramento', () => {
  assert.ok(isValidCPF('123.456.789-09'));
  assert.ok(!isValidCPF('111.111.111-11'));
  assert.ok(isValidCNPJ('11.222.333/0001-81'));
  assert.equal(maskCPF('12345678909'), '***.456.789-**');
});

test('BR Code Pix possui CRC16 válido', () => {
  assert.equal(crc16('123456789'), '29B1');
  const p = buildPixPayload({ pixKey: 'x@y.z', amount: '500.00', merchantName: 'Teste', merchantCity: 'SP', txid: 'ABC' });
  assert.equal(crc16(p.slice(0, -4)), p.slice(-4));
});

test('CSV protege contra injeção de fórmulas', () => {
  const out = toCSV([{ key: 'a', label: 'A' }], [{ a: '=HYPERLINK("x")' }]);
  assert.match(out, /'=HYPERLINK/);
});
