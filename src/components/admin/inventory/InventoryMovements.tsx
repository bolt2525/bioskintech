import React from 'react';
import recordsFetch from "../../../utils/recordsFetch";
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ArrowUpRight, ArrowDownLeft, Activity, Search, Trash2, Calendar, RefreshCw, Eraser } from 'lucide-react';

interface Movement {
  id: number;
  item_name: string;
  sku: string;
  batch_number: string;
  movement_type: string;
  quantity_change: number;
  reason: string;
  user_id: string;
  user_name?: string;
  created_at: string;
  unit_sale_price?: string | null;
  sale_total?: string | null;
  cost_total?: string | null;
  is_archived?: boolean;
}

export default function InventoryMovements({ canDelete = false, canClear = false }: { canDelete?: boolean; canClear?: boolean }) {
  const [movements, setMovements] = React.useState<Movement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [searchTerm, setSearchTerm] = React.useState('');
  
  // Filter states
  const [filterType, setFilterType] = React.useState<'all' | 'IN' | 'OUT'>('all');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');

  const fetchMovements = React.useCallback(async () => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams({
        action: 'inventoryListMovements',
        limit: '200',
        type: filterType,
      });

      if (startDate) queryParams.append('startDate', startDate);
      if (endDate) queryParams.append('endDate', endDate);

      const res = await recordsFetch(`/api/records?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setMovements(data);
      }
    } catch (error) {
      console.error('Error fetching movements:', error);
    } finally {
      setLoading(false);
    }
  }, [filterType, startDate, endDate]);

  React.useEffect(() => {
    fetchMovements();
  }, [fetchMovements]);

  const handleDelete = async (id: number) => {
    if (!window.confirm('¿Estás seguro de que deseas eliminar este registro de movimiento? Esta acción no se puede deshacer.')) {
      return;
    }

    try {
      const res = await recordsFetch(`/api/records?action=inventoryDeleteMovement&id=${id}`, {
        method: 'POST'
      });
      if (res.ok) {
        fetchMovements();
      } else {
        const payload = await res.json().catch(() => ({}));
        alert(payload.error || 'Error al eliminar el movimiento');
      }
    } catch (error) {
      console.error('Error deleting movement:', error);
    }
  };

  const handleCleanHistory = async () => {
    const days = prompt('¿Eliminar historial antiguo? Ingresa el número de días para mantener (ej. 90 para borrar todo lo anterior a 3 meses):', '90');
    if (!days || isNaN(Number(days))) return;

    if (!window.confirm(`¿Confirmas eliminar todos los movimientos anteriores a ${days} días?`)) return;

    try {
      const res = await recordsFetch('/api/records?action=inventoryClearMovements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Number(days) })
      });
      
      if (res.ok) {
        alert('Historial depurado correctamente');
        fetchMovements();
      } else {
        alert('Error al depurar historial');
      }
    } catch (error) {
      console.error('Error cleaning history:', error);
    }
  };

  const filteredMovements = movements.filter(m => 
    m.item_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.sku?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.batch_number?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.reason?.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const entryCount = filteredMovements.filter(movement => movement.quantity_change > 0).length;
  const exitCount = filteredMovements.length - entryCount;

  return (
    <div className="space-y-4 animate-enter">
      {/* Header & Controls */}
      <div className="rounded-2xl border border-white/70 bg-white p-4 shadow-xl shadow-black/10 sm:p-5">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Bitácora operativa</p>
          <h3 className="mt-1 flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Activity className="h-5 w-5 text-amber-700" aria-hidden="true" />
            Movimientos
          </h3>
          <p className="mt-1 text-sm text-gray-500">Registro detallado de ingresos y salidas.</p>
        </div>
        <div className="flex divide-x divide-gray-200 rounded-xl border border-gray-200 bg-gray-50">
          <div className="px-4 py-2 text-center"><span className="block text-lg font-bold tabular-nums text-emerald-700">{entryCount}</span><span className="text-[10px] uppercase text-gray-500">Ingresos visibles</span></div>
          <div className="px-4 py-2 text-center"><span className="block text-lg font-bold tabular-nums text-red-700">{exitCount}</span><span className="text-[10px] uppercase text-gray-500">Salidas visibles</span></div>
        </div>
        </div>
        
        <div className="mt-4 grid gap-3 border-t border-gray-100 pt-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
           <div className="relative min-w-0">
             <label htmlFor="movement-search" className="sr-only">Buscar movimientos</label>
             <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
             <input id="movement-search" type="search" placeholder="Producto, SKU, lote o razón…" className="admin-focus-ring min-h-10 w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-4 text-sm text-gray-900 placeholder:text-gray-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
           </div>
           {/* Date Filters */}
           <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 focus-within:ring-2 focus-within:ring-amber-800 sm:flex-row sm:items-center">
             <Calendar className="hidden h-4 w-4 text-gray-400 sm:block" />
             <input 
               aria-label="Fecha inicial"
               type="date" 
               className="w-full bg-transparent text-sm text-gray-600 outline-none sm:w-32"
               value={startDate}
               onChange={(e) => setStartDate(e.target.value)}
             />
             <span className="text-gray-400">-</span>
             <input 
               aria-label="Fecha final"
               type="date" 
               className="w-full bg-transparent text-sm text-gray-600 outline-none sm:w-32"
               value={endDate}
               onChange={(e) => setEndDate(e.target.value)}
             />
           </div>

           {/* Type Filter */}
           <select 
             aria-label="Filtrar por tipo de movimiento"
             className="admin-focus-ring min-h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
             value={filterType}
             onChange={(e) => setFilterType(e.target.value as 'all' | 'IN' | 'OUT')}
           >
             <option value="all">Todos los tipos</option>
             <option value="IN">Ingresos (+)</option>
             <option value="OUT">Salidas (-)</option>
           </select>

           {/* Action Buttons */}
           {canClear && <button
             onClick={handleCleanHistory}
             className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100"
             title="Depurar historial antiguo"
           >
             <Eraser className="w-4 h-4" />
             <span className="hidden sm:inline">Limpiar</span>
           </button>}

           <button 
             onClick={fetchMovements}
             className="admin-focus-ring min-h-10 min-w-10 rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors hover:bg-amber-50 hover:text-amber-800"
             title="Actualizar"
             aria-label="Actualizar movimientos"
           >
             <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
           </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-gray-600 font-medium border-b border-gray-100">
              <tr>
                <th className="px-6 py-4">Fecha/Hora</th>
                <th className="px-6 py-4">Producto</th>
                <th className="px-6 py-4">Lote</th>
                <th className="px-6 py-4">Tipo</th>
                <th className="px-6 py-4 text-right">Cantidad</th>
                <th className="px-6 py-4">Razón / Usuario</th>
                {canDelete && <th className="px-6 py-4 text-center">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={canDelete ? 7 : 6} className="px-6 py-12 text-center text-gray-600">
                    <div className="flex flex-col items-center justify-center gap-2">
                       <RefreshCw className="w-6 h-6 animate-spin text-[#deb887]" />
                       <span>Cargando auditoría...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredMovements.length === 0 ? (
                <tr>
                  <td colSpan={canDelete ? 7 : 6} className="px-6 py-12 text-center text-gray-600">
                    No se encontraron movimientos con los filtros actuales
                  </td>
                </tr>
              ) : (
                filteredMovements.map((move) => (
                  <tr key={move.id} className={`transition-colors group ${move.quantity_change > 0 ? 'hover:bg-emerald-50/40' : 'hover:bg-red-50/40'}`}>
                    <td className="px-6 py-4 text-gray-500 whitespace-nowrap">
                      {(() => {
                        const d = new Date(move.created_at);
                        return isNaN(d.getTime())
                          ? <span className="text-red-400">Fecha inválida</span>
                          : format(d, 'dd MMM yyyy HH:mm', { locale: es });
                      })()}
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-800">{move.item_name}{move.is_archived && <span className="ml-2 text-[10px] font-semibold text-gray-600">ARCHIVADO · HISTÓRICO</span>}</div>
                      <div className="text-xs text-gray-400 font-mono">{move.sku}</div>
                    </td>
                    <td className="px-6 py-4 text-gray-600 font-mono text-xs">
                      {move.batch_number}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                        move.quantity_change > 0 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {move.quantity_change > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                        {move.quantity_change > 0 ? 'Ingreso' : 'Salida'}
                      </span>
                    </td>
                    <td className={`px-6 py-4 text-right font-medium ${
                      move.quantity_change > 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {move.quantity_change > 0 ? '+' : ''}{move.quantity_change}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-gray-800">{move.reason}</div>
                      <div className="text-xs text-gray-600">{move.user_name || (move.user_id ? `Usuario #${move.user_id}` : 'Sin usuario')}</div>
                      {move.sale_total != null ? (
                        <div className="text-xs text-emerald-800 font-semibold mt-0.5">
                          Importe registrado: ${Number(move.sale_total).toFixed(2)}
                          {move.cost_total != null && <span className="ml-1 font-normal text-gray-600">(costo: ${Number(move.cost_total).toFixed(2)})</span>}
                        </div>
                      ) : move.reason?.startsWith('Venta') ? <p className="mt-0.5 text-xs text-amber-800">Venta anterior sin importe registrado</p> : null}
                    </td>
                    {canDelete && <td className="px-6 py-4 text-center">
                      {move.sale_total == null && !move.reason?.startsWith('Venta') && <button
                        onClick={() => handleDelete(move.id)}
                        className="text-gray-600 hover:text-red-700 p-1 rounded hover:bg-red-50 transition-colors"
                        title="Eliminar registro"
                        aria-label="Eliminar movimiento"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>}
                    </td>}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
