import { useState } from 'react';
import { motion } from 'framer-motion';
import type { ConsultationRef } from '../CrossConsultHistoryModal';
import TratamientosFacial from './TratamientosFacial';
import TratamientosCorporal from './TratamientosCorporal';
import TratamientosCapilar from './TratamientosCapilar';
import type { Treatment, TreatmentMode } from '../../types/treatment';
import { TREATMENT_MODE_LABELS } from '../../types/treatment';

interface TreatmentTabProps {
  recordId: number;
  treatments: Treatment[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

const MODES: TreatmentMode[] = ['facial', 'corporal', 'capilar'];

/**
 * Wrapper del tab de Tratamientos: selector de Modo (Facial/Corporal/Capilar) que delega
 * el formulario, el visor 3D y el historial (sesiones independientes + paquetes) al
 * componente correspondiente de cada modo. El historial previo a esta funcionalidad
 * pertenece íntegramente al modo Facial (treatment_mode default en la base de datos).
 */
export default function TreatmentTab({ recordId, treatments, consultationId, consultations = [], onSave }: TreatmentTabProps) {
  const [activeMode, setActiveMode] = useState<TreatmentMode>('facial');

  const ModeComponent = {
    facial: TratamientosFacial,
    corporal: TratamientosCorporal,
    capilar: TratamientosCapilar,
  }[activeMode];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <div className="admin-tabs w-fit" role="group" aria-label="Modo de tratamiento">
        {MODES.map(mode => (
          <button
            key={mode}
            type="button"
            onClick={() => setActiveMode(mode)}
            aria-pressed={activeMode === mode}
            className="admin-tab admin-focus-ring relative"
          >
            {TREATMENT_MODE_LABELS[mode]}
            {activeMode === mode && (
              <motion.div layoutId="activeTreatmentMode" className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#deb887]" />
            )}
          </button>
        ))}
      </div>

      <ModeComponent
        recordId={recordId}
        treatments={treatments}
        consultationId={consultationId}
        consultations={consultations}
        onSave={onSave}
      />
    </motion.div>
  );
}
