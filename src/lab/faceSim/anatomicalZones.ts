import type { ReferenceKind } from './maskAnatomy';

export interface AnatomicalZone {
  label: string;
  points: readonly (readonly [number, number])[];
  /** Tolerancia sobre una línea dibujada en la ilustración, no diámetro de una arteria real. */
  radius?: number;
}
const polygon = (label: string, points: AnatomicalZone['points']): AnatomicalZone => ({ label, points });
const line = (label: string, points: AnatomicalZone['points']): AnatomicalZone => ({ label, points, radius: 0.009 });
const paired = (zone: AnatomicalZone): AnatomicalZone[] => [
  { ...zone, label: `${zone.label} · derecho (referencia)` },
  { ...zone, label: `${zone.label} · izquierdo (referencia)`, points: zone.points.map(([x, y]) => [1 - x, y]) },
];

/** Abertura piriforme medida en oseo.webp (369×509), no incluye los huesos nasales altos. */
export const BONE_NASAL_OPENING = polygon('Abertura nasal ilustrada', [
  [0.505, 0.455], [0.537, 0.461], [0.559, 0.510], [0.588, 0.559],
  [0.602, 0.599], [0.580, 0.626], [0.545, 0.634], [0.520, 0.613],
  [0.493, 0.635], [0.458, 0.630], [0.431, 0.608], [0.442, 0.563], [0.477, 0.505],
]);

/** UV de imagen completa con origen arriba-izquierda, exactamente los del mapa sin padding. */
export function isBoneNasalOpening(u: number, v: number): boolean {
  return anatomicalZoneAt([BONE_NASAL_OPENING], u, v) !== null;
}

