import TreatmentModeView from './TreatmentModeView';
import type { ConsultationRef } from '../CrossConsultHistoryModal';
import type { Treatment } from '../../types/treatment';

interface TratamientosCapilarProps {
  recordId: number;
  treatments: Treatment[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

/** Modo Capilar — cabeza clínica y groom dinámico a partir de la evaluación de cada sesión. */
export default function TratamientosCapilar(props: TratamientosCapilarProps) {
  return <TreatmentModeView mode="capilar" modelUrl="/models/clinical/male_head.glb" {...props} />;
}
