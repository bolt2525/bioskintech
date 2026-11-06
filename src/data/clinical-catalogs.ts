import lesionCatalog from './skin-lesion-catalog.json' with { type: 'json' };
export const CLINICAL_FIELDS = {
  skin_type: {
    label: "Tipo de piel",
    options: ["", "Sensible", "Seca", "Normal", "Grasa", "Mixta", "No determinado"]
  },
  phototype: {
    label: "Fototipo (Fitzpatrick)",
    options: ["", "I", "II", "III", "IV", "V", "VI", "No determinado"]
  },
  glogau_scale: {
    label: "Glogau",
    options: ["", "I", "II", "III", "IV"]
  },
  photoprotection: {
    label: "Fotoprotección",
    options: ["", "No usa", "Ocasional", "Regular", "Alta"]
  },
  hydration: {
    label: "Hidratación",
    options: ["", "Baja", "Media", "Alta"]
  },
  texture: {
    label: "Textura",
    options: ["", "Fina", "Mediana", "Gruesa"]
  },
  pores: {
    label: "Poros",
    options: ["", "Cerrados", "Medianos", "Dilatados"]
  },
  elasticity: {
    label: "Elasticidad",
    options: ["", "Baja", "Media", "Buena"]
  },
  pigmentation: {
    label: "Pigmentación",
    options: ["", "Homogénea", "Lévemente irregular", "Irregular"]
  },
  sensitivity: {
    label: "Sensibilidad",
    options: ["", "Baja", "Media", "Alta"]
  }
};

export const LESION_CATALOG = Object.values(lesionCatalog).sort();

export interface ParameterTooltipItem {
  label: string;
  description: string;
}

export const PARAMETER_TOOLTIPS: Record<string, ParameterTooltipItem[]> = {
  skin_type: [
    { label: 'Sensible', description: 'Reacciona fácilmente a productos y factores externos' },
    { label: 'Seca', description: 'Falta de producción sebácea, tendencia a descamación' },
    { label: 'Normal', description: 'Equilibrio entre grasa y hidratación' },
    { label: 'Grasa', description: 'Exceso de producción sebácea, brillo y poros dilatados' },
    { label: 'Mixta', description: 'Grasa en zona T, normal/seca en mejillas' },
  ],
  phototype: [
    { label: 'I', description: 'Muy pálida, siempre se quema, nunca se broncea' },
    { label: 'II', description: 'Pálida, se quema fácil, bronceado mínimo' },
    { label: 'III', description: 'Morena clara, se quema moderado, bronceado gradual' },
    { label: 'IV', description: 'Morena, se quema mínimo, bronceado fácil' },
    { label: 'V', description: 'Morena oscura, rara vez se quema' },
    { label: 'VI', description: 'Negra, nunca se quema, muy pigmentada' },
  ],
  glogau_scale: [
    { label: 'I (20-30 años)', description: 'Sin arrugas, cambios pigmentarios mínimos' },
    { label: 'II (30-40 años)', description: 'Arrugas dinámicas, lentigos tempranos' },
    { label: 'III (40-60 años)', description: 'Arrugas persistentes, telangectasias' },
    { label: 'IV (60+ años)', description: 'Arrugas severas, daño actínico extenso' },
  ],
  photoprotection: [
    { label: 'No usa', description: 'Sin protector solar habitual' },
    { label: 'Ocasional', description: 'Solo en exposición solar directa' },
    { label: 'Regular', description: 'Uso diario en rostro' },
    { label: 'Alta', description: 'Reaplicación y uso corporal' },
  ],
  hydration: [
    { label: 'Baja', description: 'Piel tirante, descamación visible' },
    { label: 'Media', description: 'Hidratación adecuada en general' },
    { label: 'Alta', description: 'Piel bien hidratada y flexible' },
  ],
  texture: [
    { label: 'Fina', description: 'Delgada, traslúcida, frágil' },
    { label: 'Mediana', description: 'Grosor normal, resiliente' },
    { label: 'Gruesa', description: 'Piel resistente, poros más evidentes' },
  ],
  pores: [
    { label: 'Cerrados', description: 'Poros poco visibles' },
    { label: 'Medianos', description: 'Poros moderadamente visibles' },
    { label: 'Dilatados', description: 'Poros muy evidentes, principalmente zona T' },
  ],
  elasticity: [
    { label: 'Baja', description: 'Recuperación lenta al pellizco' },
    { label: 'Media', description: 'Recuperación normal' },
    { label: 'Buena', description: 'Recuperación inmediata, piel turgente' },
  ],
  pigmentation: [
    { label: 'Homogénea', description: 'Color uniforme, sin manchas' },
    { label: 'Levemente irregular', description: 'Leves variaciones tonales' },
    { label: 'Irregular', description: 'Manchas evidentes, melasma, lentigos' },
  ],
  sensitivity: [
    { label: 'Baja', description: 'Tolera bien productos y tratamientos' },
    { label: 'Media', description: 'Sensibilidad ocasional' },
    { label: 'Alta', description: 'Reacciones frecuentes, rojez, picor' },
  ],
};
