import atlasData from './genericFaceAtlas.json' with { type: 'json' };
import type { PersonalSurface, Vec3 } from './engine';

/** Intensidades visuales adimensionales, no medidas ni predicciones clínicas. */
export interface SimulationParameters {
  noseRadix: number;
  noseBridge: number;
  noseTip: number;
  noseRotation: number;
  noseWidth: number;
  /** 0 neutro; + derecha→izquierda del paciente; − izquierda→derecha. Solo geometría. */
  noseSymmetry: number;
  chinProjection: number;
  chinHeight: number;
  chinWidth: number;
  jawWidth: number;
  noseHump: number;
  noseTipWidth: number;
  lipUpper: number;
  lipLower: number;
  lipProjection: number;
  lipCorners: number;
  cheekbone: number;
  cheekVolume: number;
  buccal: number;
}

export const NEUTRAL_SIMULATION: Readonly<SimulationParameters> = Object.freeze({
  noseRadix: 0, noseBridge: 0, noseTip: 0, noseRotation: 0, noseWidth: 0, noseSymmetry: 0,
  chinProjection: 0, chinHeight: 0, chinWidth: 0, jawWidth: 0,
  noseHump: 0, noseTipWidth: 0, lipUpper: 0, lipLower: 0, lipProjection: 0, lipCorners: 0,
  cheekbone: 0, cheekVolume: 0, buccal: 0,
});

export type SimulationGroup = 'Nariz' | 'Labios' | 'Pómulos y mejillas' | 'Mentón y mandíbula';
export const SIMULATION_GROUPS: ReadonlyArray<SimulationGroup> = ['Nariz', 'Labios', 'Pómulos y mejillas', 'Mentón y mandíbula'];
export const SIMULATION_CONTROLS: ReadonlyArray<{
  key: keyof SimulationParameters; label: string; group: SimulationGroup; hint?: string;
}> = [
  { key: 'noseRadix', label: 'Raíz · relieve', group: 'Nariz', hint: '− retrae / + adelanta la raíz entre los ojos, sin moverlos.' },
  { key: 'noseBridge', label: 'Dorso · proyección', group: 'Nariz', hint: '− retrae / + adelanta el dorso y acompaña la raíz; transición suave hacia la punta.' },
  { key: 'noseHump', label: 'Dorso · giba (− rebaja)', group: 'Nariz', hint: '− rebaja / + realza solo la giba central; no hunde ni proyecta toda la nariz.' },
  { key: 'noseTip', label: 'Punta · proyección', group: 'Nariz', hint: '− acerca / + aleja la punta del rostro, sin elevarla.' },
  { key: 'noseRotation', label: 'Punta · rotación', group: 'Nariz', hint: '− baja / + eleva la punta alrededor de un pivote posterior; no es proyección.' },
  { key: 'noseTipWidth', label: 'Punta · anchura', group: 'Nariz', hint: '− estrecha / + ensancha la punta, no las alas.' },
  { key: 'noseWidth', label: 'Alas · anchura', group: 'Nariz', hint: '− aproxima / + separa las alas, no la raíz.' },
  { key: 'lipUpper', label: 'Labio superior · volumen', group: 'Labios' },
  { key: 'lipLower', label: 'Labio inferior · volumen', group: 'Labios' },
  { key: 'lipProjection', label: 'Labios · proyección', group: 'Labios' },
  { key: 'lipCorners', label: 'Comisuras · elevación', group: 'Labios' },
  { key: 'cheekbone', label: 'Pómulo · proyección malar', group: 'Pómulos y mejillas' },
  { key: 'cheekVolume', label: 'Mejilla media · volumen', group: 'Pómulos y mejillas' },
  { key: 'buccal', label: 'Mejilla inferior · volumen bucal', group: 'Pómulos y mejillas' },
  { key: 'chinProjection', label: 'Mentón · proyección', group: 'Mentón y mandíbula' },
  { key: 'chinHeight', label: 'Mentón · altura', group: 'Mentón y mandíbula' },
  { key: 'chinWidth', label: 'Mentón · anchura', group: 'Mentón y mandíbula' },
  { key: 'jawWidth', label: 'Mandíbula · anchura', group: 'Mentón y mandíbula' },
];

export const SIMULATION_NOTICE = 'Simulación ilustrativa educativa: no representa medidas ni predice resultados clínicos. Las combinaciones se moderan si comprometen la superficie.';

