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
  /** Radio absoluto (alto de imagen) y escala de radio; dirección de flecha (vector unitario en alto de imagen). */
  rad?: number; rs?: number; vx?: number; vy?: number;
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
const ARROW_LIFT = 0.02;

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
    const radius = p.rad ?? pr.radius * fw * aspect * (p.rs ?? 1);
    const arrow = ARROW_LIFT * fh;
    a.set([p.x, p.y, radius, gain], i * 4);
    b.set([pr.bulge, pr.lift[0] * fh + (p.vx ?? 0) * arrow, pr.lift[1] * fh + (p.vy ?? 0) * arrow, pr.smooth], i * 4);
    c.set([pr.glow, 0, 0, 0], i * 4);
  });
  return { count: list.length, a, b, c };
}

// ── Elementos unificados (modelo 3D y foto) ───────────────────────────────
export type ViewKind = 'frontal' | 'izquierda' | 'derecha';
export type ElemKind = 'point' | 'line' | 'arrow' | 'free' | 'pattern' | 'circle' | 'rect';
export interface P2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Meta { mode: SimMode; dose: number; zone: string; product?: string }
export interface Elem extends Meta {
  id: string; kind: ElemKind; paths: P2[][];
  /** Semiejes (coordenadas normalizadas) para circle/rect */
  rx?: number; ry?: number;
}
/** Elemento dibujado directamente sobre una foto. */
export interface PhotoEl extends Meta { id: string; view: ViewKind; kind: ElemKind; pts: P2[] }

export const AUTO_ZONE = 'Auto';

/** Zona estimada por posición dentro del marco facial (referencial). */
export function inferZone(p: P2, frame: FaceFrame): string {
  const cx = (frame.left + frame.right) / 2, hw = Math.max((frame.right - frame.left) / 2, 0.01);
  const nx = Math.abs(p.x - cx) / hw, ny = (p.y - frame.top) / Math.max(frame.bottom - frame.top, 0.01);
  if (ny < 0.22) return nx > 0.8 ? 'Región temporal' : 'Frente';
  if (ny < 0.30) return nx < 0.18 ? 'Glabela' : nx > 0.6 ? 'Cola de ceja' : 'Frente';
  if (ny < 0.42) return nx > 0.75 ? 'Patas de gallo' : nx < 0.2 ? 'Dorso nasal' : 'Ojeras';
  if (ny < 0.62) return nx < 0.15 ? 'Dorso nasal' : nx > 0.45 ? 'Pómulos' : 'Surco nasogeniano';
  if (ny < 0.70) return nx > 0.6 ? 'Línea mandibular' : 'Mejillas';
  if (ny < 0.80) return nx < 0.3 ? 'Labios' : nx < 0.55 ? 'Surco marioneta' : 'Línea mandibular';
  if (ny < 0.92) return nx < 0.3 ? 'Mentón' : 'Línea mandibular';
  return 'Papada';
}

// ── Proyección modelo 3D → foto ───────────────────────────────────────────
const X_HALF = 1.1, Z_MIN = -1, Z_MAX = 1.6; // extensión del GLB base (male_head)
const Y_TOP = 1.9, Y_BOTTOM = -1;             // trazado-referencia-superior.json
const Y_SPAN = Y_TOP - Y_BOTTOM;

export const defaultFrame = (view: ViewKind): FaceFrame => (view === 'frontal'
  ? DEFAULT_FRAME
  : { top: 0.12, bottom: 0.88, left: 0.15, right: 0.85, axisTop: { x: 0.5, y: 0.12 }, axisBottom: { x: 0.5, y: 0.88 }, source: 'manual' });

