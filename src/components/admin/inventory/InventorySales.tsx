import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { BarChart3, RefreshCw, Search } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import recordsFetch from '../../../utils/recordsFetch';

interface SalesReport {
  summary: { sales_count: number; total: string; known_margin: string; sales_without_cost: number; products_count: number };
  daily: { day: string; total: string; sales_count: number }[];
  products: { id: number; name: string; sku: string; unit_of_measure: string; units: string; total: string }[];
  recent: { id: number; created_at: string; item_name: string; category: string; batch_number: string;
    quantity_change: string; unit_of_measure: string; unit_sale_price: string; sale_total: string; reason: string }[];
}

interface Props {
  categories: string[];
  filterUserId: number | '';
  clinicKey: string;
}

const currency = new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' });
const dateValue = (date: Date) => format(date, 'yyyy-MM-dd');

export default function InventorySales({ categories, filterUserId, clinicKey }: Props) {
  const [startDate, setStartDate] = useState(() => dateValue(new Date(Date.now() - 29 * 86400000)));
  const [endDate, setEndDate] = useState(() => dateValue(new Date()));
  const [period, setPeriod] = useState<'30' | '90' | '365' | 'custom'>('30');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setCategory(''); setSearch(''); }, [clinicKey]);

  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    if (!startDate || !endDate || startDate > endDate) {
      setLoading(false);
      setError('Selecciona un rango de fechas válido.');
      return () => controller.abort();
    }
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ action: 'inventorySalesReport', startDate, endDate });
      if (category) params.set('category', category);
      if (search.trim()) params.set('search', search.trim());
      if (filterUserId) params.set('filterByUserId', String(filterUserId));
      try {
        const response = await recordsFetch(`/api/records?${params}`, { signal: controller.signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'No se pudo cargar el análisis de ventas.');
        }
        const payload = await response.json();
        if (!controller.signal.aborted) setReport(payload);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'No se pudo cargar el análisis.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [startDate, endDate, category, search, filterUserId, clinicKey, refreshKey]);

  const selectPeriod = (days: 30 | 90 | 365) => {
    setPeriod(String(days) as '30' | '90' | '365');
    setEndDate(dateValue(new Date()));
    setStartDate(dateValue(new Date(Date.now() - (days - 1) * 86400000)));
  };
  const chartData = report?.daily.map(entry => ({ day: entry.day.slice(5), total: Number(entry.total) })) || [];
  const maxProductTotal = Math.max(1, ...((report?.products || []).map(product => Number(product.total))));
  const inputClass = 'border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-amber-600 focus:ring-1 focus:ring-amber-600';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 border-b border-white/25 pb-4 text-white">
        <div className="flex gap-1" aria-label="Período de ventas">
          {([30, 90, 365] as const).map(days => (
            <button key={days} type="button" onClick={() => selectPeriod(days)} aria-pressed={period === String(days)}
              className={`px-3 py-2 text-xs font-semibold ${period === String(days) ? 'bg-white text-gray-900' : 'border border-white/40 text-gray-100 hover:bg-white/10'}`}>
              {days} días
            </button>
          ))}
        </div>
        <label className="text-xs text-gray-100">Desde
          <input type="date" value={startDate} max={endDate} onChange={event => { setStartDate(event.target.value); setPeriod('custom'); }} className={`mt-1 block ${inputClass}`} />
        </label>
        <label className="text-xs text-gray-100">Hasta
          <input type="date" value={endDate} min={startDate} onChange={event => { setEndDate(event.target.value); setPeriod('custom'); }} className={`mt-1 block ${inputClass}`} />
        </label>
        <label className="text-xs text-gray-100">Categoría
          <select value={category} onChange={event => setCategory(event.target.value)} className={`mt-1 block min-w-36 ${inputClass}`}>
            <option value="">Todas</option>
            {categories.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="relative min-w-44 flex-1 text-xs text-gray-100">Producto o SKU
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4 text-gray-500" />
          <input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)}
            className={`mt-1 block w-full pl-9 ${inputClass}`} placeholder="Buscar ventas" />
        </label>
        <button type="button" aria-label="Actualizar ventas" title="Actualizar ventas" onClick={() => setRefreshKey(key => key + 1)}
          className="border border-white/40 p-2.5 text-white hover:bg-white/10"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      <div className="bg-white p-4 text-gray-900 sm:p-6">
        {error ? <p role="alert" className="text-sm font-medium text-red-700">{error}</p> : loading ? (
          <p className="py-16 text-center text-sm text-gray-600">Cargando ventas…</p>
        ) : report ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 border-b border-gray-200 pb-5 lg:grid-cols-4">
              <div><p className="text-xs font-medium text-gray-600">Importe registrado</p><p className="text-xl font-bold">{currency.format(Number(report.summary.total))}</p></div>
              <div><p className="text-xs font-medium text-gray-600">Salidas por venta</p><p className="text-xl font-bold">{report.summary.sales_count}</p></div>
              <div><p className="text-xs font-medium text-gray-600">Productos vendidos</p><p className="text-xl font-bold">{report.summary.products_count}</p></div>
              <div><p className="text-xs font-medium text-gray-600">Margen conocido</p><p className="text-xl font-bold">{currency.format(Number(report.summary.known_margin))}</p>
                {report.summary.sales_without_cost > 0 && <p className="text-xs text-amber-800">{report.summary.sales_without_cost} ventas sin costo; margen parcial</p>}
              </div>
            </div>
            <p className="text-xs text-gray-600">Salidas registradas con precio desde la actualización. No incluye cobros, impuestos ni facturas; ventas anteriores sin precio no se estiman.</p>
            {chartData.length ? (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
                <section aria-label="Importe diario de ventas" className="min-w-0">
                  <h3 className="mb-3 text-sm font-semibold">Importe diario</h3>
                  <div className="h-60 w-full" role="img" aria-label="Gráfico de importe de ventas por día">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ left: 0, right: 8 }}>
                        <CartesianGrid stroke="#e5e7eb" vertical={false} />
                        <XAxis dataKey="day" stroke="#4b5563" tick={{ fontSize: 11 }} minTickGap={20} />
                        <YAxis stroke="#4b5563" tick={{ fontSize: 11 }} width={56} tickFormatter={value => `$${value}`} />
                        <Tooltip formatter={value => currency.format(Number(value))} />
                        <Bar dataKey="total" name="Ventas" fill="#b7793d" maxBarSize={34} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
                <section aria-label="Productos vendidos">
                  <h3 className="mb-3 text-sm font-semibold">Productos principales</h3>
                  <div className="space-y-3">
                    {report.products.map(product => (
                      <div key={product.id}>
                        <div className="flex justify-between gap-2 text-xs"><span className="truncate font-medium" title={product.name}>{product.name}</span>
                          <span className="shrink-0">{currency.format(Number(product.total))}</span></div>
                        <div className="mt-1 h-1.5 bg-gray-100"><div className="h-full bg-emerald-600" style={{ width: `${Number(product.total) / maxProductTotal * 100}%` }} /></div>
                        <p className="mt-0.5 text-xs text-gray-600">{Number(product.units)} {product.unit_of_measure || 'unidades'}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            ) : <div className="flex flex-col items-center py-10 text-center text-gray-600"><BarChart3 className="mb-2 h-8 w-8 text-gray-400" /><p className="text-sm font-medium">Sin ventas con precio registrado en este período</p><p className="mt-1 text-xs">Las salidas anteriores siguen en Movimientos, pero no tenían importe guardado.</p></div>}
            {report.recent.length > 0 && (
              <section>
                <h3 className="mb-3 text-sm font-semibold">Ventas registradas <span className="font-normal text-gray-600">(últimas 100 del período)</span></h3>
                <div className="overflow-x-auto border-t border-gray-200">
                  <table className="w-full min-w-[600px] text-left text-sm">
                    <thead className="text-xs text-gray-600"><tr><th className="py-2">Fecha</th><th>Producto / lote</th><th>Salida</th><th className="text-right">Precio unit.</th><th className="text-right">Importe</th></tr></thead>
                    <tbody className="divide-y divide-gray-100">{report.recent.map(sale => (
                      <tr key={sale.id}>
                        <td className="py-2 pr-3 whitespace-nowrap">{new Date(sale.created_at).toLocaleDateString('es-EC')}</td>
                        <td className="py-2 pr-3"><span className="font-medium">{sale.item_name}</span><br /><span className="text-xs text-gray-600">Lote {sale.batch_number}</span></td>
                        <td className="py-2 pr-3">{Number(-sale.quantity_change)} {sale.unit_of_measure}<br /><span className="text-xs text-gray-600">{sale.reason}</span></td>
                        <td className="py-2 text-right">{currency.format(Number(sale.unit_sale_price))}</td>
                        <td className="py-2 text-right font-semibold">{currency.format(Number(sale.sale_total))}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}