/** Regiones autoradas por inspección de las imágenes locales; no detección de anatomía individual. */
export const ANATOMICAL_ZONES: Record<ReferenceKind, readonly AnatomicalZone[]> = {
  muscle: [
    polygon('Prócer', [[0.475, 0.425], [0.525, 0.425], [0.548, 0.596], [0.500, 0.575], [0.452, 0.596]]),
    polygon('Nasal', [[0.452, 0.596], [0.500, 0.575], [0.548, 0.596], [0.590, 0.676], [0.555, 0.710], [0.445, 0.710], [0.410, 0.676]]),
    ...paired(polygon('Orbicular del ojo', [[0.20, 0.45], [0.39, 0.43], [0.44, 0.50], [0.41, 0.59], [0.24, 0.63], [0.17, 0.54]])),
    ...paired(polygon('Vientre frontal del occipitofrontal', [[0.22, 0.17], [0.42, 0.13], [0.48, 0.29], [0.43, 0.46], [0.22, 0.44]])),
    ...paired(polygon('Temporal', [[0.17, 0.28], [0.21, 0.28], [0.20, 0.47], [0.16, 0.47]])),
    ...paired(polygon('Elevador del labio superior y ala nasal', [[0.440, 0.548], [0.460, 0.580], [0.409, 0.683], [0.421, 0.725], [0.383, 0.739], [0.395, 0.650]])),
    ...paired(polygon('Elevador del labio superior', [[0.36, 0.58], [0.42, 0.59], [0.38, 0.74], [0.32, 0.71]])),
    ...paired(polygon('Cigomático menor', [[0.245, 0.603], [0.290, 0.620], [0.402, 0.709], [0.380, 0.737], [0.300, 0.678]])),
    ...paired(polygon('Cigomático mayor', [[0.208, 0.622], [0.244, 0.641], [0.355, 0.723], [0.337, 0.762], [0.272, 0.711]])),
    ...paired(polygon('Buccinador', [[0.25, 0.71], [0.31, 0.75], [0.32, 0.81], [0.24, 0.79]])),
    ...paired(polygon('Masetero', [[0.184, 0.638], [0.230, 0.695], [0.276, 0.742], [0.298, 0.792], [0.257, 0.838], [0.208, 0.802]])),
    polygon('Orbicular de la boca', [[0.34, 0.72], [0.66, 0.72], [0.71, 0.81], [0.62, 0.89], [0.38, 0.89], [0.29, 0.81]]),
    ...paired(polygon('Depresor del ángulo de la boca', [[0.25, 0.81], [0.32, 0.83], [0.36, 0.94], [0.27, 0.92]])),
    ...paired(polygon('Depresor del labio inferior', [[0.36, 0.87], [0.44, 0.89], [0.44, 0.96], [0.35, 0.95]])),
    polygon('Mentoniano', [[0.45, 0.89], [0.55, 0.89], [0.56, 0.98], [0.44, 0.98]]),
  ],
  vessels: [
    ...paired(line('Arteria supratroclear', [[0.451, 0.432], [0.438, 0.393], [0.446, 0.332], [0.409, 0.284], [0.396, 0.247], [0.414, 0.233], [0.453, 0.232], [0.495, 0.236]])),
    ...paired(line('Arteria supraorbitaria', [[0.400, 0.384], [0.359, 0.348], [0.355, 0.285], [0.349, 0.215], [0.352, 0.153]])),
    ...paired(line('Arteria temporal superficial', [[0.136, 0.501], [0.142, 0.437], [0.151, 0.381], [0.187, 0.361], [0.190, 0.299], [0.233, 0.276], [0.246, 0.237], [0.239, 0.199]])),
    ...paired(line('Arteria angular', [[0.358, 0.568], [0.385, 0.546], [0.399, 0.500], [0.410, 0.458], [0.432, 0.446]])),
    ...paired(line('Arteria nasal lateral', [[0.362, 0.570], [0.391, 0.558], [0.411, 0.570], [0.430, 0.579]])),
    ...paired(line('Ramas infraorbitarias', [[0.237, 0.544], [0.277, 0.555], [0.303, 0.565], [0.349, 0.564]])),
    ...paired(line('Arteria labial superior', [[0.315, 0.655], [0.363, 0.643], [0.406, 0.639], [0.463, 0.644], [0.500, 0.644]])),
    ...paired(line('Arteria labial inferior', [[0.297, 0.704], [0.328, 0.717], [0.391, 0.737], [0.455, 0.744], [0.500, 0.741]])),
    ...paired(line('Arteria facial', [[0.295, 0.763], [0.288, 0.713], [0.296, 0.674], [0.324, 0.641], [0.349, 0.614], [0.359, 0.582]])),
  ],
  bone: [
    polygon('Hueso frontal', [[0.20, 0.12], [0.80, 0.12], [0.85, 0.38], [0.68, 0.41], [0.50, 0.37], [0.32, 0.41], [0.15, 0.38]]),
    polygon('Huesos nasales', [[0.468, 0.381], [0.542, 0.381], [0.553, 0.457], [0.518, 0.448], [0.484, 0.489], [0.456, 0.510]]),
    ...paired(polygon('Reborde orbitario', [[0.18, 0.40], [0.38, 0.40], [0.44, 0.47], [0.40, 0.58], [0.20, 0.60], [0.14, 0.50]])),
    ...paired(polygon('Hueso cigomático', [[0.14, 0.57], [0.28, 0.58], [0.33, 0.68], [0.19, 0.69], [0.10, 0.64]])),
    ...paired(polygon('Maxilar', [[0.32, 0.58], [0.44, 0.57], [0.44, 0.68], [0.50, 0.71], [0.50, 0.77], [0.29, 0.76]])),
    polygon('Mandíbula', [[0.12, 0.65], [0.24, 0.70], [0.25, 0.81], [0.39, 0.87], [0.61, 0.87], [0.75, 0.81], [0.76, 0.70], [0.88, 0.65], [0.83, 0.86], [0.67, 0.95], [0.33, 0.95], [0.17, 0.86]]),
  ],
};

export function anatomicalZoneAt(zones: readonly AnatomicalZone[], u: number, v: number): string | null {
  if (![u, v].every(Number.isFinite) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (zones === ANATOMICAL_ZONES.bone && isBoneNasalOpening(u, v)) return null;
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
