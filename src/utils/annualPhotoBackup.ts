import type { AnnualPhotoBackupRequest, AnnualPhotoBackupStatus } from '../types';

/** configured = registro SMTP/schema; nunca implica disponibilidad del Worker. */
export function annualCanRequest(status: AnnualPhotoBackupStatus | null): boolean {
  return status?.configured === true && status.can_request === true;
}

export function annualCanApprove(item: AnnualPhotoBackupRequest, processorReady: boolean): boolean {
  return processorReady && ['PENDING', 'APPROVED', 'FAILED'].includes(item.status) &&
    (item.entitlement_kind !== 'PAID' || item.payment_status === 'PAID');
}

export function annualMoney(cents: number | null | undefined): string {
  return Number.isSafeInteger(cents) && cents! > 0
    ? new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(cents! / 100)
    : 'Cotización pendiente';
}

export function annualOriginalSize(bytes: number | null | undefined): string {
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
    ? `${new Intl.NumberFormat('es-EC', { maximumFractionDigits: 3 }).format(bytes / 1e9)} GB originales`
    : 'Tamaño pendiente';
}

export function manualQuoteCents(value: string): number {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) throw new Error('Indica un total USD positivo, con hasta dos decimales.');
  const cents = Math.round(Number(value.replace(',', '.')) * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 100000000)
    throw new Error('El total USD debe ser positivo y no superar 1.000.000.');
  return cents;
}

export const ANNUAL_STATUS_LABELS: Record<AnnualPhotoBackupRequest['status'], string> = {
  PENDING: 'Pendiente de autorización', PAYMENT_PENDING: 'Cotización o pago pendiente', NEEDS_QUOTE: 'Requiere cotización',
  APPROVED: 'Autorizado', PROCESSING: 'Preparando archivos', READY: 'Disponible para descargar',
  EXPIRED: 'Descarga vencida', REJECTED: 'Rechazado', CANCELLED: 'Cancelado', FAILED: 'Requiere revisión',
};
