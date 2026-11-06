import { useEffect, useRef, useState } from 'react';
import recordsFetch from '../../utils/recordsFetch';

interface Props {
  userId: number;
  clinicEnabled: boolean;
}

export default function UserSkinVisualPermission({ userId, clinicEnabled }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const counter = generation;
    const token = ++counter.current;
    const controller = new AbortController();
    setLoaded(false); setSaving(false); setEnabled(false); setError(''); setMessage('');
    void (async () => {
      try {
        const response = await recordsFetch(`/api/admin-auth?action=getUserModuleOverrides&userId=${userId}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudieron consultar los permisos.');
        if (!Array.isArray(data.overrides)) throw new Error('La respuesta de permisos no es válida.');
        if (generation.current !== token) return;
        setEnabled(data.overrides.some((item: { feature?: string; enabled?: boolean }) =>
          item.feature === 'skin_visual_ai' && item.enabled === true));
        setLoaded(true);
      } catch (reason) {
        if (controller.signal.aborted || generation.current !== token) return;
        setError(reason instanceof Error ? reason.message : 'No se pudieron consultar los permisos.');
      }
    })();
    return () => { counter.current++; controller.abort(); };
  }, [userId]);

  const save = async () => {
    const token = generation.current;
    const next = !enabled;
    setSaving(true); setError(''); setMessage('');
    try {
      const response = await recordsFetch('/api/admin-auth?action=setUserModuleOverride', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, feature: 'skin_visual_ai', enabled: next }),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error(data.error || 'No se pudo guardar el permiso.');
      if (generation.current !== token) return;
      setEnabled(next);
      setMessage(next ? 'Permiso individual habilitado.' : 'Permiso individual revocado.');
    } catch (reason) {
      if (generation.current === token) setError(reason instanceof Error ? reason.message : 'No se pudo guardar el permiso.');
    } finally {
      if (generation.current === token) setSaving(false);
    }
  };

  return <section aria-label="Permiso individual de análisis Gemini" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
    <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-amber-950">
      <input type="checkbox" checked={enabled} disabled={!loaded || saving || (!clinicEnabled && !enabled)}
        onChange={() => { void save(); }} className="h-4 w-4 accent-gold" />
      Análisis visual Gemini para este usuario
    </label>
    <p className="text-xs text-amber-900">Requiere activación explícita: no se hereda de la clínica. Tope contable de USD 5 por usuario/mes, sujeto al límite global del servicio.</p>
    {!clinicEnabled && <p className="text-xs text-amber-900">Habilita también «Análisis visual Gemini» en los módulos de la clínica. Puedes revocar el permiso aunque la clínica esté deshabilitada.</p>}
    <p className="text-xs text-amber-900">Este permiso no activa Billing ni elimina el interruptor global. Las fotos solo se envían tras confirmación del usuario.</p>
    <p className="text-xs text-amber-900">La activación con pacientes requiere resolver las condiciones contractuales y de protección de datos del proveedor; el descargo y la revisión humana no sustituyen esos requisitos.</p>
    {saving && <p role="status" className="text-xs">Guardando permiso…</p>}
    {message && <p role="status" className="text-xs text-green-800">{message}</p>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </section>;
}
