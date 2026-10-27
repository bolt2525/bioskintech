import type { P2 } from './engine';

type Landmark = P2 & { z: number };

function preservesTriangles(before: Landmark[], after: Landmark[], triangles: readonly number[]): boolean {
  const area = (points: Landmark[], a: number, b: number, c: number) =>
    (points[b].x - points[a].x) * (points[c].y - points[a].y) - (points[b].y - points[a].y) * (points[c].x - points[a].x);
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    if (![a, b, c].every(j => Number.isInteger(j) && j >= 0 && j < before.length)) return false;
    const original = area(before, a, b, c), moved = area(after, a, b, c);
    if (Math.abs(original) > 1e-10 && moved / original < 0.15) return false;
  }
  return true;
}

/** Desplaza un parche local, no solo el borde: conserva UV, relieve e índices anatómicos. */
export function moveFaceLandmark(
  landmarks: Landmark[], index: number, target: P2, aspect: number, triangles: readonly number[], references: readonly number[] = [index],
): Landmark[] | null {
  if (!landmarks[index] || !references.length || references.some(i => !landmarks[i])
    || landmarks.length < 468 || !Number.isFinite(aspect) || aspect <= 0
    || ![target.x, target.y].every(Number.isFinite) || target.x < 0 || target.x > 1 || target.y < 0 || target.y > 1) return null;
  const origin = references.reduce((p, i) => ({ x: p.x + landmarks[i].x / references.length, y: p.y + landmarks[i].y / references.length }), { x: 0, y: 0 });
  const height = Math.hypot((landmarks[152].x - landmarks[10].x) * aspect, landmarks[152].y - landmarks[10].y);
  const dx = target.x - origin.x, dy = target.y - origin.y;
  if (!(height > 0) || Math.hypot(dx * aspect, dy) > height * 0.18) return null;
  const radius = height * 0.26;
  const weight = (p: P2) => {
    const r = Math.hypot((p.x - origin.x) * aspect, p.y - origin.y) / radius;
    return r >= 1 ? 0 : (1 - r) ** 4 * (4 * r + 1);
  };
  const referenceWeight = references.reduce((sum, i) => sum + weight(landmarks[i]) / references.length, 0);
  if (referenceWeight < 0.1) return null;
  const next = landmarks.map(p => {
    const w = weight(p) / referenceWeight;
    return { ...p, x: p.x + dx * w, y: p.y + dy * w };
  });
  if (next.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) return null;
  return preservesTriangles(landmarks, next, triangles) ? next : null;
}

