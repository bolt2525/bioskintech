import React from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ArrowUpRight, ArrowDownLeft, Activity, Search, Trash2, Filter, Calendar, RefreshCw, Eraser } from 'lucide-react';

interface Movement {
  id: number;
  item_name: string;
  sku: string;
  batch_number: string;
  movement_type: string;
  quantity_change: number;
  reason: string;
  user_id: string;
  created_at: string;
}

export default function InventoryMovements() {
  const [movements, setMovements] = React.useState<Movement[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [searchTerm, setSearchTerm] = React.useState('');
  
  // Filter states
  const [filterType, setFilterType] = React.useState<'all' | 'IN' | 'OUT'>('all');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');

  React.useEffect(() => {
    fetchMovements();
  }, [filterType, startDate, endDate]);

  const fetchMovements = async () => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams({
        action: 'inventoryListMovements',
        limit: '200',
        type: filterType,
      });

      if (startDate) queryParams.append('startDate', startDate);
      if (endDate) queryParams.append('endDate', endDate);

      const res = await fetch(`/api/records?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setMovements(data);
      }
    } catch (error) {
      console.error('Error fetching movements:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('¿Estás seguro de que deseas eliminar este registro de movimiento? Esta acción no se puede deshacer.')) {
      return;
    }

    try {
      const res = await fetch(`/api/records?action=inventoryDeleteMovement&id=${id}`, {
        method: 'POST'
      });
      if (res.ok) {
        fetchMovements();
      } else {
        alert('Error al eliminar el movimiento');
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
      const res = await fetch('/api/records?action=inventoryClearMovements', {
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

  return (
    <div className="space-y-6 animate-enter">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <div>
          <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#deb887]" />
            Auditoría de Movimientos
          </h3>
          <p className="text-sm text-gray-500 mt-1">Registro detallado de ingresos y salidas del inventario</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
           {/* Date Filters */}
           <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
             <Calendar className="w-4 h-4 text-gray-400" />
             <input 
               type="date" 
               className="bg-transparent text-sm text-gray-600 outline-none w-32"
               value={startDate}
               onChange={(e) => setStartDate(e.target.value)}
             />
             <span className="text-gray-400">-</span>
             <input 
               type="date" 
               className="bg-transparent text-sm text-gray-600 outline-none w-32"
               value={endDate}
               onChange={(e) => setEndDate(e.target.value)}
             />
           </div>

           {/* Type Filter */}
           <select 
             className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-[#deb887]"
             value={filterType}
             onChange={(e) => setFilterType(e.target.value as any)}
           >
             <option value="all">Todos los tipos</option>
             <option value="IN">Ingresos (+)</option>
             <option value="OUT">Salidas (-)</option>
           </select>

           {/* Action Buttons */}
           <button 
             onClick={handleCleanHistory}
             className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100"
             title="Depurar historial antiguo"
           >
             <Eraser className="w-4 h-4" />
             <span className="hidden sm:inline">Limpiar</span>
           </button>

           <button 
             onClick={fetchMovements}
             className="p-2 text-gray-400 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-lg transition-colors"
             title="Actualizar"
           >
             <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
           </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
        <input
          type="text"
          placeholder="Buscar por nombre, SKU, lote o razón..."
          className="w-full pl-9 pr-4 py-3 text-sm border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none shadow-sm"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
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
                <th className="px-6 py-4 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center justify-center gap-2">
                       <RefreshCw className="w-6 h-6 animate-spin text-[#deb887]" />
                       <span>Cargando auditoría...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredMovements.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-400">
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
                      <div className="font-medium text-gray-800">{move.item_name}</div>
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
                      <div className="text-xs text-gray-500">{move.user_id}</div>
                      {(move.sale_price != null) && (
                        <div className="text-xs text-emerald-600 font-medium mt-0.5">
                          Venta: ${parseFloat(move.sale_price).toFixed(2)}
                          {move.cost_price != null && (
                            <span className="text-gray-400 font-normal ml-1">(costo: ${parseFloat(move.cost_price).toFixed(2)})</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button 
                        onClick={() => handleDelete(move.id)}
                        className="text-gray-300 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                        title="Eliminar registro"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
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
