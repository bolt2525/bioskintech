import type { FreehandLine, Marker3D, SurfaceShape } from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import type { Elem, ElemKind, Meta, P2, Vec3 } from './engine';
import type { FaceAddress, GenericFaceAtlas } from './faceTransfer';
import { photoPoint } from './faceTransfer.ts';

export function requireMappedPoint<T extends P2>(point: T | null): T {
  if (!point) throw new Error('Correspondencia anatómica inválida: no se pudo resolver el triángulo.');
  return point;
}

export interface AnatomicalBinding {
  paths: FaceAddress[][];
  center?: FaceAddress;
  kind: ElemKind;
  /** Contexto ilustrativo al marcar; no es un plano ni una profundidad de inyección. */
  illustrativePlane?: 'skin' | 'muscle' | 'vessels' | 'bone';
}
export type AnatomicalBindings = Record<string, AnatomicalBinding>;

/** Patrones geométricos ilustrativos en el chart de la foto, sin parámetros clínicos. */
export interface PatternConfig { fanLines: number; fanAngle: number; gridCells: number; fernBranches: number }
export const DEFAULT_PATTERN: PatternConfig = { fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 };
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

/** Patrones en el chart de la foto: cada segmento va de la entrada de aguja a su punta. `fanAngle` es media apertura. */
export function photoPatternPaths(start: P2, end: P2, aspect: number, pattern: 'fan' | 'grid' | 'fern', config: PatternConfig = DEFAULT_PATTERN): P2[][] {
  const dx = (end.x - start.x) * aspect, dy = end.y - start.y;
  const offset = (point: P2, n: number): P2 => ({ x: point.x - dy * n / aspect, y: point.y + dx * n });
  const lerp = (t: number): P2 => ({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
  if (pattern === 'fan') {
    const n = clampInt(config.fanLines, 2, 12), half = Math.min(60, Math.max(5, config.fanAngle)) * Math.PI / 180;
    return Array.from({ length: n }, (_, i) => [start, offset(end, Math.tan(-half + 2 * half * i / (n - 1)))]);
  }
  if (pattern === 'grid') {
    const cells = clampInt(config.gridCells, 2, 8), w = 0.32;
    return [
      ...Array.from({ length: cells + 1 }, (_, i) => [offset(start, -w + 2 * w * i / cells), offset(end, -w + 2 * w * i / cells)]),
      ...Array.from({ length: cells + 1 }, (_, i) => [offset(lerp(i / cells), -w), offset(lerp(i / cells), w)]),
    ];
  }
  const branches = clampInt(config.fernBranches, 2, 10);
  return [[start, end], ...Array.from({ length: branches }, (_, i) => (i + 1) / (branches + 1))
    .flatMap(t => [-1, 1].map(side => [lerp(t), offset(lerp(Math.min(1, t + 0.15)), side * 0.22)]))];
}

export function addressHasPhotoCoverage(address: FaceAddress, landmarks: readonly P2[], atlas: GenericFaceAtlas): boolean {
  const ids = atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3);
  if (ids.length !== 3 || ids.some(i => !landmarks[i] || landmarks[i].x < 0 || landmarks[i].x > 1 || landmarks[i].y < 0 || landmarks[i].y > 1)) return false;
  const [a, b, c] = ids.map(i => landmarks[i]);
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const [u, v, w] = ids.map(i => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] }));
  const sourceArea = (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  return Number.isFinite(area) && Math.abs(area) > 1e-8 && area * sourceArea > 0;
}

