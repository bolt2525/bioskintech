import React from 'react';
import { motion } from 'framer-motion';
import {
  Package, AlertTriangle, AlertCircle, CheckCircle,
  Droplet, Plus, Minus, MoreVertical, Edit2, Trash2,
  ThermometerSnowflake, Info
} from 'lucide-react';

interface InventoryItem {
  id: number;
  sku: string;
  name: string;
  brand?: string;
  category: string;
  group_name?: string;
  unit_of_measure: string;
  total_stock: number;
  total_initial?: number;
  batch_count?: number;
  preferred_display_unit?: 'absolute' | 'percentage';
  min_stock_level: number;
  next_expiry: string;
  requires_cold_chain: boolean;
  sanitary_registration?: string;
  description?: string;
  cost_price?: number | null;
  sale_price?: number | null;
}

interface Props {
  item: InventoryItem;
  onSelect: (item: InventoryItem) => void;
  onAddStock: (item: InventoryItem) => void;
  onConsume: (item: InventoryItem) => void;
  onEdit: (item: InventoryItem) => void;
  onDelete: (item: InventoryItem) => void;
  index?: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  Inyectable: 'bg-purple-100 text-purple-700 border-purple-200',
  Consumible: 'bg-blue-100 text-blue-700 border-blue-200',
  Venta: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Equipamiento: 'bg-gray-100 text-gray-700 border-gray-200',
};

