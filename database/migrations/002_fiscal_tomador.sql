-- Nota fiscal: observações e tomador escolhido pelo usuário (pode ser diferente do paciente)
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS observations TEXT;
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS taker_is_patient BOOLEAN NOT NULL DEFAULT TRUE;
