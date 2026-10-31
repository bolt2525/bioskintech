import { applySkinCosmetics } from './skinAppearance.ts';
import { FACE_OVAL, type P2 } from './engine.ts';
import { FACE_REGION_BOUNDARIES, FACE_REGION_SEEDS } from './faceRegions.ts';

export interface SkinReviewRegion {
  id: string;
  polygon: P2[];
  label: string;
  verified: boolean;
  adjustments: {
    /** 0..1 · intensidad manual de atenuación RGB, sin inferencia clínica. */
    attenuation: number;
    /** 0..1 · atenuación RGB multiescala manual; no elimina una cicatriz física. */
    scarAttenuation?: number;
    /** -1..1 · tono RGB aparente. */
    tone: number;
    /** 0..1 · uniformidad de textura ilustrativa. */
    uniformity: number;
    /** -1..1 · relieve manual normalizado; el padre lo limita a ±1 % de altura. */
    relief: number;
  };
}

export const SKIN_REVIEW_LABELS = [
  'Grano', 'Pápula', 'Pústula', 'Cicatriz', 'Mancha', 'Lunar', 'Verruga', 'Otra',
] as const;

const EMPTY_ADJUSTMENTS = Object.freeze({ attenuation: 0, scarAttenuation: 0, tone: 0, uniformity: 0, relief: 0 });
const MAX_POLYGON_POINTS = 512;

export function isValidSkinPolygon(polygon: readonly P2[]): boolean {
  if (polygon.length < 3 || polygon.length > MAX_POLYGON_POINTS) return false;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const point = polygon[i], next = polygon[(i + 1) % polygon.length];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false;
    twiceArea += point.x * next.y - next.x * point.y;
  }
  if (Math.abs(twiceArea) < 0.0001) return false;
  const orientation = (a: P2, b: P2, c: P2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    for (let j = i + 1; j < polygon.length; j++) {
      if (j === i || j === (i + 1) % polygon.length || i === (j + 1) % polygon.length) continue;
      const c = polygon[j], d = polygon[(j + 1) % polygon.length];
      const abC = orientation(a, b, c), abD = orientation(a, b, d);
      const cdA = orientation(c, d, a), cdB = orientation(c, d, b);
      if (abC * abD < 0 && cdA * cdB < 0) return false;
    }
  }
  return true;
}

/** Point test for an already validated polygon; callers must validate at their trust boundary. */
export function pointInValidatedSkinPolygon(x: number, y: number, polygon: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInSkinPolygon(x: number, y: number, polygon: readonly P2[]): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && isValidSkinPolygon(polygon)
    && pointInValidatedSkinPolygon(x, y, polygon);
}

export function createSkinRegionMask(
  width: number, height: number, polygon: readonly P2[], safeMask?: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 768 || height > 768) throw new RangeError('Dimensiones ROI inválidas.');
  if (!isValidSkinPolygon(polygon)) throw new TypeError('El trazado de la zona no es válido.');
  if (safeMask && (!(safeMask instanceof Uint8Array) || safeMask.length !== width * height)) {
    throw new TypeError('Máscara de protección inválida.');
  }
  const mask = new Uint8Array(width * height);
  const minX = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.x)) * width));
  const maxX = Math.min(width, Math.ceil(Math.max(...polygon.map(point => point.x)) * width));
  const minY = Math.max(0, Math.floor(Math.min(...polygon.map(point => point.y)) * height));
  const maxY = Math.min(height, Math.ceil(Math.max(...polygon.map(point => point.y)) * height));
  for (let y = minY; y < maxY; y++) {
    const scanY = (y + 0.5) / height, intersections: number[] = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > scanY) !== (b.y > scanY)) {
        intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const startX = Math.max(minX, Math.ceil(intersections[i] * width - 0.5));
      const endX = Math.min(maxX, Math.ceil(intersections[i + 1] * width - 0.5));
      for (let x = startX; x < endX; x++) {
        const index = y * width + x;
        if (!safeMask || safeMask[index]) mask[index] = 1;
      }
    }
  }
  return mask;
}