export type LayerId = 'skin';
export const SIMULATION_LAYERS: ReadonlyArray<{
  id: LayerId; label: string; color: string; depth: number; opacity: number;
}> = [
  { id: 'skin', label: 'Piel', color: '#d9ac91', depth: 0, opacity: 0.38 },
];

export interface SimulationMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Siempre mesh468, incluso si positions contiene la cabeza genérica completa. */
  anchors: Float32Array;
  uvs?: Float32Array;
  source: 'personal' | 'generic';
  observedIndexCount?: number;
  /** Tono de la zona inferida (p. ej. cabello muestreado); gris por defecto. */
  inferredColor?: string;
  /** Tono de piel para la zona inferida bajo la línea de la nuca. */
  inferredSkinColor?: string;
}
export interface MeshBounds { min: Vec3; max: Vec3; center: Vec3; height: number }
export interface LayerGeometry {
  id: LayerId;
  positions: Float32Array;
  indices: Uint32Array;
  colors?: Float32Array;
}
export interface SimulationCut {
  scope: 'none' | 'skin' | 'all';
  axis: 'x' | 'y' | 'z';
  /** Fracción del tamaño del modelo, 0..1. */
  position: number;
  reverse: boolean;
}
export interface CutPlane { normal: Vec3; constant: number }
export interface FacialCoordinateFrame {
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

const clamp = (n: number, min: number, max: number) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
const point = (p: ArrayLike<number>, i: number): Vec3 => ({ x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const unit = (p: Vec3): Vec3 => {
  const d = Math.hypot(p.x, p.y, p.z) || 1;
  return { x: p.x / d, y: p.y / d, z: p.z / d };
};

export function sanitizeSimulation(input: Partial<SimulationParameters>): SimulationParameters {
  const out = { ...NEUTRAL_SIMULATION };
  for (const { key } of SIMULATION_CONTROLS) out[key] = clamp(input[key] ?? 0, -1, 1);
  // Control direccional aparte: no es un campo de aumento/reducción como los anteriores.
  out.noseSymmetry = clamp(input.noseSymmetry ?? 0, -1, 1);
  return out;
}

/**
 * PersonalProjection describe el chart de la FOTO, no una pose anatómica.
 * Un perfil viene en coordenadas de cámara: se obtiene una base rígida de las
 * anclas, sin deducir orientación a partir del ancho de la foto ni girar sus UV.
 */
export function personalFaceFrame(surface: Pick<PersonalSurface, 'positions'>): FacialCoordinateFrame {
  const p = surface.positions, left = point(p, 33), rightEye = point(p, 263);
  const origin = { x: (left.x + rightEye.x) / 2, y: (left.y + rightEye.y) / 2, z: (left.z + rightEye.z) / 2 };
  const vertical = sub(point(p, 10), point(p, 152)), height = Math.hypot(vertical.x, vertical.y, vertical.z);
  let lateral = sub(rightEye, left);
  if (Math.hypot(lateral.x, lateral.y, lateral.z) < height * 0.02) {
    lateral = sub(point(p, 454), point(p, 234));
  }
  const right = unit(lateral), projection = dot(vertical, right);
  const upVector = { x: vertical.x - right.x * projection, y: vertical.y - right.y * projection, z: vertical.z - right.z * projection };
  if (height < 1e-6 || Math.hypot(lateral.x, lateral.y, lateral.z) < height * 0.02
    || Math.hypot(upVector.x, upVector.y, upVector.z) < height * 0.2) {
    throw new Error('Las anclas no permiten orientar la superficie facial.');
  }
  const up = unit(upVector);
  let forward = unit(cross(right, up));
  const cheeks = {
    x: (p[234 * 3] + p[454 * 3]) / 2,
    y: (p[234 * 3 + 1] + p[454 * 3 + 1]) / 2,
    z: (p[234 * 3 + 2] + p[454 * 3 + 2]) / 2,
  };
  if (dot(sub(point(p, 1), cheeks), forward) < 0) {
    forward = { x: -forward.x, y: -forward.y, z: -forward.z };
  }
  return { origin, right, up, forward };
}

export function toCanonicalPosition(p: Vec3, frame: FacialCoordinateFrame): Vec3 {
  const relative = sub(p, frame.origin);
  return { x: dot(relative, frame.right), y: dot(relative, frame.up), z: dot(relative, frame.forward) };
}

/** Inversa rígida: permite volver al chart de PersonalProjection sin perder su correspondencia. */
export function fromCanonicalPosition(p: Vec3, frame: FacialCoordinateFrame): Vec3 {
  return {
    x: frame.origin.x + frame.right.x * p.x + frame.up.x * p.y + frame.forward.x * p.z,
    y: frame.origin.y + frame.right.y * p.x + frame.up.y * p.y + frame.forward.y * p.z,
    z: frame.origin.z + frame.right.z * p.x + frame.up.z * p.y + frame.forward.z * p.z,
  };
}

export function meshBounds(positions: ArrayLike<number>, indices?: ArrayLike<number>): MeshBounds {
  if (positions.length < 3 || positions.length % 3) throw new Error('Superficie facial incompleta.');
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let j = 0; j < (indices?.length ?? positions.length / 3); j++) {
    const i = (indices ? indices[j] : j) * 3;
    for (const [offset, axis] of ['x', 'y', 'z'].entries()) {
      const key = axis as keyof Vec3, value = positions[i + offset];
      if (!Number.isFinite(value)) throw new Error('La superficie contiene coordenadas no finitas.');
      min[key] = Math.min(min[key], value); max[key] = Math.max(max[key], value);
    }
  }
  const height = max.y - min.y;
  if (height <= 1e-8) throw new Error('La superficie facial no tiene altura.');
  return { min, max, height, center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 } };
}

/** Copias propias: jamás se mutan buffers del llamador ni el atlas compartido. */
export function createSimulationMesh(surface?: PersonalSurface & { observedIndexCount?: number; inferredColor?: string; inferredSkinColor?: string }): SimulationMesh {
  if (surface) {
    if (surface.positions.length < 468 * 3 || surface.indices.length < 3 || surface.indices.length % 3
      || surface.uvs.length !== surface.positions.length / 3 * 2
      || !surface.uvs.every(Number.isFinite)
      || !surface.indices.every(i => Number.isInteger(i) && i >= 0 && i < surface.positions.length / 3)) {
      throw new Error('La superficie personal no es compatible con mesh468.');
    }
    meshBounds(surface.positions);
    const projection = surface.projection;
    if (!projection || ![projection.cx, projection.cy, projection.k, projection.aspect].every(Number.isFinite)
      || projection.k <= 0 || projection.aspect <= 0) {
      throw new Error('La proyección de la superficie personal no es válida.');
    }
    const frame = personalFaceFrame(surface), positions = surface.positions.slice();
    if (surface.observedIndexCount !== undefined && (!Number.isInteger(surface.observedIndexCount)
      || surface.observedIndexCount < 3 || surface.observedIndexCount % 3 || surface.observedIndexCount >= surface.indices.length)) {
      throw new Error('La separación de superficie observada y estimada no es válida.');
    }
    for (let i = 0; i < positions.length / 3; i++) {
      const p = toCanonicalPosition(point(surface.positions, i), frame);
      positions.set([p.x, p.y, p.z], i * 3);
    }
    return {
      positions, indices: surface.indices.slice(), anchors: positions.slice(0, 468 * 3),
      uvs: surface.uvs.slice(), source: 'personal',
      observedIndexCount: surface.observedIndexCount, inferredColor: surface.inferredColor, inferredSkinColor: surface.inferredSkinColor,
    };
  }
  const full = atlasData.surface;
  return {
    positions: Float32Array.from(full.positions), indices: Uint32Array.from(full.triangles),
    anchors: Float32Array.from(atlasData.positions), source: 'generic',
  };
}

function facialFrame(anchors: ArrayLike<number>) {
  const top = point(anchors, 10), chin = point(anchors, 152);
  const height = Math.max(Math.hypot(top.x - chin.x, top.y - chin.y, top.z - chin.z), 1e-6);
  const axis = (top.x + chin.x + point(anchors, 1).x) / 3;
  const average = (ids: number[]): Vec3 => {
    const p = ids.reduce((a, i) => {
      const b = point(anchors, i);
      return { x: a.x + b.x / ids.length, y: a.y + b.y / ids.length, z: a.z + b.z / ids.length };
    }, { x: 0, y: 0, z: 0 });
    return p;
  };
  return { height, axis, average };
}

/** Wendland C2 de soporte compacto: cero exacto fuera de la zona local. */
export function localInfluence(p: Vec3, center: Vec3, radius: Vec3): number {
  const r = Math.hypot((p.x - center.x) / radius.x, (p.y - center.y) / radius.y, (p.z - center.z) / radius.z);
  return r < 1 ? (1 - r) ** 4 * (4 * r + 1) : 0;
}

/** Correspondencias topológicas del atlas, no búsqueda de vecinos en una nariz ya asimétrica. */
const atlasMirrors = (() => {
  // Pares mesh468 del soporte nasal. La búsqueda geométrica intercambiaba
  // vecinos de las narinas (238→461 en lugar de 458) e invertía su superficie.
  // No inferirlos por triangulación: algunos cuadriláteros tienen diagonales distintas.
  const pairs = [
    [3, 248], [20, 250], [44, 274], [45, 275], [47, 277], [48, 278], [49, 279],
    [51, 281], [59, 289], [60, 290], [64, 294], [75, 305], [79, 309], [97, 326],
    [98, 327], [99, 328], [100, 329], [102, 331], [114, 343], [115, 344],
    [121, 350], [122, 351], [125, 354], [126, 355], [128, 357], [129, 358],
    [131, 360], [134, 363], [141, 370], [142, 371], [166, 392], [174, 399],
    [188, 412], [189, 413], [193, 417], [196, 419], [198, 420], [203, 423],
    [209, 429], [217, 437], [218, 438], [219, 439], [220, 440], [235, 455],
    [236, 456], [237, 457], [238, 458], [239, 459], [240, 460], [241, 461],
    [242, 462], [244, 464], [245, 465],
  ];
  const result = Array.from({ length: 468 }, (_, i) => i);
  for (const [a, b] of pairs) { result[a] = b; result[b] = a; }
  return result;
})();
const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

function nasalSymmetryDeltas(anchors: ArrayLike<number>, signed: number) {
  const frame = personalFaceFrame({ positions: Float32Array.from(anchors) });
  const deltas = new Float32Array(468 * 3), masks = new Float32Array(468), sides = new Float32Array(468);
  for (let i = 0; i < 468; i++) {
    const atlas = point(atlasData.positions, i), source = atlasMirrors[i];
    // Soporte limitado a nariz, con transición C1 hacia mejillas, glabela y labio.
    const mask = smooth((0.42 - Math.abs(atlas.x)) / 0.14)
      * smooth((atlas.y - 0.015) / 0.055) * smooth((0.89 - atlas.y) / 0.15)
      * smooth((atlas.z - 1.36) / 0.10);
    const side = source === i ? 0.5 : smooth(0.5 + Math.sign(signed) * atlas.x / 0.10);
    masks[i] = mask; sides[i] = side;
    if (!mask || !side) continue;
    const p = point(anchors, i), q = toCanonicalPosition(point(anchors, source), frame);
    const mirrored = fromCanonicalPosition({ ...q, x: -q.x }, frame);
    const w = Math.abs(signed) * mask * side;
    deltas.set([(mirrored.x - p.x) * w, (mirrored.y - p.y) * w, (mirrored.z - p.z) * w], i * 3);
  }
  return { deltas, masks, sides, frame };
}

/**
 * Segunda pasada: los landmarks ya quedaron espejados; ahora el relieve denso del lado destino
 * se reemplaza por el del hemimallado origen reflejado (no interpolado desde 468 anclas).
 * Solo cambia la profundidad canónica: XY/UV quedan intactos y no aparecen costuras ni pliegues.
 * El peso es C1 y se anula en la línea media; la identidad fija los bordes sin vecinos.
 */
function copyNasalHalf(
  result: Float32Array, dense: Uint8Array, mask: Float32Array, side: Float32Array,
  frame: FacialCoordinateFrame, strength: number, h: number, normals?: Float32Array,
) {
  const n = result.length / 3, r = h * 0.04, canonical = new Float32Array(result.length);
  const canonicalNormals = normals ? new Float32Array(normals.length) : null;
  for (let i = 0; i < n; i++) {
    const c = toCanonicalPosition(point(result, i), frame);
    canonical.set([c.x, c.y, c.z], i * 3);
    if (normals) {
      const normal = point(normals, i);
      canonicalNormals!.set([dot(normal, frame.right), dot(normal, frame.up), dot(normal, frame.forward)], i * 3);
    }
  }
  // Rejilla 2D en el plano frontal canónico: la profundidad del destino no debe sesgar la búsqueda.
  const grid = new Map<string, number[]>(), key = (x: number, y: number) => `${Math.floor(x / r)},${Math.floor(y / r)}`;
  for (let i = 0; i < n; i++) if (mask[i] > 0 && side[i] < 0.5) {
    const k = key(canonical[i * 3], canonical[i * 3 + 1]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  for (let i = 0; i < n; i++) {
    if (!dense[i] || side[i] <= 0.5 || !mask[i]) continue;
    const x = -canonical[i * 3], y = canonical[i * 3 + 1], z = canonical[i * 3 + 2];
    // Un peso de identidad evita saltos al entrar/salir del soporte de vecinos.
    let weight = 4 / (r * r), depth = z * weight;
    const gx = Math.floor(x / r), gy = Math.floor(y / r);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const j of grid.get(`${gx + a},${gy + b}`) ?? []) {
        if (canonicalNormals) {
          const source = point(canonicalNormals, j), target = point(canonicalNormals, i);
          if (-source.x * target.x + source.y * target.y + source.z * target.z < 0.5) continue;
        }
        const d = Math.hypot(canonical[j * 3] - x, canonical[j * 3 + 1] - y);
        // No saltar entre hojas de la narina/dorso que comparten XY.
        // Caída continua en profundidad: el umbral binario anterior creaba escalones.
        const dz = Math.abs(canonical[j * 3 + 2] - z);
        if (d >= r || dz >= r * 0.8) continue;
        const w = (1 - d / r) ** 4 / Math.max(d * d, r * r * 1e-8)
          * smooth((r * 0.8 - dz) / (r * 0.3));
        weight += w; depth += canonical[j * 3 + 2] * w;
      }
    }
    if (!weight) continue;
    const t = strength * mask[i] * smooth((side[i] - 0.5) / 0.25);
    const next = fromCanonicalPosition({ x: -x, y, z: z + (depth / weight - z) * t }, frame);
    result.set([next.x, next.y, next.z], i * 3);
  }
}

/**
 * Límite analítico, sin iterar ni recalcular la deformación. El área orientada de
 * cada triángulo durante original→resultado es un polinomio cuadrático en t.
 * Acotar antes de su primera raíz conserva al menos 10% del área proyectada.
 * No repara triángulos degenerados que ya existían en la captura.
 */
function preserveTriangleOrientation(original: ArrayLike<number>, result: Float32Array, indices: ArrayLike<number>) {
  let strength = 1;
  for (let k = 0; k < indices.length; k += 3) {
    const ids = [indices[k], indices[k + 1], indices[k + 2]];
    if (ids.every(i => result[i * 3] === original[i * 3] && result[i * 3 + 1] === original[i * 3 + 1]
      && result[i * 3 + 2] === original[i * 3 + 2])) continue;
    const [a, b, c] = ids.map(i => point(original, i));
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), area2 = dot(n, n);
    if (area2 < 1e-20) continue;
    const [da, db, dc] = ids.map(i => sub(point(result, i), point(original, i)));
    const dab = sub(db, da), dac = sub(dc, da);
    const linear = (dot(n, cross(dab, ac)) + dot(n, cross(ab, dac))) / area2;
    const quadratic = dot(n, cross(dab, dac)) / area2;
    const roots: number[] = [];
    if (Math.abs(quadratic) < 1e-12) {
      if (linear < 0) roots.push(-0.9 / linear);
    } else {
      const discriminant = linear * linear - 3.6 * quadratic;
      if (discriminant >= 0) {
        const sqrt = Math.sqrt(discriminant);
        roots.push((-linear - sqrt) / (2 * quadratic), (-linear + sqrt) / (2 * quadratic));
      }
    }
    for (const root of roots) if (root > 0 && root <= strength) strength = root * 0.98;
  }
  if (strength < 1) for (let i = 0; i < result.length; i++) {
    result[i] = original[i] + (result[i] - original[i]) * strength;
  }
}

