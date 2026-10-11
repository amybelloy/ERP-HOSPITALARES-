'use strict';
/**
 * Contrato (interface) de um provedor Pix. Cada banco/PSP implementa um adaptador.
 * O modelo segue a API Pix padronizada pelo Banco Central (cob, pix, devolução, webhook),
 * adotada por Santander e demais PSPs, o que facilita trocar de provedor.
 *
 * Status de cobrança (BACEN): ATIVA | CONCLUIDA | REMOVIDA_PELO_USUARIO_RECEBEDOR | REMOVIDA_PELO_PSP
 *
 * Objetos normalizados:
 *  Charge  { txid, status, amountCents, copyPaste, location, expiresAt, pix: PixReceived[], raw }
 *  PixReceived { endToEndId, txid, amountCents, paidAt, refunds: Refund[] }
 *  Refund  { id, rtrId, amountCents, status: EM_PROCESSAMENTO|DEVOLVIDO|NAO_REALIZADO, requestedAt }
 */
class PixProvider {
  get name() { throw new Error('não implementado'); }
  get isDemo() { return false; }
  /** @returns {{configured:boolean, missing:string[]}} */
  status() { return { configured: false, missing: [] }; }
  async createCharge(/* { txid, amountCents, expiresIn, debtor, description } */) { throw new Error('não implementado'); }
  async getCharge(/* txid */) { throw new Error('não implementado'); }
  async cancelCharge(/* txid */) { throw new Error('não implementado'); }
  async requestRefund(/* { endToEndId, refundId, amountCents, reason } */) { throw new Error('não implementado'); }
  async listReceived(/* { from, to } */) { throw new Error('não implementado'); }
  /** Autenticidade da notificação. Mesmo autêntica, o sistema SEMPRE reconsulta a cobrança no provedor. */
  verifyWebhook(/* { headers, rawBody, query, params } */) { return false; }
}

/** txid BACEN: 26 a 35 caracteres [a-zA-Z0-9] */
function newTxid() {
  const crypto = require('crypto');
  return crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32).padEnd(32, '0');
}

module.exports = { PixProvider, newTxid };
