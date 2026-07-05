import React from 'react';
import { motion } from 'framer-motion';
import { Package, AlertTriangle, RefreshCw, AlertCircle, TrendingUp } from 'lucide-react';

interface Stats {
  total_items: number;
  out_of_stock_count: number;
  low_stock_count: number;
  expiring_soon_count: number;
  expired_count: number;
  movements_this_month: number;
}

interface Props {
  stats: Stats | null;
  loading?: boolean;
}

const KPI_CARDS = [
  {
    key: 'total_items' as const,
    label: 'Total Productos',
    icon: Package,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    format: (v: number) => v,
    sub: null,
  },
  {
    key: 'low_stock_count' as const,
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
    label: 'Movimientos (Mes)',
    icon: TrendingUp,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    format: (v: number) => v,
    sub: null,
  },
];

export default function InventoryOverview({ stats, loading }: Props) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {KPI_CARDS.map((card, i) => {
        const value = stats ? stats[card.key] : 0;
        const subValue = stats && 'subKey' in card ? stats[card.subKey as keyof Stats] : null;

        return (
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-3"
          >
            <div className={`p-2.5 rounded-xl ${card.iconBg} flex-shrink-0`}>
              <card.icon className={`w-5 h-5 ${card.iconColor}`} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium truncate">{card.label}</p>
              {loading ? (
                <div className="mt-1 h-7 w-12 bg-gray-100 rounded-lg animate-pulse" />
              ) : (
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-bold text-gray-900">{card.format(value)}</span>
                  {subValue !== null && subValue !== undefined && (subValue as number) > 0 && (
                    <span className={`text-xs font-semibold ${(card as any).subColor}`}>
                      {subValue} {(card as any).subLabel}
                    </span>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
