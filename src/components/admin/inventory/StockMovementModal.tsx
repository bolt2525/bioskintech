import React, { useState } from 'react';
import { X, Save, AlertCircle, Calendar } from 'lucide-react';

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
    cost_per_unit: 0
  });
  const [noExpiry, setNoExpiry] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Auto-generate batch number if empty
      const finalBatchNumber = formData.batch_number.trim() || `LOTE-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(Math.random() * 1000)}`;
      
      await onSave({
        item_id: item.id,
        ...formData,
        expiration_date: noExpiry ? '2099-12-31' : formData.expiration_date,
        batch_number: finalBatchNumber
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error al guardar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
          <div>
            <h3 className="font-bold text-gray-800">Agregar Stock (Entrada)</h3>
            <p className="text-xs text-gray-500">{item.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
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
              className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
              placeholder="Ej. L-2024-001 (Se generará uno si se deja vacío)"
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

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cantidad ({item.unit_of_measure}) *</label>
              <input
                type="number"
                min="1"
                required
                className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.quantity}
                onChange={e => setFormData({...formData, quantity: parseInt(e.target.value)})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Costo Unitario ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.cost_per_unit}
                onChange={e => setFormData({...formData, cost_per_unit: parseFloat(e.target.value)})}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
            >
              {loading ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <Save className="w-4 h-4" />}
              Registrar Entrada
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
