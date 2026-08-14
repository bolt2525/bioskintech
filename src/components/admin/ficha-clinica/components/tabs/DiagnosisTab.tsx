import React, { useState, useEffect, useRef } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Plus, Trash2, Copy, Printer, Check, Edit2, History } from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import diagnosisOptions from '../../data/diagnosis_options.json';
import { Tooltip } from '../../../../ui/Tooltip';
import { useClinicSettings } from '../../../../../hooks/useClinicSettings';
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

interface Diagnosis {
  id?: number;
  record_id: number;
  date?: string;
  diagnosis_text: string;
  cie10_code: string;
  type: string;
  severity: string;
  notes: string;
}

interface DiagnosisTabProps {
  recordId: number;
  diagnoses: Diagnosis[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

const EMPTY_DIAGNOSIS: Omit<Diagnosis, 'record_id'> = {
  diagnosis_text: '',
  cie10_code: '',
  type: 'presumptive',
  severity: 'Leve',
  notes: ''
};

export default function DiagnosisTab({ recordId, diagnoses, patientName, consultationId, consultations = [], onSave }: DiagnosisTabProps) {
  const { settings: clinic } = useClinicSettings();
  const [currentDiagnosis, setCurrentDiagnosis] = useState<Diagnosis>({ ...EMPTY_DIAGNOSIS, record_id: recordId });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const [crossHistOpen, setCrossHistOpen] = useState(false);

  useEffect(() => {
    if (diagnoses.length > 0 && !currentDiagnosis.id) {
      setCurrentDiagnosis(diagnoses[0]);
    } else if (diagnoses.length === 0 && !currentDiagnosis.id) {
      setCurrentDiagnosis({ ...EMPTY_DIAGNOSIS, record_id: recordId });
    }
  }, [diagnoses, recordId]);

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNew = () => {
    setCurrentDiagnosis({ ...EMPTY_DIAGNOSIS, record_id: recordId });
    setMessage(null);
  };

  const handleDuplicate = () => {
    const { id, date, ...rest } = currentDiagnosis;
    setCurrentDiagnosis({ ...rest, record_id: recordId });
    setMessage({ type: 'success', text: 'Diagnóstico duplicado. Guarde para crear uno nuevo.' });
  };

  const handleDelete = async () => {
    if (!currentDiagnosis.id || !confirm('¿Eliminar este diagnóstico?')) return;
    setDeleting(true);
    try {
      const response = await recordsFetch(`/api/records?action=deleteDiagnosis&id=${currentDiagnosis.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        onSave();
        handleNew();
        setMessage({ type: 'success', text: 'Diagnóstico eliminado correctamente' });
      } else {
        throw new Error('Error al eliminar');
      }
    } catch (error) {
      console.error('Error deleting diagnosis:', error);
      setMessage({ type: 'error', text: 'Error al eliminar el diagnóstico' });
    } finally {
      setDeleting(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const response = await recordsFetch('/api/records?action=saveDiagnosis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...currentDiagnosis, ...(consultationId ? { consultation_id: consultationId } : {}) }),
      });

      if (response.ok) {
        setMessage({ type: 'success', text: 'Diagnóstico guardado correctamente' });
        onSave();
      } else {
        const errData = await response.json();
        throw new Error(errData.error || 'Error al guardar');
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Error al guardar el diagnóstico' });
    } finally {
      setSaving(false);
    }
  };

  const handlePrint = () => {
    setMessage({ type: 'success', text: 'Abriendo vista de impresión...' });
    const html = `
      <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Diagnóstico - ${patientName}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #000; padding-bottom: 10px; }
            .header h1 { margin: 0; font-size: 24px; color: #deb887; }
            .info { margin-bottom: 20px; }
            .info p { margin: 5px 0; }
            .section { margin-bottom: 20px; }
            .section h3 { border-bottom: 1px solid #ddd; padding-bottom: 5px; color: #deb887; }
            .field { margin-bottom: 10px; }
            .label { font-weight: bold; color: #555; }
            .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #666; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${clinic.general.name || 'BioSkinTech'}</h1>
            <p>${clinic.general.tagline || 'Dermatología y Medicina Estética'}</p>
            ${clinic.general.address ? `<p>${clinic.general.address}${clinic.general.city ? ' — ' + clinic.general.city : ''}</p>` : ''}
            ${clinic.general.phone ? `<p>Tel: ${clinic.general.phone}</p>` : ''}
          </div>
          
          <div class="info">
            <p><strong>Paciente:</strong> ${patientName}</p>
            <p><strong>Fecha:</strong> ${new Date().toLocaleDateString()}</p>
          </div>

          <div class="section">
            <h3>Detalle del Diagnóstico</h3>
            <div class="field"><span class="label">Diagnóstico:</span> ${currentDiagnosis.diagnosis_text}</div>
            <div class="field"><span class="label">CIE-10:</span> ${currentDiagnosis.cie10_code}</div>
            <div class="field"><span class="label">Tipo:</span> ${currentDiagnosis.type}</div>
            <div class="field"><span class="label">Severidad:</span> ${currentDiagnosis.severity}</div>
          </div>

          <div class="section">
            <h3>Notas Adicionales</h3>
            <p>${currentDiagnosis.notes || 'Sin notas adicionales.'}</p>
          </div>

          <div class="footer">
            <p>_____________________________</p>
            <p>Firma Profesional</p>
          </div>
          
          <script>
            window.onload = function() { window.print(); }
          </script>
        </body>
      </html>
    `;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
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
          Historial de Diagnósticos
          <span className="ml-auto flex items-center gap-1">
            <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{diagnoses.length}</span>
            {consultations.length > 1 && (
              <button onClick={() => setCrossHistOpen(true)} title="Ver todas las consultas" className="p-1 hover:bg-[#deb887]/10 rounded-lg">
                <History className="w-3.5 h-3.5 text-[#b8944d]" />
              </button>
            )}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {diagnoses.map((diag, index) => (
            <motion.div
              key={diag.id || index}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setCurrentDiagnosis(diag)}
              className={`p-4 rounded-xl cursor-pointer border transition-all shadow-sm ${
                currentDiagnosis.id === diag.id 
                  ? 'bg-[#deb887]/10 border-[#deb887] ring-1 ring-[#deb887]' 
                  : 'bg-white border-gray-100 hover:border-[#deb887]/50'
              }`}
            >
              <div className="font-medium truncate mb-1 text-gray-800">{diag.diagnosis_text}</div>
              <div className="text-xs opacity-90 flex items-center gap-2 text-gray-500">
                <span className={`w-2 h-2 rounded-full ${diag.type === 'confirmed' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {diag.date ? new Date(toDateOnly(diag.date) + 'T12:00:00').toLocaleDateString('es-EC') : 'Nuevo'}
              </div>
            </motion.div>
          ))}
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleNew}
            className="w-full py-3 mt-2 border-2 border-dashed border-gray-200 rounded-xl text-gray-500 hover:border-[#deb887] hover:text-[#deb887] transition-colors font-medium flex items-center justify-center gap-2 bg-gray-50/50 hover:bg-[#deb887]/5"
          >
            <Plus className="w-4 h-4" />
            Nuevo Diagnóstico
          </motion.button>
          {diagnoses.length === 0 && (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay diagnósticos registrados
            </div>
          )}
        </div>
      </div>

      {/* Main Form */}
      <div className="flex-1 flex flex-col gap-6 overflow-visible md:overflow-y-auto pr-0 md:pr-2 custom-scrollbar">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm sticky top-0 z-10">
          <div className="flex gap-2 items-center">
            <Tooltip content="Guardar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSubmit} 
                disabled={saving} 
                className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
              >
                {saving ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <Save size={18} />}
                <span className="hidden sm:inline">Guardar</span>
              </motion.button>
            </Tooltip>

            <Tooltip content="Duplicar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 transition-colors"
              >
                <Copy size={18} />
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete} 
                disabled={deleting}
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 transition-colors disabled:opacity-50"
              >
                {deleting ? <div className="animate-spin w-4 h-4 border-2 border-red-300 border-t-red-500 rounded-full" /> : <Trash2 size={18} />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Imprimir">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePrint} 
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 transition-colors"
              >
                <Printer size={18} />
              </motion.button>
            </Tooltip>
            
          </div>
          <div className={`text-sm font-medium px-3 py-1 rounded-full flex items-center gap-2 ${
            currentDiagnosis.id ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {currentDiagnosis.id ? <Edit2 size={12} /> : <Plus size={12} />}
            {currentDiagnosis.id ? 'Editando' : 'Nuevo Registro'}
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Diagnóstico<FieldHelp text={HELP.diagnosis.diagnosis_text} /></label>
            <input
              type="text"
              required
              list="diagnoses-list"
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.diagnosis_text}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, diagnosis_text: e.target.value})}
              placeholder="Ej: Acné Vulgar"
            />
            <datalist id="diagnoses-list">
              {Object.values(diagnosisOptions).flat().map((d: string, i: number) => (
                <option key={i} value={d} />
              ))}
            </datalist>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">CIE-10 (Opcional)<FieldHelp text={HELP.diagnosis.cie10_code} /></label>
            <input
              type="text"
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.cie10_code}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, cie10_code: e.target.value})}
              placeholder="Ej: L70.0"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Tipo<FieldHelp text={HELP.diagnosis.type} /></label>
            <select
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.type}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, type: e.target.value})}
            >
              <option value="presumptive">Presuntivo</option>
              <option value="confirmed">Confirmado</option>
              <option value="differential">Diferencial</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Severidad<FieldHelp text={HELP.diagnosis.severity} /></label>
            <select
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.severity}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, severity: e.target.value})}
            >
              <option value="Leve">Leve</option>
              <option value="Moderado">Moderado</option>
              <option value="Severo">Severo</option>
            </select>
          </div>

          <div className="col-span-1 md:col-span-2 space-y-2">
            <label className="block text-sm font-bold text-gray-700">Notas / Observaciones<FieldHelp text={HELP.diagnosis.notes} /></label>
            <textarea
              rows={4}
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.notes}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, notes: e.target.value})}
              placeholder="Detalles adicionales del diagnóstico..."
            />
          </div>
        </div>
      </div>

    </motion.div>
    <CrossConsultHistoryModal
      isOpen={crossHistOpen}
      onClose={() => setCrossHistOpen(false)}
      tabLabel="Diagnósticos"
      consultations={consultations}
      items={diagnoses}
      currentConsultationId={consultationId}
      renderItem={d => (
        <div className="flex items-start gap-2">
          <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${d.type === 'confirmed' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <div>
            <p className="font-medium text-gray-800 line-clamp-2">{d.diagnosis_text}</p>
            <p className="text-gray-400 mt-0.5">{d.date ? new Date(toDateOnly(d.date)+'T12:00:00').toLocaleDateString('es-EC') : ''}</p>
          </div>
        </div>
      )}
      renderDetail={d => (
        <>
          <div><span className="text-gray-400">Texto:</span> <span className="font-medium">{d.diagnosis_text}</span></div>
          {d.cie10_code && <div><span className="text-gray-400">CIE-10:</span> {d.cie10_code}</div>}
          <div><span className="text-gray-400">Tipo:</span> {d.type === 'confirmed' ? 'Confirmado' : 'Presuntivo'}</div>
          {d.severity && <div><span className="text-gray-400">Severidad:</span> {d.severity}</div>}
          {d.notes && <div><span className="text-gray-400">Notas:</span> {d.notes}</div>}
          {d.date && <div><span className="text-gray-400">Fecha:</span> {new Date(toDateOnly(d.date)+'T12:00:00').toLocaleDateString('es-EC')}</div>}
        </>
      )}
    />
    </>
  );
}
