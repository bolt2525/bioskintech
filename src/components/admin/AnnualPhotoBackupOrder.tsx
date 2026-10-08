import { useId, useState } from 'react';
import type { AnnualPhotoBackupQuote, AnnualPhotoBackupRequest } from '../../types';
import { annualMoney, annualOriginalSize, manualQuoteCents } from '../../utils/annualPhotoBackup';
import { Dialog } from '../ui/Dialog';

export interface AnnualOrderCommand {
  action: 'quotePhotoBackup' | 'acceptPhotoBackupQuote' | 'confirmPhotoBackupPayment' | 'retryPhotoBackupNotifications';
  body: { requestId: string; clinicId: string; manualTotalCents?: number; acceptanceConfirmed?: true; paymentConfirmed?: true; paymentReference?: string };
}

interface Props {
  item: AnnualPhotoBackupRequest;
  busy: boolean;
  execute: (command: AnnualOrderCommand) => Promise<AnnualPhotoBackupQuote | undefined>;
}

const buttonClass = 'min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-gold-dark disabled:opacity-50';

/** Solo proveedor: cada paso requiere una acción explícita; no confirma pagos al cotizar. */
export default function AnnualPhotoBackupOrder({ item, busy, execute }: Props) {
  const titleId = useId();
  const [quote, setQuote] = useState<AnnualPhotoBackupQuote | null>(null);
  const [manualTotal, setManualTotal] = useState('');
  const [confirmation, setConfirmation] = useState<'accept' | 'payment' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [paymentReference, setPaymentReference] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const disabled = busy || working;
  const bytes = quote ? quote.quote_complete ? quote.original_total_bytes : null : item.original_total_bytes;
  const total = quote ? quote.quote_complete ? quote.quote_total_cents : null : item.quote_total_cents;
  const complete = Number.isSafeInteger(bytes) && bytes! >= 0 && Number.isSafeInteger(total) && total! > 0;
  const unpaid = item.entitlement_kind === 'PAID' && ['PAYMENT_PENDING', 'NEEDS_QUOTE'].includes(item.status) && item.payment_status !== 'PAID';
  const manualNeeded = unpaid && typeof bytes === 'number' && bytes > 50e9 && !item.quote_accepted_at;

  const run = async (action: AnnualOrderCommand['action'], extra: Partial<AnnualOrderCommand['body']> = {}) => {
    if (disabled) return;
    setWorking(true); setError('');
    try {
      const result = await execute({ action, body: { ...extra, requestId: item.id, clinicId: item.clinic_id } });
      if (action === 'quotePhotoBackup' && result) setQuote(result);
      setConfirmation(null); setConfirmed(false); setPaymentReference('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo registrar la operación; actualiza para verificar el estado.');
    } finally { setWorking(false); }
  };

  return <div className="mt-3 space-y-3">
    {unpaid && <>
      <p className="text-sm">{annualOriginalSize(bytes)} · {annualMoney(total)}{complete && ' · USD, IVA incluido'}</p>
      {quote && !quote.quote_complete && <p role="status" className="text-sm text-amber-950">Medición parcial de originales. Continúa la cotización; todavía no hay un precio final ni se puede registrar aceptación o pago.</p>}
      <div className="flex flex-wrap gap-2">
        {!item.quote_accepted_at && <button type="button" disabled={disabled} className={buttonClass} onClick={() => void run('quotePhotoBackup')}>{quote && !quote.quote_complete ? 'Continuar cotización' : 'Calcular cotización'}</button>}
        {!item.quote_accepted_at && <button type="button" disabled={disabled || !complete} className={buttonClass} onClick={() => { setConfirmation('accept'); setConfirmed(false); }}>Registrar aceptación</button>}
        <button type="button" disabled={disabled || !complete || !item.quote_accepted_at} className={buttonClass} onClick={() => { setConfirmation('payment'); setConfirmed(false); }}>Confirmar pago recibido</button>
      </div>
      {manualNeeded && <form className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3" onSubmit={event => {
        event.preventDefault();
        try { void run('quotePhotoBackup', { manualTotalCents: manualQuoteCents(manualTotal) }); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Total USD inválido'); }
      }}>
        <label className="block text-sm">Total final cotizado para más de 50 GB (USD, IVA incluido)
          <input name="manual_quote_usd" inputMode="decimal" autoComplete="off" value={manualTotal} onChange={event => setManualTotal(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 focus-visible:ring-2 focus-visible:ring-gold-dark" />
        </label>
        <button disabled={disabled} className={buttonClass}>Registrar cotización manual</button>
      </form>}
    </>}
    {item.notification_error && <button type="button" disabled={disabled} className={buttonClass} onClick={() => void run('retryPhotoBackupNotifications')}>Reintentar avisos por correo</button>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {confirmation && <Dialog open onClose={() => { if (!disabled) setConfirmation(null); }} labelledBy={titleId} className="w-full sm:w-[32rem]">
      <div className="space-y-3 rounded-xl bg-white p-5">
        <h3 id={titleId} className="text-lg font-semibold">{confirmation === 'accept' ? 'Registrar aceptación de la cotización' : 'Confirmar pago recibido'}</h3>
        <p className="text-sm">{annualMoney(total)} · USD, IVA incluido. Esta acción registra evidencia del proveedor; no cobra automáticamente ni inicia la preparación.</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="provider_confirmation" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 focus-visible:ring-2 focus-visible:ring-gold-dark" />
          {confirmation === 'accept' ? 'Confirmo que la clínica aceptó esta cotización y conservo la constancia verificable.' : 'Confirmo que verifiqué la recepción del pago y su referencia.'}
        </label>
        {confirmation === 'payment' && <label className="block text-sm">Referencia verificable de pago
          <input name="payment_reference" autoComplete="off" maxLength={200} value={paymentReference} onChange={event => setPaymentReference(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 focus-visible:ring-2 focus-visible:ring-gold-dark" />
        </label>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={disabled || !confirmed || (confirmation === 'payment' && (paymentReference.trim().length < 3 || [...paymentReference].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))} className={buttonClass} onClick={() => void run(
            confirmation === 'accept' ? 'acceptPhotoBackupQuote' : 'confirmPhotoBackupPayment',
            confirmation === 'accept' ? { acceptanceConfirmed: true } : { paymentConfirmed: true, paymentReference: paymentReference.trim() },
          )}>Confirmar registro</button>
          <button type="button" disabled={disabled} className={buttonClass} onClick={() => setConfirmation(null)}>Cancelar</button>
        </div>
      </div>
    </Dialog>}
  </div>;
}