/** Aplicación RGB inmutable sobre una copia; nunca analiza ni modifica la imagen de origen. */
export function applySkinRegionRgb(
  image: { width: number; height: number; data: Uint8ClampedArray },
  safeMask: Uint8Array,
  regions: readonly SkinReviewRegion[],
): Uint8ClampedArray {
  const { width, height, data } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 768 || height > 768 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('Imagen RGB local inválida.');
  }
  if (!(safeMask instanceof Uint8Array) || safeMask.length !== width * height) {
    throw new TypeError('Máscara de protección inválida.');
  }
  const output = data.slice();
  for (const region of regions) {
    if (!region.verified || !isValidSkinPolygon(region.polygon)) continue;
    const mask = createSkinRegionMask(width, height, region.polygon, safeMask);
    const { attenuation, tone, uniformity, relief, scarAttenuation = 0 } = region.adjustments;
    const values = [attenuation, tone, uniformity, relief, scarAttenuation];
    if (values.some(value => !Number.isFinite(value))) continue;
    const bounded = values.map(value => Math.max(-1, Math.min(1, value)));
    if (bounded.every(value => value === 0)) continue;
    const retouched = applySkinCosmetics({ width, height, data }, mask, {
      spots: Math.max(0, bounded[0], bounded[4] * 0.65),
      tone: bounded[1],
      texture: Math.max(0, bounded[2], bounded[4] * 0.75),
      fineWrinkles: Math.max(0, bounded[4]),
      coarseWrinkles: Math.max(0, bounded[4]),
    });
    // El relieve es solo una sugerencia RGB local basada en luminancia; no mide ni simula profundidad real.
    const amount = bounded[3] * 0.12;
    if (amount) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!mask[index]) continue;
        const pixel = index * 4;
        const light = (r: number, g: number, b: number) => r * 0.2126 + g * 0.7152 + b * 0.0722;
        const center = light(data[pixel], data[pixel + 1], data[pixel + 2]);
        let total = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) {
            const neighbor = (ny * width + nx) * 4;
            total += light(data[neighbor], data[neighbor + 1], data[neighbor + 2]);
            count++;
          }
        }
        const delta = Math.max(-2, Math.min(2, ((total / count) - center) * amount));
        for (let channel = 0; channel < 3; channel++) {
          retouched[pixel + channel] = Math.max(0, Math.min(255, retouched[pixel + channel] + delta));
        }
      }
    }
    for (let index = 0; index < mask.length; index++) if (mask[index]) {
      const pixel = index * 4;
      output[pixel] = retouched[pixel];
      output[pixel + 1] = retouched[pixel + 1];
      output[pixel + 2] = retouched[pixel + 2];
    }
  }
  return output;
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

interface FacialUvSafety {
  contour: P2[];
  exclusions: Array<{ bounds: { left: number; right: number; top: number; bottom: number } }>;
}

