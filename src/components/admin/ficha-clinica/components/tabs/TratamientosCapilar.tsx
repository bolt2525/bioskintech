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

/** Modo Capilar — cabeza clínica con malla capilar estilizada para el groom dinámico. */
export default function TratamientosCapilar(props: TratamientosCapilarProps) {
  return <TreatmentModeView mode="capilar" modelUrl="/models/clinical/male_head_hair.glb" {...props} />;
}
