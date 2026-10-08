const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
const TURNSTILE_VERIFY_TIMEOUT_MS = 10_000;

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return Array.isArray(raw) ? raw[0] : String(raw).split(',')[0].trim();
}

function normalizeHostname(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function getTurnstileAllowedHosts() {
  const hosts = `${process.env.TURNSTILE_HOSTNAMES || ''},${process.env.APP_URL || ''}`
    .split(',')
    .map(normalizeHostname)
    .filter(Boolean);

  const normalized = new Set(hosts);
  if (process.env.NODE_ENV !== 'production') {
    normalized.add('localhost');
    normalized.add('127.0.0.1');
  }
  return [...normalized];
}

export async function verifyTurnstileToken(req, token, {
  action,
  context = 'turnstile',
  prompt = 'Confirma que no eres un robot.',
} = {}) {
  const secret = (process.env.TURNSTILE_SECRET || '').trim();
  if (!secret) {
    return process.env.NODE_ENV === 'production' || process.env.VERCEL
      ? { ok: false, status: 503, error: 'La verificación de seguridad no está disponible.' }
      : { ok: true };
  }

  if (!action) {
    throw new Error('Turnstile requiere una acción esperada');
  }

  if (typeof token !== 'string' || token.length > TURNSTILE_TOKEN_MAX_LENGTH || !token.trim()) {
    return { ok: false, status: 403, error: prompt };
  }

  const allowedHosts = getTurnstileAllowedHosts();
  if (process.env.NODE_ENV === 'production' && allowedHosts.length === 0) {
    return { ok: false, status: 503, error: 'La verificación de seguridad no está disponible.' };
  }

  let result;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TURNSTILE_VERIFY_TIMEOUT_MS),
      body: new URLSearchParams({
        secret,
        response: token.trim(),
        remoteip: getClientIp(req),
      }).toString(),
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    result = await response.json();
  } catch (error) {
    console.error(`[${context}] Turnstile Siteverify no disponible:`, error instanceof Error ? error.message : 'error desconocido');
    return { ok: false, status: 503, error: 'La verificación de seguridad falló. Inténtalo de nuevo.' };
  }

  const rejectedReason = !result?.success
    ? 'siteverify'
    : result.action !== action
      ? 'action'
      : !allowedHosts.includes(normalizeHostname(result.hostname))
        ? 'hostname'
        : '';
  if (rejectedReason) {
    console.warn(`[${context}] Turnstile rechazado: ${rejectedReason}`);
    return { ok: false, status: 403, error: 'La verificación anti-bot falló. Inténtalo de nuevo.' };
  }

  return { ok: true };
}
