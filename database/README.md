# Banco de dados

- `migrations/` — migrações SQL versionadas, aplicadas em ordem por `backend/src/db/migrate.js`
  (controle em `schema_migrations`, com lock consultivo para execução concorrente segura).
- Dados iniciais e fictícios: `backend/src/db/seed.js`.

Princípios do modelo:

- Valores monetários em **centavos (`BIGINT`)** — nunca `float`/`numeric` com arredondamento implícito.
- Status financeiro da conta é **derivado** dos pagamentos confirmados (ver `settlementService.js`);
  `CHECK` impede `QUITADA` sem `recebido = total > 0` e impede `recebido > total`.
- Gatilhos bloqueiam `DELETE` em contas, itens, pagamentos, transações, notificações, quitações,
  documentos fiscais, extratos, conciliação e auditoria; `UPDATE` também é bloqueado em
  `payment_transactions`, `settlements` e `audit_logs` (registros imutáveis).
- Idempotência: `UNIQUE (provider, kind, provider_transaction_id)` em `payment_transactions` e
  `UNIQUE (provider, event_key)` em `payment_webhook_events`.
- No máximo um documento fiscal ativo por conta (índice único parcial).
