import React from 'react';
import { format, differenceInDays } from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar, AlertTriangle, AlertCircle, CheckCircle, Trash2 } from 'lucide-react';

interface Batch {
  id: number;
  item_name: string;
  sku: string;
  batch_number: string;
  expiration_date: string;
  quantity_current: number;
  unit_of_measure: string;
}

export default function InventoryBatches() {
  const [batches, setBatches] = React.useState<Batch[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetchBatches();
  }, []);

  const fetchBatches = async () => {
    try {
      const res = await fetch('/api/records?action=inventoryListBatches');
      if (res.ok) {
        const data = await res.json();
        setBatches(data);
      }
    } catch (error) {
      console.error('Error fetching batches:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteBatch = async (batchId: number, batchNumber: string) => {
    if (!window.confirm(`¿Estás seguro de eliminar el lote "${batchNumber}"? Se eliminará todo el historial de movimientos asociado y esta acción no se puede deshacer.`)) return;

    try {
      const res = await fetch(`/api/records?action=inventoryDeleteBatch&id=${batchId}`, {
        method: 'DELETE'
      });

      if (res.ok) {
        fetchBatches();
      } else {
        const err = await res.json();
        alert(err.error || 'Error al eliminar el lote');
      }
    } catch (error) {
      console.error('Error removing batch:', error);
      alert('Error en la conexión');
    }
  };

  const getExpiryStatus = (date: string) => {
    // Check for dummy date (No Expiry)
    if (date.startsWith('2099')) return { label: 'Permanente', color: 'bg-blue-100 text-blue-700', icon: CheckCircle };

    const days = differenceInDays(new Date(date), new Date());
    if (days < 0) return { label: 'Vencido', color: 'bg-red-100 text-red-700', icon: AlertCircle };
    if (days < 30) return { label: 'Por Vencer', color: 'bg-orange-100 text-orange-700', icon: AlertTriangle };
    if (days < 90) return { label: 'Próximo', color: 'bg-yellow-100 text-yellow-700', icon: AlertTriangle };
    return { label: 'Vigente', color: 'bg-green-100 text-green-700', icon: CheckCircle };
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
        <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-[#deb887]" />
          Lotes y Vencimientos
        </h3>
        <p className="text-sm text-gray-500 mt-1">Listado de lotes activos ordenados por fecha de vencimiento.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {loading ? (
             [...Array(4)].map((_, i) => (
                <div key={i} className="animate-pulse bg-white h-40 rounded-xl border border-gray-100"></div>
             ))
        ) : batches.length === 0 ? (
             <div className="col-span-full py-12 text-center text-gray-400">No hay lotes activos</div>
        ) : (
          batches.map((batch) => {
            const status = getExpiryStatus(batch.expiration_date);
            const StatusIcon = status.icon;
            
            return (
              <div key={batch.id} className="bg-white p-5 rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
                <div className={`absolute top-0 right-0 p-2 rounded-bl-xl ${status.color} text-xs font-semibold flex items-center gap-1`}>
                  <StatusIcon className="w-3 h-3" />
                  {status.label}
                </div>

                <button 
                  onClick={() => handleDeleteBatch(batch.id, batch.batch_number)}
                  className="absolute bottom-3 right-3 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100 z-10"
                  title="Eliminar lote"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                
                <div className="mb-4">
                  <h4 className="font-semibold text-gray-800 line-clamp-1" title={batch.item_name}>{batch.item_name}</h4>
                  <div className="text-xs text-gray-400 font-mono mt-1">{batch.sku}</div>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between items-center text-gray-600">
                    <span>Lote:</span>
                    <span className="font-mono bg-gray-50 px-2 py-0.5 rounded text-gray-800">{batch.batch_number}</span>
                  </div>
                  <div className="flex justify-between items-center text-gray-600">
                    <span>Cantidad:</span>
                    <span className="font-medium text-gray-900">{batch.quantity_current} {batch.unit_of_measure}</span>
                  </div>
                  <div className="flex justify-between items-center text-gray-600">
                    <span>Vence:</span>
                    <span className={`font-medium ${status.color.replace('bg-', 'text-').split(' ')[0]}`}>
                      {batch.expiration_date.startsWith('2099') ? 'Sin Vencimiento' : format(new Date(batch.expiration_date), 'dd/MM/yyyy')}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
