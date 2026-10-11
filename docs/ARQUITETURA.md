# Arquitetura

## Visão geral

Monólito modular em Node.js/Express servindo API REST (`/api`), webhooks (`/api/webhooks`) e o
frontend estático. Regras de negócio ficam em `backend/src/services`; integrações externas ficam atrás
de interfaces em `backend/src/integrations` e são escolhidas por variável de ambiente.

```
Navegador (HTML/CSS/JS) ──HTTPS + cookie httpOnly──► Express ──► services ──► PostgreSQL
                                                         │
Banco / adquirente / Fisco ◄──── adaptadores ────────────┘
Banco / adquirente ──── webhook autenticado ───► /api/webhooks ──► reconsulta o provedor ──► services
```

## Modelo de dados (principais relações)

```
patients 1──1 medical_records
patients 1──n appointments ──1──1 accounts ──1──n account_items
                     │                  ├──1──n payments ──1──n payment_transactions
                     └─n appointment_procedures   ├──1──n settlements (histórico de quitação)
                                                  └──1──n fiscal_documents
payment_webhook_events (bruto, idempotente)   bank_statement_entries ─┐
reconciliation_runs 1──n bank_reconciliation ◄────────────────────────┘
users n──1 roles (permissions[])   sessions   audit_logs (imutável)   settings
professionals · suppliers · insurance_plans · procedures · schedulings
```

Tabelas exigidas pela especificação: todas presentes (`patients`, `medical_records`, `professionals`,
`suppliers`, `insurance_plans`, `procedures`, `appointments`, `appointment_procedures`, `accounts`,
`account_items`, `payments`, `payment_transactions`, `payment_webhook_events`, `settlements`,
`fiscal_documents`, `bank_reconciliation`, `users`, `roles`, `audit_logs`), mais `sessions`,
`settings`, `schedulings`, `bank_statement_entries`, `reconciliation_runs` e `demo_provider_state`.

## Máquinas de estado

**Conta (`accounts.financial_status`) — sempre derivado, nunca editado:**

```
PENDENTE ──pagamento confirmado < total──► PARCIAL ──confirmado = total──► QUITADA
   ▲                                          ▲                              │
   └──────────── estorno / reatribuição ──────┴────────── REABERTURA ◄───────┘
CANCELADA (somente cancelamento de atendimento sem valores recebidos/cobranças em aberto)
```

`recalculateAccount()` bloqueia a conta (`SELECT … FOR UPDATE`), recalcula
`total = Σ itens ativos` e `recebido = Σ (valor − estornado)` dos pagamentos confirmados e grava um
evento em `settlements` (QUITACAO, PAGAMENTO_PARCIAL, REABERTURA, ATUALIZACAO) com origem, pagamento e usuário.
`CHECK`s no banco impedem `recebido > total` e `QUITADA` com saldo.

**Pagamento (`payments.status`):**

```
Pix:     PENDENTE ──(consulta: CONCLUIDA + e2eId)──► CONFIRMADO ──► ESTORNADO_PARCIAL ──► ESTORNADO
                  └─► EXPIRADO / CANCELADO / DIVERGENTE (valor ≠ cobrado, excede saldo)
Cartão:  PROCESSANDO ──(consulta: APROVADA)──► CONFIRMADO      └─► REJEITADO (NEGADA) / CANCELADO
Manual:  AGUARDANDO_CONFERENCIA ──(2º usuário com payments.confer)──► CONFIRMADO | REJEITADO
Qualquer chamada ao provedor que falhe ──► FALHA_COMUNICACAO (nada é confirmado)
```

**Documento fiscal (`fiscal_documents.status`) — independente do financeiro:**

```
PREPARADA ─(integração)─► ENVIADA ─► PROCESSANDO ─► EMITIDA ─► CANCELADA
    │                        └──────────────────────► REJEITADA   (permite novo documento)
    │                        └──► FALHA_COMUNICACAO ─(reenvio com o mesmo nº de DPS)─► …
    └─(exportação)─► EXPORTADA ─(registro manual)─► EMITIDA_EXTERNAMENTE
Demonstração: mesmo fluxo, is_demo = true, número "DEMO-…", sem transmissão.
```

## Garantias da quitação automática

