BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id              BIGSERIAL PRIMARY KEY,
  phone           VARCHAR(20) NOT NULL UNIQUE CHECK (phone ~ '^[0-9]{7,20}$'),
  name            VARCHAR(150),
  clinic_id       UUID REFERENCES clinics(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  BIGSERIAL PRIMARY KEY,
  contact_id          BIGINT NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  direction           VARCHAR(10) NOT NULL CHECK (direction IN ('entrante', 'saliente')),
  content             TEXT NOT NULL DEFAULT '',
  media_type          VARCHAR(10) NOT NULL DEFAULT 'texto' CHECK (media_type IN ('texto', 'imagen', 'audio')),
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              VARCHAR(10) NOT NULL CHECK (status IN ('leido', 'enviado', 'fallido')),
  provider_message_id VARCHAR(255),
  error_detail        VARCHAR(500),
  booked_by_user_id   INTEGER,
  read_notified       BOOLEAN NOT NULL DEFAULT false,
  appointment_event_id VARCHAR(255),
  appointment_start   TIMESTAMPTZ,
  appointment_reply_status VARCHAR(30),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_provider_id
  ON whatsapp_messages(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_last_message
  ON whatsapp_contacts(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_contact_time
  ON whatsapp_messages(contact_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_appointment
  ON whatsapp_messages(appointment_event_id, appointment_start)
  WHERE appointment_event_id IS NOT NULL;

COMMIT;