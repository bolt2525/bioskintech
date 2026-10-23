import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateMasterContractRecord } from '../lib/master-contract-records.js';

const validInput = () => ({
  client: {
    partyType: 'natural',
    contractReference: 'BIOSKIN-2026-001',
    name: 'Paciente de Prueba',
    taxId: '0102030405',
    address: 'Cuenca, Ecuador',
    representative: '',
    representativeId: '',
    representativeRole: '',
    email: 'prueba@example.com',
    phone: '0991234567',
    clinicName: 'Clínica de Prueba',
    startDate: '2026-10-23',
    paymentMethod: 'Tarjeta',
    otherPaymentMethod: '',
    cardCommission: '14.95',
  },
  chatbot: true,
  options: {
    jurisdiction: 'Cuenca',
    support: false,
    supportTerms: 'Texto de soporte.',
    refund: false,
    refundTerms: 'Texto de devolución.',
    incidentNotice: false,
    aiInstructions: false,
    aiInstructionTerms: 'Texto de IA.',
    activation: false,
    activationTerms: 'Texto de activación.',
  },
  prices: { platform: '245', chatbot: '100' },
  selectedModules: ['clinical-records', 'inventory'],
  legalVersion: '2026-10-07-r2',
});

test('normalizes a valid contract and computes the saved total in cents', () => {
  const result = validateMasterContractRecord(validInput());
  assert.equal(result.error, undefined);
  assert.equal(result.record.annualTotal, '359.95');
  assert.equal(result.record.contractData.client.contractReference, 'BIOSKIN-2026-001');
  assert.deepEqual(result.record.contractData.selectedModules, ['clinical-records', 'inventory']);
});

test('requires a valid client identity, date, and unique module selection', () => {
  const invalidIdentity = validInput();
  invalidIdentity.client.taxId = '123';
  assert.match(validateMasterContractRecord(invalidIdentity).error, /datos obligatorios/);

  const invalidDate = validInput();
  invalidDate.client.startDate = '2026-02-31';
  assert.match(validateMasterContractRecord(invalidDate).error, /datos obligatorios/);

  const duplicateModules = validInput();
  duplicateModules.selectedModules = ['inventory', 'inventory'];
  assert.match(validateMasterContractRecord(duplicateModules).error, /módulos válidos/);
});

test('requires text for enabled negotiated terms and rejects unsupported modules', () => {
  const missingTerms = validInput();
  missingTerms.options.support = true;
  missingTerms.options.supportTerms = '   ';
  assert.match(validateMasterContractRecord(missingTerms).error, /condiciones particulares/);

  const unsupportedModule = validInput();
  unsupportedModule.selectedModules = ['unknown'];
  assert.match(validateMasterContractRecord(unsupportedModule).error, /módulos válidos/);
});

test('rejects payment methods outside the contract form options', () => {
  const invalidPayment = validInput();
  invalidPayment.client.paymentMethod = 'cash';
  assert.match(validateMasterContractRecord(invalidPayment).error, /datos obligatorios/);
});

test('rejects malformed payloads and invalid contract references', () => {
  assert.match(validateMasterContractRecord(null).error, /Datos de contrato/);
  const invalidReference = validInput();
  invalidReference.client.contractReference = '<script>';
  assert.match(validateMasterContractRecord(invalidReference).error, /datos obligatorios/);
});

test('print CSS uses system fonts and avoids forcing background graphics', () => {
  const source = readFileSync(new URL('../src/components/admin/ContractGenerator.tsx', import.meta.url), 'utf8');
  assert.match(source, /font-family: Arial, Helvetica, sans-serif !important/);
  assert.match(source, /print-color-adjust: economy/);
  assert.doesNotMatch(source, /print-color-adjust: exact/);
});
