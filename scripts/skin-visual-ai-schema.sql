-- Auth/accounting migration ONLY. Prepared, not executed automatically.
-- Apply deliberately with the existing AUTH database migration credentials.
-- No clinical content, image/prompt/result, patient/record ID or names are stored.
BEGIN;
CREATE TABLE IF NOT EXISTS skin_visual_ai_usage (
  actor_key TEXT NOT NULL CHECK (actor_key ~ '^(user:[1-9][0-9]*|master:[0-9a-f]{64})$'),
  request_id UUID NOT NULL,
  effective_user_id INTEGER NOT NULL,
  clinic_id UUID NOT NULL,
  month_utc DATE NOT NULL CHECK (EXTRACT(DAY FROM month_utc) = 1),
  reserved_micro_usd BIGINT NOT NULL CHECK (reserved_micro_usd = 325000),
  charged_micro_usd BIGINT NOT NULL CHECK (charged_micro_usd >= 0 AND charged_micro_usd <= reserved_micro_usd),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'uncertain')),
  input_tokens INTEGER CHECK (input_tokens BETWEEN 1 AND 1048576),
  output_tokens INTEGER CHECK (output_tokens BETWEEN 1 AND 4096), -- visible output + thinking
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_key, request_id),
  UNIQUE (effective_user_id, request_id),
  CHECK (status <> 'completed' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CHECK (status = 'completed' OR charged_micro_usd = reserved_micro_usd)
);
CREATE INDEX IF NOT EXISTS skin_visual_ai_usage_month ON skin_visual_ai_usage(month_utc);
CREATE INDEX IF NOT EXISTS skin_visual_ai_usage_user_month ON skin_visual_ai_usage(effective_user_id, month_utc);
CREATE INDEX IF NOT EXISTS skin_visual_ai_usage_actor_month ON skin_visual_ai_usage(actor_key, month_utc);
CREATE INDEX IF NOT EXISTS skin_visual_ai_usage_flight ON skin_visual_ai_usage(expires_at) WHERE status = 'reserved';
-- Keep accounting durable across clinical/user deletion. Intentionally no cascading FK.
-- Runtime uses the existing auth DB role; bioskin_app must NOT read/write this ledger.
REVOKE ALL ON skin_visual_ai_usage FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bioskin_app') THEN
    REVOKE ALL ON skin_visual_ai_usage FROM bioskin_app;
  END IF;
END $$;
-- Reuse existing feature tables. Absence denies; no user grants or clinic activation.
INSERT INTO clinic_features (clinic_id, feature, enabled)
  SELECT id, 'skin_visual_ai', false FROM clinics
  ON CONFLICT (clinic_id, feature) DO NOTHING;
COMMIT;
