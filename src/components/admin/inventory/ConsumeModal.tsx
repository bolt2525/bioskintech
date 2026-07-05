import React, { useState, useEffect } from 'react';
import { X, Save, AlertCircle, ShoppingCart, Package, Layers } from 'lucide-react';

interface ConsumeModalProps {
  item: any;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
}

export default function ConsumeModal({ item, onClose, onSave }: ConsumeModalProps) {
  const isVenta = item.category === 'Venta';

  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [quantity, setQuantity] = useState<string>('1');
  const [reason, setReason] = useState(isVenta ? 'Venta directa' : 'Uso en cabina');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/records?action=inventoryGetItem&id=${item.id}`)
      .then(res => res.json())
      .then(data => {
        if (data.batches) {
          setBatches(data.batches);
          if (data.batches.length > 0) {
            setSelectedBatchId(String(data.batches[0].id));
          }
        }
      })
      .catch(() => setError('Error cargando lotes'))
      .finally(() => setLoading(false));
  }, [item.id]);

  const selectedBatch = batches.find(b => String(b.id) === selectedBatchId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBatchId) {
      setError('Selecciona un lote con stock disponible');
      return;
    }

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      setError('La cantidad debe ser mayor a 0');
      return;
    }

    if (selectedBatch && qty > parseFloat(selectedBatch.quantity_current)) {
      setError(`Stock insuficiente en el lote seleccionado (Max: ${selectedBatch.quantity_current})`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onSave({ batch_id: selectedBatchId, quantity: qty, reason });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error al registrar');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887] focus:border-[#deb887] outline-none transition-all bg-gray-50 focus:bg-white";
  const labelCls = "block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide";

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* Encabezado */}
        <div className={`px-6 py-5 border-b border-gray-100 flex justify-between items-start ${isVenta ? 'bg-emerald-50' : 'bg-orange-50'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${isVenta ? 'bg-emerald-100' : 'bg-orange-100'}`}>
              {isVenta
                ? <ShoppingCart className="w-5 h-5 text-emerald-600" />
                : <Package className="w-5 h-5 text-orange-500" />
              }
            </div>
            <div>
              <h3 className="font-bold text-gray-900 text-base">
                {isVenta ? 'Registrar Venta' : 'Registrar Consumo'}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5 max-w-[260px] truncate">{item.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white/70 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-100 text-red-700 rounded-xl text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Lote */}
          <div>
            <label className={labelCls}>
              <Layers className="w-3 h-3 inline-block mr-1 -mt-0.5" />
              Lote de origen
            </label>
            {loading ? (
              <div className="h-10 bg-gray-100 rounded-xl animate-pulse" />
            ) : batches.length === 0 ? (
              <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-sm text-red-600">
                No hay lotes con stock disponible para este producto.
              </div>
            ) : (
              <select
                className={inputCls}
                value={selectedBatchId}
                onChange={e => setSelectedBatchId(e.target.value)}
              >
                {batches.map(batch => (
                  <option key={batch.id} value={batch.id}>
                    Lote {batch.batch_number} — Vence: {new Date(batch.expiration_date).toLocaleDateString('es-MX')} — Stock: {batch.quantity_current} {item.unit_of_measure}
                  </option>
                ))}
              </select>
            )}
            {selectedBatch && (
              <p className="text-xs text-gray-400 mt-1.5 pl-1">
                Disponible: <span className="font-semibold text-gray-600">{selectedBatch.quantity_current} {item.unit_of_measure}</span>
              </p>
            )}
          </div>

          {/* Cantidad */}
          <div>
            <label className={labelCls}>
              {isVenta ? 'Cantidad vendida' : 'Cantidad a consumir'}
            </label>
            <div className="flex gap-2.5">
              <input
                type="number"
                step="1"
                min="1"
                max={selectedBatch ? selectedBatch.quantity_current : undefined}
                required
                className={`flex-1 ${inputCls}`}
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
              />
              <span className="px-4 py-2.5 bg-gray-100 rounded-xl text-gray-600 text-sm font-medium flex items-center whitespace-nowrap">
                {item.unit_of_measure || 'Unidad'}
              </span>
            </div>
          </div>

          {/* Motivo */}
          <div>
            <label className={labelCls}>Motivo del egreso</label>
            <select
              className={inputCls}
              value={reason}
              onChange={e => setReason(e.target.value)}
            >
              {isVenta ? (
                <>
                  <option value="Venta directa">Venta directa</option>
                  <option value="Venta con descuento">Venta con descuento</option>
                  <option value="Muestra gratis">Muestra / Promocion</option>
                </>
              ) : (
                <>
                  <option value="Uso en cabina">Uso en cabina / Tratamiento</option>
                  <option value="Venta directa">Venta directa</option>
                  <option value="Mermas / Dano">Mermas / Dano</option>
                  <option value="Vencimiento">Vencimiento</option>
                  <option value="Ajuste de inventario">Ajuste de inventario</option>
                </>
              )}
            </select>
          </div>

          {/* Botones */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors text-sm font-medium"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading || batches.length === 0}
              className={`flex-1 px-4 py-2.5 text-white rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold shadow-sm ${
                isVenta
                  ? 'bg-emerald-500 hover:bg-emerald-600'
                  : 'bg-[#deb887] hover:bg-[#c5a075]'
              }`}
            >
              <Save className="w-4 h-4" />
              {loading ? 'Registrando...' : isVenta ? 'Confirmar Venta' : 'Confirmar Consumo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}