import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHmac } from 'node:crypto';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const STAFF = '593999000111';
const PATIENT = '593999000222';
const sent = [];
const audits = [];
const replyUpdates = [];
let withinWindow = true;
let events = [];
let context = null;
const sql = async parts => parts.join('').includes('FROM clinic_oauth_tokens t')
  ? { rows: [{ clinic_id: CLINIC, user_id: 7, staff_phone: STAFF, staff_name: 'Profesional Prueba', general: { name: 'Clínica Prueba' } }] }
  : { rows: [{ access_token: 'test', refresh_token: 'test' }] };
sql.query = async () => ({ rows: [] });
mock.module('@vercel/postgres', { namedExports: { sql } });
mock.module('googleapis', { namedExports: { google: {
  auth: { OAuth2: class { setCredentials() {} } },
  calendar: () => ({ events: { list: async () => ({ data: { items: events } }) } }),
} } });
mock.module(new URL('../lib/neon-clinical-db.js', import.meta.url).href, {
  namedExports: { getPool: () => ({ query: async () => ({ rows: [{ is_active: true, general: {} }] }) }) },
});
const crm = await import('../lib/whatsapp-crm.js');
mock.module(new URL('../lib/whatsapp-crm.js', import.meta.url).href, { namedExports: {
  ...crm,
  recordWhatsAppMessage: async message => { audits.push(message); return { rows: [{ id: audits.length }] }; },
  updateOutgoingWhatsAppMessage: async () => true,
  isWithinCustomerServiceWindow: async () => withinWindow,
  getAppointmentReplyStatuses: async () => ({}),
  getAppointmentDeliveryStatuses: async () => ({ 'test-event': 'leido' }),
  getPendingAppointmentReplyContext: async () => context,
  setAppointmentReplyStatus: async (...args) => { replyUpdates.push(args); return true; },
} });
mock.module(new URL('../lib/wa-short-link.js', import.meta.url).href, { namedExports: {
  createShortWaLink: async () => `https://example.test/r/${CLINIC}.aaaaaaaaa_bbbbbbbbbbbb`,
  resolveShortWaLink: async () => null,
} });
const bot = await import('../api/whatsapp-chatbot.js');
const { sendWhatsAppTemplate } = await import('../lib/whatsapp-service.js');

test.beforeEach(t => {
  sent.length = 0;
  audits.length = 0;
  replyUpdates.length = 0;
  withinWindow = true;
  events = [];
  context = null;
  Object.assign(process.env, {
    WHATSAPP_TOKEN: 'test', WHATSAPP_PHONE_NUMBER_ID: 'test',
    WHATSAPP_TEMPLATE_DAILY_SUMMARY: 'agenda_diaria_staff', WHATSAPP_TEMPLATE_DAILY_SUMMARY_LANG: 'es_MX',
    GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test',
    WHATSAPP_SYSTEM_STAFF_PHONES: '',
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ messages: [{ id: `wamid.test.${sent.length}` }] }) };
  });
});

test('patient Meta template preserves name, language, six named parameters and confirmation button payload', async () => {
  const params = {
    nombre_paciente: 'Paciente Prueba', nombre_clinica: 'Clínica Prueba', nombre_usuario: 'Profesional Prueba',
    servicio: 'Consulta', fecha_hora: '21/10/2026, 17:00', enlace_contacto: 'https://example.test/r/a_b',
  };
  await sendWhatsAppTemplate(PATIENT, 'confirmacion_cita', 'es_MX', params, {
    clinicId: CLINIC, buttonPayloads: ['appointment_confirm:test-event'],
  });
  assert.deepEqual(sent, [{
    messaging_product: 'whatsapp', to: PATIENT, type: 'template',
    template: { name: 'confirmacion_cita', language: { code: 'es_MX' }, components: [
      { type: 'body', parameters: Object.entries(params).map(([parameter_name, text]) => ({ type: 'text', parameter_name, text })) },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'appointment_confirm:test-event' }] },
    ] },
  }]);
});

