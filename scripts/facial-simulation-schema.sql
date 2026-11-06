-- Prepared only. NEVER called by API initialization. Operator approval required.
-- Neon clinical metadata + small idempotency receipts; editable JSON lives in private R2.
BEGIN;
CREATE TABLE IF NOT EXISTS public.facial_simulations (
  id SERIAL PRIMARY KEY,
  request_id UUID NOT NULL,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  record_id INTEGER NOT NULL REFERENCES clinical_records(id) ON DELETE CASCADE,
  state_version INTEGER NOT NULL CHECK (state_version = 1),
  scope TEXT NOT NULL CHECK (scope IN ('physical-exam', 'facial-simulation')),
  r2_key VARCHAR(500) NOT NULL UNIQUE,
  state_sha256 TEXT NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  state_bytes INTEGER NOT NULL CHECK (state_bytes BETWEEN 1 AND 3900000),
  photo_refs JSONB NOT NULL CHECK (jsonb_typeof(photo_refs) = 'array' AND jsonb_array_length(photo_refs) BETWEEN 1 AND 12),
  created_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS facial_simulations_request ON public.facial_simulations(clinic_id, request_id);
CREATE INDEX IF NOT EXISTS facial_simulations_record_versions
  ON public.facial_simulations(clinic_id, record_id, scope, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS public.clinical_simulation_requests (
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  record_id INTEGER NOT NULL REFERENCES clinical_records(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('session', 'exam')),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (octet_length(result::text) <= 2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clinic_id, request_id)
);
ALTER TABLE public.facial_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facial_simulations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_simulation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_simulation_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.facial_simulations;
CREATE POLICY tenant_isolation ON public.facial_simulations
  USING (clinic_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON public.clinical_simulation_requests;
CREATE POLICY tenant_isolation ON public.clinical_simulation_requests
  USING (clinic_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (clinic_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
REVOKE ALL ON public.facial_simulations, public.clinical_simulation_requests FROM PUBLIC;
GRANT SELECT, INSERT ON public.facial_simulations, public.clinical_simulation_requests TO bioskin_app;
GRANT USAGE, SELECT ON SEQUENCE public.facial_simulations_id_seq TO bioskin_app;
-- Existing ledger intentionally contains NO record/photo IDs: no nullable-record DDL needed.
COMMIT;
