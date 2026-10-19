import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = await readFile(new URL(
  '../src/components/admin/ficha-clinica/components/tabs/ConsentimientosTab.tsx',
  import.meta.url,
), 'utf8');
const api = await readFile(new URL('../api/records.js', import.meta.url), 'utf8');

test('draft critical antecedents are controlled and included in persistence', () => {
  assert.match(component, /value=\{currentConsent\.critical_antecedents\.allergies\}/);
  assert.match(component, /value=\{currentConsent\.critical_antecedents\.medications\}/);
  assert.match(component, /body: JSON\.stringify\(buildConsentPayload\(currentConsent\)\)/);
  assert.match(api, /critical_antecedents = COALESCE\(\$14, critical_antecedents\)/);
  assert.match(api, /JSON\.stringify\(critical_antecedents\)/);
  assert.match(api, /critical_antecedents, authorizations, declarations/);
});

test('templates restore every medical detail represented by the form', () => {
  for (const field of [
    'objectives', 'risks', 'benefits', 'alternatives',
    'pre_care', 'post_care', 'contraindications',
  ]) {
    assert.match(component, new RegExp(`${field}: template\\.${field} \\|\\| \\[\\]`), field);
  }
});

test('existing drafts preserve their consultation and empty states use the active consultation', () => {
  assert.match(component, /!consent\.id && consent\.consultation_id == null && consultationId/);
  assert.doesNotMatch(component, /\.\.\.\(consultationId \? \{ consultation_id: consultationId \} : \{\}\)/);
  assert.match(component, /patient_id: patientId,\s+consultation_id: consultationId,/);
  assert.match(component, /!loading && currentConsents\.length === 0/);
});

test('database migration is not exposed as a clinical user action', () => {
  assert.doesNotMatch(component, /Configurar DB|migrateConsents/);
});

test('deletion reports a list refresh failure instead of a false success', () => {
  assert.match(component, /if \(!await loadConsents\(\)\)/);
  assert.match(component, /El consentimiento fue eliminado, pero no se pudo actualizar la lista/);
});
