import type { Marker3D } from '../components/Clinical3DViewer';

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
  parameters?: Record<string, unknown> | null;
  area_treated: string;
  /** Marcación anatómica puntual en el modelo 3D del modo (opcional, solo referencia visual) */
  area_marker?: Marker3D | null;
  duration_minutes: number;
  cost: number;
  notes: string;
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
