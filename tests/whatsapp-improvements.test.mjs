import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { resolveOperationalWaLink } from '../lib/wa-link-resolver.js';
import { buildStaffAppointmentReplyMessage, extractIncomingMessages } from '../api/whatsapp-chatbot.js';

const CLINIC = '11111111-2222-4333-8444-555555555555';
const CODE = `${CLINIC}.aaaaaaaaa_bbbbbbbbbbbb`;
const TARGET = 'https://wa.me/593999000111?text=Hola';

function linkDb({ links = [{ code: CODE, target_url: TARGET }], origins = [{ clinic_id: CLINIC }], active = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM wa_short_links')) {
        assert.match(sql, /INTERVAL '30 days'/);
        assert.match(sql, /retired_at IS NULL/);
        return { rows: links.map(link => ({ created_at: '2026-10-23T12:00:00Z', ...link })) };
      }
      if (sql.includes('FROM clinic_identity_history')) return { rows: [{ released_at: null }] };
      if (sql.includes('SELECT DISTINCT COALESCE')) return { rows: origins };
      if (sql.includes('FROM clinics c')) return { rows: [{ is_active: active, general: {} }] };
      assert.fail(`Unexpected query: ${sql}`);
    },
  };
}

test('short links keep exact and stripped codes but reject ambiguous recovery', async () => {
  assert.equal(await resolveOperationalWaLink(CODE, linkDb()), TARGET);
  assert.equal(await resolveOperationalWaLink(CODE.replace('_', ''), linkDb()), TARGET);
  assert.equal(await resolveOperationalWaLink(CODE.replace('_', ''), linkDb({ links: [
    { code: CODE, target_url: TARGET }, { code: CODE.replace('_b', 'b_'), target_url: TARGET },
  ] })), null);
  assert.equal(await resolveOperationalWaLink(CODE, linkDb({ links: [] })), null);
  const db = linkDb();
  assert.equal(await resolveOperationalWaLink('../secret', db), null);
  assert.equal(db.calls.length, 0);
});

test('short links recheck lifecycle without cache and constrain redirect hosts', async () => {
  assert.equal(await resolveOperationalWaLink(CODE, linkDb({ active: false })), null);
  for (const target_url of ['https://example.invalid/', 'javascript:alert(1)', 'https://wa.me.evil.invalid/1234567']) {
    assert.equal(await resolveOperationalWaLink(CODE, linkDb({ links: [{ code: CODE, target_url }] })), null);
  }
  for (const lifecycle of [
    { is_active: true, general: { _purge: {} } },
    { is_active: true, subscription_expires_at: '2020-01-01T00:00:00Z' },
  ]) {
    const db = linkDb();
    const query = db.query.bind(db);
    db.query = (sql, values) => sql.includes('FROM clinics c') ? { rows: [lifecycle] } : query(sql, values);
    assert.equal(await resolveOperationalWaLink(CODE, db), null);
  }
  await assert.rejects(resolveOperationalWaLink(CODE, { query: async () => { throw new Error('database unavailable'); } }), /database unavailable/);
});

test('legacy links survive only with one evidenced tenant, never by guessing from destination', async () => {
  const options = { links: [{ code: 'old-code', target_url: TARGET }] };
  assert.equal(await resolveOperationalWaLink('old-code', linkDb(options)), TARGET);
  for (const origins of [[], [{ clinic_id: null }], [{ clinic_id: CLINIC, conflicting: true }], [{ clinic_id: CLINIC }, { clinic_id: 'another-clinic' }]]) {
    assert.equal(await resolveOperationalWaLink('old-code', linkDb({ ...options, origins })), null);
  }
  assert.equal(await resolveOperationalWaLink('old-code', linkDb({ ...options, active: false })), null);
});

