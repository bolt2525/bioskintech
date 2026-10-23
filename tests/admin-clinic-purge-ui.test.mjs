import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboard = readFileSync(new URL('../src/pages/AdminMasterDashboard.tsx', import.meta.url), 'utf8');

test('Master reemplaza el borrado directo por desactivación y revisión de purga', () => {
  assert.doesNotMatch(dashboard, /action=deleteClinic/);
  assert.match(dashboard, /setClinicActive\(clinic\)/);
  assert.match(dashboard, /openClinicPurge\(clinic\)/);
  assert.match(dashboard, /action=updateClinic/);
});

test('desactivar avisa de enlaces pendientes revocados sin borrar consentimientos ni firmas', () => {
  assert.match(dashboard, /se invalidarán los enlaces de firma pendientes/);
  assert.match(dashboard, /consentimientos y firmas permanecerán conservados/);
  assert.match(dashboard, /Los consentimientos pendientes requieren un nuevo enlace de firma/);
});

test('la vista previa consulta el alcance sin caché y valida la respuesta', () => {
  assert.match(dashboard, /action=clinicPurgePreview&id=\$\{encodeURIComponent\(clinicId\)\}/);
  assert.match(dashboard, /cache: 'no-store'/);
  assert.match(dashboard, /!res\.ok \|\| !isClinicPurgePreview\(payload\)/);
  assert.match(dashboard, /Object\.entries\(clinicPurgePreview\.counts\)/);
});

test('la UI integrada conserva validación y conteos WhatsApp sin equiparar retenidos con propiedad', () => {
  assert.match(dashboard, /!isClinicPurgeWhatsappSummary\(value\.whatsapp\)/);
  assert.match(dashboard, /value\.policy === 'preserve_ambiguous'/);
  assert.match(dashboard, /Object\.entries\(clinicPurgePreview\.whatsapp\.deletable\)/);
  assert.match(dashboard, /Object\.entries\(clinicPurgePreview\.whatsapp\.retained\)/);
  assert.match(dashboard, /sus conteos no significan que pertenezcan a esta clínica/);
  assert.match(dashboard, /Solo se eliminan registros con atribución exclusiva verificable/);
});

test('la purga exige slug exacto, autorización, retención y motivo antes del POST', () => {
  assert.match(dashboard, /clinicPurgeConfirmation === clinicPurgePreview\.requiredConfirmation/);
  assert.match(dashboard, /clinicPurgeAuthorized && clinicPurgeRetentionConfirmed/);
  assert.match(dashboard, /clinicPurgeReason\.trim\(\)\.length >= 10/);
  assert.match(dashboard, /action=purgeClinic/);
  assert.match(dashboard, /authorizationConfirmed: clinicPurgeAuthorized/);
  assert.match(dashboard, /retentionConfirmed: clinicPurgeRetentionConfirmed/);
  assert.match(dashboard, /confirmation: clinicPurgeConfirmation/);
  assert.match(dashboard, /reason: clinicPurgeReason\.trim\(\)/);
});

test('la UI explica la espera, el avance durable, reintentos y retención de copias', () => {
  assert.match(dashboard, /Esta revisión no borra información ni libera identificadores/);
  assert.match(dashboard, /La API confirma el plazo aplicable/);
  assert.match(dashboard, /suscripciones pagadas pueden requerir 45 días/);
  assert.match(dashboard, /endedAt \+ 30 \* 86400000/);
  assert.match(dashboard, /retryAfter/);
  assert.match(dashboard, /leaseUntil/);
  assert.match(dashboard, /last_error/);
  assert.match(dashboard, /deletedObjects/);
  assert.match(dashboard, /immutableDays/);
  assert.match(dashboard, /retentionDays/);
  assert.match(dashboard, /[Nn]o se borran inmediatamente/);
  assert.match(dashboard, /lifecycle informado/);
});

test('el diálogo de purga tiene semántica accesible y los errores no se convierten en éxito', () => {
  assert.match(dashboard, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  assert.match(dashboard, /role="alert"/);
  assert.match(dashboard, /!res\.ok \|\| !d\.success \|\| d\.error/);
  assert.match(dashboard, /payload\.complete && \(res\.status !== 200 \|\| payload\.purge\?\.state !== 'COMPLETE'\)/);
});

test('reutilización se anuncia al inicio durable, no al consultar o desactivar', () => {
  assert.match(dashboard, /typeof value\.manualLegacyAuthorizationRequired !== 'boolean'/);
  assert.match(dashboard, /value\.identifiersReleasedAt === null/);
  assert.match(dashboard, /Number\.isFinite\(Date\.parse\(value\.identifiersReleasedAt\)\)/);
  assert.match(dashboard, /value\.identifiersReleasedAt !== null && !isRecord\(value\.purge\)/);
  assert.match(dashboard, /clinicPurgePreview\.identifiersReleasedAt/);
  assert.match(dashboard, /Desactivar la clínica o consultar esta vista previa no los libera/);
  assert.match(dashboard, /sin esperar a que termine el borrado/);
  assert.match(dashboard, /El nuevo registro no hereda fichas, conversaciones ni credenciales/);
  assert.match(dashboard, /payload\.identifiersReleasedAt && !clinicPurgePreview\.identifiersReleasedAt\) await loadAll\(\)/);
});

test('legacy manual requiere confirmación expresa sin habilitar purga automática', () => {
  assert.match(dashboard, /setClinicPurgeLegacyAuthorized\(false\)/);
  assert.match(dashboard, /legacyAuthorizationConfirmed: clinicPurgeLegacyAuthorized/);
  assert.match(dashboard, /!clinicPurgePreview\.manualLegacyAuthorizationRequired \|\| clinicPurgeLegacyAuthorized/);
  assert.match(dashboard, /Esto no habilita la purga automática de clínicas legacy/);
});

test('una purga autorizada explica la continuación diaria sin mantener abierta la ventana', () => {
  assert.match(dashboard, /continúa automáticamente en el cron diario de las 03:00 \(Ecuador\)/);
  assert.match(dashboard, /Puedes cerrar esta ventana/);
  assert.match(dashboard, /procesar un lote manualmente es opcional/);
});
