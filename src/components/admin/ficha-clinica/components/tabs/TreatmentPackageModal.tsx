import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Package, X, DollarSign, Hash, Wallet } from 'lucide-react';
import recordsFetch from '../../../../../utils/recordsFetch';
import { Dialog } from '../../../../ui/Dialog';
import type { TreatmentMode, TreatmentPackage } from '../../types/treatment';

interface TreatmentPackageModalProps {
  recordId: number;
  consultationId?: number;
  mode: TreatmentMode;
  onClose: () => void;
  onCreated: (pkg: TreatmentPackage) => void;
}

/** Modal único de registro de paquetes, reutilizable en los 3 modos del tab de Tratamientos */
export default function TreatmentPackageModal({ recordId, consultationId, mode, onClose, onCreated }: TreatmentPackageModalProps) {
  const [name, setName] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [estimatedSessions, setEstimatedSessions] = useState('1');
  const [initialPayment, setInitialPayment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('El nombre del paquete es obligatorio'); return; }
    setSaving(true);
    setError('');
    try {
      const response = await recordsFetch('/api/records?action=createPackage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: recordId,
          consultation_id: consultationId,
          treatment_mode: mode,
          name: name.trim(),
          total_cost: parseFloat(totalCost.replace(',', '.')) || 0,
          estimated_sessions: parseInt(estimatedSessions) || 1,
          initial_payment: parseFloat(initialPayment.replace(',', '.')) || 0,
        }),
      });
      const resBody = await response.json().catch(() => null);
      if (!response.ok) throw new Error(resBody?.error || 'Error al crear el paquete');
      onCreated(resBody);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear el paquete');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} labelledBy="package-modal-title">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-gray-100 bg-white p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
          <h3 id="package-modal-title" className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <div className="w-1.5 h-6 bg-[#deb887] rounded-full" />
            <Package className="w-5 h-5 text-[#b8944d]" /> Crear Paquete
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">Nombre del Paquete</label>
            <input
              type="text"
              required
              autoFocus
              className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ej: Paquete 5 sesiones Hydrafacial"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Costo Total</label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  inputMode="decimal"
                  className="w-full pl-9 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
                  value={totalCost}
                  onChange={e => setTotalCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Sesiones estimadas</label>
              <div className="relative">
                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="number"
                  min={1}
                  className="w-full pl-9 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
                  value={estimatedSessions}
                  onChange={e => setEstimatedSessions(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">Abono Inicial</label>
            <div className="relative">
              <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                inputMode="decimal"
                className="w-full pl-9 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
                value={initialPayment}
                onChange={e => setInitialPayment(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 p-2.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="flex-1 p-2.5 rounded-lg bg-[#deb887] text-white hover:bg-[#c5a075] font-medium disabled:opacity-60">
              {saving ? 'Creando...' : 'Crear Paquete'}
            </button>
          </div>
        </form>
      </motion.div>
    </Dialog>
  );
}