test('empty agenda sends one short staff message in the existing opted-in slot', async () => {
  const result = await bot.sendAppointmentSummaries();
  assert.equal(result.remindersSent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, STAFF);
  assert.equal(sent[0].type, 'text');
  assert.match(sent[0].text.body, /Sin citas hoy\./);
  assert.ok(sent[0].text.body.length < 180);
});

test('empty evening agenda uses the approved staff template and exactly its existing four parameters', async () => {
  withinWindow = false;
  await bot.sendAppointmentSummaries(1, 'evening');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, STAFF);
  assert.equal(sent[0].template.name, 'agenda_diaria_staff');
  assert.equal(sent[0].template.language.code, 'es_MX');
  assert.deepEqual(sent[0].template.components[0].parameters.map(p => p.parameter_name), [
    'nombre_usuario', 'nombre_clinica', 'fecha', 'resumen',
  ]);
  assert.equal(sent[0].template.components[0].parameters[3].text, 'Sin citas mañana.');
});

test('existing staff summary highlights read-but-unconfirmed without sending another patient notification', async () => {
  events = [{
    id: 'test-event', summary: 'Cita: Paciente Prueba', description: 'Teléfono: 0999000222',
    start: { dateTime: '2026-10-21T17:00:00-05:00' },
  }];
  await bot.sendAppointmentSummaries();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, STAFF);
  assert.match(sent[0].text.body, /Leída · sin confirmar/);
});

test('confirmation button still updates the appointment and sends only the existing patient acknowledgment', async () => {
  context = {
    clinic_id: CLINIC, appointment_event_id: 'test-event', booked_by_user_id: 7,
    appointment_start: '2026-10-21T17:00:00-05:00', appointment_reply_status: null,
  };
  await bot.handlePatientAppointmentReply({ from: PATIENT, text: 'Confirmar asistencia', buttonPayload: 'appointment_confirm:test-event' });
  assert.equal(replyUpdates[0][2], 'confirmed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PATIENT);
  assert.match(sent[0].text.body, /^✅ Gracias\. Hemos registrado tu confirmación/);
});

test('confirmed patient reporting delay alerts staff without treating it as cancellation', async () => {
  context = {
    clinic_id: CLINIC, appointment_event_id: 'test-event', booked_by_user_id: 7,
    appointment_start: '2026-10-21T17:00:00-05:00', appointment_reply_status: 'confirmed',
    patient_name: 'Paciente Prueba', professional_phone: STAFF, clinic_phone: STAFF,
  };
  await bot.handlePatientAppointmentReply({ from: PATIENT, text: 'Voy con retraso', buttonPayload: '' });
  assert.equal(replyUpdates[0][2], 'needs_contact');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, STAFF);
  assert.match(sent[0].text.body, /avisa un retraso/);
  assert.doesNotMatch(sent[0].text.body, /NO confirmó|cancel/);
  assert.equal(sent[1].to, PATIENT);
});

test('thanks after confirmation do not generate more messages or overwrite attendance', async () => {
  context = { clinic_id: CLINIC, appointment_reply_status: 'confirmed' };
  await bot.handlePatientAppointmentReply({ from: PATIENT, text: 'Gracias', buttonPayload: '' });
  assert.equal(sent.length, 0);
  assert.equal(replyUpdates.length, 0);
});

test('signed reactions and stickers are recorded but never invoke a conversational flow', async () => {
  process.env.WHATSAPP_APP_SECRET = 'fictional-signing-secret';
  for (const type of ['reaction', 'sticker']) {
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'test' },
      messages: [{ id: `wamid.${type}`, from: PATIENT, type, reaction: { emoji: '👍' } }],
    } }] }] }));
    const req = {
      method: 'POST', query: {},
      headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(body).digest('hex')}` },
      async *[Symbol.asyncIterator]() { yield body; },
    };
    const res = { code: 0, status(code) { this.code = code; return this; }, json() { return this; }, send() { return this; } };
    await bot.default(req, res);
    assert.equal(res.code, 200);
  }
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(message => message.content), ['[Reacción 👍]', '[Sticker]']);
  assert.equal(sent.length, 0);
  assert.equal(replyUpdates.length, 0);
});
