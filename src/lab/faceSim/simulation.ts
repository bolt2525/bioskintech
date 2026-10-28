import atlasData from './genericFaceAtlas.json' with { type: 'json' };
import type { PersonalSurface, Vec3 } from './engine';

/** Intensidades visuales adimensionales, no medidas ni predicciones clínicas. */
export interface SimulationParameters {
  noseBridge: number;
  noseTip: number;
  noseRotation: number;
  noseWidth: number;
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
  noseBridge: 0, noseTip: 0, noseRotation: 0, noseWidth: 0,
  chinProjection: 0, chinHeight: 0, chinWidth: 0, jawWidth: 0,
  noseHump: 0, noseTipWidth: 0, lipUpper: 0, lipLower: 0, lipProjection: 0, lipCorners: 0,
  cheekbone: 0, cheekVolume: 0, buccal: 0,
});

export type SimulationGroup = 'Nariz' | 'Labios' | 'Pómulos y mejillas' | 'Mentón y mandíbula';
export const SIMULATION_GROUPS: ReadonlyArray<SimulationGroup> = ['Nariz', 'Labios', 'Pómulos y mejillas', 'Mentón y mandíbula'];
export const SIMULATION_CONTROLS: ReadonlyArray<{
  key: keyof SimulationParameters; label: string; group: SimulationGroup;
}> = [
  { key: 'noseBridge', label: 'Dorso · proyección', group: 'Nariz' },
  { key: 'noseHump', label: 'Dorso · giba (− rebaja)', group: 'Nariz' },
  { key: 'noseTip', label: 'Punta · proyección', group: 'Nariz' },
  { key: 'noseRotation', label: 'Punta · rotación', group: 'Nariz' },
  { key: 'noseTipWidth', label: 'Punta · anchura', group: 'Nariz' },
  { key: 'noseWidth', label: 'Alas · anchura', group: 'Nariz' },
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

export type LayerId = 'skin' | 'fat' | 'muscle' | 'nerves' | 'vessels';
export const SIMULATION_LAYERS: ReadonlyArray<{
  id: LayerId; label: string; color: string; depth: number; opacity: number;
}> = [
  { id: 'skin', label: 'Piel', color: '#d9ac91', depth: 0, opacity: 0.38 },
  { id: 'fat', label: 'Grasa genérica', color: '#e5c355', depth: 0.012, opacity: 0.18 },
  { id: 'muscle', label: 'Músculos esquemáticos', color: '#d95168', depth: 0.027, opacity: 0.85 },
  { id: 'nerves', label: 'Nervios · trayectos genéricos', color: '#fde047', depth: 0.019, opacity: 1 },
  { id: 'vessels', label: 'Vasos · trayectos genéricos', color: '#fb7185', depth: 0.021, opacity: 1 },
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
const push = (out: number[], p: Vec3) => out.push(p.x, p.y, p.z);

export function sanitizeSimulation(input: Partial<SimulationParameters>): SimulationParameters {
  const out = { ...NEUTRAL_SIMULATION };
  for (const { key } of SIMULATION_CONTROLS) out[key] = clamp(input[key] ?? 0, -1, 1);
  return out;
}

/**
 * PersonalProjection describe el chart de la FOTO, no una pose anatómica.
 * Un perfil viene en coordenadas de cámara: se obtiene una base rígida de las
 * anclas, sin deducir orientación a partir del ancho de la foto ni girar sus UV.
 */
export function personalFaceFrame(surface: PersonalSurface): FacialCoordinateFrame {
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

/** Evalúa siempre contra el original. +Z es anterior, +Y superior en PersonalSurface/atlas. */
export function deformPositions(
  original: ArrayLike<number>, anchors: ArrayLike<number>, input: Partial<SimulationParameters>,
): Float32Array {
  if (anchors.length < 468 * 3) throw new Error('Faltan anclas mesh468.');
  meshBounds(original);
  const params = sanitizeSimulation(input), { height: h, axis, average } = facialFrame(anchors);
  type Field = { center: Vec3; radius: Vec3; delta: (p: Vec3) => Vec3; protectedCenters: Vec3[] };
  const fields: Field[] = [];
  const jawAnchors = [152, 175, 199, 172, 136, 150, 149, 176, 148, 397, 365, 379, 378, 400, 377];
  const softAnchors = [0, 13, 14, 17, 61, 291, 117, 50, 346, 280, 205, 187, 425, 411, 214, 192, 434, 416];
  const add = (ids: number[], radius: [number, number, number], delta: Field['delta'], protect: number[] = []) => {
    fields.push({ center: average(ids), radius: { x: radius[0] * h, y: radius[1] * h, z: radius[2] * h }, delta,
      protectedCenters: protect.map(id => point(anchors, id)) });
  };
  // Recorrido visual ampliado; no son milímetros ni rangos quirúrgicos.
  add([6, 197, 195], [0.12, 0.24, 0.20], () => ({ x: 0, y: 0, z: params.noseBridge * h * 0.09 }));
  add([197, 195], [0.075, 0.10, 0.12], () => ({ x: 0, y: 0, z: params.noseHump * h * 0.055 }));
  const tip = average([1, 4]);
  add([1, 4], [0.13, 0.16, 0.20], p => {
    const angle = params.noseRotation * 0.60;
    // Pivot posterior a la punta, no giro global de la nariz.
    const y = p.y - tip.y, z = p.z - (tip.z - h * 0.10);
    return {
      x: 0, y: y * (Math.cos(angle) - 1) + z * Math.sin(angle),
      z: params.noseTip * h * 0.11 - y * Math.sin(angle) + z * (Math.cos(angle) - 1),
    };
  });
  add([1, 4], [0.09, 0.08, 0.12], p => ({ x: params.noseTipWidth * (p.x - tip.x) * 0.65, y: 0, z: 0 }));
  for (const id of [98, 327]) add([id], [0.10, 0.11, 0.15], p => ({
    x: params.noseWidth * (p.x - axis) * 0.80, y: 0, z: 0,
  }));
  const mouth = average([13, 14]);
  add([0, 13], [0.17, 0.055, 0.10], p => ({
    x: 0, y: params.lipUpper * h * 0.012 * Math.tanh((p.y - mouth.y) / (h * 0.012)), z: params.lipUpper * h * 0.03,
  }), jawAnchors);
  add([14, 17], [0.16, 0.06, 0.10], p => ({
    x: 0, y: params.lipLower * h * 0.012 * Math.tanh((p.y - mouth.y) / (h * 0.012)), z: params.lipLower * h * 0.032,
  }), jawAnchors);
  add([13, 14], [0.20, 0.10, 0.12], () => ({ x: 0, y: 0, z: params.lipProjection * h * 0.035 }), jawAnchors);
  for (const id of [61, 291]) add([id], [0.05, 0.05, 0.08], () => ({ x: 0, y: params.lipCorners * h * 0.025, z: 0 }), jawAnchors);
  for (const ids of [[117, 50], [346, 280]]) add(ids, [0.14, 0.12, 0.16], p => ({
    x: params.cheekbone * (p.x - axis) * 0.07, y: params.cheekbone * h * 0.008, z: params.cheekbone * h * 0.045,
  }), jawAnchors);
  for (const ids of [[205, 187], [425, 411]]) add(ids, [0.15, 0.14, 0.18], p => ({
    x: params.cheekVolume * (p.x - axis) * 0.06, y: 0, z: params.cheekVolume * h * 0.04,
  }), jawAnchors);
  for (const ids of [[214, 192], [434, 416]]) add(ids, [0.13, 0.12, 0.18], p => ({
    x: params.buccal * (p.x - axis) * 0.09, y: 0, z: params.buccal * h * 0.012,
  }), jawAnchors);
  add([152, 175, 199], [0.25, 0.21, 0.24], p => ({
    x: params.chinWidth * (p.x - axis) * 0.48,
    y: -params.chinHeight * h * 0.085, z: params.chinProjection * h * 0.10,
  }), softAnchors);
  for (const ids of [[172, 136], [397, 365]]) add(ids, [0.23, 0.20, 0.24], p => ({
    x: params.jawWidth * (p.x - axis) * 0.32, y: 0, z: 0,
  }), softAnchors);
  const result = Float32Array.from(original);
  for (let i = 0; i < original.length / 3; i++) {
    const p = point(original, i);
    for (const field of fields) {
      let w = localInfluence(p, field.center, field.radius);
      if (!w) continue;
      // Máscara espacial suave: sirve también para vértices densos y capas, no sólo mesh468.
      for (const center of field.protectedCenters) {
        w *= 1 - localInfluence(p, center, { x: h * 0.055, y: h * 0.055, z: h * 0.09 });
      }
      const d = field.delta(p);
      result[i * 3] += d.x * w; result[i * 3 + 1] += d.y * w; result[i * 3 + 2] += d.z * w;
    }
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

// Diseños originales de bandas y ramificaciones. Los índices sólo sitúan el esquema
// en el chart del atlas: NO representan trayectos internos medidos ni planos clínicos.
const MUSCLE_PATHS = [
  [109, 108, 107, 66], [338, 337, 336, 296],
  [70, 63, 105, 66, 107], [300, 293, 334, 296, 336],
  [33, 160, 159, 158, 133, 153, 145, 144, 33],
  [263, 387, 386, 385, 362, 380, 374, 373, 263],
  [50, 101, 205, 61], [280, 330, 425, 291],
  [123, 147, 187, 172], [352, 376, 411, 397],
  [61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91, 61],
  [61, 57, 150], [291, 287, 379], [18, 200, 175, 152],
];
// Almohadillas volumétricas ilustrativas, no compartimentos grasos identificados.
const FAT_PATHS = [
  [116, 117, 50, 205, 187], [345, 346, 280, 425, 411],
  [123, 147, 192, 214], [352, 376, 416, 434],
  [109, 108, 67], [338, 337, 297],
];
const NERVE_PATHS = [
  [127, 123, 50, 101, 98], [123, 117, 111, 133], [127, 70, 105, 107, 108, 109],
  [123, 205, 61, 17], [205, 187, 172, 150, 152],
  [356, 352, 280, 330, 327], [352, 346, 340, 362], [356, 300, 334, 336, 337, 338],
  [352, 425, 291, 17], [425, 411, 397, 379, 152],
];
const VESSEL_PATHS = [
  [136, 58, 205, 203, 98, 64, 133, 55, 108],
  [365, 288, 425, 423, 327, 294, 362, 285, 337],
  [205, 61, 40, 37, 0], [425, 291, 270, 267, 0],
  [61, 91, 84, 17], [291, 321, 314, 17],
  [127, 54, 103, 67, 109], [356, 284, 332, 297, 338],
];

/** Interpolación baricéntrica XY sobre mesh468, profundidad según la normal local. */
function surfaceSampler(anchors: Float32Array) {
  const normals = vertexNormals(anchors, atlasData.triangles);
  const triangles: Array<{
    a: Vec3; b: Vec3; c: Vec3; area: number; ns: Vec3[];
    minX: number; maxX: number; minY: number; maxY: number;
  }> = [];
  for (let i = 0; i < atlasData.triangles.length; i += 3) {
    const ids = atlasData.triangles.slice(i, i + 3);
    const [a, b, c] = ids.map(id => point(anchors, id));
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-10) continue;
    triangles.push({
      a, b, c, area, ns: ids.map(id => point(normals, id)),
      minX: Math.min(a.x, b.x, c.x) - 1e-7, maxX: Math.max(a.x, b.x, c.x) + 1e-7,
      minY: Math.min(a.y, b.y, c.y) - 1e-7, maxY: Math.max(a.y, b.y, c.y) + 1e-7,
    });
  }
  return (x: number, y: number): { p: Vec3; n: Vec3 } | null => {
    let best: { p: Vec3; n: Vec3 } | null = null;
    for (const triangle of triangles) {
      if (x < triangle.minX || x > triangle.maxX || y < triangle.minY || y > triangle.maxY) continue;
      const { a, b, c, area, ns } = triangle;
      const v = ((x - a.x) * (c.y - a.y) - (y - a.y) * (c.x - a.x)) / area;
      const w = ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) / area;
      const u = 1 - v - w;
      if (Math.min(u, v, w) < -1e-6) continue;
      const z = a.z * u + b.z * v + c.z * w;
      if (best && z <= best.p.z) continue;
      let n = unit({
        x: ns[0].x * u + ns[1].x * v + ns[2].x * w,
        y: ns[0].y * u + ns[1].y * v + ns[2].y * w,
        z: ns[0].z * u + ns[1].z * v + ns[2].z * w,
      });
      if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
      best = { p: { x, y, z }, n };
    }
    return best;
  };
}

function pathGeometry(
  id: LayerId, paths: number[][], anchors: Float32Array, depth: number, h: number,
  sample: ReturnType<typeof surfaceSampler>,
): LayerGeometry {
  const positions: number[] = [], indices: number[] = [], colors: number[] = [];
  const muscle = id === 'muscle', pad = id === 'fat';
  const ringSize = muscle || pad ? 10 : 8;
  for (const path of paths) {
    let previous: number | null = null;
    const cap = (base: number, reverse: boolean) => {
      for (let ring = 1; ring < ringSize - 1; ring++) {
        indices.push(base, base + (reverse ? ring + 1 : ring), base + (reverse ? ring : ring + 1));
      }
    };
    for (let segment = 0; segment < path.length - 1; segment++) {
      const a = point(anchors, path[segment]), b = point(anchors, path[segment + 1]);
      const tangent = unit(sub(b, a));
      const steps = Math.max(3, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (h * 0.012)));
      for (let step = segment === 0 ? 0 : 1; step <= steps; step++) {
        const t = step / steps, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        const hit = sample(x, y);
        if (!hit) { if (previous !== null) cap(previous, false); previous = null; continue; }
        const side = unit(cross(tangent, hit.n)), base = positions.length / 3;
        const progress = (segment + t) / (path.length - 1);
        const belly = Math.sin(Math.PI * progress);
        const width = h * (pad ? 0.045 : 0.023) * (0.18 + 0.82 * belly);
        for (let ring = 0; ring < ringSize; ring++) {
          const angle = ring / ringSize * Math.PI * 2;
          if (muscle || pad) {
            const s = Math.cos(angle);
            const edge = sample(x + side.x * width * s, y + side.y * width * s) ?? hit;
            const thickness = h * (pad ? 0.010 : 0.005) * (0.3 + 0.7 * belly);
            const inset = depth * h + thickness * Math.sin(angle);
            push(positions, {
              x: edge.p.x - edge.n.x * inset,
              y: edge.p.y - edge.n.y * inset,
              z: edge.p.z - edge.n.z * inset,
            });
            if (muscle) colors.push(ring % 2 ? 0.92 : 0.60, ring % 2 ? 0.32 : 0.12, ring % 2 ? 0.39 : 0.20);
          } else {
            const r = h * (id === 'nerves' ? 0.0030 : 0.0040) * (1 - 0.45 * progress);
            push(positions, {
              x: hit.p.x - hit.n.x * depth * h + r * (side.x * Math.cos(angle) + hit.n.x * Math.sin(angle)),
              y: hit.p.y - hit.n.y * depth * h + r * (side.y * Math.cos(angle) + hit.n.y * Math.sin(angle)),
              z: hit.p.z - hit.n.z * depth * h + r * (side.z * Math.cos(angle) + hit.n.z * Math.sin(angle)),
            });
          }
        }
        if (previous !== null) {
          for (let ring = 0; ring < ringSize; ring++) {
            const next = (ring + 1) % ringSize;
            indices.push(previous + ring, base + ring, base + next, previous + ring, base + next, previous + next);
          }
        } else cap(base, true);
        previous = base;
      }
    }
    if (previous !== null) cap(previous, false);
  }
  return { id, positions: Float32Array.from(positions), indices: Uint32Array.from(indices), ...(muscle ? { colors: Float32Array.from(colors) } : {}) };
}

function buildNeutralLayers(mesh: SimulationMesh): LayerGeometry[] {
  const positions = mesh.positions;
  const anchors = mesh.anchors;
  const { height: h } = facialFrame(mesh.anchors), normals = vertexNormals(positions, mesh.indices);
  const sample = surfaceSampler(anchors);
  return SIMULATION_LAYERS.map(layer => {
    if (layer.id === 'skin') {
      const p = positions.slice();
      for (let i = 0; i < p.length; i++) p[i] -= normals[i] * layer.depth * h;
      return { id: layer.id, positions: p, indices: mesh.indices.slice() };
    }
    const paths = layer.id === 'fat' ? FAT_PATHS : layer.id === 'muscle' ? MUSCLE_PATHS : layer.id === 'nerves' ? NERVE_PATHS : VESSEL_PATHS;
    return pathGeometry(layer.id, paths, anchors, layer.depth, h, sample);
  });
}

// Buffers propios del visor, inmutables durante su vida. WeakMap no retiene modelos descartados.
const neutralLayerCache = new WeakMap<SimulationMesh, LayerGeometry[]>();

/** Capas co-deformadas por el mismo campo suave desde sus originales, sin remuestreo por frame. */
export function buildSimulationLayers(mesh: SimulationMesh, input: Partial<SimulationParameters>): LayerGeometry[] {
  let neutral = neutralLayerCache.get(mesh);
  if (!neutral) {
    neutral = buildNeutralLayers(mesh);
    neutralLayerCache.set(mesh, neutral);
  }
  return neutral.map(layer => ({
    id: layer.id,
    positions: deformPositions(layer.positions, mesh.anchors, input),
    indices: layer.indices.slice(),
    ...(layer.colors ? { colors: layer.colors.slice() } : {}),
  }));
}

/** Convención de Three.Plane: se conserva normal·p + constant >= 0. */
export function buildCutPlane(bounds: MeshBounds, cut: SimulationCut): CutPlane | null {
  if (cut.scope === 'none') return null;
  const axis = cut.axis, sign = cut.reverse ? -1 : 1;
  // Margen para poder revelar/ocultar completamente incluso tubos desplazados.
  const margin = bounds.height * 0.04;
  const value = bounds.min[axis] - margin
    + clamp(cut.position, 0, 1) * (bounds.max[axis] - bounds.min[axis] + margin * 2);
  return { normal: { x: 0, y: 0, z: 0, [axis]: sign }, constant: -value * sign };
}

export function isPointRetained(p: Vec3, plane: CutPlane | null): boolean {
  return !plane || p.x * plane.normal.x + p.y * plane.normal.y + p.z * plane.normal.z + plane.constant >= -1e-8;
}
