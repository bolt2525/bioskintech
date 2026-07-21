import React, { useState, useEffect } from 'react';
import { X, Clock, User, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import recordsFetch from '../../../../utils/recordsFetch';

interface AuditEntry {
  id: number;
  patient_id: number;
  record_id?: number;
  clinic_user_id?: number;
  user_display_name: string;
  action_type: string;
  module: string;
  summary: string;
  field_changes?: any;
  created_at: string;
}

const MODULE_LABELS: Record<string, string> = {
  patient:       '👤 Paciente',
  consultation:  '🩺 Consulta',
  history:       '📋 Antecedentes',
  physical_exam: '🔍 Examen Físico',
  diagnosis:     '🧬 Diagnóstico',
  treatment:     '💊 Tratamiento',
  injectable:    '💉 Inyectable',
  prescription:  '📝 Receta',
  consent:       '📄 Consentimiento',
};

const ACTION_COLORS: Record<string, string> = {
  create:   'bg-emerald-100 text-emerald-700',
  tab_save: 'bg-blue-100 text-blue-700',
  update:   'bg-amber-100 text-amber-700',
  delete:   'bg-red-100 text-red-700',
};

interface Props {
  patientId: number;
  patientName: string;
  onClose: () => void;
}

export default function PatientAuditModal({ patientId, patientName, onClose }: Props) {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    recordsFetch(`/api/records?action=listAuditLog&patient_id=${patientId}&limit=100`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setLogs(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [patientId]);

  const formatDate = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleString('es-EC', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
      >
        <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#deb887]" />
              Historial de cambios
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">{patientName}</p>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex justify-center py-12 text-gray-400">
              <div className="w-6 h-6 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Clock className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p className="text-sm">Sin historial de cambios registrado</p>
            </div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-100" />
              <div className="space-y-3 pl-10">
                {logs.map(log => (
                  <div key={log.id} className="relative">
                    {/* Timeline dot */}
                    <div className="absolute -left-[26px] w-3 h-3 rounded-full bg-[#deb887] border-2 border-white shadow-sm top-2" />

                    <div className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                      <div
                        className="flex items-start gap-3 p-3 cursor-pointer select-none"
                        onClick={() => setExpandedId(p => p === log.id ? null : log.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${ACTION_COLORS[log.action_type] || 'bg-gray-100 text-gray-600'}`}>
                              {log.action_type === 'create' ? 'Creó' : log.action_type === 'tab_save' ? 'Guardó' : 'Actualizó'}
                            </span>
                            <span className="text-xs font-medium text-gray-700">{MODULE_LABELS[log.module] || log.module}</span>
                          </div>
                          <p className="text-sm text-gray-800 mt-1">{log.summary}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                            <span className="flex items-center gap-1">
                              <User className="w-3 h-3" />
                              {log.user_display_name}
                            </span>
                            <span>{formatDate(log.created_at)}</span>
                          </div>
                        </div>
                        {log.field_changes && (
                          <button className="text-gray-300 shrink-0 mt-0.5">
                            {expandedId === log.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        )}
                      </div>

                      {/* Field changes detail */}
                      <AnimatePresence>
                        {expandedId === log.id && log.field_changes && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="border-t border-gray-100 overflow-hidden"
                          >
                            <div className="p-3 bg-white">
                              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-2">Detalle de cambios</p>
                              <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono bg-gray-50 rounded-lg p-2">
                                {JSON.stringify(log.field_changes, null, 2)}
                              </pre>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 text-right">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border rounded-lg hover:bg-gray-100 transition-colors">
            Cerrar
          </button>
        </div>
      </motion.div>
    </div>
  );
}
