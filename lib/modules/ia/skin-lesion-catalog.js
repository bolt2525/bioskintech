import catalog from '../../../src/data/skin-lesion-catalog.json' with { type: 'json' };

export const LESION_CATEGORIES = Object.freeze({ ...catalog });
// These categories remain available to clinicians, never inferred by AI.
const MANUAL_ONLY = new Set(['poros-dilatados', 'nevo-displasico', 'other']);
export const AI_LESION_LABELS = Object.freeze({
  acne: 'Posible apariencia acneiforme',
  spot: 'Posible mancha visible',
  nevus: 'Posible apariencia névica',
  scar: 'Posible apariencia cicatricial',
  melasma: 'Posible patrón pigmentario',
  'fine-wrinkle': 'Posible línea fina',
  'coarse-wrinkle': 'Posible línea marcada',
  ...Object.fromEntries(Object.entries(catalog)
    .filter(([key]) => !MANUAL_ONLY.has(key) &&
      !['acne', 'spot', 'nevus', 'scar', 'melasma', 'fine-wrinkle', 'coarse-wrinkle'].includes(key))
    .map(([key, label]) => [key, `Posible apariencia: ${label}`])),
});
