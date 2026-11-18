'use strict';
/**
 * Contrato de integração fiscal (NFS-e).
 * Result { status: PROCESSANDO|EMITIDA|REJEITADA|CANCELADA, nfseNumber, verificationCode, accessKey,
 *          protocol, officialUrl, xml, rejectionReason, raw }
 */
class FiscalProvider {
  get name() { throw new Error('não implementado'); }
  get isDemo() { return false; }
  status() { return { configured: false, missing: [] }; }
  async emit(/* fiscalDocument */) { throw new Error('não implementado'); }
  async check(/* fiscalDocument */) { throw new Error('não implementado'); }
  async cancel(/* fiscalDocument, reason */) { throw new Error('não implementado'); }
}
module.exports = { FiscalProvider };
