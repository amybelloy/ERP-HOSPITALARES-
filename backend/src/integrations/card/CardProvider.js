'use strict';
/**
 * Contrato de integração com terminais de cartão / adquirente / TEF.
 *
 * Fluxo:
 *   1. startTransaction() envia o valor ao terminal (pinpad/POS) vinculado ao caixa;
 *   2. o resultado chega por callback (POST /api/webhooks/card/:provider) ou por consulta;
 *   3. o sistema SEMPRE reconsulta getTransaction() antes de registrar a aprovação.
 *
 * Transaction { transactionId, status: PROCESSANDO|APROVADA|NEGADA|CANCELADA, amountCents,
 *               nsu, authorizationCode, brand, cardLast4, message, raw }
 */
class CardProvider {
  get name() { throw new Error('não implementado'); }
  get isDemo() { return false; }
  status() { return { configured: false, missing: [] }; }
  async startTransaction(/* { reference, amountCents, type: CREDITO|DEBITO, installments } */) { throw new Error('não implementado'); }
  async getTransaction(/* transactionId */) { throw new Error('não implementado'); }
  async cancelTransaction(/* { transactionId, amountCents } */) { throw new Error('não implementado'); }
  verifyCallback(/* { headers, rawBody } */) { return false; }
}

module.exports = { CardProvider };
