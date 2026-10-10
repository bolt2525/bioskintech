import type { Marker3D } from '../components/Clinical3DViewer';
import type { ScalpScale } from '../../../../data/scalpPatterns';

/** Modo del tab de Tratamientos — el historial previo a esta migración pertenece a 'facial' */
export type TreatmentMode = 'facial' | 'corporal' | 'capilar';

export interface Treatment {
  id?: number;
  consultation_id?: number;
  /** Ausente en historial previo a la migración de modos — se interpreta como 'facial' */
  treatment_mode?: TreatmentMode;
  /** Paquete al que pertenece la sesión, o null/undefined si es una sesión independiente */
  package_id?: number | null;
  date: string;
  procedure_name: string;
  equipment_used: string;
  /** Mapa de parámetros por equipo (ver TreatmentParametersModal), más claves reservadas __* con datos clínicos por modo (ver RESERVED_PARAM_KEYS) */
  parameters?: Record<string, unknown> | null;
  area_treated: string;
  /** Marcación(es) anatómica(s) en el modelo 3D del modo. Historial previo guarda un solo objeto; usar getAreaMarkers() para leer siempre un arreglo. */
  area_marker?: Marker3D | Marker3D[] | null;
  duration_minutes: number;
  cost: number;
  notes: string;
}

export interface FinancePostingOptions {
  enabled: boolean;
  includes_iva: boolean;
  invoice_number: string;
  idempotency_key: string;
}

export const createFinancePostingOptions = (): FinancePostingOptions => ({
  enabled: false,
  includes_iva: false,
  invoice_number: '',
  idempotency_key: crypto.randomUUID(),
});

/** Normaliza area_marker (objeto único legado o arreglo) a un arreglo de marcadores */
export const getAreaMarkers = (t: Pick<Treatment, 'area_marker'>): Marker3D[] => {
  const m = t.area_marker;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
};

/** Claves reservadas dentro de `parameters` (JSONB) para datos clínicos adicionales por modo.
 *  Prefijo "__" para no colisionar con nombres de equipos (que usan el nombre tal cual como clave). */
export const RESERVED_PARAM_KEYS = {
  facial: '__post_care',
  corporal: '__anthropometrics',
  capilar: '__scalp_assessment',
} as const satisfies Record<TreatmentMode, string>;

export type SeverityScale = 0 | 1 | 2 | 3;

export interface PostCareData {
  erythema: SeverityScale | null;
  edema: SeverityScale | null;
  indications: string[];
  notes?: string;
}

export interface AnthropometricMeasure { waist?: string; hip?: string; thigh?: string; arm?: string; abdomen?: string; weight?: string }
export interface AnthropometricsData {
  before: AnthropometricMeasure;
  after: AnthropometricMeasure;
  custom: Array<{ label: string; before: string; after: string }>;
}

export type HairLossScale = ScalpScale;
export interface ScalpAssessmentData {
  scale: HairLossScale | null;
  stage: string | null;
  density: 'Alta' | 'Media' | 'Baja' | null;
  alopecia_type: string | null;
  itching_flaking: boolean;
  notes?: string;
}

export interface TreatmentPackage {
  id?: number;
  record_id: number;
  consultation_id?: number | null;
  treatment_mode: TreatmentMode;
  name: string;
  total_cost: number;
  estimated_sessions: number;
  initial_payment: number;
  created_at?: string;
  /** Calculados por el backend (join con treatments vinculados) */
  sessions_paid?: number;
  sessions_count?: number;
}

/** Deuda pendiente = Costo Total - (Abono Inicial + sumatoria de abonos por sesión) */
export const getPackageDebt = (pkg: TreatmentPackage): number =>
  Math.max(0, Number(pkg.total_cost) - (Number(pkg.initial_payment) + Number(pkg.sessions_paid || 0)));

export const getPackagePaidTotal = (pkg: TreatmentPackage): number =>
  Number(pkg.initial_payment) + Number(pkg.sessions_paid || 0);

export const TREATMENT_MODE_LABELS: Record<TreatmentMode, string> = {
  facial: 'Facial',
  corporal: 'Corporal',
  capilar: 'Capilar',
};
