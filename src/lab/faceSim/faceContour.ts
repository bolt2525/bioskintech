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

/** Altura del límite frontal normalizada por glabela→mentón; permite trasladarla entre vistas. */
export function foreheadRatio(landmarks: Landmark[], point: P2, aspect: number): number | null {
  const brow = landmarks[9], top = landmarks[10], chin = landmarks[152];
  if (!brow || !top || !chin || !(aspect > 0)) return null;
  const scale = Math.hypot((chin.x - brow.x) * aspect, chin.y - brow.y);
  const ax = (top.x - brow.x) * aspect, ay = top.y - brow.y, length = Math.hypot(ax, ay);
  if (scale < 1e-4 || length < 1e-5) return null;
  const ratio = ((point.x - brow.x) * aspect * ax + (point.y - brow.y) * ay) / length / scale;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

export function foreheadPointFromRatio(landmarks: Landmark[], ratio: number, aspect: number): P2 | null {
  const brow = landmarks[9], top = landmarks[10], chin = landmarks[152];
  if (!brow || !top || !chin || !(aspect > 0) || !(ratio > 0)) return null;
  const scale = Math.hypot((chin.x - brow.x) * aspect, chin.y - brow.y);
  const ax = (top.x - brow.x) * aspect, ay = top.y - brow.y, length = Math.hypot(ax, ay);
  if (scale < 1e-4 || length < 1e-5) return null;
  const point = { x: brow.x + ax / length * ratio * scale / aspect, y: brow.y + ay / length * ratio * scale };
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null;
}

/**
 * Detecta el nacimiento del cabello como fin de la piel visible: modela el color de la piel del
 * propio paciente (frente baja y mejillas) y recorre rayos hacia arriba hasta salir de ese color.
 * Funciona con cabello claro y fondo; si no hay salida coherente, recurre al contraste oscuro.
 */
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
  const ycc = (x: number, y: number) => {
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) return null;
    let r = 0, g = 0, b = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const i = ((Math.round(y) + oy) * width + Math.round(x) + ox) * 4;
      r += data[i] / 9; g += data[i + 1] / 9; b += data[i + 2] / 9;
    }
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return [l, 0.564 * (b - l), 0.713 * (r - l)];
  };
  const samples = [
    ...[0.25, 0.45, 0.65].flatMap(t => [-0.12, 0, 0.12].map(o => ({
      x: (brow.x + (top.x - brow.x) * t) * width + axis.y * o * faceHeight, y: (brow.y + (top.y - brow.y) * t) * height - axis.x * o * faceHeight }))),
    ...[50, 280, 205, 425].map(i => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })),
  ].map(p => ycc(p.x, p.y)).filter((v): v is number[] => !!v);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  if (samples.length >= 8) {
    const center = [0, 1, 2].map(c => median(samples.map(s => s[c])));
    const spread = [0, 1, 2].map(c => median(samples.map(s => Math.abs(s[c] - center[c]))));
    const tolerance = [Math.max(45, spread[0] * 4), Math.max(9, spread[1] * 4), Math.max(9, spread[2] * 4)];
    const isSkin = (v: number[]) => v.every((value, c) => Math.abs(value - center[c]) <= tolerance[c]);
    const run = Math.max(3, faceHeight * 0.02);
    const distances = [-0.1, -0.05, 0, 0.05, 0.1].map(offset => {
      const x = top.x * width + axis.y * offset * faceHeight, y = top.y * height - axis.x * offset * faceHeight;
      const back = Math.round(faceHeight * 0.06);
      const start = ycc(x - axis.x * back, y - axis.y * back);
      if (!start || !isSkin(start)) return null;
      let outside = 0;
      for (let d = -back; d < faceHeight * 0.35; d++) {
        const value = ycc(x + axis.x * d, y + axis.y * d);
        if (!value) return outside ? d - outside : null;
        outside = isSkin(value) ? 0 : outside + 1;
        if (outside >= run) return d - outside + 1;
      }
      return null;
    }).filter((d): d is number => d !== null).sort((a, b) => a - b);
    if (distances.length >= 2 && distances.at(-1)! - distances[0] <= faceHeight * 0.08) {
      const d = Math.max(0, distances[Math.floor(distances.length / 2)] - 1);
      return { point: { x: top.x + axis.x * d / width, y: top.y + axis.y * d / height },
        reason: `Nacimiento del cabello candidato: fin de la piel visible en ${distances.length} de 5 trazos. Confirma que el punto quede sobre piel, justo antes del cabello.` };
    }
  }
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
