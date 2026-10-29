import type { PersonalSurface } from './engine';
import type { HairPhotoProjection } from './estimatedHair';

export interface HeadPhotoSource {
  label: string;
  width: number;
  height: number;
  mask: Float32Array;
  /** Confianza de cabello (subconjunto de mask), si el segmentador la ofrece. */
  hair?: Float32Array;
  texture: HTMLCanvasElement;
  projection: HairPhotoProjection;
}
export interface PhotoSurfacePatch {
  source: HeadPhotoSource; indices: Uint32Array; uvs: Float32Array;
  /** Triángulos con aporte de esta vista y alfa por vértice para la mezcla ordenada. */
  blendIndices?: Uint32Array; alpha?: Float32Array;
}

const project = (p: ArrayLike<number>, row: number[]) => p[0] * row[0] + p[1] * row[1] + p[2] * row[2] + row[3];
const smoothStep = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
function rowBounds(source: HeadPhotoSource): Float32Array {
  if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 2 || source.height < 2
    || source.mask.length !== source.width * source.height
    || !source.mask.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || (source.hair && (source.hair.length !== source.mask.length
      || !source.hair.every(value => Number.isFinite(value) && value >= 0 && value <= 1)))
    || source.projection.u.length !== 4 || source.projection.v.length !== 4 || source.projection.towardCamera.length !== 3
    || ![...source.projection.u, ...source.projection.v, ...source.projection.towardCamera].every(Number.isFinite)) {
    throw new Error('Silueta o cámara multivista inválida.');
  }
  const rows = new Float32Array(source.height * 2).fill(-1);
  for (let y = 0; y < source.height; y++) {
    let left = source.width, right = -1;
    for (let x = 0; x < source.width; x++) if (source.mask[y * source.width + x] > 0.6) {
      left = Math.min(left, x); right = x;
    }
    if (right - left > 2) { rows[y * 2] = left / source.width; rows[y * 2 + 1] = (right + 1) / source.width; }
  }
  return rows;
}

/**
 * Z-buffer analítico por celdas: compara profundidad baricéntrica en el píxel exacto, sin rasterizar
 * fotos ni confundir una mejilla tras la nariz con piel visible. Incluye oclusores de ambas orientaciones.
 */