export default function InventoryProductCard({
  item,
  onSelect,
  onAddStock,
  onConsume,
  onEdit,
  onDelete,
  index = 0,
}: Props) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const stock = Number(item.total_stock) || 0;
  const initial = Number(item.total_initial) || 0;
  const minStock = Number(item.min_stock_level) || 0;

  const isOutOfStock = stock === 0;
  const isLowStock = stock > 0 && stock <= minStock;

  const stockPercent = initial > 0 ? Math.min(100, Math.round((stock / initial) * 100)) : 100;

  const getStockBar = () => {
    if (isOutOfStock) return 'bg-red-500';
    if (isLowStock) return 'bg-yellow-400';
    if (stockPercent > 60) return 'bg-emerald-500';
    return 'bg-[#deb887]';
  };

  const getStatusBadge = () => {
    if (isOutOfStock)
      return { label: 'Agotado', icon: AlertCircle, cls: 'bg-red-50 text-red-700 border-red-200' };
    if (isLowStock)
      return { label: 'Bajo Stock', icon: AlertTriangle, cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' };
    return { label: 'Normal', icon: CheckCircle, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  };

  const getExpiryInfo = () => {
    if (!item.next_expiry) return null;
    if (item.next_expiry.startsWith('2099')) return null;
    const today = new Date();
    const expiry = new Date(item.next_expiry);
    const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return { label: 'Vencido', cls: 'text-red-600' };
    if (diffDays <= 30) return { label: `Vence en ${diffDays}d`, cls: 'text-orange-500' };
    if (diffDays <= 90) return { label: `Vence en ${diffDays}d`, cls: 'text-yellow-600' };
    return null;
  };

  const status = getStatusBadge();
  const StatusIcon = status.icon;
  const expiryInfo = getExpiryInfo();
  const categoryColor = CATEGORY_COLORS[item.category] || 'bg-gray-100 text-gray-600 border-gray-200';

  const displayUnit = item.preferred_display_unit === 'percentage' && initial > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.25, ease: 'easeOut' }}
      whileHover={{ y: -3, boxShadow: '0 12px 28px rgba(0,0,0,0.10)' }}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden cursor-pointer group"
      onClick={() => onSelect(item)}
    >
      {/* Card Header */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Category + cold chain */}
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${categoryColor}`}>
                {item.category}
              </span>
              {item.requires_cold_chain && (
                <span className="text-[10px] font-medium bg-sky-50 text-sky-600 border border-sky-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <ThermometerSnowflake className="w-2.5 h-2.5" />
                  Frío
                </span>
              )}
            </div>
            <h3 className="font-semibold text-gray-900 text-sm leading-snug truncate pr-1" title={item.name}>
              {item.name}
            </h3>
            {item.brand && (
              <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={item.brand}>
                Marca: {item.brand}
              </p>
            )}
            <p className="text-[11px] text-gray-500 font-mono mt-0.5">SKU: {item.sku || 'Sin SKU'}</p>
          </div>

          {/* Kebab menu */}
          <div className="relative flex-shrink-0" ref={menuRef}>
            <motion.button
              whileHover={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
              whileTap={{ scale: 0.9 }}
              onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
            >
              <MoreVertical className="w-4 h-4" />
            </motion.button>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -4 }}
                className="absolute right-0 top-8 z-30 bg-white rounded-xl shadow-xl border border-gray-100 min-w-[160px] py-1 overflow-hidden"
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onEdit(item); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Edit2 className="w-3.5 h-3.5 text-gray-400" />
                  Editar producto
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onSelect(item); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <Info className="w-3.5 h-3.5 text-gray-400" />
                  Ver detalle
                </button>
                <div className="h-px bg-gray-100 my-1" />
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(item); }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Eliminar
                </button>
              </motion.div>
            )}
          </div>
        </div>
      </div>

      {/* Stock level */}
      <div className="px-4 pb-3">
        <div className="flex items-end justify-between mb-1.5">
          <span className="text-xs text-gray-500">Stock actual</span>
          <div className="text-right">
            {displayUnit ? (
              <>
                <span className="text-xl font-bold text-gray-900">{stockPercent}%</span>
                <span className="text-xs text-gray-400 ml-1">({stock} {item.unit_of_measure})</span>
              </>
            ) : (
              <>
                <span className="text-xl font-bold text-gray-900">{stock}</span>
                <span className="text-xs text-gray-500 ml-1">{item.unit_of_measure}</span>
              </>
            )}
          </div>
        </div>
        {/* Progress bar */}
        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${getStockBar()}`}
            initial={{ width: 0 }}
            animate={{ width: `${displayUnit ? stockPercent : Math.min(100, (stock / Math.max(stock + 1, minStock * 3)) * 100)}%` }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: index * 0.04 }}
          />
        </div>

        {/* Status + expiry */}
        <div className="flex items-center justify-between mt-2">
          <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${status.cls}`}>
            <StatusIcon className="w-3 h-3" />
            {status.label}
          </span>
          {expiryInfo && (
            <span className={`text-[11px] font-medium ${expiryInfo.cls}`}>
              ⚠ {expiryInfo.label}
            </span>
          )}
          {item.batch_count !== undefined && Number(item.batch_count) > 0 && (
            <span className="text-[10px] text-gray-400">
              {item.batch_count} {Number(item.batch_count) === 1 ? 'lote' : 'lotes'}
            </span>
          )}
        </div>
      </div>

      {/* Precios — solo categoría Venta */}
      {item.category === 'Venta' && (item.sale_price || item.cost_price) && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            {item.cost_price ? (
              <span>Costo: <span className="font-semibold text-gray-700">${Number(item.cost_price).toFixed(2)}</span></span>
            ) : null}
            {item.cost_price && item.sale_price ? <span className="text-gray-300">|</span> : null}
            {item.sale_price ? (
              <span>Venta: <span className="font-semibold text-emerald-600">${Number(item.sale_price).toFixed(2)}</span></span>
            ) : null}
            {item.cost_price && item.sale_price && Number(item.cost_price) > 0 ? (
              <span className="ml-auto text-[10px] text-emerald-500 font-medium">
                {(((Number(item.sale_price) - Number(item.cost_price)) / Number(item.cost_price)) * 100).toFixed(0)}% margen
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-3 pb-3 pt-1 border-t border-gray-50 flex items-center gap-2">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={(e) => { e.stopPropagation(); onAddStock(item); }}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[#deb887]/10 text-[#b8905a] hover:bg-[#deb887]/20 transition-colors text-xs font-semibold"
          title="Agregar stock"
        >
          <Plus className="w-3.5 h-3.5" />
          Ingresar
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={(e) => { e.stopPropagation(); onConsume(item); }}
          disabled={isOutOfStock}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-colors text-xs font-semibold
            ${isOutOfStock
              ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          title={isOutOfStock ? 'Sin stock' : 'Registrar consumo'}
        >
          {item.category === 'Consumible'
            ? <Droplet className="w-3.5 h-3.5" />
            : <Minus className="w-3.5 h-3.5" />
          }
          Consumir
        </motion.button>
      </div>
    </motion.div>
  );
}
