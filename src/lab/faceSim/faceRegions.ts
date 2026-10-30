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
  { zone: 'Piel supralabial / filtrum', indices: [164] },
  { zone: 'Labio superior', indices: [0, 11, 12, 13, 37, 39, 40, 80, 81, 82, 185, 191, 267, 269, 270, 310, 311, 312, 409, 415] },
  { zone: 'Labio inferior', indices: [14, 15, 16, 17, 84, 87, 88, 91, 95, 146, 178, 181, 314, 317, 318, 321, 324, 375, 402, 405] },
  { zone: 'Comisuras', indices: [61, 78, 291, 308] },
  { zone: 'Surco marioneta', indices: [57, 186, 92, 287, 410, 322] },
  { zone: 'Mentón', indices: [152, 175, 199, 200, 201, 208, 421, 428, 18] },
  { zone: 'Línea mandibular', indices: [172, 136, 150, 149, 176, 148, 397, 365, 379, 378, 400, 377, 132, 361, 58, 288] },
];

export interface FaceRegionMap {
  landmarks: P2[];
  triangles: readonly number[];
  labels: string[];
}
const canonicalLabels = new WeakMap<readonly number[], Map<string, string[]>>();

export function faceRegionColor(zone: string): string {
  const palette = ['#38bdf8', '#fb923c', '#a78bfa', '#f472b6', '#34d399', '#facc15', '#2dd4bf', '#fb7185', '#818cf8',
    '#4ade80', '#fbbf24', '#c084fc', '#22d3ee', '#e879f9', '#a3e635', '#60a5fa', '#f87171', '#fcd34d'];
  const index = FACE_REGION_SEEDS.findIndex(entry => entry.zone === zone);
  return index < 0 ? '#94a3b8' : palette[index];
}

export const FACE_REGION_EDUCATION: ReadonlyArray<{ zones: readonly string[]; structures: string }> = [
  { zones: ['Frente', 'Glabela', 'Cola de ceja'], structures: 'Arterias supratroclear y supraorbitaria; variaciones y conexiones vasculares.' },
  { zones: ['Dorso nasal'], structures: 'Arterias dorsal nasal, lateral nasal y angular; conexiones con otros territorios.' },
  { zones: ['Contorno ocular (revisar)', 'Patas de gallo', 'Ojeras'], structures: 'Vascularización periorbitaria y conexiones con la circulación oftálmica.' },
  { zones: ['Región temporal'], structures: 'Arteria temporal superficial y otras ramas; planos anatómicos variables.' },
  { zones: ['Surco nasogeniano'], structures: 'Arterias facial y angular; trayectos y profundidad variables.' },
  { zones: ['Labio superior', 'Labio inferior', 'Comisuras', 'Piel supralabial / filtrum'], structures: 'Arterias labiales superior e inferior; posición variable entre personas.' },
];

export function faceRegionEducation(zone: string): string | undefined {
  return FACE_REGION_EDUCATION.find(entry => entry.zones.includes(zone))?.structures;
}

export function faceAttentionColor(zone: string): string {
  return faceRegionEducation(zone) ? '#f59e0b' : '#94a3b8';
}
export function faceTriangleZone(indices: readonly number[], labels: readonly string[]): string {
  const votes = new Map<string, number>();
  indices.forEach(i => votes.set(labels[i], (votes.get(labels[i]) ?? 0) + 1));
  return [...votes].sort((a, b) => b[1] - a[1])[0][0];
}

/** Límites cerrados por aristas reales: el bermellón no se propaga hacia la piel. */
export const FACE_REGION_BOUNDARIES = {
  upperLip: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 306, 292, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78, 62, 76],
  lowerLip: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 306, 292, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78, 62, 76],
  nose: [168, 193, 122, 196, 3, 51, 45, 220, 115, 48, 64, 98, 97, 2, 326, 327, 294, 278, 344, 440, 275, 281, 248, 419, 351, 417],
  leftEye: [247, 30, 29, 27, 28, 56, 190, 243, 112, 26, 22, 23, 24, 110, 25, 130],
  rightEye: [467, 260, 259, 257, 258, 286, 414, 463, 341, 256, 252, 253, 254, 339, 255, 359],
  leftUnderEye: [130, 25, 110, 24, 23, 22, 26, 112, 232, 121, 120, 119, 118, 117, 31, 226],
  rightUnderEye: [359, 255, 339, 254, 253, 252, 256, 341, 452, 350, 349, 348, 347, 346, 261, 446],
} as const;