export function projectModel(p: Vec3, view: ViewKind, frame: FaceFrame, flip: boolean): P2 | null {
  const y = frame.top + ((Y_TOP - p.y) / Y_SPAN) * (frame.bottom - frame.top);
  if (view === 'frontal') {
    if (p.z < -0.5) return null;
    const t = Math.max(-1.3, Math.min(1.3, (flip ? -p.x : p.x) / X_HALF));
    return { x: (frame.left + frame.right) / 2 + t * ((frame.right - frame.left) / 2), y };
  }
  const side = (view === 'derecha' ? 1 : -1) * (flip ? -1 : 1);
  if (p.x * side < -0.15) return null; // cara opuesta, no visible
  const t = Math.max(0, Math.min(1, (p.z - Z_MIN) / (Z_MAX - Z_MIN)));
  return { x: view === 'derecha' ? frame.left + t * (frame.right - frame.left) : frame.right - t * (frame.right - frame.left), y };
}

export interface Store3D {
  markers: { id?: string; position: Vec3 }[];
  lines: { id: string; points: Vec3[]; segments?: Vec3[][]; technique_preset?: string }[];
  shapes: { id: string; shapeType: 'circle' | 'rectangle'; center: Vec3; radius?: number; width?: number; height?: number }[];
  meta: Record<string, Meta>;
}

export const lineKind = (l: { points: Vec3[]; segments?: Vec3[][]; technique_preset?: string }): ElemKind =>
  l.technique_preset === 'Flecha' ? 'arrow' : l.segments?.length ? 'pattern' : l.points.length === 2 ? 'line' : 'free';

/** Convierte los trazos del visor 3D en elementos 2D para la vista activa. */
export function elemsFrom3D(st: Store3D, view: ViewKind, frame: FaceFrame, aspect: number, flip: boolean): Elem[] {
  const out: Elem[] = [];
  const proj = (pts: Vec3[]) => pts.map(p => projectModel(p, view, frame, flip)).filter((q): q is P2 => q !== null);
  const sy = (frame.bottom - frame.top) / Y_SPAN; // alto de imagen por unidad de modelo
  st.markers.forEach(m => {
    const meta = m.id ? st.meta[m.id] : undefined, q = proj([m.position])[0];
    if (meta && q) out.push({ ...meta, id: m.id!, kind: 'point', paths: [[q]] });
  });
  st.lines.forEach(l => {
    const meta = st.meta[l.id]; if (!meta) return;
    const kind = lineKind(l);
    const raw = kind === 'pattern' ? (l.segments ?? []) : [l.points];
    const paths = raw.map(proj).filter(p => p.length >= 2);
    if (paths.length) out.push({ ...meta, id: l.id, kind, paths });
  });
  st.shapes.forEach(sh => {
    const meta = st.meta[sh.id], c = proj([sh.center])[0]; if (!meta || !c) return;
    const circle = sh.shapeType === 'circle';
    const hy = circle ? (sh.radius ?? 0.1) * sy : ((sh.height ?? 0.2) / 2) * sy;
    const hx = (circle ? (sh.radius ?? 0.1) * sy : ((sh.width ?? 0.2) / 2) * sy) / aspect;
    out.push({ ...meta, id: sh.id, kind: circle ? 'circle' : 'rect', paths: [[c]], rx: hx, ry: hy });
  });
  return out;
}

