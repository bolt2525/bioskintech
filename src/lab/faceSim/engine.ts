/**
 * Motor puro (sin DOM) del simulador facial del Laboratorio 3D.
 * Coordenadas de punto: normalizadas 0..1 sobre la foto (x→derecha, y→abajo).
 */
export type SimMode = 'toxina' | 'relleno_ha' | 'hidratacion' | 'bioestimulador';

export const SIM_MODES: Record<SimMode, { label: string; unit: string; defaultDose: number; ref: number; color: string; catalog: string }> = {
  toxina: { label: 'Toxina', unit: 'U', defaultDose: 4, ref: 4, color: '#f59e0b', catalog: 'marca_toxina' },
  relleno_ha: { label: 'Relleno HA', unit: 'ml', defaultDose: 0.2, ref: 0.5, color: '#a855f7', catalog: 'marca_relleno_ha' },
  hidratacion: { label: 'Hidratación', unit: 'ml', defaultDose: 0.1, ref: 0.4, color: '#0ea5e9', catalog: 'marca_hidratacion' },
  bioestimulador: { label: 'Bioestimulador', unit: 'ml', defaultDose: 0.3, ref: 0.7, color: '#10b981', catalog: 'marca_bioestimulador' },
};

export interface SimPoint {
  id: string;
  mode: SimMode;
  x: number;
  y: number;
  dose: number;
  zone: string;
  product?: string;
}

export interface FaceFrame {
  /** Caja del rostro y eje de simetría, en coordenadas normalizadas de la foto. */
  top: number; bottom: number; left: number; right: number;
  axisTop: { x: number; y: number }; axisBottom: { x: number; y: number };
  source: 'landmarks' | 'manual';
}

export const DEFAULT_FRAME: FaceFrame = {
  top: 0.15, bottom: 0.85, left: 0.27, right: 0.73,
  axisTop: { x: 0.5, y: 0.15 }, axisBottom: { x: 0.5, y: 0.85 }, source: 'manual',
};

/** Landmarks de MediaPipe Face Mesh → marco facial. */
export function frameFromLandmarks(lm: { x: number; y: number }[]): FaceFrame {
  const g = (i: number) => ({ x: lm[i].x, y: lm[i].y });
  const top = g(10), chin = g(152), l = g(234), r = g(454), glab = g(168);
  return {
    top: top.y, bottom: chin.y, left: Math.min(l.x, r.x), right: Math.max(l.x, r.x),
    axisTop: glab, axisBottom: chin, source: 'landmarks',
  };
}

/** Intensidad con saturación (ley de rendimientos decrecientes) 0..1. */
export const doseGain = (mode: SimMode, dose: number) =>
  1 - Math.exp(-Math.max(0, dose) / SIM_MODES[mode].ref);

// ── Estimación robusta / corrección de errores de marcación ───────────────
export interface CorrectionOptions {
  enabled: boolean;
  linear: boolean;
  mirror: boolean;
  /** Tolerancia (fracción de la altura del rostro). Más allá, el punto se simula tal cual. */
  tolerance: number;
  aspect: number; // ancho/alto de la foto
  frame: FaceFrame;
}

export interface CorrectedPoint extends SimPoint {
  rawX: number; rawY: number;
  corrected: 'linear' | 'mirror' | 'both' | null;
  shift: number;
}

const ROW_ZONES = /frente|glabela|entrecejo|mandibular|ceja|c[oó]digo/i;
/** Peso biponderado de Tukey: 1 en r=0, 0 en r≥c. Redescendente → los atípicos no se tocan. */
const tukey = (r: number, c: number) => (r >= c ? 0 : (1 - (r / c) ** 2) ** 2);