/** Evalúa siempre contra el original. +Z es anterior, +Y superior en PersonalSurface/atlas. */
export function deformPositions(
  original: ArrayLike<number>, anchors: ArrayLike<number>, input: Partial<SimulationParameters>,
  /** Topología de original (no de anchors); necesaria para proteger superficies densas propias. */
  indices?: ArrayLike<number>,
): Float32Array {
  if (anchors.length < 468 * 3) throw new Error('Faltan anclas mesh468.');
  meshBounds(original);
  const params = sanitizeSimulation(input);
  if (Object.values(params).every(value => value === 0)) return Float32Array.from(original);
  const topology = indices ?? (original.length === atlasData.surface.positions.length ? atlasData.surface.triangles : undefined);
  const { height: h, axis, average } = facialFrame(anchors);
  type Field = {
    center: Vec3; radius: Vec3; delta: (p: Vec3) => Vec3; protectedCenters: Vec3[];
    influence?: (p: Vec3) => number;
    protectNasal?: boolean;
  };
  const fields: Field[] = [];
  const jawAnchors = [152, 175, 199, 172, 136, 150, 149, 176, 148, 397, 365, 379, 378, 400, 377];
  const softAnchors = [0, 13, 14, 17, 61, 291, 117, 50, 346, 280, 205, 187, 425, 411, 214, 192, 434, 416];
  const eyeAnchors = [33, 263, 159, 386, 145, 374];
  const nasalProtectedAnchors = [...eyeAnchors, 0, 13, 14, 17, 61, 291];
  const add = (
    ids: number[], radius: [number, number, number], delta: Field['delta'],
    protect: number[] = [], protectNasal = false,
  ) => {
    fields.push({ center: average(ids), radius: { x: radius[0] * h, y: radius[1] * h, z: radius[2] * h }, delta,
      protectedCenters: protect.map(id => point(anchors, id)), protectNasal });
  };
  // Magnitudes acotadas por subzona; no son milímetros ni rangos quirúrgicos.
  const tip = average([1, 4]);
  const radix = average([168]), upperBridge = average([6]), supratip = average([5]);
  // C2 tanto en los extremos longitudinales como en el borde lateral.
  const ramp = (t: number) => { const x = clamp(t, 0, 1); return x ** 3 * (10 + x * (-15 + 6 * x)); };
  const nasalLateral = (p: Vec3) => ramp((h * 0.14 - Math.abs(p.x - axis)) / (h * 0.10));
  const dorsalEnvelope = (p: Vec3) => ramp((p.y - (tip.y - h * 0.04)) / (h * 0.20))
    * ramp((radix.y + h * 0.22 - p.y) / (h * 0.22))
    * nasalLateral(p)
    * ramp((p.z - (upperBridge.z - h * 0.22)) / (h * 0.12));
  if (params.noseRadix || params.noseBridge || params.noseHump) {
    // La giba termina exactamente en 5/6: raíz, suprapunta, punta y alas quedan fuera.
    const humpSpan = Math.max(upperBridge.y - supratip.y, h * 0.02);
    fields.push({
      center: tip, radius: { x: h, y: h, z: h },
      delta: p => {
        const t = clamp((p.y - supratip.y) / humpSpan, 0, 1);
        const humpWeight = 64 * (t * (1 - t)) ** 3;
        const radixWeight = ramp((p.y - supratip.y) / Math.max(radix.y - supratip.y, h * 0.08))
          * ramp((radix.y + h * 0.18 - p.y) / (h * 0.18));
        return {
          x: 0, y: 0,
          // Giba ≤0.8% de altura facial y además ≤7% del tramo 5→6.
          z: h * (params.noseBridge * 0.035 + params.noseRadix * 0.015 * radixWeight)
            + params.noseHump * Math.min(h * 0.008, humpSpan * 0.07) * humpWeight,
        };
      },
      protectedCenters: [], protectNasal: true,
      influence: dorsalEnvelope,
    });
  }
  const angle = params.noseRotation * 0.18, sin = Math.sin(angle), cos = Math.cos(angle);
  if (params.noseTip || params.noseRotation) add([1, 4], [0.18, 0.22, 0.28], p => {
    // Pivot posterior a la punta, no giro global de la nariz.
    const y = p.y - tip.y, z = p.z - (tip.z - h * 0.065);
    return {
      x: 0, y: y * (cos - 1) + z * sin,
      z: params.noseTip * h * 0.04 - y * sin + z * (cos - 1),
    };
  }, [], true);
  if (params.noseTipWidth) add([1, 4], [0.09, 0.08, 0.12], p => ({ x: params.noseTipWidth * (p.x - tip.x) * 0.65, y: 0, z: 0 }), [], true);
  if (params.noseWidth) for (const id of [98, 327]) add([id], [0.13, 0.14, 0.18], p => ({
    x: params.noseWidth * (p.x - axis) * 0.45, y: 0, z: 0,
  }), [], true);
  const mouth = average([13, 14]);
  if (params.lipUpper) add([0, 13], [0.17, 0.055, 0.10], p => ({
    x: 0, y: params.lipUpper * h * 0.012 * Math.tanh((p.y - mouth.y) / (h * 0.012)), z: params.lipUpper * h * 0.03,
  }), jawAnchors);
  if (params.lipLower) add([14, 17], [0.16, 0.06, 0.10], p => ({
    x: 0, y: params.lipLower * h * 0.012 * Math.tanh((p.y - mouth.y) / (h * 0.012)), z: params.lipLower * h * 0.032,
  }), jawAnchors);
  if (params.lipProjection) add([13, 14], [0.20, 0.10, 0.12], () => ({ x: 0, y: 0, z: params.lipProjection * h * 0.035 }), jawAnchors);
  if (params.lipCorners) for (const id of [61, 291]) add([id], [0.05, 0.05, 0.08], () => ({ x: 0, y: params.lipCorners * h * 0.025, z: 0 }), jawAnchors);
  if (params.cheekbone) for (const ids of [[117, 50], [346, 280]]) add(ids, [0.14, 0.12, 0.16], p => ({
    x: params.cheekbone * (p.x - axis) * 0.07, y: params.cheekbone * h * 0.008, z: params.cheekbone * h * 0.045,
  }), jawAnchors);
  if (params.cheekVolume) for (const ids of [[205, 187], [425, 411]]) add(ids, [0.15, 0.14, 0.18], p => ({
    x: params.cheekVolume * (p.x - axis) * 0.06, y: 0, z: params.cheekVolume * h * 0.04,
  }), jawAnchors);
  if (params.buccal) for (const ids of [[214, 192], [434, 416]]) add(ids, [0.13, 0.12, 0.18], p => ({
    x: params.buccal * (p.x - axis) * 0.09, y: 0, z: params.buccal * h * 0.012,
  }), jawAnchors);
  if (params.chinWidth || params.chinHeight || params.chinProjection) add([152, 175, 199], [0.32, 0.27, 0.32], p => ({
    x: params.chinWidth * (p.x - axis) * 0.48,
    y: -params.chinHeight * h * 0.07, z: params.chinProjection * h * 0.085,
  }), softAnchors);
  if (params.jawWidth) for (const ids of [[172, 136], [397, 365]]) add(ids, [0.23, 0.20, 0.24], p => ({
    x: params.jawWidth * (p.x - axis) * 0.32, y: 0, z: 0,
  }), softAnchors);
  const result = Float32Array.from(original);
  const nasal = params.noseSymmetry ? nasalSymmetryDeltas(anchors, params.noseSymmetry) : null;
  const symmetry = nasal?.deltas, count = original.length / 3;
  const radius = h * 0.075;
  // Fuera de este soporte todos los vecinos tienen máscara y delta nasales cero.
  const nasalSupport = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity, back: Infinity, front: -Infinity };
  if (nasal) for (let i = 0; i < 468; i++) if (nasal.masks[i] > 0) {
    const p = point(anchors, i);
    nasalSupport.left = Math.min(nasalSupport.left, p.x - radius); nasalSupport.right = Math.max(nasalSupport.right, p.x + radius);
    nasalSupport.bottom = Math.min(nasalSupport.bottom, p.y - radius); nasalSupport.top = Math.max(nasalSupport.top, p.y + radius);
    nasalSupport.back = Math.min(nasalSupport.back, p.z - radius); nasalSupport.front = Math.max(nasalSupport.front, p.z + radius);
  }
  const vertexMask = new Float32Array(nasal ? count : 0), vertexSide = new Float32Array(vertexMask.length);
  const dense = new Uint8Array(vertexMask.length);
  const nasalProtectedCenters = nasalProtectedAnchors.map(id => point(anchors, id));
  const nasalProtectionRadius = { x: h * 0.055, y: h * 0.055, z: h * 0.09 };
  for (let i = 0; i < original.length / 3; i++) {
    const p = point(original, i);
    let nasalProtection: number | undefined;
    for (const field of fields) {
      let w = field.influence ? field.influence(p) : localInfluence(p, field.center, field.radius);
      if (!w) continue;
      // Máscara espacial suave: sirve también para vértices densos, no sólo mesh468.
      if (field.protectNasal) {
        if (nasalProtection === undefined) {
          nasalProtection = 1;
          for (const center of nasalProtectedCenters) {
            const dx = (p.x - center.x) / nasalProtectionRadius.x;
            const dy = (p.y - center.y) / nasalProtectionRadius.y;
            const dz = (p.z - center.z) / nasalProtectionRadius.z;
            if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1 || Math.abs(dz) >= 1) continue;
            const distance = Math.hypot(dx, dy, dz);
            if (distance < 1) nasalProtection *= 1 - (1 - distance) ** 4 * (4 * distance + 1);
          }
        }
        w *= nasalProtection;
      } else {
        for (const center of field.protectedCenters) {
          w *= 1 - localInfluence(p, center, nasalProtectionRadius);
        }
      }
      if (!w) continue;
      const d = field.delta(p);
      result[i * 3] += d.x * w; result[i * 3 + 1] += d.y * w; result[i * 3 + 2] += d.z * w;
    }
    if (symmetry) {
      if (i < 468 && p.x === anchors[i * 3] && p.y === anchors[i * 3 + 1] && p.z === anchors[i * 3 + 2]) {
        for (let axis = 0; axis < 3; axis++) result[i * 3 + axis] += symmetry[i * 3 + axis];
        vertexMask[i] = nasal!.masks[i]; vertexSide[i] = nasal!.sides[i];
      } else if (p.x >= nasalSupport.left && p.x <= nasalSupport.right && p.y >= nasalSupport.bottom
        && p.y <= nasalSupport.top && p.z >= nasalSupport.back && p.z <= nasalSupport.front) {
        // Extensión continua a superficies densas. Los vecinos con delta cero fijan el borde.
        let weight = 0, mask = 0, side = 0;
        const delta = [0, 0, 0];
        for (let j = 0; j < 468; j++) {
          const q = point(anchors, j), distance = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
          if (distance >= radius) continue;
          const w = (1 - distance / radius) ** 4 / Math.max(distance ** 2, h * h * 1e-12);
          weight += w; mask += nasal!.masks[j] * w; side += nasal!.sides[j] * w;
          for (let axis = 0; axis < 3; axis++) delta[axis] += symmetry[j * 3 + axis] * w;
        }
        if (weight) for (let axis = 0; axis < 3; axis++) result[i * 3 + axis] += delta[axis] / weight;
        if (weight) { vertexMask[i] = mask / weight; vertexSide[i] = side / weight; dense[i] = 1; }
      }
    }
  }
  if (nasal && dense.some(value => value !== 0)) {
    copyNasalHalf(result, dense, vertexMask, vertexSide, nasal.frame, Math.abs(params.noseSymmetry), h,
      topology ? vertexNormals(original, topology) : undefined);
  }
  if (topology && (params.noseRadix || params.noseBridge || params.noseHump || params.noseTip
    || params.noseRotation || params.noseTipWidth || params.noseWidth || params.noseSymmetry)) {
    preserveTriangleOrientation(original, result, topology);
  }
  return result;
}

