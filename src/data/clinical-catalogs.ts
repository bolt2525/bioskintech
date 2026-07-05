
export const CLINICAL_FIELDS = {
  skin_type: {
    label: "Tipo de piel",
    options: ["", "Sensible", "Seca", "Normal", "Grasa", "Mixta"]
  },
  phototype: {
    label: "Fototipo (Fitzpatrick)",
    options: ["", "I", "II", "III", "IV", "V", "VI"]
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

export const LESION_CATALOG = [
  // Lesiones pigmentarias
  "Melasma", "Lentigo solar", "Efélides", "Queratosis seborreica", "Nevo melanocítico",
  "Nevo displásico", "Léntigo actínico", "Poiquilodermia", "Hiperpigmentación postinflamatoria",
  
  // Lesiones vasculares
  "Telangiectasias", "Arañas vasculares", "Rosácea", "Eritema", "Cuperosis",
  "Hemangioma", "Angioma rubí", "Lago venoso", "Varicosidades",
  
  // Lesiones inflamatorias
  "Acné comedónico", "Acné inflamatorio", "Acné quístico", "Pápulas", "Pústulas",
  "Dermatitis seborreica", "Dermatitis atópica", "Foliculitis", "Queratosis pilaris",
  
  // Signos de envejecimiento
  "Arrugas dinámicas", "Arrugas estáticas", "Surcos nasogenianos", "Líneas periorbitarias",
  "Código de barras", "Flacidez facial", "Pérdida de volumen", "Ptosis palpebral",
  
  // Textura y calidad de piel
  "Poros dilatados", "Comedones", "Puntos negros", "Milia", "Rugosidad",
  "Xerosis", "Descamación", "Hiperqueratosis", "Atrofia cutánea",
  
  // Cicatrices
  "Cicatriz hipertrófica", "Queloides", "Cicatrices atróficas", "Cicatrices de acné",
  "Estrías", "Cicatrices quirúrgicas"
].sort();

export const PARAMETER_TOOLTIPS: Record<string, string> = {
  skin_type: `
    <div class="space-y-1">
      <p><strong>Sensible:</strong> Reacciona fácilmente a productos y factores externos</p>
      <p><strong>Seca:</strong> Falta de producción sebácea, tendencia a descamación</p>
      <p><strong>Normal:</strong> Equilibrio entre grasa y hidratación</p>
      <p><strong>Grasa:</strong> Exceso de producción sebácea, brillo y poros dilatados</p>
      <p><strong>Mixta:</strong> Grasa en zona T, normal/seca en mejillas</p>
    </div>
  `,
  phototype: `
    <div class="space-y-1">
      <p><strong>I:</strong> Muy pálida, siempre se quema, nunca se broncea</p>
      <p><strong>II:</strong> Pálida, se quema fácil, bronceado mínimo</p>
      <p><strong>III:</strong> Morena clara, se quema moderado, bronceado gradual</p>
      <p><strong>IV:</strong> Morena, se quema mínimo, bronceado fácil</p>
      <p><strong>V:</strong> Morena oscura, rara vez se quema</p>
      <p><strong>VI:</strong> Negra, nunca se quema, muy pigmentada</p>
    </div>
  `,
  glogau_scale: `
    <div class="space-y-1">
      <p><strong>I (20-30 años):</strong> Sin arrugas, cambios pigmentarios mínimos</p>
      <p><strong>II (30-40 años):</strong> Arrugas dinámicas, lentigos tempranos</p>
      <p><strong>III (40-60 años):</strong> Arrugas persistentes, telangectasias</p>
      <p><strong>IV (60+ años):</strong> Arrugas severas, actínico daño extenso</p>
    </div>
  `,
  photoprotection: `
    <div class="space-y-1">
      <p><strong>No usa:</strong> Sin protector solar habitual</p>
      <p><strong>Ocasional:</strong> Solo en exposición solar directa</p>
      <p><strong>Regular:</strong> Uso diario en rostro</p>
      <p><strong>Alta:</strong> Reaplicación y uso corporal</p>
    </div>
  `,
  hydration: `
    <div class="space-y-1">
      <p><strong>Baja:</strong> Piel tirante, descamación visible</p>
      <p><strong>Media:</strong> Hidratación adecuada en general</p>
      <p><strong>Alta:</strong> Piel bien hidratada y flexible</p>
    </div>
  `,
  texture: `
    <div class="space-y-1">
      <p><strong>Fina:</strong> Delgada, traslúcida, frágil</p>
      <p><strong>Mediana:</strong> Grosor normal, resiliente</p>
      <p><strong>Gruesa:</strong> Piel resistente, poros más evidentes</p>
    </div>
  `,
  pores: `
    <div class="space-y-1">
      <p><strong>Cerrados:</strong> Poros poco visibles</p>
      <p><strong>Medianos:</strong> Poros moderadamente visibles</p>
      <p><strong>Dilatados:</strong> Poros muy evidentes, principalmente zona T</p>
    </div>
  `,
  elasticity: `
    <div class="space-y-1">
      <p><strong>Baja:</strong> Recuperación lenta al pellizco</p>
      <p><strong>Media:</strong> Recuperación normal</p>
      <p><strong>Buena:</strong> Recuperación inmediata, piel turgente</p>
    </div>
  `,
  pigmentation: `
    <div class="space-y-1">
      <p><strong>Homogénea:</strong> Color uniforme, sin manchas</p>
      <p><strong>Levemente irregular:</strong> Leves variaciones tonales</p>
      <p><strong>Irregular:</strong> Manchas evidentes, melasma, lentigos</p>
    </div>
  `,
  sensitivity: `
    <div class="space-y-1">
      <p><strong>Baja:</strong> Tolera bien productos y tratamientos</p>
      <p><strong>Media:</strong> Sensibilidad ocasional</p>
      <p><strong>Alta:</strong> Reacciones frecuentes, rojez, picor</p>
    </div>
  `
};
