import { useCallback, useEffect, useRef, useState } from 'react';
import recordsFetch from '../../utils/recordsFetch';

type Channel = {
  phone_number: string;
  status: 'pending_validation' | 'setup_failed' | 'disconnected';
};
type Connection = { authorized: boolean; enabled: boolean; channel: Channel | null; message?: string };
type Signup = { state: string; appId: string; configId: string; version: string };
type MetaResponse = { authResponse?: { code?: string } };
type FacebookSDK = {
  init(options: { appId: string; version: string; cookie: boolean; xfbml: boolean }): void;
  login(callback: (response: MetaResponse) => void, options: {
    config_id: string; response_type: 'code'; override_default_response_type: true;
    extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
  }): void;
};
declare global {
  interface Window { FB?: FacebookSDK; }
}

let sdkPromise: Promise<FacebookSDK> | undefined;
function loadSDK() {
  if (window.FB) return Promise.resolve(window.FB);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FacebookSDK>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/es_LA/sdk.js';
    script.async = true;
    const timeout = window.setTimeout(() => finish(false), 15000);
    const finish = (loaded: boolean) => {
      window.clearTimeout(timeout);
      if (loaded && window.FB) resolve(window.FB);
      else {
        script.remove();
        sdkPromise = undefined;
        reject(new Error('No se pudo cargar el login de Meta. Revisa los bloqueadores del navegador.'));
      }
    };
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  });
  return sdkPromise;
}

