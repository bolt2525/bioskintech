import type { ConsultationRef } from '../CrossConsultHistoryModal';
import type { Treatment } from '../../types/treatment';
import TreatmentModeView from './TreatmentModeView';

interface TreatmentTabProps {
  recordId: number;
  treatments: Treatment[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void | Promise<void>;
}

export default function TreatmentTab(props: TreatmentTabProps) {
  return <TreatmentModeView {...props} />;
}
