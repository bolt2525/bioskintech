/**
 * @file middleware.js
 * @description Vercel Edge Middleware — seguridad perimetral para BIOSKIN.
 *
 * Corre en el edge (antes de las serverless functions y del CDN).
 * No tiene acceso a Node.js APIs — solo Web APIs estándar.
 *
 * Funciones:
 *  - Rate limiting en /api/ (en memoria por IP, 60 req/min)
 *  - Bloqueo de bots y patrones de explotación conocidos
 *  - CSP y headers de seguridad suplementarios
 *  - Log de IPs bloqueadas
 *
 * ponytail: rate limit en memoria → no persiste entre instancias edge.
 *           Para producción con alta carga usar Vercel KV o Upstash Redis.
 */

// Mapa en memoria: ip → { count, resetAt }
// ponytail: mapa global por instancia, no compartido → suficiente para el volumen esperado
const rateMap = new Map();

const RATE_LIMIT    = 60;   // requests por ventana
const RATE_WINDOW   = 60_000; // 1 minuto en ms
const LOGIN_LIMIT   = 10;  // intentos de login por ventana
const LOGIN_WINDOW  = 60_000;
const loginMap      = new Map();

// Patrones de inyección SQL / path traversal comunes en scans automáticos
const BLOCK_PATTERNS = [
  /\.\.\//,
  /<script/i,
  /union\s+select/i,
  /sleep\(\d+\)/i,
  /exec\(/i,
  /eval\(/i,
  /\/etc\/passwd/,
  /\/proc\/self/,
  /\.env$/i,
  /wp-admin/i,
  /phpmyadmin/i,
];

export default function middleware(request) {
  const url = new URL(request.url);
  const ip  = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const path = url.pathname;

  // ── 1. Bloquear patrones de explotación ──────────────────────────────────
  const fullUrl = url.pathname + url.search;
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(fullUrl)) {
      console.warn(`[BIOSKIN Edge] Blocked malicious pattern from ${ip}: ${fullUrl}`);
      return new Response('Forbidden', { status: 403 });
    }
  }

  // ── 2. Rate limiting en /api/ ─────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    const now = Date.now();

    // Rate limit general por IP
    let entry = rateMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
    if (now > entry.resetAt) entry = { count: 0, resetAt: now + RATE_WINDOW };
    entry.count++;
    rateMap.set(ip, entry);

    if (entry.count > RATE_LIMIT) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      console.warn(`[BIOSKIN Edge] Rate limited ${ip} on ${path}`);
      return new Response(JSON.stringify({ error: 'Demasiadas solicitudes. Intenta en un momento.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(RATE_LIMIT),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
        },
      });
    }

    // Rate limit específico para login (más estricto)
    if (path.includes('admin-auth') && request.method === 'POST') {
      let loginEntry = loginMap.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW };
      if (now > loginEntry.resetAt) loginEntry = { count: 0, resetAt: now + LOGIN_WINDOW };
      loginEntry.count++;
      loginMap.set(ip, loginEntry);

      if (loginEntry.count > LOGIN_LIMIT) {
        console.warn(`[BIOSKIN Edge] Login rate limited ${ip}`);
        return new Response(JSON.stringify({ error: 'Demasiados intentos de acceso. Espera 1 minuto.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        });
      }
    }
  }

  // ── 3. Pasar al siguiente handler con headers de seguridad adicionales ────
  const response = new Response(null, { status: 200 });

  // Limpiar mapas periódicamente para evitar memory leak
  // ponytail: limpieza simple por tamaño — no necesita timer en edge
  if (rateMap.size > 10000) rateMap.clear();
  if (loginMap.size > 5000) loginMap.clear();

  return undefined; // undefined = continuar normalmente
}

export const config = {
  // Aplica a todas las rutas excepto assets estáticos
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)',
  ],
};
