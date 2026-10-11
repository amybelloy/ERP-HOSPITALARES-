-- =====================================================================
-- Boleto bancário e faturamento de convênios (remessas/lotes)
-- =====================================================================

-- Novos meios de pagamento: BOLETO (via banco) e CONVENIO (repasse da operadora)
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('PIX','CARTAO_CREDITO','CARTAO_DEBITO','DINHEIRO','OUTRO','BOLETO','CONVENIO'));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS boleto_barcode        CHAR(44);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS boleto_digitable_line VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS boleto_due_date       DATE;

ALTER TABLE demo_provider_state DROP CONSTRAINT demo_provider_state_kind_check;
ALTER TABLE demo_provider_state ADD CONSTRAINT demo_provider_state_kind_check
  CHECK (kind IN ('PIX','CARD','PIX_ORPHAN','FISCAL','BOLETO'));

-- Remessas de faturamento para convênios
CREATE SEQUENCE billing_batch_seq START 1;
CREATE TABLE billing_batches (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number             VARCHAR(20) NOT NULL UNIQUE DEFAULT ('REM' || lpad(nextval('billing_batch_seq')::text, 6, '0')),
  insurance_plan_id  BIGINT NOT NULL REFERENCES insurance_plans(id),
  competence         CHAR(7) NOT NULL CHECK (competence ~ '^\d{4}-\d{2}$'),   -- AAAA-MM
  status             VARCHAR(20) NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA','ENVIADA','RETORNO_REGISTRADO','CANCELADA')),
  total_cents        BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents         BIGINT NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  glosa_cents        BIGINT NOT NULL DEFAULT 0 CHECK (glosa_cents >= 0),
  protocol           VARCHAR(60),
  notes              TEXT,
  created_by         BIGINT NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at            TIMESTAMPTZ,
  returned_at        TIMESTAMPTZ
);

CREATE TABLE billing_batch_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        BIGINT NOT NULL REFERENCES billing_batches(id),
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  billed_cents    BIGINT NOT NULL CHECK (billed_cents > 0),
  paid_cents      BIGINT CHECK (paid_cents >= 0),
  glosa_cents     BIGINT CHECK (glosa_cents >= 0),
  glosa_reason    TEXT,
  payment_id      BIGINT REFERENCES payments(id),
  UNIQUE (batch_id, account_id),
  CHECK (paid_cents IS NULL OR paid_cents + COALESCE(glosa_cents, 0) <= billed_cents)
);
-- Uma conta só pode estar em uma remessa ativa
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_batch_id BIGINT REFERENCES billing_batches(id);

CREATE TRIGGER billing_batches_no_delete     BEFORE DELETE ON billing_batches     FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER billing_batch_items_no_delete BEFORE DELETE ON billing_batch_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();
