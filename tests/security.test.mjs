import assert from 'node:assert/strict';
import test from 'node:test';

test('R2 photo keys stay inside the clinic and record prefix', async () => {
  const { isOwnedPhotoKey } = await import('../api/records.js');
  const clinicId = '11111111-1111-4111-8111-111111111111';
  const recordId = '42';

  assert.equal(
    isOwnedPhotoKey(`clinics/${clinicId}/records/${recordId}/photos/22222222-2222-4222-8222-222222222222.jpg`, clinicId, recordId),
    true
  );
  assert.equal(isOwnedPhotoKey('clinics/other/records/42/photos/file.jpg', clinicId, recordId), false);
  assert.equal(isOwnedPhotoKey(`clinics/${clinicId}/records/43/photos/22222222-2222-4222-8222-222222222222.jpg`, clinicId, recordId), false);
  assert.equal(isOwnedPhotoKey(`clinics/${clinicId}/records/${recordId}/photos/../../secret.jpg`, clinicId, recordId), false);
});

test('finance update query only permits approved fields and scopes by clinic', async () => {
  const { buildFinanceUpdateQuery } = await import('../lib/finance-db.js');
  const statement = buildFinanceUpdateQuery({
    total_payment: 100,
    clinic_id: 'attacker-controlled',
    'raw_note = raw_note, clinic_id': 'injected',
  }, 7, '11111111-1111-4111-8111-111111111111');

  assert.match(statement.query, /total_payment = \$1/);
  assert.match(statement.query, /WHERE id = \$2 AND clinic_id = \$3/);
  assert.doesNotMatch(statement.query, /attacker-controlled|raw_note = raw_note/);
  assert.deepEqual(statement.values, [100, 7, '11111111-1111-4111-8111-111111111111']);
});

test('clinical pool fails closed when the RLS app URL is absent', async () => {
  delete process.env.NEON_APP_URL;
  delete process.env.NEON_DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const { getPool, getAppPool } = await import('../lib/neon-clinical-db.js');

  assert.equal(getPool(), null);
  assert.equal(getAppPool(), null);
});

test('R2 refuses to sign URLs without credentials', async () => {
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  const { generateReadUrl } = await import('../lib/r2-service.js');

  await assert.rejects(
    () => generateReadUrl('clinics/test/photo.jpg'),
    /R2_ACCESS_KEY_ID \/ R2_SECRET_ACCESS_KEY no configuradas/
  );
});

test('R2 upload signing rejects sizes above the clinical photo limit', async () => {
  const { generateUploadUrl } = await import('../lib/r2-service.js');
  await assert.rejects(
    () => generateUploadUrl('clinics/test/photo.jpg', 'image/jpeg', 4 * 1024 * 1024 + 1),
    /contentLength debe estar entre 1 y 4 MB/
  );
});