/** Amplía la banda superior completa; no estira ojos/cejas ni añade piel oculta como observada. */
export function extendVisibleForehead(landmarks: Landmark[], target: P2, aspect: number, triangles: readonly number[]): Landmark[] | null {
  if (landmarks.length < 468 || !Number.isFinite(aspect) || aspect <= 0
    || landmarks.some(p => ![p.x, p.y, p.z].every(Number.isFinite))
    || ![target.x, target.y].every(Number.isFinite) || target.x < 0 || target.x > 1 || target.y < 0 || target.y > 1) return null;
  const top = landmarks[10], brow = landmarks[9], chin = landmarks[152];
  const height = Math.hypot((top.x - chin.x) * aspect, top.y - chin.y);
  const direction = { x: (top.x - brow.x) * aspect, y: top.y - brow.y };
  const length = Math.hypot(direction.x, direction.y);
  if (length < 1e-5 || height < 1e-4) return null;
  const axis = { x: direction.x / length, y: direction.y / length };
  const projection = (p: P2) => (p.x - brow.x) * aspect * axis.x + (p.y - brow.y) * axis.y;
  const browLimit = Math.max(...[70, 63, 105, 66, 107, 336, 296, 334, 293, 300].map(i => projection(landmarks[i])));
  const band = projection(top) - browLimit;
  const dx = (target.x - top.x) * aspect, dy = target.y - top.y;
  if (band < height * 0.025 || Math.hypot(dx, dy) > height * 0.35 || dx * axis.x + dy * axis.y < 0
    || Math.abs(dx * axis.y - dy * axis.x) > height * 0.07) return null;
  const next = landmarks.map(p => {
    const t = Math.max(0, Math.min(1, (projection(p) - browLimit) / band));
    const weight = t * t * (3 - 2 * t);
    return { ...p, x: p.x + dx / aspect * weight, y: p.y + dy * weight };
  });
  if (next.some(p => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return null;
  return preservesTriangles(landmarks, next, triangles) ? next : null;
}

/** Propone un borde oscuro compatible con cabello. Requiere revisión; no es segmentación capilar. */
export function proposeForeheadBoundary(
  landmarks: Landmark[], image: { width: number; height: number; data: Uint8ClampedArray },
): { point: P2 | null; reason: string } {
  const { width, height, data } = image;
  if (landmarks.length < 468 || data.length !== width * height * 4 || width < 32 || height < 32) {
    throw new Error('No se puede proponer el límite frontal: imagen o referencias inválidas.');
  }
  const top = landmarks[10], brow = landmarks[9], chin = landmarks[152];
  const axis = { x: (top.x - brow.x) * width, y: (top.y - brow.y) * height };
  const length = Math.hypot(axis.x, axis.y), faceHeight = Math.hypot((top.x - chin.x) * width, (top.y - chin.y) * height);
  if (!(length > 1) || !(faceHeight > 30)) return { point: null, reason: 'No hay referencias suficientes para proponer el límite de la frente.' };
  axis.x /= length; axis.y /= length;
  const luma = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return null;
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const distances = [-0.08, 0, 0.08].map(offset => {
    const x = top.x * width + axis.y * offset * faceHeight, y = top.y * height - axis.x * offset * faceHeight;
    let best = 30, distance: number | null = null;
    const gap = Math.max(2, faceHeight * 0.012);
    for (let d = 3; d < faceHeight * 0.3; d++) {
      const inside = luma(x + axis.x * (d - gap), y + axis.y * (d - gap));
      const outside = luma(x + axis.x * (d + gap), y + axis.y * (d + gap));
      if (inside === null || outside === null) break;
      const contrast = inside - outside;
      if (contrast > best && outside < inside * 0.75) { best = contrast; distance = d; }
    }
    return distance;
  }).filter((d): d is number => d !== null).sort((a, b) => a - b);
  if (distances.length < 2 || distances.at(-1)! - distances[0] > faceHeight * 0.06) {
    return { point: null, reason: 'Sin borde capilar claro y coherente. Marca manualmente el límite de piel visible; no se inventará la frente oculta.' };
  }
  const d = distances[Math.floor(distances.length / 2)];
  return { point: { x: top.x + axis.x * d / width, y: top.y + axis.y * d / height },
    reason: 'Borde oscuro candidato, no cabello identificado. Revisa que el punto quede sobre piel visible antes del cabello.' };
}
/**
 * Busca un borde cromático solo en una banda exterior estrecha del mentón/sienes.
 * Un borde ambiguo conserva MediaPipe: no se expande un óvalo por defecto.
 */
export function refinePhotoContour(
  landmarks: Landmark[], oval: readonly number[], triangles: readonly number[],
  image: { width: number; height: number; data: Uint8ClampedArray },
): { landmarks: Landmark[]; adjusted: number } {
  const { width, height, data } = image;
  if (width < 32 || height < 32 || data.length !== width * height * 4 || landmarks.length < 468
    || landmarks.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) return { landmarks, adjusted: 0 };
  const aspect = width / height;
  const faceHeight = (landmarks[152].y - landmarks[10].y) * height;
  if (!(faceHeight > 30)) return { landmarks, adjusted: 0 };
  const pixel = (x: number, y: number) => {
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const contrast = (x: number, y: number, nx: number, ny: number) => {
    const gap = Math.max(2, faceHeight * 0.008);
    if (x < gap + 1 || x >= width - gap - 1 || y < gap + 1 || y >= height - gap - 1) return 0;
    const a = pixel(x - nx * gap, y - ny * gap), b = pixel(x + nx * gap, y + ny * gap);
    return Math.hypot(...a.map((v, i) => v - b[i]));
  };
  const center = oval.reduce((p, i) => ({ x: p.x + landmarks[i].x / oval.length, y: p.y + landmarks[i].y / oval.length }), { x: 0, y: 0 });
  const proposals = oval.map((index, i) => {
    const p = landmarks[index], before = landmarks[oval[(i + oval.length - 1) % oval.length]], after = landmarks[oval[(i + 1) % oval.length]];
    const tx = (after.x - before.x) * width, ty = (after.y - before.y) * height;
    const length = Math.hypot(tx, ty);
    let nx = ty / length, ny = -tx / length;
    if (nx * (p.x - center.x) * width + ny * (p.y - center.y) * height < 0) { nx = -nx; ny = -ny; }
    // Frente sin línea de cabello visible y mejillas no se infieren desde sombras.
    const relativeY = (p.y - landmarks[10].y) * height / faceHeight;
    if (!Number.isFinite(nx) || !(relativeY > 0.76 || relativeY > 0.16 && relativeY < 0.38)) return null;
    const baseline = contrast(p.x * width, p.y * height, nx, ny);
    const search = Math.min(24, Math.round(faceHeight * 0.045));
    let best = baseline, distance = 0;
    for (let d = 2; d <= search; d++) {
      const score = contrast(p.x * width + nx * d, p.y * height + ny * d, nx, ny);
      if (score > best) { best = score; distance = d; }
    }
    if (best < 45 || best < baseline * 1.8 || distance < 2) return null;
    return { index, nx, ny, distance };
  });
  let next = landmarks, adjusted = 0;
  proposals.forEach((p, i) => {
    if (!p) return;
    const adjacent = [proposals[(i + oval.length - 1) % oval.length], proposals[(i + 1) % oval.length]];
    if (!adjacent.some(q => q && Math.abs(q.distance - p.distance) <= faceHeight * 0.015)) return;
    const origin = landmarks[p.index];
    const moved = moveFaceLandmark(next, p.index, { x: origin.x + p.nx * p.distance / width, y: origin.y + p.ny * p.distance / height }, aspect, triangles);
    if (moved) { next = moved; adjusted++; }
  });
  return { landmarks: next, adjusted };
}
