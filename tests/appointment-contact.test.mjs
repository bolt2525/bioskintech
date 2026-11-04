import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/utils/whatsappMessage.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText, { exports });
const { normalizeAppointmentPhone, appointmentContact } = exports;

test('mantiene Ecuador local e internacional sin duplicar 593', () => {
  for (const phone of ['0991234567', '991234567', '+593 99 123 4567', '593991234567', '00593 99 123 4567']) {
    assert.equal(normalizeAppointmentPhone(phone), '593991234567', phone);
  }
  assert.equal(normalizeAppointmentPhone('02 234 5678'), '59322345678');
});

test('respeta prefijos extranjeros, 00, paréntesis y países con ceros internos', () => {
  for (const [input, expected] of [
    ['+34 612 345 678', '34612345678'], ['0034 (612) 345-678', '34612345678'],
    ['+1 (202) 555-0123', '12025550123'], ['+39 06 6982 0000', '390669820000'],
    ['+49 30 123456', '4930123456'], ['34612345678', '34612345678'],
    ['+290 1234', '2901234'],
  ]) assert.equal(normalizeAppointmentPhone(input), expected, input);
});

test('no fabrica enlaces desde teléfonos incompletos, extensiones ni texto', () => {
  for (const input of ['', '0', '123', '+0123456789', '01234567890', '612345678',
    '+1234567890123456', '+34 612345678 ext 12', '0991234567 / 0987654321',
    'https://wa.me/123456789', '0991234567\nEmail: 12', '++34612345678']) {
    assert.equal(normalizeAppointmentPhone(input), '', input);
  }
});

test('lee variantes de etiquetas y descripciones HTML sin perder paréntesis', () => {
  for (const label of ['Teléfono', 'Telefono', 'TELÉFONO', 'Tel.', 'Celular', 'Móvil', 'Phone', 'WhatsApp', 'Teléfono / WhatsApp']) {
    const contact = appointmentContact(`${label}: +1 (202) 555-0123\nEmail: prueba@example.test`);
    assert.equal(contact.internationalPhone, '12025550123', label);
    assert.equal(contact.issue, '');
  }
  assert.equal(appointmentContact('<p><b>Teléfono:</b>&nbsp;+34 (612) 345-678</p><p>Servicio: Otro</p>').internationalPhone, '34612345678');
});

test('distingue teléfono ausente e inválido y no captura la siguiente línea', () => {
  for (const description of [undefined, '', 'Servicio: Otro', 'Teléfono:\nFecha: 2026-11-07', 'Teléfono: \r\n1234567890']) {
    const contact = appointmentContact(description);
    assert.equal(contact.phone, '');
    assert.match(contact.issue, /Sin teléfono/);
  }
  const invalid = appointmentContact('Teléfono: no registrado');
  assert.equal(invalid.internationalPhone, '');
  assert.match(invalid.issue, /Revisa el teléfono/);
});
