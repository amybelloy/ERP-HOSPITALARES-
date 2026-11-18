'use strict';
/**
 * Montagem do payload Pix "Copia e Cola" (padrão EMV® QRCPS / BR Code do Banco Central).
 * Usado pelo provedor de DEMONSTRAÇÃO. Em produção, o payload vem do PSP (Santander)
 * a partir do campo `pixCopiaECola` / `location` da cobrança.
 */
function tlv(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normalize(s, max) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, max);
}

function buildPixPayload({ pixKey, amount, merchantName, merchantCity, txid, location }) {
  const gui = tlv('00', 'br.gov.bcb.pix');
  const account = location ? gui + tlv('25', location) : gui + tlv('01', pixKey);
  let payload =
    tlv('00', '01') +
    (location ? tlv('01', '12') : '') +
    tlv('26', account) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (amount ? tlv('54', amount) : '') +
    tlv('58', 'BR') +
    tlv('59', normalize(merchantName, 25)) +
    tlv('60', normalize(merchantCity, 15)) +
    tlv('62', tlv('05', (txid || '***').slice(0, 25))) +
    '6304';
  return payload + crc16(payload);
}

module.exports = { buildPixPayload, crc16 };
