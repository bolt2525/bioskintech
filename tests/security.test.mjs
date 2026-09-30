import assert from 'node:assert/strict';
import test from 'node:test';

test('inventory groups persist per clinic/category without products or accent/case duplicates', async () => {
  const { resolveInventoryGroup } = await import('../api/records.js');
  const queries = [];
  const groups = new Map();
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      const [clinicId, category, name, nameKey] = params;
      const key = `${clinicId}:${category}:${nameKey}`;
      if (!groups.has(key)) groups.set(key, name);
      return { rows: [{ name: groups.get(key) }] };
    },
  };
  const sessionUser = { inventory_scope: 'own', user_id: 42 };

  assert.equal(await resolveInventoryGroup('Rellenos', 'Inyectable', 'clinic-a', sessionUser, pool), 'Rellenos');
  assert.equal(await resolveInventoryGroup('  rellénos  ', 'Inyectable', 'clinic-a', sessionUser, pool), 'Rellenos');
  assert.equal(await resolveInventoryGroup('Rellenos', 'Venta', 'clinic-a', sessionUser, pool), 'Rellenos');
  assert.equal(await resolveInventoryGroup('rellenos', 'Inyectable', 'clinic-b', sessionUser, pool), 'rellenos');
  assert.equal(await resolveInventoryGroup('  Ácido  Hialurónico  ', 'Inyectable', 'clinic-a', sessionUser, pool), 'Ácido Hialurónico');
  assert.deepEqual(queries[1].params, ['clinic-a', 'Inyectable', 'rellénos', 'rellenos']);
  assert.match(queries[0].sql, /ON CONFLICT \(clinic_id, category, name_key\)/);
  assert.equal(groups.size, 4);
  assert.equal(await resolveInventoryGroup('  ', 'Inyectable', 'clinic-a', sessionUser, pool), null);
  await assert.rejects(() => resolveInventoryGroup(12, 'Inyectable', 'clinic-a', sessionUser, pool), TypeError);
  await assert.rejects(() => resolveInventoryGroup('x'.repeat(101), 'Inyectable', 'clinic-a', sessionUser, pool), RangeError);
  await assert.rejects(() => resolveInventoryGroup('Rellenos', 'Inyectable', null, sessionUser, pool), TypeError);
  assert.equal(queries.length, 5);
});

test('inventory group backup restores without products and forces the target clinic', async () => {
  const { restoreInventoryGroups } = await import('../api/backup.js');
  const saved = new Set();
  const pool = { query: async (_sql, params) => {
    const key = `${params[0]}:${params[1]}:${params[3]}`;
    const rowCount = saved.has(key) ? 0 : 1;
    saved.add(key);
    assert.equal(params[0], 'target-clinic');
    return { rowCount };
  } };
  const rows = [
    { clinic_id: 'foreign-clinic', category: 'Inyectable', name: 'Rellenos' },
    { clinic_id: 'foreign-clinic', category: 'Inyectable', name: '  rellénos ' },
  ];
  assert.equal(await restoreInventoryGroups(pool, rows, 'target-clinic', false), 1);
  assert.equal(await restoreInventoryGroups(pool, rows, 'target-clinic', false), 0);
  assert.equal(saved.size, 1);
  await assert.rejects(() => restoreInventoryGroups(pool, [{ category: 'Venta', name: 'Grupo' }], null, false), /inválida/);
  await assert.rejects(() => restoreInventoryGroups(pool, [{ category: 'Venta', name: ' ' }], 'target-clinic', false), /inválida/);
  await assert.rejects(() => restoreInventoryGroups(pool, 'no es un arreglo', 'target-clinic', false), /inválido/);
});

