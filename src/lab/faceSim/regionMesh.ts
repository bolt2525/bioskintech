import type { FaceAddress } from './faceTransfer';
import type { FaceRegionMap } from './faceRegions';

export const REGION_PLANES = [
  { id: 'superficial', label: 'Superficial · piel', inset: 0 },
  { id: 'middle', label: 'Medio · tejido blando', inset: 0.012 },
  { id: 'deep', label: 'Profundo · referencia muscular', inset: 0.027 },
] as const;
export type RegionPlane = typeof REGION_PLANES[number]['id'];

export interface RegionCell {
  triangle: number;
  corners: [number[], number[], number[]];
  label: string;
}

const fixedRegions = new Set(['Labio superior', 'Labio inferior', 'Comisuras', 'Dorso nasal', 'Contorno ocular (revisar)', 'Ojeras']);
const midpoint = (a: number[], b: number[]) => a.map((v, i) => (v + b[i]) / 2);

/** Subdivide solo bordes semánticos; mantiene las direcciones originales de registro. */
export function buildRegionCells(map: FaceRegionMap, faceLabels: readonly string[], minimumDepth = 0): RegionCell[] {
  const result: RegionCell[] = [];
  const edges = new Map<string, number[]>(), borders = new Set<number>();
  faceLabels.forEach((_, triangle) => {
    const ids = map.triangles.slice(triangle * 3, triangle * 3 + 3);
    ids.forEach((id, j) => {
      const other = ids[(j + 1) % 3], key = `${Math.min(id, other)}:${Math.max(id, other)}`;
      const adjacent = edges.get(key) ?? [];
      adjacent.push(triangle); edges.set(key, adjacent);
    });
  });
  for (const adjacent of edges.values()) {
    if (new Set(adjacent.map(triangle => faceLabels[triangle])).size > 1) adjacent.forEach(triangle => borders.add(triangle));
  }
  for (let triangle = 0; triangle < faceLabels.length; triangle++) {
    const ids = map.triangles.slice(triangle * 3, triangle * 3 + 3);
    const label = faceLabels[triangle];
    const candidates = ids.map(id => map.labels[id]);
    const classify = (weights: number[]) => {
      if (fixedRegions.has(label)) return label;
      const votes = new Map<string, number>();
      candidates.forEach((zone, i) => {
        if (!fixedRegions.has(zone)) votes.set(zone, (votes.get(zone) ?? 0) + weights[i]);
      });
      return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? label;
    };
    const divide = (corners: RegionCell['corners'], depth: number) => {
      if (!depth) {
        result.push({ triangle, corners, label: classify([0, 1, 2].map(i => corners.reduce((sum, p) => sum + p[i] / 3, 0))) });
        return;
      }
      const [a, b, c] = corners, ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      for (const child of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]] as RegionCell['corners'][]) divide(child, depth - 1);
    };
    const depth = fixedRegions.has(label) ? borders.has(triangle) ? 1 : 0 : new Set(candidates).size > 1 ? 2 : 0;
    divide([[1, 0, 0], [0, 1, 0], [0, 0, 1]], Math.max(depth, minimumDepth));
  }
  return result;
}

export function regionCellAt(address: FaceAddress, cells: readonly RegionCell[]): string | null {
  const [x, y] = address.weights;
  for (const cell of cells) {
    if (cell.triangle !== address.triangle) continue;
    const [a, b, c] = cell.corners;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    if (u >= -1e-7 && v >= -1e-7 && 1 - u - v >= -1e-7) return cell.label;
  }
  return null;
}

interface RegionSurface {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
}
type Point3 = [number, number, number];
interface SurfaceChart {
  faces: Point3[][];
  bins: Map<string, Set<number>>;
  bin: (x: number, y: number) => [number, number];
}
const surfaceCharts = new WeakMap<RegionSurface, SurfaceChart>();
const side = (a: Point3, b: Point3, p: Point3) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

