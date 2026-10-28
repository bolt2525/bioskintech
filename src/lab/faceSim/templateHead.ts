import type { PersonalSurface } from './engine';
import { FACE_OVAL, type EstimatedHeadSurface } from './estimatedHead';
import type { HeadPhotoSource } from './multiViewHead';

/**
 * Cabeza a partir de una PLANTILLA genérica (cráneo, orejas y cuello) deformada
 * hacia los landmarks personales y ajustada a las siluetas de las fotos.
 * Sustituye la extrusión del óvalo: conserva una forma craneal anatómica en
 * vez de inflar o recortar planos. Sigue siendo una aproximación, no un escaneo.
 */
export interface HeadTemplate { landmarks: ArrayLike<number>; positions: ArrayLike<number>; triangles: ArrayLike<number> }
type V = [number, number, number];

const CONTROL = [...FACE_OVAL, 1, 2, 4, 6, 9, 151, 168, 199, 33, 133, 263, 362, 61, 291, 0, 17, 98, 327, 50, 280, 205, 425, 70, 300, 105, 334];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const at = (p: ArrayLike<number>, i: number): V => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
const fail = (reason: string): never => { throw new Error(`Cabeza ajustada: ${reason}`); };

/** Similaridad de Umeyama (sin reflexión) por iteración de potencia sobre la matriz cuaternión de Horn. */
function similarity(src: V[], dst: V[]) {
  const n = src.length, cs: V = [0, 0, 0], cd: V = [0, 0, 0];
  src.forEach((p, i) => { for (let k = 0; k < 3; k++) { cs[k] += p[k] / n; cd[k] += dst[i][k] / n; } });
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let vs = 0, vd = 0;
  src.forEach((p, i) => {
    const a = sub(p, cs), b = sub(dst[i], cd);
    vs += dot(a, a); vd += dot(b, b);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
  });
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const shift = Math.abs(xx) + Math.abs(yy) + Math.abs(zz) + Math.abs(xy) + Math.abs(xz) + Math.abs(yx) + Math.abs(yz) + Math.abs(zx) + Math.abs(zy);
  let q = [1, 0, 0, 0];
  for (let it = 0; it < 200; it++) {
    const next = N.map((row, r) => row.reduce((s, v, c) => s + (v + (r === c ? shift : 0)) * q[c], 0));
    const l = Math.hypot(...next);
    q = next.map(v => v / l);
  }
  const [w, x, y, z] = q;
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
  const s = Math.sqrt(vd / vs);
  const apply = (p: V): V => {
    const a = sub(p, cs);
    return [0, 1, 2].map(r => cd[r] + s * (R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2])) as V;
  };
  return { apply, R, s };
}

function weld(positions: ArrayLike<number>, triangles: ArrayLike<number>) {
  const map = new Map<string, number>(), rep: number[] = [], points: V[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const p = at(positions, i), key = p.map(v => Math.round(v * 1e4)).join(',');
    if (!map.has(key)) { map.set(key, points.length); points.push(p); }
    rep.push(map.get(key)!);
  }
  const tris: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const t = [rep[triangles[i]], rep[triangles[i + 1]], rep[triangles[i + 2]]];
    if (new Set(t).size === 3) tris.push(...t);
  }
  return { points, tris };
}

