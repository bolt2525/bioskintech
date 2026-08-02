import React, { useState, useEffect } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Save, Check, Plus, Trash2, MessageSquare, Calendar, Edit3, AlertCircle } from 'lucide-react';
import { Tooltip } from '../../../../ui/Tooltip';

interface Consultation {
  id: number;
  record_id: number;
  reason: string;
  current_illness: string;
  enable_injectables: boolean;
  enable_consents: boolean;
  created_at: string;
  updated_at: string;
}

interface ConsultationTabProps {
  recordId: number;
  consultations: Consultation[];
  activeConsultation: Consultation | null;
  onSelectConsultation: (c: Consultation | null) => void;
  onConsultationCreated: (c: Consultation) => void;
  onSave: () => void;
  initialData?: any;
  historyData?: any[];
}

const EMPTY_FORM = { reason: '', current_illness: '' };

export default function ConsultationTab({
  recordId, consultations, activeConsultation, onSelectConsultation, onConsultationCreated, onSave,
}: ConsultationTabProps) {
  const [mode, setMode] = useState<'list' | 'new' | 'edit'>('list');
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  useEffect(() => {
    if (message) {
      const t = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [message]);

  useEffect(() => {
    if (mode === 'edit' && activeConsultation) {
      setFormData({ reason: activeConsultation.reason || '', current_illness: activeConsultation.current_illness || '' });
    }
    if (mode === 'new') setFormData(EMPTY_FORM);
  }, [mode, activeConsultation]);

  const handleSaveNew = async () => {
    if (!formData.reason.trim()) { setMessage({ type: 'error', text: 'El motivo de consulta es requerido' }); return; }
    setSaving(true);
    try {
      const r = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'createConsultation', record_id: recordId, ...formData }),
      });
      if (!r.ok) throw new Error();
      const created: Consultation = await r.json();
      setMessage({ type: 'success', text: 'Consulta registrada correctamente' });
      setMode('list');
      onSave();
      onConsultationCreated(created);
    } catch { setMessage({ type: 'error', text: 'Error al guardar la consulta' }); }
    finally { setSaving(false); }
  };

  const handleSaveEdit = async () => {
    if (!activeConsultation) return;
    if (!formData.reason.trim()) { setMessage({ type: 'error', text: 'El motivo es requerido' }); return; }
    setSaving(true);
    try {
      const r = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateConsultation', id: activeConsultation.id, ...formData }),
      });
      if (!r.ok) throw new Error();
      const updated: Consultation = await r.json();
      setMessage({ type: 'success', text: 'Consulta actualizada' });
      setMode('list');
      onSave();
      onSelectConsultation(updated);
    } catch { setMessage({ type: 'error', text: 'Error al actualizar' }); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminar esta consulta? Los registros vinculados perderan la asociacion.')) return;
    setDeleting(id);
    try {
      await recordsFetch('/api/records?action=deleteConsultation&id=' + id, { method: 'DELETE' });
      onSave();
      if (activeConsultation?.id === id) onSelectConsultation(null);
      setMessage({ type: 'success', text: 'Consulta eliminada' });
    } catch { setMessage({ type: 'error', text: 'Error al eliminar' }); }
    finally { setDeleting(null); }
  };

  const isFormMode = mode === 'new' || mode === 'edit';

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col md:flex-row gap-6">
      {/* Sidebar: Lista de consultas */}
      <div className="w-full md:w-1/3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-800 border-l-4 border-[#deb887] pl-3">Historial de Consultas</h3>
          <span className="text-xs text-gray-400">{consultations.length} sesi{consultations.length !== 1 ? 'ones' : 'on'}</span>
        </div>

        <button onClick={() => setMode('new')}
          className={`w-full p-3.5 rounded-xl border-2 border-dashed text-left transition-all flex items-center gap-3 ${
            mode === 'new' ? 'border-[#deb887] bg-amber-50/70 text-[#b8944d]' : 'border-gray-200 text-gray-500 hover:border-[#deb887]/50 hover:bg-amber-50/30'
          }`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${mode === 'new' ? 'bg-[#deb887]/20' : 'bg-gray-100'}`}>
            <Plus className="w-4 h-4" />
          </div>
          <span className="text-sm font-semibold">Nueva Consulta</span>
        </button>

        <div className="flex-1 overflow-y-auto space-y-2 max-h-[520px] pr-1">
          {consultations.length === 0 && mode !== 'new' && (
            <div className="text-center py-10 text-gray-400 bg-gray-50/50 rounded-xl border border-dashed border-gray-200">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Sin consultas registradas</p>
            </div>
          )}
          {consultations.map(c => {
            const isActive = activeConsultation?.id === c.id;
            return (
              <motion.div key={c.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                onClick={() => { onSelectConsultation(c); setMode('list'); }}
                className={`p-3.5 rounded-xl cursor-pointer border transition-all hover:shadow-sm group relative ${
                  isActive ? 'bg-amber-50 border-[#deb887] ring-1 ring-[#deb887]/50' : 'bg-white border-gray-100 hover:border-[#deb887]/30'
                }`}>
                <div className="flex justify-between items-start mb-1">
                  <div className="flex items-center gap-1.5">
                    <Calendar className={`w-3.5 h-3.5 ${isActive ? 'text-[#b8944d]' : 'text-gray-400'}`} />
                    <span className={`text-xs font-bold ${isActive ? 'text-[#b8944d]' : 'text-gray-500'}`}>
                      {new Date(c.created_at).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                  </div>
                  {isActive && <Check className="w-3.5 h-3.5 text-[#b8944d]" />}
                </div>
                <p className={`text-sm line-clamp-2 ${isActive ? 'text-gray-800 font-medium' : 'text-gray-600'}`}>
                  {c.reason || <span className="italic text-gray-400">Sin motivo</span>}
                </p>
                {(c.enable_injectables || c.enable_consents) && (
                  <div className="flex gap-1 mt-1.5">
                    {c.enable_injectables && <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded">Inyect.</span>}
                    {c.enable_consents && <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">Consent.</span>}
                  </div>
                )}
                <button onClick={e => { e.stopPropagation(); handleDelete(c.id); }} disabled={deleting === c.id}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-400 transition-all rounded">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Panel principal */}
      <div className="w-full md:w-2/3 flex flex-col gap-4">
        <AnimatePresence>
          {message && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium ${
                message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
              {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {message.text}
            </motion.div>
          )}
        </AnimatePresence>

        {isFormMode && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-xl border border-[#deb887]/40 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-amber-50 to-white border-b border-[#deb887]/20">
              <h4 className="text-sm font-bold text-gray-800">{mode === 'new' ? 'Nueva Consulta' : 'Editar Consulta'}</h4>
              <div className="flex gap-2">
                <button onClick={() => setMode('list')} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">Cancelar</button>
                <button onClick={mode === 'new' ? handleSaveNew : handleSaveEdit} disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-lg transition-colors disabled:opacity-50">
                  {saving ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  {mode === 'new' ? 'Registrar' : 'Actualizar'}
                </button>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Motivo de Consulta <span className="text-red-400">*</span></label>
                <input type="text" value={formData.reason} onChange={e => setFormData(p => ({ ...p, reason: e.target.value }))}
                  placeholder="Ej: Control post-tratamiento, consulta estetica..." autoFocus
                  className="w-full px-4 py-2.5 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887]" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Historia de la Enfermedad Actual</label>
                <textarea value={formData.current_illness} onChange={e => setFormData(p => ({ ...p, current_illness: e.target.value }))}
                  rows={7} placeholder="Descripcion detallada, evolucion, sintomas..."
                  className="w-full px-4 py-2.5 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] resize-none" />
              </div>
            </div>
          </motion.div>
        )}

        {!isFormMode && activeConsultation && (
          <motion.div key={activeConsultation.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-xl border border-[#deb887]/40 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-amber-50 to-white border-b border-[#deb887]/20">
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Consulta Activa</p>
                <p className="text-sm font-bold text-gray-800 mt-0.5">
                  {new Date(activeConsultation.created_at).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              <Tooltip content="Editar esta consulta">
                <button onClick={() => setMode('edit')}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-[#b8944d] hover:bg-amber-50 rounded-lg border border-gray-200 hover:border-[#deb887]/40 transition-colors">
                  <Edit3 className="w-3.5 h-3.5" /> Editar
                </button>
              </Tooltip>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Motivo de Consulta</p>
                <p className="text-sm text-gray-800 leading-relaxed bg-gray-50 rounded-xl p-4 border border-gray-100">
                  {activeConsultation.reason || <em className="text-gray-400">No especificado</em>}
                </p>
              </div>
              {activeConsultation.current_illness && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Historia de la Enfermedad Actual</p>
                  <p className="text-sm text-gray-700 leading-relaxed bg-gray-50 rounded-xl p-4 border border-gray-100 whitespace-pre-wrap">
                    {activeConsultation.current_illness}
                  </p>
                </div>
              )}
              {(activeConsultation.enable_injectables || activeConsultation.enable_consents) && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-gray-400">Tabs habilitados:</span>
                  {activeConsultation.enable_injectables && <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-full font-medium">Inyectables</span>}
                  {activeConsultation.enable_consents && <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-full font-medium">Consentimientos</span>}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {!isFormMode && !activeConsultation && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mb-4">
              <MessageSquare className="w-8 h-8 text-[#deb887]" />
            </div>
            <h4 className="text-base font-bold text-gray-700 mb-2">Selecciona o crea una consulta</h4>
            <p className="text-sm text-gray-400 max-w-xs mb-5">La consulta activa habilita los demas tabs (Examen Fisico, Diagnostico, Tratamientos, Recetas).</p>
            <button onClick={() => setMode('new')}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-xl transition-colors">
              <Plus className="w-4 h-4" /> Nueva Consulta
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}