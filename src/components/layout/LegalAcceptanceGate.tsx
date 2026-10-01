import { useEffect, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { LEGAL_VERSION } from '../legal/LegalLayout';

const ACCEPTED_KEY = 'bioskin_legal_accepted';

/** Bloquea el panel hasta que el usuario acepte la versión vigente de Condiciones y Política; la evidencia queda en el servidor. */
export default function LegalAcceptanceGate() {
  const { isAuthenticated, user, logout } = useAuth();
  const [version, setVersion] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');

  useEffect(() => {
    if (!isAuthenticated || user?.role === 'master_admin') { setVersion(null); setChecking(false); setCheckError(''); return; }
    const token = sessionStorage.getItem('adminSessionToken');
    if (!token) { setCheckError('No se encontró una sesión válida. Cierre sesión e ingrese nuevamente.'); return; }
    if (sessionStorage.getItem(ACCEPTED_KEY) === `${user?.id}:${LEGAL_VERSION}`) return;
    setChecking(true);
    setCheckError('');
    fetch('/api/admin-auth?action=legalStatus', { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        const data = await r.json();
        if (!r.ok || (!data?.required && !data?.success)) throw new Error(data?.error || 'Respuesta inválida al verificar la aceptación.');
        return data;
      })
      .then(d => {
        if (d?.required) setVersion(d.version);
        else if (d?.success) sessionStorage.setItem(ACCEPTED_KEY, `${user?.id}:${d.version}`);
      })
      .catch(() => setCheckError('No se pudo verificar la aceptación de los documentos legales. Revise su conexión e intente nuevamente.'))
      .finally(() => setChecking(false));
  }, [isAuthenticated, user?.id, user?.role]);

  if (!version && !checking && !checkError) return null;

  if (!version) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="legal-check-title">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 text-center space-y-4">
          <ShieldCheck aria-hidden="true" className="mx-auto h-8 w-8 text-gold-dark" />
          <h2 id="legal-check-title" className="text-lg font-bold text-gray-900">Verificando documentos legales</h2>
          {checking ? <Loader2 aria-hidden="true" className="mx-auto h-5 w-5 animate-spin text-gold-dark" /> : <p className="text-sm text-red-600" role="alert">{checkError}</p>}
          {checkError && <button type="button" onClick={() => window.location.reload()} className="w-full py-2.5 rounded-xl bg-gold text-white text-sm font-semibold">Reintentar</button>}
        </div>
      </div>
    );
  }

  const accept = async () => {
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/admin-auth?action=acceptLegal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
        body: JSON.stringify({ version, accepted: true }),
      });
      const d = await r.json();
      if (!r.ok || d.required) throw new Error(d.error || 'No se pudo registrar la aceptación');
      sessionStorage.setItem(ACCEPTED_KEY, `${user?.id}:${version}`);
      setVersion(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la aceptación');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="legal-gate-title">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gold/15 rounded-xl"><ShieldCheck className="w-6 h-6 text-gold-dark" /></div>
          <h2 id="legal-gate-title" className="text-lg font-bold text-gray-900">Actualizamos nuestros documentos legales</h2>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          Para continuar usando BioSkinTech debes leer y aceptar la versión vigente ({version}) de las Condiciones de Servicio
          y la Política de Privacidad. Incluyen cambios sobre respaldos, inteligencia artificial, proveedores tecnológicos y
          responsabilidades de la clínica frente a los datos de sus pacientes.
        </p>
        <div className="flex gap-3 text-sm">
          <a href="/condiciones-de-servicio" target="_blank" rel="noopener noreferrer" className="text-gold-dark font-semibold hover:underline">Condiciones de Servicio</a>
          <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="text-gold-dark font-semibold hover:underline">Política de Privacidad</a>
        </div>
        <label className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="mt-0.5 w-4 h-4 accent-gold" />
          <span className="text-xs text-gray-700 leading-relaxed">
            He leído y acepto las Condiciones de Servicio y la Política de Privacidad. Entiendo que mi aceptación queda registrada con fecha, versión, dirección IP y navegador.
          </span>
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={logout} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Cerrar sesión</button>
          <button onClick={accept} disabled={!checked || saving}
            className="flex-1 py-2.5 rounded-xl bg-gold text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}Aceptar y continuar
          </button>
        </div>
      </div>
    </div>
  );
}
