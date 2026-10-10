export const NORWOOD_STAGES = ['I', 'II', 'III', 'III Vertex', 'IV', 'V', 'VI', 'VII'];
export const LUDWIG_STAGES = ['I', 'II', 'III'];
export const SAVIN_STAGES = ['I-1', 'I-2', 'I-3', 'I-4', 'II-1', 'II-2', 'III', 'Advanced', 'Frontal'];
export type ScalpScale = 'norwood' | 'ludwig' | 'savin';
export const SCALP_SCALE_LABELS: Record<ScalpScale, string> = {
  norwood: 'Norwood', ludwig: 'Ludwig', savin: 'Savin (Ludwig ampliada)',
};

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
export const SAVIN_DESCRIPTIONS = [
  'Raya central estrecha; densidad prácticamente conservada',
  'Ensanchamiento muy leve de la raya',
  'Raya más ancha y aclaramiento central visible',
  'Aclaramiento central marcado, con cabello superior todavía presente',
  'Aclaramiento oval superior que supera la raya central',
  'Área superior de aclaramiento más amplia y menos densa',
  'Pérdida superior intensa; banda frontal conservada',
  'Pérdida superior casi completa; variante avanzada',
  'Retroceso frontal con aclaramiento central; variante, no etapa posterior',
];
export const getScalpStages = (scale: ScalpScale): string[] =>
  scale === 'savin' ? SAVIN_STAGES : scale === 'ludwig' ? LUDWIG_STAGES : NORWOOD_STAGES;
export const getScalpDescriptions = (scale: ScalpScale): string[] =>
  scale === 'savin' ? SAVIN_DESCRIPTIONS : scale === 'ludwig' ? LUDWIG_DESCRIPTIONS : NORWOOD_DESCRIPTIONS;
export const getScalpStageLabel = (stage: string): string =>
  stage === 'Advanced' ? 'Avanzada' : stage === 'Frontal' ? 'Frontal (variante)' : stage;

type Pattern = { scale: ScalpScale; stage: string };
type Position = { x: number; y: number; z: number };
const SAVIN_WIDTHS = [0.24, 0.34, 0.46, 0.58, 0.72, 0.86, 1.02, 1.16, 0.5];
const SAVIN_LOSSES = [0.04, 0.14, 0.28, 0.43, 0.6, 0.76, 0.94, 0.995, 0.36];
const SAVIN_PART_WIDTHS = [0.018, 0.035, 0.06, 0.095, 0.14, 0.2, 0.3, 0.4, 0.08];
const LUDWIG_WIDTHS = [0.62, 0.82, 1.02];
const LUDWIG_LOSSES = [0.3, 0.62, 0.94];
const LUDWIG_PART_WIDTHS = [0.035, 0.07, 0.12];
const NORWOOD_FRONT_LIMITS = [1.62, 1.53, 1.46, 1.46, 1.0, 0.4];
const NORWOOD_TEMPLE_LOSSES = [0.04, 0.62, 0.82, 0.82, 0.9, 0.6];
const NORWOOD_CROWN_X = [0, 0, 0, 0.32, 0.49, 0.68];
const NORWOOD_CROWN_Z = [0, 0, 0, 0.34, 0.46, 0.58];
const smoothstep = (value: number, low: number, high: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

// Coordinates are those of the normalized clinical head, not calibrated scalp measurements.
export const getScalpCoverage = ({ x, y, z }: Position, { scale, stage }: Pattern): number => {
  if (scale === 'savin') {
    const index = Math.max(0, SAVIN_STAGES.indexOf(stage));
    const upperScalp = smoothstep(y, 1.3, 1.9);
    const preserveFront = 1 - smoothstep(z, 1.12, 1.38);
    const oval = Math.exp(-((x / SAVIN_WIDTHS[index]) ** 4) - (((z + 0.1) / 1.22) ** 6));
    const diffuse = oval * upperScalp * preserveFront;
    const part = Math.exp(-((x / SAVIN_PART_WIDTHS[index]) ** 2)) * upperScalp * preserveFront;
    const frontalLoss = stage === 'Frontal'
      ? smoothstep(z, 0.98, 1.2) * smoothstep(y, 1.15, 1.5)
      : 0;
    return Math.max(0.005, (1 - diffuse * SAVIN_LOSSES[index]) * (1 - part * 0.8) * (1 - frontalLoss));
  }
  if (scale === 'ludwig') {
    const index = Math.max(0, LUDWIG_STAGES.indexOf(stage));
    const upperScalp = smoothstep(y, 1.35, 1.95);
    const frontalPreservation = 1 - smoothstep(z, 1.12, 1.38);
    const diffuse = Math.exp(-((x / LUDWIG_WIDTHS[index]) ** 4))
      * upperScalp * frontalPreservation;
    const part = Math.exp(-((x / LUDWIG_PART_WIDTHS[index]) ** 2))
      * upperScalp * frontalPreservation;
    return Math.max(0.025, (1 - diffuse * LUDWIG_LOSSES[index]) * (1 - part * 0.8));
  }

  const index = Math.max(0, NORWOOD_STAGES.indexOf(stage));
  if (index >= 6) {
    const rimHeight = index === 6 ? 1.42 : 0.96;
    return 1 - smoothstep(y, rimHeight - 0.06, rimHeight + 0.06);
  }
  const temple = Math.exp(-(((Math.abs(x) - 0.78) / 0.31) ** 2));
  const frontLimit = NORWOOD_FRONT_LIMITS[index] - temple * NORWOOD_TEMPLE_LOSSES[index];
  const frontLoss = smoothstep(z, frontLimit - 0.055, frontLimit + 0.055)
    * smoothstep(y, 1.05, 1.4);
  const crownRadiusX = NORWOOD_CROWN_X[index];
  const crownRadiusZ = NORWOOD_CROWN_Z[index];
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
