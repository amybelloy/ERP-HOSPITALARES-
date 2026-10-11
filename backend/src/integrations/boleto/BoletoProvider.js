'use strict';
/**
 * Contrato de cobrança por boleto (registro, consulta, baixa e notificação).
 * Boleto { ourNumber, status: REGISTRADO|PAGO|BAIXADO|VENCIDO, amountCents, dueDate, barcode, digitableLine,
 *          paidAmountCents, paidAt, raw }
 */
class BoletoProvider {
  get name() { throw new Error('não implementado'); }
  get isDemo() { return false; }
  status() { return { configured: false, missing: [] }; }
  async register(/* { ourNumber, amountCents, dueDate, payer, description } */) { throw new Error('não implementado'); }
  async getBoleto(/* ourNumber */) { throw new Error('não implementado'); }
  async cancel(/* ourNumber */) { throw new Error('não implementado'); }
  verifyWebhook(/* { headers, rawBody, params } */) { return false; }
}
module.exports = { BoletoProvider };
