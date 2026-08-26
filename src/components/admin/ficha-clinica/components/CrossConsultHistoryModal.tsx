/**
 * Modal reutilizable que muestra todos los ítems de un tab agrupados por consulta.
 * Cada tab provee renderItem (fila) y renderDetail (vista read-only).
 */
import { useState } from 'react';
import { X, History, ChevronDown, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export interface ConsultationRef {
  id: number;
  reason: string;
  current_illness?: string;
  created_at: string;
}

interface CrossConsultHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  tabLabel: string;
  consultations: ConsultationRef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[];
  currentConsultationId?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderItem: (item: any) => React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderDetail: (item: any) => React.ReactNode;
}

export default function CrossConsultHistoryModal({
  isOpen, onClose, tabLabel, consultations, items,
  currentConsultationId, renderItem, renderDetail,
}: CrossConsultHistoryModalProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedConsults, setExpandedConsults] = useState<Set<number | null>>(new Set());

  if (!isOpen) return null;

  // Group items by consultation_id — coerce to number to handle string/number mismatch from DB
  const grouped: Array<{ consult: ConsultationRef | null; items: typeof items }> = [];

  const knownIds = new Set(consultations.map(c => Number(c.id)));

  for (const consult of consultations) {
    const consultItems = items.filter(i => Number(i.consultation_id) === Number(consult.id));
    if (consultItems.length > 0) grouped.push({ consult, items: consultItems });
  }
  // Items without consultation_id
  const ungrouped = items.filter(i => !i.consultation_id);
  if (ungrouped.length > 0) grouped.push({ consult: null, items: ungrouped });
  // Orphaned: has a consultation_id but it doesn't exist in current record's consultations
  const orphaned = items.filter(i => i.consultation_id && !knownIds.has(Number(i.consultation_id)));
  if (orphaned.length > 0) grouped.push({ consult: null, items: orphaned });

  const selectedItem = selectedId != null ? items.find(i => i.id === selectedId) : null;

  const toggleConsult = (id: number | null) => {
    setExpandedConsults(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatDate = (d: string) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-[60]"
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
          className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[82vh] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-4 border-b">
            <History className="w-4 h-4 text-[#b8944d]" />
            <h3 className="font-semibold text-gray-900 flex-1 text-sm">
              Historial completo — <span className="text-[#b8944d]">{tabLabel}</span>
            </h3>
            <span className="text-xs text-gray-400">{items.length} registro{items.length !== 1 ? 's' : ''}</span>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg ml-1">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          {/* Body */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Left: grouped list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {grouped.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">No hay registros históricos.</p>
              )}
              {grouped.map(({ consult, items: gItems }, idx) => {
                const key = consult?.id ?? null;
                const isCurrent = consult?.id === currentConsultationId;
                const expanded = expandedConsults.has(key);
                return (
                  <div key={idx} className="border rounded-xl overflow-hidden">
                    {/* Consultation header */}
                    <button
                      onClick={() => toggleConsult(key)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                        isCurrent ? 'bg-[#deb887]/10' : 'bg-gray-50 hover:bg-gray-100'
                      }`}
                    >
                      {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-700 truncate">
                          {consult ? (consult.reason || 'Sin motivo') : 'Sin consulta asignada'}
                          {isCurrent && <span className="ml-2 text-[10px] text-[#b8944d] font-medium">(actual)</span>}
                        </p>
                        {consult?.created_at && (
                          <p className="text-[10px] text-gray-400 mt-0.5">{formatDate(consult.created_at)}</p>
                        )}
                      </div>
                      <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5 shrink-0">{gItems.length}</span>
                    </button>

                    {/* Items list */}
                    {expanded && (
                      <div className="divide-y">
                        {gItems.map(item => (
                          <button
                            key={item.id}
                            onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}
                            className={`w-full px-4 py-3 text-left transition-colors ${
                              selectedId === item.id
                                ? 'bg-[#deb887]/15 border-l-2 border-[#b8944d]'
                                : 'hover:bg-gray-50'
                            }`}
                          >
                            <div className="text-xs text-gray-700">{renderItem(item)}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Right: detail panel */}
            <AnimatePresence>
              {selectedItem && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }} animate={{ width: 288, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
                  className="border-l overflow-y-auto bg-gray-50/50 flex-shrink-0"
                  style={{ minWidth: 0 }}
                >
                  <div className="p-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Detalle</p>
                    <div className="text-xs space-y-2 text-gray-700">{renderDetail(selectedItem)}</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
