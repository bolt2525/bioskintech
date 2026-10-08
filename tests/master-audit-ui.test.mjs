import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/pages/AdminMasterDashboard.tsx', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function formatPurgeDate('), source.indexOf('function formatPurgeEligibilityDate('));
const FixedDate = class extends Date {
  static now() { return Date.parse('2026-10-07T23:00:00Z'); }
};
const context = { Date: FixedDate };
vm.createContext(context);
vm.runInContext(ts.transpile(functions) + '\nthis.formatDate = formatPurgeDate; this.elapsed = formatElapsed;', context);

test('Master presents last successful access in Ecuador without assuming every user has logged in', () => {
  assert.match(source, /Último acceso/);
  assert.match(source, /Sin acceso registrado/);
  assert.match(source, /u\.last_login/);
  assert.match(source, /inicio de sesión exitoso/);
  const displayed = context.formatDate('2026-10-07T23:00:00Z');
  assert.match(displayed, /18:00|6:00/);
  assert.equal(context.formatDate(null), 'No registrada');
});

test('elapsed purge time reports days and hours, missing dates and recent events', () => {
  assert.equal(context.elapsed('2026-10-05T21:00:00Z'), '2 días 2 h');
  assert.equal(context.elapsed('2026-10-07T22:15:00Z'), '45 min');
  assert.equal(context.elapsed('2026-10-07T21:15:00Z'), '1 h 45 min');
  assert.equal(context.elapsed('2026-10-06T23:00:00Z'), '1 día 0 h');
  assert.equal(context.elapsed(null), 'Sin fecha registrada');
  assert.equal(context.elapsed('not-a-date'), 'Sin fecha registrada');
  assert.equal(context.elapsed('2026-10-08T23:00:00Z'), '0 min');
  assert.match(source, /clinic\.purge_completed_at/);
  assert.match(source, /disabled=\{clinicActionBusyId === clinic\.id \|\| !!clinic\.purge_state\}/);
});

test('Master user filters cover email, clinic and activity with explicit sort and accessible controls', () => {
  assert.match(source, /\[u\.username, u\.full_name, u\.email, u\.clinic_name\]/);
  assert.match(source, /matchSearch && matchClinic && matchStatus/);
  assert.match(source, /aria-label="Ordenar usuarios"/);
  assert.match(source, /Accesos recientes/);
  assert.match(source, /w-full min-w-0 sm:w-auto sm:max-w-xs/);
  assert.match(source, /aria-expanded=\{showNotifications\}/);
  assert.match(source, /colSpan=\{9\}/);
});

test('module selection preserves full UUID identifiers and mobile navigation wraps', () => {
  assert.doesNotMatch(source, /setSelectedModuleClinic\([^;]*parseInt/);
  assert.match(source, /clinics\.find\(clinic => String\(clinic\.id\) === e\.target\.value\)\?\.id/);
  assert.match(source, /grid grid-cols-2 gap-1 sm:flex sm:flex-wrap/);
  assert.match(source, /Clínica para acceder a los módulos/);
});

test('compact backup guidance remains available on demand and JSON downloads stay compressed', () => {
  const backup = readFileSync(new URL('../src/pages/AdminBackup.tsx', import.meta.url), 'utf8');
  assert.match(backup, /<summary[^>]*>Alcance y límites de las copias<\/summary>/);
  const downloader = backup.slice(backup.indexOf('async function downloadCompressedBackup'), backup.indexOf('async function downloadConsentPages'));
  assert.match(downloader, /saveBlob\(await response\.blob\(\), filename\)/);
  assert.doesNotMatch(downloader, /DecompressionStream|JSON\.parse/);
  assert.match(backup, /filteredSnapshots\.slice\(0, snapshotLimit\)/);
  assert.match(backup, /puede ocurrir después/);
});

test('visible provider terminology preserves internal roles and shared contractual documents', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../src/constants/theme.ts'), /master_admin: 'Proveedor del sistema'/);
  assert.match(source, /<option value="master_admin">Proveedor del sistema<\/option>/);
  for (const path of ['../src/pages/TermsOfService.tsx', '../src/pages/PrivacyPolicy.tsx']) {
    assert.match(read(path), /autorización del proveedor del sistema/);
    assert.doesNotMatch(read(path), /Master Admin/);
  }
  assert.match(read('../src/components/admin/AnnualPhotoBackupPanel.tsx'), /El proveedor del sistema recibirá la notificación/);
});