test('foreign numbers and non-text content are auditable without activating bot flows', () => {
  const messages = extractIncomingMessages({ entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '15557060441', profile: { name: 'Prueba' } }],
    messages: [
      { id: 'reaction', from: '15557060441', type: 'reaction', reaction: { emoji: '👍' } },
      { id: 'removed', from: '15557060441', type: 'reaction', reaction: { emoji: '' } },
      { id: 'sticker', from: '15557060441', type: 'sticker' },
      { id: 'image', from: '15557060441', type: 'image', image: { caption: 'confirmar' } },
      { id: 'audio', from: '15557060441', type: 'audio' },
      { id: 'button', from: '15557060441', type: 'button', button: { text: 'Confirmar asistencia', payload: 'appointment_confirm:test' } },
      { id: 'text', from: '15557060441', type: 'text', text: { body: 'Confirmo' } },
      { id: 'unknown', from: '15557060441', type: 'unknown' },
    ],
  } }] }] });
  assert.ok(messages.every(message => message.from === '15557060441' && message.name === 'Prueba' && message.text));
  assert.deepEqual(messages.filter(message => message.processable).map(message => message.providerMessageId), ['button', 'text']);
  assert.equal(messages[0].text, '[Reacción 👍]');
  assert.equal(messages[1].text, '[Reacción retirada]');
  assert.equal(messages[2].text, '[Sticker]');
  assert.equal(messages[5].buttonPayload, 'appointment_confirm:test');
});

test('delay notices are short, informative and never claim a confirmed patient cancelled', () => {
  const appointment = { patient_name: 'Paciente Prueba', appointment_start: '2026-10-21T17:00:00Z' };
  const delay = buildStaffAppointmentReplyMessage(appointment, 'Voy a llegar un poco tarde');
  assert.match(delay, /avisa un retraso/);
  assert.doesNotMatch(delay, /NO confirmó|cancel/);
  assert.ok(delay.length < 250);
  assert.match(buildStaffAppointmentReplyMessage(appointment, 'Necesito cambiar de día'), /requiere contacto/);
  assert.ok(buildStaffAppointmentReplyMessage(appointment, 'x'.repeat(2000)).length < 350);
});

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/whatsappMessage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports, URL });

test('CRM renders template parameters without changing the recorded message or losing URLs', () => {
  const content = `[plantilla:confirmacion_cita] nombre_paciente=Paciente Prueba | fecha_hora=21/10/2026, 17:00 | enlace_contacto=https://example.test/r/a_b?text=a=b`;
  const template = exports.parseWhatsAppTemplate(content);
  assert.equal(template.title, 'Confirmación de cita');
  assert.equal(template.fields.length, 3);
  assert.equal(template.fields[2].value, 'https://example.test/r/a_b?text=a=b');
  assert.equal(exports.whatsAppMessagePreview(content), 'Plantilla: Confirmación de cita');
  assert.equal(exports.whatsAppMessagePreview('Hola'), 'Hola');
  assert.equal(exports.parseWhatsAppTemplate('<script>alert(1)</script>'), null);
  assert.equal(exports.whatsAppMessagePreview(content, 'entrante'), content);
  const summary = exports.parseWhatsAppTemplate('[plantilla:agenda_diaria_staff] resumen=1. Paciente A | 2. Paciente B');
  assert.equal(summary.fields[0].value, '1. Paciente A | 2. Paciente B');
});

test('CRM only activates links to trusted WhatsApp and application routes', () => {
  for (const value of ['javascript:alert(1)', 'https://phishing.invalid/', 'https://wa.me.evil.invalid/1234567',
    'https://user:pass@wa.me/593999000111', 'https://wa.me:444/593999000111', 'https://bioskintechapp.com/admin']) {
    assert.equal(exports.trustedWhatsAppHref(value), null);
  }
  for (const value of ['https://wa.me/593999000111?text=Hola',
    `https://www.bioskintechapp.com/r/${CODE}`]) {
    assert.equal(exports.trustedWhatsAppHref(value), value);
  }
});