async function request(action: string, body?: object) {
  const response = await recordsFetch(`/api/whatsapp-chatbot?action=${action}`, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo consultar la conexión de WhatsApp.');
  return data;
}

export default function WhatsAppCoexistence() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [signup, setSignup] = useState<Signup | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const active = useRef(false);
  const session = useRef<{ code?: string; wabaId?: string; phoneNumberId?: string; submitted?: boolean }>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    const data: Connection = await request('channelConfig');
    setConnection(data);
  }, []);

  useEffect(() => {
    active.current = true;
    refresh().catch(error => { if (active.current) setMessage(error.message); });
    return () => { active.current = false; clearTimeout(timer.current); };
  }, [refresh]);

  const complete = useCallback(async () => {
    const result = session.current;
    if (!signup || !result.code || !result.wabaId || result.submitted) return;
    result.submitted = true;
    clearTimeout(timer.current);
    try {
      await request('channelComplete', { ...result, state: signup.state });
      if (active.current) setMessage('Autorización recibida. Sincronización solicitada; validación y envíos todavía pendientes.');
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : 'No se pudo completar la conexión.');
    } finally {
      if (active.current) {
        setBusy(false);
        setSignup(null);
        refresh().catch(error => setMessage(error.message));
      }
    }
  }, [signup, refresh]);

  useEffect(() => {
    if (!signup) return;
    const receive = (event: MessageEvent) => {
      if (!busy || !['https://www.facebook.com', 'https://web.facebook.com'].includes(event.origin)) return;
      let data: unknown = event.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return; }
      }
      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'WA_EMBEDDED_SIGNUP' || !('event' in data)) return;
      if (data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' && 'data' in data
          && data.data && typeof data.data === 'object' && 'waba_id' in data.data && typeof data.data.waba_id === 'string') {
        session.current.wabaId = data.data.waba_id;
        if ('phone_number_id' in data.data && typeof data.data.phone_number_id === 'string') session.current.phoneNumberId = data.data.phone_number_id;
        void complete();
      } else if (['CANCEL', 'ERROR', 'FINISH', 'FINISH_ONLY_WABA'].includes(String(data.event))) {
        session.current.submitted = true;
        clearTimeout(timer.current);
        setBusy(false);
        setSignup(null);
        setMessage('Conexión cancelada o flujo no compatible. Elige un número existente de la app WhatsApp Business.');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [signup, busy, complete]);

  const prepare = async () => {
    setBusy(true);
    setMessage('');
    try {
      const data: Signup = await request('channelStart', {});
      const sdk = await loadSDK();
      sdk.init({ appId: data.appId, version: data.version, cookie: false, xfbml: false });
      if (active.current) setSignup(data);
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : 'No se pudo preparar el login.');
    } finally { if (active.current) setBusy(false); }
  };

  const launch = () => {
    if (!signup || !window.FB) return;
    session.current = {};
    const flow = session.current;
    setBusy(true);
    setMessage('Completa la conexión en la ventana de Meta. No cierres esta página.');
    timer.current = setTimeout(() => {
      if (active.current) {
        flow.submitted = true;
        setBusy(false);
        setSignup(null);
        setMessage('La conexión no terminó. Prepara otro intento y permite las ventanas emergentes de Meta.');
      }
    }, 5 * 60 * 1000);
    try {
      window.FB.login(response => {
        if (!active.current || session.current !== flow || flow.submitted) return;
        const code = response.authResponse?.code;
        if (code) {
          session.current.code = code;
          void complete();
        } else {
          flow.submitted = true;
          clearTimeout(timer.current);
          setBusy(false);
          setSignup(null);
          setMessage('No se recibió la autorización de Meta. Puedes volver a intentarlo.');
        }
      }, { config_id: signup.configId, response_type: 'code', override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } });
    } catch {
      flow.submitted = true;
      clearTimeout(timer.current);
      setBusy(false);
      setSignup(null);
      setMessage('No se pudo abrir el login de Meta. Revisa el navegador y prepara otra conexión.');
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await request('channelDisconnect', {});
      setConfirmDisconnect(false);
      setMessage('Credencial eliminada de BIOSKIN. Completa la desconexión también en WhatsApp Business → Ajustes → Cuenta → Plataforma empresarial.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo desconectar.');
    } finally { setBusy(false); }
  };

  if ((!connection && !message) || (connection && !connection.authorized)) return null;
  const connected = connection?.channel && connection.channel.status !== 'disconnected';
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3" aria-label="WhatsApp coexistencia" aria-busy={busy}>
      <h2 className="text-base font-semibold text-gray-900">WhatsApp coexistencia</h2>
      <p className="text-sm text-gray-600">Usa tu WhatsApp Business sin dejar de utilizar la app del teléfono. El chatbot del sistema sigue siendo independiente.</p>
      <p className="text-sm text-amber-800">Piloto: recordatorios a pacientes desactivados. No se enviarán desde el número del sistema.</p>
      {connected ? (
        <>
          <p className="text-sm font-medium text-gray-800">{connection.channel?.phone_number}</p>
          <p className="text-sm text-gray-600">{connection.channel?.status === 'setup_failed'
            ? 'Configuración incompleta. Revisa la conexión con el proveedor antes de volver a vincular.'
            : 'Autorización guardada. Pendiente validar sincronización, webhooks y plantillas.'}</p>
          {confirmDisconnect ? <div className="space-y-2">
              <p className="text-sm text-gray-700">¿Eliminar la credencial de BIOSKIN? Esto no revoca por sí solo el acceso otorgado en Meta ni desconecta la app del teléfono.</p>
              <button type="button" disabled={busy} onClick={disconnect} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-50">Confirmar desconexión</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDisconnect(false)} className="ml-2 rounded-lg border px-3 py-2 text-sm">Cancelar</button>
            </div> : <button type="button" disabled={busy} onClick={() => setConfirmDisconnect(true)} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700">Desconectar de BIOSKIN</button>
          }
        </>
      ) : connection?.enabled ? (
        <>
          <p className="text-sm text-gray-600">Requiere la app WhatsApp Business, no WhatsApp personal. No importamos conversaciones ni contactos al CRM durante este piloto.</p>
          <button type="button" disabled={busy} onClick={signup ? launch : prepare}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
            {busy ? 'Conectando…' : signup ? 'Continuar con Meta' : 'Preparar conexión de WhatsApp Business'}
          </button>
        </>
      ) : <p className="text-sm text-gray-600">{connection?.message || 'Consultando disponibilidad…'}</p>}
      {message && <p role="status" className="text-sm text-gray-700 break-words">{message}</p>}
    </section>
  );
}