test('temporary passwords are strong and unique', async () => {
  const { generateTemporaryPassword } = await import('../api/admin-auth.js');
  const passwords = Array.from({ length: 100 }, () => generateTemporaryPassword());

  assert.equal(new Set(passwords).size, passwords.length);
  for (const password of passwords) {
    assert.equal(password.length, 14);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[!@#$%]/);
  }
});

test('WhatsApp webhook only accepts the configured verification token', async () => {
  const { verifyWhatsAppWebhook, verifyWhatsAppSignature } = await import('../api/whatsapp-chatbot.js');

  assert.equal(
    verifyWhatsAppWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-token', 'hub.challenge': 'challenge' }, 'test-token'),
    'challenge'
  );
  assert.equal(
    verifyWhatsAppWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'challenge' }, 'test-token'),
    null
  );
  const crypto = await import('node:crypto');
  const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update('{"object":"whatsapp_business_account"}').digest('hex')}`;
  assert.equal(verifyWhatsAppSignature(signature, '{"object":"whatsapp_business_account"}', 'app-secret'), true);
  assert.equal(verifyWhatsAppSignature(signature, '{"object":"tampered"}', 'app-secret'), false);
});

test('WhatsApp message sending fails closed without credentials', async () => {
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  const { sendWhatsAppText } = await import('../lib/whatsapp-service.js');

  await assert.rejects(
    () => sendWhatsAppText('593987654321', 'hola'),
    /WHATSAPP_TOKEN \/ WHATSAPP_PHONE_NUMBER_ID no configuradas/
  );
});

test('appointment system note prefers clinic contact and falls back to professional', async () => {
  const { buildAppointmentSystemNote } = await import('../lib/whatsapp-service.js');

  assert.match(
    buildAppointmentSystemNote({
      clinicName: 'Clínica BIOSKIN',
      clinicPhone: '099 123 4567',
      professionalName: 'Dra. Ana',
      professionalPhone: '098 765 4321',
    }),
    /Clínica BIOSKIN: https:\/\/wa\.me\/593991234567/
  );
  assert.match(
    buildAppointmentSystemNote({ clinicName: 'Clínica BIOSKIN', professionalName: 'Dra. Ana', professionalPhone: '098 765 4321' }),
    /Dra\. Ana: https:\/\/wa\.me\/593987654321/
  );
});

test('WhatsApp bot normalizes Ecuadorian phone numbers consistently', async () => {
  const { config, normalizeEcuadorPhone } = await import('../api/whatsapp-chatbot.js');

  assert.equal(config.api.bodyParser, false);
  assert.equal(normalizeEcuadorPhone('0987654321'), '593987654321');
  assert.equal(normalizeEcuadorPhone('593987654321'), '593987654321');
  assert.equal(normalizeEcuadorPhone('987654321'), '593987654321');
  assert.equal(normalizeEcuadorPhone(''), '');
});

test('user WhatsApp numbers are stored in one canonical format', async () => {
  const { normalizeUserPhone } = await import('../api/admin-auth.js');

  assert.equal(normalizeUserPhone('098 765 4321'), '593987654321');
  assert.equal(normalizeUserPhone('+593 098 765 4321'), '593987654321');
  assert.equal(normalizeUserPhone('987654321'), '593987654321');
  assert.equal(normalizeUserPhone(''), null);
});

test('WhatsApp bot extracts auditable messages only when a sender exists', async () => {
  const { extractIncomingMessages, extractMessageStatuses } = await import('../api/whatsapp-chatbot.js');

  const messages = extractIncomingMessages({
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '0987654321', profile: { name: 'Ana' } }],
      messages: [
      { id: 'wamid.incoming', from: '0987654321', timestamp: '1700000000', type: 'text', text: { body: '1' } },
      { from: '0987654321', text: { body: 'sin id de Meta' } },
      { text: { body: 'sin remitente' } },
    ] } }] }],
  });

  assert.deepEqual(messages, [{
    from: '593987654321',
    text: '1',
    mediaType: 'texto',
    providerMessageId: 'wamid.incoming',
    timestamp: new Date(1700000000000),
    name: 'Ana',
  }]);

  assert.deepEqual(extractMessageStatuses({
    entry: [{ changes: [{ value: { statuses: [
      { id: 'wamid.outgoing', status: 'read' },
      { id: 'wamid.failed', status: 'failed', errors: [{ title: 'No entregado' }] },
    ] } }] }],
  }), [
    { providerMessageId: 'wamid.outgoing', status: 'leido', errorDetail: null },
    { providerMessageId: 'wamid.failed', status: 'fallido', errorDetail: 'No entregado' },
  ]);
});

test('WhatsApp finance report selection maps menu choices to report periods', async () => {
  const { resolveFinancePeriodChoice } = await import('../api/whatsapp-chatbot.js');

  assert.equal(resolveFinancePeriodChoice('1'), 'daily');
  assert.equal(resolveFinancePeriodChoice('2'), 'weekly');
  assert.equal(resolveFinancePeriodChoice('3'), 'monthly');
  assert.equal(resolveFinancePeriodChoice('diario'), 'daily');
  assert.equal(resolveFinancePeriodChoice('semanal'), 'weekly');
  assert.equal(resolveFinancePeriodChoice('mensual'), 'monthly');
  assert.equal(resolveFinancePeriodChoice('otro'), null);
});

test('appointment reminders are sent only one day before the event and never duplicated', async () => {
  const { shouldSendAppointmentReminder } = await import('../api/whatsapp-chatbot.js');

  const event = {
    summary: 'Cita: Ana García',
    start: { dateTime: '2026-09-25T10:30:00-05:00' },
    end: { dateTime: '2026-09-25T11:00:00-05:00' },
    description: 'Teléfono: 0987654321\nProfesional: Dra. María\n[AGENDADO POR WEB]',
    extendedProperties: { private: {} },
  };

  assert.equal(shouldSendAppointmentReminder(event, new Date('2026-09-24T18:00:00-05:00')), true);
  assert.equal(shouldSendAppointmentReminder({ ...event, extendedProperties: { private: { bioskinReminderSent: '2026-09-25' } } }, new Date('2026-09-24T18:00:00-05:00')), false);
  assert.equal(shouldSendAppointmentReminder({ ...event, start: { dateTime: '2026-09-26T10:30:00-05:00' } }, new Date('2026-09-24T18:00:00-05:00')), false);
});

test('appointment notifications target only the normalized patient number', async () => {
  const { normalizeWhatsAppNumber, buildAppointmentWhatsAppRecipients } = await import('../api/sendEmail.js');

  assert.equal(normalizeWhatsAppNumber('0987654321'), '593987654321');
  assert.deepEqual(
    buildAppointmentWhatsAppRecipients({ patientPhone: '0987654321', bookingUserPhone: '0991234567' }),
    ['593987654321']
  );
  assert.deepEqual(
    buildAppointmentWhatsAppRecipients({ patientPhone: '', bookingUserPhone: '5930991234567' }),
    []
  );

  const previousStaffPhones = process.env.WHATSAPP_SYSTEM_STAFF_PHONES;
  process.env.WHATSAPP_SYSTEM_STAFF_PHONES = '0997061321';
  try {
    assert.deepEqual(
      buildAppointmentWhatsAppRecipients({ patientPhone: '0997061321', bookingUserPhone: '0991234567' }),
      []
    );
    assert.deepEqual(
      buildAppointmentWhatsAppRecipients({ patientPhone: '0987654321', bookingUserPhone: '0997061321' }),
      ['593987654321']
    );
  } finally {
    if (previousStaffPhones === undefined) delete process.env.WHATSAPP_SYSTEM_STAFF_PHONES;
    else process.env.WHATSAPP_SYSTEM_STAFF_PHONES = previousStaffPhones;
  }
});

test('public bookings must fit completely inside resource work hours', async () => {
  const { isWithinWorkHours, isValidFutureLocalDateTime } = await import('../lib/agenda-resources.js');

  assert.equal(isWithinWorkHours('09:00', 60, '08:00', '17:00'), true);
  assert.equal(isWithinWorkHours('16:00', 60, '08:00', '17:00'), true);
  assert.equal(isWithinWorkHours('16:15', 60, '08:00', '17:00'), false);
  assert.equal(isWithinWorkHours('07:45', 30, '08:00', '17:00'), false);
  assert.equal(isWithinWorkHours('invalid', 60, '08:00', '17:00'), false);
  assert.equal(isValidFutureLocalDateTime('2030-02-28', '09:00', Date.parse('2030-02-27T09:00:00-05:00')), true);
  assert.equal(isValidFutureLocalDateTime('2030-02-30', '09:00', 0), false);
  assert.equal(isValidFutureLocalDateTime('2020-02-20', '09:00', Date.parse('2030-02-20T09:00:00-05:00')), false);
});