/** Bucles de frontera orientados; tolera vértices de pellizco eligiendo la continuación. */
function loops(tris: number[]): number[][] {
  const count = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = tris[i + j], b = tris[i + (j + 1) % 3], k = a < b ? `${a}:${b}` : `${b}:${a}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const next = new Map<number, number[]>();
  for (let i = 0; i < tris.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = tris[i + j], b = tris[i + (j + 1) % 3];
    if (count.get(a < b ? `${a}:${b}` : `${b}:${a}`) === 1) next.set(a, [...(next.get(a) ?? []), b]);
  }
  const out: number[][] = [];
  while (next.size) {
    const start = next.keys().next().value!, loop: number[] = [];
    let cur = start;
    for (let guard = 0; guard < 100000; guard++) {
      loop.push(cur);
      const list = next.get(cur);
      if (!list?.length) break;
      const b = list.shift()!;
      if (!list.length) next.delete(cur);
      cur = b;
      if (cur === start && !next.has(start)) break;
    }
    if (loop.length >= 3) out.push(loop);
  }
  return out;
}

type SilhouetteView = { proj: (p: V) => number[]; top: number; bottom: number; browV: number };
const FIT_BINS = 64;
const FIT_ROUNDS = 10;

/** Media móvil que ignora huecos (NaN) y conserva NaN donde no hay datos cerca. */
function smoothBins(values: number[], radius: number) {
  return values.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) if (Number.isFinite(values[j])) { s += values[j]; n++; }
    return n ? s / n : NaN;
  });
}
/** Interpolación lineal entre bins finitos (para que el desplazamiento no salte de fila en fila). */
function sampleBins(values: number[], f: number) {
  const a = Math.max(0, Math.min(values.length - 1, Math.floor(f))), b = Math.min(values.length - 1, a + 1), t = Math.min(1, Math.max(0, f - a));
  const va = values[a], vb = values[b];
  if (Number.isFinite(va) && Number.isFinite(vb)) return va + (vb - va) * t;
  return Number.isFinite(va) ? va : Number.isFinite(vb) ? vb : 0;
}

/**
 * Ajuste no rígido a siluetas («shape from silhouettes» por vértice): en cada vista, el extremo
 * de cada fila del cráneo se lleva al borde de la máscara (cabello incluido) y, sobre la frente,
 * el techo de cada columna al techo de la máscara. El desplazamiento vive en el plano de la imagen
 * (frontal → anchura, lateral → occipucio y volumen posterior), crece hacia la silueta, se pondera
 * con `weight` (cero en el borde facial) y se suaviza sobre la malla para evitar escalones.
 */
function fitSilhouettes(points: V[], shell: number[], used: number[], weight: number[],
  sources: readonly HeadPhotoSource[], views: SilhouetteView[], forward: V): V[] {
  const out = points.map(p => [...p] as V);
  const neighbors = new Map<number, Set<number>>();
  for (let i = 0; i < shell.length; i += 3) for (let a = 0; a < 3; a++) {
    const set = neighbors.get(shell[i + a]) ?? new Set<number>();
    set.add(shell[i + (a + 1) % 3]); set.add(shell[i + (a + 2) % 3]);
    neighbors.set(shell[i + a], set);
  }
  // Dirección 3D que cambia solo una coordenada de imagen (a·d = 1, b·d = 0).
  const planar = (a: V, b: V): V => {
    const k = dot(a, b) / Math.max(1e-12, dot(b, b)), d = sub(a, [b[0] * k, b[1] * k, b[2] * k]), n = dot(a, d);
    return n > 1e-12 ? [d[0] / n, d[1] / n, d[2] / n] : [0, 0, 0];
  };
  const prepared = sources.map((source, s) => {
    const view = views[s], span = view.bottom - view.top;
    const rows = Array.from({ length: FIT_BINS }, () => [Infinity, -Infinity]);
    const colTop = new Float32Array(source.width).fill(Infinity);
    for (let y = 0; y < source.height; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < source.width; x++) if (source.mask[y * source.width + x] > 0.5) {
        if (l < 0) l = x; r = x;
        if (colTop[x] === Infinity) colTop[x] = y / source.height;
      }
      const b = Math.floor((y / source.height - view.top) / span * FIT_BINS);
      if (r - l < 3 || b < 0 || b >= FIT_BINS) continue;
      rows[b][0] = Math.min(rows[b][0], l / source.width);
      rows[b][1] = Math.max(rows[b][1], (r + 1) / source.width);
    }
    const U: V = [source.projection.u[0], source.projection.u[1], source.projection.u[2]];
    const W: V = [source.projection.v[0], source.projection.v[1], source.projection.v[2]];
    const profile = Math.abs(dot(U, forward)) > norm(U) * 0.7;
    const horizontal = dot(U, forward);
    // Un perfil oblicuo corrige profundidad, nunca anchura/altura de la frontal.
    const du: V = profile ? forward.map(v => v / horizontal) as V : planar(U, W);
    const limitV = 0.3 * (view.bottom - view.browV), limitU = limitV * source.height / source.width;
    return { source, view, span, rows, colTop, du, dv: profile ? [0, 0, 0] as V : planar(W, U), limitU, limitV, inward: profile ? Infinity : 0.1,
      spent: [new Float64Array(FIT_BINS), new Float64Array(FIT_BINS), new Float64Array(FIT_BINS)] };
  });
  // Estrechar/bajar tiene presupuesto acumulado en la frontal: su máscara pierde mechones y una cámara baja oculta la coronilla.
  const clamp = (x: number, l: number, outward: number, inward: number, spent: Float64Array, b: number) => {
    const y = Math.max(-l, Math.min(l, x));
    if (y * outward >= 0 || !Number.isFinite(inward)) return y;
    const step = Math.min(Math.abs(y), Math.max(0, l * inward - spent[b]));
    spent[b] += step;
    return -outward * step;
  };
  for (let round = 0; round < FIT_ROUNDS; round++) for (const { source, view, span, rows, colTop, du, dv, limitU, limitV, inward, spent } of prepared) {
    const uv = used.map(id => view.proj(out[id]));
    const rowMin = new Array(FIT_BINS).fill(Infinity), rowMax = new Array(FIT_BINS).fill(-Infinity);
    const minId = new Array(FIT_BINS).fill(-1), maxId = new Array(FIT_BINS).fill(-1);
    let uMin = Infinity, uMax = -Infinity;
    uv.forEach(([u, v], k) => {
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
      const b = Math.floor((v - view.top) / span * FIT_BINS);
      if (b < 0 || b >= FIT_BINS) return;
      if (u < rowMin[b]) { rowMin[b] = u; minId[b] = used[k]; }
      if (u > rowMax[b]) { rowMax[b] = u; maxId[b] = used[k]; }
    });
    // Intersectar aristas en cada fila: los vértices solos dejan huecos en mallas poco densas.
    for (let i = 0; i < shell.length; i += 3) for (let e = 0; e < 3; e++) {
      const a = shell[i + e], b = shell[i + (e + 1) % 3];
      const p = view.proj(out[a]), q = view.proj(out[b]);
      if (Math.abs(q[1] - p[1]) < 1e-12) continue;
      for (let row = 0; row < FIT_BINS; row++) {
        const v = view.top + (row + 0.5) / FIT_BINS * span;
        const t = (v - p[1]) / (q[1] - p[1]);
        if (t < 0 || t > 1) continue;
        const u = p[0] + (q[0] - p[0]) * t, id = weight[a] > weight[b] ? a : b;
        if (u < rowMin[row]) { rowMin[row] = u; minId[row] = id; }
        if (u > rowMax[row]) { rowMax[row] = u; maxId[row] = id; }
      }
    }
    // Un extremo facial (peso bajo) no se mueve: la cara observada manda.
    const left = smoothBins(rows.map((m, b) => Number.isFinite(m[0]) && minId[b] >= 0 && weight[minId[b]] > 0.3
      ? clamp(m[0] - rowMin[b], limitU, -1, inward, spent[0], b) : NaN), 2);
    const right = smoothBins(rows.map((m, b) => Number.isFinite(m[1]) && maxId[b] >= 0 && weight[maxId[b]] > 0.3
      ? clamp(m[1] - rowMax[b], limitU, 1, inward, spent[1], b) : NaN), 2);
    const center = smoothBins(rowMin.map((l, b) => Number.isFinite(l) ? (l + rowMax[b]) / 2 : NaN), 1);
    const halfLeft = smoothBins(rowMin.map((l, b) => Number.isFinite(l) ? Math.max(1e-6, center[b] - l) : NaN), 1);
    const halfRight = smoothBins(rowMax.map((r, b) => Number.isFinite(r) ? Math.max(1e-6, r - center[b]) : NaN), 1);
    // Techo por columnas sobre la frente: aquí el cabello define la forma.
    const colMesh = new Array(FIT_BINS).fill(Infinity), colId = new Array(FIT_BINS).fill(-1);
    const colOf = (u: number) => (u - uMin) / Math.max(1e-9, uMax - uMin) * FIT_BINS;
    uv.forEach(([u, v], k) => {
      const c = Math.min(FIT_BINS - 1, Math.max(0, Math.floor(colOf(u))));
      if (v < view.browV && v < colMesh[c]) { colMesh[c] = v; colId[c] = used[k]; }
    });
    const tops = smoothBins(colMesh.map((v, c) => {
      if (!Number.isFinite(v) || colId[c] < 0 || weight[colId[c]] <= 0.3) return NaN;
      const x0 = Math.max(0, Math.floor((uMin + c / FIT_BINS * (uMax - uMin)) * source.width));
      const x1 = Math.min(source.width, Math.ceil((uMin + (c + 1) / FIT_BINS * (uMax - uMin)) * source.width));
      let m = Infinity;
      for (let x = x0; x < x1; x++) m = Math.min(m, colTop[x]);
      return Number.isFinite(m) && m < view.browV ? clamp(m - v, limitV, -1, inward, spent[2], c) : NaN;
    }), 2);
    const delta = new Map<number, V>();
    uv.forEach(([u, v], k) => {
      const id = used[k], w = weight[id];
      if (w <= 0) return;
      const f = (v - view.top) / span * FIT_BINS - 0.5, c = sampleBins(center, f);
      let shiftU = 0;
      if (Number.isFinite(c) && f >= -1 && f <= FIT_BINS) {
        const t = u < c ? (c - u) / sampleBins(halfLeft, f) : (u - c) / sampleBins(halfRight, f);
        shiftU = sampleBins(u < c ? left : right, f) * Math.min(1, Math.max(0, t)) ** 2;
      }
      let shiftV = 0;
      if (v < view.browV) {
        const fc = colOf(u) - 0.5, topMesh = sampleBins(colMesh.map(x => Number.isFinite(x) ? x : NaN), fc);
        const t = (view.browV - v) / Math.max(1e-6, view.browV - topMesh);
        shiftV = sampleBins(tops, fc) * Math.min(1, Math.max(0, t)) ** 2;
      }
      if (shiftU || shiftV) delta.set(id, [0, 1, 2].map(a => (du[a] * shiftU + dv[a] * shiftV) * w) as V);
    });
    // Suavizado laplaciano del campo de desplazamiento: continuidad entre filas/columnas (sin «legos»).
    let field = delta;
    for (let it = 0; it < 3; it++) {
      const next = new Map<number, V>();
      for (const id of used) {
        const own = field.get(id) ?? [0, 0, 0], ns = neighbors.get(id);
        if (!ns?.size) { next.set(id, own); continue; }
        const avg: V = [0, 0, 0];
        for (const n of ns) { const d = field.get(n); if (d) { avg[0] += d[0]; avg[1] += d[1]; avg[2] += d[2]; } }
        next.set(id, [0, 1, 2].map(a => weight[id] === 0 ? 0 : (own[a] + avg[a] / ns.size) / 2) as V);
      }
      field = next;
    }
    for (const id of used) {
      const d = field.get(id);
      // Peso de nuevo tras suavizar: el borde facial queda fijo exactamente.
      if (d) out[id] = [0, 1, 2].map(a => out[id][a] + d[a] * 0.8 * Math.min(1, weight[id] * 1.5)) as V;
    }
  }
  return out;
}

export function buildTemplateHead(face: PersonalSurface, template: HeadTemplate, sources: readonly HeadPhotoSource[] = []): EstimatedHeadSurface {
  const count = face.positions.length / 3;
  if (!Number.isInteger(count) || count < 468 || template.landmarks.length < 468 * 3) fail('datos incompletos.');
  const personal = Array.from({ length: 468 }, (_, i) => at(face.positions, i));
  const generic = Array.from({ length: 468 }, (_, i) => at(template.landmarks, i));
  if (![...personal, ...generic].every(p => p.every(Number.isFinite))) fail('landmarks no finitos.');
  const sim = similarity(CONTROL.map(i => generic[i]), CONTROL.map(i => personal[i]));
  const axis = (c: number): V => [sim.R[0][c], sim.R[1][c], sim.R[2][c]];
  const right = axis(0), up = axis(1), fwd = axis(2);
  const { points: raw, tris: rawTris } = weld(template.positions, template.triangles);
  // Escala global por ejes (ancho, alto, profundidad) por mínimos cuadrados: deforma el cráneo como un todo,
  // sin interpolar cada vértice hacia el óvalo (eso estiraba las orejas en punta).
  const cd = CONTROL.reduce((s, i) => [s[0] + personal[i][0] / CONTROL.length, s[1] + personal[i][1] / CONTROL.length, s[2] + personal[i][2] / CONTROL.length] as V, [0, 0, 0] as V);
  const axisScale = [right, up, fwd].map(ax => {
    let num = 0, den = 0;
    for (const i of CONTROL) {
      const x = dot(sub(sim.apply(generic[i]), cd), ax), y = dot(sub(personal[i], cd), ax);
      num += x * y; den += x * x;
    }
    // Rango amplio: rostros anchos o largos deben poder alcanzarse antes del ajuste local.
    return Math.min(1.35, Math.max(0.75, den > 0 ? num / den : 1));
  });
  const affine = (p: V): V => {
    const q = sub(sim.apply(p), cd), x = dot(q, right) * axisScale[0], y = dot(q, up) * axisScale[1], z = dot(q, fwd) * axisScale[2];
    return [0, 1, 2].map(k => cd[k] + right[k] * x + up[k] * y + fwd[k] * z) as V;
  };
  let points = raw.map(affine);
  // Corrección local acotada: residuos del óvalo repartidos con Shepard gaussiano solo cerca de la cara.
  {
    const fh = norm(sub(personal[10], personal[152])), sigma2 = (fh * 0.12) ** 2;
    const ctl = FACE_OVAL.map(i => ({ p: personal[i], r: sub(personal[i], affine(generic[i])) }));
    points = points.map(p => {
      let ws = 1e-3, dmin = Infinity;
      const acc: V = [0, 0, 0];
      for (const c of ctl) {
        const d2 = dot(sub(p, c.p), sub(p, c.p)), w = Math.exp(-d2 / (2 * sigma2));
        dmin = Math.min(dmin, Math.sqrt(d2)); ws += w;
        acc[0] += c.r[0] * w; acc[1] += c.r[1] * w; acc[2] += c.r[2] * w;
      }
      const t = Math.min(1, dmin / (fh * 0.35)), fall = 1 - t * t * (3 - 2 * t);
      return [p[0] + acc[0] / ws * fall, p[1] + acc[1] / ws * fall, p[2] + acc[2] / ws * fall] as V;
    });
  }

  const oval = FACE_OVAL.map(i => personal[i]);
  const faceH = norm(sub(personal[10], personal[152]));
  const ovalUV = oval.map(p => [dot(p, right), dot(p, up)]);
  const minFwd = Math.min(...oval.map(p => dot(p, fwd)));
  const inOval = (p: V) => {
    const x = dot(p, right), y = dot(p, up);
    let inside = false;
    for (let i = 0, j = ovalUV.length - 1; i < ovalUV.length; j = i++) {
      const [ax, ay] = ovalUV[i], [bx, by] = ovalUV[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
  const chinUp = dot(personal[152], up);
  const keep: number[] = [];
  for (let i = 0; i < rawTris.length; i += 3) {
    const t = [rawTris[i], rawTris[i + 1], rawTris[i + 2]];
    const c = [0, 1, 2].map(k => (points[t[0]][k] + points[t[1]][k] + points[t[2]][k]) / 3) as V;
    // Solo triángulos enteros bajo el corte: tras proyectar, el borde libre queda en el plano.
    if (t.every(id => dot(points[id], up) < chinUp - faceH * 0.3)) continue;
    if (dot(c, fwd) > minFwd - faceH * 0.04 && t.some(id => inOval(points[id]))) continue;
    keep.push(...t);
  }
  // Islas sueltas (p. ej. restos del interior de la boca) fuera: solo el componente mayor.
  const parent = points.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < keep.length; i += 3) { parent[find(keep[i + 1])] = find(keep[i]); parent[find(keep[i + 2])] = find(keep[i]); }
  const size = new Map<number, number>();
  for (const id of keep) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  const main = [...size.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const shell = keep.filter((_, i) => find(keep[i - i % 3]) === main);
  if (shell.length < 300) fail('la plantilla no conserva suficiente cráneo.');
  // Borde del cuello recto: los vértices bajo el plano de corte se proyectan sobre él (sin dientes de sierra).
  {
    const cut = chinUp - faceH * 0.3;
    for (const id of new Set(shell)) {
      const h = dot(points[id], up);
      if (h < cut) points[id] = [0, 1, 2].map(k => points[id][k] + up[k] * (cut - h)) as V;
    }
  }

  // Frontera facial de la plantilla: el bucle más cercano al óvalo personal.
  const ovalCenter = oval.reduce((s, p) => [s[0] + p[0] / 36, s[1] + p[1] / 36, s[2] + p[2] / 36] as V, [0, 0, 0] as V);
  const angle = (p: V) => { const d = sub(p, ovalCenter); return Math.atan2(dot(d, up), dot(d, right)); };
  const winding = (loop: number[], pos: (id: number) => V) => loop.reduce((s, id, i) => {
    const a = angle(pos(id)), b = angle(pos(loop[(i + 1) % loop.length]));
    return s + Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }, 0);
  const seam = loops(shell).filter(loop => Math.abs(winding(loop, id => points[id])) > 5 && dot(points[loop[0]], fwd) > minFwd - faceH * 0.6).map(loop => ({
    loop, d: loop.reduce((s, id) => s + Math.min(...oval.map(p => norm(sub(points[id], p)))), 0) / loop.length,
  })).sort((a, b) => a.d - b.d)[0];
  if (!seam || seam.d > faceH * 0.2) fail('no se encontró el borde facial de la plantilla.');

  // Influencia de las siluetas: nula en el borde facial y completa en el cráneo.
  const distToFace = points.map(p => Math.min(...oval.map(q => norm(sub(p, q)))));
  const pivot: V = [0, 1, 2].map(k => (personal[234][k] + personal[454][k]) / 2) as V;
  // El cuello no sigue la escala craneal: rampa desde el mentón hasta el trago.
  const neckSpan = Math.max(1e-6, dot(pivot, up) - chinUp);
  const weight = points.map((p, i) => {
    const t = Math.min(1, distToFace[i] / (faceH * 0.45)), n = Math.min(1, Math.max(0, (dot(p, up) - chinUp) / neckSpan));
    return t * t * (3 - 2 * t) * n * n * (3 - 2 * n);
  });
  for (const id of seam.loop) weight[id] = 0;
  const used = [...new Set(shell)];
  if (sources.length) {
    const views = sources.map(source => {
      const proj = (p: V) => [p[0] * source.projection.u[0] + p[1] * source.projection.u[1] + p[2] * source.projection.u[2] + source.projection.u[3],
        p[0] * source.projection.v[0] + p[1] * source.projection.v[1] + p[2] * source.projection.v[2] + source.projection.v[3]];
      const chinV = proj(personal[152])[1], browV = proj(personal[10])[1];
      const top = browV - (chinV - browV) * 0.9;
      return { proj, top, bottom: chinV, browV };
    });
    points = fitSilhouettes(points, shell, used, weight, sources, views, fwd);
  }

  // Empaquetar: cara observada intacta + cráneo de plantilla + costura.
  const remap = new Map<number, number>();
  used.forEach((id, i) => remap.set(id, count + i));
  const positions = new Float32Array((count + used.length) * 3), uvs = new Float32Array((count + used.length) * 2);
  positions.set(face.positions);
  uvs.set(face.uvs);
  const { cx, cy, k, aspect } = face.projection;
  used.forEach((id, i) => {
    const p = points[id];
    positions.set(p, (count + i) * 3);
    uvs.set([Math.min(1, Math.max(0, (p[0] / k + cx) / aspect)), Math.min(1, Math.max(0, -(p[1] / k + cy)))], (count + i) * 2);
  });
  const P = (id: number): V => at(positions, id);
  const headCenter: V = [0, 1, 2].map(a => pivot[a] - fwd[a] * faceH * 0.2) as V;
  const outward = (a: number, b: number, c: number) => {
    const n = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    const m = [0, 1, 2].map(k => (P(a)[k] + P(b)[k] + P(c)[k]) / 3) as V;
    return dot(n, sub(m, headCenter)) >= 0;
  };
  const faceTris = Array.from(face.indices);
  let faceOut = 0;
  for (let i = 0; i < faceTris.length; i += 3) faceOut += outward(faceTris[i], faceTris[i + 1], faceTris[i + 2]) ? 1 : -1;
  const orient = (a: number, b: number, c: number) => (outward(a, b, c) === faceOut >= 0) ? [a, b, c] : [a, c, b];

  // Cremallera por ángulo alrededor del centro del óvalo.
  const ordered = (ids: number[], pos: (id: number) => V) => {
    const walk = (list: number[]) => {
      let prev = angle(pos(list[0])), acc = 0;
      return list.map(id => { const a = angle(pos(id)); acc += Math.atan2(Math.sin(a - prev), Math.cos(a - prev)); prev = a; return { id, t: acc }; });
    };
    const list = [...ids];
    const probe = walk(list);
    if (probe[probe.length - 1].t < 0) list.reverse();
    const start = list.reduce((best, id, i) => (Math.cos(angle(pos(id)) - Math.PI / 2) > Math.cos(angle(pos(list[best])) - Math.PI / 2) ? i : best), 0);
    return walk([...list.slice(start), ...list.slice(0, start)]);
  };
  const closed = (list: { id: number; t: number }[]) => {
    const last = list[list.length - 1];
    const total = last.t + Math.atan2(Math.sin(angle(P(list[0].id)) - angle(P(last.id))), Math.cos(angle(P(list[0].id)) - angle(P(last.id))));
    if (total < 5) fail('el borde facial no rodea la cara.');
    return [...list.map(e => ({ id: e.id, t: e.t / total })), { id: list[0].id, t: 1 }];
  };
  const A = closed(ordered([...FACE_OVAL], P)), Bt = closed(ordered(seam.loop.map(id => remap.get(id)!), P));
  const stitch: number[] = [];
  for (let i = 0, j = 0; i < A.length - 1 || j < Bt.length - 1;) {
    if (j >= Bt.length - 1 || (i < A.length - 1 && A[i + 1].t <= Bt[j + 1].t)) { stitch.push(...orient(A[i].id, A[i + 1].id, Bt[j].id)); i++; }
    else { stitch.push(...orient(A[i].id, Bt[j + 1].id, Bt[j].id)); j++; }
  }
  const shellIdx = shell.map(id => remap.get(id)!);
  let shellOut = 0;
  for (let t = 0; t < shellIdx.length; t += 3) shellOut += outward(shellIdx[t], shellIdx[t + 1], shellIdx[t + 2]) ? 1 : -1;
  const cranium: number[] = [];
  for (let t = 0; t < shellIdx.length; t += 3) {
    const [a, b, c] = shellIdx.slice(t, t + 3);
    cranium.push(...((shellOut >= 0) === (faceOut >= 0) ? [a, b, c] : [a, c, b]));
  }
  const indices = Uint32Array.from([...faceTris, ...cranium, ...stitch]);
  if (!positions.every(Number.isFinite)) fail('coordenadas no finitas.');
  const openings = loops(faceTris).length - 1;
  return { positions, uvs, indices, projection: face.projection, observedIndexCount: faceTris.length,
    observedVertexCount: count, preservedOpenings: Math.max(0, openings) };
}
