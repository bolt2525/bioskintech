import TreatmentModeView from './TreatmentModeView';
import type { ConsultationRef } from '../CrossConsultHistoryModal';
import type { Treatment } from '../../types/treatment';

interface TratamientosCapilarProps {
  recordId: number;
  treatments: Treatment[];
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

/**
 * Modo Capilar — ponytail: no existe aún un modelo .glb dedicado de cuero cabelludo;
 * se reutiliza male_head.glb como aproximación temporal (decisión confirmada con el usuario).
 * Upgrade path: reemplazar modelUrl cuando se provea un modelo de cráneo/cuero cabelludo.
 */
export default function TratamientosCapilar(props: TratamientosCapilarProps) {
  return <TreatmentModeView mode="capilar" modelUrl="/models/clinical/male_head.glb" {...props} />;
}
