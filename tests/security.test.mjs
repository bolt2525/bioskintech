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