/** Recta y = a + b·x por mínimos cuadrados reponderados iterativamente (Tukey). */
export function robustLine(pts: { x: number; y: number }[], c: number): { a: number; b: number } {
  let a = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let b = 0;
  for (let it = 0; it < 12; it++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(p => {
      const w = Math.max(tukey(Math.abs(p.y - (a + b * p.x)), c * 2), 1e-3);
      sw += w; sx += w * p.x; sy += w * p.y; sxx += w * p.x * p.x; sxy += w * p.x * p.y;
    });
    const den = sw * sxx - sx * sx;
    if (Math.abs(den) < 1e-12) break;
    b = (sw * sxy - sx * sy) / den;
    a = (sy - b * sx) / sw;
  }
  return { a, b };
}

export function correctPoints(points: SimPoint[], opt: CorrectionOptions): CorrectedPoint[] {
  const A = opt.aspect;
  const out: CorrectedPoint[] = points.map(p => ({ ...p, rawX: p.x, rawY: p.y, corrected: null, shift: 0 }));
  if (!opt.enabled) return out;
  const tol = opt.tolerance;
  // Trabajamos en unidades de altura: X = x·aspecto, Y = y
  const X = (p: CorrectedPoint) => p.x * A;
  const mark = (p: CorrectedPoint, kind: 'linear' | 'mirror') => {
    p.corrected = p.corrected && p.corrected !== kind ? 'both' : kind;
  };

  if (opt.linear) {
    const groups = new Map<string, CorrectedPoint[]>();
    out.filter(p => ROW_ZONES.test(p.zone)).forEach(p => {
      const key = `${p.mode}|${p.zone}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    });
    groups.forEach(list => {
      // Agrupar en filas por Y (hueco > 2·tol separa filas)
      const sorted = [...list].sort((p, q) => p.y - q.y);
      const rows: CorrectedPoint[][] = [];
      sorted.forEach(p => {
        const row = rows.at(-1);
        if (row && p.y - row[row.length - 1].y <= tol * 2) row.push(p); else rows.push([p]);
      });
      rows.forEach(row => {
        if (row.length < 3) return;
        const { a, b } = robustLine(row.map(p => ({ x: X(p), y: p.y })), tol);
        row.forEach(p => {
          const ex = X(p);
          // Proyección ortogonal al ajuste
          const n2 = 1 + b * b;
          const t = (ex + b * (p.y - a)) / n2;
          const px = t, py = a + b * t;
          const r = Math.hypot(ex - px, p.y - py);
          const w = tukey(r, tol * 2);
          if (w <= 0.01) return;
          p.x = (ex + w * (px - ex)) / A;
          p.y += w * (py - p.y);
          mark(p, 'linear');
        });
      });
    });
  }

  if (opt.mirror) {
    const { axisTop: t, axisBottom: bt } = opt.frame;
    const ax = t.x * A, ay = t.y;
    let dx = bt.x * A - ax, dy = bt.y - ay;
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const side = (p: CorrectedPoint) => (X(p) - ax) * dy - (p.y - ay) * dx; // lado con signo
    const reflect = (p: CorrectedPoint) => {
      const vx = X(p) - ax, vy = p.y - ay;
      const k = vx * dx + vy * dy;
      return { x: 2 * (ax + k * dx) - X(p), y: 2 * (ay + k * dy) - p.y };
    };
    const used = new Set<string>();
    const snapshot = out.map(p => ({ ...p }));
    out.forEach((p, i) => {
      if (used.has(p.id) || Math.abs(side(p)) < tol * 0.5) return; // sobre la línea media
      const r = reflect(snapshot[i] as CorrectedPoint);
      let best = -1, bd = Infinity;
      out.forEach((q, j) => {
        if (j === i || used.has(q.id) || q.mode !== p.mode || q.zone !== p.zone || side(q) * side(p) >= 0) return;
        const d = Math.hypot(X(snapshot[j] as CorrectedPoint) - r.x, snapshot[j].y - r.y);
        if (d < bd) { bd = d; best = j; }
      });
      if (best < 0) return;
      const w = tukey(bd, tol * 3);
      if (w <= 0.01) return; // demasiado asimétrico: asimetría real, se simula como está
      const q = out[best];
      const rq = reflect(snapshot[best] as CorrectedPoint);
      // Estimador: media de la marca y del reflejo de su par, ponderada por Tukey
      const pxT = (X(snapshot[i] as CorrectedPoint) + rq.x) / 2, pyT = (snapshot[i].y + rq.y) / 2;
      const qxT = (X(snapshot[best] as CorrectedPoint) + r.x) / 2, qyT = (snapshot[best].y + r.y) / 2;
      p.x += w * (pxT / A - p.x); p.y += w * (pyT - p.y);
      q.x += w * (qxT / A - q.x); q.y += w * (qyT - q.y);
      mark(p, 'mirror'); mark(q, 'mirror');
      used.add(p.id); used.add(q.id);
    });
  }

  out.forEach(p => { p.shift = Math.hypot((p.x - p.rawX) * A, p.y - p.rawY); });
  return out;
}

// ── Efectos → uniformes del shader ────────────────────────────────────────
export const MAX_EFFECTS = 64;

interface Profile { radius: number; bulge: number; lift: [number, number]; smooth: number; glow: number }

/** Parámetros por modo y zona. radius = fracción del ancho del rostro; lift en unidades de alto de rostro. */
export function profileFor(mode: SimMode, zone: string, side: -1 | 0 | 1): Profile {
  const z = zone.toLowerCase();
  const out = side * 0.5; // sentido hacia fuera de la línea media
  if (mode === 'toxina') {
    const base: Profile = { radius: 0.12, bulge: 0, lift: [0, 0], smooth: 0.95, glow: 0.05 };
    if (/ceja|temporal/.test(z)) return { ...base, radius: 0.1, lift: [out * 0.004, -0.012] };
    if (/patas|gallo/.test(z)) return { ...base, radius: 0.08, lift: [out * 0.003, -0.005] };
    if (/frente|glabela|entrecejo/.test(z)) return { ...base, radius: 0.14 };
    if (/mentón|menton|comisura|marioneta|c[oó]digo/.test(z)) return { ...base, radius: 0.09, smooth: 0.8, lift: [0, -0.006] };
    return base;
  }
  if (mode === 'hidratacion') return { radius: 0.15, bulge: 0.02, lift: [0, 0], smooth: 0.6, glow: 1 };
  if (mode === 'bioestimulador') {
    const base: Profile = { radius: 0.2, bulge: 0.06, lift: [out * 0.02, -0.03], smooth: 0.45, glow: 0.5 };
    if (/mandibular/.test(z)) return { ...base, radius: 0.14, lift: [out * 0.02, -0.045] };
    return base;
  }
  // relleno HA
  if (/labio/.test(z)) return { radius: 0.07, bulge: 0.55, lift: [0, 0], smooth: 0.15, glow: 0.15 };
  if (/p[oó]mulo|malar/.test(z)) return { radius: 0.17, bulge: 0.3, lift: [out * 0.01, -0.03], smooth: 0.1, glow: 0.1 };
  if (/ment[oó]n/.test(z)) return { radius: 0.1, bulge: 0.35, lift: [0, 0.01], smooth: 0.1, glow: 0 };
  if (/mandibular/.test(z)) return { radius: 0.1, bulge: 0.2, lift: [out * 0.01, -0.012], smooth: 0.1, glow: 0 };
  if (/surco|marioneta|nasogen|ojera|l[aá]grima/.test(z)) return { radius: 0.07, bulge: 0.32, lift: [0, 0], smooth: 0.45, glow: 0.1 };
  if (/dorso|nasal/.test(z)) return { radius: 0.07, bulge: 0.2, lift: [0, -0.01], smooth: 0, glow: 0 };
  return { radius: 0.1, bulge: 0.28, lift: [0, 0], smooth: 0.2, glow: 0.05 };
}

/** Datos listos para subir al shader (vec4 × 3 por efecto). */
export interface EffectUniforms { count: number; a: Float32Array; b: Float32Array; c: Float32Array }

export function buildEffects(points: CorrectedPoint[], frame: FaceFrame, aspect: number, intensity: number): EffectUniforms {
  const list = points.slice(0, MAX_EFFECTS);
  const a = new Float32Array(MAX_EFFECTS * 4), b = new Float32Array(MAX_EFFECTS * 4), c = new Float32Array(MAX_EFFECTS * 4);
  const fw = Math.max(frame.right - frame.left, 0.05), fh = Math.max(frame.bottom - frame.top, 0.05);
  const midX = (frame.axisTop.x + frame.axisBottom.x) / 2;
  list.forEach((p, i) => {
    const side = Math.abs(p.x - midX) < 0.01 ? 0 : p.x > midX ? 1 : -1;
    const pr = profileFor(p.mode, p.zone, side as -1 | 0 | 1);
    const gain = doseGain(p.mode, p.dose) * intensity;
    // Radio en unidades de alto de imagen (el shader mide distancias con x·aspecto)
    const radius = pr.radius * fw * aspect;
    a.set([p.x, p.y, radius, gain], i * 4);
    b.set([pr.bulge, pr.lift[0] * fh, pr.lift[1] * fh, pr.smooth], i * 4);
    c.set([pr.glow, 0, 0, 0], i * 4);
  });
  return { count: list.length, a, b, c };
}

// ── Puente con la ficha clínica (pestaña Inyectables) ─────────────────────
const FORM_Y = { top: 1.9, bottom: -1 }; // trazado-referencia-superior.json (hairline → límite inferior)
const FORM_X_HALF = 1;

/** Convierte un punto del modelo GLB (x,y) al espacio de la foto usando el marco facial. */
export function modelToPhoto(pos: { x: number; y: number }, frame: FaceFrame, flipX: boolean): { x: number; y: number } {
  const tx = Math.max(-1.3, Math.min(1.3, (flipX ? -pos.x : pos.x) / FORM_X_HALF));
  const ty = (FORM_Y.top - pos.y) / (FORM_Y.top - FORM_Y.bottom);
  const cx = (frame.left + frame.right) / 2, hw = (frame.right - frame.left) / 2;
  return { x: cx + tx * hw, y: frame.top + ty * (frame.bottom - frame.top) };
}

const toMode = (productType?: string, subtype?: string): SimMode =>
  productType === 'toxina' ? 'toxina'
    : subtype === 'bioestimulador' ? 'bioestimulador'
      : subtype === 'hidratacion' ? 'hidratacion' : 'relleno_ha';

/**
 * Acepta un registro de inyectable completo ({product_type, relleno_subtype, mapping_data})
 * o solo su mapping_data (array de puntos o {injectionPoints}).
 */
export function importInjectable(raw: unknown, frame: FaceFrame, flipX: boolean): SimPoint[] {
  const rec = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!rec || typeof rec !== 'object') return [];
  const mappingRaw = Array.isArray(rec) ? rec : (rec.mapping_data ?? rec);
  const mapping = typeof mappingRaw === 'string' ? JSON.parse(mappingRaw) : mappingRaw;
  const pts: Record<string, any>[] =  // eslint-disable-line @typescript-eslint/no-explicit-any
     Array.isArray(mapping) ? mapping : Array.isArray(mapping?.injectionPoints) ? mapping.injectionPoints : [];
  const mode = toMode(rec.product_type, rec.relleno_subtype);
  return pts
    .filter(p => p?.position && Number.isFinite(p.position.x) && Number.isFinite(p.position.y))
    .map((p, i) => {
      const xy = modelToPhoto(p.position, frame, flipX);
      const dose = Number(p.units);
      return {
        id: `imp-${Date.now()}-${i}`,
        mode,
        x: xy.x, y: xy.y,
        dose: Number.isFinite(dose) && dose > 0 ? dose : SIM_MODES[mode].defaultDose,
        zone: String(p.label || p.zone || ''),
        product: rec.product_name,
      };
    });
}
