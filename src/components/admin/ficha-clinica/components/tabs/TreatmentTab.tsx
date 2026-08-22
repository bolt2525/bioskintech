import React, { useState, useEffect, useRef } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Calendar, DollarSign, Clock, Save, Trash2, Copy, Check, AlertCircle, FileText, Pencil, Layers, History } from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import treatmentOptions from '../../data/treatment_options.json';
import { Tooltip } from '../../../../ui/Tooltip';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';

/** Extrae solo YYYY-MM-DD de un ISO timestamp o string de PG para evitar desfase de zona horaria */
const toDateOnly = (d: string | null | undefined): string => {
  if (!d) return '';
  const s = String(d);
  if (s.includes('T')) return s.split('T')[0]; // "2026-05-15T00:00:00.000Z"
  if (s.includes(' ') && s.length > 10) return s.split(' ')[0]; // "2026-05-15 00:00:00"
  return s; // ya es "YYYY-MM-DD"
};
/** Retorna la fecha LOCAL actual en YYYY-MM-DD (no UTC) */
const getLocalDate = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface Treatment {
  id?: number;
  consultation_id?: number;
  date: string;
  procedure_name: string;
  equipment_used: string;
  area_treated: string;
  duration_minutes: number;
  cost: number;
  notes: string;
}