| Risco | Proteção |
|---|---|
| Usuário clica "confirmar" | Não existe endpoint que confirme pagamento eletrônico sem o provedor; manual exige 2º usuário |
| Webhook forjado | Segredo/assinatura (HMAC/mTLS) **e** reconsulta da cobrança no provedor; o payload nunca é prova |
| Webhook repetido | `UNIQUE(provider, event_key)` + `UNIQUE(provider, kind, provider_transaction_id)` + verificação sob lock |
| Concorrência | Lock ordenado conta → pagamento; reatribuição bloqueia as duas contas por ordem de id |
| Valor divergente / excedente | Pagamento vai para `DIVERGENTE`, não conta no saldo, aparece na conciliação |
| Cobrar mais que o saldo | Saldo disponível = saldo − cobranças em andamento |
| Pagou mas o webhook se perdeu | Botão "Consultar status" + cancelamento sempre reconsulta antes |
| Banco fora do ar | Evento fica `ERRO` e é reprocessado a cada 2 min (e sob demanda) |
| Alteração após quitar | Itens bloqueados; correção somente por estorno auditável |
| Exclusão silenciosa | Gatilhos `forbid_delete`/`forbid_update` no banco |
| Arredondamento | Centavos inteiros (`BIGINT`) e parsing por texto |

## Segurança

- **Autenticação**: e-mail + senha (bcrypt). Sessão opaca de 256 bits; no banco só o SHA-256.
  Inatividade (padrão 30 min) e expiração absoluta (8 h). Bloqueio temporário após 5 falhas.
- **Autorização**: permissões finas (`lib/permissions.js`) agrupadas em perfis editáveis pela tela
  *Usuários e permissões*; checadas no servidor em todas as rotas e refletidas no menu.
- **CSRF**: `SameSite=Strict` + cabeçalho `X-Requested-With: SaudeGestao` obrigatório para métodos de escrita.
- **Cabeçalhos**: Helmet, CSP sem `unsafe-inline`, `Cache-Control: no-store` na API, HSTS em produção.
- **Entrada**: validação no servidor (`lib/validate.js`), consultas parametrizadas, CSV protegido contra injeção de fórmulas.
- **Criptografia em trânsito**: TLS no proxy reverso (nginx) com `COOKIE_SECURE=true` e `TRUST_PROXY=1`;
  mTLS com o Santander (cliente) e validação do certificado do banco no webhook.
- **LGPD**: minimização por perfil, auditoria de acesso a ficha/comprovantes, dados fictícios no seed,
  backups com retenção (`scripts/backup.sh`). Avalie criptografia de disco/coluna e política de retenção.

## Exemplo de proxy reverso (produção)

```nginx
server {
  listen 443 ssl;
  server_name erp.hospital.exemplo;
  ssl_certificate     /etc/ssl/erp.crt;
  ssl_certificate_key /etc/ssl/erp.key;

  # Webhook Pix: exige certificado de cliente emitido para o Santander
  location /api/webhooks/pix/ {
    ssl_client_certificate /etc/ssl/santander-ca.pem;
    ssl_verify_client optional;
    if ($ssl_client_verify != SUCCESS) { return 403; }
    proxy_set_header X-Client-Verify $ssl_client_verify;
    proxy_pass http://127.0.0.1:3000;
  }
  location / {
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:3000;
  }
}
```

## API (resumo)

| Método e rota | Permissão |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | — |
| `GET/POST /api/patients`, `GET/PUT /api/patients/:id`, `GET …/history`, `GET …/documents` | patients.*, records.view |
| `GET/POST/PUT /api/professionals \| suppliers \| insurance-plans \| procedures` | registry.* |
| `GET/POST /api/schedulings`, `POST …/:id/status` | scheduling.* |
| `GET/POST /api/appointments`, `POST …/:id/status`, `POST …/:id/cancel` | appointments.* |
| `GET /api/accounts` (filtros de quitação), `GET /api/accounts/:id`, `GET …/settlement` | accounts.view, settlement.view |
| `POST /api/accounts/:id/items`, `POST …/items/:itemId/cancel`, `POST …/check`, `POST …/billing` | accounts.*, billing.manage |
| `POST /api/accounts/:id/payments` (iniciar recebimento) | payments.receive |
| `POST /api/payments/:id/refresh \| confer \| cancel \| refund \| reassign`, `GET …/receipt` | payments.* |
| `POST /api/webhooks/pix/:provider/:secret` · `POST /api/webhooks/card/:provider` | segredo/assinatura |
| `GET /api/fiscal/eligible \| documents`, `POST /api/fiscal/accounts/:id/prepare`, `POST /api/fiscal/documents/:id/submit \| check \| external \| cancel`, `GET …/export` | fiscal.* |
| `POST /api/reconciliation/import \| import-csv \| run`, `POST …/items/:id/resolve`, `GET …/runs` | reconciliation.* |
| `GET /api/reports/:tipo?from&to[&status][&format=csv]` | reports.view / reports.export |
| `GET/POST/PUT /api/users`, `GET/PUT /api/roles` · `GET /api/audit` · `GET/PUT /api/settings` · `GET /api/integrations` | users.manage, audit.view, settings.manage |
| `POST /api/demo/…` (somente `DEMO_MODE=true`) | demo.simulate |
