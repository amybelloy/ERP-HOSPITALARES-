'use strict';
const config = require('./config');
const { createApp } = require('./app');
const { migrate } = require('./db/migrate');
const webhooks = require('./services/webhookService');

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Saúde Gestão em http://localhost:${config.port}  (DEMO_MODE=${config.demoMode})`);
    console.log(`Provedores: Pix=${config.pix.provider} Cartão=${config.card.provider} Fiscal=${config.fiscal.provider}`);
  });
  // Reprocessamento periódico de notificações que falharam (ex.: indisponibilidade do banco)
  setInterval(() => webhooks.retryFailed().catch((e) => console.error('[retry webhooks]', e.message)), 2 * 60 * 1000).unref();
}

main().catch((err) => { console.error(err); process.exit(1); });