export function elemsFromPhoto(list: PhotoEl[], aspect: number): Elem[] {
  return list.map(e => {
    const { pts, view: _v, ...rest } = e; void _v;
    if (e.kind === 'circle' || e.kind === 'rect') {
      const [a, b] = [pts[0], pts[1] ?? pts[0]];
      if (e.kind === 'circle') {
        const d = Math.hypot((b.x - a.x) * aspect, b.y - a.y);
        return { ...rest, paths: [[a]], rx: d / aspect, ry: d };
      }
      return { ...rest, paths: [[{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]], rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 };
    }
    return { ...rest, paths: [pts] };
  });
}

// ── Expansión de elementos a puntos de efecto ─────────────────────────────
const sampleDose = (dose: number, n: number) => Math.max(dose / Math.max(n, 1) * 2, 0.01);

function along(path: P2[], count: number, aspect: number): { x: number; y: number; dx: number; dy: number }[] {
  const seg: number[] = [0];
  for (let i = 1; i < path.length; i++) seg.push(seg[i - 1] + Math.hypot((path[i].x - path[i - 1].x) * aspect, path[i].y - path[i - 1].y));
  const L = seg[seg.length - 1];
  const res: { x: number; y: number; dx: number; dy: number }[] = [];
  for (let k = 0; k < count; k++) {
    const d = count === 1 ? L / 2 : (k / (count - 1)) * L;
    let i = 1; while (i < path.length - 1 && seg[i] < d) i++;
    const a = path[i - 1], b = path[i], span = seg[i] - seg[i - 1] || 1, t = Math.min(1, Math.max(0, (d - seg[i - 1]) / span));
    const dx = (b.x - a.x) * aspect, dy = b.y - a.y, n = Math.hypot(dx, dy) || 1;
    res.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: dx / n, dy: dy / n });
  }
  return res;
}
const pathLen = (p: P2[], aspect: number) => p.slice(1).reduce((s, q, i) => s + Math.hypot((q.x - p[i].x) * aspect, q.y - p[i].y), 0);

export function expandElems(elems: Elem[], frame: FaceFrame, aspect: number): { points: SimPoint[]; derived: SimPoint[] } {
  const fh = Math.max(frame.bottom - frame.top, 0.05);
  const zoneAt = (e: Elem, p: P2) => (e.zone === AUTO_ZONE || !e.zone ? inferZone(p, frame) : e.zone);
  const points: SimPoint[] = [], derived: SimPoint[] = [];
  const base = (e: Elem, p: P2, extra: Partial<SimPoint>): SimPoint =>
    ({ id: `${e.id}:${derived.length}`, mode: e.mode, x: p.x, y: p.y, dose: e.dose, zone: zoneAt(e, p), product: e.product, ...extra });
  const areaElems = elems.filter(e => e.kind !== 'point');
  const share = Math.max(4, Math.floor(Math.max(MAX_EFFECTS - elems.filter(e => e.kind === 'point').length, 8) / Math.max(areaElems.length, 1)));

  elems.forEach(e => {
    if (e.kind === 'point') {
      const p = e.paths[0]?.[0]; if (p) points.push({ id: e.id, mode: e.mode, x: p.x, y: p.y, dose: e.dose, zone: zoneAt(e, p), product: e.product });
      return;
    }
    const mine: SimPoint[] = [];
    if (e.kind === 'circle' || e.kind === 'rect') {
      const c = e.paths[0][0], rx = e.rx ?? 0.05, ry = e.ry ?? 0.05;
      const cell = Math.max(ry / 2.5, fh * 0.04), n = Math.min(5, Math.max(1, Math.ceil((2 * ry) / cell)));
      const nx = Math.min(5, Math.max(1, Math.ceil((2 * rx * aspect) / cell)));
      for (let i = 0; i < nx; i++) for (let j = 0; j < n; j++) {
        const u = -1 + (2 * i + 1) / nx, v = -1 + (2 * j + 1) / n;
        if (e.kind === 'circle' && u * u + v * v > 1.2) continue;
        mine.push(base(e, { x: c.x + u * rx, y: c.y + v * ry }, { rad: Math.max(Math.min(rx * aspect / nx, ry / n) * 1.6, fh * 0.03) }));
      }
    } else {
      const step = fh * 0.05;
      const paths = e.kind === 'arrow' ? [e.paths[0]] : e.paths;
      paths.forEach(path => {
        const cnt = Math.max(2, Math.ceil(pathLen(path, aspect) / step));
        along(path, cnt, aspect).forEach(s => mine.push(base(e, s, { rs: 0.6, ...(e.kind === 'arrow' ? { vx: s.dx, vy: s.dy } : {}) })));
      });
    }
    const stride = Math.max(1, Math.ceil(mine.length / share));
    const kept = mine.filter((_, i) => i % stride === 0).slice(0, share);
    kept.forEach(p => { p.dose = sampleDose(e.dose, kept.length); });
    derived.push(...kept);
  });
  return { points, derived };
}