/** Índice del chart frontal, igual que modelPoint: no proyecta sobre nuca/caras invertidas. */
function surfaceChart(surface: RegionSurface): SurfaceChart {
  const cached = surfaceCharts.get(surface);
  if (cached) return cached;
  const { positions, triangles } = surface;
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    left = Math.min(left, positions[i]); right = Math.max(right, positions[i]);
    bottom = Math.min(bottom, positions[i + 1]); top = Math.max(top, positions[i + 1]);
  }
  const bin = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(31, Math.floor((x - left) / (right - left || 1) * 32))),
    Math.max(0, Math.min(31, Math.floor((y - bottom) / (top - bottom || 1) * 32))),
  ];
  const faces: Point3[][] = [], bins = new Map<string, Set<number>>();
  for (let i = 0; i < triangles.length; i += 3) {
    const face = [0, 1, 2].map(j => [0, 1, 2].map(axis => positions[triangles[i + j] * 3 + axis]) as Point3);
    if (!face.flat().every(Number.isFinite) || side(face[0], face[1], face[2]) <= 1e-12) continue;
    const id = faces.length; faces.push(face);
    const lo = bin(Math.min(...face.map(p => p[0])), Math.min(...face.map(p => p[1])));
    const hi = bin(Math.max(...face.map(p => p[0])), Math.max(...face.map(p => p[1])));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) {
      const key = `${x}:${y}`, bucket = bins.get(key) ?? new Set<number>();
      bucket.add(id); bins.set(key, bucket);
    }
  }
  const chart = { faces, bins, bin };
  surfaceCharts.set(surface, chart);
  return chart;
}

/**
 * Recorta triángulos REALES por el dominio XY de la celda, no una cuerda que
 * atraviesa la piel. Interpola XYZ sobre cada cara densa: conserva agujeros,
 * contornos y profundidad, sin puente sobre zonas sin superficie observada.
 */
export function regionCellPositions(cell: RegionCell, triangles: readonly number[], positions: ArrayLike<number>, surface?: RegionSurface): number[] {
  const ids = triangles.slice(cell.triangle * 3, cell.triangle * 3 + 3);
  const corners = cell.corners.map(weights => [0, 1, 2].map(axis =>
    ids.reduce((sum, id, j) => sum + positions[id * 3 + axis] * weights[j], 0)) as Point3);
  if (!surface) return corners.flat();
  const area = side(corners[0], corners[1], corners[2]);
  if (Math.abs(area) <= 1e-12) return [];
  const chart = surfaceChart(surface), candidates = new Set<number>(), result: number[] = [];
  const lo = chart.bin(Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])));
  const hi = chart.bin(Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1])));
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) {
    chart.bins.get(`${x}:${y}`)?.forEach(id => candidates.add(id));
  }
  const orientation = Math.sign(area);
  for (const id of candidates) {
    let polygon = chart.faces[id];
    for (let edge = 0; edge < 3 && polygon.length; edge++) {
      const a = corners[edge], b = corners[(edge + 1) % 3], clipped: Point3[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const p = polygon[j], q = polygon[(j + 1) % polygon.length];
        const dp = side(a, b, p) * orientation, dq = side(a, b, q) * orientation;
        if (dp >= 0) clipped.push(p);
        if ((dp >= 0) !== (dq >= 0)) {
          const t = dp / (dp - dq);
          clipped.push(p.map((value, axis) => value + (q[axis] - value) * t) as Point3);
        }
      }
      polygon = clipped;
    }
    for (let j = 1; j + 1 < polygon.length; j++) {
      if (side(polygon[0], polygon[j], polygon[j + 1]) > 1e-12) result.push(...polygon[0], ...polygon[j], ...polygon[j + 1]);
    }
  }
  return result;
}

/** Capas de referencia relativas, nunca profundidades medidas ni planos de inyección. */
export function regionPlanePositions(positions: ArrayLike<number>, triangles: readonly number[], plane: RegionPlane): Float32Array {
  const result = Float32Array.from(positions);
  const inset = REGION_PLANES.find(entry => entry.id === plane)!.inset;
  if (!inset) return result;
  const normals = new Float32Array(positions.length);
  const height = Math.abs(positions[10 * 3 + 1] - positions[152 * 3 + 1]);
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3).map(id => id * 3);
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    for (const id of [a, b, c]) {
      normals[id] += uy * vz - uz * vy;
      normals[id + 1] += uz * vx - ux * vz;
      normals[id + 2] += ux * vy - uy * vx;
    }
  }
  for (let i = 0; i < result.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (!length) continue;
    for (let axis = 0; axis < 3; axis++) result[i + axis] -= normals[i + axis] / length * inset * height;
  }
  return result;
}
