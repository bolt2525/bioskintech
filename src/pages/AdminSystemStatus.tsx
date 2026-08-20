import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, Database, Mail, Calendar, CheckCircle2, XCircle,
  Loader2, RefreshCw, ChevronDown, ChevronUp, Server,
  Shield, Clock, User, Info, Link2, Link2Off, Send,
  CreditCard, AlertTriangle, Sparkles,
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';

interface CheckResult { success: boolean; logs?: string[]; latency_ms?: number; code?: string; }
interface AllChecks   { db?: CheckResult; calendar?: CheckResult; email?: CheckResult; }
interface StatusData  { success: boolean; role: string; username: string; checks: AllChecks; }
interface UserStatus  {
  success: boolean;
  clinic_name: string | null;
  subscription_expires_at: string | null;
  days_remaining: number | null;
  status: 'active' | 'expiring_soon' | 'expired' | 'no_subscription' | 'demo' | 'master';
  is_demo: boolean;
  demo_expires_at: string | null;
}

const fetch$ = (url: string) =>
  fetch(url, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` } });

// ── Tarjeta de servicio (solo para master) ────────────────────────────────────
const ServiceCard = ({
  name, icon: Icon, iconBg, result, onCheck, loading,
}: { name: string; icon: React.ComponentType<{ className?: string }>; iconBg: string; result?: CheckResult; onCheck: () => void; loading: boolean; }) => {
  const [showLogs, setShowLogs] = useState(false);
  const statusColor = result === undefined ? 'bg-gray-100 text-gray-500'
    : result.success ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-red-50 text-red-700 border-red-200';
  const StatusIcon = result === undefined ? null : result.success ? CheckCircle2 : XCircle;
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className={`bg-white rounded-2xl border p-5 shadow-sm ${result?.success === false ? 'border-red-200' : result?.success ? 'border-emerald-200' : 'border-gray-200'}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${iconBg}`}><Icon className="w-5 h-5" /></div>
          <div>
            <p className="font-semibold text-gray-800">{name}</p>
            {result?.latency_ms !== undefined && <p className="text-xs text-gray-400">{result.latency_ms}ms</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {StatusIcon && (
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium border flex items-center gap-1 ${statusColor}`}>
              <StatusIcon className="w-3.5 h-3.5" />{result!.success ? 'Conectado' : 'Error'}
            </span>
          )}
          {!result && <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Sin verificar</span>}
          <button onClick={onCheck} disabled={loading} className="p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
          </button>
        </div>
      </div>
      {result?.logs && result.logs.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowLogs(p => !p)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600">
            {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showLogs ? 'Ocultar' : 'Ver'} logs ({result.logs.length})
          </button>
          <AnimatePresence>
            {showLogs && (
              <motion.pre initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                className="mt-2 text-xs bg-gray-900 text-green-400 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                {result.logs.join('\n')}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
};

// ── Vista de usuario (suscripción + Gmail) ────────────────────────────────────
function UserStatusView({ isClinicAdmin, user }: { isClinicAdmin: boolean; user: any }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [emailConn, setEmailConn] = useState<{ connected: boolean; email: string | null; connected_at: string | null; clinic_email: string | null; } | null>(null);
  const [loadingEmailConn, setLoadingEmailConn] = useState(false);
  const [emailConnMsg, setEmailConnMsg] = useState<string | null>(null);

  const fetchUserStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch$('/api/system-status?type=user-status');
      const data: UserStatus = await res.json();
      if (data.success) setUserStatus(data);
    } catch { /* non-fatal */ }
    finally { setLoadingStatus(false); }
  }, []);

  const fetchEmailConn = useCallback(async () => {
    if (!user?.clinic_id) return;
    setLoadingEmailConn(true);
    try {
      const res = await fetch$(`/api/admin-auth?action=getEmailConnectionStatus&clinicId=${user.clinic_id}`);
      const data = await res.json();
      if (data.success) setEmailConn(data);
    } catch { /* non-fatal */ }
    finally { setLoadingEmailConn(false); }
  }, [user?.clinic_id]);

  const handleConnectEmail = async () => {
    setLoadingEmailConn(true);
    try {
      const res = await fetch('/api/admin-auth?action=oauthStart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
        body: JSON.stringify({ clinicId: user.clinic_id, returnPath: '/gestionestetica/admin/system-status' }),
      });
      const d = await res.json();
      if (d.url) window.location.href = d.url;
      else setEmailConnMsg(d.error || 'Error al iniciar conexión');
    } catch { setEmailConnMsg('Error de conexión'); }
    finally { setLoadingEmailConn(false); }
  };

  const handleResendLink = async () => {
    setLoadingEmailConn(true);
    try {
      const res = await fetch('/api/admin-auth?action=sendEmailConnectionLink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
        body: JSON.stringify({ clinicId: user.clinic_id }),
      });
      const d = await res.json();
      setEmailConnMsg(d.success ? '✓ Enlace enviado a tu correo' : (d.error || 'Error al enviar'));
    } catch { setEmailConnMsg('Error de conexión'); }
    finally { setLoadingEmailConn(false); }
  };

  useEffect(() => {
    fetchUserStatus();
    fetchEmailConn();
    // Detectar retorno exitoso del OAuth de Google
    const params = new URLSearchParams(location.search);
    if (params.get('oauth') === 'success') {
      setEmailConnMsg('\u2713 Gmail conectado correctamente');
      navigate(location.pathname, { replace: true }); // limpiar query param
    }
  }, [fetchUserStatus, fetchEmailConn]); // eslint-disable-line react-hooks/exhaustive-deps

  const badge = (() => {
    if (!userStatus) return null;
    const { status, days_remaining } = userStatus;
    if (status === 'demo')          return { label: 'Demo',                   color: 'bg-blue-100 text-blue-700 border-blue-200',     icon: Sparkles };
    if (status === 'active')        return { label: 'Activa',                 color: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 };
    if (status === 'expiring_soon') return { label: `Vence en ${days_remaining}d`, color: 'bg-amber-50 text-amber-700 border-amber-200',   icon: AlertTriangle };
    if (status === 'expired')       return { label: 'Vencida',                color: 'bg-red-50 text-red-700 border-red-200',         icon: XCircle };
    return { label: 'Sin suscripción', color: 'bg-gray-100 text-gray-500 border-gray-200', icon: Info };
  })();

  const expiresDate = (dateStr: string | null) =>
    dateStr ? new Date(dateStr).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

  return (
    <div className="space-y-4">
      {/* Card suscripción */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className={`bg-white rounded-2xl border p-5 shadow-sm ${
          !badge ? 'border-gray-200'
          : userStatus?.status === 'expired' ? 'border-red-200'
          : userStatus?.status === 'expiring_soon' ? 'border-amber-200'
          : userStatus?.status === 'demo' ? 'border-blue-200'
          : 'border-emerald-200'
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#deb887]/10"><CreditCard className="w-5 h-5 text-[#c5a075]" /></div>
            <div>
              <p className="font-semibold text-gray-800">Suscripción</p>
              {userStatus?.is_demo && userStatus.demo_expires_at && (
                <p className="text-xs text-gray-400">Demo hasta {expiresDate(userStatus.demo_expires_at)}</p>
              )}
              {!userStatus?.is_demo && userStatus?.subscription_expires_at && (
                <p className="text-xs text-gray-400">Vence el {expiresDate(userStatus.subscription_expires_at)}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {badge && (
              <span className={`px-2.5 py-1 rounded-full text-xs font-medium border flex items-center gap-1 ${badge.color}`}>
                <badge.icon className="w-3.5 h-3.5" />{badge.label}
              </span>
            )}
            {!badge && <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Sin verificar</span>}
            <button onClick={fetchUserStatus} disabled={loadingStatus} className="p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50">
              {loadingStatus ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
            </button>
          </div>
        </div>
        {userStatus?.status === 'expired' && (
          <p className="text-sm text-red-600 mt-1">Tu suscripción ha vencido. Contacta al administrador para renovarla.</p>
        )}
        {userStatus?.status === 'expiring_soon' && (
          <p className="text-sm text-amber-600 mt-1">Tu suscripción vence pronto. Contacta al administrador para renovarla.</p>
        )}
      </motion.div>

      {/* Card Gmail de la clínica */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className={`bg-white rounded-2xl border p-5 shadow-sm ${
          emailConn === null ? 'border-gray-200' : emailConn.connected ? 'border-emerald-200' : 'border-amber-200'
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${emailConn?.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
              {emailConn?.connected ? <Link2 className="w-5 h-5" /> : <Link2Off className="w-5 h-5" />}
            </div>
            <div>
              <p className="font-semibold text-gray-800">Email de la clínica</p>
              {emailConn?.email && <p className="text-xs text-gray-400">{emailConn.email}</p>}
              {!emailConn?.connected && emailConn?.clinic_email && <p className="text-xs text-gray-400">Registrado: {emailConn.clinic_email}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {emailConn !== null && (
              <span className={`px-2.5 py-1 rounded-full text-xs font-medium border flex items-center gap-1 ${
                emailConn.connected ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}>
                {emailConn.connected ? <><CheckCircle2 className="w-3.5 h-3.5" /> Conectado</> : <><XCircle className="w-3.5 h-3.5" /> Desconectado</>}
              </span>
            )}
            {emailConn === null && <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Sin verificar</span>}
            <button onClick={fetchEmailConn} disabled={loadingEmailConn} className="p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50">
              {loadingEmailConn ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
            </button>
          </div>
        </div>
        {/* Solo clinic_admin puede conectar; clinic_user ve estado de solo lectura */}
        {isClinicAdmin && emailConn !== null && !emailConn.connected && (
          <div className="flex gap-2 mt-2">
            <button onClick={handleConnectEmail} disabled={loadingEmailConn}
              className="flex-1 py-2 bg-[#deb887] text-white rounded-lg text-xs font-semibold hover:bg-[#c9a876] disabled:opacity-50 flex items-center justify-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Conectar ahora
            </button>
            <button onClick={handleResendLink} disabled={loadingEmailConn}
              className="flex-1 py-2 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
              <Send className="w-3.5 h-3.5" /> Reenviar link por correo
            </button>
          </div>
        )}
        {emailConnMsg && <p className="mt-2 text-xs text-gray-500">{emailConnMsg}</p>}
      </motion.div>

      {/* Info de cuenta */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
          <User className="w-4 h-4 text-gray-500" />
          <span className="font-semibold text-gray-700 text-sm">Mi cuenta</span>
        </div>
        <div className="divide-y divide-gray-100">
          <div className="flex items-center justify-between p-4">
            <span className="text-sm text-gray-500 flex items-center gap-2"><User className="w-4 h-4" />Usuario</span>
            <span className="text-sm font-medium text-gray-800">{user?.username || '—'}</span>
          </div>
          <div className="flex items-center justify-between p-4">
            <span className="text-sm text-gray-500 flex items-center gap-2"><Shield className="w-4 h-4" />Rol</span>
            <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-blue-100 text-blue-700">
              {user?.role === 'clinic_admin' ? 'Administrador' : 'Usuario'}
            </span>
          </div>
          {userStatus?.clinic_name && (
            <div className="flex items-center justify-between p-4">
              <span className="text-sm text-gray-500 flex items-center gap-2"><Info className="w-4 h-4" />Clínica</span>
              <span className="text-sm font-medium text-gray-800">{userStatus.clinic_name}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function AdminSystemStatus() {
  const { user } = useAuth();
  const isMaster = user?.role === 'master_admin';
  const isClinicAdmin = user?.role === 'clinic_admin';

  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadingCheck, setLoadingCheck] = useState<Record<string, boolean>>({});
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAllChecks = useCallback(async () => {
    setLoadingAll(true);
    setError(null);
    try {
      const res = await fetch$('/api/system-status?type=all');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setStatusData(await res.json());
      setLastRun(new Date().toLocaleTimeString('es-EC'));
    } catch (e: any) {
      setError(e.message || 'Error al verificar servicios');
    } finally { setLoadingAll(false); }
  }, []);

  const runSingleCheck = async (type: string) => {
    setLoadingCheck(p => ({ ...p, [type]: true }));
    try {
      const res  = await fetch$(`/api/system-status?type=${type}`);
      const data: CheckResult = await res.json();
      setStatusData(prev => prev
        ? { ...prev, checks: { ...prev.checks, [type]: data } }
        : { success: data.success, role: user?.role || '', username: user?.username || '', checks: { [type]: data } }
      );
    } catch { /* silent */ }
    finally { setLoadingCheck(p => ({ ...p, [type]: false })); }
  };

  useEffect(() => { if (isMaster) runAllChecks(); }, [isMaster, runAllChecks]);

  // ── Vista clinic_admin / clinic_user ──────────────────────────────────
  if (!isMaster) {
    return (
      <AdminLayout>
        <div className="p-4 md:p-8 max-w-2xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <div className="p-3 rounded-2xl shadow-lg bg-gradient-to-br from-[#deb887] to-[#c5a075]">
              <Activity className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Estado del Sistema</h1>
              <p className="text-sm text-gray-400">Estado de tu cuenta y servicios de la clínica</p>
            </div>
          </div>
          <UserStatusView isClinicAdmin={isClinicAdmin} user={user} />
        </div>
      </AdminLayout>
    );
  }

  // ── Vista master_admin: infra completa ────────────────────────────────
  const allOk = statusData ? Object.values(statusData.checks).every(c => c.success) : null;
  return (
    <AdminLayout>
      <div className="p-4 md:p-8 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-2xl shadow-lg ${allOk === null ? 'bg-gray-200' : allOk ? 'bg-gradient-to-br from-emerald-400 to-emerald-600' : 'bg-gradient-to-br from-red-400 to-red-600'}`}>
              <Activity className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Estado del Sistema</h1>
              {lastRun && <p className="text-sm text-gray-400 flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Última verificación: {lastRun}</p>}
            </div>
          </div>
          <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={runAllChecks} disabled={loadingAll}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50 shadow-sm disabled:opacity-50">
            {loadingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}Verificar todo
          </motion.button>
        </div>

        {statusData && (
          <div className={`mb-6 p-4 rounded-2xl flex items-center gap-3 border ${allOk ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            {allOk ? <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />}
            <p className="font-medium">{allOk ? 'Todos los servicios operando correctamente.' : 'Uno o más servicios con problemas de conexión.'}</p>
          </div>
        )}
        {error && <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm">{error}</div>}

        <div className="space-y-4 mb-8">
          <ServiceCard name="Base de Datos (Neon PostgreSQL)" icon={Database} iconBg="bg-blue-50 text-blue-600"
            result={statusData?.checks?.db} onCheck={() => runSingleCheck('db')} loading={!!loadingCheck['db'] || loadingAll} />
          <ServiceCard name="Correo Electrónico (SMTP)" icon={Mail} iconBg="bg-amber-50 text-amber-600"
            result={statusData?.checks?.email} onCheck={() => runSingleCheck('email')} loading={!!loadingCheck['email'] || loadingAll} />
          <ServiceCard name="Google Calendar" icon={Calendar} iconBg="bg-indigo-50 text-indigo-600"
            result={statusData?.checks?.calendar} onCheck={() => runSingleCheck('calendar')} loading={!!loadingCheck['calendar'] || loadingAll} />
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
            <Server className="w-4 h-4 text-gray-500" />
            <span className="font-semibold text-gray-700 text-sm">Información del Sistema</span>
          </div>
          <div className="divide-y divide-gray-100">
            <div className="flex items-center justify-between p-4">
              <span className="text-sm text-gray-500 flex items-center gap-2"><User className="w-4 h-4" />Usuario activo</span>
              <span className="text-sm font-medium text-gray-800">{user?.username || '—'}</span>
            </div>
            <div className="flex items-center justify-between p-4">
              <span className="text-sm text-gray-500 flex items-center gap-2"><Shield className="w-4 h-4" />Rol</span>
              <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-purple-100 text-purple-700">{user?.role || '—'}</span>
            </div>
            <div className="flex items-center justify-between p-4">
              <span className="text-sm text-gray-500 flex items-center gap-2"><Database className="w-4 h-4" />Base de datos</span>
              <span className="text-sm font-medium text-gray-600 font-mono">Neon PostgreSQL</span>
            </div>
            <div className="flex items-center justify-between p-4">
              <span className="text-sm text-gray-500 flex items-center gap-2"><Info className="w-4 h-4" />Entorno</span>
              <span className="text-sm font-medium text-gray-600">
                {typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'Desarrollo local' : 'Producción (Vercel)'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
