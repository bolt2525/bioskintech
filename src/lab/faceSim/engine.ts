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
  /** Contorno facial detectado; permite adaptar el ancho de la proyección a cada altura. */
  outline?: P2[];
  /** Anclajes faciales MediaPipe: frente, glabela, ojos, nariz, labio y mentón. */
  anchors?: P2[];
  source: 'landmarks' | 'manual';
}

export const DEFAULT_FRAME: FaceFrame = {
  top: 0.15, bottom: 0.85, left: 0.27, right: 0.73,
  axisTop: { x: 0.5, y: 0.15 }, axisBottom: { x: 0.5, y: 0.85 }, source: 'manual',
};

const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
export const REGISTRATION_ANCHORS = [
  'Centro de la frente', 'Glabela', 'Ojo lado A', 'Ojo lado B',
  'Punta nasal', 'Centro del labio superior', 'Mentón',
  'Cola de ceja A', 'Cola de ceja B', 'Centro de ceja A', 'Centro de ceja B',
];
/** Índices MediaPipe por anclaje; los grupos se promedian (cejas: borde superior + inferior). */
const LANDMARK_ANCHORS = [[10], [9], [33], [263], [1], [13], [152], [70, 46], [300, 276], [105, 52], [334, 282]];
/** Anclajes para calibración manual (clics en el modelo). */
export const registrationAnchorIndices = (view: ViewKind) =>
  view === 'frontal' ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 4, 5, 6];
/** La alineación automática suma las cejas en frontal: su altura varía mucho entre pacientes. */
const autoAnchorIndices = (view: ViewKind) =>
  view === 'frontal' ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : registrationAnchorIndices(view);
/**
 * Mismos anclajes sobre male_head.glb normalizado (raycast de la malla; cejas según trazado-referencia-superior.json).
 * El lado A es el derecho del paciente (izquierda de la imagen).
 */
export const MODEL_REGISTRATION_ANCHORS: Vec3[] = [
  { x: 0, y: 1.65, z: 1.44 }, { x: 0, y: 0.9, z: 1.58 }, { x: -0.71, y: 0.8, z: 1.17 }, { x: 0.72, y: 0.8, z: 1.17 },
  { x: 0, y: 0.25, z: 1.9 }, { x: 0, y: -0.2, z: 1.66 }, { x: 0, y: -1, z: 1.42 },
  { x: -0.72, y: 0.97, z: 1.36 }, { x: 0.73, y: 0.96, z: 1.35 }, { x: -0.5, y: 1.15, z: 1.52 }, { x: 0.5, y: 1.15, z: 1.51 },
];

/**
 * rmse/maxError: validación cruzada del ajuste afín global (fracción del alto facial). Con la corrección local RBF
 * los anclajes coinciden exactamente, así que estos límites solo descartan poses o detecciones incompatibles.
 */
export const REGISTRATION_LIMITS = { rmse: 0.1, maxError: 0.2 };
export const isRegistrationAccepted = (r: AffineRegistration | null): r is AffineRegistration =>
  !!r && r.rmse <= REGISTRATION_LIMITS.rmse && r.maxError <= REGISTRATION_LIMITS.maxError;

/** Alinea automáticamente el modelo genérico con los landmarks detectados; null si no hay landmarks, el orden anatómico falla o el ajuste no es válido. */
export function autoRegistration(view: ViewKind, frame: FaceFrame, aspect: number, flip: boolean): AffineRegistration | null {
  const anchors = frame.anchors;
  if (!anchors) return null;
  // frente → glabela → punta nasal → labio → mentón deben descender a lo largo del eje facial.
  const axis = { x: (frame.axisBottom.x - frame.axisTop.x) * aspect, y: frame.axisBottom.y - frame.axisTop.y };
  const along = [0, 1, 4, 5, 6].map(index => anchors[index].x * aspect * axis.x + anchors[index].y * axis.y);
  if (along.some((value, i) => i > 0 && value <= along[i - 1])) return null;
  const indices = autoAnchorIndices(view);
  const source = indices.map(index => projectModel(MODEL_REGISTRATION_ANCHORS[index], view, frame, flip, aspect)
    ?? { x: Number.NaN, y: Number.NaN });
  return fitAffineRegistration(source, indices.map(index => anchors[index]), aspect, frame.bottom - frame.top);
}

