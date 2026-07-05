import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { format, differenceInDays } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  X, Package, Edit2, Plus, Minus, Trash2, Calendar, Activity,
  ThermometerSnowflake, AlertTriangle, CheckCircle, AlertCircle,
  Tag, Layers, Droplet, RefreshCw
} from 'lucide-react';

interface Batch {
  id: number;
  batch_number: string;
  expiration_date: string;
  quantity_current: number;
  quantity_initial: number;
  unit_of_measure?: string;
  status: string;
}

interface Movement {
  id: number;
  movement_type: string;
  quantity_change: number;
  reason: string;
  user_id: string;
  created_at: string;
  batch_number?: string;
}

interface InventoryItem {
  id: number;
  sku: string;
  name: string;
  category: string;
  group_name?: string;
  unit_of_measure: string;
  total_stock: number;
  min_stock_level: number;
  next_expiry: string;
  requires_cold_chain: boolean;
  sanitary_registration?: string;
  description?: string;
}

interface Props {
  item: InventoryItem | null;
  onClose: () => void;
  onEdit: (item: InventoryItem) => void;
  onAddStock: (item: InventoryItem) => void;
  onConsume: (item: InventoryItem) => void;
  onDelete: (item: InventoryItem) => void;
}

export default function InventoryProductDrawer({ item, onClose, onEdit, onAddStock, onConsume, onDelete }: Props) {
  const [detail, setDetail] = useState<{ batches: Batch[]; movements: Movement[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<'batches' | 'movements'>('batches');

  const formatSafeDate = (value: string, pattern: string) => {
    if (!value) return '-';
    const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) return '-';
    return format(parsed, pattern, { locale: es });
  };

  useEffect(() => {
    if (!item) return;
    setDetail(null);
    setLoading(true);
    fetch(`/api/records?action=inventoryGetItem&id=${item.id}`)
      .then(r => r.json())
      .then(data => {
        setDetail({ batches: data.batches || [], movements: data.movements || [] });
      })
      .catch(() => setDetail({ batches: [], movements: [] }))
      .finally(() => setLoading(false));
  }, [item?.id]);

  const getExpiryStatus = (date: string) => {
    if (!date || date.startsWith('2099')) return { label: 'Sin Vencimiento', cls: 'bg-blue-50 text-blue-700', Icon: CheckCircle };
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return { label: 'Fecha inválida', cls: 'bg-gray-100 text-gray-500', Icon: AlertCircle };
    const days = differenceInDays(parsed, new Date());
    if (days < 0) return { label: 'Vencido', cls: 'bg-red-100 text-red-700', Icon: AlertCircle };
    if (days <= 30) return { label: `Vence en ${days}d`, cls: 'bg-orange-100 text-orange-700', Icon: AlertTriangle };
    if (days <= 90) return { label: `${days}d restantes`, cls: 'bg-yellow-100 text-yellow-700', Icon: AlertTriangle };
    return { label: 'Vigente', cls: 'bg-green-100 text-green-700', Icon: CheckCircle };
  };

  const getMovementColor = (type: string, qty: number) => {
    if (qty > 0) return 'text-emerald-600 bg-emerald-50';
    return 'text-red-500 bg-red-50';
  };

  return (
    <AnimatePresence>
      {item && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40"
          />

          {/* Drawer panel */}
          <motion.div
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 35 }}
            className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-gray-100 bg-gradient-to-r from-[#deb887]/10 to-white">
              <div className="flex-1 min-w-0 pr-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold bg-[#deb887]/20 text-[#8a6530] px-2 py-0.5 rounded-full">
                    {item.category}
                  </span>
                  {item.requires_cold_chain && (
                    <span className="text-xs font-medium bg-sky-50 text-sky-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                      <ThermometerSnowflake className="w-3 h-3" /> Frío
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-bold text-gray-900 leading-snug">{item.name}</h2>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{item.sku || 'Sin SKU'}</p>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Info chips */}
            <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-gray-100">
              {item.description && (
                <p className="text-xs text-gray-500 w-full">{item.description}</p>
              )}
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
                <Tag className="w-3 h-3 text-gray-400" />
                {item.unit_of_measure}
              </div>
              {item.group_name && (
                <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
                  <Layers className="w-3 h-3 text-gray-400" />
                  {item.group_name}
                </div>
              )}
              {item.sanitary_registration && (
                <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
                  <Package className="w-3 h-3 text-gray-400" />
                  {item.sanitary_registration}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 px-2.5 py-1.5 rounded-lg border border-gray-100">
                <AlertTriangle className="w-3 h-3 text-yellow-500" />
                Mín. {item.min_stock_level} {item.unit_of_measure}
              </div>
            </div>

            {/* Stock summary */}
            <div className="px-5 py-4 bg-gray-50/60 border-b border-gray-100">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500 mb-0.5">Stock total</p>
                  <p className="text-3xl font-bold text-gray-900">
                    {Number(item.total_stock) || 0}
                    <span className="text-sm font-normal text-gray-400 ml-1">{item.unit_of_measure}</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <motion.button
                    whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                    onClick={() => onAddStock(item)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[#deb887] text-white rounded-xl text-sm font-semibold shadow-sm shadow-[#deb887]/30 hover:bg-[#c5a075] transition-colors"
                  >
                    <Plus className="w-4 h-4" /> Ingresar
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
                    onClick={() => onConsume(item)}
                    disabled={Number(item.total_stock) === 0}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      Number(item.total_stock) === 0
                        ? 'bg-gray-100 text-gray-300 cursor-not-allowed'
                        : 'bg-gray-800 text-white hover:bg-gray-700 shadow-sm'
                    }`}
                  >
                    {item.category === 'Consumible' ? <Droplet className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                    Consumir
                  </motion.button>
                </div>
              </div>
            </div>

            {/* Sub-tabs: Batches | Movements */}
            <div className="flex border-b border-gray-100">
              {(['batches', 'movements'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveSection(tab)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-sm font-medium transition-all border-b-2 ${
                    activeSection === tab
                      ? 'border-[#deb887] text-[#8a6530]'
                      : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {tab === 'batches' ? <Calendar className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                  {tab === 'batches' ? 'Lotes Activos' : 'Movimientos'}
                  {tab === 'batches' && detail && (
                    <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded-full">
                      {detail.batches.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loading && (
                <div className="flex justify-center py-10">
                  <RefreshCw className="w-5 h-5 animate-spin text-[#deb887]" />
                </div>
              )}

              {!loading && activeSection === 'batches' && (
                <>
                  {detail?.batches.length === 0 && (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      No hay lotes activos
                    </div>
                  )}
                  {detail?.batches.map((batch) => {
                    const exp = getExpiryStatus(batch.expiration_date);
                    const ExpIcon = exp.Icon;
                    const pct = batch.quantity_initial > 0
                      ? Math.round((batch.quantity_current / batch.quantity_initial) * 100)
                      : 100;
                    return (
                      <motion.div
                        key={batch.id}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="bg-gray-50 rounded-xl border border-gray-100 p-3"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <span className="text-xs font-mono text-gray-700 bg-white px-2 py-0.5 rounded border border-gray-200">
                              {batch.batch_number}
                            </span>
                          </div>
                          <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${exp.cls}`}>
                            <ExpIcon className="w-3 h-3" />
                            {exp.label}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-gray-600 mb-1.5">
                          <span>{batch.quantity_current} / {batch.quantity_initial} {item.unit_of_measure}</span>
                          <span>{pct}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${pct > 50 ? 'bg-emerald-500' : pct > 20 ? 'bg-yellow-400' : 'bg-red-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {!batch.expiration_date.startsWith('2099') && (
                          <p className="text-[10px] text-gray-400 mt-1.5">
                            Vence: {formatSafeDate(batch.expiration_date, 'dd MMM yyyy')}
                          </p>
                        )}
                      </motion.div>
                    );
                  })}
                </>
              )}

              {!loading && activeSection === 'movements' && (
                <>
                  {detail?.movements.length === 0 && (
                    <div className="text-center py-8 text-gray-400 text-sm">
                      Sin movimientos registrados
                    </div>
                  )}
                  {detail?.movements.map((mov) => {
                    const isIn = mov.quantity_change > 0;
                    return (
                      <motion.div
                        key={mov.id}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0"
                      >
                        <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${getMovementColor(mov.movement_type, mov.quantity_change)}`}>
                          {isIn ? '+' : '−'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm font-semibold ${isIn ? 'text-emerald-700' : 'text-red-600'}`}>
                              {isIn ? '+' : ''}{mov.quantity_change} {item.unit_of_measure}
                            </span>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">
                              {formatSafeDate(mov.created_at, 'dd MMM HH:mm')}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 truncate">{mov.reason || mov.movement_type}</p>
                          {mov.user_id && (
                            <p className="text-[10px] text-gray-400">{mov.user_id}</p>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Footer actions */}
            <div className="p-4 border-t border-gray-100 flex items-center gap-2 bg-white">
              <motion.button
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                onClick={() => onEdit(item)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors text-sm font-medium"
              >
                <Edit2 className="w-4 h-4" />
                Editar
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                onClick={() => onDelete(item)}
                className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 text-red-600 hover:bg-red-100 transition-colors text-sm font-medium"
              >
                <Trash2 className="w-4 h-4" />
              </motion.button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
