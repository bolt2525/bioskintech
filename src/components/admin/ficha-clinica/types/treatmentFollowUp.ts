import type { Treatment, TreatmentMode, ScalpAssessmentData, AnthropometricsData, PostCareData } from './treatment';
import { RESERVED_PARAM_KEYS } from './treatment';
import { getScalpStages, SCALP_SCALE_LABELS, getScalpStageLabel } from '../../../../data/scalpPatterns';
import type { ScalpHairVisualization } from '../components/Clinical3DViewer';
import { SCALP_BOUNDARY_PRESET } from '../../../../data/scalpBoundaryPreset';

export const FOLLOW_UP_KEY = '__follow_up';
export interface TreatmentFollowUp {
  purpose: 'initial' | 'control' | null;
  observations: string;
  referenceId?: string | null;
}
export const getTreatmentFollowUp = (treatment: Treatment): TreatmentFollowUp => {
  const data = treatment.parameters?.[FOLLOW_UP_KEY];
  if (!data || typeof data !== 'object') return { purpose: null, observations: '' };
  const { purpose, observations, referenceId } = data as Record<string, unknown>;
  return {
    purpose: purpose === 'initial' || purpose === 'control' ? purpose : null,
    observations: typeof observations === 'string' ? observations : '',
    referenceId: typeof referenceId === 'string' && referenceId.length <= 100 ? referenceId : null,
  };
};
export const getFollowUpLabel = (treatment: Treatment): string => {
  const purpose = getTreatmentFollowUp(treatment).purpose;
  return purpose === 'initial' ? 'Evaluación inicial' : purpose === 'control' ? 'Control' : 'Sin tipo de seguimiento';
};
export const treatmentDate = (value: string): string => value.slice(0, 10);
export const formatTreatmentDate = (value: string): string => {
  const date = treatmentDate(value);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : null;
  return parsed && Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString('es-EC', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Fecha no disponible';
};
export const getFollowUpSessions = (current: Treatment, history: Treatment[], mode: TreatmentMode): Treatment[] => {
  const procedure = current.procedure_name.trim().toLocaleLowerCase();
  if (!current.package_id && !procedure) return [];
  return history.filter(session => (session.treatment_mode ?? 'facial') === mode
    && (current.package_id
      ? session.package_id === current.package_id
      : !session.package_id && session.procedure_name.trim().toLocaleLowerCase() === procedure))
    .slice().sort((a, b) => treatmentDate(a.date).localeCompare(treatmentDate(b.date)));
};

export const prepareNextTreatment = (current: Treatment, date: string): Treatment => {
  const parameters = { ...current.parameters };
  for (const key of Object.values(RESERVED_PARAM_KEYS)) delete parameters[key];
  parameters[FOLLOW_UP_KEY] = { purpose: 'control', observations: '', referenceId: current.id == null ? null : String(current.id) } satisfies TreatmentFollowUp;
  const next = { ...current, date, parameters, notes: '' };
  delete next.id;
  return next;
};

export const getScalpVisualization = (data: ScalpAssessmentData | undefined): ScalpHairVisualization | null => {
  if (!data?.scale || !data.stage || !['norwood', 'ludwig', 'savin'].includes(data.scale)
    || !getScalpStages(data.scale).includes(data.stage)) return null;
  return {
    scale: data.scale, stage: data.stage, density: data.density,
    color: '#2b1a12', lengthScale: 0.82, showBoundaryTrace: false,
    boundaryPoints: SCALP_BOUNDARY_PRESET, boundaryClosed: true,
  };
};
export const describeTreatmentAssessment = (treatment: Treatment, mode: TreatmentMode): string => {
  const data = treatment.parameters?.[RESERVED_PARAM_KEYS[mode]];
  if (!data || typeof data !== 'object') return 'Sin evaluación clínica registrada';
  if (mode === 'capilar') {
    const scalp = data as ScalpAssessmentData;
    if (!getScalpVisualization(scalp)) return 'Clasificación capilar incompleta o no reconocida';
    return `${SCALP_SCALE_LABELS[scalp.scale!]} ${getScalpStageLabel(scalp.stage!)} · Densidad ${scalp.density ?? 'no registrada'}`;
  }
  if (mode === 'facial') {
    const postCare = data as PostCareData;
    return `Reacción inmediata: eritema ${postCare.erythema ?? 'sin valorar'}/3 · edema ${postCare.edema ?? 'sin valorar'}/3`;
  }
  const { before, after } = data as AnthropometricsData;
  return `Medidas antes: ${Object.values(before ?? {}).filter(Boolean).length} · después: ${Object.values(after ?? {}).filter(Boolean).length}`;
};

export const compareTreatmentAssessments = (baseline: Treatment, current: Treatment, mode: TreatmentMode): string => {
  if (mode === 'facial') return 'Eritema y edema describen la reacción inmediata, no la eficacia acumulada. Registra la evolución clínica en observaciones.';
  if (mode === 'capilar') {
    const first = baseline.parameters?.[RESERVED_PARAM_KEYS.capilar] as ScalpAssessmentData | undefined;
    const last = current.parameters?.[RESERVED_PARAM_KEYS.capilar] as ScalpAssessmentData | undefined;
    if (!getScalpVisualization(first) || !getScalpVisualization(last)) return 'Faltan evaluaciones completas para comparar.';
    if (first!.scale !== last!.scale) return 'Escalas distintas: no se calcula una equivalencia ni un porcentaje de mejoría.';
    if (first!.stage === 'Frontal' || last!.stage === 'Frontal'
      || first!.stage === 'Advanced' || last!.stage === 'Advanced') {
      return 'Variante de patrón: comparación descriptiva, no una etapa posterior ni porcentaje de mejoría.';
    }
    return first!.stage === last!.stage && first!.density === last!.density
      ? 'Misma clasificación y densidad percibida; no demuestra por sí sola estabilidad clínica.'
      : 'Cambio de clasificación o densidad percibida; confirma su significado clínico con exploración y fotos comparables.';
  }
  const first = baseline.parameters?.[RESERVED_PARAM_KEYS.corporal] as AnthropometricsData | undefined;
  const last = current.parameters?.[RESERVED_PARAM_KEYS.corporal] as AnthropometricsData | undefined;
  const parseMeasure = (value: string | undefined): number | null => {
    if (!value?.trim() || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) return null;
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const start = parseMeasure(first?.before?.waist);
  const end = parseMeasure(last?.after?.waist);
  if (start === null || end === null) return 'Para comparar cintura: registra el valor antes en la referencia y después en el control, con el mismo protocolo.';
  const delta = end - start;
  return `Cintura: ${delta > 0 ? '+' : ''}${delta.toLocaleString('es-EC', { maximumFractionDigits: 1 })} cm frente al valor antes de la referencia. Cambio descriptivo, no valoración automática del resultado.`;
};
