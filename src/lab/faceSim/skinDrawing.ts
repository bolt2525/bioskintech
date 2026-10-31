import type { P2 } from './engine';

/** Puente sin estado duplicado: foto y raycast alimentan el mismo borrador UV. */
export interface SkinModelDrawing {
  enabled: boolean;
  start: (point: P2) => void;
  move: (point: P2) => void;
  finish: (point: P2) => void;
  cancel: () => void;
  stop: () => void;
}

/** Pincel conservador: un ROI circular por gesto corto, nunca un hull que rellene huecos. */
export function skinBrushPolygon(points: readonly P2[], radius = 0.035): P2[] {
  if (!points.length || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
  const center = points[0];
  // Un recorrido largo requiere contorno explícito: no simular éxito con una caja envolvente.
  if (points.some(p => Math.hypot(p.x - center.x, p.y - center.y) > radius * 0.5)) return [];
  return Array.from({ length: 24 }, (_, i) => ({
    x: center.x + Math.cos(i * Math.PI / 12) * radius,
    y: center.y + Math.sin(i * Math.PI / 12) * radius,
  }));
}