/** Landmarks de MediaPipe Face Mesh → marco facial y contorno completo. */
export function frameFromLandmarks(lm: { x: number; y: number }[]): FaceFrame {
  if (lm.length <= Math.max(...FACE_OVAL)) throw new Error('Landmarks faciales incompletos.');
  const g = (i: number) => {
    const point = lm[i];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      // Fotos recortadas (frente/mentón en el borde): MediaPipe extrapola landmarks fuera del encuadre.
      || point.x < -0.5 || point.x > 1.5 || point.y < -0.5 || point.y > 1.5) {
      throw new Error('Landmarks faciales fuera de rango.');
    }
    return { x: point.x, y: point.y };
  };
  const top = g(10), chin = g(152), l = g(234), r = g(454), glab = g(9);
  const outline = FACE_OVAL.map(g);
  const anchors = LANDMARK_ANCHORS.map(group => {
    const points = group.map(g);
    return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
  });
  const outlineArea = Math.abs(outline.reduce((area, point, index) => {
    const next = outline[(index + 1) % outline.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  if (chin.y - top.y < 0.15 || Math.abs(l.x - r.x) < 0.08 || outlineArea < 0.01) {
    throw new Error('Geometría facial no válida.');
  }
  return {
    top: Math.min(top.y, chin.y), bottom: Math.max(top.y, chin.y),
    left: Math.min(l.x, r.x), right: Math.max(l.x, r.x),
    axisTop: glab, axisBottom: chin, outline, anchors, source: 'landmarks',
  };
}

export interface AffineRegistration {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
  rmse: number; maxError: number;
  /** Corrección thin-plate spline sobre la afín: centros en coordenadas modelo-proyectadas y pesos de desplazamiento. */
  warp?: { centers: P2[]; weights: P2[]; scale: number; aspect: number };
}

/** Corrige una referencia fotográfica sin aceptar proyecciones incompatibles ni perder la calibración del modelo. */
export function updateRegistrationAnchor(
  view: ViewKind, frame: FaceFrame, aspect: number, flip: boolean, index: number, point: P2, modelAnchors?: Vec3[],
): { frame: FaceFrame; registration: AffineRegistration } | null {
  if (!frame.anchors || !Number.isInteger(index) || index < 0 || index >= frame.anchors.length
    || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !isWithinFace(point, frame)) return null;
  const next = {
    ...frame, anchors: frame.anchors.map((anchor, i) => i === index ? point : anchor),
    axisTop: index === 1 ? point : frame.axisTop,
    axisBottom: index === 6 ? point : frame.axisBottom,
  };
  const indices = registrationAnchorIndices(view);
  if (modelAnchors && modelAnchors.length !== indices.length) return null;
  const registration = modelAnchors
    ? fitAffineRegistration(
      modelAnchors.map(p => projectModel(p, view, next, flip, aspect) ?? { x: Number.NaN, y: Number.NaN }),
      indices.map(i => next.anchors[i]), aspect, next.bottom - next.top,
    )
    : autoRegistration(view, next, aspect, flip);
  return isRegistrationAccepted(registration) ? { frame: next, registration } : null;
}

/** Ajusta modelo→foto por mínimos cuadrados; requiere referencias no colineales y mide residuos en alturas faciales. */
export function fitAffineRegistration(source: P2[], target: P2[], aspect: number, faceHeight: number): AffineRegistration | null {
  if (source.length < 5 || source.length !== target.length || !Number.isFinite(aspect) || aspect <= 0
    || !Number.isFinite(faceHeight) || faceHeight <= 0) return null;
  if ([...source, ...target].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const solve = (indices: number[]) => {
    const rows = indices.map(index => [source[index].x, source[index].y, 1]);
    const normal = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
      rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
    const fitAxis = (axis: 'x' | 'y') => {
      const matrix = normal.map((row, i) => [...row, rows.reduce((sum, p, j) => sum + p[i] * target[indices[j]][axis], 0)]);
      for (let col = 0; col < 3; col++) {
        let pivot = col;
        for (let row = col + 1; row < 3; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
        if (Math.abs(matrix[pivot][col]) < 1e-8) return null;
        [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
        const divisor = matrix[col][col];
        for (let j = col; j < 4; j++) matrix[col][j] /= divisor;
        for (let row = 0; row < 3; row++) {
          if (row === col) continue;
          const factor = matrix[row][col];
          for (let j = col; j < 4; j++) matrix[row][j] -= factor * matrix[col][j];
        }
      }
      return matrix.map(row => row[3]);
    };
    const x = fitAxis('x'), y = fitAxis('y');
    return x && y ? { x, y } : null;
  };
  const indices = source.map((_, index) => index);
  const fit = solve(indices);
  if (!fit) return null;
  const errors = indices.map(heldOut => {
    const validated = solve(indices.filter(index => index !== heldOut));
    if (!validated) return Number.POSITIVE_INFINITY;
    const p = source[heldOut], q = target[heldOut];
    return Math.hypot((validated.x[0] * p.x + validated.x[1] * p.y + validated.x[2] - q.x) * aspect,
      validated.y[0] * p.x + validated.y[1] * p.y + validated.y[2] - q.y) / faceHeight;
  });
  const { x, y } = fit;
  const determinant = x[0] * y[1] - x[1] * y[0];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.0025 || Math.abs(determinant) > 25
    || [...x, ...y].some(value => Math.abs(value) > 20) || errors.some(error => !Number.isFinite(error))) return null;
  const base = { a: x[0], b: x[1], c: x[2], d: y[0], e: y[1], f: y[2], rmse: 0, maxError: 0 };
  const n = source.length;
  const residuals = source.map((p, i) => {
    const mapped = applyRegistration(p, base);
    return { x: target[i].x - mapped.x, y: target[i].y - mapped.y };
  });
  // Thin-plate spline sobre el residuo afín: cada anclaje cae exactamente en su landmark con mínima curvatura.
  const scale = faceHeight;
  const matrix = Array.from({ length: n + 3 }, (_, i) => Array.from({ length: n + 3 }, (_, j) => {
    if (i < n && j < n) return tpsKernel(source[i], source[j], aspect, scale) + (i === j ? 1e-9 : 0);
    if (i < n) return [source[i].x, source[i].y, 1][j - n];
    if (j < n) return [source[j].x, source[j].y, 1][i - n];
    return 0;
  }));
  const solution = solveLinear(matrix, [...residuals, ...Array.from({ length: 3 }, () => ({ x: 0, y: 0 }))]);
  if (!solution) return null;
  const [ax, ay, a1] = solution.slice(n);
  const registration: AffineRegistration = {
    ...base,
    a: base.a + ax.x, b: base.b + ay.x, c: base.c + a1.x,
    d: base.d + ax.y, e: base.e + ay.y, f: base.f + a1.y,
    warp: { centers: source, weights: solution.slice(0, n), scale, aspect },
    rmse: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length),
    maxError: Math.max(...errors),
  };
  const xs = source.map(p => p.x), ys = source.map(p => p.y), h = 1e-4;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const p = { x: x0 + (x1 - x0) * (i / 8), y: y0 + (y1 - y0) * (j / 8) };
    const o = applyRegistration(p, registration), u = applyRegistration({ x: p.x + h, y: p.y }, registration), v = applyRegistration({ x: p.x, y: p.y + h }, registration);
    const jac = ((u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x)) / (h * h);
    if (jac * determinant < 0.15 * determinant * determinant) return null; // pliegue o compresión extrema
  }
  return registration;
}

/** Núcleo TPS U(r) = r² log r, con r medido en alturas faciales y corrigiendo el aspecto de la imagen. */
function tpsKernel(p: P2, q: P2, aspect: number, scale: number): number {
  const r2 = (((p.x - q.x) * aspect) ** 2 + (p.y - q.y) ** 2) / (scale * scale);
  return r2 < 1e-12 ? 0 : 0.5 * r2 * Math.log(r2);
}

/** Eliminación gaussiana con pivoteo para matrices pequeñas (N×N, columnas x/y simultáneas). */
function solveLinear(matrix: number[][], rhs: P2[]): P2[] | null {
  const n = matrix.length;
  const m = matrix.map((row, i) => [...row, rhs[i].x, rhs[i].y]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let j = col; j < n + 2; j++) m[row][j] -= factor * m[col][j];
    }
  }
  const out = m.map((row, i) => ({ x: row[n] / row[i], y: row[n + 1] / row[i] }));
  return out.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) ? out : null;
}

