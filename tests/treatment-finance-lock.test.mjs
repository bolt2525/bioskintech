import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasProtectedTreatmentFinanceChanges,
  validateTreatmentFinanceInput,
} from '../lib/modules/fichas-clinicas/treatment-finance-lock.js';

const current = {
  cost: '30.00',
  consultation_id: 98,
  package_id: null,
  date: new Date('2026-03-30T00:00:00.000Z'),
  procedure_name: 'Remoción tatuaje corporal',
};

test('permite cambios clínicos cuando la identidad financiera permanece igual', () => {
  assert.equal(hasProtectedTreatmentFinanceChanges(current, {
    ...current,
    cost: 30,
    date: '2026-03-30',
    equipment_used: 'Láser Nd:YAG',
    notes: 'Parámetros actualizados',
  }), false);
});

test('bloquea cambios reales en campos vinculados al registro financiero', () => {
  for (const change of [
    { cost: 31 },
    { consultation_id: 99 },
    { package_id: 7 },
    { date: '2026-03-31' },
    { procedure_name: 'Otro procedimiento' },
  ]) {
    assert.equal(hasProtectedTreatmentFinanceChanges(current, { ...current, ...change }), true);
  }
});

test('normaliza fechas equivalentes recibidas como Date, timestamp o fecha simple', () => {
  for (const date of [
    '2026-03-30',
    '2026-03-30T00:00:00.000Z',
    new Date('2026-03-30T12:00:00.000Z'),
  ]) {
    assert.equal(hasProtectedTreatmentFinanceChanges(current, { ...current, date }), false);
  }
});

test('rechaza tipos coercibles y fechas no canónicas antes del UPDATE', () => {
  for (const input of [
    { procedure_name: ['Remoción tatuaje corporal'] },
    { procedure_name: '' },
    { consultation_id: '98' },
    { package_id: false },
    { date: '2026-03-30 BC' },
    { date: '2026-02-30' },
    { date: new Date('2026-03-30T00:00:00.000Z') },
  ]) {
    assert.ok(validateTreatmentFinanceInput(input));
  }
});

test('el comparador falla cerrado ante valores protegidos no escalares', () => {
  assert.equal(hasProtectedTreatmentFinanceChanges(current, {
    ...current,
    procedure_name: ['Remoción tatuaje corporal'],
  }), true);
  assert.equal(hasProtectedTreatmentFinanceChanges(current, {
    ...current,
    date: '2026-03-30 BC',
  }), true);
});
