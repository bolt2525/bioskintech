import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Package, X, DollarSign, Hash, Wallet } from 'lucide-react';
import recordsFetch from '../../../../../utils/recordsFetch';
import { Dialog } from '../../../../ui/Dialog';
import { ConfirmationDialog } from '../../../../ui/ConfirmationDialog';
import TreatmentFinanceOptions from './TreatmentFinanceOptions';
import { createFinancePostingOptions, type FinancePostingOptions, type TreatmentMode, type TreatmentPackage } from '../../types/treatment';

interface TreatmentPackageModalProps {
  recordId: number;
  consultationId?: number;
  patientName?: string;
  mode: TreatmentMode;
  packageToEdit?: TreatmentPackage | null;
  onClose: () => void;
  onCreated: (pkg: TreatmentPackage) => void;
  onUpdated?: (pkg: TreatmentPackage) => void;
}

/** Convierte un campo monetario de texto a número redondeado a centavos.
 *  Lanza un error legible si el valor no es finito o es negativo. Vacío equivale a 0. */
function parseMoneyField(raw: string, label: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const normalized = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${label} debe ser un número válido mayor o igual a 0`);
  }
  return Math.round(normalized * 100) / 100;
}

/** Parseo "suave" solo para vista previa en vivo (nunca lanza, usa 0 como respaldo) */
function previewMoney(raw: string): number {
  const normalized = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
}

/** Modal único de registro y modificación de paquetes, reutilizable en los 3 modos del tab de Tratamientos */
export default function TreatmentPackageModal({
  recordId,
  consultationId,
  patientName,
  mode,
  packageToEdit,
  onClose,
  onCreated,
  onUpdated,
}: TreatmentPackageModalProps) {
  const isEditing = Boolean(packageToEdit && packageToEdit.id);
  const [name, setName] = useState(packageToEdit?.name || '');
  const [totalCost, setTotalCost] = useState(packageToEdit ? String(packageToEdit.total_cost ?? '') : '');
  const [estimatedSessions, setEstimatedSessions] = useState(packageToEdit ? String(packageToEdit.estimated_sessions ?? 1) : '1');
  const [initialPayment, setInitialPayment] = useState(packageToEdit ? String(packageToEdit.initial_payment ?? '0') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [financePosting, setFinancePosting] = useState<FinancePostingOptions>(createFinancePostingOptions);
  // La `idempotency_key` se genera una sola vez al montar el modal y permanece estable en el estado
  // de React durante todo el ciclo de vida (incluidos reintentos de envío tras error de red): esto es
  // lo que exige el backend para `createPackage` con abono > 0, que no genera una clave de respaldo.
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  const minSessions = packageToEdit?.sessions_count ? Math.max(1, packageToEdit.sessions_count) : 1;
  const sessionsPaid = Number(packageToEdit?.sessions_paid || 0);
  const previousInitialPayment = Number(packageToEdit?.initial_payment || 0);
  /** Deuda total ya consolidada (abono inicial actual + pagos por sesión), para el aviso de edición */
  const alreadyPaid = previousInitialPayment + sessionsPaid;

  // Vista previa en vivo para el resumen financiero diferenciado (no valida, solo informa)
  const previewCost = previewMoney(totalCost);
  const previewInitial = previewMoney(initialPayment);
  const previewTotalPaid = Math.round((previewInitial + sessionsPaid) * 100) / 100;
  const previewBalance = Math.round((previewCost - previewTotalPaid) * 100) / 100;

  const submitUpdate = async (parsedCost: number, parsedSessions: number, parsedInitial: number, confirmRemoval: boolean) => {
    if (!packageToEdit?.id) return;
    setSaving(true);
    setError('');
    try {
      const response = await recordsFetch('/api/records?action=updatePackage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: packageToEdit.id,
          name: name.trim(),
          total_cost: parsedCost,
          estimated_sessions: parsedSessions,
          initial_payment: parsedInitial,
          ...(confirmRemoval ? { confirm_remove_initial_payment: true } : {}),
        }),
      });
      const resBody = await response.json().catch(() => null);
      if (!response.ok) {
        if (resBody?.code === 'INITIAL_PAYMENT_CONFIRMATION_REQUIRED') {
          setConfirmRemoveOpen(true);
          return;
        }
        throw new Error(resBody?.error || 'Error al modificar el paquete');
      }
      setConfirmRemoveOpen(false);
      if (onUpdated) {
        onUpdated(resBody);
      } else {
        onCreated(resBody);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al modificar el paquete');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('El nombre del paquete es obligatorio'); return; }

    let parsedCost: number;
    let parsedInitial: number;
    try {
      parsedCost = parseMoneyField(totalCost, 'El costo total');
      parsedInitial = parseMoneyField(initialPayment, 'El abono inicial');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Monto inválido');
      return;
    }

    const parsedSessions = parseInt(estimatedSessions, 10);
    if (!Number.isFinite(parsedSessions) || parsedSessions < 1) {
      setError('Las sesiones estimadas deben ser al menos 1');
      return;
    }

    if (isEditing && packageToEdit?.id) {
      if (parsedSessions < minSessions) {
        setError(`Las sesiones no pueden ser menores a las ya registradas (${minSessions})`);
        return;
      }
      const requiredMinimum = Math.round((parsedInitial + sessionsPaid) * 100) / 100;
      if (parsedCost < requiredMinimum) {
        setError(`El costo total ($${parsedCost.toFixed(2)}) no puede ser menor al abono inicial ($${parsedInitial.toFixed(2)}) más los pagos por sesión ($${sessionsPaid.toFixed(2)})`);
        return;
      }
      if (previousInitialPayment > 0 && parsedInitial === 0) {
        setConfirmRemoveOpen(true);
        return;
      }
      await submitUpdate(parsedCost, parsedSessions, parsedInitial, false);
      return;
    }

    if (parsedInitial > parsedCost) {
      setError(`El abono inicial ($${parsedInitial.toFixed(2)}) no puede superar el costo total ($${parsedCost.toFixed(2)})`);
      return;
    }

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
          total_cost: parsedCost,
          estimated_sessions: parsedSessions,
          initial_payment: parsedInitial,
          finance_posting: {
            ...financePosting,
            enabled: parsedInitial > 0,
          },
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

  const handleConfirmRemoveInitialPayment = async () => {
    let parsedCost: number;
    let parsedInitial: number;
    try {
      parsedCost = parseMoneyField(totalCost, 'El costo total');
      parsedInitial = parseMoneyField(initialPayment, 'El abono inicial');
    } catch (err) {
      setConfirmRemoveOpen(false);
      setError(err instanceof Error ? err.message : 'Monto inválido');
      return;
    }
    const parsedSessions = parseInt(estimatedSessions, 10) || minSessions;
    await submitUpdate(parsedCost, parsedSessions, parsedInitial, true);
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
            <Package className="w-5 h-5 text-[#b8944d]" /> {isEditing ? 'Modificar Paquete' : 'Crear Paquete'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Cerrar">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="mb-4 text-xs text-gray-500">Disponible para sesiones faciales, corporales y capilares de esta consulta.</p>

        {isEditing && (
          <div className="mb-4 p-3 bg-amber-50/70 border border-amber-200/80 rounded-lg text-xs space-y-1 text-amber-800">
            <div className="flex justify-between">
              <span>Sesiones registradas:</span>
              <span className="font-semibold">{packageToEdit?.sessions_count ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span>Pagos por sesión (independientes, no se editan aquí):</span>
              <span className="font-semibold">${sessionsPaid.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-t border-amber-200/60 pt-1 mt-1">
              <span>Total abonado / pagado:</span>
              <span className="font-semibold">${alreadyPaid.toFixed(2)}</span>
            </div>
            {packageToEdit?.sessions_count ? (
              <p className="text-[11px] text-amber-700/80 pt-1 border-t border-amber-200/60 mt-1">
                Las sesiones mínimas no pueden ser menores a las ya registradas ({packageToEdit.sessions_count}).
              </p>
            ) : null}
            {previousInitialPayment > 0 ? (
              <p className="text-[11px] text-amber-700/80 pt-1 border-t border-amber-200/60 mt-1">
                Este paquete tiene un abono registrado en Finanzas: cambiar el monto o renombrar el paquete requiere un administrador con acceso a Finanzas.
              </p>
            ) : null}
          </div>
        )}

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
                  min={minSessions}
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
            {isEditing ? (
              <p className="text-[11px] text-gray-500">
                Es independiente de los pagos por sesión. Reducirlo a $0 requerirá confirmación explícita porque elimina su registro en Finanzas.
              </p>
            ) : null}
          </div>

          {!isEditing ? (
            <TreatmentFinanceOptions
              amount={previewInitial}
              patientName={patientName}
              value={financePosting}
              onChange={setFinancePosting}
              mandatory
            />
          ) : null}

          <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-3 text-xs text-gray-600 space-y-1" aria-label="Resumen financiero del paquete">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Resumen</p>
            <div className="flex justify-between"><span>Costo total</span><span className="font-semibold text-gray-800">${previewCost.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Abono inicial</span><span className="font-semibold text-gray-800">${previewInitial.toFixed(2)}</span></div>
            {isEditing ? (
              <div className="flex justify-between"><span>Pagos por sesión (ya registrados)</span><span className="font-semibold text-gray-800">${sessionsPaid.toFixed(2)}</span></div>
            ) : null}
            <div className="flex justify-between border-t border-gray-200 pt-1"><span>Total pagado</span><span className="font-semibold text-gray-800">${previewTotalPaid.toFixed(2)}</span></div>
            <div className="flex justify-between">
              <span>Saldo pendiente</span>
              <span className={`font-semibold ${previewBalance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                {previewBalance > 0 ? `$${previewBalance.toFixed(2)}` : 'Pagado'}
              </span>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 p-2.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="flex-1 p-2.5 rounded-lg bg-[#deb887] text-white hover:bg-[#c5a075] font-medium disabled:opacity-60">
              {saving ? (isEditing ? 'Guardando...' : 'Creando...') : (isEditing ? 'Guardar Cambios' : 'Crear Paquete')}
            </button>
          </div>
        </form>
      </motion.div>

      <ConfirmationDialog
        open={confirmRemoveOpen}
        title="Quitar el abono inicial"
        description={<>Vas a reducir el abono inicial de <strong>{name || 'este paquete'}</strong> de ${previousInitialPayment.toFixed(2)} a $0.</>}
        detail="Esto eliminará su registro en Finanzas. Los pagos por sesión, ya independientes, no se ven afectados. Esta acción requiere confirmación explícita."
        confirmLabel="Quitar abono y confirmar"
        variant="danger"
        busy={saving}
        onClose={() => setConfirmRemoveOpen(false)}
        onConfirm={() => void handleConfirmRemoveInitialPayment()}
      />
    </Dialog>
  );
}