/** Una etiqueta por cara, compartida por color y hover en foto/atlas/superficie. */
export function buildFaceTriangleRegions(map: FaceRegionMap, positions: readonly number[]): string[] {
  const faces = Array.from({ length: map.triangles.length / 3 }, (_, i) => map.triangles.slice(i * 3, i * 3 + 3));
  const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const edges = new Map<string, number[]>();
  faces.forEach((face, i) => face.forEach((a, j) => {
    const edge = key(a, face[(j + 1) % 3]);
    edges.set(edge, [...(edges.get(edge) ?? []), i]);
  }));
  const enclosed = (boundary: readonly number[], seed: readonly number[]) => {
    const barriers = new Set(boundary.map((a, j) => key(a, boundary[(j + 1) % boundary.length])));
    if ([...barriers].some(edge => !edges.has(edge))) throw new Error('El atlas no contiene los límites anatómicos esperados.');
    const start = faces.findIndex(face => seed.every(id => face.includes(id)));
    if (start < 0) throw new Error('El atlas no contiene la referencia anatómica esperada.');
    const selected = new Set([start]), queue = [start];
    for (let j = 0; j < queue.length; j++) {
      const face = faces[queue[j]];
      face.forEach((a, k) => {
        const edge = key(a, face[(k + 1) % 3]);
        if (barriers.has(edge)) return;
        for (const neighbor of edges.get(edge)!) if (!selected.has(neighbor)) {
          selected.add(neighbor); queue.push(neighbor);
        }
      });
    }
    if (selected.size > faces.length / 3) throw new Error('El límite anatómico no encierra una región local.');
    return selected;
  };
  const upper = enclosed(FACE_REGION_BOUNDARIES.upperLip, [0, 11, 37]);
  const lower = enclosed(FACE_REGION_BOUNDARIES.lowerLip, [17, 84, 85]);
  const nose = enclosed(FACE_REGION_BOUNDARIES.nose, [6, 122, 168]);
  const leftEye = enclosed(FACE_REGION_BOUNDARIES.leftEye, [33, 246, 247]);
  const rightEye = enclosed(FACE_REGION_BOUNDARIES.rightEye, [263, 467, 466]);
  const leftUnderEye = enclosed(FACE_REGION_BOUNDARIES.leftUnderEye, [121, 232, 120]);
  const rightUnderEye = enclosed(FACE_REGION_BOUNDARIES.rightUnderEye, [350, 452, 349]);
  const protectedZones = new Set(['Labio superior', 'Labio inferior', 'Comisuras', 'Dorso nasal', 'Contorno ocular (revisar)', 'Ojeras']);
  const surroundingSeeds = FACE_REGION_SEEDS.filter(entry => !protectedZones.has(entry.zone));
  return faces.map((face, i) => {
    if ((upper.has(i) || lower.has(i)) && face.some(id => [61, 78, 291, 308].includes(id))) return 'Comisuras';
    if (upper.has(i)) return 'Labio superior';
    if (lower.has(i)) return 'Labio inferior';
    if (nose.has(i)) return 'Dorso nasal';
    if (leftEye.has(i) || rightEye.has(i)) return 'Contorno ocular (revisar)';
    if (leftUnderEye.has(i) || rightUnderEye.has(i)) return 'Ojeras';
    const surrounding = face.filter(id => !protectedZones.has(map.labels[id]));
    if (surrounding.length) return faceTriangleZone(surrounding, map.labels);
    // Los vértices del borde pueden pertenecer todos al labio/nariz, pero no la cara exterior.
    const center = [0, 1, 2].map(axis => face.reduce((sum, id) => sum + positions[id * 3 + axis] / 3, 0));
    let best = Infinity, label = 'Sin zona facial';
    for (const entry of surroundingSeeds) for (const id of entry.indices) {
      const distance = Math.hypot(...center.map((value, axis) => value - positions[id * 3 + axis]));
      if (distance < best) { best = distance; label = entry.zone; }
    }
    return label;
  });
}

