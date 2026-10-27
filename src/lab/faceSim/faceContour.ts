import type { P2 } from './engine';

type Landmark = P2 & { z: number };

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
  const area = (points: Landmark[], a: number, b: number, c: number) =>
    (points[b].x - points[a].x) * (points[c].y - points[a].y)
      - (points[b].y - points[a].y) * (points[c].x - points[a].x);
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = triangles.slice(i, i + 3);
    if (![a, b, c].every(j => Number.isInteger(j) && j >= 0 && j < landmarks.length)) return null;
    const before = area(landmarks, a, b, c), after = area(next, a, b, c);
    if (Math.abs(before) > 1e-10 && after / before < 0.15) return null;
  }
  return next;
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
