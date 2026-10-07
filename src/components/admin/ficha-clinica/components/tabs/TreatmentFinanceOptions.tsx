import { AlertTriangle, BadgeDollarSign, FileWarning } from 'lucide-react';
import type { FinancePostingOptions } from '../../types/treatment';

interface TreatmentFinanceOptionsProps {
  amount: number;
  patientName?: string;
  value: FinancePostingOptions;
  onChange: (value: FinancePostingOptions) => void;
}

export default function TreatmentFinanceOptions({ amount, patientName, value, onChange }: TreatmentFinanceOptionsProps) {
  if (amount <= 0) return null;

  const subtotal = value.includes_iva ? amount / 1.15 : amount;
  const tax = value.includes_iva ? amount - subtotal : 0;

  return (
    <section className={`rounded-xl border-2 p-4 transition-colors ${value.enabled ? 'border-gold bg-gold/10' : 'border-amber-200 bg-amber-50/60'}`}>
      <label className="admin-focus-ring flex cursor-pointer items-start gap-3 rounded-lg">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={event => onChange({ ...value, enabled: event.target.checked })}
          className="mt-1 h-5 w-5 rounded border-amber-400 text-gold-dark focus:ring-gold"
        />
        <span>
          <span className="flex items-center gap-2 font-semibold text-gray-900">
            <BadgeDollarSign className="h-5 w-5 text-gold-ink" aria-hidden="true" />
            Registrar este cobro en Finanzas
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">
            Se enviará ${amount.toFixed(2)}{patientName ? ` a nombre de ${patientName}` : ''} con la fecha, consulta y referencia de esta sesión o paquete.
          </span>
        </span>
      </label>

      {value.enabled ? (
        <div className="mt-4 space-y-4 border-t border-gold/30 pt-4">
          <label className={`admin-focus-ring flex cursor-pointer items-center justify-between gap-4 rounded-xl border-2 p-3 ${value.includes_iva ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white'}`}>
            <span>
              <span className="block text-sm font-semibold text-gray-900">El monto incluye IVA 15%</span>
              <span className="block text-xs text-gray-500">
                {value.includes_iva ? 'Se desglosará el IVA incluido en el total.' : 'Sin seleccionar: tarifa IVA 0%.'}
              </span>
            </span>
            <input
              type="checkbox"
              checked={value.includes_iva}
              onChange={event => onChange({ ...value, includes_iva: event.target.checked })}
              className="h-6 w-6 shrink-0 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
          </label>

          <div className="grid grid-cols-3 gap-2 rounded-xl bg-white p-3 text-right text-xs">
            <div><span className="block text-gray-400">Subtotal</span><strong>${subtotal.toFixed(2)}</strong></div>
            <div><span className="block text-gray-400">IVA</span><strong>${tax.toFixed(2)}</strong></div>
            <div><span className="block text-gray-400">Total</span><strong>${amount.toFixed(2)}</strong></div>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
              <FileWarning className="h-4 w-4 text-amber-600" aria-hidden="true" />
              Número de factura (opcional)
            </label>
            <input
              type="text"
              maxLength={100}
              value={value.invoice_number}
              onChange={event => onChange({ ...value, invoice_number: event.target.value })}
              placeholder="Pendiente de registrar"
              className={`admin-focus-ring w-full rounded-lg border px-3 py-2 text-sm ${value.invoice_number.trim() ? 'border-gray-200 bg-white' : 'border-amber-400 bg-amber-50'}`}
            />
            {!value.invoice_number.trim() ? (
              <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Se guardará como cobro sin número de factura.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
