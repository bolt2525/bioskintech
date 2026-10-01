import React from 'react';
import { motion } from 'framer-motion';
import { Package, AlertTriangle, AlertCircle, TrendingUp } from 'lucide-react';

interface Stats {
  total_items: number;
  out_of_stock_count: number;
  low_stock_count: number;
  expiring_soon_count: number;
  expired_count: number;
  movements_this_month: number;
  stock_value: string | number;
  archived_stock_value: string | number;
  archived_items_count: string | number;
  archived_units_without_cost: string | number;
  potential_margin: string | number;
  units_without_cost: string | number;
  units_without_sale_price: string | number;
}

interface Props {
  stats: Stats | null;
  loading?: boolean;
  onSelectMetric: (metric: 'products' | 'lowStock' | 'batches' | 'movements') => void;
}

const KPI_CARDS = [
  {
    key: 'total_items' as const,
    action: 'products' as const,
    label: 'Total Productos',
    icon: Package,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    format: (v: number) => v,
    sub: null,
  },
  {
    key: 'low_stock_count' as const,
    action: 'lowStock' as const,
    label: 'Bajo Stock',
    icon: AlertTriangle,
    iconBg: 'bg-yellow-100',
    iconColor: 'text-yellow-600',
    format: (v: number) => v,
    subKey: 'out_of_stock_count' as const,
    subLabel: 'agotados',
    subColor: 'text-red-500',
  },
  {
    key: 'expiring_soon_count' as const,
    action: 'batches' as const,
    label: 'Lotes por Vencer',
    icon: AlertCircle,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-600',
    format: (v: number) => v,
    subKey: 'expired_count' as const,
    subLabel: 'vencidos',
    subColor: 'text-red-600',
  },
  {
    key: 'movements_this_month' as const,
    action: 'movements' as const,
    label: 'Movimientos Este Mes',
    icon: TrendingUp,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    format: (v: number) => v,
    sub: null,
  },
];

export default function InventoryOverview({ stats, loading, onSelectMetric }: Props) {
  const money = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
  return (
    <section className="overflow-hidden rounded-2xl border border-white/70 bg-white shadow-xl shadow-black/10" aria-label="Estado general del inventario">
      <div className="grid grid-cols-2 gap-px bg-gray-100 lg:grid-cols-4">
        {KPI_CARDS.map((card, i) => {
        const value = stats ? stats[card.key] : 0;
        const subValue = stats && 'subKey' in card ? stats[card.subKey as keyof Stats] : null;

        return (
          <motion.button
            type="button"
            key={card.key}
            onClick={() => onSelectMetric(card.action)}
            aria-label={`${card.label}: ${loading ? 'cargando' : card.format(value)}. Abrir detalle`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="admin-focus-ring group flex min-h-24 items-center gap-3 bg-white p-4 text-left transition-colors hover:bg-amber-50/60"
          >
            <div className={`p-2.5 rounded-xl ${card.iconBg} flex-shrink-0 transition-transform group-hover:scale-105`}>
              <card.icon className={`w-5 h-5 ${card.iconColor}`} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium truncate">{card.label}</p>
              {loading ? (
                <div className="mt-1 h-7 w-12 bg-gray-100 rounded-lg animate-pulse" />
              ) : (
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-bold tabular-nums text-gray-900">{card.format(value)}</span>
                  {subValue !== null && subValue !== undefined && (subValue as number) > 0 && (
                    <span className={`text-xs font-semibold ${'subColor' in card ? card.subColor : ''}`}>
                      {subValue} {'subLabel' in card ? card.subLabel : ''}
                    </span>
                  )}
                </div>
              )}
              <span className="mt-1 block text-[10px] font-medium text-gray-400 group-hover:text-amber-800">Abrir detalle →</span>
            </div>
          </motion.button>
        );
        })}
      </div>
      <div className="grid grid-cols-1 border-t border-gray-200 bg-gray-50 sm:grid-cols-2">
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-gray-500">Valor del stock vigente</p>
          <p className="text-lg font-semibold tabular-nums text-gray-900">{loading ? '—' : money.format(Number(stats?.stock_value || 0))}</p>
          {!loading && Number(stats?.units_without_cost || 0) > 0 && (
            <p className="text-xs text-amber-700">{stats?.units_without_cost} unidades con costo pendiente o $0; valor parcial</p>
          )}
          {!loading && Number(stats?.archived_items_count || 0) > 0 && (
            <p className="mt-1 border-t border-gray-200 pt-1 text-xs text-gray-700">
              Existencias archivadas: {money.format(Number(stats?.archived_stock_value || 0))} · fuera del disponible
              {Number(stats?.archived_units_without_cost || 0) > 0 && <span className="block text-amber-800">{stats?.archived_units_without_cost} unidades archivadas sin costo confirmado</span>}
            </p>
          )}
        </div>
        <div className="border-t border-gray-200 px-5 py-4 sm:border-l sm:border-t-0">
          <p className="text-xs font-medium text-gray-500">Margen potencial · Venta</p>
          <p className="text-lg font-semibold tabular-nums text-gray-900">{loading ? '—' : money.format(Number(stats?.potential_margin || 0))}</p>
          <p className="text-xs text-gray-500">Estimación del stock, no ingresos realizados</p>
          {!loading && Number(stats?.units_without_sale_price || 0) > 0 && (
            <p className="text-xs text-amber-700">{stats?.units_without_sale_price} unidades de Venta sin precio; margen parcial</p>
          )}
        </div>
      </div>
    </section>
  );
}