function getFacialUvSafety(uvs: Float32Array): FacialUvSafety | undefined {
  // Solo se desplaza la topología facial canónica; atlas/UV parciales se dejan intactos.
  if (uvs.length < 468 * 2) return undefined;
  const landmarks = Array.from({ length: 468 }, (_, index) => ({ x: uvs[index * 2], y: uvs[index * 2 + 1] }));
  if (landmarks.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return undefined;
  const oval = FACE_OVAL.map(index => landmarks[index]);
  if (!isValidSkinPolygon(oval)) return undefined;
  const center = oval.reduce((sum, point) => ({ x: sum.x + point.x / oval.length, y: sum.y + point.y / oval.length }), { x: 0, y: 0 });
  const contour = oval.map(point => ({
    x: center.x + (point.x - center.x) * 0.92,
    y: center.y + (point.y - center.y) * 0.92,
  }));
  const top = Math.min(...oval.map(point => point.y));
  const bottom = Math.max(...oval.map(point => point.y));
  const browIds = FACE_REGION_SEEDS.find(entry => entry.zone === 'Cola de ceja')?.indices ?? [];
  const protectedIds = [
    FACE_REGION_BOUNDARIES.leftEye,
    FACE_REGION_BOUNDARIES.rightEye,
    [...FACE_REGION_BOUNDARIES.upperLip, ...FACE_REGION_BOUNDARIES.lowerLip],
    browIds,
  ];
  const margin = (bottom - top) * 0.04;
  const exclusions = protectedIds.map(ids => {
    const points = ids.map(index => landmarks[index]);
    return {
      bounds: {
        left: Math.min(...points.map(point => point.x)) - margin,
        right: Math.max(...points.map(point => point.x)) + margin,
        top: Math.min(...points.map(point => point.y)) - margin,
        bottom: Math.max(...points.map(point => point.y)) + margin,
      },
    };
  });
  return { contour, exclusions };
}

function isSafeFacialUv(x: number, y: number, safety: FacialUvSafety): boolean {
  if (!pointInValidatedSkinPolygon(x, y, safety.contour)) return false;
  return !safety.exclusions.some(({ bounds }) => x >= bounds.left && x <= bounds.right
    && y >= bounds.top && y <= bounds.bottom);
}

/** El relieve 3D es exclusivamente manual, pequeño y solo dentro de UV/ROI verificados. */
export function applySkinRegionRelief(
  positions: Float32Array,
  uvs: Float32Array,
  regions: readonly SkinReviewRegion[],
  normals?: Float32Array,
): Float32Array {
  if (!(positions instanceof Float32Array)) return new Float32Array();
  const output = positions.slice();
  if (!Number.isSafeInteger(positions.length) || positions.length % 3 !== 0
    || !(uvs instanceof Float32Array) || uvs.length !== positions.length / 3 * 2
    || (normals && (!(normals instanceof Float32Array) || normals.length !== positions.length))) return output;
  const safety = getFacialUvSafety(uvs);
  if (!safety) return output;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (![positions[i], positions[i + 1], positions[i + 2]].every(Number.isFinite)) return output;
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
  }
  const height = maxY - minY;
  if (!Number.isFinite(height) || height <= 0) return output;
  const validRegions = regions.filter(region => region.verified && isValidSkinPolygon(region.polygon));
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const uvX = uvs[vertex * 2], uvY = uvs[vertex * 2 + 1];
    if (!Number.isFinite(uvX) || !Number.isFinite(uvY) || !isSafeFacialUv(uvX, uvY, safety)) continue;
    for (const region of validRegions) {
      const relief = region.adjustments.relief;
      if (!Number.isFinite(relief) || relief === 0 || !pointInValidatedSkinPolygon(uvX, uvY, region.polygon)) continue;
      let nearest = Infinity;
      for (let i = 0; i < region.polygon.length; i++) {
        const a = region.polygon[i], b = region.polygon[(i + 1) % region.polygon.length];
        const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
        const t = length ? Math.max(0, Math.min(1, ((uvX - a.x) * dx + (uvY - a.y) * dy) / length)) : 0;
        nearest = Math.min(nearest, Math.hypot(uvX - (a.x + t * dx), uvY - (a.y + t * dy)));
      }
      const weight = smoothstep(nearest / 0.035);
      const offset = vertex * 3, amount = Math.max(-1, Math.min(1, relief)) * height * 0.01 * weight;
      if (normals) {
        if (![normals[offset], normals[offset + 1], normals[offset + 2]].every(Number.isFinite)) continue;
        const magnitude = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
        if (magnitude <= 1e-8) continue;
        output[offset] += normals[offset] / magnitude * amount;
        output[offset + 1] += normals[offset + 1] / magnitude * amount;
        output[offset + 2] += normals[offset + 2] / magnitude * amount;
      } else {
        output[offset + 2] += amount;
      }
      break;
    }
  }
  return output;
}

export function createSkinReviewRegion(id: string, polygon: readonly P2[], label = ''): SkinReviewRegion {
  if (!id || !isValidSkinPolygon(polygon)) throw new TypeError('Zona o trazado inválido.');
  return {
    id,
    polygon: polygon.map(point => ({ x: point.x, y: point.y })),
    label,
    verified: false,
    adjustments: { ...EMPTY_ADJUSTMENTS },
  };
}
