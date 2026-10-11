-- =====================================================================
-- SAÚDE GESTÃO — Esquema relacional principal
-- Valores monetários SEMPRE em centavos (BIGINT). Nunca usar float.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Segurança: perfis, usuários e sessões
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL UNIQUE,
  name         VARCHAR(120) NOT NULL,
  permissions  TEXT[]       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           VARCHAR(160) NOT NULL,
  email          VARCHAR(160) NOT NULL,
  password_hash  VARCHAR(200) NOT NULL,
  role_id        BIGINT       NOT NULL REFERENCES roles(id),
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  failed_logins  INTEGER      NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    CHAR(64)    NOT NULL UNIQUE,          -- SHA-256 do token; o token em si só existe no cookie
  user_id       BIGINT      NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            VARCHAR(64),
  user_agent    VARCHAR(300)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------
-- Configurações gerais (dados da instituição, modo fiscal etc.)
-- Credenciais NÃO ficam aqui: ficam em variáveis de ambiente.
-- ---------------------------------------------------------------------
CREATE TABLE settings (
  key         VARCHAR(80) PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Cadastros
-- ---------------------------------------------------------------------
CREATE TABLE insurance_plans (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  ans_code    VARCHAR(20),
  cnpj        CHAR(14),
  plan_type   VARCHAR(80),
  phone       VARCHAR(30),
  email       VARCHAR(160),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE patient_code_seq START 1;
CREATE TABLE patients (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                   VARCHAR(20)  NOT NULL UNIQUE DEFAULT ('PAC' || lpad(nextval('patient_code_seq')::text, 6, '0')),
  name                   VARCHAR(160) NOT NULL,
  social_name            VARCHAR(160),
  cpf                    CHAR(11),
  birth_date             DATE,
  sex                    CHAR(1) CHECK (sex IN ('F','M','O')),
  mother_name            VARCHAR(160),
  phone                  VARCHAR(30),
  email                  VARCHAR(160),
  zip_code               CHAR(8),
  address                VARCHAR(200),
  address_number         VARCHAR(20),
  district               VARCHAR(100),
  city                   VARCHAR(100),
  city_ibge_code         CHAR(7),
  state                  CHAR(2),
  insurance_plan_id      BIGINT REFERENCES insurance_plans(id),
  insurance_card_number  VARCHAR(40),
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_by             BIGINT REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX patients_cpf_uq ON patients (cpf) WHERE cpf IS NOT NULL;
CREATE INDEX patients_name_trgm ON patients USING gin (lower(name) gin_trgm_ops);
CREATE INDEX patients_birth_idx ON patients (birth_date);

-- Prontuário: exatamente UM por paciente (não se cria outro a cada retorno)
CREATE SEQUENCE medical_record_seq START 1;
CREATE TABLE medical_records (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id     BIGINT NOT NULL UNIQUE REFERENCES patients(id),
  record_number  VARCHAR(20) NOT NULL UNIQUE DEFAULT ('PRT' || lpad(nextval('medical_record_seq')::text, 6, '0')),
  notes          TEXT,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE professionals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            VARCHAR(160) NOT NULL,
  kind            VARCHAR(40)  NOT NULL DEFAULT 'MEDICO',
  council         VARCHAR(20),
  council_number  VARCHAR(20),
  council_state   CHAR(2),
  specialty       VARCHAR(120),
  cpf             CHAR(11),
  email           VARCHAR(160),
  phone           VARCHAR(30),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  trade_name  VARCHAR(160),
  cnpj        CHAR(14) UNIQUE,
  category    VARCHAR(80),
  email       VARCHAR(160),
  phone       VARCHAR(30),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE procedures (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 VARCHAR(30)  NOT NULL UNIQUE,
  name                 VARCHAR(200) NOT NULL,
  category             VARCHAR(80)  NOT NULL DEFAULT 'EXAME',
  description          TEXT,
  price_cents          BIGINT NOT NULL CHECK (price_cents >= 0),
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  -- Regras fiscais (NFS-e)
  service_list_item    VARCHAR(10),            -- item da lista LC 116/2003 (ex.: 04.03)
  national_tax_code    VARCHAR(10),            -- código de tributação nacional (NFS-e Nacional)
  nbs_code             VARCHAR(12),
  iss_rate_bp          INTEGER CHECK (iss_rate_bp BETWEEN 0 AND 10000),  -- alíquota em pontos-base (200 = 2,00%)
  -- Faturamento
  tuss_code            VARCHAR(20),
  billing_notes        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX procedures_name_trgm ON procedures USING gin (lower(name) gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Agendamento e atendimento
-- ---------------------------------------------------------------------
CREATE SEQUENCE appointment_number_seq START 1;
CREATE TABLE appointments (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number             VARCHAR(20) NOT NULL UNIQUE DEFAULT ('ATD' || lpad(nextval('appointment_number_seq')::text, 7, '0')),
  patient_id         BIGINT NOT NULL REFERENCES patients(id),
  medical_record_id  BIGINT NOT NULL REFERENCES medical_records(id),
  professional_id    BIGINT REFERENCES professionals(id),
  sector             VARCHAR(80) NOT NULL,
  type               VARCHAR(30) NOT NULL CHECK (type IN ('AMBULATORIAL','EXAME','URGENCIA','INTERNACAO','CONSULTA')),
  modality           VARCHAR(20) NOT NULL CHECK (modality IN ('PARTICULAR','CONVENIO')),
  insurance_plan_id  BIGINT REFERENCES insurance_plans(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','EM_ATENDIMENTO','FINALIZADO','CANCELADO')),
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by          BIGINT NOT NULL REFERENCES users(id),
  finished_at        TIMESTAMPTZ,
  cancel_reason      TEXT,
  notes              TEXT,
  CHECK (modality = 'PARTICULAR' OR insurance_plan_id IS NOT NULL)
);
CREATE INDEX appointments_patient_idx ON appointments (patient_id, opened_at DESC);
CREATE INDEX appointments_opened_idx  ON appointments (opened_at);

CREATE TABLE schedulings (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id       BIGINT NOT NULL REFERENCES patients(id),
  professional_id  BIGINT REFERENCES professionals(id),
  procedure_id     BIGINT REFERENCES procedures(id),
  scheduled_at     TIMESTAMPTZ NOT NULL,
  sector           VARCHAR(80),
  status           VARCHAR(20) NOT NULL DEFAULT 'AGENDADO' CHECK (status IN ('AGENDADO','CONFIRMADO','CANCELADO','ATENDIDO','FALTOU')),
  appointment_id   BIGINT REFERENCES appointments(id),
  notes            TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX schedulings_date_idx ON schedulings (scheduled_at);

CREATE TABLE appointment_procedures (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id   BIGINT NOT NULL REFERENCES appointments(id),
  procedure_id     BIGINT NOT NULL REFERENCES procedures(id),
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  professional_id  BIGINT REFERENCES professionals(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'SOLICITADO' CHECK (status IN ('SOLICITADO','REALIZADO','CANCELADO')),
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointment_procedures_appt_idx ON appointment_procedures (appointment_id);

-- ---------------------------------------------------------------------
-- Conta do atendimento (uma por atendimento)
-- ---------------------------------------------------------------------
CREATE SEQUENCE account_number_seq START 1;
CREATE TABLE accounts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number            VARCHAR(20) NOT NULL UNIQUE DEFAULT ('CTA' || lpad(nextval('account_number_seq')::text, 7, '0')),
  appointment_id    BIGINT NOT NULL UNIQUE REFERENCES appointments(id),
  patient_id        BIGINT NOT NULL REFERENCES patients(id),
  total_cents       BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  received_cents    BIGINT NOT NULL DEFAULT 0 CHECK (received_cents >= 0),
  financial_status  VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
                    CHECK (financial_status IN ('PENDENTE','PARCIAL','QUITADA','CANCELADA')),
  fiscal_status     VARCHAR(30) NOT NULL DEFAULT 'NAO_SOLICITADA',
  billing_status    VARCHAR(20) NOT NULL DEFAULT 'ABERTA' CHECK (billing_status IN ('ABERTA','FECHADA','FATURADA')),
  checked_at        TIMESTAMPTZ,
  checked_by        BIGINT REFERENCES users(id),
  settled_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Rede de segurança: nunca pode haver recebido maior que o total
  CONSTRAINT accounts_received_le_total CHECK (received_cents <= total_cents),
  -- Quitada só se o saldo for zero e houver valor
  CONSTRAINT accounts_settled_consistency CHECK (
    financial_status <> 'QUITADA' OR (received_cents = total_cents AND total_cents > 0)
  )
);
CREATE INDEX accounts_patient_idx ON accounts (patient_id);
CREATE INDEX accounts_status_idx  ON accounts (financial_status);

CREATE TABLE account_items (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id                BIGINT NOT NULL REFERENCES accounts(id),
  procedure_id              BIGINT REFERENCES procedures(id),
  appointment_procedure_id  BIGINT REFERENCES appointment_procedures(id),
  description               VARCHAR(200) NOT NULL,
  quantity                  INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents          BIGINT  NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents            BIGINT  NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  surcharge_cents           BIGINT  NOT NULL DEFAULT 0 CHECK (surcharge_cents >= 0),
  total_cents               BIGINT  NOT NULL CHECK (total_cents >= 0),
  price_overridden          BOOLEAN NOT NULL DEFAULT FALSE,
  adjustment_reason         TEXT,
  status                    VARCHAR(20) NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','CANCELADO')),
  cancel_reason             TEXT,
  cancelled_by              BIGINT REFERENCES users(id),
  cancelled_at              TIMESTAMPTZ,
  created_by                BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_cents = quantity * unit_price_cents - discount_cents + surcharge_cents)
);
CREATE INDEX account_items_account_idx ON account_items (account_id);

-- ---------------------------------------------------------------------
-- Pagamentos
-- payments              = intenção/cobrança vinculada a uma conta
-- payment_transactions  = fatos confirmados pelo provedor ou conferência (liquidação, estorno, ...)
-- payment_webhook_events= notificações brutas recebidas (idempotência)
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           BIGINT NOT NULL REFERENCES accounts(id),
  method               VARCHAR(20) NOT NULL CHECK (method IN ('PIX','CARTAO_CREDITO','CARTAO_DEBITO','DINHEIRO','OUTRO')),
  method_label         VARCHAR(80),
  amount_cents         BIGINT NOT NULL CHECK (amount_cents > 0),
  refunded_cents       BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  installments         INTEGER NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 24),
  status               VARCHAR(30) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN (
                         'PENDENTE','PROCESSANDO','AGUARDANDO_CONFERENCIA','CONFIRMADO',
                         'REJEITADO','CANCELADO','EXPIRADO','ESTORNADO','ESTORNADO_PARCIAL','DIVERGENTE','FALHA_COMUNICACAO')),
  provider             VARCHAR(30) NOT NULL,     -- DEMO_PIX, SANTANDER_PIX, DEMO_CARD, GETNET, MANUAL
  provider_charge_id   VARCHAR(100),             -- txid (Pix) / id da transação no terminal
  pix_copy_paste       TEXT,
  pix_location         VARCHAR(300),
  expires_at           TIMESTAMPTZ,
  manual_reference     VARCHAR(100),             -- NSU / código de autorização informado manualmente
  confirmation_source  VARCHAR(40) CHECK (confirmation_source IN
                         ('WEBHOOK_VALIDADO_CONSULTA','CONSULTA_PROVEDOR','TERMINAL_PROVEDOR','CONFERENCIA_MANUAL')),
  confirmed_at         TIMESTAMPTZ,
  status_reason        TEXT,
  is_demo              BOOLEAN NOT NULL DEFAULT FALSE,
  created_by           BIGINT NOT NULL REFERENCES users(id),
  conferred_by         BIGINT REFERENCES users(id),
  conferred_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (refunded_cents <= amount_cents),
  CHECK (status NOT IN ('CONFIRMADO','ESTORNADO','ESTORNADO_PARCIAL') OR (confirmed_at IS NOT NULL AND confirmation_source IS NOT NULL)),
  CHECK (conferred_by IS NULL OR conferred_by <> created_by)
);
CREATE UNIQUE INDEX payments_provider_charge_uq ON payments (provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;
CREATE INDEX payments_account_idx ON payments (account_id);
CREATE INDEX payments_status_idx  ON payments (status);
CREATE INDEX payments_created_idx ON payments (created_at);

CREATE TABLE payment_transactions (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id               BIGINT NOT NULL REFERENCES payments(id),
  account_id               BIGINT NOT NULL REFERENCES accounts(id),
  appointment_id           BIGINT NOT NULL REFERENCES appointments(id),
  kind                     VARCHAR(30) NOT NULL CHECK (kind IN
                             ('LIQUIDACAO','ESTORNO','REJEICAO','CANCELAMENTO','REATRIBUICAO','LIQUIDACAO_DUPLICADA','DIVERGENCIA')),
  provider                 VARCHAR(30) NOT NULL,
  provider_transaction_id  VARCHAR(120) NOT NULL,   -- endToEndId / id devolução / NSU / id interno
  amount_cents             BIGINT NOT NULL CHECK (amount_cents >= 0),
  status                   VARCHAR(30) NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,
  source                   VARCHAR(40) NOT NULL,
  raw                      JSONB,
  created_by               BIGINT REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotência: a mesma liquidação/estorno nunca é registrada duas vezes
  CONSTRAINT payment_transactions_idem_uq UNIQUE (provider, kind, provider_transaction_id)
);
CREATE INDEX payment_transactions_payment_idx ON payment_transactions (payment_id);

CREATE TABLE payment_webhook_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         VARCHAR(30)  NOT NULL,
  event_key        VARCHAR(200) NOT NULL,
  signature_valid  BOOLEAN NOT NULL,
  headers          JSONB,
  payload          JSONB NOT NULL,
  status           VARCHAR(30) NOT NULL DEFAULT 'RECEBIDO' CHECK (status IN
                     ('RECEBIDO','PROCESSADO','DUPLICADO','ERRO','INVALIDO','SEM_COBRANCA')),
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  CONSTRAINT payment_webhook_events_uq UNIQUE (provider, event_key)
);

-- Histórico de quitação (cada mudança de estado financeiro da conta)
CREATE TABLE settlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  event            VARCHAR(30) NOT NULL,     -- QUITACAO, PAGAMENTO_PARCIAL, REABERTURA, AJUSTE_TOTAL
  previous_status  VARCHAR(20) NOT NULL,
  new_status       VARCHAR(20) NOT NULL,
  total_cents      BIGINT NOT NULL,
  received_cents   BIGINT NOT NULL,
  balance_cents    BIGINT NOT NULL,
  source           VARCHAR(60) NOT NULL,     -- origem da confirmação (webhook validado, terminal, conferência manual...)
  payment_id       BIGINT REFERENCES payments(id),
  user_id          BIGINT REFERENCES users(id),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlements_account_idx ON settlements (account_id, created_at);

-- ---------------------------------------------------------------------
-- Fiscal (status fiscal é independente do financeiro)
-- ---------------------------------------------------------------------
CREATE SEQUENCE dps_number_seq START 1;
CREATE TABLE fiscal_documents (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          BIGINT NOT NULL REFERENCES accounts(id),
  mode                VARCHAR(20) NOT NULL CHECK (mode IN ('INTEGRACAO','EXPORTACAO','DEMONSTRACAO')),
  provider            VARCHAR(30) NOT NULL,      -- NFSE_NACIONAL, EXPORTACAO, DEMO_FISCAL
  is_demo             BOOLEAN NOT NULL DEFAULT FALSE,
  status              VARCHAR(30) NOT NULL CHECK (status IN
                        ('PREPARADA','ENVIADA','PROCESSANDO','EMITIDA','REJEITADA','CANCELADA','EXPORTADA','EMITIDA_EXTERNAMENTE','FALHA_COMUNICACAO')),
  dps_number          BIGINT NOT NULL DEFAULT nextval('dps_number_seq'),
  dps_series          VARCHAR(5) NOT NULL DEFAULT '1',
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  taker               JSONB NOT NULL,           -- snapshot do tomador
  service             JSONB NOT NULL,           -- snapshot do serviço
  provider_data       JSONB NOT NULL,           -- snapshot do prestador
  nfse_number         VARCHAR(30),
  verification_code   VARCHAR(60),
  access_key          VARCHAR(60),              -- chave de acesso NFS-e Nacional
  protocol            VARCHAR(80),
  official_url        VARCHAR(400),
  xml_document        TEXT,
  rejection_reason    TEXT,
  external_reference  VARCHAR(120),
  requested_by        BIGINT NOT NULL REFERENCES users(id),
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        BIGINT REFERENCES users(id),
  cancel_reason       TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No máximo um documento fiscal "vivo" por conta
CREATE UNIQUE INDEX fiscal_documents_active_uq ON fiscal_documents (account_id)
  WHERE status NOT IN ('REJEITADA','CANCELADA');
CREATE INDEX fiscal_documents_status_idx ON fiscal_documents (status);

-- ---------------------------------------------------------------------
-- Conciliação bancária
-- ---------------------------------------------------------------------
CREATE TABLE bank_statement_entries (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      VARCHAR(30)  NOT NULL,
  external_id   VARCHAR(120) NOT NULL,        -- endToEndId / id da devolução / id do extrato
  kind          VARCHAR(20)  NOT NULL CHECK (kind IN ('CREDITO','DEVOLUCAO')),
  txid          VARCHAR(100),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  occurred_at   TIMESTAMPTZ NOT NULL,
  description   VARCHAR(300),
  raw           JSONB,
  import_batch  VARCHAR(60),
  imported_by   BIGINT REFERENCES users(id),
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_statement_entries_uq UNIQUE (provider, kind, external_id)
);
CREATE INDEX bank_statement_entries_date_idx ON bank_statement_entries (occurred_at);

CREATE TABLE reconciliation_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  summary       JSONB NOT NULL DEFAULT '{}',
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_reconciliation (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                  BIGINT NOT NULL REFERENCES reconciliation_runs(id),
  category                VARCHAR(40) NOT NULL CHECK (category IN (
                            'CONCILIADO','SEM_CONTA','SEM_TRANSACAO_BANCARIA','VALOR_DIVERGENTE',
                            'DUPLICADA','PENDENTE','ESTORNO')),
  statement_entry_id      BIGINT REFERENCES bank_statement_entries(id),
  payment_id              BIGINT REFERENCES payments(id),
  account_id              BIGINT REFERENCES accounts(id),
  expected_cents          BIGINT,
  found_cents             BIGINT,
  difference_cents        BIGINT,
  description             TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','EM_ANALISE','RESOLVIDA','JUSTIFICADA')),
  resolution_note         TEXT,
  resolved_by             BIGINT REFERENCES users(id),
  resolved_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bank_reconciliation_run_idx ON bank_reconciliation (run_id);

-- ---------------------------------------------------------------------
-- Auditoria (somente inserção)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     BIGINT REFERENCES users(id),
  user_email  VARCHAR(160),
  action      VARCHAR(80) NOT NULL,
  entity      VARCHAR(60) NOT NULL,
  entity_id   VARCHAR(60),
  details     JSONB,
  ip          VARCHAR(64),
  user_agent  VARCHAR(300)
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id);
CREATE INDEX audit_logs_user_idx   ON audit_logs (user_id, occurred_at);
CREATE INDEX audit_logs_date_idx   ON audit_logs (occurred_at);

-- ---------------------------------------------------------------------
-- Estado do provedor de DEMONSTRAÇÃO (simula o "lado do banco/terminal")
-- Só é utilizado quando os provedores estão em modo demo.
-- ---------------------------------------------------------------------
CREATE TABLE demo_provider_state (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          VARCHAR(20)  NOT NULL CHECK (kind IN ('PIX','CARD','PIX_ORPHAN','FISCAL')),
  external_id   VARCHAR(120) NOT NULL UNIQUE,
  amount_cents  BIGINT NOT NULL,
  status        VARCHAR(30) NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Proteções contra exclusão/alteração silenciosa
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Exclusão não permitida em %. Utilize cancelamento/estorno auditável.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Alteração não permitida em % (registro imutável).', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_no_delete             BEFORE DELETE ON accounts             FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER account_items_no_delete        BEFORE DELETE ON account_items        FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payments_no_delete             BEFORE DELETE ON payments             FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_transactions_no_delete BEFORE DELETE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_transactions_no_update BEFORE UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER webhook_events_no_delete       BEFORE DELETE ON payment_webhook_events FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER settlements_no_delete          BEFORE DELETE ON settlements          FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER settlements_no_update          BEFORE UPDATE ON settlements          FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER fiscal_documents_no_delete     BEFORE DELETE ON fiscal_documents     FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER statement_no_delete            BEFORE DELETE ON bank_statement_entries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER reconciliation_no_delete       BEFORE DELETE ON bank_reconciliation  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER audit_logs_no_delete           BEFORE DELETE ON audit_logs           FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER audit_logs_no_update           BEFORE UPDATE ON audit_logs           FOR EACH ROW EXECUTE FUNCTION forbid_update();
