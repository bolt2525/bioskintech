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
    buttonPayload: '',
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

test('appointment replies classify only explicit confirmations as confirmed', async () => {
  const { classifyAppointmentReply, formatAppointmentReplyStatus } = await import('../api/whatsapp-chatbot.js');

  assert.equal(classifyAppointmentReply('Confirmar', 'appointment_confirm:event-1'), 'confirmed');
  assert.equal(classifyAppointmentReply('Sí, asistiré'), 'confirmed');
  assert.equal(classifyAppointmentReply('No podré ir'), 'needs_contact');
  assert.equal(classifyAppointmentReply('Llegaré tarde'), 'needs_contact');
  assert.equal(classifyAppointmentReply('Deseo cambiar la cita'), 'needs_contact');
  assert.equal(formatAppointmentReplyStatus('confirmed'), '✅ Confirmado');
  assert.equal(formatAppointmentReplyStatus('needs_contact'), '⚠️ Requiere atención');
  assert.equal(formatAppointmentReplyStatus(null), '⚠️ Sin confirmar · escribir');
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
    description: 'Teléfono: 0987654321\nServicio: Limpieza facial\nProfesional: Dra. María\nEnlace público: clinica/dra-maria',
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

test('own-scope record access honors patient assignments', async () => {
  const { canAccessRecord } = await import('../api/records.js');
  let query = '';
  let values = [];
  const sessionUser = {
    effective_clinic_id: '11111111-1111-4111-8111-111111111111',
    role: 'clinic_user',
    access_scope: 'own',
    user_id: 7,
  };
  const pool = {
    query: async (statement, params) => {
      query = statement;
      values = params;
      return { rows: [{}] };
    },
  };

  assert.equal(await canAccessRecord(pool, sessionUser, 42), true);
  assert.match(query, /patient_assignments/);
  assert.deepEqual(values, [42, sessionUser.effective_clinic_id, true, 7]);
  assert.equal(await canAccessRecord({ query: async () => ({ rows: [] }) }, sessionUser, 42), false);
});

test('backup imports whitelist tables and schema-backed columns', async () => {
  const { buildBackupInsertStatement, buildClinicFilter, resolveFinanceSourceTable } = await import('../api/backup.js');
  const statement = buildBackupInsertStatement('patients', {
    id: 9,
    first_name: 'Ana',
    'id) VALUES (NULL); DROP TABLE patients; --': 'injected',
    unrecognized: 'ignored',
  }, new Set(['id', 'first_name']));

  assert.match(statement.query, /^INSERT INTO patients \("id","first_name"\)/);
  assert.doesNotMatch(statement.query, /DROP TABLE|unrecognized/);
  assert.deepEqual(statement.values, [9, 'Ana']);
  assert.throws(() => buildBackupInsertStatement('clinics', { id: 1 }, new Set(['id'])), /Tabla o fila/);
  const consent = buildBackupInsertStatement('consent_forms', {
    id: 12,
    signing_token: 'secret-link-token',
    signing_otp_hash: 'secret-otp-hash',
    signing_session_hash: 'secret-session-hash',
    signing_sender_user_id: 42,
    signing_hash: 'signed-evidence-hash',
  }, new Set(['id', 'signing_token', 'signing_otp_hash', 'signing_session_hash', 'signing_sender_user_id', 'signing_hash']));
  assert.doesNotMatch(consent.query, /signing_token|signing_otp_hash|signing_session_hash|signing_sender_user_id/);
  assert.match(consent.query, /signing_hash/);

  const clinicId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(
    buildClinicFilter('patients', 'SELECT * FROM patients', [], true, clinicId),
    { query: 'SELECT * FROM patients WHERE clinic_id = $1', params: [clinicId] }
  );
  assert.deepEqual(
    buildClinicFilter('patients', 'SELECT * FROM patients', [], true, null),
    { query: 'SELECT * FROM patients', params: [] }
  );
  assert.deepEqual(
    buildClinicFilter('financial_items', 'SELECT * FROM financial_items WHERE record_id = ANY($1::int[]) ORDER BY id LIMIT 50000', [[4, 5]], true, clinicId),
    { query: 'SELECT * FROM financial_items WHERE record_id = ANY($1::int[]) AND clinic_id = $2 ORDER BY id LIMIT 50000', params: [[4, 5], clinicId] }
  );
  assert.equal(resolveFinanceSourceTable({ source_table: 'external_finance_records', records: [] }), 'external_finance_records');
  assert.equal(resolveFinanceSourceTable({ records: [{ patient_name: 'Ana', raw_note: 'legacy' }] }), 'external_finance_records');
  assert.equal(resolveFinanceSourceTable({ records: [{ entity: 'Farmacia', date: '2026-01-01', type: 'expense' }] }), 'financial_records');
  assert.throws(() => resolveFinanceSourceTable({ records: [{ id: 1, clinic_id: clinicId }] }), /ambiguo/);
});

test('backup restore forces clinic_id and rejects foreign patient references', async () => {
  const { insertBackupRow } = await import('../api/backup.js');
  const clinicId = '11111111-1111-4111-8111-111111111111';
  let insertedValues = [];
  const patientPool = {
    query: async (statement, params) => {
      if (statement.includes('information_schema.columns'))
        return { rows: ['id', 'first_name', 'clinic_id'].map(column_name => ({ column_name })) };
      if (statement.startsWith('SELECT clinic_id FROM patients')) return { rows: [] };
      if (statement.startsWith('INSERT INTO patients')) {
        insertedValues = params;
        return { rowCount: 1 };
      }
      throw new Error('Unexpected query');
    },
  };

  assert.equal(await insertBackupRow(patientPool, 'patients', { id: 42, first_name: 'Ana', clinic_id: 'foreign' }, clinicId, true), 1);
  assert.equal(insertedValues[2], clinicId);

  const recordPool = {
    query: async statement => {
      if (statement.includes('information_schema.columns'))
        return { rows: ['id', 'patient_id', 'clinic_id'].map(column_name => ({ column_name })) };
      if (statement.startsWith('SELECT 1 FROM patients')) return { rows: [] };
      throw new Error('Unexpected query');
    },
  };
  await assert.rejects(
    () => insertBackupRow(recordPool, 'clinical_records', { id: 7, patient_id: 999, clinic_id: 'foreign' }, clinicId, true),
    /fuera de la clínica destino/
  );
});

test('backup finance items validate against the selected legacy table', async () => {
  const { insertBackupRow } = await import('../api/backup.js');
  const clinicId = '11111111-1111-4111-8111-111111111111';
  let parentQuery = '';
  const pool = {
    query: async (statement) => {
      if (statement.includes('information_schema.columns'))
        return { rows: ['id', 'record_id', 'clinic_id', 'description'].map(column_name => ({ column_name })) };
      if (statement.startsWith('SELECT 1 FROM external_finance_records')) {
        parentQuery = statement;
        return { rows: [{}] };
      }
      if (statement.startsWith('INSERT INTO financial_items')) return { rowCount: 1 };
      throw new Error('Unexpected query');
    },
  };
  assert.equal(await insertBackupRow(pool, 'financial_items', { id: 8, record_id: 4 }, clinicId, false, { financialRecordTable: 'external_finance_records' }), 1);
  assert.match(parentQuery, /external_finance_records/);
});

test('backup restore rejects foreign consultations and clears foreign movement users', async () => {
  const { insertBackupRow } = await import('../api/backup.js');
  const clinicId = '11111111-1111-4111-8111-111111111111';
  const foreignConsultationPool = {
    query: async statement => {
      if (statement.includes('information_schema.columns'))
        return { rows: ['id', 'record_id', 'clinic_id'].map(column_name => ({ column_name })) };
      if (statement.startsWith('SELECT 1 FROM clinical_records')) return { rows: [] };
      throw new Error('Unexpected query');
    },
  };
  await assert.rejects(
    () => insertBackupRow(foreignConsultationPool, 'consultations', { id: 3, record_id: 44 }, clinicId, true),
    /fuera de la clínica destino/
  );

  let insertedValues = [];
  const movementPool = {
    query: async (statement, params) => {
      if (statement.includes('information_schema.columns'))
        return { rows: ['id', 'batch_id', 'clinic_id', 'user_id'].map(column_name => ({ column_name })) };
      if (statement.startsWith('SELECT 1 FROM inventory_batches')) return { rows: [{}] };
      if (statement.startsWith('SELECT 1 FROM clinic_users')) return { rows: [] };
      if (statement.startsWith('INSERT INTO inventory_movements')) {
        insertedValues = params;
        return { rowCount: 1 };
      }
      throw new Error('Unexpected query');
    },
  };
  assert.equal(await insertBackupRow(movementPool, 'inventory_movements', { id: 8, batch_id: 2, user_id: 999 }, clinicId, false), 1);
  assert.equal(insertedValues[2], null);
});

test('patient signing requires a professional name and valid saved PNG signature', async () => {
  const { hasProfessionalSignature } = await import('../api/records.js');
  const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

  assert.equal(hasProfessionalSignature({ professional_name: 'Dra. Ana', professional_sig_data: validPng }), true);
  assert.equal(hasProfessionalSignature({ professional_name: '', professional_sig_data: validPng }), false);
  assert.equal(hasProfessionalSignature({ professional_name: 'Dra. Ana', professional_sig_data: '' }), false);
});