// ── Importar registro de Inyectables al almacén 3D ────────────────────────
const toMode = (productType?: string, subtype?: string): SimMode =>
  productType === 'toxina' ? 'toxina'
    : subtype === 'bioestimulador' ? 'bioestimulador'
      : subtype === 'hidratacion' ? 'hidratacion' : 'relleno_ha';

type Json = Record<string, unknown>;
const isVec = (p: unknown): p is Vec3 => !!p && typeof p === 'object'
  && ['x', 'y', 'z'].every(k => Number.isFinite((p as Json)[k]));

/**
 * Acepta el registro de inyectable completo ({product_type, relleno_subtype, mapping_data})
 * o solo su mapping_data (array de puntos o {injectionPoints, freehandLines, surfaceShapes}).
 */
export function importInjectable(raw: unknown, knownZones: string[]): Store3D & { markersFull: Json[] } {
  const rec = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Json | Json[] | null;
  const empty = { markers: [], lines: [], shapes: [], meta: {}, markersFull: [] };
  if (!rec || typeof rec !== 'object') return empty;
  const holder = Array.isArray(rec) ? ({} as Json) : rec;
  let mapping = (Array.isArray(rec) ? rec : holder.mapping_data ?? rec) as unknown;
  if (typeof mapping === 'string') mapping = JSON.parse(mapping);
  const m = (Array.isArray(mapping) ? { injectionPoints: mapping } : mapping) as Json;
  const mode = toMode(holder.product_type as string, holder.relleno_subtype as string);
  const product = typeof holder.product_name === 'string' ? holder.product_name : undefined;
  const stamp = Date.now(), res = { ...empty, markers: [] as Store3D['markers'], lines: [] as Store3D['lines'], shapes: [] as Store3D['shapes'], meta: {} as Store3D['meta'], markersFull: [] as Json[] };
  const zoneOf = (label: unknown) => {
    const z = typeof label === 'string' ? label : '';
    return knownZones.find(k => k.toLowerCase() === z.toLowerCase()) ?? AUTO_ZONE;
  };
  const dose = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : SIM_MODES[mode].defaultDose);
  ((m.injectionPoints as Json[]) ?? []).forEach((p, i) => {
    if (!isVec(p.position)) return;
    const id = `imp-${stamp}-p${i}`;
    res.markersFull.push({ ...p, id, type: 'Puntual', pathologyId: p.pathologyId ?? 'filler', zone: p.zone ?? '',
      rotation: p.rotation ?? [0, 0, 0], normal: isVec(p.normal) ? p.normal : { x: 0, y: 0, z: 1 } });
    res.markers.push({ id, position: p.position });
    res.meta[id] = { mode, dose: dose(p.units), zone: zoneOf(p.label || p.zone), product };
  });
  ((m.freehandLines as Json[]) ?? []).forEach((l, i) => {
    if (!Array.isArray(l.points) || !l.points.every(isVec)) return;
    const id = `imp-${stamp}-l${i}`;
    res.lines.push({ ...(l as unknown as Store3D['lines'][number]), id });
    res.meta[id] = { mode, dose: dose(l.units), zone: AUTO_ZONE, product };
  });
  ((m.surfaceShapes as Json[]) ?? []).forEach((sh, i) => {
    if (!isVec(sh.center)) return;
    const id = `imp-${stamp}-s${i}`;
    res.shapes.push({ ...(sh as unknown as Store3D['shapes'][number]), id });
    res.meta[id] = { mode, dose: dose(sh.units), zone: AUTO_ZONE, product };
  });
  return res;
}