export function vertexNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = point(positions, indices[i]), b = point(positions, indices[i + 1]), c = point(positions, indices[i + 2]);
    const n = cross(sub(b, a), sub(c, a));
    for (let j = 0; j < 3; j++) {
      const index = indices[i + j] * 3;
      normals[index] += n.x; normals[index + 1] += n.y; normals[index + 2] += n.z;
    }
  }
  for (let i = 0; i < normals.length / 3; i++) {
    const n = unit(point(normals, i));
    normals.set([n.x, n.y, n.z], i * 3);
  }
  return normals;
}

/** Sólo piel, evaluada desde el original y con buffers propios en cada llamada. */
export function buildSimulationLayers(mesh: SimulationMesh, input: Partial<SimulationParameters>): LayerGeometry[] {
  // ponytail: piel sin generador ni caché multicapa → imágenes anatómicas en su módulo.
  return [{
    id: 'skin',
    positions: deformPositions(mesh.positions, mesh.anchors, input, mesh.indices),
    indices: mesh.indices.slice(),
  }];
}

/** Preparación facial para referencias: la cabeza genérica completa NO es una malla mesh468. */
export function buildSimulationReferenceSurface(
  mesh: SimulationMesh, input: Partial<SimulationParameters>,
): { positions: Float32Array; indices: Uint32Array } {
  return mesh.source === 'generic'
    ? { positions: deformPositions(mesh.anchors, mesh.anchors, input, atlasData.triangles), indices: Uint32Array.from(atlasData.triangles) }
    : {
      positions: deformPositions(mesh.positions, mesh.anchors, input, mesh.indices),
      indices: mesh.indices.slice(0, mesh.observedIndexCount ?? mesh.indices.length),
    };
}

/** Convención de Three.Plane: se conserva normal·p + constant >= 0. */
export function buildCutPlane(bounds: MeshBounds, cut: SimulationCut): CutPlane | null {
  if (cut.scope === 'none') return null;
  const axis = cut.axis, sign = cut.reverse ? -1 : 1;
  // Margen para poder revelar/ocultar completamente la superficie.
  const margin = bounds.height * 0.04;
  const value = bounds.min[axis] - margin
    + clamp(cut.position, 0, 1) * (bounds.max[axis] - bounds.min[axis] + margin * 2);
  return { normal: { x: 0, y: 0, z: 0, [axis]: sign }, constant: -value * sign };
}

export function isPointRetained(p: Vec3, plane: CutPlane | null): boolean {
  return !plane || p.x * plane.normal.x + p.y * plane.normal.y + p.z * plane.normal.z + plane.constant >= -1e-8;
}
