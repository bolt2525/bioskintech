// Shared by the existing administrative Neon migration and privileged bootstrap.
// This transaction must succeed in full before the new release path can run.
export const clinicIdentityMigrations = [
  `CREATE TABLE IF NOT EXISTS clinic_identity_history (
    clinic_id UUID PRIMARY KEY REFERENCES clinics(id),
    released_at TIMESTAMPTZ NOT NULL,
    clinic_aliases JSONB NOT NULL,
    user_aliases JSONB NOT NULL CHECK (jsonb_typeof(user_aliases)='array')
  )`,
  'REVOKE ALL ON clinic_identity_history FROM PUBLIC',
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bioskin_app') THEN
      REVOKE ALL ON clinic_identity_history FROM bioskin_app;
    END IF;
  END $$`,
  'ALTER TABLE whatsapp_contacts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ',
  'ALTER TABLE whatsapp_contacts DROP CONSTRAINT IF EXISTS whatsapp_contacts_phone_key',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_contacts_active_phone ON whatsapp_contacts(phone) WHERE retired_at IS NULL',
  'ALTER TABLE whatsapp_bot_state ADD COLUMN IF NOT EXISTS id BIGSERIAL',
  'ALTER TABLE whatsapp_bot_state ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ',
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='whatsapp_bot_state'::regclass
      AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (phone)') THEN
      ALTER TABLE whatsapp_bot_state DROP CONSTRAINT whatsapp_bot_state_pkey;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='whatsapp_bot_state'::regclass AND contype='p') THEN
      ALTER TABLE whatsapp_bot_state ADD PRIMARY KEY(id);
    END IF;
  END $$`,
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_bot_state_active_phone ON whatsapp_bot_state(phone) WHERE retired_at IS NULL',
  'ALTER TABLE wa_short_links ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ',
  `DO $$ BEGIN
    IF to_regclass('public.user_whatsapp_channels') IS NOT NULL THEN
      ALTER TABLE user_whatsapp_channels DROP CONSTRAINT IF EXISTS user_whatsapp_channels_phone_number_id_key;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_whatsapp_channels_active_number
        ON user_whatsapp_channels(phone_number_id) WHERE status <> 'disconnected';
    END IF;
  END $$`,
];
