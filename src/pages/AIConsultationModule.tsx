import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain, User, Users, ChevronRight, ChevronDown, ChevronLeft,
  Send, Loader2, BookOpen, Stethoscope, Pill, FlaskConical,
  FileText, ClipboardList, X, Check, History, Trash2, AlertCircle,
  Sparkles, RotateCcw, Save
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import recordsFetch from '../utils/recordsFetch';

// ─── Máquina de estados ──────────────────────────────────────────────────────
type Step = 'type_select' | 'patient_search' | 'context_config' | 'question' | 'response';

interface Patient {
  id: number;
  first_name: string;
  last_name: string;
  birth_date?: string;
  phone?: string;
}

interface ContextIndex {
  antecedentes: { id: number; created_at: string; chief_complaint?: string }[];
  examenes: { id: number; created_at: string; skin_type?: string; phototype?: string }[];
  diagnosticos: { id: number; date: string; diagnosis_text: string; type: string }[];
  tratamientos: { id: number; date: string; procedure_name: string; area_treated?: string }[];
  recetas: { id: number; date: string; medications?: string }[];
}

interface TabSelection {
  enabled: boolean;
  ids: number[];
}

interface Selections {
  antecedentes: TabSelection;
  examenes: TabSelection;
  diagnosticos: TabSelection;
  tratamientos: TabSelection;
  recetas: TabSelection;
}

const EMPTY_SELECTIONS: Selections = {
  antecedentes: { enabled: false, ids: [] },
  examenes:     { enabled: false, ids: [] },
  diagnosticos: { enabled: false, ids: [] },
  tratamientos: { enabled: false, ids: [] },
  recetas:      { enabled: false, ids: [] },
};

interface SavedConsultation {
  id: number;
  patient_name: string | null;
  consultation_type: string;
  question: string;
  response_preview: string;
  tabs_used: string[];
  created_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const formatDate = (d: string) => {
  if (!d) return 'N/A';
  try { return new Date(d).toLocaleDateString('es-EC'); } catch { return d; }
};

const calculateAge = (birthDate: string): string => {
  if (!birthDate) return '';
  const age = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 3600 * 1000));
  return `${age} años`;
};

