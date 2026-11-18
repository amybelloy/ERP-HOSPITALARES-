-- =====================================================================
-- MÓDULOS ASSISTENCIAIS: leitos, classificação de risco, PEP, prescrição,
-- checagem (administração), enfermagem (SAE, escalas, sinais vitais,
-- balanço hídrico, passagem de plantão), alergias.
-- =====================================================================

-- Usuário pode estar vinculado a um profissional (CRM/COREN) para assinatura
ALTER TABLE users ADD COLUMN IF NOT EXISTS professional_id BIGINT REFERENCES professionals(id);

-- ---------------------------------------------------------------- Alergias
CREATE TABLE patient_allergies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id  BIGINT NOT NULL REFERENCES patients(id),
  substance   VARCHAR(120) NOT NULL,
  reaction    VARCHAR(200),
  severity    VARCHAR(10) NOT NULL DEFAULT 'MODERADA' CHECK (severity IN ('LEVE','MODERADA','GRAVE')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX patient_allergies_patient_idx ON patient_allergies (patient_id) WHERE active;

-- ---------------------------------------------------------------- Unidades e leitos
CREATE TABLE care_units (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code    VARCHAR(20) NOT NULL UNIQUE,
  name    VARCHAR(120) NOT NULL,
  kind    VARCHAR(20) NOT NULL CHECK (kind IN ('ENFERMARIA','APARTAMENTO','UTI','OBSERVACAO','PRONTO_SOCORRO','CENTRO_CIRURGICO')),
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE beds (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id                 BIGINT NOT NULL REFERENCES care_units(id),
  code                    VARCHAR(20) NOT NULL,
  status                  VARCHAR(20) NOT NULL DEFAULT 'LIVRE' CHECK (status IN ('LIVRE','OCUPADO','HIGIENIZACAO','MANUTENCAO','RESERVADO','BLOQUEADO')),
  current_appointment_id  BIGINT REFERENCES appointments(id),
  status_since            TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                   VARCHAR(200),
  UNIQUE (unit_id, code),
  CHECK ((status = 'OCUPADO') = (current_appointment_id IS NOT NULL))
);
-- Um atendimento ocupa no máximo um leito
CREATE UNIQUE INDEX beds_current_appointment_uq ON beds (current_appointment_id) WHERE current_appointment_id IS NOT NULL;

CREATE TABLE bed_movements (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('INTERNACAO','TRANSFERENCIA','ALTA','OBITO')),
  from_bed_id     BIGINT REFERENCES beds(id),
  to_bed_id       BIGINT REFERENCES beds(id),
  reason          TEXT,
  user_id         BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bed_movements_appt_idx ON bed_movements (appointment_id);

-- ---------------------------------------------------------------- Classificação de risco (protocolo de cores)
CREATE TABLE triages (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id   BIGINT NOT NULL REFERENCES appointments(id),
  color            VARCHAR(10) NOT NULL CHECK (color IN ('VERMELHO','LARANJA','AMARELO','VERDE','AZUL')),
  target_minutes   INTEGER NOT NULL,
  chief_complaint  VARCHAR(300) NOT NULL,
  flowchart        VARCHAR(120),
  discriminator    VARCHAR(200),
  pain_score       SMALLINT CHECK (pain_score BETWEEN 0 AND 10),
  notes            TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'AGUARDANDO' CHECK (status IN ('AGUARDANDO','EM_ATENDIMENTO','ATENDIDO','EVADIU')),
  called_at        TIMESTAMPTZ,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX triages_status_idx ON triages (status, created_at);

-- ---------------------------------------------------------------- Sinais vitais (+ escore NEWS)
CREATE TABLE vital_signs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id   BIGINT NOT NULL REFERENCES appointments(id),
  systolic         SMALLINT CHECK (systolic BETWEEN 30 AND 300),
  diastolic        SMALLINT CHECK (diastolic BETWEEN 10 AND 200),
  heart_rate       SMALLINT CHECK (heart_rate BETWEEN 10 AND 300),
  resp_rate        SMALLINT CHECK (resp_rate BETWEEN 2 AND 80),
  temp_tenths      SMALLINT CHECK (temp_tenths BETWEEN 250 AND 450),   -- 36,5 °C = 365
  spo2             SMALLINT CHECK (spo2 BETWEEN 30 AND 100),
  on_oxygen        BOOLEAN NOT NULL DEFAULT FALSE,
  consciousness    CHAR(1) NOT NULL DEFAULT 'A' CHECK (consciousness IN ('A','C','V','P','U')),
  glucose          SMALLINT CHECK (glucose BETWEEN 10 AND 1000),
  pain_score       SMALLINT CHECK (pain_score BETWEEN 0 AND 10),
  weight_grams     INTEGER CHECK (weight_grams BETWEEN 300 AND 400000),
  news_score       SMALLINT,
  news_risk        VARCHAR(10),
  measured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id          BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vital_signs_appt_idx ON vital_signs (appointment_id, measured_at DESC);

-- ---------------------------------------------------------------- Evoluções / anotações (PEP)
CREATE TABLE clinical_notes (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('ANAMNESE','EVOLUCAO_MEDICA','EVOLUCAO_ENFERMAGEM','ANOTACAO_ENFERMAGEM','MULTIPROFISSIONAL','SUMARIO_ALTA')),
  text            TEXT NOT NULL,
  cid_code        VARCHAR(10),
  parent_id       BIGINT REFERENCES clinical_notes(id),   -- adendo/correção (o original nunca é alterado)
  author_id       BIGINT NOT NULL REFERENCES users(id),
  professional_id BIGINT REFERENCES professionals(id),
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clinical_notes_appt_idx ON clinical_notes (appointment_id, signed_at DESC);

-- ---------------------------------------------------------------- Prescrição
CREATE TABLE prescriptions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id   BIGINT NOT NULL REFERENCES appointments(id),
  prescriber_id    BIGINT NOT NULL REFERENCES users(id),
  professional_id  BIGINT REFERENCES professionals(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA','SUSPENSA','ENCERRADA')),
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until      TIMESTAMPTZ NOT NULL,
  notes            TEXT,
  suspended_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from)
);
CREATE INDEX prescriptions_appt_idx ON prescriptions (appointment_id);

CREATE TABLE prescription_items (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prescription_id         BIGINT NOT NULL REFERENCES prescriptions(id),
  kind                    VARCHAR(20) NOT NULL CHECK (kind IN ('MEDICAMENTO','SOLUCAO','CUIDADO','DIETA','PROCEDIMENTO')),
  description             VARCHAR(200) NOT NULL,
  dose                    VARCHAR(60),
  route                   VARCHAR(30),
  frequency_hours         SMALLINT CHECK (frequency_hours BETWEEN 1 AND 168),
  if_needed               BOOLEAN NOT NULL DEFAULT FALSE,        -- "se necessário" (ACM/SN)
  first_dose_at           TIMESTAMPTZ,
  instructions            VARCHAR(300),
  allergy_override_reason TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','SUSPENSO')),
  suspended_reason        TEXT
);
CREATE INDEX prescription_items_presc_idx ON prescription_items (prescription_id);

-- Aprazamento + checagem (administração à beira-leito)
CREATE TABLE administrations (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prescription_item_id  BIGINT NOT NULL REFERENCES prescription_items(id),
  appointment_id        BIGINT NOT NULL REFERENCES appointments(id),
  scheduled_at          TIMESTAMPTZ NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ADMINISTRADO','NAO_ADMINISTRADO','SUSPENSO')),
  performed_at          TIMESTAMPTZ,
  performed_by          BIGINT REFERENCES users(id),
  is_late               BOOLEAN NOT NULL DEFAULT FALSE,
  reason                TEXT,
  lot                   VARCHAR(40),
  UNIQUE (prescription_item_id, scheduled_at),
  CHECK (status = 'PENDENTE' OR status = 'SUSPENSO' OR (performed_at IS NOT NULL AND performed_by IS NOT NULL))
);
CREATE INDEX administrations_sched_idx ON administrations (appointment_id, scheduled_at);
CREATE INDEX administrations_pending_idx ON administrations (scheduled_at) WHERE status = 'PENDENTE';

-- ---------------------------------------------------------------- Enfermagem
-- Escalas (Braden, Morse, Glasgow)
CREATE TABLE nursing_scales (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  scale           VARCHAR(20) NOT NULL CHECK (scale IN ('BRADEN','MORSE','GLASGOW')),
  answers         JSONB NOT NULL,
  score           SMALLINT NOT NULL,
  risk            VARCHAR(30) NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX nursing_scales_appt_idx ON nursing_scales (appointment_id, scale, created_at DESC);

-- SAE: Sistematização da Assistência de Enfermagem (diagnósticos, resultados esperados, intervenções)
CREATE TABLE nursing_care_plans (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  history         TEXT,
  diagnoses       TEXT[] NOT NULL,
  goals           TEXT,
  interventions   TEXT[] NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','SUBSTITUIDO','ENCERRADO')),
  author_id       BIGINT NOT NULL REFERENCES users(id),
  professional_id BIGINT REFERENCES professionals(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX nursing_care_plans_active_uq ON nursing_care_plans (appointment_id) WHERE status = 'ATIVO';

-- Balanço hídrico
CREATE TABLE fluid_balance (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  direction       VARCHAR(10) NOT NULL CHECK (direction IN ('ENTRADA','SAIDA')),
  kind            VARCHAR(40) NOT NULL,       -- oral, soro, diurese, dreno, vômito...
  volume_ml       INTEGER NOT NULL CHECK (volume_ml BETWEEN 1 AND 20000),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         BIGINT NOT NULL REFERENCES users(id)
);
CREATE INDEX fluid_balance_appt_idx ON fluid_balance (appointment_id, recorded_at);

-- Passagem de plantão (modelo SBAR)
CREATE TABLE shift_handoffs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  BIGINT NOT NULL REFERENCES appointments(id),
  shift           VARCHAR(10) NOT NULL CHECK (shift IN ('MANHA','TARDE','NOITE')),
  situation       TEXT NOT NULL,
  background      TEXT,
  assessment      TEXT,
  recommendation  TEXT,
  author_id       BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shift_handoffs_appt_idx ON shift_handoffs (appointment_id, created_at DESC);

-- Registros clínicos são imutáveis (correções por adendo / novo registro)
CREATE TRIGGER clinical_notes_no_update   BEFORE UPDATE ON clinical_notes   FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER clinical_notes_no_delete   BEFORE DELETE ON clinical_notes   FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER vital_signs_no_update      BEFORE UPDATE ON vital_signs      FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER vital_signs_no_delete      BEFORE DELETE ON vital_signs      FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER nursing_scales_no_update   BEFORE UPDATE ON nursing_scales   FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER nursing_scales_no_delete   BEFORE DELETE ON nursing_scales   FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER administrations_no_delete  BEFORE DELETE ON administrations  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER prescriptions_no_delete    BEFORE DELETE ON prescriptions    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER prescription_items_no_del  BEFORE DELETE ON prescription_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER bed_movements_no_delete    BEFORE DELETE ON bed_movements    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER fluid_balance_no_delete    BEFORE DELETE ON fluid_balance    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER shift_handoffs_no_delete   BEFORE DELETE ON shift_handoffs   FOR EACH ROW EXECUTE FUNCTION forbid_delete();