/** Voronoi geodésico sobre las conexiones reales de la malla, no franjas de una caja 2D. */
export function buildFaceRegionMap(
  landmarks: P2[], triangles: readonly number[], aspect: number, referencePositions?: readonly number[],
): FaceRegionMap {
  if (landmarks.length < 468 || !Number.isFinite(aspect) || aspect <= 0
    || landmarks.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    || triangles.length % 3 || triangles.some(i => !Number.isInteger(i) || i < 0 || i >= 468)) {
    throw new Error('No se puede construir el mapa anatómico: malla facial inválida.');
  }
  const adjacency = Array.from({ length: 468 }, () => new Map<number, number>());
  if (referencePositions && (referencePositions.length < 468 * 3 || referencePositions.some(p => !Number.isFinite(p)))) {
    throw new Error('Las referencias anatómicas del modelo no son válidas.');
  }
  const topology = referencePositions ? triangles.join(',') : '';
  const cached = referencePositions && canonicalLabels.get(referencePositions)?.get(topology);
  if (cached) return { landmarks, triangles, labels: [...cached] };
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = triangles[i + j], b = triangles[i + (j + 1) % 3];
      const distance = Math.max(1e-8, referencePositions
        ? Math.hypot(...[0, 1, 2].map(axis => referencePositions[a * 3 + axis] - referencePositions[b * 3 + axis]))
        : Math.hypot((landmarks[a].x - landmarks[b].x) * aspect, landmarks[a].y - landmarks[b].y));
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
  if (referencePositions) {
    let cache = canonicalLabels.get(referencePositions);
    if (!cache) { cache = new Map(); canonicalLabels.set(referencePositions, cache); }
    cache.set(topology, [...labels]);
  }
  return { landmarks, triangles, labels };
}

/** Color interpolado por vértice, sin asignar arbitrariamente un triángulo mixto a una sola zona. */
export function rasterizeFaceRegions(
  map: FaceRegionMap, width: number, height: number, color = faceRegionColor, include?: (triangle: number) => boolean,
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 1024 * 1024) {
    throw new Error('Dimensiones inválidas para la capa anatómica.');
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  const colors = map.labels.map(zone => {
    const hex = color(zone);
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Color anatómico inválido.');
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  });
  for (let offset = 0; offset < map.triangles.length; offset += 3) {
    if (include && !include(offset / 3)) continue;
    const ids = map.triangles.slice(offset, offset + 3);
    const [a, b, c] = ids.map(i => map.landmarks[i]);
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) * width)), x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x) * width));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) * height)), y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y) * height));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / width, py = (y + 0.5) / height;
      const u = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / den;
      const v = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / den;
      const w = 1 - u - v;
      if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[index + channel] = colors[ids[0]][channel] * u + colors[ids[1]][channel] * v + colors[ids[2]][channel] * w;
      }
      pixels[index + 3] = 255;
    }
  }
  return pixels;
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
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  return ranked.length > 1 && ranked[0][1] < 0.6
    ? `${ranked[0][0]} / ${ranked[1][0]} (límite aproximado)` : ranked[0][0];
}

/** Rechaza casquete/zonas estimadas aunque su proyección XY coincida con el rostro. */
export function isOnObservedFace(p: Vec3, surface: PersonalSurface, map: FaceRegionMap): boolean {
  const m = surface.projection;
  const hit = locateFaceTriangle({ x: (p.x / m.k + m.cx) / m.aspect, y: -(p.y / m.k + m.cy) }, map);
  if (!hit || !Number.isFinite(p.z)) return false;
  const z = hit.indices.reduce((sum, i, j) => sum + surface.positions[i * 3 + 2] * hit.weights[j], 0);
  return Math.abs(p.z - z) < 0.03 * m.k;
}