test('inventory receipts reject invalid quantities and preserve unknown cost', async () => {
  const { validateInventoryBatchInput } = await import('../api/records.js');
  assert.deepEqual(validateInventoryBatchInput('2.5', ''), { units: 2.5, cost: null });
  assert.deepEqual(validateInventoryBatchInput(1, '  '), { units: 1, cost: null });
  assert.deepEqual(validateInventoryBatchInput(2, '0'), { units: 2, cost: 0 });
  assert.deepEqual(validateInventoryBatchInput(1, '12.3456'), { units: 1, cost: 12.3456 });
  for (const quantity of [0, -1, 1.234, 'no-numérico', Infinity]) {
    assert.throws(() => validateInventoryBatchInput(quantity, null), RangeError);
  }
  for (const cost of [-1, 'abc', Infinity, 1.12345]) {
    assert.throws(() => validateInventoryBatchInput(1, cost), RangeError);
  }
});

test('inventory purchase cost updates product reference only by explicit, current choice', async () => {
  const { validateReferenceCostChange, updateInventoryReferenceCost } = await import('../api/records.js');
  assert.equal(validateReferenceCostChange(false, 33, 30.01), null);
  assert.equal(validateReferenceCostChange(true, 33, '30.01'), 30.01);
  assert.throws(() => validateReferenceCostChange(true, null, 30.01), RangeError);
  assert.throws(() => validateReferenceCostChange(true, 33.1234, 30.01), RangeError);
  assert.equal(validateReferenceCostChange(false, 33.1234, 30.01), null);
  assert.throws(() => validateReferenceCostChange('true', 33, 30.01), RangeError);
  let referenceCost = 30.01;
  const pool = { query: async (sql, params) => {
    assert.match(sql, /clinic_id = \$3 AND cost_price IS NOT DISTINCT FROM \$4/);
    assert.deepEqual(params.slice(0, 3), [33, 7, 'clinic-a']);
    if (referenceCost !== params[3]) return { rows: [] };
    referenceCost = params[0];
    return { rows: [{ id: params[1] }] };
  } };
  assert.deepEqual((await updateInventoryReferenceCost(pool, { cost: 33, itemId: 7, clinicId: 'clinic-a', expectedCost: 30.01 })).rows, [{ id: 7 }]);
  assert.deepEqual((await updateInventoryReferenceCost(pool, { cost: 33, itemId: 7, clinicId: 'clinic-a', expectedCost: 30.01 })).rows, []);
});

test('inventory archive transitions require clinic, reason and expected state', async () => {
  const { buildInventoryArchiveUpdate, validateInventoryListStatus, getInventoryPermanentDeleteConflict } = await import('../api/records.js');
  const archive = buildInventoryArchiveUpdate({
    itemId: 12, clinicId: 'clinic-a', userId: 8, inventoryScope: 'own', archive: true,
    reason: 'Producto discontinuado por el proveedor',
  });
  assert.match(archive.query, /clinic_id = \$3 AND is_archived = \$6/);
  assert.match(archive.query, /created_by_user_id/);
  assert.deepEqual(archive.params, [true, 12, 'clinic-a', 8, 'Producto discontinuado por el proveedor', false, 8]);
  const restore = buildInventoryArchiveUpdate({
    itemId: 12, clinicId: 'clinic-a', userId: 8, inventoryScope: 'all', archive: false,
  });
  assert.deepEqual(restore.params, [false, 12, 'clinic-a', 8, null, true]);
  assert.throws(() => buildInventoryArchiveUpdate({ itemId: 12, clinicId: 'clinic-a', userId: 8, inventoryScope: 'all', archive: true, reason: 'cambio' }), RangeError);
  assert.throws(() => buildInventoryArchiveUpdate({ itemId: 12, clinicId: null, userId: 8, inventoryScope: 'all', archive: true, reason: 'Producto fuera de clínica' }), TypeError);
  assert.equal(validateInventoryListStatus(undefined, 'clinic_user'), 'active');
  assert.equal(validateInventoryListStatus('archived', 'clinic_admin'), 'archived');
  assert.throws(() => validateInventoryListStatus('archived', 'clinic_user'), TypeError);
  assert.match(getInventoryPermanentDeleteConflict({ isArchived: false, hasMovementHistory: false, hasRemainingStock: false }), /Archiva/);
  assert.match(getInventoryPermanentDeleteConflict({ isArchived: true, hasMovementHistory: true, hasRemainingStock: false }), /historial/);
  assert.equal(getInventoryPermanentDeleteConflict({ isArchived: true, hasMovementHistory: false, hasRemainingStock: false }), null);
});

