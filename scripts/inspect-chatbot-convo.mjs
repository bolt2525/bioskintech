// Inspección de solo lectura del CRM de WhatsApp — diagnóstico de flujos del chatbot.
import 'dotenv/config';
import pg from 'pg';

const conn = process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL;
const pool = new pg.Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });

const phoneArg = process.argv[2];
const norm = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.startsWith('0') ? `593${d.slice(1)}` : d.startsWith('593') ? d : `593${d}`; };

const contacts = await pool.query(
  `SELECT c.id, c.phone, c.name, c.clinic_id, c.last_message_at,
          (SELECT count(*) FROM whatsapp_messages m WHERE m.contact_id = c.id) AS msgs
   FROM whatsapp_contacts c ORDER BY c.last_message_at DESC NULLS LAST`
);
console.log('=== CONTACTOS ===');
for (const c of contacts.rows) console.log(`#${c.id} ${c.phone} | ${c.name || '(sin nombre)'} | clinic=${c.clinic_id || '-'} | msgs=${c.msgs} | last=${c.last_message_at?.toISOString?.() || '-'}`);

const targets = phoneArg ? [norm(phoneArg)] : contacts.rows.map(c => c.phone);
for (const phone of targets) {
  const msgs = await pool.query(
    `SELECT m.id, m.direction, m.content, m.status, m.occurred_at, m.error_detail,
            m.appointment_event_id, m.appointment_reply_status, m.booked_by_user_id
     FROM whatsapp_messages m JOIN whatsapp_contacts c ON c.id = m.contact_id
     WHERE c.phone = $1 ORDER BY m.occurred_at ASC`, [phone]
  );
  if (!msgs.rows.length) continue;
  console.log(`\n\n===== CONVERSACIÓN ${phone} (${msgs.rows.length} mensajes) =====`);
  for (const m of msgs.rows) {
    const ts = new Date(m.occurred_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });
    console.log(`\n[${ts}] ${m.direction === 'entrante' ? '<<< PACIENTE/STAFF' : '>>> BOT'} (${m.status})${m.error_detail ? ` ERR:${m.error_detail.slice(0, 200)}` : ''}${m.appointment_event_id ? ` evt=${m.appointment_event_id.slice(0, 12)} reply=${m.appointment_reply_status || '-'}` : ''}`);
    console.log(m.content);
  }
}
await pool.end();
