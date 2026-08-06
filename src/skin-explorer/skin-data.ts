/**
 * Datos clínicos del módulo DermoAtlas 3D.
 * Hotspots adaptados de anatomy-data.ts (thebuggeddev/anatomy),
 * enriquecidos con información de estética médica.
 */

export type Hotspot = {
  id: string;
  label: string;
  detail: string;
  /** Posición en espacio de pivote normalizado (FIT_SIZE = 3.8) */
  position: [number, number, number];
  color: string;
};

export type SkinLayer = {
  id: string;
  name: string;
  color: string;
  depth: string;
  description: string;
  components: string[];
  /** Relevancia clínica para tratamientos estéticos */
  aesthetic: {
    treatments: string[];
    targets: string[];
    note: string;
  };
};

export type SkinCondition = {
  id: string;
  name: string;
  icon: string;
  brief: string;
  treatments: string[];
};

export type QuizQuestion = {
  id: string;
  question: string;
  options: string[];
  correct: number;
  explanation: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Hotspots 3D — posiciones relativas al modelo skin.glb
// ─────────────────────────────────────────────────────────────────────────────

// Posiciones exactas del repo de referencia (thebuggeddev/anatomy) — verificadas en skin.glb
export const SKIN_HOTSPOTS: Hotspot[] = [
  {
    id: 'epidermis',
    label: 'Epidermis',
    detail: 'Capa protectora externa — barrera física y química',
    position: [-0.05, 0.88, 1.4],
    color: '#ee7c6a',
  },
  {
    id: 'dermis',
    label: 'Dermis',
    detail: 'Red de colágeno, elastina y ácido hialurónico nativo',
    position: [0.29, 0.05, 1.4],
    color: '#f2a33b',
  },
  {
    id: 'hypodermis',
    label: 'Hipodermis',
    detail: 'Compartimentos grasos — soporte estructural y aislamiento',
    position: [-0.39, -1.15, 1.4],
    color: '#6393d8',
  },
  {
    id: 'follicle',
    label: 'Folículo Piloso',
    detail: 'Ancla cada cabello — diana de PRP y mesoterapia',
    position: [0.89, -0.44, 1.4],
    color: '#d89bc4',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Capas de la piel con información clínica
// ─────────────────────────────────────────────────────────────────────────────

export const SKIN_LAYERS: SkinLayer[] = [
  {
    id: 'epidermis',
    name: 'Epidermis',
    color: '#f59e0b',
    depth: '0.05 – 1.5 mm',
    description:
      'La capa más externa. Formada principalmente por queratinocitos que migran desde la capa basal hasta la superficie en ~28 días.',
    components: [
      'Estrato córneo (barrera lipídica)',
      'Queratinocitos',
      'Melanocitos (pigmentación)',
      'Células de Langerhans (inmunidad)',
      'Células de Merkel (tacto)',
    ],
    aesthetic: {
      treatments: ['Peeling químico', 'Microdermabrasión', 'Láser ablativo', 'Retinoides tópicos'],
      targets: ['Barrera cutánea', 'Renovación celular', 'Hiperpigmentación'],
      note: 'Los tratamientos epidérmicos buscan acelerar el recambio celular y reforzar la barrera sin comprometer capas profundas.',
    },
  },
  {
    id: 'dermis',
    name: 'Dermis',
    color: '#c99277',
    depth: '1.5 – 4 mm',
    description:
      'Capa media que otorga firmeza y elasticidad. Contiene la red de soporte estructural de la piel: colágeno (70%), elastina y ácido hialurónico nativo.',
    components: [
      'Fibroblastos (productores de colágeno)',
      'Colágeno tipos I y III',
      'Fibras de elastina',
      'Ácido hialurónico nativo',
      'Folículos pilosos',
      'Glándulas sudoríparas y sebáceas',
      'Terminaciones nerviosas',
      'Red vascular dérmica',
    ],
    aesthetic: {
      treatments: [
        'Rellenos de ácido hialurónico',
        'Bioestimuladores (Sculptra, Radiesse)',
        'Radiofrecuencia',
        'Ultrasonido focalizado (HIFU)',
        'Microneedling con RF',
        'Mesoterapia',
      ],
      targets: ['Colágeno', 'Elastina', 'Ácido hialurónico', 'Fibroblastos'],
      note: 'La dermis es la capa principal de los tratamientos antiaging. Los fillers de HA se depositan aquí para restaurar volumen y estimular colágeno.',
    },
  },
  {
    id: 'hypodermis',
    name: 'Hipodermis',
    color: '#f97316',
    depth: '4 – 20 mm',
    description:
      'La capa más profunda (tejido celular subcutáneo). Compuesta por lobulillos de adipocitos separados por tabiques fibrosos. Proporciona aislamiento, soporte y reserva energética.',
    components: [
      'Adipocitos (células grasas)',
      'Tabiques fibrosos',
      'Grandes vasos sanguíneos',
      'Nervios subcutáneos',
      'Compartimentos grasos faciales',
    ],
    aesthetic: {
      treatments: [
        'Rellenos profundos (HA de alta densidad)',
        'Grasa autóloga (lipofilling)',
        'Lipolisis inyectable (ácido desoxicólico)',
        'Criolipólisis',
        'Ultrasonido liporeductor',
      ],
      targets: ['Compartimentos grasos', 'Contorno facial', 'Volumen estructural'],
      note: 'La pérdida de volumen en los compartimentos grasos subcutáneos es una de las principales causas del envejecimiento facial. Los rellenos profundos restauran proyección y soporte.',
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Condiciones dermatológicas relevantes en estética médica
// ─────────────────────────────────────────────────────────────────────────────

export const SKIN_CONDITIONS: SkinCondition[] = [
  {
    id: 'acne',
    name: 'Acné',
    icon: '⬡',
    brief: 'Inflamación de unidades pilosebáceas por Cutibacterium acnes, exceso de sebo y queratinización anómala.',
    treatments: ['Peeling salicílico', 'Luz LED azul', 'Láser', 'Tratamiento médico'],
  },
  {
    id: 'melasma',
    name: 'Melasma',
    icon: '◧',
    brief: 'Hiperpigmentación por sobreactivación de melanocitos. Influyen UV, hormonas y predisposición genética.',
    treatments: ['Despigmentantes tópicos', 'Peeling químico', 'Láser QS', 'Fotoprotección'],
  },
  {
    id: 'rosacea',
    name: 'Rosácea',
    icon: '◈',
    brief: 'Eritema facial crónico con telangiectasias por disfunción vascular y respuesta inflamatoria exagerada.',
    treatments: ['Láser vascular', 'IPL', 'Tratamiento médico', 'Fotoprotección'],
  },
  {
    id: 'psoriasis',
    name: 'Psoriasis',
    icon: '◫',
    brief: 'Enfermedad autoinmune que acelera el ciclo celular epidérmico, produciendo placas eritematosas descamativas.',
    treatments: ['Fototerapia UVB', 'Biológicos', 'Corticoides tópicos', 'Tacrolimus'],
  },
  {
    id: 'eczema',
    name: 'Dermatitis Atópica',
    icon: '◩',
    brief: 'Alteración de la barrera cutánea con inflamación crónica, prurito intenso y sensibilización alérgica.',
    treatments: ['Emolientes barrera', 'Corticoides tópicos', 'Inhibidores calcineurina', 'Dupilumab'],
  },
  {
    id: 'aging',
    name: 'Envejecimiento',
    icon: '◎',
    brief: 'Pérdida de colágeno (~1% por año), glicación, fotodaño y descenso gravitacional de compartimentos grasos.',
    treatments: ['Toxina botulínica', 'Rellenos HA', 'Bioestimuladores', 'Radiofrecuencia', 'HIFU'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Quiz sobre la piel
// ─────────────────────────────────────────────────────────────────────────────

export const SKIN_QUIZ: QuizQuestion[] = [
  {
    id: 'q1',
    question: '¿En qué capa de la piel se depositan los rellenos de ácido hialurónico?',
    options: ['Epidermis', 'Dermis', 'Hipodermis', 'Depende del efecto buscado'],
    correct: 3,
    explanation:
      'Los rellenos se depositan en dermis media/profunda para arrugas y líneas, o en hipodermis/supraperióstico para restaurar volumen estructural. La elección depende del área y efecto deseado.',
  },
  {
    id: 'q2',
    question: '¿Qué célula es responsable de producir la pigmentación de la piel?',
    options: ['Queratinocito', 'Fibroblasto', 'Melanocito', 'Célula de Langerhans'],
    correct: 2,
    explanation:
      'Los melanocitos, ubicados en la capa basal epidérmica, producen melanina y la transfieren a los queratinocitos vecinos. Su sobreactivación causa hiperpigmentaciones como el melasma.',
  },
  {
    id: 'q3',
    question: '¿Cuál es la principal proteína estructural de la dermis?',
    options: ['Elastina', 'Colágeno', 'Ácido hialurónico', 'Queratina'],
    correct: 1,
    explanation:
      'El colágeno (principalmente tipos I y III) constituye ~70% del peso seco de la dermis. Es la proteína que otorga resistencia y firmeza. Se pierde ~1% anualmente a partir de los 25 años.',
  },
  {
    id: 'q4',
    question: '¿Qué tratamiento actúa directamente sobre los fibroblastos dérmicos?',
    options: ['Peeling superficial', 'Bioestimuladores de colágeno', 'Botox', 'Microdermoabrasión'],
    correct: 1,
    explanation:
      'Los bioestimuladores (Sculptra, Radiesse, Ellansé) estimulan directamente a los fibroblastos dérmicos para producir nuevo colágeno, logrando un efecto de rejuvenecimiento progresivo y duradero.',
  },
  {
    id: 'q5',
    question: '¿Cuál es el ciclo normal de renovación de la epidermis?',
    options: ['7 días', '14 días', '28 días', '45 días'],
    correct: 2,
    explanation:
      'Los queratinocitos tardan ~28 días en migrar desde la capa basal hasta el estrato córneo. Este ciclo se acelera patológicamente en la psoriasis y se ralentiza con el envejecimiento.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Info detallada por hotspot (para el panel lateral)
// ─────────────────────────────────────────────────────────────────────────────

export const HOTSPOT_DETAILS: Record<string, {
  title: string;
  subtitle: string;
  color: string;
  facts: string[];
  aestheticNote: string;
}> = {
  epidermis: {
    title: 'Epidermis',
    subtitle: 'La barrera viva',
    color: '#f59e0b',
    facts: [
      'Grosor de 0.05 mm (párpados) a 1.5 mm (palmas)',
      'Se renueva completamente cada ~28 días',
      'No contiene vasos sanguíneos (avascular)',
      '95% queratinocitos + melanocitos, Langerhans, Merkel',
      'El estrato córneo es la barrera frente a agresiones externas',
    ],
    aestheticNote: 'Los peelings y láseres ablativo actúan en esta capa para eliminar queratinocitos dañados y estimular la renovación. El factor clave es la profundidad de acción.',
  },
  dermis: {
    title: 'Dermis',
    subtitle: 'El andamiaje de la piel',
    color: '#c99277',
    facts: [
      'Contiene 70% de colágeno (tipos I y III)',
      'Las fibras de elastina permiten la recuperación elástica',
      'Produce ácido hialurónico nativo (~0.1 mg/g de tejido)',
      'Los fibroblastos sintetizan y degradan la matriz extracelular',
      'Red vascular que nutre la epidermis por difusión',
    ],
    aestheticNote: 'La dermis es el principal objetivo de los tratamientos antiaging: fillers de HA, bioestimuladores de colágeno, radiofrecuencia y HIFU actúan aquí para revertir la pérdida estructural.',
  },
  hypodermis: {
    title: 'Hipodermis',
    subtitle: 'El soporte profundo',
    color: '#f97316',
    facts: [
      'Compuesta por lobulillos de adipocitos',
      'Los compartimentos grasos faciales sostienen los tejidos superiores',
      'Se atrofia con el envejecimiento → hundimiento y ptosis',
      'Punto de entrada de técnicas liporeductoras',
      'Conecta la piel con el periostio y músculo subyacente',
    ],
    aestheticNote: 'El relleno profundo en hipodermis (o supraperióstico) restaura el volumen perdido y el efecto de soporte de los compartimentos grasos. Es fundamental en el rejuvenecimiento facial volumétrico.',
  },
  follicle: {
    title: 'Folículo Piloso',
    subtitle: 'Unidad regenerativa',
    color: '#d89bc4',
    facts: [
      'Estructura túbuloalveolar que produce el cabello',
      'Contiene células madre en la región del bulge',
      'Ciclo: anágeno → catágeno → telógeno',
      'Una de las pocas estructuras cutáneas con capacidad regenerativa',
      'Presente en todo el cuerpo excepto palmas, plantas y labios',
    ],
    aestheticNote: 'El PRP (plasma rico en plaquetas) y la mesoterapia capilar actúan sobre las células madre del folículo para estimular el crecimiento en alopecia. Las células madre foliculares también se usan en regeneración cutánea.',
  },
};
