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
  assert.match(dashboard, /transcurrido 30 días desde el vencimiento registrado/);
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
