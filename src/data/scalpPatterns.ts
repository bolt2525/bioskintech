export const NORWOOD_STAGES = ['I', 'II', 'III', 'III Vertex', 'IV', 'V', 'VI', 'VII'];
export const LUDWIG_STAGES = ['I', 'II', 'III'];

export const NORWOOD_DESCRIPTIONS = [
  'Línea frontal conservada',
  'Retroceso temporal leve',
  'Entradas profundas; región superior conservada',
  'Entradas y aclaramiento localizado del vértex',
  'Pérdida frontal y vértex separados por un puente ancho',
  'Puente superior estrecho y menos denso, todavía presente',
  'Desaparece el puente; frente y vértex confluyen',
  'Banda lateral y occipital más baja y estrecha',
];
export const LUDWIG_DESCRIPTIONS = [
  'Raya ensanchada y aclaramiento superior leve; frente conservada',
  'Aclaramiento superior difuso moderado; frente conservada',
  'Aclaramiento superior intenso; banda frontal conservada',
];

type Pattern = { scale: 'norwood' | 'ludwig'; stage: string };
type Position = { x: number; y: number; z: number };
const smoothstep = (value: number, low: number, high: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

// Coordinates are those of the normalized clinical head, not calibrated scalp measurements.
export const getScalpCoverage = ({ x, y, z }: Position, { scale, stage }: Pattern): number => {
  if (scale === 'ludwig') {
    const index = Math.max(0, LUDWIG_STAGES.indexOf(stage));
    const upperScalp = smoothstep(y, 1.35, 1.95);
    const frontalPreservation = 1 - smoothstep(z, 1.12, 1.38);
    const diffuse = Math.exp(-((x / [0.62, 0.82, 1.02][index]) ** 4))
      * upperScalp * frontalPreservation;
    const part = Math.exp(-((x / [0.035, 0.07, 0.12][index]) ** 2))
      * upperScalp * frontalPreservation;
    return Math.max(0.025, (1 - diffuse * [0.3, 0.62, 0.94][index]) * (1 - part * 0.8));
  }

  const index = Math.max(0, NORWOOD_STAGES.indexOf(stage));
  if (index >= 6) {
    const rimHeight = index === 6 ? 1.42 : 0.96;
    return 1 - smoothstep(y, rimHeight - 0.06, rimHeight + 0.06);
  }
  const temple = Math.exp(-(((Math.abs(x) - 0.78) / 0.31) ** 2));
  const frontLimit = [1.62, 1.53, 1.46, 1.46, 1.0, 0.4][index]
    - temple * [0.04, 0.62, 0.82, 0.82, 0.9, 0.6][index];
  const frontLoss = smoothstep(z, frontLimit - 0.055, frontLimit + 0.055)
    * smoothstep(y, 1.05, 1.4);
  const crownRadiusX = [0, 0, 0, 0.32, 0.49, 0.68][index];
  const crownRadiusZ = [0, 0, 0, 0.34, 0.46, 0.58][index];
  const crownDistance = crownRadiusX
    ? Math.hypot(x / crownRadiusX, (z + 0.65) / crownRadiusZ)
    : 10;
  const crownLoss = (1 - smoothstep(crownDistance, 0.9, 1.1))
    * smoothstep(y, 1.35, 1.85);
  const bridgeThinning = index === 5
    ? 0.36 * smoothstep(y, 1.65, 2.15) * (1 - smoothstep(Math.abs(x), 0.5, 0.95))
    : 0;
  return (1 - Math.max(frontLoss, crownLoss)) * (1 - bridgeThinning);
};

export const getScalpDensity = (density: 'Alta' | 'Media' | 'Baja' | null): number =>
  density === 'Alta' ? 1 : density === 'Baja' ? 0.32 : 0.64;
