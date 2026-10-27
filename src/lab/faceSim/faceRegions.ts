import type { P2, PersonalSurface, Vec3 } from './engine';

/** Semillas anatómicas de la topología MediaPipe; no son sitios de inyección recomendados. */
export const FACE_REGION_SEEDS: ReadonlyArray<{ zone: string; indices: number[] }> = [
  { zone: 'Frente', indices: [10, 151, 108, 337, 109, 338, 67, 297, 103, 332] },
  { zone: 'Glabela', indices: [9, 8, 55, 285] },
  { zone: 'Región temporal', indices: [127, 356, 162, 389, 21, 251, 54, 284] },
  { zone: 'Cola de ceja', indices: [70, 46, 300, 276, 63, 293] },
  { zone: 'Contorno ocular (revisar)', indices: [33, 133, 159, 145, 153, 154, 155, 160, 161, 163, 173, 246, 263, 362, 386, 374, 380, 381, 382, 385, 387, 388, 390, 398, 466] },
  { zone: 'Patas de gallo', indices: [130, 359, 226, 446, 35, 265] },
  { zone: 'Ojeras', indices: [111, 117, 118, 119, 120, 121, 128, 245, 340, 346, 347, 348, 349, 350, 357, 465] },
  { zone: 'Dorso nasal', indices: [168, 6, 197, 195, 5, 4, 1, 2, 98, 327] },
  { zone: 'Pómulos', indices: [50, 101, 100, 36, 280, 330, 329, 266] },
  { zone: 'Mejillas', indices: [205, 206, 207, 187, 123, 116, 425, 426, 427, 411, 352, 345] },
  { zone: 'Surco nasogeniano', indices: [48, 49, 102, 64, 203, 278, 279, 331, 294, 423] },
  { zone: 'Labios', indices: [0, 13, 14, 17, 37, 39, 40, 78, 80, 81, 82, 84, 87, 88, 267, 269, 270, 308, 310, 311, 312, 314, 317, 318] },
  { zone: 'Comisuras', indices: [61, 291] },
  { zone: 'Surco marioneta', indices: [57, 186, 92, 165, 287, 410, 322, 391] },
  { zone: 'Mentón', indices: [152, 175, 199, 200, 201, 208, 421, 428, 18] },
  { zone: 'Línea mandibular', indices: [172, 136, 150, 149, 176, 148, 397, 365, 379, 378, 400, 377, 132, 361, 58, 288] },
];

export interface FaceRegionMap {
  landmarks: P2[];
  triangles: readonly number[];
  labels: string[];
}

/** Voronoi geodésico sobre las conexiones reales de la malla, no franjas de una caja 2D. */
export function buildFaceRegionMap(landmarks: P2[], triangles: readonly number[], aspect: number): FaceRegionMap {
  if (landmarks.length < 468 || !Number.isFinite(aspect) || aspect <= 0
    || landmarks.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    || triangles.length % 3 || triangles.some(i => !Number.isInteger(i) || i < 0 || i >= 468)) {
    throw new Error('No se puede construir el mapa anatómico: malla facial inválida.');
  }
  const adjacency = Array.from({ length: 468 }, () => new Map<number, number>());
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = triangles[i + j], b = triangles[i + (j + 1) % 3];
      const distance = Math.max(1e-8, Math.hypot((landmarks[a].x - landmarks[b].x) * aspect, landmarks[a].y - landmarks[b].y));
      adjacency[a].set(b, distance); adjacency[b].set(a, distance);
    }
  }
  const distances = Array<number>(468).fill(Infinity), labels = Array<string>(468).fill('Sin zona facial');
  FACE_REGION_SEEDS.forEach(({ zone, indices }) => indices.forEach(i => { distances[i] = 0; labels[i] = zone; }));
  const visited = new Set<number>();
  for (let step = 0; step < 468; step++) {
    let best = -1;
    for (let i = 0; i < 468; i++) if (!visited.has(i) && (best < 0 || distances[i] < distances[best])) best = i;
    if (best < 0 || !Number.isFinite(distances[best])) break;
    visited.add(best);
    adjacency[best].forEach((distance, i) => {
      if (distances[best] + distance < distances[i]) {
        distances[i] = distances[best] + distance; labels[i] = labels[best];
      }
    });
  }
  return { landmarks, triangles, labels };
}

function locateFaceTriangle(p: P2, map: FaceRegionMap): { indices: number[]; weights: number[] } | null {
  if (![p.x, p.y].every(Number.isFinite)) return null;
  for (let i = 0; i < map.triangles.length; i += 3) {
    const indices = map.triangles.slice(i, i + 3);
    const [a, b, c] = indices.map(j => map.landmarks[j]);
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / den;
    const v = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / den;
    if (u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6) return { indices, weights: [u, v, 1 - u - v] };
  }
  return null;
}

export function facialZoneAt(p: P2, map: FaceRegionMap): string | null {
  const hit = locateFaceTriangle(p, map);
  if (!hit) return null;
  const votes = new Map<string, number>();
  hit.indices.forEach((i, j) => votes.set(map.labels[i], (votes.get(map.labels[i]) ?? 0) + hit.weights[j]));
  return [...votes].sort((a, b) => b[1] - a[1])[0][0];
}

/** Rechaza casquete/zonas estimadas aunque su proyección XY coincida con el rostro. */
export function isOnObservedFace(p: Vec3, surface: PersonalSurface, map: FaceRegionMap): boolean {
  const m = surface.projection;
  const hit = locateFaceTriangle({ x: (p.x / m.k + m.cx) / m.aspect, y: -(p.y / m.k + m.cy) }, map);
  if (!hit || !Number.isFinite(p.z)) return false;
  const z = hit.indices.reduce((sum, i, j) => sum + surface.positions[i * 3 + 2] * hit.weights[j], 0);
  return Math.abs(p.z - z) < 0.03 * m.k;
}