test('inventory price validation and consumption enforce monetary and stock boundaries', async () => {
  const { normalizeInventoryPrice, normalizeInventoryCategory, decrementInventoryBatch } = await import('../api/records.js');
  assert.equal(normalizeInventoryPrice(''), null);
  assert.equal(normalizeInventoryPrice('12.50'), 12.5);
  assert.equal(normalizeInventoryPrice(0), 0);
  assert.equal(normalizeInventoryCategory('  Consumibles  '), 'Consumibles');
  assert.throws(() => normalizeInventoryCategory('   '), TypeError);
  assert.throws(() => normalizeInventoryCategory('x'.repeat(101)), TypeError);
  for (const price of [-1, 'abc', 1.234, Infinity]) {
    assert.throws(() => normalizeInventoryPrice(price), RangeError);
  }
  const client = { query: async (sql, params) => {
    assert.match(sql, /quantity_current >= \$2/);
    assert.match(sql, /status = 'active'/);
    assert.match(sql, /i\.is_archived = false/);
    assert.match(sql, /expiration_date >= CURRENT_DATE OR \$3 = 'Vencimiento'/);
    assert.deepEqual(params, [7, 2.5, 'Uso en cabina']);
    return { rows: [] };
  } };
  assert.deepEqual((await decrementInventoryBatch(client, 7, 2.5, 'Uso en cabina')).rows, []);
});

test('inventory sales require captured price and reports stay within clinic and date range', async () => {
  const { validateInventorySalePrice, buildInventorySalesFilter, recordInventoryOutflow, INVENTORY_OUTFLOW_REASONS } = await import('../api/records.js');
  assert.equal(validateInventorySalePrice('Uso en cabina', null, 2), null);
  assert.equal(validateInventorySalePrice('Venta directa', '12.50', 2), 12.5);
  assert.equal(INVENTORY_OUTFLOW_REASONS.has('Venta directa'), true);
  assert.equal(INVENTORY_OUTFLOW_REASONS.has('venta directa'), false);
  for (const price of [null, 0, -1, 'abc']) {
    assert.throws(() => validateInventorySalePrice('Venta con descuento', price, 1), RangeError);
  }
  const filters = buildInventorySalesFilter({
    clinicId: 'clinic-a', startDate: '2026-09-01', endDate: '2026-09-29',
    ownerId: 7, userId: 7, category: 'Venta', search: "x%' OR TRUE--",
  });
  assert.match(filters.where, /m\.clinic_id = \$1 AND i\.clinic_id = \$1/);
  assert.match(filters.where, /America\/Guayaquil/);
  assert.match(filters.where, /created_by_user_id/);
  assert.doesNotMatch(filters.where, /TRUE--/);
  assert.deepEqual(filters.params, ['clinic-a', '2026-09-01', '2026-09-29', 7, 7, 'Venta', "%x%' OR TRUE--%"]);
  assert.throws(() => buildInventorySalesFilter({ clinicId: 'a', startDate: '2026-02-31', endDate: '2026-03-01' }), RangeError);
  assert.throws(() => buildInventorySalesFilter({ clinicId: 'a', startDate: '2024-01-01', endDate: '2026-01-01' }), RangeError);
  const client = { query: async (sql, params) => {
    assert.match(sql, /ROUND\(-\$3::numeric \* \$7::numeric, 2\)/);
    assert.match(sql, /cost_total/);
    assert.match(sql, /WHERE b\.id = \$1/);
    return { rows: [{ id: 3, sale_total: params[6] == null ? null : '25.00' }] };
  } };
  const movement = { batchId: 3, clinicId: 'clinic-a', quantity: 2, reason: 'Venta directa', referenceId: null, userId: 7, saleUnitPrice: 12.5 };
  assert.equal((await recordInventoryOutflow(client, movement)).rows[0].sale_total, '25.00');
  assert.equal((await recordInventoryOutflow(client, { ...movement, reason: 'Vencimiento', saleUnitPrice: null })).rows[0].sale_total, null);
});

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
  // La negación debe primar sobre la palabra "confirmar" presente en la misma frase
  assert.equal(classifyAppointmentReply('No voy a poder confirmar'), 'needs_contact');
  assert.equal(classifyAppointmentReply('necesito cancelar, confirmo que no puedo'), 'needs_contact');
  assert.equal(formatAppointmentReplyStatus('confirmed'), '✅ Confirmó asistencia');
  assert.equal(formatAppointmentReplyStatus('needs_contact'), '🔴 Respondió — requiere que la clínica lo contacte');
  assert.equal(formatAppointmentReplyStatus(null), '⏳ Aún no responde el recordatorio');
});

