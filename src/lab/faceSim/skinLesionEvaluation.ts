export const SKIN_LESION_CATEGORIES = {
  acne: 'Acné',
  spot: 'Mancha no especificada',
  nevus: 'Lunar',
  scar: 'Cicatriz',
  melasma: 'Melasma',
  pore: 'Poro',
  'fine-wrinkle': 'Arruga fina',
  'coarse-wrinkle': 'Arruga gruesa',
} as const;
export type SkinLesionCategory = keyof typeof SKIN_LESION_CATEGORIES;
export interface SkinEvaluationBox {
  category: SkinLesionCategory;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface ReferenceImage { id: string; group: string; boxes: SkinEvaluationBox[] }
interface PredictionImage { id: string; boxes: (SkinEvaluationBox & { score: number })[] }
interface ReferenceSet { version: 1; trainingGroups: string[]; images: ReferenceImage[] }
interface PredictionSet { version: 1; model: string; images: PredictionImage[] }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
function isBox(value: unknown): value is SkinEvaluationBox {
  if (!object(value) || typeof value.category !== 'string'
    || !Object.prototype.hasOwnProperty.call(SKIN_LESION_CATEGORIES, value.category)) return false;
  const { x, y, width, height } = value;
  return [x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item))
    && typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number'
    && x >= 0 && y >= 0 && width > 0 && height > 0 && width * height > 0
    && x + width > x && y + height > y && x + width <= 1 + 1e-8 && y + height <= 1 + 1e-8;
}
function referenceSet(value: unknown): asserts value is ReferenceSet {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.trainingGroups) || !value.trainingGroups.every(identifier)
    || !Array.isArray(value.images) || !value.images.length || value.images.length > 10000
    || !value.images.every(image => object(image) && identifier(image.id) && identifier(image.group)
      && Array.isArray(image.boxes) && image.boxes.length <= 2000 && image.boxes.every(isBox))) {
    throw new TypeError('Referencias inválidas: usa versión 1, grupos seudónimos e imágenes con cajas normalizadas y categorías admitidas.');
  }
  if (new Set(value.images.map(image => image.id)).size !== value.images.length) throw new Error('Las referencias repiten identificadores de imagen.');
  const training = new Set(value.trainingGroups);
  if (value.images.some(image => training.has(image.group))) throw new Error('Evaluación rechazada: hay grupos compartidos con entrenamiento.');
}
function predictionSet(value: unknown): asserts value is PredictionSet {
  if (!object(value) || value.version !== 1 || !identifier(value.model) || !Array.isArray(value.images)
    || value.images.length > 10000 || !value.images.every(image => object(image) && identifier(image.id)
      && Array.isArray(image.boxes) && image.boxes.length <= 2000 && image.boxes.every(box =>
        isBox(box) && object(box) && typeof box.score === 'number' && Number.isFinite(box.score) && box.score >= 0 && box.score <= 1))) {
    throw new TypeError('Predicciones inválidas: incluye versión 1, modelo identificado y score entre 0 y 1 en cada caja.');
  }
  if (new Set(value.images.map(image => image.id)).size !== value.images.length) throw new Error('Las predicciones repiten identificadores de imagen.');
}
export function skinBoxIoU(a: SkinEvaluationBox, b: SkinEvaluationBox): number {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return Math.min(1, intersection / (a.width * a.height + b.width * b.height - intersection));
}

/** Evaluación de cajas a IoU 0,5; no certificación clínica, ni evaluación de máscaras o profundidad. */
export function evaluateSkinLesions(references: unknown, predictions: unknown) {
  referenceSet(references); predictionSet(predictions);
  const byId = new Map(predictions.images.map(image => [image.id, image]));
  if (byId.size !== references.images.length || references.images.some(image => !byId.has(image.id))) {
    throw new Error('Incluye exactamente las mismas imágenes en ambos archivos; representa una detección vacía con boxes: [].');
  }
  const classes = Object.keys(SKIN_LESION_CATEGORIES) as SkinLesionCategory[];
  const results = classes.map(category => {
    let truePositive = 0, falsePositive = 0, falseNegative = 0;
    for (const reference of references.images) {
      const truth = reference.boxes.filter(box => box.category === category), matched = new Set<number>();
      const found = byId.get(reference.id)!.boxes.filter(box => box.category === category).slice().sort((a, b) => b.score - a.score);
      for (const prediction of found) {
        let best = -1, overlap = .5;
        truth.forEach((box, index) => {
          const iou = skinBoxIoU(prediction, box);
          if (!matched.has(index) && iou >= overlap) { best = index; overlap = iou; }
        });
        if (best >= 0) { matched.add(best); truePositive++; } else falsePositive++;
      }
      falseNegative += truth.length - matched.size;
    }
    const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
    const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
    return {
      category, referenceCount: truePositive + falseNegative, predictionCount: truePositive + falsePositive,
      truePositive, falsePositive, falseNegative, precision, recall,
      observedAbove70: precision !== null && recall !== null && precision > .7 && recall > .7,
    };
  });
  return {
    version: 1, model: predictions.model, images: references.images.length, groups: new Set(references.images.map(image => image.group)).size,
    iouThreshold: .5, classes: results,
    scope: 'Detección y categoría conjuntas. Sin mAP, severidad, máscaras ni validación clínica. Usa anotaciones independientes; no decisiones de aceptación/descarte.',
    independence: references.trainingGroups.length ? 'Sin coincidencias en los grupos declarados; no prueba ausencia de duplicados visuales.' : 'Grupos de entrenamiento no declarados: independencia no verificada.',
  };
}
