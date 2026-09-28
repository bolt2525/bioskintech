import { createHash, createHmac, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export function normalizeEcuadorIdentification(type, value) {
  if (type !== 'cedula' && type !== 'ruc') return null;
  const raw = String(value ?? '').trim();
  if (!/^[0-9.\s-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  const expectedLength = type === 'cedula' ? 10 : 13;
  return digits.length === expectedLength ? digits : null;
}

export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashConsentEvidence(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashSigningCode(token, code, secret) {
  if (!secret) throw new Error('Secret required to hash signing codes');
  return createHmac('sha256', secret).update(`${token}:${code}`).digest('hex');
}

export function hashConsentSession(session, secret) {
  if (!secret) throw new Error('Secret required to hash consent sessions');
  return createHmac('sha256', secret).update(`consent-session:${session}`).digest('hex');
}

export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '';
  return `${local[0]}${'*'.repeat(Math.min(Math.max(local.length, 3), 8))}@${domain}`;
}

export function isValidSignatureDataUrl(value, maxLength = 512_000) {
  if (typeof value !== 'string' || value.length > maxLength ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const png = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  let offset = 8;
  let hasHeader = false;
  let hasPalette = false;
  let hasImageData = false;
  let imageDataEnded = false;
  let width = 0;
  let height = 0;
  const imageData = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataEnd = offset + 8 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > png.length) return false;
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false;
    if (type === 'PLTE') {
      if (hasPalette || hasImageData || length === 0 || length > 768 || length % 3 !== 0) return false;
      hasPalette = true;
    }
    const expectedCrc = png.readUInt32BE(dataEnd);
    let crc = 0xffffffff;
    for (const byte of png.subarray(offset + 4, dataEnd)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) return false;
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 4_000_000 ||
          png[offset + 16] !== 8 || png[offset + 17] !== 6 || png[offset + 18] !== 0 ||
          png[offset + 19] !== 0 || png[offset + 20] !== 0) return false;
      hasHeader = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') {
      if (imageDataEnded) return false;
      hasImageData = true;
      imageData.push(png.subarray(offset + 8, dataEnd));
    } else if (hasImageData && type !== 'IEND') imageDataEnded = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasImageData || dataEnd + 4 !== png.length) return false;
      try {
        const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: 16_020_000 });
        const rowLength = width * 4 + 1;
        if (decoded.length !== rowLength * height) return false;
        for (let row = 0; row < height; row++) {
          if (decoded[row * rowLength] > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    offset = dataEnd + 4;
  }
  return false;
}

function base64Mime(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function encodeMimeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || '').replace(/[\r\n]/g, ' '), 'utf8').toString('base64')}?=`;
}

export function buildConsentGmailRaw({ fromEmail, fromName, to, subject, text, html, signaturePngBase64 }) {
  const validEmail = value => typeof value === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
  if (!validEmail(fromEmail) || !validEmail(to)) throw new Error('Invalid Gmail sender or recipient');
  const alternativeBoundary = `bioskin_alt_${randomBytes(12).toString('hex')}`;
  const relatedBoundary = `bioskin_rel_${randomBytes(12).toString('hex')}`;
  const hasSignature = typeof signaturePngBase64 === 'string' && signaturePngBase64.length > 0;
  const alternativeBody = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Mime(text),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Mime(html),
    `--${alternativeBoundary}--`,
  ].join('\r\n');
  const body = hasSignature ? [
      `--${relatedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      alternativeBody,
      `--${relatedBoundary}`,
      'Content-Type: image/png; name="firma-paciente.png"',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <patient-signature>',
      'Content-Disposition: inline; filename="firma-paciente.png"',
      '',
      signaturePngBase64.match(/.{1,76}/g)?.join('\r\n') || signaturePngBase64,
      `--${relatedBoundary}--`,
    ].join('\r\n') : alternativeBody;
  const topBoundary = hasSignature ? relatedBoundary : alternativeBoundary;
  const topType = hasSignature ? 'multipart/related' : 'multipart/alternative';
  const fromHeader = `${encodeMimeHeader(fromName || 'BIOSKIN')} <${fromEmail}>`;
  const raw = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${topType}; boundary="${topBoundary}"`,
    '',
    body,
  ].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64url');
}