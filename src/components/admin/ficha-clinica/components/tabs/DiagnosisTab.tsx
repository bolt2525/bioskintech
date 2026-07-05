import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Plus, Trash2, Copy, Printer, Sparkles, Check, X, Info, Edit2 } from 'lucide-react';
import diagnosisOptions from '../../data/diagnosis_options.json';
import { Tooltip } from '../../../../ui/Tooltip';

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

interface PhysicalExam {
  id?: number;
  created_at?: string;
  face_map_data?: string;
  body_map_data?: string;
  skin_type?: string;
  phototype?: string;
  glogau_scale?: string;
  lesions_description?: string;
}

interface DiagnosisTabProps {
  recordId: number;
  diagnoses: Diagnosis[];
  physicalExams?: PhysicalExam[];
  patientName?: string;
  onSave: () => void;
}

const EMPTY_DIAGNOSIS: Omit<Diagnosis, 'record_id'> = {
  diagnosis_text: '',
  cie10_code: '',
  type: 'presumptive',
  severity: 'Leve',
  notes: ''
};

export default function DiagnosisTab({ recordId, diagnoses, physicalExams = [], patientName, onSave }: DiagnosisTabProps) {
  const [currentDiagnosis, setCurrentDiagnosis] = useState<Diagnosis>({ ...EMPTY_DIAGNOSIS, record_id: recordId });
  const [saving, setSaving] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [selectedExamId, setSelectedExamId] = useState<number | string>('');

  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [showContextModal, setShowContextModal] = useState(false);
  const [contextText, setContextText] = useState('');
  const [loadingContext, setLoadingContext] = useState(false);

  useEffect(() => {
    if (diagnoses.length > 0 && !currentDiagnosis.id) {
      setCurrentDiagnosis(diagnoses[0]);
    } else if (diagnoses.length === 0 && !currentDiagnosis.id) {
      setCurrentDiagnosis({ ...EMPTY_DIAGNOSIS, record_id: recordId });
    }
  }, [diagnoses, recordId]);

  useEffect(() => {
    if (physicalExams && physicalExams.length > 0) {
      // Default to the first exam (assuming sorted by date DESC from API)
      setSelectedExamId(physicalExams[0].id || '');
    }
  }, [physicalExams]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNew = () => {
    setCurrentDiagnosis({ ...EMPTY_DIAGNOSIS, record_id: recordId });
    setMessage(null);
    setAiWarning(null);
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
      const response = await fetch(`/api/records?action=deleteDiagnosis&id=${currentDiagnosis.id}`, {
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

  const handleOpenAIModal = async () => {
    if (!physicalExams || physicalExams.length === 0) {
      setMessage({ type: 'error', text: 'No hay examen físico registrado. Complete el examen físico primero.' });
      return;
    }

    const examToUse = physicalExams.find(e => e.id === Number(selectedExamId)) || physicalExams[0];
    setLoadingContext(true);
    setShowContextModal(true);

    try {
      const response = await fetch('/api/records?action=getDiagnosisContext', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          examData: examToUse,
          patientName
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setContextText(data.context);
      } else {
        setContextText('Error al cargar el contexto. Puede escribirlo manualmente.');
      }
    } catch (error) {
      console.error('Error fetching context:', error);
      setContextText('Error de conexión. Puede escribir el contexto manualmente.');
    } finally {
      setLoadingContext(false);
    }
  };

  const handleGenerateAI = async () => {
    setGeneratingAI(true);
    setMessage(null);
    setShowContextModal(false);

    const examToUse = physicalExams.find(e => e.id === Number(selectedExamId)) || physicalExams[0];

    try {
      const response = await fetch('/api/records?action=generateDiagnosisAI', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          examData: examToUse,
          patientName,
          customContext: contextText
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Error al generar diagnóstico con IA');
      }

      const data = await response.json();
      
      // Fix for potential double-encoded JSON or object response
      let diagnosisText = data.diagnosis;
      
      // Handle case where diagnosis is an object
      if (typeof diagnosisText === 'object' && diagnosisText !== null) {
        diagnosisText = diagnosisText.diagnosis || diagnosisText.text || JSON.stringify(diagnosisText);
      }
      
      // Handle case where diagnosis is a stringified JSON (e.g. "{ ... }")
      if (typeof diagnosisText === 'string' && diagnosisText.trim().startsWith('{') && diagnosisText.trim().endsWith('}')) {
         try {
            const parsed = JSON.parse(diagnosisText);
            if (parsed.diagnosis) diagnosisText = parsed.diagnosis;
         } catch (e) {
            // Not valid JSON, keep as is
         }
      }

      setCurrentDiagnosis(prev => ({
        ...prev,
        diagnosis_text: diagnosisText || prev.diagnosis_text,
        notes: data.notes || prev.notes
      }));
      
      setMessage({ type: 'success', text: 'Diagnóstico generado por IA correctamente' });
      setAiWarning('IMPORTANTE: Este diagnóstico ha sido generado por Inteligencia Artificial. Se requiere revisión y validación por parte de un profesional médico antes de guardar.');

    } catch (error: any) {
      console.error('AI Generation error:', error);
      setMessage({ type: 'error', text: error.message || 'Error al generar diagnóstico con IA' });
    } finally {
      setGeneratingAI(false);
    }
  };

  const addContextOption = (option: string) => {
    setContextText(prev => prev + '\n- ' + option);
  };

  const handleSubmit = async () => {
    if (aiWarning && !confirm('¿Ha revisado y validado el diagnóstico generado por IA?')) {
      return;
    }

    setSaving(true);
    setMessage(null);
    setAiWarning(null);

    try {
      const response = await fetch('/api/records?action=saveDiagnosis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentDiagnosis),
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
            <h1>BIOSKIN</h1>
            <p>Dermatología y Medicina Estética</p>
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
            
            <div className="h-8 w-px bg-gray-200 mx-2 hidden sm:block"></div>

            <select 
                className="p-2 border border-gray-200 rounded-lg text-sm max-w-[180px] focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 hover:bg-white transition-colors"
                value={selectedExamId}
                onChange={(e) => setSelectedExamId(Number(e.target.value))}
                title="Seleccionar Examen Físico base"
            >
                {physicalExams.map((exam, idx) => (
                    <option key={exam.id || idx} value={exam.id}>
                        {exam.created_at ? new Date(exam.created_at).toLocaleDateString() : 'Examen'}
                    </option>
                ))}
                {physicalExams.length === 0 && <option value="">Sin exámenes</option>}
            </select>

            <motion.button 
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleOpenAIModal} 
              disabled={generatingAI} 
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-lg hover:shadow-md transition-all disabled:opacity-50 shadow-lg shadow-[#deb887]/20"
            >
              <Sparkles className="w-4 h-4" />
              <span className="text-sm font-medium hidden sm:inline">{generatingAI ? 'Generando...' : 'Diagnóstico IA'}</span>
            </motion.button>
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

        <AnimatePresence>
          {aiWarning && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="p-4 rounded-xl bg-amber-50 text-amber-800 border border-amber-100 flex items-start gap-3 shadow-sm"
            >
              <div className="p-1.5 bg-amber-100 rounded-full mt-0.5">
                <AlertCircle className="w-4 h-4" />
              </div>
              <div>
                <p className="font-bold text-sm mb-1">Atención</p>
                <p className="text-sm opacity-90 leading-relaxed">{aiWarning}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Diagnóstico</label>
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
            <label className="block text-sm font-bold text-gray-700">CIE-10 (Opcional)</label>
            <input
              type="text"
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentDiagnosis.cie10_code}
              onChange={e => setCurrentDiagnosis({...currentDiagnosis, cie10_code: e.target.value})}
              placeholder="Ej: L70.0"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Tipo</label>
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
            <label className="block text-sm font-bold text-gray-700">Severidad</label>
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
            <label className="block text-sm font-bold text-gray-700">Notas / Observaciones</label>
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

      {/* AI Context Modal */}
      <AnimatePresence>
        {showContextModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col border border-gray-100"
            >
              <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                <div className="flex items-center gap-2 text-[#deb887]">
                  <div className="p-2 bg-[#deb887]/10 rounded-lg">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <h3 className="text-lg font-bold text-gray-800">Contexto para Diagnóstico IA</h3>
                </div>
                <button onClick={() => setShowContextModal(false)} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 p-2 rounded-lg transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="p-6 overflow-y-auto flex-1 space-y-6 custom-scrollbar">
                <div className="bg-blue-50 p-4 rounded-xl text-sm text-blue-800 border border-blue-100 flex gap-3">
                  <Info className="w-5 h-5 flex-shrink-0" />
                  <p>Revise y modifique la información que se enviará a la IA. Puede añadir instrucciones específicas o corregir datos.</p>
                </div>

                {loadingContext ? (
                  <div className="flex justify-center py-12">
                    <div className="animate-spin w-10 h-10 border-4 border-[#deb887] border-t-transparent rounded-full"></div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <label className="block text-sm font-bold text-gray-700">Contexto del Paciente y Examen Físico</label>
                      <textarea
                        value={contextText}
                        onChange={(e) => setContextText(e.target.value)}
                        className="w-full h-64 p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none font-mono text-sm bg-gray-50/50 focus:bg-white transition-all"
                      />
                    </div>

                    <div className="space-y-3">
                      <label className="block text-sm font-bold text-gray-700">Opciones Rápidas (Añadir al contexto)</label>
                      <div className="flex flex-wrap gap-2">
                        {[
                          "Considerar antecedentes de acné",
                          "Enfocarse en lesiones pigmentadas",
                          "Descartar patología maligna",
                          "Sugerir diagnóstico diferencial",
                          "Considerar fototipo alto"
                        ].map((option) => (
                          <motion.button
                            key={option}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={() => addContextOption(option)}
                            className="px-3 py-1.5 bg-gray-100 hover:bg-[#deb887]/10 hover:text-[#deb887] rounded-lg text-xs text-gray-600 transition-colors border border-gray-200 hover:border-[#deb887]/30 font-medium"
                          >
                            + {option}
                          </motion.button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50 rounded-b-2xl">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setShowContextModal(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-white hover:shadow-sm rounded-lg transition-all border border-transparent hover:border-gray-200 font-medium"
                >
                  Cancelar
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleGenerateAI}
                  disabled={loadingContext}
                  className="flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-lg hover:shadow-lg hover:shadow-[#deb887]/20 transition-all disabled:opacity-50 font-medium"
                >
                  <Sparkles className="w-4 h-4" />
                  Generar Diagnóstico
                </motion.button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
