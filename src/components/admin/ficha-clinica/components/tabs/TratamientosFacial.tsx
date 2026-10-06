import TreatmentModeView from './TreatmentModeView';
import type { ConsultationRef } from '../CrossConsultHistoryModal';
import type { Treatment } from '../../types/treatment';

interface TratamientosFacialProps {
  recordId: number;
  treatments: Treatment[];
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

/** Modo Facial — modelo de referencia: male_head.glb (mismo usado en Examen Físico) */
export default function TratamientosFacial(props: TratamientosFacialProps) {
  return <TreatmentModeView mode="facial" modelUrl="/models/clinical/male_head.glb" {...props} />;
}
