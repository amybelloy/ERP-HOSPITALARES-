'use strict';
/**
 * Configuração central. Todos os segredos vêm de variáveis de ambiente.
 * Nenhuma credencial é enviada ao frontend.
 */
const env = process.env;

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase());
}

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://hospital:hospital@localhost:5432/hospital_dev',

  /** Modo de demonstração: habilita provedores simulados e o endpoint de simulação. */
  demoMode: bool(env.DEMO_MODE, true),

  session: {
    cookieName: 'sg_session',
    idleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
    absoluteHours: Number(env.SESSION_ABSOLUTE_HOURS || 8),
    secureCookie: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  },

  security: {
    maxFailedLogins: Number(env.MAX_FAILED_LOGINS || 5),
    lockMinutes: Number(env.LOCK_MINUTES || 15),
    bcryptRounds: Number(env.BCRYPT_ROUNDS || 12),
  },

  /** Exige que pagamentos informados manualmente (dinheiro, cartão sem TEF) sejam conferidos por outro usuário. */
  manualPaymentsRequireConference: bool(env.MANUAL_PAYMENTS_REQUIRE_CONFERENCE, true),

  pix: {
    provider: env.PIX_PROVIDER || 'DEMO_PIX', // DEMO_PIX | SANTANDER_PIX
    chargeExpirationSeconds: Number(env.PIX_EXPIRATION_SECONDS || 3600),
    webhookSecret: env.PIX_WEBHOOK_SECRET || '',          // segredo compartilhado (path/HMAC)
    demoWebhookSecret: env.DEMO_WEBHOOK_SECRET || 'demo-webhook-secret-apenas-desenvolvimento',
    requireMtlsHeader: bool(env.PIX_WEBHOOK_REQUIRE_MTLS_HEADER, false), // proxy reverso valida o mTLS do banco
    santander: {
      baseUrl: env.SANTANDER_PIX_BASE_URL || '',
      tokenUrl: env.SANTANDER_PIX_TOKEN_URL || '',
      clientId: env.SANTANDER_CLIENT_ID || '',
      clientSecret: env.SANTANDER_CLIENT_SECRET || '',
      certPath: env.SANTANDER_CERT_PATH || '',          // certificado do cliente (mTLS) — fica no servidor
      keyPath: env.SANTANDER_KEY_PATH || '',
      certPassphrase: env.SANTANDER_CERT_PASSPHRASE || '',
      pixKey: env.SANTANDER_PIX_KEY || '',              // chave Pix recebedora
      timeoutMs: Number(env.SANTANDER_TIMEOUT_MS || 15000),
    },
  },

  boleto: {
    provider: env.BOLETO_PROVIDER || 'DEMO_BOLETO', // DEMO_BOLETO | SANTANDER_BOLETO
    defaultDueDays: Number(env.BOLETO_DUE_DAYS || 3),
    webhookSecret: env.BOLETO_WEBHOOK_SECRET || '',
    santander: {
      baseUrl: env.SANTANDER_BOLETO_BASE_URL || '',
      tokenUrl: env.SANTANDER_BOLETO_TOKEN_URL || '',
      clientId: env.SANTANDER_CLIENT_ID || '',
      clientSecret: env.SANTANDER_CLIENT_SECRET || '',
      certPath: env.SANTANDER_CERT_PATH || '',
      keyPath: env.SANTANDER_KEY_PATH || '',
      certPassphrase: env.SANTANDER_CERT_PASSPHRASE || '',
      workspaceId: env.SANTANDER_BOLETO_WORKSPACE || '',
      beneficiaryCode: env.SANTANDER_BOLETO_BENEFICIARIO || '',
      environment: env.SANTANDER_BOLETO_AMBIENTE || 'TESTE',
      timeoutMs: Number(env.SANTANDER_TIMEOUT_MS || 15000),
    },
  },

  card: {
    provider: env.CARD_PROVIDER || 'DEMO_CARD', // DEMO_CARD | GETNET
    callbackSecret: env.CARD_CALLBACK_SECRET || 'demo-card-secret-apenas-desenvolvimento',
    getnet: {
      baseUrl: env.GETNET_BASE_URL || '',
      clientId: env.GETNET_CLIENT_ID || '',
      clientSecret: env.GETNET_CLIENT_SECRET || '',
      sellerId: env.GETNET_SELLER_ID || '',
      terminalId: env.GETNET_TERMINAL_ID || '',
      timeoutMs: Number(env.GETNET_TIMEOUT_MS || 15000),
    },
  },

  fiscal: {
    provider: env.FISCAL_PROVIDER || 'DEMO_FISCAL', // DEMO_FISCAL | NFSE_NACIONAL
    nfseNacional: {
      baseUrl: env.NFSE_NACIONAL_BASE_URL || '',
      certPath: env.NFSE_CERT_PATH || '',             // certificado A1 do prestador (PFX)
      certPassphrase: env.NFSE_CERT_PASSPHRASE || '',
      environment: env.NFSE_AMBIENTE || '2',          // 1 = produção, 2 = produção restrita (homologação)
      timeoutMs: Number(env.NFSE_TIMEOUT_MS || 20000),
    },
  },
};

if (config.env === 'production' && config.demoMode) {
  // Não bloqueia, mas deixa explícito no log.
  console.warn('[ATENÇÃO] DEMO_MODE ativo em produção. Desative com DEMO_MODE=false.');
}

module.exports = config;
