import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnualPhotoBackupProviderStatus } from '../types';
import recordsFetch from '../utils/recordsFetch';

/** Solo metadatos administrativos, sin manifiestos ni pacientes. */
export function useAnnualPhotoProviderStatus(enabled: boolean) {
  const [status, setStatus] = useState<AnnualPhotoBackupProviderStatus | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const invalidate = useCallback(() => ++revision.current, []);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = invalidate();
    try {
      const response = await recordsFetch('/api/backup?action=listPhotoBackupRequests');
      const result: AnnualPhotoBackupProviderStatus = await response.json();
      if (!response.ok || !Array.isArray(result.requests)) throw new Error('Estado anual no disponible');
      if (current === revision.current) { setStatus(result); setError(''); }
    } catch {
      // No convertir un fallo de consulta en "cero pendientes".
      if (current === revision.current)
        setError('No se pudo actualizar el contador anual. Abre Respaldos anuales para reintentar.');
    }
  }, [enabled, invalidate]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => { invalidate(); window.clearInterval(timer); };
  }, [enabled, refresh, invalidate]);
  const update = useCallback((next: AnnualPhotoBackupProviderStatus) => { invalidate(); setStatus(next); setError(''); }, [invalidate]);
  const pendingCount = typeof status?.pending_count === 'number' ? status.pending_count : null;
  const failedCount = new Set([
    ...(status?.notifications?.filter(item => item.status === 'FAILED').map(item => item.request_id) || []),
    ...(status?.requests.filter(item => item.notification_error).map(item => item.id) || []),
  ]).size;
  return { status, update, refresh, pendingCount, failedCount, error };
}