/** Rechaza el elemento completo si cruza una zona sin correspondencia; nunca omite puntos silenciosamente. */
export function bindAnatomicalPaths(
  paths: Vec3[][], locate: (p: Vec3) => FaceAddress | null, kind: ElemKind, step = 0.035,
): AnatomicalBinding | null {
  if (!paths.length || paths.some(p => !p.length) || !Number.isFinite(step) || step <= 0) return null;
  const mapped: FaceAddress[][] = [];
  for (const path of paths) {
    const addresses: FaceAddress[] = [];
    for (let i = 0; i < path.length; i++) {
      const a = i ? path[i - 1] : path[i], b = path[i];
      if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return null;
      const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const steps = i ? Math.max(1, Math.ceil(length / step)) : 1;
      if (steps > 2000 || addresses.length + steps > 10000) return null;
      for (let j = 1; j <= steps; j++) {
        const t = i ? j / steps : 1;
        const address = locate({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        if (!address) return null;
        addresses.push(address);
      }
    }
    mapped.push(addresses);
  }
  return { paths: mapped, kind };
}

export function surfaceNormal(address: FaceAddress, atlas: GenericFaceAtlas, point: (a: FaceAddress) => Vec3): Vec3 {
  const corners = [0, 1, 2].map(i => point({ triangle: address.triangle, weights: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0] }));
  const a = corners[0], b = corners[1], c = corners[2];
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const length = Math.hypot(n.x, n.y, n.z);
  if (!Number.isFinite(length) || length < 1e-10 || atlas.triangles.length <= address.triangle * 3) throw new Error('Normal anatómica degenerada.');
  const sign = n.z < 0 ? -1 : 1;
  return { x: sign * n.x / length, y: sign * n.y / length, z: sign * n.z / length };
}

export function shapeOutline(s: SurfaceShape): Vec3[] {
  const n = s.normal, length = Math.hypot(n.x, n.y, n.z);
  if (!Number.isFinite(length) || length < 1e-8) return [];
  const seed = s.tangent ?? (Math.abs(n.y / length) < 0.95 ? { x: n.z, y: 0, z: -n.x } : { x: 1, y: 0, z: 0 });
  const dot = (seed.x * n.x + seed.y * n.y + seed.z * n.z) / (length * length);
  const tangent = { x: seed.x - dot * n.x, y: seed.y - dot * n.y, z: seed.z - dot * n.z };
  const tl = Math.hypot(tangent.x, tangent.y, tangent.z);
  if (!(tl > 1e-8)) return [];
  const u = { x: tangent.x / tl, y: tangent.y / tl, z: tangent.z / tl };
  const v = { x: (n.y * u.z - n.z * u.y) / length, y: (n.z * u.x - n.x * u.z) / length, z: (n.x * u.y - n.y * u.x) / length };
  const w = s.shapeType === 'circle' ? s.radius ?? 0 : (s.width ?? 0) / 2;
  const h = s.shapeType === 'circle' ? w : (s.height ?? 0) / 2;
  if (![w, h].every(v => Number.isFinite(v) && v > 0)) return [];
  const coords: [number, number][] = s.shapeType === 'circle'
    ? Array.from({ length: 49 }, (_, i) => [Math.cos(i * Math.PI / 24) * w, Math.sin(i * Math.PI / 24) * h])
    : [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]];
  return coords.map(([x, y]) => ({ x: s.center.x + u.x * x + v.x * y, y: s.center.y + u.y * x + v.y * y, z: s.center.z + u.z * x + v.z * y }));
}

export function annotationViews(
  markers: Marker3D[], lines: FreehandLine[], shapes: SurfaceShape[], bindings: AnatomicalBindings,
  atlas: GenericFaceAtlas, point: (a: FaceAddress) => Vec3,
): { markers: Marker3D[]; lines: FreehandLine[] } {
  return {
    markers: markers.flatMap(m => {
      const binding = m.id ? bindings[m.id] : undefined, address = binding?.paths[0]?.[0];
      return address ? [{ ...m, position: point(address), normal: surfaceNormal(address, atlas, point) }] : [];
    }),
    lines: [
      ...lines.flatMap(l => {
        const binding = bindings[l.id];
        if (!binding) return [];
        const paths = binding.paths.map(path => path.map(point));
        return [{ ...l, points: paths[0], ...(paths.length > 1 ? { segments: paths } : { segments: undefined }) }];
      }),
      ...shapes.flatMap(s => {
        const binding = bindings[s.id];
        return binding ? [{ id: s.id, points: binding.paths[0].map(point), color: s.color, thickness: s.thickness }] : [];
      }),
    ],
  };
}

export function anatomicalPhotoElements(
  bindings: AnatomicalBindings, meta: Record<string, Meta>, landmarks: readonly P2[], atlas: GenericFaceAtlas,
): Elem[] {
  return Object.entries(bindings).flatMap(([id, binding]) => {
    const properties = meta[id];
    if (!properties) return [];
    const paths = binding.paths.map(path => path.map(a => requireMappedPoint(photoPoint(a, landmarks, atlas))));
    if (binding.center) {
      const boundary = paths[0], center = requireMappedPoint(photoPoint(binding.center, landmarks, atlas));
      return [{ ...properties, id, kind: binding.kind, paths: [[center]], boundary,
        rx: Math.max(...boundary.map(p => Math.abs(p.x - center.x))), ry: Math.max(...boundary.map(p => Math.abs(p.y - center.y))) }];
    }
    return [{ ...properties, id, kind: binding.kind, paths }];
  });
}
