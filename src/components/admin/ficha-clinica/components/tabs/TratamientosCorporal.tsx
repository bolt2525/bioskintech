import TreatmentModeView from './TreatmentModeView';
import type { ConsultationRef } from '../CrossConsultHistoryModal';
import type { Treatment } from '../../types/treatment';

interface TratamientosCorporalProps {
  recordId: number;
  treatments: Treatment[];
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

/** Modo Corporal — modelo de referencia: male_body.glb (mismo usado en Examen Físico) */
export default function TratamientosCorporal(props: TratamientosCorporalProps) {
  return <TreatmentModeView mode="corporal" modelUrl="/models/clinical/male_body.glb" {...props} />;
}
