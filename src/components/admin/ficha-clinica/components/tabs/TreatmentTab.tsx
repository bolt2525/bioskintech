import { useState } from 'react';
import { motion } from 'framer-motion';
import { ScanFace, PersonStanding, ScanSearch } from 'lucide-react';
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
const MODE_META = {
  facial: {
    icon: ScanFace,
    description: 'Rostro, cuello y escote',
    accent: 'from-rose-50 to-amber-50',
  },
  corporal: {
    icon: PersonStanding,
    description: 'Silueta y antropometría',
    accent: 'from-emerald-50 to-teal-50',
  },
  capilar: {
    icon: ScanSearch,
    description: 'Cuero cabelludo y densidad',
    accent: 'from-violet-50 to-indigo-50',
  },
} satisfies Record<TreatmentMode, { icon: typeof ScanFace; description: string; accent: string }>;

/**
 * Wrapper del tab de Tratamientos: selector de Modo (Facial/Corporal/Capilar) que delega
 * el formulario, el visor 3D y el historial (sesiones independientes + paquetes) al
 * componente correspondiente de cada modo. El historial previo a esta funcionalidad
 * pertenece íntegramente al modo Facial (treatment_mode default en la base de datos).
 */
export default function TreatmentTab({ recordId, treatments, patientName, consultationId, consultations = [], onSave }: TreatmentTabProps) {
  const [activeMode, setActiveMode] = useState<TreatmentMode>('facial');

  const ModeComponent = {
    facial: TratamientosFacial,
    corporal: TratamientosCorporal,
    capilar: TratamientosCapilar,
  }[activeMode];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Modo de tratamiento">
        {MODES.map(mode => {
          const meta = MODE_META[mode];
          const Icon = meta.icon;
          const count = treatments.filter(treatment => (treatment.treatment_mode || 'facial') === mode).length;
          const active = activeMode === mode;
          return (
            <motion.button
              key={mode}
              type="button"
              onClick={() => setActiveMode(mode)}
              aria-pressed={active}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.99 }}
              className={`admin-focus-ring relative overflow-hidden rounded-2xl border p-3 text-left transition-[border-color,box-shadow,background-color] duration-200 ${
                active
                  ? `border-gold bg-gradient-to-br ${meta.accent} shadow-[0_12px_30px_-20px_rgba(139,104,64,0.75)]`
                  : 'border-gray-200 bg-white hover:border-gold hover:shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${active ? 'bg-white text-gold-ink shadow-sm' : 'bg-gray-50 text-gray-500'}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{TREATMENT_MODE_LABELS[mode]}</span>
                    <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-gray-500">{count}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">{meta.description}</span>
                </span>
              </div>
              {active ? <motion.span layoutId="activeTreatmentMode" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-gold" /> : null}
            </motion.button>
          );
        })}
      </div>

      <ModeComponent
        recordId={recordId}
        treatments={treatments}
        patientName={patientName}
        consultationId={consultationId}
        consultations={consultations}
        onSave={onSave}
      />
    </motion.div>
  );
}