export function applyRegistration(point: P2, registration: AffineRegistration): P2 {
  const out = {
    x: registration.a * point.x + registration.b * point.y + registration.c,
    y: registration.d * point.x + registration.e * point.y + registration.f,
  };
  const warp = registration.warp;
  if (!warp) return out;
  warp.centers.forEach((center, i) => {
    const k = tpsKernel(point, center, warp.aspect, warp.scale);
    out.x += warp.weights[i].x * k;
    out.y += warp.weights[i].y * k;
  });
  return out;
}

export function isWithinFace(point: P2, frame: FaceFrame): boolean {
  if (point.x < frame.left || point.x > frame.right || point.y < frame.top || point.y > frame.bottom) return false;
  const outline = frame.outline;
  if (!outline?.length) return true;
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
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

export function projectModel(
  p: Vec3, view: ViewKind, frame: FaceFrame, flip: boolean, aspect = 1, registration?: AffineRegistration,
): P2 | null {
  const yRatio = (Y_TOP - p.y) / Y_SPAN;
  const y = frame.top + yRatio * (frame.bottom - frame.top);
  const map = (point: P2): P2 | null => {
    const result = registration ? applyRegistration(point, registration) : point;
    return registration && !isWithinFace(result, frame) ? null : result;
  };
  if (view === 'frontal') {
    if (p.z < -0.5) return null;
    const side = Math.max(-1.3, Math.min(1.3, (flip ? -p.x : p.x) / X_HALF));
    const rowY = frame.top + Math.min(1, Math.max(0, yRatio)) * (frame.bottom - frame.top);
    const crossings: number[] = [];
    frame.outline?.forEach((a, i, outline) => {
      const b = outline[(i + 1) % outline.length];
      if ((a.y <= rowY && b.y > rowY) || (b.y <= rowY && a.y > rowY)) {
        crossings.push(a.x + ((rowY - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    });
    const halfWidth = crossings.length >= 2
      ? (Math.max(...crossings) - Math.min(...crossings)) / 2
      : (frame.right - frame.left) / 2;
    const axisStart = (frame.axisTop.y - frame.top) / Math.max(frame.bottom - frame.top, 0.05);
    const axisSpan = Math.max(1 - axisStart, 0.05);
    const centerX = frame.axisTop.x + ((yRatio - axisStart) / axisSpan) * (frame.axisBottom.x - frame.axisTop.x);
    const dx = (frame.axisBottom.x - frame.axisTop.x);
    const dy = (frame.axisBottom.y - frame.axisTop.y);
    const physicalDx = dx * aspect;
    const axisLength = Math.hypot(physicalDx, dy) || 1;
    const normalX = dy / axisLength;
    const normalY = -physicalDx / axisLength;
    const centerY = frame.top + yRatio * (frame.bottom - frame.top);
    const offset = side * halfWidth;
    return map({
      x: centerX + offset * normalX,
      y: centerY + offset * aspect * normalY,
    });
  }
  const side = (view === 'derecha' ? 1 : -1) * (flip ? -1 : 1);
  if (p.x * side < -0.15) return null; // cara opuesta, no visible
  const t = Math.max(0, Math.min(1, (p.z - Z_MIN) / (Z_MAX - Z_MIN)));
  return map({ x: view === 'derecha' ? frame.left + t * (frame.right - frame.left) : frame.right - t * (frame.right - frame.left), y });
}

export interface Store3D {
  markers: { id?: string; position: Vec3 }[];
  lines: { id: string; points: Vec3[]; segments?: Vec3[][]; technique_preset?: string }[];
  shapes: { id: string; shapeType: 'circle' | 'rectangle'; center: Vec3; radius?: number; width?: number; height?: number }[];
  meta: Record<string, Meta>;
}

export const lineKind = (l: { points: Vec3[]; segments?: Vec3[][]; technique_preset?: string }): ElemKind =>
  l.technique_preset === 'Flecha' ? 'arrow' : l.segments?.length ? 'pattern' : l.points.length === 2 ? 'line' : 'free';

// ── Superficie 3D personal (landmarks MediaPipe + foto como textura) ───────
/** Escala modelo→foto de la superficie personal: proyección ortográfica exacta de cada vértice a su landmark. */
export interface PersonalProjection { cx: number; cy: number; k: number; aspect: number }
export interface PersonalSurface {
  positions: Float32Array; uvs: Float32Array; indices: Uint32Array; projection: PersonalProjection;
}
/** El visor normaliza la malla a 5 unidades de dimensión máxima; generarla ya normalizada deja su transformación en identidad. */
const VIEWER_MAX_DIM = 5;

/** Triángulos de la teselación MediaPipe: viene como tríos de aristas cerradas (a→b, b→c, c→a); se descartan tríos inválidos. */
export function trianglesFromEdges(edges: { start: number; end: number }[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < edges.length; i += 3) {
    const [a, b, c] = [edges[i], edges[i + 1], edges[i + 2]];
    if (a.end === b.start && b.end === c.start && c.end === a.start && new Set([a.start, b.start, c.start]).size === 3) {
      out.push(a.start, b.start, c.start);
    }
  }
  return out;
}

/**
 * Malla personal desde landmarks normalizados (x,y en foto; z de MediaPipe en escala de ancho de imagen).
 * UV = posición del landmark en la foto, así cada punto marcado en 3D cae exactamente sobre la piel fotografiada.
 * `depth` exagera o suaviza el relieve estimado (idea de «intensidad de profundidad» del conversor 2D→3D).
 */
export function buildPersonalSurface(
  lm: { x: number; y: number; z?: number }[], aspect: number, triangles: number[], depth = 1,
): PersonalSurface | null {
  if (lm.length < 468 || !(aspect > 0) || !Number.isFinite(depth) || depth <= 0 || triangles.length < 3) return null;
  if (lm.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.z !== undefined && !Number.isFinite(p.z)))) return null;
  if (triangles.some(i => !Number.isInteger(i) || i < 0 || i >= lm.length)) return null;
  const raw = lm.map(p => ({ x: p.x * aspect, y: -p.y, z: -(p.z ?? 0) * aspect * depth }));
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  raw.forEach(p => (['x', 'y', 'z'] as const).forEach(a => { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }));
  const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  if (!(span > 0)) return null;
  const k = VIEWER_MAX_DIM / span;
  const c = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const positions = new Float32Array(lm.length * 3), uvs = new Float32Array(lm.length * 2);
  raw.forEach((p, i) => {
    positions.set([(p.x - c.x) * k, (p.y - c.y) * k, (p.z - c.z) * k], i * 3);
    uvs.set([lm[i].x, lm[i].y], i * 2);
  });
  // X = (x·aspect − c.x)·k ; Y = (−y − c.y)·k  →  x = (X/k + c.x)/aspect ; y = −(Y/k + c.y)
  return { positions, uvs, indices: Uint32Array.from(triangles), projection: { cx: c.x, cy: c.y, k, aspect } };
}

export const projectPersonal = (p: Vec3, m: PersonalProjection): P2 =>
  ({ x: (p.x / m.k + m.cx) / m.aspect, y: -(p.y / m.k + m.cy) });

/** Convierte los trazos del visor 3D en elementos 2D para la vista activa. */
export function elemsFrom3D(
  st: Store3D, view: ViewKind, frame: FaceFrame, aspect: number, flip: boolean, registration?: AffineRegistration,
  personal?: PersonalProjection,
): Elem[] {
  const out: Elem[] = [];
  const project = (p: Vec3) => personal ? projectPersonal(p, personal) : projectModel(p, view, frame, flip, aspect, registration);
  const proj = (pts: Vec3[]) => pts.map(project).filter((q): q is P2 => q !== null);
  const projectPaths = (pts: Vec3[]) => {
    const paths: P2[][] = [];
    let current: P2[] = [];
    pts.forEach(point => {
      const projected = project(point);
      if (projected) current.push(projected);
      else {
        if (current.length >= 2) paths.push(current);
        current = [];
      }
    });
    if (current.length >= 2) paths.push(current);
    return paths;
  };
  const sy = personal ? 1 / personal.k : (frame.bottom - frame.top) / Y_SPAN; // alto de imagen por unidad de modelo
  st.markers.forEach(m => {
    const meta = m.id ? st.meta[m.id] : undefined, q = proj([m.position])[0];
    if (meta && q) out.push({ ...meta, id: m.id!, kind: 'point', paths: [[q]] });
  });
  st.lines.forEach(l => {
    const meta = st.meta[l.id]; if (!meta) return;
    const kind = lineKind(l);
    const raw = kind === 'pattern' ? (l.segments ?? []) : [l.points];
    const paths = raw.flatMap(projectPaths);
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
