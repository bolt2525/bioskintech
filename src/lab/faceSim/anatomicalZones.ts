import type { ReferenceKind } from './maskAnatomy';

export interface AnatomicalZone {
  label: string;
  points: readonly (readonly [number, number])[];
  /** Tolerancia sobre una línea dibujada en la ilustración, no diámetro de una arteria real. */
  radius?: number;
}
const polygon = (label: string, points: AnatomicalZone['points']): AnatomicalZone => ({ label, points });
const line = (label: string, points: AnatomicalZone['points']): AnatomicalZone => ({ label, points, radius: 0.018 });
const paired = (zone: AnatomicalZone): AnatomicalZone[] => [
  { ...zone, label: `${zone.label} · derecho (referencia)` },
  { ...zone, label: `${zone.label} · izquierdo (referencia)`, points: zone.points.map(([x, y]) => [1 - x, y]) },
];

/** Regiones autoradas sobre las ilustraciones limpias incluidas; no detección de anatomía individual. */
export const ANATOMICAL_ZONES: Record<ReferenceKind, readonly AnatomicalZone[]> = {
  muscle: [
    polygon('Prócer', [[0.45, 0.45], [0.55, 0.45], [0.54, 0.57], [0.46, 0.57]]),
    polygon('Nasal', [[0.43, 0.57], [0.57, 0.57], [0.62, 0.69], [0.38, 0.69]]),
    ...paired(polygon('Orbicular del ojo', [[0.20, 0.45], [0.39, 0.43], [0.44, 0.50], [0.41, 0.59], [0.24, 0.63], [0.17, 0.54]])),
    ...paired(polygon('Vientre frontal del occipitofrontal', [[0.22, 0.17], [0.42, 0.13], [0.48, 0.29], [0.43, 0.46], [0.22, 0.44]])),
    ...paired(polygon('Temporal', [[0.17, 0.28], [0.21, 0.28], [0.20, 0.47], [0.16, 0.47]])),
    ...paired(polygon('Elevador del labio superior y ala nasal', [[0.42, 0.55], [0.46, 0.56], [0.43, 0.74], [0.38, 0.73]])),
    ...paired(polygon('Elevador del labio superior', [[0.36, 0.58], [0.42, 0.59], [0.38, 0.74], [0.32, 0.71]])),
    ...paired(polygon('Cigomático menor', [[0.27, 0.59], [0.33, 0.61], [0.39, 0.74], [0.34, 0.73]])),
    ...paired(polygon('Cigomático mayor', [[0.22, 0.61], [0.27, 0.63], [0.35, 0.77], [0.30, 0.78]])),
    ...paired(polygon('Buccinador', [[0.25, 0.71], [0.31, 0.75], [0.32, 0.81], [0.24, 0.79]])),
    ...paired(polygon('Masetero', [[0.19, 0.66], [0.23, 0.70], [0.24, 0.83], [0.20, 0.86]])),
    polygon('Orbicular de la boca', [[0.34, 0.72], [0.66, 0.72], [0.71, 0.81], [0.62, 0.89], [0.38, 0.89], [0.29, 0.81]]),
    ...paired(polygon('Depresor del ángulo de la boca', [[0.25, 0.81], [0.32, 0.83], [0.36, 0.94], [0.27, 0.92]])),
    ...paired(polygon('Depresor del labio inferior', [[0.36, 0.87], [0.44, 0.89], [0.44, 0.96], [0.35, 0.95]])),
    polygon('Mentoniano', [[0.45, 0.89], [0.55, 0.89], [0.56, 0.98], [0.44, 0.98]]),
  ],
  vessels: [
    ...paired(line('Arteria supratroclear', [[0.46, 0.41], [0.44, 0.32], [0.45, 0.22], [0.46, 0.12]])),
    ...paired(line('Arteria supraorbitaria', [[0.39, 0.39], [0.36, 0.29], [0.35, 0.19], [0.36, 0.12]])),
    ...paired(line('Arteria temporal superficial', [[0.14, 0.47], [0.16, 0.37], [0.18, 0.30], [0.22, 0.26], [0.23, 0.17]])),
    ...paired(line('Arteria angular', [[0.36, 0.58], [0.40, 0.52], [0.42, 0.46], [0.44, 0.43]])),
    ...paired(line('Arteria nasal lateral', [[0.29, 0.56], [0.34, 0.57], [0.39, 0.58], [0.43, 0.60]])),
    ...paired(line('Ramas infraorbitarias', [[0.24, 0.54], [0.29, 0.55], [0.32, 0.56], [0.35, 0.57]])),
    ...paired(line('Arteria labial superior', [[0.29, 0.65], [0.36, 0.65], [0.44, 0.64], [0.50, 0.65]])),
    ...paired(line('Arteria labial inferior', [[0.28, 0.70], [0.36, 0.73], [0.44, 0.74], [0.50, 0.74]])),
    ...paired(line('Arteria facial', [[0.25, 0.77], [0.25, 0.72], [0.29, 0.66], [0.34, 0.62], [0.36, 0.58]])),
  ],
  bone: [
    polygon('Hueso frontal', [[0.20, 0.12], [0.80, 0.12], [0.85, 0.38], [0.68, 0.41], [0.50, 0.37], [0.32, 0.41], [0.15, 0.38]]),
    polygon('Huesos nasales', [[0.45, 0.40], [0.55, 0.40], [0.57, 0.53], [0.43, 0.53]]),
    ...paired(polygon('Reborde orbitario', [[0.18, 0.40], [0.38, 0.40], [0.44, 0.47], [0.40, 0.58], [0.20, 0.60], [0.14, 0.50]])),
    ...paired(polygon('Hueso cigomático', [[0.14, 0.57], [0.28, 0.58], [0.33, 0.68], [0.19, 0.69], [0.10, 0.64]])),
    ...paired(polygon('Maxilar', [[0.32, 0.58], [0.44, 0.57], [0.44, 0.68], [0.50, 0.71], [0.50, 0.77], [0.29, 0.76]])),
    polygon('Mandíbula', [[0.12, 0.65], [0.24, 0.70], [0.25, 0.81], [0.39, 0.87], [0.61, 0.87], [0.75, 0.81], [0.76, 0.70], [0.88, 0.65], [0.83, 0.86], [0.67, 0.95], [0.33, 0.95], [0.17, 0.86]]),
  ],
};

export function anatomicalZoneAt(zones: readonly AnatomicalZone[], u: number, v: number): string | null {
  if (![u, v].every(Number.isFinite) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  for (const zone of zones) {
    if (zone.radius) {
      for (let i = 1; i < zone.points.length; i++) {
        const [ax, ay] = zone.points[i - 1], [bx, by] = zone.points[i];
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(u - ax - t * dx, v - ay - t * dy) <= zone.radius) return zone.label;
      }
    } else {
      let inside = false;
      for (let i = 0, j = zone.points.length - 1; i < zone.points.length; j = i++) {
        const [ax, ay] = zone.points[i], [bx, by] = zone.points[j];
        if ((ay > v) !== (by > v) && u < (bx - ax) * (v - ay) / (by - ay) + ax) inside = !inside;
      }
      if (inside) return zone.label;
    }
  }
  return null;
}
