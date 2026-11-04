import assert from 'node:assert/strict';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { buildGmailRaw } from '../lib/email-mime.js';
import { buildConsentGmailRaw } from '../lib/consent-signing.js';

const sender = { name: 'Estética Biológica', address: 'sender@example.test' };
const subject = 'Confirmación — información clínica 🧴';
const html = '<p>¡Hola José! Estética Biológica: sesión y atención.</p>';

function decodeWords(value) {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, encoding, data) =>
      encoding.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64').toString('utf8')
        : decodeQuotedPrintable(data.replace(/_/g, ' ')));
}

function decodeQuotedPrintable(value) {
  return Buffer.from(value.replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
}

function parseMime(wire) {
  const index = wire.indexOf('\r\n\r\n');
  assert.ok(index >= 0, 'MIME header/body separator');
  const headerBlock = wire.slice(0, index);
  const headers = Object.fromEntries(headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
    .map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
  const body = wire.slice(index + 4);
  const boundary = headers['content-type']?.match(/boundary="([^"]+)"/i)?.[1];
  if (boundary) {
    return {
      headers, headerBlock,
      parts: body.split(`--${boundary}`).slice(1, -1).map(part => parseMime(part.replace(/^\r\n/, ''))),
    };
  }
  const encoding = headers['content-transfer-encoding']?.toLowerCase();
  const decoded = encoding === 'base64' ? Buffer.from(body, 'base64').toString('utf8')
    : encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : body;
  return { headers, headerBlock, body: decoded, parts: [] };
}

function leaves(part) {
  return part.parts.length ? part.parts.flatMap(leaves) : [part];
}

test('regression: legacy UTF-8 From is mojibake even with correctly encoded subject/body', () => {
  const wire = Buffer.from(`From: ${sender.name} <${sender.address}>\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}`);
  const legacy = parseMime(wire.toString('latin1'));
  assert.equal(legacy.headers.from, 'EstÃ©tica BiolÃ³gica <sender@example.test>');
  assert.equal(decodeWords(legacy.headers.subject), subject);
  assert.equal(parseMime(wire.toString('utf8')).body, html);
});

test('real Nodemailer MIME round-trips sender, subject and HTML for Gmail raw', async () => {
  const raw = await buildGmailRaw({ from: sender, to: 'patient@example.test', subject, html });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  assert.equal(decodeWords(mime.headers.from), `${sender.name} <${sender.address}>`);
  assert.equal(decodeWords(mime.headers.subject), subject);
  assert.equal(mime.headers.to, 'patient@example.test');
  assert.match(mime.headers['content-type'], /text\/html; charset=utf-8/i);
  assert.match(mime.headers['content-transfer-encoding'], /quoted-printable|base64/);
  assert.equal(mime.body.trim(), html);
  assert.doesNotMatch(mime.headerBlock, /[^\x00-\x7f]/);
});

test('display names with commas, quotes and accents remain one authenticated mailbox', async () => {
  const name = 'Estética Biológica, "Cuenca"';
  const raw = await buildGmailRaw({ from: { ...sender, name }, to: 'patient@example.test', subject, html });
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  assert.equal(decodeWords(mime.headers.from), `${name} <${sender.address}>`);
  assert.equal((mime.headers.from.match(/<sender@example\.test>/g) || []).length, 1);
});

test('native MIME folds long Unicode names and subjects without losing characters', async () => {
  const name = 'Estética Biológica 🧴 '.repeat(15).trim();
  const longSubject = `${subject} `.repeat(20).trim();
  const raw = await buildGmailRaw({ from: { ...sender, name }, to: 'patient@example.test', subject: longSubject, html });
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  assert.equal(decodeWords(mime.headers.from), `${name} <${sender.address}>`);
  assert.equal(decodeWords(mime.headers.subject), longSubject);
  assert.ok(mime.headerBlock.split('\r\n').every(line => line.length <= 998));
  assert.ok([...mime.headerBlock.matchAll(/=\?UTF-8\?[BQ]\?[^?]*\?=/gi)].every(([word]) => word.length <= 75));
});

test('CSV attachment, accents and UTF-8 BOM survive real multipart MIME', async () => {
  const csv = '\uFEFFPaciente;Descripción;Total\r\nJosé;Sesión estética;115.00\r\n';
  const raw = await buildGmailRaw({
    from: sender, to: 'finance@example.test', subject, html,
    attachments: [{ filename: 'finanzas_2026-11.csv', content: csv, contentType: 'text/csv; charset=utf-8' }],
  });
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  const parts = leaves(mime);
  assert.match(mime.headers['content-type'], /multipart\/mixed/);
  assert.equal(parts.find(part => /text\/html/.test(part.headers['content-type'])).body.trim(), html);
  const attachment = parts.find(part => /text\/csv/.test(part.headers['content-type']));
  assert.match(attachment.headers['content-type'], /charset=utf-8/i);
  assert.match(attachment.headers['content-disposition'], /attachment; filename=finanzas_2026-11.csv/);
  assert.equal(attachment.body, csv);
});

test('consent MIME already encodes From and preserves both inline signatures', () => {
  const raw = buildConsentGmailRaw({
    fromEmail: sender.address, fromName: sender.name, to: 'patient@example.test', subject,
    text: 'Código para José: 123456', html,
    signaturePngBase64: Buffer.from('fake patient PNG').toString('base64'),
    professionalSignaturePngBase64: Buffer.from('fake professional PNG').toString('base64'),
  });
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  assert.equal(decodeWords(mime.headers.from), `${sender.name} <${sender.address}>`);
  assert.equal(decodeWords(mime.headers.subject), subject);
  const parts = leaves(mime);
  assert.equal(parts.find(part => /text\/plain/.test(part.headers['content-type'])).body, 'Código para José: 123456');
  assert.equal(parts.find(part => /text\/html/.test(part.headers['content-type'])).body, html);
  assert.equal(parts.find(part => part.headers['content-id'] === '<patient-signature>').body, 'fake patient PNG');
  assert.equal(parts.find(part => part.headers['content-id'] === '<professional-signature>').body, 'fake professional PNG');
});

test('SMTP paths use the same native encoder without a connection', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  for (const from of [sender, '"BIOSKIN Admin" <sender@example.test>', 'sender@example.test']) {
    const result = await transport.sendMail({ from, to: 'patient@example.test', subject, html });
    const mime = parseMime(result.message.toString('utf8'));
    assert.equal(decodeWords(mime.headers.subject), subject);
    assert.equal(mime.body.trim(), html);
    assert.doesNotMatch(mime.headerBlock, /[^\x00-\x7f]/);
  }
});

test('CRLF in display name/subject cannot inject extra MIME headers', async () => {
  const raw = await buildGmailRaw({
    from: { ...sender, name: 'Estética\r\nBcc: other@example.test' },
    to: 'patient@example.test', subject: 'Confirmación\r\nX-Injected: yes', html,
  });
  const mime = parseMime(Buffer.from(raw, 'base64url').toString('utf8'));
  assert.equal(mime.headers.bcc, undefined);
  assert.equal(mime.headers['x-injected'], undefined);
  assert.match(mime.headers.from, /<sender@example\.test>$/);
});

test('local composer refuses attachment file/URL access', async () => {
  for (const path of ['file:///not-a-real-file', 'https://example.test/not-a-real-resource']) {
    await assert.rejects(buildGmailRaw({
      from: sender, to: 'patient@example.test', subject, html,
      attachments: [{ filename: 'blocked.txt', path }],
    }), /access rejected/i);
  }
});
