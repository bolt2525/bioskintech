import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const api = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../src/pages/AdminMasterDashboard.tsx', import.meta.url), 'utf8');

test('user deletion clears restrictive registration and invitation references before deleting the user', () => {
  const deleteUser = api.slice(api.indexOf('async function deleteUser('), api.indexOf('// ───', api.indexOf('async function deleteUser(')));
  assert.match(deleteUser, /UPDATE invite_links SET used_by = NULL WHERE used_by = \$\{id\}/);
  assert.match(deleteUser, /UPDATE invite_links SET created_by = NULL WHERE created_by = \$\{id\}/);
  assert.match(deleteUser, /UPDATE registration_codes SET used_by = NULL WHERE used_by = \$\{id\}/);
  assert.match(deleteUser, /UPDATE registration_codes SET created_by = NULL WHERE created_by = \$\{id\}/);
  assert.match(deleteUser, /await revokeGoogleRefreshToken\(oauth\.rows\[0\]\?\.refresh_token\)/);
  assert.ok(deleteUser.indexOf('UPDATE registration_codes SET created_by') < deleteUser.indexOf('DELETE FROM clinic_users'));
  assert.ok(deleteUser.indexOf('await revokeGoogleRefreshToken') < deleteUser.indexOf('DELETE FROM clinic_users'));
  assert.match(deleteUser, /DELETE FROM clinic_users WHERE id = \$\{id\} RETURNING id/);
});

test('user deletion API requires DELETE and rejects master or current accounts', () => {
  const deleteUser = api.slice(api.indexOf('async function deleteUser('), api.indexOf('// ───', api.indexOf('async function deleteUser(')));
  const route = api.slice(api.indexOf("if (action === 'deleteUser')"), api.indexOf('// Gestión de clínicas', api.indexOf("if (action === 'deleteUser')")));
  assert.match(deleteUser, /target\.rows\[0\]\.role === 'master_admin'/);
  assert.match(deleteUser, /String\(target\.rows\[0\]\.id\) === String\(requestUser\.id\)/);
  assert.match(route, /req\.method !== 'DELETE'/);
  assert.match(api, /if \(!parsePostgresIntegerId\(req\.query\.id \|\| req\.body\?\.id\)\)/);
  assert.match(api, /AbortSignal\.timeout\(8000\)/);
});

test('master user management reports HTTP/network failures instead of showing false success', () => {
  const deleteAction = dashboard.slice(dashboard.indexOf('const deleteUser = async'), dashboard.indexOf('const setClinicActive = async'));
  assert.match(deleteAction, /!res\.ok \|\| !data\.success/);
  assert.match(deleteAction, /catch \(error\)/);
});
