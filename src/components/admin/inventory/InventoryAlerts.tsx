import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, AlertCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface AlertBatch {
  id: number;
  batch_number: string;
  expiration_date: string;
  quantity_current: number;
  item_name: string;
  sku: string;
  unit_of_measure: string;
  alert_type: 'expired' | 'expiring_soon';
}

interface Props {
  alertBatches: AlertBatch[];
  outOfStockCount: number;
  lowStockCount: number;
  onFilterCategory?: (filter: string) => void;
}

export default function InventoryAlerts({ alertBatches, outOfStockCount, lowStockCount, onFilterCategory }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const expiredBatches = alertBatches.filter(b => b.alert_type === 'expired');
  const expiringSoon = alertBatches.filter(b => b.alert_type === 'expiring_soon');

  const totalAlerts = expiredBatches.length + expiringSoon.length + outOfStockCount + lowStockCount;

  if (dismissed || totalAlerts === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="rounded-2xl border border-orange-200 bg-orange-50/80 overflow-hidden shadow-sm"
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-orange-100/40 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-600 flex-shrink-0" />
          <span className="text-sm font-semibold text-orange-800">
            {totalAlerts} alerta{totalAlerts !== 1 ? 's' : ''} pendiente{totalAlerts !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-1.5 ml-1 flex-wrap">
            {expiredBatches.length > 0 && (
              <span className="text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full">
                {expiredBatches.length} vencido{expiredBatches.length !== 1 ? 's' : ''}
              </span>
            )}
            {expiringSoon.length > 0 && (
              <span className="text-[10px] font-semibold bg-orange-100 text-orange-700 border border-orange-200 px-2 py-0.5 rounded-full">
                {expiringSoon.length} por vencer
              </span>
            )}
            {outOfStockCount > 0 && (
              <span className="text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full">
                {outOfStockCount} agotado{outOfStockCount !== 1 ? 's' : ''}
              </span>
            )}
            {lowStockCount > 0 && (
              <span className="text-[10px] font-semibold bg-yellow-100 text-yellow-700 border border-yellow-200 px-2 py-0.5 rounded-full">
                {lowStockCount} bajo stock
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
            className="p-1 rounded-lg text-orange-400 hover:text-orange-700 hover:bg-orange-100 transition-colors"
            title="Cerrar alertas"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-orange-500" />
            : <ChevronDown className="w-4 h-4 text-orange-500" />
          }
        </div>
      </div>

      {/* Expandable content */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 space-y-2 max-h-64 overflow-y-auto">
              {/* Expired batches */}
              {expiredBatches.map(b => (
                <motion.div
                  key={`exp-${b.id}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-3 bg-white rounded-xl px-3 py-2.5 border border-red-100 shadow-sm"
                >
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{b.item_name}</p>
                    <p className="text-[11px] text-red-600">
                      Lote {b.batch_number} — vencido el {format(new Date(b.expiration_date), 'dd MMM yyyy', { locale: es })}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-gray-500 flex-shrink-0">
                    {b.quantity_current} {b.unit_of_measure}
                  </span>
                </motion.div>
              ))}

              {/* Expiring soon batches */}
              {expiringSoon.map(b => {
                const days = Math.ceil((new Date(b.expiration_date).getTime() - Date.now()) / 86400000);
                return (
                  <motion.div
                    key={`soon-${b.id}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-3 bg-white rounded-xl px-3 py-2.5 border border-orange-100 shadow-sm"
                  >
                    <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{b.item_name}</p>
                      <p className="text-[11px] text-orange-600">
                        Lote {b.batch_number} — vence en {days} día{days !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-gray-500 flex-shrink-0">
                      {b.quantity_current} {b.unit_of_measure}
                    </span>
                  </motion.div>
                );
              })}

              {/* Summary of out of stock */}
              {outOfStockCount > 0 && (
                <div className="flex items-center gap-3 bg-white rounded-xl px-3 py-2.5 border border-red-100 shadow-sm">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <p className="text-sm text-red-700 font-medium">
                    {outOfStockCount} producto{outOfStockCount !== 1 ? 's' : ''} sin stock disponible
                  </p>
                </div>
              )}

              {/* Summary of low stock */}
              {lowStockCount > 0 && (
                <div className="flex items-center gap-3 bg-white rounded-xl px-3 py-2.5 border border-yellow-100 shadow-sm">
                  <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                  <p className="text-sm text-yellow-700 font-medium">
                    {lowStockCount} producto{lowStockCount !== 1 ? 's' : ''} con nivel bajo de stock
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
