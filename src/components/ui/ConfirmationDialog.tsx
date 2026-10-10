import { useId, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
import { Dialog } from './Dialog';

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  detail?: ReactNode;
  variant?: 'default' | 'danger';
  busy?: boolean;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  detail,
  variant = 'default',
  busy = false,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const Icon = variant === 'danger' ? Trash2 : CheckCircle2;

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      labelledBy={titleId}
      describedBy={descriptionId}
    >
      <div className="w-[min(28rem,calc(100vw-2rem))] rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start gap-4">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            variant === 'danger' ? 'bg-red-50 text-red-600' : 'bg-gold/15 text-gold-ink'
          }`}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-pretty text-lg font-semibold text-gray-900">{title}</h2>
            <div id={descriptionId} className="mt-1 text-pretty text-sm leading-6 text-gray-600">{description}</div>
          </div>
        </div>

        {detail ? (
          <div className={`mt-5 rounded-xl border p-4 text-sm ${
            variant === 'danger' ? 'border-red-100 bg-red-50/70 text-red-900' : 'border-gold/30 bg-gold/10 text-gray-800'
          }`}>
            {detail}
          </div>
        ) : null}

        {variant === 'danger' ? (
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Esta acción no se puede deshacer.
          </p>
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="admin-focus-ring min-h-11 rounded-xl border border-gray-200 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`admin-focus-ring min-h-11 rounded-xl px-4 text-sm font-semibold text-white shadow-sm disabled:opacity-60 ${
              variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-gold-dark hover:bg-gold-ink'
            }`}
          >
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