function photoVisibility(surface: PersonalSurface, source: HeadPhotoSource, uvs: Float32Array) {
  const size = 32, bins: number[][] = Array.from({ length: size * size }, () => []);
  const camera = source.projection.towardCamera, norm = Math.hypot(...camera) || 1;
  const depths = Float32Array.from({ length: surface.positions.length / 3 }, (_, id) =>
    (surface.positions[id * 3] * camera[0] + surface.positions[id * 3 + 1] * camera[1]
      + surface.positions[id * 3 + 2] * camera[2]) / norm);
  let min = Infinity, max = -Infinity;
  for (const d of depths) { min = Math.min(min, d); max = Math.max(max, d); }
  const tolerance = Math.max(1e-6, (max - min) * 0.002);
  for (let i = 0; i < surface.indices.length; i += 3) {
    const ids = surface.indices.subarray(i, i + 3);
    const us = Array.from(ids, id => uvs[id * 2]), vs = Array.from(ids, id => uvs[id * 2 + 1]);
    const x0 = Math.max(0, Math.floor(Math.min(...us) * size)), x1 = Math.min(size - 1, Math.floor(Math.max(...us) * size));
    const y0 = Math.max(0, Math.floor(Math.min(...vs) * size)), y1 = Math.min(size - 1, Math.floor(Math.max(...vs) * size));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bins[y * size + x].push(i);
  }
  const visible = (u: number, v: number, depth: number) => {
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return false;
    for (const i of bins[Math.floor(v * size) * size + Math.floor(u * size)]) {
      const a = surface.indices[i], b = surface.indices[i + 1], c = surface.indices[i + 2];
      const ax = uvs[a * 2], ay = uvs[a * 2 + 1], bx = uvs[b * 2], by = uvs[b * 2 + 1];
      const cx = uvs[c * 2], cy = uvs[c * 2 + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det;
      const wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det, wc = 1 - wa - wb;
      if (Math.min(wa, wb, wc) >= -1e-6 && wa * depths[a] + wb * depths[b] + wc * depths[c] > depth + tolerance) return false;
    }
    return true;
  };
  const vertexVisible = Uint8Array.from(depths, (depth, id) => Number(visible(uvs[id * 2], uvs[id * 2 + 1], depth)));
  return { depths, visible, vertexVisible };
}

/** Mediana del color de cabello visible en todas las vistas (o, sin canal de cabello, la cabeza sobre la frente). */
export function sampleScalpColor(sources: readonly HeadPhotoSource[], forehead: ArrayLike<number>): string | undefined {
  const channels: number[][] = [[], [], []];
  for (const source of sources) {
    const browV = project(forehead, source.projection.v);
    const ctx = source.texture.getContext?.('2d', { willReadFrequently: true });
    if (!ctx || !Number.isFinite(browV)) continue;
    const { width: tw, height: th } = source.texture, pixels = ctx.getImageData(0, 0, tw, th).data;
    const rows = source.hair ? source.height : Math.min(source.height, Math.floor((browV - 0.03) * source.height));
    for (let y = 0; y < rows; y += 2) {
      for (let x = 0; x < source.width; x += 2) {
        if ((source.hair ?? source.mask)[y * source.width + x] < 0.7) continue;
        const o = (Math.floor(y / source.height * th) * tw + Math.floor(x / source.width * tw)) * 4;
        for (let c = 0; c < 3; c++) channels[c].push(pixels[o + c]);
      }
    }
  }
  if (channels[0].length < 50) return undefined;
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  return `#${channels.map(values => median(values).toString(16).padStart(2, '0')).join('')}`;
}

/** Mediana RGB en ventanas 9×9 alrededor de puntos 3D proyectados en una vista (p. ej. piel de frente y pómulos). */
export function sampleColorAt(source: HeadPhotoSource | undefined, points: readonly ArrayLike<number>[]): string | undefined {
  const ctx = source?.texture.getContext?.('2d', { willReadFrequently: true });
  if (!source || !ctx) return undefined;
  const { width: tw, height: th } = source.texture, channels: number[][] = [[], [], []];
  for (const p of points) {
    const cx = Math.round(project(p, source.projection.u) * tw), cy = Math.round(project(p, source.projection.v) * th);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 4 || cy < 4 || cx > tw - 5 || cy > th - 5) continue;
    const pixels = ctx.getImageData(cx - 4, cy - 4, 9, 9).data;
    for (let o = 0; o < pixels.length; o += 4) for (let c = 0; c < 3; c++) channels[c].push(pixels[o + c]);
  }
  if (!channels[0].length) return undefined;
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
  return `#${channels.map(values => median(values).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `indices`: un triángulo, una vista (exportación GLB). `blendIndices` + `alpha`: mezcla suave por vértice
 * para el visor; dibujar los parches en orden con alfa «over» da la media ponderada Σwᵢcᵢ/Σwᵢ.
 * Los triángulos anteriores a `firstIndex` (cara observada) conservan la textura frontal propia.
 * Para máscara abierta: firstIndex = surface.indices.length. sources[0] DEBE ser la foto frontal base.
 * Para cabeza: firstIndex = observedIndexCount. No genera geometría ni cierra aberturas.
 */
export function buildPhotoSurfacePatches(surface: PersonalSurface, sources: readonly HeadPhotoSource[], firstIndex = 0): PhotoSurfacePatch[] {
  if (!Number.isInteger(firstIndex) || firstIndex < 0 || firstIndex > surface.indices.length || firstIndex % 3) {
    throw new Error('El límite de la cara observada debe coincidir con un triángulo.');
  }
  const vertexCount = surface.positions.length / 3;
  const candidates = sources.map(source => {
    rowBounds(source);
    const uvs = new Float32Array(vertexCount * 2);
    for (let id = 0; id < vertexCount; id++) {
      const p = surface.positions.subarray(id * 3, id * 3 + 3);
      uvs[id * 2] = project(p, source.projection.u); uvs[id * 2 + 1] = project(p, source.projection.v);
    }
    return { source, uvs, ...photoVisibility(surface, source, uvs),
      indices: [] as number[], blend: [] as number[], alpha: new Float32Array(vertexCount) };
  });
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    const [a, b, c] = ids.map(id => Array.from(surface.positions.subarray(id * 3, id * 3 + 3)));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const id of ids) for (let k = 0; k < 3; k++) normals[id * 3 + k] += n[k];
  }
  // La frontal domina donde también es útil: la cara y la frente no se fragmentan con recortes laterales.
  // Borde de máscara suave: media en una ventana (~2 % del ancho) → la vista se desvanece hacia su silueta
  // en vez de cortarse en seco por un píxel (origen de los escalones tipo «lego»).
  const softMask = (source: HeadPhotoSource, u: number, v: number) => {
    const r = Math.max(1, Math.round(source.width * 0.02)), cx = Math.floor(u * source.width), cy = Math.floor(v * source.height);
    let sum = 0, n = 0;
    for (let dy = -r; dy <= r; dy += r) for (let dx = -r; dx <= r; dx += r) {
      const x = Math.min(source.width - 1, Math.max(0, cx + dx)), y = Math.min(source.height - 1, Math.max(0, cy + dy));
      sum += source.mask[y * source.width + x]; n++;
    }
    const t = Math.min(1, Math.max(0, (sum / n - 0.45) / 0.5));
    return t * t * (3 - 2 * t);
  };
  const faceVertices = new Set(Array.from(surface.indices.subarray(0, firstIndex)));
  const faceH = vertexCount >= 468 ? Math.hypot(surface.positions[30] - surface.positions[456],
    surface.positions[31] - surface.positions[457]) : 0;
  const faceLateralGate = (id: number) => {
    if (!(faceH > 1e-6)) return 1;
    const x = surface.positions[id * 3], y = surface.positions[id * 3 + 1];
    const center = surface.positions[168 * 3];
    let gate = smoothStep((Math.abs(x - center) / faceH - 0.12) / 0.12);
    // Ojos y cantos externos son textura frontal, no una segunda imagen lateral superpuesta.
    for (const [a, b] of [[33, 133], [263, 362]]) {
      const ax = surface.positions[a * 3], bx = surface.positions[b * 3];
      const cy = (surface.positions[a * 3 + 1] + surface.positions[b * 3 + 1]) / 2;
      const radius = Math.max(Math.abs(ax - bx) / 2, faceH * 0.025) + faceH * 0.025;
      const d = Math.hypot((x - (ax + bx) / 2) / radius, (y - cy) / (faceH * 0.045));
      gate *= smoothStep((d - 1) / 0.4);
    }
    return gate;
  };
  const maskCovers = (source: HeadPhotoSource, u: number, v: number) =>
    u >= 0 && v >= 0 && u < 1 && v < 1
      && source.mask[Math.floor(v * source.height) * source.width + Math.floor(u * source.width)] > 0.6;
  const vertexCovered = (candidate: typeof candidates[number], id: number) =>
    candidate.vertexVisible[id] && maskCovers(candidate.source, candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]);
  const weights = candidates.map((candidate, s) => Float32Array.from({ length: vertexCount }, (_, id) => {
    const n = normals.subarray(id * 3, id * 3 + 3), length = Math.hypot(n[0], n[1], n[2]);
    const [u, v] = [candidate.uvs[id * 2], candidate.uvs[id * 2 + 1]];
    if (length < 1e-12 || !vertexCovered(candidate, id)) return 0;
    const facing = (n[0] * candidate.source.projection.towardCamera[0] + n[1] * candidate.source.projection.towardCamera[1]
      + n[2] * candidate.source.projection.towardCamera[2]) / (length * Math.hypot(...candidate.source.projection.towardCamera));
    const gate = s > 0 && faceVertices.has(id) ? faceLateralGate(id) : 1;
    return facing > 0.15 ? (facing - 0.15) ** 2 * (s === 0 ? 2.5 : 1)
      * softMask(candidate.source, u, v) * gate : 0;
  }));
  for (let id = 0; id < vertexCount; id++) {
    let total = 0;
    candidates.forEach((candidate, s) => {
      total += weights[s][id];
      candidate.alpha[id] = total > 0 ? weights[s][id] / total : 0;
    });
  }
  // En la cara observada solo entran las laterales y solo donde la frontal es oblicua (mejillas, mandíbula):
  // la textura propia de la cara hace de base y se evitan estrías estiradas sin «fantasmas» en el centro.
  for (const id of faceVertices) candidates.forEach((candidate, s) => {
    if (s > 0) candidate.alpha[id] = Math.min(1, Math.max(0, (candidate.alpha[id] - 0.2) / 0.6));
  });
  for (let i = 0; i < firstIndex; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    candidates.forEach((candidate, s) => {
      if (s > 0 && ids.some(id => candidate.alpha[id] > 0) && triangleCovered(candidate, ids)) {
        candidate.blend.push(...ids);
        // GLB no consume alfa: solo reemplazar donde el lateral ya es claramente dominante.
        if (ids.every(id => candidate.alpha[id] > 0.65)) candidate.indices.push(...ids);
      }
    });
  }
  function triangleCovered(candidate: typeof candidates[number], ids: number[]) {
    if (!ids.every(id => vertexCovered(candidate, id))) return false;
    const [a, b, c] = ids.map(id => surface.positions.subarray(id * 3, id * 3 + 3));
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const camera = candidate.source.projection.towardCamera;
    if (n.reduce((sum, v, k) => sum + v * camera[k], 0) <= 0.12 * Math.hypot(...n) * Math.hypot(...camera)) return false;
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / 3;
    const u = average(ids.map(id => candidate.uvs[id * 2])), v = average(ids.map(id => candidate.uvs[id * 2 + 1]));
    return maskCovers(candidate.source, u, v) && candidate.visible(u, v, average(ids.map(id => candidate.depths[id])));
  }
  for (let i = firstIndex; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    candidates.forEach((candidate, s) => {
      if (ids.some(id => weights[s][id] > 0) && triangleCovered(candidate, ids)) candidate.blend.push(...ids);
    });
  }
  for (let i = firstIndex; i < surface.indices.length; i += 3) {
    const ids = Array.from(surface.indices.subarray(i, i + 3));
    const [a, b, c] = ids.map(id => Array.from(surface.positions.subarray(id * 3, id * 3 + 3)));
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...n);
    if (length < 1e-10) continue;
    let best: typeof candidates[number] | undefined, score = 0.2;
    for (const candidate of candidates) {
      const facing = n.reduce((sum, v, j) => sum + v / length * candidate.source.projection.towardCamera[j], 0)
        / Math.hypot(...candidate.source.projection.towardCamera);
      if (facing <= score) continue;
      if (triangleCovered(candidate, ids)) { best = candidate; score = facing; }
    }
    best?.indices.push(...ids);
  }
  return candidates.filter(candidate => candidate.indices.length || candidate.blend.length).map(candidate => ({
    source: candidate.source, uvs: candidate.uvs, indices: Uint32Array.from(candidate.indices),
    blendIndices: Uint32Array.from(candidate.blend), alpha: candidate.alpha,
  }));
}

/** Solo nariz: raíz, dorso, punta, columela y subnasal. Nunca barba, labios ni mentón. */
export const PROFILE_MIDLINE = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 164];

export interface ProfileDepthResult {
  positions: Float32Array;
  points: number;
  coverage: 'one-sided' | 'bilateral';
  /** Error de las muestras aceptadas en unidades de malla, no precisión clínica. */
  beforeRmse: number;
  afterRmse: number;
  maxDisplacement: number;
}

/**
 * Ajusta la envolvente nasal a siluetas casi laterales. Solo cambia Z: XY y UV frontales son inmutables.
 * La confianza absoluta depende del ángulo, resolución, estabilidad de borde y acuerdo bilateral;
 * no se normaliza una vista rasante hasta convertirla en evidencia plena.
 * No estima rotación vertical moviendo Y: la curva Z(Y) cambia la pendiente aparente de punta/columela.
 */
export function refineProfileDepth(positions: Float32Array, sources: readonly HeadPhotoSource[]): ProfileDepthResult | null {
  if (positions.length < 468 * 3 || positions.length % 3 || !positions.every(Number.isFinite)) return null;
  const P = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const faceH = Math.hypot(P(10)[0] - P(152)[0], P(10)[1] - P(152)[1]);
  const root = P(168), base = P(164), lip = P(0);
  // Borde superior completo del bermellón, no solo el centro: los arcos de Cupido quedan fuera del soporte.
  lip[1] = Math.max(...[0, 37, 39, 40, 267, 269, 270].map(id => P(id)[1]));
  if (!(faceH > 1e-6 && root[1] > base[1] && base[1] > lip[1])) return null;
  const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
  const median = (a: number[]) => {
    const b = [...a].sort((x, y) => x - y), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const sum = new Map<number, { delta: number; weight: number; side: number }[]>();
  for (const source of sources) {
    rowBounds(source);
    const U = source.projection.u, V = source.projection.v, camera = source.projection.towardCamera;
    const lateral = Math.abs(U[2]) / Math.hypot(U[0], U[1], U[2]);
    // Z frontal es la única incógnita. Un perfil con pitch acusado no permite leer un borde por filas.
    if (!(lateral > 0.8) || Math.abs(V[2]) > Math.hypot(V[0], V[1]) * 0.15
      || Math.abs(camera[0]) < Math.hypot(...camera) * 0.75) continue;
    const dir = Math.sign(U[2]), { width: W, height: H, mask, hair } = source;
    const faceHpx = Math.abs(project(P(10), V) - project(P(152), V)) * H;
    if (faceHpx < 40) continue;
    const confidence = smooth((lateral - 0.8) / 0.18) * Math.min(1, faceHpx / 160);
    const limit = Math.ceil(Math.abs(U[2]) * W * faceH * 0.085);
    const inside = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H && mask[y * W + x] > 0.6;
    for (const id of PROFILE_MIDLINE) {
      const p = P(id), u = project(p, source.projection.u), v = project(p, source.projection.v);
      const y0 = Math.floor(v * H), x0 = Math.floor(u * W);
      if (!(y0 >= 2 && y0 < H - 2 && x0 >= 1 && x0 < W - 1)) continue;
      const edges: { x: number; y: number }[] = [];
      for (let y = y0 - 2; y <= y0 + 2; y++) {
        let x = x0, steps = 0;
        if (inside(x, y)) { while (steps < limit && inside(x + dir, y)) { x += dir; steps++; } }
        else { while (steps < limit && !inside(x, y)) { x -= dir; steps++; } }
        // Bordes recortados, islas de segmentación y cabello no son una medida nasal.
        if (steps >= limit || x < 2 || x >= W - 2 || !inside(x, y) || inside(x + dir, y)
          || !inside(x - dir, y) || !inside(x - 2 * dir, y) || inside(x + 2 * dir, y) || inside(x + 3 * dir, y)
          || (hair && hair[y * W + x] > 0.25)) continue;
        edges.push({ x: x + (dir > 0 ? 1 : 0), y });
      }
      if (edges.length < 4) continue;
      // Quitar la pendiente local antes de medir ruido: un dorso inclinado no es segmentación inestable.
      const slopes = edges.flatMap((a, i) => edges.slice(i + 1).map(b => (b.x - a.x) / (b.y - a.y)));
      const slope = median(slopes), intercepts = edges.map(e => e.x - slope * (e.y - y0));
      const edge = median(intercepts), noise = median(intercepts.map(e => Math.abs(e - edge)));
      const delta = (edge / W - u) / U[2];
      if (noise > Math.max(2, faceHpx * 0.008) || Math.abs(delta) > faceH * 0.08) continue;
      const weight = confidence * (edges.length / 5) / (1 + noise * noise);
      const acc = sum.get(id) ?? [];
      acc.push({ delta, weight, side: Math.sign(camera[0]) }); sum.set(id, acc);
    }
  }
  const samples = [...sum].flatMap(([id, observations]) => {
    // Una sola mala vista no puede crear un compromiso nasal entre dos siluetas incompatibles.
    const center = median(observations.map(o => o.delta));
    if (observations.some(o => Math.abs(o.delta - center) > faceH * 0.018)) return [];
    const total = observations.reduce((s, o) => s + o.weight, 0);
    if (total < 0.02) return [];
    const delta = observations.reduce((s, o) => s + o.weight * o.delta, 0) / total;
    const sides = new Set(observations.filter(o => o.weight > 0.1).map(o => o.side));
    const confidence = Math.min(1, total / (sides.size > 1 ? 1.5 : 1.25));
    return [{ id, y: P(id)[1], delta, s: delta * confidence, bilateral: sides.size > 1 }];
  }).sort((a, b) => a.y - b.y);
  if (samples.length < 5 || !samples.some(s => [168, 6, 197].includes(s.id))
    || !samples.some(s => [4, 1].includes(s.id)) || !samples.some(s => [19, 94, 2, 164].includes(s.id))) return null;
  const at = (y: number) => {
    const j = samples.findIndex(e => e.y >= y);
    if (j <= 0) return samples[j === 0 ? 0 : samples.length - 1].s;
    const a = samples[j - 1], b = samples[j], t = (y - a.y) / Math.max(1e-9, b.y - a.y);
    return a.s + (b.s - a.s) * t;
  };
  const out = Float32Array.from(positions);
  let maxDisplacement = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = P(i), t = (p[1] - base[1]) / (root[1] - base[1]);
    if (p[1] <= lip[1] || p[1] >= root[1] + faceH * 0.04) continue;
    const axisX = base[0] + (root[0] - base[0]) * Math.max(0, Math.min(1, t));
    const x = Math.abs(p[0] - axisX) / faceH;
    // Meseta central: no concentrar toda la corrección en un ápice afilado.
    const lateral = 1 - smooth((x - 0.025) / 0.095);
    const vertical = smooth((p[1] - lip[1]) / (base[1] - lip[1]))
      * (1 - smooth((p[1] - root[1]) / (faceH * 0.04)));
    const s = at(p[1]) * lateral * vertical;
    out[i * 3 + 2] += s;
    maxDisplacement = Math.max(maxDisplacement, Math.abs(s));
  }
  const rmse = (after: boolean) => Math.sqrt(samples.reduce((s, sample) => {
    const applied = after ? out[sample.id * 3 + 2] - positions[sample.id * 3 + 2] : 0;
    return s + (sample.delta - applied) ** 2;
  }, 0) / samples.length);
  return out.every(Number.isFinite) ? {
    positions: out, points: samples.length, coverage: samples.filter(s => s.bilateral).length >= 5 ? 'bilateral' : 'one-sided',
    beforeRmse: rmse(false), afterRmse: rmse(true), maxDisplacement,
  } : null;
}