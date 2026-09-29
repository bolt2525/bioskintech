import React, { useState } from 'react';
import { X, Save, AlertCircle, Calendar, Info, TrendingUp } from 'lucide-react';

interface StockMovementModalProps {
  item: any;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
}

export default function StockMovementModal({ item, onClose, onSave }: StockMovementModalProps) {
  const [formData, setFormData] = useState({
    batch_number: '',
    expiration_date: '',
    quantity: 1,
    cost_per_unit: ''
  });
  const [noExpiry, setNoExpiry] = useState(false);
  const [updateReferenceCost, setUpdateReferenceCost] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referenceCost = item.cost_price == null ? null : Number(item.cost_price);
  const newCost = formData.cost_per_unit === '' ? null : Number(formData.cost_per_unit);
  const costChanged = newCost !== null && Number.isFinite(newCost) && newCost !== referenceCost;
  const salePrice = item.category === 'Venta' && item.sale_price != null ? Number(item.sale_price) : null;
  const negativeMargin = newCost !== null && salePrice !== null && salePrice > 0 && newCost > salePrice;
  const money = (value: number) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(value);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(formData.quantity) || formData.quantity <= 0 ||
        (newCost !== null && (!Number.isFinite(newCost) || newCost < 0))) {
      setError('Revisa la cantidad y el costo de esta entrada.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Auto-generate batch number if empty
      const finalBatchNumber = formData.batch_number.trim() || `LOTE-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(Math.random() * 1000)}`;
      
      await onSave({
        item_id: item.id,
        ...formData,
        expiration_date: noExpiry ? '2099-12-31' : formData.expiration_date,
        batch_number: finalBatchNumber,
        update_reference_cost: updateReferenceCost && costChanged,
        reference_cost: item.cost_price ?? null
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/65 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-md shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto text-gray-900">
        <div className="p-5 border-b border-gray-200 flex justify-between items-center bg-gray-50">
          <div>
            <h3 className="font-bold text-gray-800">Agregar Stock (Entrada)</h3>
            <p className="text-xs text-gray-500">{item.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar entrada de stock" className="text-gray-600 hover:text-gray-900">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Número de Lote <span className="text-gray-400 font-normal">(Opcional)</span></label>
            <input
              type="text"
              className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#b8874d] outline-none"
              placeholder="Ej. L-2026-001"
              value={formData.batch_number}
              onChange={e => setFormData({...formData, batch_number: e.target.value})}
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="block text-sm font-medium text-gray-700">Fecha de Vencimiento *</label>
              <div className="flex items-center gap-2">
                <input 
                  type="checkbox" 
                  id="noExpiry"
                  checked={noExpiry}
                  onChange={(e) => {
                    setNoExpiry(e.target.checked);
                    if (e.target.checked) setFormData({...formData, expiration_date: ''});
                  }}
                  className="w-4 h-4 text-[#deb887] rounded focus:ring-[#deb887]"
                />
                <label htmlFor="noExpiry" className="text-xs text-gray-500 cursor-pointer select-none">No aplica</label>
              </div>
            </div>
            <div className="relative">
              <Calendar className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${noExpiry ? 'text-gray-300' : 'text-gray-400'}`} />
              <input
                type="date"
                required={!noExpiry}
                disabled={noExpiry}
                className={`w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none ${noExpiry ? 'bg-gray-50 text-gray-400' : ''}`}
                value={formData.expiration_date}
                onChange={e => setFormData({...formData, expiration_date: e.target.value})}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <label className="block text-sm font-medium text-gray-700 mb-1">Cantidad ({item.unit_of_measure}) *</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                className="w-full min-w-0 p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#b8874d] outline-none"
                value={formData.quantity}
                onChange={e => setFormData({...formData, quantity: parseFloat(e.target.value)})}
              />
            </div>
            <div className="min-w-0">
              <label htmlFor="receipt-unit-cost" className="block text-sm font-medium text-gray-700 mb-1">Costo real de este lote por {item.unit_of_measure || 'unidad'} ($)</label>
              <input
                id="receipt-unit-cost"
                type="number"
                min="0"
                step="0.01"
                className="w-full min-w-0 p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#b8874d] outline-none"
                value={formData.cost_per_unit}
                onChange={e => {
                  setFormData(previous => ({ ...previous, cost_per_unit: e.target.value }));
                  if (!e.target.value || Number(e.target.value) === referenceCost) setUpdateReferenceCost(false);
                }}
              />
            </div>
          </div>

          <div className="border-y border-gray-200 py-4 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-gray-700">Costo de referencia del producto</span>
              <span className="font-bold text-gray-900">{referenceCost === null ? 'Sin registrar' : money(referenceCost)}</span>
            </div>
            {newCost !== null && Number.isFinite(newCost) && (
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-gray-700">Valor de esta entrada ({formData.quantity || 0} {item.unit_of_measure || 'unidades'})</span>
                <span className="font-semibold text-gray-900">{money(newCost * (formData.quantity || 0))}</span>
              </div>
            )}
            {newCost !== null && Number.isFinite(newCost) && salePrice !== null && salePrice > 0 && (
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-gray-700">Margen bruto por unidad al precio de venta de referencia</span>
                <span className={`font-semibold ${negativeMargin ? 'text-red-800' : 'text-emerald-800'}`}>
                  {money(salePrice - newCost)} ({(((salePrice - newCost) / salePrice) * 100).toFixed(1)}%)
                </span>
              </div>
            )}
            {costChanged ? (
              <>
                <div className="flex items-start gap-2 border-l-2 border-amber-600 bg-amber-50 p-3 text-sm text-amber-950">
                  <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Este lote quedará a {money(newCost!)} por unidad. {referenceCost === null
                    ? 'El producto aún no tiene costo de referencia.'
                    : `Diferencia: ${money(newCost! - referenceCost)} (${referenceCost > 0 ? `${(((newCost! - referenceCost) / referenceCost) * 100).toFixed(1)}%` : 'sin porcentaje base'}).`}</span>
                </div>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-900">
                  <input type="checkbox" checked={updateReferenceCost} onChange={event => setUpdateReferenceCost(event.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0 accent-emerald-700" />
                  <span>Actualizar también la referencia del producto a <strong>{money(newCost!)}</strong></span>
                </label>
              </>
            ) : (
              <p className="flex items-start gap-2 text-xs text-gray-700"><Info className="h-4 w-4 shrink-0" />{newCost === null
                ? 'Sin costo de compra: el lote conservará costo desconocido. La valoración usará la referencia del producto si existe.'
                : 'La referencia no cambia. El costo del lote se conserva para su valoración y trazabilidad.'}</p>
            )}
            {costChanged && !updateReferenceCost && <p className="text-xs text-gray-700">La referencia seguirá en {referenceCost === null ? 'sin registrar' : money(referenceCost)}; la diferencia solo afecta este lote.</p>}
            {updateReferenceCost && <p className="text-xs font-medium text-emerald-800">No cambia costos reales de otros lotes ni el precio de venta. Puede cambiar la valoración estimada de lotes antiguos sin costo propio.</p>}
            {negativeMargin && <p role="alert" className="border-l-2 border-red-600 bg-red-50 p-2 text-xs font-semibold text-red-900">El costo de este lote supera el precio de venta de referencia ({money(salePrice!)}). Revisa el margen antes de guardar.</p>}
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-emerald-700 text-white rounded-md hover:bg-emerald-800 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {loading ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <Save className="w-4 h-4" />}
              {updateReferenceCost && costChanged ? 'Registrar y actualizar referencia' : 'Registrar entrada'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
