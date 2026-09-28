import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  buildConsentGmailRaw,
  hashConsentEvidence,
  hashConsentSession,
  hashSigningCode,
  isValidSignatureDataUrl,
  maskEmail,
  normalizeEcuadorIdentification,
} from '../lib/consent-signing.js';

test('Ecuadorian identification accepts the expected cédula and RUC lengths', () => {
  assert.equal(normalizeEcuadorIdentification('cedula', '0102030405'), '0102030405');
  assert.equal(normalizeEcuadorIdentification('ruc', '0102030405001'), '0102030405001');
  assert.equal(normalizeEcuadorIdentification('cedula', '010203040'), null);
  assert.equal(normalizeEcuadorIdentification('ruc', '0102030405'), null);
  assert.equal(normalizeEcuadorIdentification('rut', '0102030405'), null);
  assert.equal(normalizeEcuadorIdentification('cedula', 'abc0102030405'), null);
});

test('consent evidence hashes are independent of object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashConsentEvidence({ b: 2, a: 1 }), hashConsentEvidence({ a: 1, b: 2 }));
  assert.notEqual(hashConsentEvidence({ a: 1 }), hashConsentEvidence({ a: 2 }));
  assert.equal(hashConsentEvidence({ date: new Date('2026-01-01T00:00:00.000Z') }), hashConsentEvidence({ date: '2026-01-01T00:00:00.000Z' }));
});

test('signing code hashes are scoped to the token', () => {
  assert.notEqual(hashSigningCode('token-a', '123456', 'test-secret'), hashSigningCode('token-b', '123456', 'test-secret'));
  assert.notEqual(hashSigningCode('token-a', '123456', 'test-secret'), hashSigningCode('token-a', '123456', 'other-secret'));
});

test('consent browser sessions are HMAC-protected', () => {
  assert.notEqual(hashConsentSession('session-a', 'secret'), hashConsentSession('session-b', 'secret'));
  assert.notEqual(hashConsentSession('session-a', 'secret'), hashConsentSession('session-a', 'other-secret'));
});

test('signature submissions accept only bounded PNG data URLs', () => {
  const validPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
  assert.equal(isValidSignatureDataUrl(`data:image/png;base64,${validPng}`), true);
  const emptyPalettePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAFBMVEVLqIlVAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
  assert.equal(isValidSignatureDataUrl(`data:image/png;base64,${emptyPalettePng}`), false);
  assert.equal(isValidSignatureDataUrl('data:image/png;base64,iVBORw0KGgo='), false);
  assert.equal(isValidSignatureDataUrl('data:image/svg+xml;base64,AAAA'), false);
  assert.equal(isValidSignatureDataUrl('data:image/png;base64,AAAA', 10), false);
});

test('email hints mask most of the mailbox name', () => {
  assert.equal(maskEmail('ana@example.com'), 'a***@example.com');
  assert.equal(maskEmail('invalid'), '');
});

test('consent email MIME uses the authenticated mailbox and inline signature', () => {
  const raw = buildConsentGmailRaw({
    fromEmail: 'dra@clinic.example',
    fromName: 'Clínica BIOSKIN · Dra. Ana',
    to: 'paciente@example.com',
    subject: 'Código para firmar',
    text: 'Código 123456',
    html: '<p>Código 123456</p><img src="cid:patient-signature">',
    signaturePngBase64: 'aW1hZ2U=',
    professionalSignaturePngBase64: 'c2lnbmF0dXJl',
  });
  const message = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(message, /From: =\?UTF-8\?B\?.*<dra@clinic\.example>/);
  assert.match(message, /Content-Type: multipart\/related/);
  assert.match(message, /Content-Type: multipart\/alternative/);
  assert.match(message, /Content-ID: <patient-signature>/);
  assert.match(message, /Content-ID: <professional-signature>/);
  assert.doesNotMatch(message, /bolt2525@gmail\.com/);
  assert.throws(() => buildConsentGmailRaw({ fromEmail: 'bad\r\nBcc:x@y.com', to: 'a@b.com', subject: 'x', text: 'x', html: 'x' }), /Invalid Gmail/);
});