// ─── Subcomponentes ──────────────────────────────────────────────────────────
const TabCheckbox = ({
  label, icon: Icon, color, enabled, count, expanded, onToggle, onExpand, children
}: {
  label: string; icon: React.ComponentType<{ className?: string }>;
  color: string; enabled: boolean; count: number; expanded: boolean;
  onToggle: () => void; onExpand: () => void; children?: React.ReactNode;
}) => (
  <div className={`rounded-xl border transition-all ${enabled ? 'border-[#deb887] bg-[#deb887]/5' : 'border-gray-200 bg-white'}`}>
    <div className="flex items-center gap-3 p-4">
      <button
        onClick={onToggle}
        className={`w-5 h-5 rounded flex items-center justify-center border-2 flex-shrink-0 transition-colors ${
          enabled ? 'bg-[#deb887] border-[#deb887]' : 'border-gray-300 bg-white'
        }`}
      >
        {enabled && <Check className="w-3 h-3 text-white" />}
      </button>
      <div className={`p-2 rounded-lg ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1">
        <span className="font-medium text-gray-800">{label}</span>
        <span className="ml-2 text-xs text-gray-400">({count} disponibles)</span>
      </div>
      {enabled && count > 0 && (
        <button onClick={onExpand} className="p-1 text-gray-400 hover:text-gray-600 transition-colors">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      )}
    </div>
    {enabled && expanded && children && (
      <div className="px-4 pb-4 border-t border-[#deb887]/20">{children}</div>
    )}
  </div>
);

// ─── Componente principal ────────────────────────────────────────────────────
export default function AIConsultationModule() {
  const [step, setStep] = useState<Step>('type_select');
  const [mode, setMode] = useState<'patient' | 'open'>('patient');

  // Patient selection
  const [patientQuery, setPatientQuery] = useState('');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [loadingPatients, setLoadingPatients] = useState(false);

  // Context config
  const [contextIndex, setContextIndex] = useState<ContextIndex | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [selections, setSelections] = useState<Selections>({ ...EMPTY_SELECTIONS });
  const [expandedTabs, setExpandedTabs] = useState<Set<keyof Selections>>(new Set());

  // Question
  const [question, setQuestion] = useState('');
  const [questionSuggestions] = useState([
    '¿Cuál es el mejor tratamiento para la condición actual del paciente?',
    '¿Hay contraindicaciones que deba considerar antes del siguiente procedimiento?',
    '¿Los tratamientos anteriores han sido efectivos? ¿Qué ajustes recomiendas?',
    '¿Existe riesgo de interacción con los medicamentos actuales?',
    '¿Cuál debería ser el protocolo de seguimiento?',
  ]);

  // Response
  const [response, setResponse] = useState('');
  const [contextSummary, setContextSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveConsultation, setSaveConsultation] = useState(true);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<SavedConsultation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // ── Buscar pacientes ──────────────────────────────────────────────────────
  const searchPatients = useCallback(async (q: string) => {
    if (q.length < 2) { setPatients([]); return; }
    setLoadingPatients(true);
    try {
      const res = await recordsFetch(`/api/records?action=listPatients&search=${encodeURIComponent(q)}&limit=10`);
      if (res.ok) {
        const data = await res.json();
        setPatients(data.patients || data || []);
      }
    } catch (e) { console.error(e); }
    finally { setLoadingPatients(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchPatients(patientQuery), 300);
    return () => clearTimeout(t);
  }, [patientQuery, searchPatients]);

  // ── Cargar índice de contexto al seleccionar paciente ────────────────────
  const loadContextIndex = async (patientId: number) => {
    setLoadingContext(true);
    setContextIndex(null);
    setSelections({ ...EMPTY_SELECTIONS });
    try {
      const res = await recordsFetch(`/api/ai-consultation?action=getContextIndex&patient_id=${patientId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('adminSessionToken') || ''}` },
      });
      if (res.ok) setContextIndex(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoadingContext(false); }
  };

  // ── Toggle tab selection ─────────────────────────────────────────────────
  const toggleTab = (tab: keyof Selections) => {
    setSelections(prev => {
      const current = prev[tab];
      if (!current.enabled) {
        // Habilitar y seleccionar todos por defecto
        const allIds = (contextIndex?.[tab] as any[] || []).map((i: any) => i.id);
        return { ...prev, [tab]: { enabled: true, ids: allIds } };
      }
      return { ...prev, [tab]: { enabled: false, ids: [] } };
    });
  };

  const toggleItem = (tab: keyof Selections, id: number) => {
    setSelections(prev => {
      const current = prev[tab];
      const ids = current.ids.includes(id)
        ? current.ids.filter(x => x !== id)
        : [...current.ids, id];
      return { ...prev, [tab]: { ...current, ids } };
    });
  };

  const toggleExpanded = (tab: keyof Selections) => {
    setExpandedTabs(prev => {
      const next = new Set(prev);
      next.has(tab) ? next.delete(tab) : next.add(tab);
      return next;
    });
  };

  // ── Ejecutar consulta IA ─────────────────────────────────────────────────
  const runQuery = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const payload: any = {
        question: question.trim(),
        save: saveConsultation,
      };

      if (mode === 'patient' && selectedPatient) {
        payload.patient_id = selectedPatient.id;
        payload.patient_name = `${selectedPatient.first_name} ${selectedPatient.last_name}`;
        payload.selections = selections;
      }

      const res = await recordsFetch('/api/ai-consultation?action=query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error al procesar la consulta');
      }

      const data = await res.json();
      setResponse(data.response);
      setContextSummary(data.contextSummary || '');
      setStep('response');
    } catch (e: any) {
      setError(e.message || 'Error inesperado');
    } finally {
      setLoading(false);
    }
  };

  // ── Cargar historial ─────────────────────────────────────────────────────
  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const url = selectedPatient
        ? `/api/ai-consultation?action=list&patient_id=${selectedPatient.id}`
        : '/api/ai-consultation?action=list';
      const res = await recordsFetch(url);
      if (res.ok) setHistory(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoadingHistory(false); }
  };

  const deleteHistory = async (id: number) => {
    await recordsFetch(`/api/ai-consultation?action=delete&id=${id}`, { method: 'DELETE' });
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  // ── Helpers de conteo ────────────────────────────────────────────────────
  const enabledCount = Object.values(selections).filter(s => s.enabled).length;
  const totalSelected = Object.values(selections).reduce((a, s) => a + s.ids.length, 0);

  return (
    <AdminLayout>
      <div className="p-4 md:p-8 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-[#deb887] to-[#d4a76a] rounded-2xl shadow-lg">
              <Brain className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Consultas IA</h1>
              <p className="text-gray-500 text-sm">Asistente médico con contexto clínico</p>
            </div>
          </div>
          <button
            onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadHistory(); }}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50 transition-colors text-sm"
          >
            <History className="w-4 h-4" />
            Historial
          </button>
        </div>

        {/* ── HISTORIAL PANEL ─────────────────────────────────────────────── */}
        <AnimatePresence>
          {showHistory && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-6 bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm"
            >
              <div className="p-4 border-b flex justify-between items-center bg-gray-50">
                <span className="font-semibold text-gray-700">Historial de consultas</span>
                <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                {loadingHistory && (
                  <div className="p-6 flex justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-[#deb887]" />
                  </div>
                )}
                {!loadingHistory && history.length === 0 && (
                  <div className="p-6 text-center text-gray-400 text-sm">Sin consultas guardadas</div>
                )}
                {history.map(h => (
                  <div key={h.id} className="p-4 flex gap-3 hover:bg-gray-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">{h.question}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {h.patient_name || 'Consulta abierta'} · {formatDate(h.created_at)}
                      </p>
                      <p className="text-xs text-gray-500 mt-1 truncate">{h.response_preview}...</p>
                    </div>
                    <button
                      onClick={() => deleteHistory(h.id)}
                      className="p-1.5 text-gray-300 hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── MÁQUINA DE ESTADOS ───────────────────────────────────────────── */}

        {/* PASO 1: Selección de tipo */}
        {step === 'type_select' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <h2 className="text-lg font-semibold text-gray-700 mb-6">¿Qué tipo de consulta deseas realizar?</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => { setMode('patient'); setStep('patient_search'); }}
                className="p-6 bg-white border-2 border-gray-200 hover:border-[#deb887] rounded-2xl text-left transition-all group shadow-sm hover:shadow-md"
              >
                <div className="w-12 h-12 bg-[#deb887]/10 group-hover:bg-[#deb887]/20 rounded-xl flex items-center justify-center mb-4 transition-colors">
                  <User className="w-6 h-6 text-[#deb887]" />
                </div>
                <h3 className="font-bold text-gray-800 text-lg mb-2">Consulta con Paciente</h3>
                <p className="text-gray-500 text-sm leading-relaxed">
                  Selecciona un paciente y elige qué datos de su ficha clínica incluir como contexto.
                  La IA analizará antecedentes, tratamientos, diagnósticos y más.
                </p>
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => { setMode('open'); setStep('question'); }}
                className="p-6 bg-white border-2 border-gray-200 hover:border-[#deb887] rounded-2xl text-left transition-all group shadow-sm hover:shadow-md"
              >
                <div className="w-12 h-12 bg-purple-50 group-hover:bg-purple-100 rounded-xl flex items-center justify-center mb-4 transition-colors">
                  <Users className="w-6 h-6 text-purple-500" />
                </div>
                <h3 className="font-bold text-gray-800 text-lg mb-2">Consulta Abierta</h3>
                <p className="text-gray-500 text-sm leading-relaxed">
                  Realiza una pregunta libre sobre dermatología, medicina estética, protocolos
                  o cualquier tema médico sin asociarlo a un paciente específico.
                </p>
              </motion.button>
            </div>
          </motion.div>
        )}

        {/* PASO 2: Búsqueda de paciente */}
        {step === 'patient_search' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="flex items-center gap-3 mb-6">
              <button onClick={() => setStep('type_select')} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                <ChevronLeft className="w-5 h-5 text-gray-500" />
              </button>
              <h2 className="text-lg font-semibold text-gray-700">Buscar paciente</h2>
            </div>

            <div className="relative">
              <input
                type="text"
                value={patientQuery}
                onChange={e => setPatientQuery(e.target.value)}
                placeholder="Nombre, apellido o cédula del paciente..."
                className="w-full p-4 pl-12 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all"
                autoFocus
              />
              <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              {loadingPatients && (
                <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 animate-spin" />
              )}
            </div>

            {patients.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm divide-y divide-gray-100">
                {patients.map(p => (
                  <motion.button
                    key={p.id}
                    whileHover={{ backgroundColor: '#fef9f0' }}
                    onClick={async () => {
                      setSelectedPatient(p);
                      await loadContextIndex(p.id);
                      setStep('context_config');
                    }}
                    className="w-full flex items-center gap-4 p-4 text-left transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#deb887]/10 flex items-center justify-center flex-shrink-0">
                      <span className="text-[#deb887] font-bold text-sm">
                        {p.first_name[0]}{p.last_name[0]}
                      </span>
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{p.first_name} {p.last_name}</p>
                      {p.birth_date && (
                        <p className="text-sm text-gray-400">{calculateAge(p.birth_date)}</p>
                      )}
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-300 ml-auto" />
                  </motion.button>
                ))}
              </div>
            )}

            {patientQuery.length >= 2 && !loadingPatients && patients.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No se encontraron pacientes</p>
              </div>
            )}
          </motion.div>
        )}

        {/* PASO 3: Configurar contexto */}
        {step === 'context_config' && selectedPatient && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => setStep('patient_search')} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
                <ChevronLeft className="w-5 h-5 text-gray-500" />
              </button>
              <div>
                <h2 className="text-lg font-semibold text-gray-700">Seleccionar contexto clínico</h2>
                <p className="text-sm text-gray-400">
                  Paciente: <strong className="text-[#deb887]">{selectedPatient.first_name} {selectedPatient.last_name}</strong>
                </p>
              </div>
            </div>

            {loadingContext ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-[#deb887]" />
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 bg-blue-50 border border-blue-100 rounded-xl p-3 flex gap-2">
                  <AlertCircle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                  Selecciona los tabs que deseas incluir como contexto. Por defecto se seleccionan todos los registros disponibles; puedes desmarcar los que no apliquen.
                </p>

                <div className="space-y-3">
                  <TabCheckbox
                    label="Antecedentes" icon={BookOpen} color="bg-amber-50 text-amber-600"
                    enabled={selections.antecedentes.enabled}
                    count={contextIndex?.antecedentes.length || 0}
                    expanded={expandedTabs.has('antecedentes')}
                    onToggle={() => toggleTab('antecedentes')}
                    onExpand={() => toggleExpanded('antecedentes')}
                  >
                    <div className="pt-3 space-y-2">
                      {contextIndex?.antecedentes.map(item => (
                        <label key={item.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selections.antecedentes.ids.includes(item.id)}
                            onChange={() => toggleItem('antecedentes', item.id)}
                            className="accent-[#deb887]"
                          />
                          <span className="text-sm text-gray-600">
                            {formatDate(item.created_at)} — {item.chief_complaint || 'Sin motivo registrado'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </TabCheckbox>

                  <TabCheckbox
                    label="Examen Físico" icon={Stethoscope} color="bg-teal-50 text-teal-600"
                    enabled={selections.examenes.enabled}
                    count={contextIndex?.examenes.length || 0}
                    expanded={expandedTabs.has('examenes')}
                    onToggle={() => toggleTab('examenes')}
                    onExpand={() => toggleExpanded('examenes')}
                  >
                    <div className="pt-3 space-y-2">
                      {contextIndex?.examenes.map(item => (
                        <label key={item.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selections.examenes.ids.includes(item.id)}
                            onChange={() => toggleItem('examenes', item.id)}
                            className="accent-[#deb887]"
                          />
                          <span className="text-sm text-gray-600">
                            {formatDate(item.created_at)} — {item.skin_type || 'N/A'} | Fototipo {item.phototype || 'N/A'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </TabCheckbox>

                  <TabCheckbox
                    label="Diagnósticos" icon={ClipboardList} color="bg-blue-50 text-blue-600"
                    enabled={selections.diagnosticos.enabled}
                    count={contextIndex?.diagnosticos.length || 0}
                    expanded={expandedTabs.has('diagnosticos')}
                    onToggle={() => toggleTab('diagnosticos')}
                    onExpand={() => toggleExpanded('diagnosticos')}
                  >
                    <div className="pt-3 space-y-2">
                      {contextIndex?.diagnosticos.map(item => (
                        <label key={item.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selections.diagnosticos.ids.includes(item.id)}
                            onChange={() => toggleItem('diagnosticos', item.id)}
                            className="accent-[#deb887]"
                          />
                          <span className="text-sm text-gray-600">
                            {formatDate(item.date)} — {item.diagnosis_text} ({item.type})
                          </span>
                        </label>
                      ))}
                    </div>
                  </TabCheckbox>

                  <TabCheckbox
                    label="Tratamientos" icon={FlaskConical} color="bg-purple-50 text-purple-600"
                    enabled={selections.tratamientos.enabled}
                    count={contextIndex?.tratamientos.length || 0}
                    expanded={expandedTabs.has('tratamientos')}
                    onToggle={() => toggleTab('tratamientos')}
                    onExpand={() => toggleExpanded('tratamientos')}
                  >
                    <div className="pt-3 space-y-2">
                      {contextIndex?.tratamientos.map(item => (
                        <label key={item.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selections.tratamientos.ids.includes(item.id)}
                            onChange={() => toggleItem('tratamientos', item.id)}
                            className="accent-[#deb887]"
                          />
                          <span className="text-sm text-gray-600">
                            {formatDate(item.date)} — {item.procedure_name} {item.area_treated ? `| ${item.area_treated}` : ''}
                          </span>
                        </label>
                      ))}
                    </div>
                  </TabCheckbox>

                  <TabCheckbox
                    label="Recetas" icon={Pill} color="bg-green-50 text-green-600"
                    enabled={selections.recetas.enabled}
                    count={contextIndex?.recetas.length || 0}
                    expanded={expandedTabs.has('recetas')}
                    onToggle={() => toggleTab('recetas')}
                    onExpand={() => toggleExpanded('recetas')}
                  >
                    <div className="pt-3 space-y-2">
                      {contextIndex?.recetas.map(item => (
                        <label key={item.id} className="flex items-center gap-3 p-2 hover:bg-white rounded-lg cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selections.recetas.ids.includes(item.id)}
                            onChange={() => toggleItem('recetas', item.id)}
                            className="accent-[#deb887]"
                          />
                          <span className="text-sm text-gray-600">
                            {formatDate(item.date)} — {item.medications || 'Sin medicamentos registrados'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </TabCheckbox>
                </div>

                {/* Resumen de selección */}
                {enabledCount > 0 && (
                  <div className="bg-[#deb887]/10 border border-[#deb887]/30 rounded-xl p-3 flex items-center gap-2 text-sm text-[#9a7a50]">
                    <Check className="w-4 h-4" />
                    <span>{enabledCount} sección{enabledCount > 1 ? 'es' : ''} seleccionada{enabledCount > 1 ? 's' : ''} — {totalSelected} registro{totalSelected !== 1 ? 's' : ''} incluido{totalSelected !== 1 ? 's' : ''}</span>
                  </div>
                )}

                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => setStep('question')}
                  className="w-full py-3 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-xl font-medium flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all"
                >
                  Continuar con la pregunta
                  <ChevronRight className="w-5 h-5" />
                </motion.button>
              </>
            )}
          </motion.div>
        )}

        {/* PASO 4: Pregunta */}
        {step === 'question' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
            <div className="flex items-center gap-3 mb-2">
              <button
                onClick={() => setStep(mode === 'patient' ? 'context_config' : 'type_select')}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ChevronLeft className="w-5 h-5 text-gray-500" />
              </button>
              <div>
                <h2 className="text-lg font-semibold text-gray-700">
                  {mode === 'patient' ? 'Realiza tu consulta' : 'Consulta abierta'}
                </h2>
                {mode === 'patient' && selectedPatient && (
                  <p className="text-sm text-gray-400">
                    Paciente: <strong className="text-[#deb887]">{selectedPatient.first_name} {selectedPatient.last_name}</strong>
                    {enabledCount > 0 && ` · ${totalSelected} registros en contexto`}
                  </p>
                )}
              </div>
            </div>

            {/* Sugerencias */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-500 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-[#deb887]" />
                Sugerencias de preguntas
              </p>
              <div className="flex flex-wrap gap-2">
                {questionSuggestions.slice(0, mode === 'patient' ? 5 : 3).map(s => (
                  <button
                    key={s}
                    onClick={() => setQuestion(s)}
                    className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-[#deb887]/10 hover:text-[#9a7a50] rounded-lg transition-colors border border-gray-200 hover:border-[#deb887]/30 text-gray-600"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Tu pregunta</label>
              <textarea
                rows={5}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                placeholder={
                  mode === 'patient'
                    ? 'Ej: ¿Cuál es el mejor protocolo para continuar el tratamiento dado el historial del paciente?'
                    : 'Ej: ¿Cuál es la dosis recomendada de toxina botulínica para líneas frontales en pacientes mayores de 50 años?'
                }
                className="w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
                autoFocus
              />
            </div>

            {/* Opción de guardar */}
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div
                onClick={() => setSaveConsultation(p => !p)}
                className={`w-10 h-5 rounded-full transition-colors relative ${saveConsultation ? 'bg-[#deb887]' : 'bg-gray-200'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${saveConsultation ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-sm text-gray-600">Guardar en historial</span>
            </label>

            {error && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm flex gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <motion.button
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              onClick={runQuery}
              disabled={!question.trim() || loading}
              className="w-full py-3.5 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-xl font-medium flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Consultando IA...
                </>
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  Enviar consulta
                </>
              )}
            </motion.button>
          </motion.div>
        )}

        {/* PASO 5: Respuesta */}
        {step === 'response' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#deb887]/10 rounded-lg">
                  <Brain className="w-5 h-5 text-[#deb887]" />
                </div>
                <h2 className="text-lg font-semibold text-gray-700">Respuesta de la IA</h2>
              </div>
              <button
                onClick={() => { setStep('question'); setResponse(''); setError(null); }}
                className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Nueva consulta
              </button>
            </div>

            {/* Contexto usado */}
            {contextSummary && contextSummary !== 'Consulta abierta sin contexto de paciente específico.' && (
              <details className="bg-gray-50 border border-gray-200 rounded-xl overflow-hidden">
                <summary className="p-3 text-sm font-medium text-gray-600 cursor-pointer hover:bg-gray-100 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-400" />
                  Contexto clínico enviado
                </summary>
                <pre className="p-4 text-xs text-gray-500 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto border-t border-gray-200">
                  {contextSummary}
                </pre>
              </details>
            )}

            {/* Pregunta */}
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <p className="text-xs font-medium text-blue-500 mb-1 uppercase tracking-wide">Tu pregunta</p>
              <p className="text-gray-700 text-sm">{question}</p>
            </div>

            {/* Respuesta */}
            <div className="bg-white border border-[#deb887]/30 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
                <Sparkles className="w-4 h-4 text-[#deb887]" />
                <span className="text-sm font-semibold text-[#9a7a50]">Asistente Médico IA</span>
              </div>
              <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap leading-relaxed">
                {response}
              </div>
            </div>

            {/* Disclaimer */}
            <div className="flex gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>Esta respuesta es un apoyo al criterio clínico. El diagnóstico y tratamiento final es siempre responsabilidad del profesional médico.</p>
            </div>

            {/* Acciones */}
            <div className="flex gap-3">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setStep('question')}
                className="flex-1 py-2.5 border border-[#deb887] text-[#9a7a50] rounded-xl font-medium hover:bg-[#deb887]/5 transition-colors flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                Pregunta adicional
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  setStep('type_select');
                  setSelectedPatient(null);
                  setSelections({ ...EMPTY_SELECTIONS });
                  setQuestion('');
                  setResponse('');
                  setContextIndex(null);
                }}
                className="flex-1 py-2.5 bg-gradient-to-r from-[#deb887] to-[#d4a76a] text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Nueva consulta
              </motion.button>
            </div>
          </motion.div>
        )}
      </div>
    </AdminLayout>
  );
}