test('bot global commands ignore accents added by mobile autocorrect', async () => {
  const { normalizeCommandText } = await import('../api/whatsapp-chatbot.js');

  assert.equal(normalizeCommandText(' Menú '), 'menu');
  assert.equal(normalizeCommandText('CANCELAR'), 'cancelar');
  assert.equal(normalizeCommandText('Mañana'), 'manana');
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
  const annulled = buildBackupInsertStatement('consent_forms', {
    id: 13, status: 'draft', replaces_consent_id: 12, annulment_reason: null, signing_token: 'secret',
  }, new Set(['id', 'status', 'replaces_consent_id', 'annulment_reason', 'signing_token']));
  assert.match(annulled.query, /replaces_consent_id/);
  assert.doesNotMatch(annulled.query, /signing_token/);

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
      if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
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
      if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
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
      if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
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
      if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
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

test('deleting a consultation detaches clinical records without deleting them', async () => {
  const { detachConsultationChildren } = await import('../api/records.js');
  const statements = [];
  const detached = await detachConsultationChildren({
    query: async (statement, values) => {
      statements.push({ statement, values });
      return { rowCount: 1 };
    },
  }, 31);

  assert.equal(detached, 6);
  assert.equal(statements.length, 6);
  assert.ok(statements.every(({ statement, values }) => statement.includes('UPDATE ') &&
    statement.includes('SET consultation_id = NULL') && values[0] === 31));
  assert.ok(statements.every(({ statement }) => !statement.includes('DELETE FROM')));
});

test('backup replacement cannot refer to a consent from another patient or clinic', async () => {
  const { insertBackupRow } = await import('../api/backup.js');
  const clinicId = '11111111-1111-4111-8111-111111111111';
  let samePatient = false;
  const pool = {
    query: async (statement, params) => {
      if (statement.includes('information_schema.columns')) return {
        rows: ['id', 'patient_id', 'record_id', 'clinic_id', 'replaces_consent_id'].map(column_name => ({ column_name })),
      };
      if (/^SELECT clinic_id FROM \w+ WHERE id = \$1$/.test(statement)) return { rows: [] };
      if (statement.startsWith('SELECT patient_id FROM clinical_records')) return { rows: [{ patient_id: 8 }] };
      if (statement.startsWith('SELECT 1 FROM consent_forms')) {
        assert.deepEqual(params, [4, 8, 9, clinicId, 'annulled']);
        return { rows: samePatient ? [{ '?column?': 1 }] : [] };
      }
      if (statement.startsWith('INSERT INTO consent_forms')) return { rowCount: 1 };
      throw new Error('Unexpected query');
    },
  };
  const row = { id: 10, patient_id: 8, record_id: 9, replaces_consent_id: 4 };
  await assert.rejects(() => insertBackupRow(pool, 'consent_forms', row, clinicId, false), /reemplazo referencia/);
  samePatient = true;
  assert.equal(await insertBackupRow(pool, 'consent_forms', row, clinicId, false), 1);
});