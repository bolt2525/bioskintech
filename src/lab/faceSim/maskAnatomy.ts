import type { AnatomyPlane } from './defaultLayers';

export type ReferenceKind = Exclude<AnatomyPlane, 'skin'>;
export interface MaskReveal {
  mode: 'none' | 'progressive' | 'compare';
  progress: number;
  from: 'skin' | 'muscle';
  to: 'muscle' | 'bone';
}
export const INITIAL_REVEAL: MaskReveal = { mode: 'none', progress: 0, from: 'skin', to: 'muscle' };

/** Dos transiciones ilustrativas; los vasos acompañan al músculo, no son un estrato medido. */
export function revealStage(reveal: MaskReveal): { from: AnatomyPlane; to: AnatomyPlane; fraction: number } | null {
  if (!Number.isFinite(reveal.progress) || reveal.progress < 0 || reveal.progress > 1) {
    throw new Error('El avance del corte debe estar entre cero y uno.');
  }
  if (reveal.mode === 'none') return null;
  if (reveal.mode === 'compare') {
    if (reveal.from === reveal.to || reveal.from === 'muscle' && reveal.to !== 'bone') {
      throw new Error('Selecciona dos planos distintos, del superficial al profundo.');
    }
    return { from: reveal.from, to: reveal.to, fraction: reveal.progress };
  }
  return reveal.progress < 0.5
    ? { from: 'skin', to: 'muscle', fraction: reveal.progress * 2 }
    : { from: 'muscle', to: 'bone', fraction: (reveal.progress - 0.5) * 2 };
}

export function revealPlane(minZ: number, maxZ: number, fraction: number) {
  if (![minZ, maxZ, fraction].every(Number.isFinite) || maxZ <= minZ || fraction < 0 || fraction > 1) {
    throw new Error('Límites inválidos para el corte de la máscara.');
  }
  const margin = (maxZ - minZ) * 0.01;
  return { normal: { x: 0, y: 0, z: -1 }, constant: maxZ + margin - (maxZ - minZ + margin * 2) * fraction };
}

/**
 * Reverso mate liso y paredes cortas. No duplica la fotografía ni reconstruye un cráneo.
 * El reverso se suaviza para no repetir ojos/boca en negativo (ilusión de cara cóncava);
 * ojos y boca se cierran con un bolsillo poco profundo delante y una tapa detrás.
 */
export function buildMaskBacking(positions: Float32Array, indices: Uint32Array, thicknessRatio = 0.11) {
  if (!Number.isFinite(thicknessRatio) || thicknessRatio <= 0 || thicknessRatio > 0.3) throw new Error('Grosor relativo inválido para el reverso.');
  if (positions.length < 9 || positions.length % 3 || indices.length % 3 || !positions.every(Number.isFinite)) {
    throw new Error('Superficie inválida para cerrar el reverso.');
  }
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j], b = indices[i + (j + 1) % 3];
    if (Math.max(a, b) * 3 + 2 >= positions.length) throw new Error('Índice fuera de la máscara.');
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`, edge = edges.get(key);
    if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
  }
  if ([...edges.values()].some(edge => edge.count > 2)) throw new Error('La máscara tiene aristas no manifold.');
  const boundary = [...edges.values()].filter(edge => edge.count === 1);
  if (!boundary.length) throw new Error('No se encontró el contorno de la máscara.');
  const used = new Set(indices);
  const xs = [...used].map(id => positions[id * 3]);
  const thickness = (Math.max(...xs) - Math.min(...xs)) * thicknessRatio;
  if (!thickness) throw new Error('La máscara no tiene anchura.');

  // Lazos de contorno consumiendo aristas (un vértice de esquina puede pertenecer a dos lazos).
  const outgoing = new Map<number, number[]>();
  for (const { a, b } of boundary) outgoing.set(a, [...(outgoing.get(a) ?? []), b]);
  const loops: number[][] = [];
  for (const start of [...outgoing.keys()]) {
    while (outgoing.get(start)?.length) {
      const loop: number[] = [];
      let id = start;
      do {
        loop.push(id);
        const targets = outgoing.get(id);
        const target = targets?.shift();
        if (target === undefined) break;
        id = target;
      } while (id !== start && loop.length <= boundary.length);
      if (loop.length >= 3) loops.push(loop);
    }
  }
  if (!loops.length) throw new Error('No se encontró el contorno de la máscara.');
  const span = (loop: number[]) => {
    const lx = loop.map(id => positions[id * 3]), ly = loop.map(id => positions[id * 3 + 1]);
    return (Math.max(...lx) - Math.min(...lx)) * (Math.max(...ly) - Math.min(...ly));
  };
  const outer = loops.reduce((best, loop) => span(loop) > span(best) ? loop : best);
  const inner = loops.filter(loop => loop !== outer);
  const fixed = new Set(outer);

  const count = positions.length / 3, neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const { a, b } of edges.values()) { neighbours[a].push(b); neighbours[b].push(a); }
  // Membrana laplaciana completa (XYZ) con el borde exterior fijo: superficie mínima sin relieve facial.
  // Mantener XY frontal plegaba laterales nasales y boca y volvía a dibujar la cara en negativo.
  let membrane = Float64Array.from(positions);
  for (let iteration = 0; iteration < 400; iteration++) {
    const smoothed = membrane.slice();
    for (let id = 0; id < count; id++) {
      if (fixed.has(id) || !neighbours[id].length) continue;
      for (let axis = 0; axis < 3; axis++) {
        smoothed[id * 3 + axis] = neighbours[id].reduce((sum, n) => sum + membrane[n * 3 + axis], 0) / neighbours[id].length;
      }
    }
    membrane = smoothed;
  }

  const extra = inner.length * 2;
  const result = new Float32Array((count * 2 + extra) * 3), triangles: number[] = [];
  result.set(positions);
  for (let id = 0; id < count; id++) {
    const front = positions[id * 3 + 2];
    result[(id + count) * 3] = membrane[id * 3];
    result[(id + count) * 3 + 1] = membrane[id * 3 + 1];
    result[(id + count) * 3 + 2] = Math.min(membrane[id * 3 + 2] - thickness, front - thickness * 0.3);
  }
  for (let i = 0; i < indices.length; i += 3) triangles.push(indices[i] + count, indices[i + 2] + count, indices[i + 1] + count);
  for (let k = 0; k < outer.length; k++) {
    const a = outer[k], b = outer[(k + 1) % outer.length];
    triangles.push(b, a, a + count, b, a + count, b + count);
  }
  inner.forEach((loop, k) => {
    const pocket = count * 2 + k * 2, cap = pocket + 1;
    for (const [target, offset, depth] of [[pocket, 0, thickness * 0.35], [cap, count, 0]] as const) {
      for (let axis = 0; axis < 3; axis++) {
        result[target * 3 + axis] = loop.reduce((sum, id) => sum + result[(id + offset) * 3 + axis], 0) / loop.length;
      }
      result[target * 3 + 2] -= depth;
    }
    // Lazo a→b sigue la orientación de la piel; el bolsillo la continúa y la tapa la invierte como el reverso.
    for (let j = 0; j < loop.length; j++) {
      const a = loop[j], b = loop[(j + 1) % loop.length];
      triangles.push(b, a, pocket, a + count, b + count, cap);
    }
  });
  return { positions: result, indices: Uint32Array.from(triangles), thickness };
}
