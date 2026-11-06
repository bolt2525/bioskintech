import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_FEATURES, OPT_IN_FEATURES, FEATURE_META, isUserFeatureEnabled, getVisibleModules } from '../src/constants/features.ts';

test('Gemini requiere opt-in de clínica y de usuario, no hereda acceso', () => {
  assert.ok(ALL_FEATURES.includes('skin_visual_ai'));
  assert.ok(OPT_IN_FEATURES.includes('skin_visual_ai'));
  assert.ok(FEATURE_META.skin_visual_ai.label.includes('Gemini'));
  assert.equal(isUserFeatureEnabled('skin_visual_ai', undefined), false);
  assert.equal(isUserFeatureEnabled('skin_visual_ai', false), false);
  assert.equal(isUserFeatureEnabled('skin_visual_ai', true), true);
});

test('el opt-in individual no altera la herencia de módulos existentes', () => {
  for (const feature of ALL_FEATURES.filter(item => item !== 'skin_visual_ai')) {
    assert.equal(isUserFeatureEnabled(feature, undefined), true);
    assert.equal(isUserFeatureEnabled(feature, false), false);
    assert.equal(isUserFeatureEnabled(feature, true), true);
  }
});

test('Gemini es una capacidad de Examen físico, no un módulo vacío independiente', () => {
  assert.equal(getVisibleModules(() => true, true).some(item => item.feat === 'skin_visual_ai'), false);
});
