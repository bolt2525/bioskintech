import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Calendar, DollarSign, Clock, Save, Trash2, Copy, Sparkles, X, MessageSquare, Check, AlertCircle, FileText, Pencil } from 'lucide-react';
import treatmentOptions from '../../data/treatment_options.json';
import { Tooltip } from '../../../../ui/Tooltip';

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
  date: string;
  procedure_name: string;
  equipment_used: string;
  area_treated: string;
  duration_minutes: number;
  cost: number;
  notes: string;
  ai_suggestion?: string;
}

interface TreatmentTabProps {
  recordId: number;
  treatments: Treatment[];
  physicalExams?: any[];
  patientName?: string;
  patientAge?: number | string;
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
  ai_suggestion: ''
};

export default function TreatmentTab({ recordId, treatments, physicalExams = [], patientName, patientAge, onSave }: TreatmentTabProps) {
  const [currentTreatment, setCurrentTreatment] = useState<Treatment>({ ...EMPTY_TREATMENT });
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  
  // AI Modal State
  const [showAIModal, setShowAIModal] = useState(false);
  const [aiContext, setAiContext] = useState('');
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [editableExamData, setEditableExamData] = useState('');
  const [generatingAI, setGeneratingAI] = useState(false);

  // Sort treatments by date descending for the history list
  const sortedTreatments = [...treatments].sort((a, b) => 
    new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  useEffect(() => {
    if (showAIModal && physicalExams.length > 0 && !selectedExamId) {
      handleExamSelect(physicalExams[0].id);
    }
  }, [showAIModal, physicalExams]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleExamSelect = (examId: string | number) => {
    setSelectedExamId(String(examId));
    const exam = physicalExams.find(e => String(e.id) === String(examId));
    if (exam) {
      // Format exam data for display/editing
      let text = `Tipo de Piel: ${exam.skin_type || 'N/A'}\n`;
      text += `Fototipo: ${exam.phototype || 'N/A'}\n`;
      text += `Glogau: ${exam.glogau_scale || 'N/A'}\n`;
      text += `Lesiones: ${exam.lesions_description || 'N/A'}\n`;
      
      try {
        const face = typeof exam.face_map_data === 'string' ? JSON.parse(exam.face_map_data) : exam.face_map_data;
        if (Array.isArray(face) && face.length > 0) {
          text += `\nMapa Facial (Lesiones):\n`;
          face.forEach((f: any) => {
             text += `- ${f.category} (${f.distribution || 'General'}): ${f.severity || 'N/A'} - ${f.notes || 'Zona no especificada'}\n`;
          });
        }
        
        const body = typeof exam.body_map_data === 'string' ? JSON.parse(exam.body_map_data) : exam.body_map_data;
        if (Array.isArray(body) && body.length > 0) {
          text += `\nMapa Corporal (Lesiones):\n`;
          body.forEach((b: any) => {
             text += `- ${b.category} (${b.distribution || 'General'}): ${b.severity || 'N/A'} - ${b.notes || 'Zona no especificada'}\n`;
          });
        }
      } catch (e) {
        console.error('Error parsing map data', e);
      }

      setEditableExamData(text);
    }
  };

  const handleGenerateAI = async () => {
    setGeneratingAI(true);
    try {
      const response = await fetch('/api/records?action=generateTreatmentAI', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientName,
          patientAge,
          examData: editableExamData, // Send the edited text
          treatmentContext: aiContext
        }),
      });

      if (!response.ok) throw new Error('Error generating AI suggestion');

      const data = await response.json();
      
      // Helper to format recursive objects/arrays
      const formatProtocolValue = (value: any, depth = 0): string => {
        const indent = '  '.repeat(depth);
        
        if (value === null || value === undefined) return '';
        
        if (typeof value === 'string') return value;
        
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        
        if (Array.isArray(value)) {
          return value.map((item, i) => {
             // If item is string, just list it. If object, format it.
             if (typeof item === 'string') return `${indent}${i+1}. ${item}`;
             return `${indent}${i+1}. \n${formatProtocolValue(item, depth + 1)}`;
          }).join('\n');
        }
        
        if (typeof value === 'object') {
          return Object.entries(value).map(([k, v]) => {
            // Format key: device_parameters -> Device Parameters
            const niceKey = k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            
            // If value is object/array, put on new line
            if (typeof v === 'object' && v !== null) {
                return `${indent}${niceKey}:\n${formatProtocolValue(v, depth + 1)}`;
            }
            return `${indent}${niceKey}: ${formatProtocolValue(v, depth)}`;
          }).join('\n');
        }
        
        return String(value);
      };

      // Format the result
      let protocolText = formatProtocolValue(data.protocol);

      const formattedSuggestion = `TRATAMIENTO SUGERIDO: ${data.treatment_name}
      
DESCRIPCIÓN:
${data.description}

OBJETIVO:
${data.objective}

PROTOCOLO:
${protocolText}`;

      setCurrentTreatment(prev => ({
        ...prev,
        ai_suggestion: formattedSuggestion,
        // Optionally fill other fields if empty
        procedure_name: prev.procedure_name || data.treatment_name,
        notes: prev.notes || formattedSuggestion
      }));

      setShowAIModal(false);
      setMessage({ type: 'success', text: 'Sugerencia generada correctamente' });
    } catch (error) {
      console.error('AI Error:', error);
      setMessage({ type: 'error', text: 'Error al generar sugerencia' });
    } finally {
      setGeneratingAI(false);
    }
  };

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
        ...currentTreatment
      };

      const response = await fetch(`/api/records?action=${action}`, {
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
      const response = await fetch(`/api/records?action=deleteTreatment&id=${currentTreatment.id}`, { 
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
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {sortedTreatments.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay tratamientos previos
            </div>
          ) : (
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
              <label className="block text-sm font-medium text-gray-700">Procedimiento</label>
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
              <label className="block text-sm font-medium text-gray-700">Equipo Utilizado</label>
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
              <label className="block text-sm font-medium text-gray-700">Zona Tratada</label>
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
                <label className="block text-sm font-medium text-gray-700">Duración (min)</label>
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
                <label className="block text-sm font-medium text-gray-700">Costo</label>
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
            <label className="block text-sm font-medium text-gray-700">Notas / Parámetros</label>
            <textarea
              rows={5}
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentTreatment.notes}
              onChange={e => setCurrentTreatment({...currentTreatment, notes: e.target.value})}
              placeholder="Detalles de la sesión, parámetros del equipo..."
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="block text-sm font-medium text-gray-700">Sugerencia IA</label>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowAIModal(true)}
                className="flex items-center gap-1.5 text-xs bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white px-3 py-1.5 rounded-lg shadow-md hover:shadow-lg transition-all font-medium"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Generar con IA
              </motion.button>
            </div>
            <textarea
              rows={6}
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none bg-gray-50/50"
              value={currentTreatment.ai_suggestion || ''}
              onChange={e => setCurrentTreatment({...currentTreatment, ai_suggestion: e.target.value})}
              placeholder="La sugerencia generada por IA aparecerá aquí..."
            />
          </div>
        </div>
      </div>

      {/* AI Modal */}
      <AnimatePresence>
        {showAIModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
            >
              <div className="p-4 border-b flex justify-between items-center bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white">
                <h3 className="font-bold flex items-center gap-2">
                  <Sparkles className="w-5 h-5" />
                  Asistente de Tratamiento IA
                </h3>
                <button onClick={() => setShowAIModal(false)} className="hover:bg-white/20 p-1.5 rounded-lg transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="p-6 overflow-y-auto space-y-6 flex-1 custom-scrollbar">
                <div className="bg-blue-50 p-4 rounded-xl text-sm text-blue-800 border border-blue-100 flex items-start gap-3">
                  <div className="p-1 bg-blue-100 rounded-full shrink-0">
                    <MessageSquare className="w-4 h-4 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-semibold mb-1">Información del Paciente</p>
                    <p>{patientName} ({patientAge} años)</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">1. Seleccionar Examen Físico Base</label>
                  <select 
                    className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all"
                    value={selectedExamId}
                    onChange={(e) => handleExamSelect(e.target.value)}
                  >
                    <option value="">Seleccionar examen...</option>
                    {physicalExams.map((exam, idx) => (
                      <option key={exam.id || idx} value={exam.id}>
                        {exam.created_at ? new Date(exam.created_at).toLocaleDateString() : `Examen ${exam.id}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">2. Contexto Clínico (Editable)</label>
                  <textarea
                    rows={4}
                    className="w-full p-3 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all resize-none"
                    value={editableExamData}
                    onChange={(e) => setEditableExamData(e.target.value)}
                    placeholder="Datos del examen físico..."
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">3. Contexto del Tratamiento</label>
                  <textarea
                    rows={3}
                    className="w-full p-3 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all resize-none"
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    placeholder="Describe el equipo a usar, objetivo, número de sesión, etc..."
                  />
                </div>
              </div>

              <div className="p-4 border-t bg-gray-50 flex justify-end gap-3">
                <button 
                  onClick={() => setShowAIModal(false)}
                  className="px-4 py-2 text-gray-600 hover:bg-gray-200 rounded-lg font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  onClick={handleGenerateAI}
                  disabled={generatingAI}
                  className="px-6 py-2 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-lg hover:shadow-lg disabled:opacity-50 flex items-center gap-2 font-medium transition-all"
                >
                  {generatingAI ? (
                    <>
                      <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
                      Generando...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Generar Sugerencia
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