interface TreatmentTabProps {
  recordId: number;
  treatments: Treatment[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

const EMPTY_TREATMENT: Treatment = {
  date: new Date().toISOString().split('T')[0],
  procedure_name: '',
  equipment_used: '',
  area_treated: '',
  duration_minutes: 30,
  cost: 0,
  notes: '',
};

export default function TreatmentTab({ recordId, treatments, patientName, consultationId, consultations = [], onSave }: TreatmentTabProps) {
  const [currentTreatment, setCurrentTreatment] = useState<Treatment>({ ...EMPTY_TREATMENT });
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [groupByProcedure, setGroupByProcedure] = useState(false);
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);

  // Sort treatments by date descending for the history list
  const sortedTreatments = [...treatments]
    .filter(t => t.consultation_id === consultationId)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const otherTreatCount = treatments.filter(t => t.consultation_id !== consultationId).length;

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNew = () => {
    setCurrentTreatment({ ...EMPTY_TREATMENT, date: getLocalDate() });
    setDateLocked(false);
    setMessage(null);
  };

  const handleSelect = (treatment: Treatment) => {
    setCurrentTreatment({ ...treatment, date: toDateOnly(treatment.date) });
    setDateLocked(true);
    setMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const action = currentTreatment.id ? 'updateTreatment' : 'addTreatment';
      const body = {
        record_id: recordId,
        ...currentTreatment,
        ...(consultationId ? { consultation_id: consultationId } : {})
      };

      const response = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        onSave();
        if (!currentTreatment.id) {
          handleNew();
        }
        setMessage({ type: 'success', text: 'Tratamiento guardado correctamente' });
      } else {
        throw new Error('Error al guardar');
      }
    } catch (error) {
      console.error('Error saving treatment:', error);
      setMessage({ type: 'error', text: 'Error al guardar el tratamiento' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentTreatment.id || !confirm('¿Eliminar este tratamiento?')) return;
    setDeleting(true);
    try {
      const response = await recordsFetch(`/api/records?action=deleteTreatment&id=${currentTreatment.id}`, { 
        method: 'DELETE' 
      });

      if (response.ok) {
        onSave();
        handleNew();
        setMessage({ type: 'success', text: 'Tratamiento eliminado correctamente' });
      } else {
        throw new Error('Error al eliminar');
      }
    } catch (error) {
      console.error('Error deleting:', error);
      setMessage({ type: 'error', text: 'Error al eliminar el tratamiento' });
    } finally {
      setDeleting(false);
    }
  };

  const handleDuplicate = () => {
    const { id, ...rest } = currentTreatment;
    setCurrentTreatment({
      ...rest,
      date: getLocalDate()
    });
    setDateLocked(false);
    setMessage({ type: 'success', text: 'Tratamiento duplicado. Guarde para crear uno nuevo.' });
  };

  return (
    <>
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col md:flex-row h-auto md:h-[600px] gap-6"
    >
      {/* Sidebar List */}
      <div className="w-full md:w-72 border-r-0 md:border-r border-b md:border-b-0 border-gray-100 pr-0 md:pr-6 pb-4 md:pb-0 flex flex-col gap-4 shrink-0">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial de Tratamientos
          <button
            onClick={() => setGroupByProcedure(g => !g)}
            title={groupByProcedure ? 'Vista plana' : 'Agrupar por procedimiento'}
            className={`ml-auto p-1.5 rounded-lg border transition-colors ${groupByProcedure ? 'bg-[#deb887]/20 border-[#deb887]/40 text-[#b8944d]' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}
          >
            <Layers className="w-4 h-4" />
          </button>
          {otherTreatCount > 0 && (
            <button onClick={() => setCrossHistOpen(true)} title={`Ver ${otherTreatCount} tratamiento(s) de otras consultas`} className="p-1 hover:bg-[#deb887]/10 rounded-lg relative">
              <History className="w-3.5 h-3.5 text-[#b8944d]" />
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#b8944d] text-white text-[8px] rounded-full flex items-center justify-center font-bold">{otherTreatCount > 9 ? '9+' : otherTreatCount}</span>
            </button>
          )}
          <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{sortedTreatments.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {sortedTreatments.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay tratamientos previos
            </div>
          ) : groupByProcedure ? (
            // ── Vista agrupada por procedimiento ──────────────────────────
            (() => {
              const grouped = sortedTreatments.reduce((acc, t) => {
                const key = t.procedure_name || 'Sin procedimiento';
                if (!acc[key]) acc[key] = [];
                acc[key].push(t);
                return acc;
              }, {} as Record<string, Treatment[]>);
              return Object.entries(grouped).map(([proc, treats]) => (
                <div key={proc} className="space-y-1.5">
                  <div className="flex items-center justify-between px-2 py-1.5 bg-[#deb887]/10 rounded-lg sticky top-0 z-10">
                    <span className="text-xs font-bold text-[#b8944d] truncate">{proc}</span>
                    <span className="text-[10px] font-medium bg-[#deb887]/20 text-[#b8944d] px-1.5 py-0.5 rounded-full shrink-0 ml-1">
                      {treats.length} ses.
                    </span>
                  </div>
                  {treats.map((t, idx) => (
                    <motion.div
                      key={t.id || idx}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => handleSelect(t)}
                      className={`p-3 rounded-xl cursor-pointer border transition-all shadow-sm ${
                        currentTreatment.id === t.id
                          ? 'bg-[#deb887] text-white border-[#deb887] shadow-md'
                          : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-[#deb887]/30'
                      }`}
                    >
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-medium">{new Date(toDateOnly(t.date) + 'T12:00:00').toLocaleDateString('es-EC')}</span>
                        <FileText className="w-3.5 h-3.5 opacity-60" />
                      </div>
                      <div className="text-xs opacity-75 truncate mt-0.5">{t.equipment_used || 'Sin equipo'}</div>
                    </motion.div>
                  ))}
                </div>
              ));
            })()
          ) : (
            // ── Vista plana ──────────────────────────────────────────────
            sortedTreatments.map((t, index) => (
              <motion.div
                key={t.id || index}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => t && handleSelect(t)}
                className={`p-4 rounded-xl cursor-pointer border transition-all shadow-sm ${
                  currentTreatment.id === t.id 
                    ? 'bg-[#deb887] text-white border-[#deb887] shadow-md' 
                    : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-[#deb887]/30'
                }`}
              >
                <div className="font-medium flex justify-between items-center">
                  <span>{new Date(toDateOnly(t.date) + 'T12:00:00').toLocaleDateString('es-EC')}</span>
                  <FileText className="w-4 h-4 opacity-70" />
                </div>
                <div className="font-semibold truncate mt-1">{t.procedure_name}</div>
                <div className="text-xs opacity-80 truncate">{t.equipment_used || 'Sin equipo'}</div>
              </motion.div>
            ))
          )}
        </div>
      </div>

      {/* Main Form */}
      <div className="flex-1 flex flex-col gap-6 relative overflow-visible md:overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm sticky top-0 z-10">
          <div className="flex gap-2 items-center">
            <Tooltip content="Nuevo Tratamiento">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleNew} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Plus className="w-5 h-5" />
              </motion.button>
            </Tooltip>
            
            <Tooltip content="Guardar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSave} 
                disabled={saving} 
                className="p-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] shadow-lg shadow-[#deb887]/20 disabled:opacity-70"
              >
                {saving ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Save className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Duplicar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate} 
                disabled={!currentTreatment.id}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 disabled:opacity-50"
              >
                <Copy className="w-5 h-5" />
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete} 
                disabled={!currentTreatment.id || deleting}
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 disabled:opacity-50"
              >
                {deleting ? <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-500 rounded-full" /> : <Trash2 className="w-5 h-5" />}
              </motion.button>
            </Tooltip>
          </div>
        </div>

        <AnimatePresence>
          {message && (
            <motion.div 
              ref={messageRef}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`p-4 rounded-xl flex items-center gap-3 shadow-sm ${
                message.type === 'success' 
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                  : 'bg-red-50 text-red-700 border border-red-100'
              }`}
            >
              <div className={`p-1.5 rounded-full ${message.type === 'success' ? 'bg-emerald-100' : 'bg-red-100'}`}>
                {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              </div>
              <span className="font-medium text-sm">{message.text}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Form Fields */}
        <div className="bg-white p-6 rounded-xl border border-gray-100 shadow-sm space-y-6 overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Fecha</label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="date"
                    disabled={dateLocked}
                    className={`w-full pl-10 p-2.5 border rounded-lg outline-none transition-all ${
                      dateLocked
                        ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'border-gray-200 focus:ring-2 focus:ring-[#deb887] bg-gray-50/50 focus:bg-white'
                    }`}
                    value={currentTreatment.date}
                    onChange={e => setCurrentTreatment({...currentTreatment, date: e.target.value})}
                  />
                </div>
                {currentTreatment.id && dateLocked && (
                  <Tooltip content="Actualizar fecha">
                    <button
                      type="button"
                      onClick={() => setDateLocked(false)}
                      className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors shrink-0"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Procedimiento<FieldHelp text={HELP.treatment.procedure_name} /></label>
              <input
                type="text"
                required
                list="procedures-list"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.procedure_name}
                onChange={e => setCurrentTreatment({...currentTreatment, procedure_name: e.target.value})}
                placeholder="Ej: Limpieza Facial Profunda"
              />
              <datalist id="procedures-list">
                {Object.values(treatmentOptions.procedures).flat().map((p: string, i: number) => (
                  <option key={i} value={p} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Equipo Utilizado<FieldHelp text={HELP.treatment.equipment_used} /></label>
              <input
                type="text"
                list="equipment-list"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.equipment_used}
                onChange={e => setCurrentTreatment({...currentTreatment, equipment_used: e.target.value})}
                placeholder="Ej: Hydrafacial, Laser CO2"
              />
              <datalist id="equipment-list">
                {treatmentOptions.equipment.map((e: string, i: number) => (
                  <option key={i} value={e} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Zona Tratada<FieldHelp text={HELP.treatment.area_treated} /></label>
              <input
                type="text"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.area_treated}
                onChange={e => setCurrentTreatment({...currentTreatment, area_treated: e.target.value})}
                placeholder="Ej: Rostro completo"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Duración (min)<FieldHelp text={HELP.treatment.duration_minutes} /></label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="number"
                    className="w-full pl-10 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                    value={currentTreatment.duration_minutes}
                    onChange={e => setCurrentTreatment({...currentTreatment, duration_minutes: parseInt(e.target.value) || 0})}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Costo<FieldHelp text={HELP.treatment.cost} /></label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="number"
                    className="w-full pl-10 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                    value={currentTreatment.cost}
                    onChange={e => setCurrentTreatment({...currentTreatment, cost: parseFloat(e.target.value) || 0})}
                  />
                </div>
              </div>
            </div>
          </div>
          
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Notas / Parámetros<FieldHelp text={HELP.treatment.notes} /></label>
            <textarea
              rows={5}
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentTreatment.notes}
              onChange={e => setCurrentTreatment({...currentTreatment, notes: e.target.value})}
              placeholder="Detalles de la sesión, parámetros del equipo..."
            />
          </div>

        </div>
      </div>
    </motion.div>
    <CrossConsultHistoryModal
      isOpen={crossHistOpen}
      onClose={() => setCrossHistOpen(false)}
      tabLabel="Tratamientos"
      consultations={consultations}
      items={treatments}
      currentConsultationId={consultationId}
      renderItem={t => (
        <div>
          <p className="font-medium text-gray-800">{t.procedure_name}</p>
          <p className="text-gray-400">{t.date ? new Date(toDateOnly(t.date)+'T12:00:00').toLocaleDateString('es-EC') : ''}{t.equipment_used ? ` — ${t.equipment_used}` : ''}</p>
        </div>
      )}
      renderDetail={t => (
        <>
          <div><span className="text-gray-400">Procedimiento:</span> <span className="font-medium">{t.procedure_name}</span></div>
          {t.equipment_used && <div><span className="text-gray-400">Equipo:</span> {t.equipment_used}</div>}
          {t.area_treated && <div><span className="text-gray-400">Área:</span> {t.area_treated}</div>}
          {t.duration_minutes > 0 && <div><span className="text-gray-400">Duración:</span> {t.duration_minutes} min</div>}
          {t.cost > 0 && <div><span className="text-gray-400">Costo:</span> ${t.cost}</div>}
          {t.notes && <div><span className="text-gray-400">Notas:</span> {t.notes}</div>}
          {t.date && <div><span className="text-gray-400">Fecha:</span> {new Date(toDateOnly(t.date)+'T12:00:00').toLocaleDateString('es-EC')}</div>}
        </>
      )}
    />
    </>
  );
}
