import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, Database, Mail, Calendar, CheckCircle2, XCircle,
  Loader2, RefreshCw, ChevronDown, ChevronUp, Server,
  Shield, Clock, User, Info, Link2, Link2Off, Send
} from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';

interface CheckResult {
  success: boolean;
  logs?: string[];
  latency_ms?: number;
  code?: string;
}

interface AllChecks {
  db?: CheckResult;
  calendar?: CheckResult;
  email?: CheckResult;
}

interface StatusData {
  success: boolean;
  role: string;
  username: string;
  checks: AllChecks;
}

const fetch$ = (url: string) =>
  fetch(url, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
  });

// ── Tarjeta de servicio ───────────────────────────────────────────────────────
const ServiceCard = ({
  name, icon: Icon, iconBg, result, onCheck, loading, showCalendar
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  result?: CheckResult;
  onCheck: () => void;
  loading: boolean;
  showCalendar?: boolean;
}) => {
  const [showLogs, setShowLogs] = useState(false);

  const statusColor =
    result === undefined ? 'bg-gray-100 text-gray-500'
    : result.success ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-red-50 text-red-700 border-red-200';

  const StatusIcon = result === undefined ? null : result.success ? CheckCircle2 : XCircle;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-white rounded-2xl border p-5 shadow-sm transition-all ${
        result?.success === false ? 'border-red-200' : result?.success ? 'border-emerald-200' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${iconBg}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <p className="font-semibold text-gray-800">{name}</p>
            {result?.latency_ms !== undefined && (
              <p className="text-xs text-gray-400">{result.latency_ms}ms</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {StatusIcon && (
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium border flex items-center gap-1 ${statusColor}`}>
              <StatusIcon className="w-3.5 h-3.5" />
              {result!.success ? 'Conectado' : 'Error'}
            </span>
          )}
          {!result && <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Sin verificar</span>}
          <button
            onClick={onCheck}
            disabled={loading}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
            title="Verificar"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
          </button>
        </div>
      </div>

      {result?.logs && result.logs.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowLogs(p => !p)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showLogs ? 'Ocultar' : 'Ver'} logs ({result.logs.length})
          </button>
          <AnimatePresence>
            {showLogs && (
              <motion.pre
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 text-xs bg-gray-900 text-green-400 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap font-mono max-h-40 overflow-y-auto"
              >
                {result.logs.join('\n')}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
};

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

  // Estado de conexión de email de la clínica
  const [emailConn, setEmailConn] = useState<{
    connected: boolean; email: string | null; connected_at: string | null; clinic_email: string | null;
  } | null>(null);
  const [loadingEmailConn, setLoadingEmailConn] = useState(false);
  const [emailConnMsg, setEmailConnMsg] = useState<string | null>(null);

  const runAllChecks = useCallback(async () => {
    setLoadingAll(true);
    setError(null);
    try {
      const res = await fetch$('/api/system-status?type=all');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const data: StatusData = await res.json();
      setStatusData(data);
      setLastRun(new Date().toLocaleTimeString('es-EC'));
    } catch (e: any) {
      setError(e.message || 'Error al verificar servicios');
    } finally {
      setLoadingAll(false);
    }
  }, []);

  const fetchEmailConnectionStatus = useCallback(async () => {
    if (!isClinicAdmin || !user?.clinic_id) return;
    setLoadingEmailConn(true);
    try {
      const res = await fetch$(`/api/admin-auth?action=getEmailConnectionStatus&clinicId=${user.clinic_id}`);
      const data = await res.json();
      if (data.success) setEmailConn(data);
    } catch { /* non-fatal */ }
    finally { setLoadingEmailConn(false); }
  }, [isClinicAdmin, user?.clinic_id]);

  const handleConnectEmail = async () => {
    if (!user?.clinic_id) return;
    setLoadingEmailConn(true);
    try {
      const res = await fetch('/api/admin-auth?action=oauthStart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
        body: JSON.stringify({ clinicId: user.clinic_id }),
      });
      const d = await res.json();
      if (d.url) window.location.href = d.url;
      else setEmailConnMsg(d.error || 'Error al iniciar conexión');
    } catch { setEmailConnMsg('Error de conexión'); }
    finally { setLoadingEmailConn(false); }
  };

  const handleResendConnectionLink = async () => {
    if (!user?.clinic_id) return;
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

  const runSingleCheck = async (type: string) => {
    setLoadingCheck(p => ({ ...p, [type]: true }));
    try {
      const res = await fetch$(`/api/system-status?type=${type}`);
      const data: CheckResult = await res.json();
      setStatusData(prev => prev
        ? { ...prev, checks: { ...prev.checks, [type]: data } }
        : { success: data.success, role: user?.role || '', username: user?.username || '', checks: { [type]: data } }
      );
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoadingCheck(p => ({ ...p, [type]: false }));
    }
  };

  useEffect(() => {
    runAllChecks();
    if (isClinicAdmin) fetchEmailConnectionStatus();
  }, [runAllChecks, fetchEmailConnectionStatus, isClinicAdmin]);

  const allOk = statusData
    ? Object.values(statusData.checks).every(c => c.success)
    : null;

  return (
    <AdminLayout>
      <div className="p-4 md:p-8 max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-2xl shadow-lg ${
              allOk === null ? 'bg-gray-200' : allOk ? 'bg-gradient-to-br from-emerald-400 to-emerald-600' : 'bg-gradient-to-br from-red-400 to-red-600'
            }`}>
              <Activity className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Estado del Sistema</h1>
              {lastRun && (
                <p className="text-sm text-gray-400 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  Última verificación: {lastRun}
                </p>
              )}
            </div>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={runAllChecks}
            disabled={loadingAll}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-50"
          >
            {loadingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Verificar todo
          </motion.button>
        </div>

        {/* Estado global */}
        {statusData && (
          <div className={`mb-6 p-4 rounded-2xl flex items-center gap-3 border ${
            allOk ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
          }`}>
            {allOk
              ? <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
              : <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
            }
            <p className="font-medium">
              {allOk
                ? 'Todos los servicios operando correctamente.'
                : 'Uno o más servicios con problemas de conexión.'}
            </p>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Servicios */}
        <div className="space-y-4 mb-8">
          <ServiceCard
            name="Base de Datos (Neon PostgreSQL)"
            icon={Database}
            iconBg="bg-blue-50 text-blue-600"
            result={statusData?.checks?.db}
            onCheck={() => runSingleCheck('db')}
            loading={!!loadingCheck['db'] || loadingAll}
          />

          <ServiceCard
            name="Correo Electrónico (SMTP)"
            icon={Mail}
            iconBg="bg-amber-50 text-amber-600"
            result={statusData?.checks?.email}
            onCheck={() => runSingleCheck('email')}
            loading={!!loadingCheck['email'] || loadingAll}
          />

          {isMaster && (
            <ServiceCard
              name="Google Calendar"
              icon={Calendar}
              iconBg="bg-indigo-50 text-indigo-600"
              result={statusData?.checks?.calendar}
              onCheck={() => runSingleCheck('calendar')}
              loading={!!loadingCheck['calendar'] || loadingAll}
            />
          )}

          {/* Gmail de la clínica — solo clinic_admin */}
          {isClinicAdmin && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`bg-white rounded-2xl border p-5 shadow-sm transition-all ${
                emailConn === null ? 'border-gray-200'
                : emailConn.connected ? 'border-emerald-200'
                : 'border-amber-200'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${emailConn?.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                    {emailConn?.connected ? <Link2 className="w-5 h-5" /> : <Link2Off className="w-5 h-5" />}
                  </div>
                  <div>
                    <p className="font-semibold text-gray-800">Gmail de la clínica</p>
                    {emailConn?.email && <p className="text-xs text-gray-400">{emailConn.email}</p>}
                    {!emailConn?.connected && emailConn?.clinic_email && (
                      <p className="text-xs text-gray-400">Registrado: {emailConn.clinic_email}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {emailConn !== null && (
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium border flex items-center gap-1 ${
                      emailConn.connected
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}>
                      {emailConn.connected
                        ? <><CheckCircle2 className="w-3.5 h-3.5" /> Conectado</>
                        : <><XCircle className="w-3.5 h-3.5" /> Desconectado</>
                      }
                    </span>
                  )}
                  {emailConn === null && <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Sin verificar</span>}
                  <button
                    onClick={fetchEmailConnectionStatus}
                    disabled={loadingEmailConn}
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                    title="Verificar"
                  >
                    {loadingEmailConn ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" /> : <RefreshCw className="w-4 h-4 text-gray-500" />}
                  </button>
                </div>
              </div>

              {emailConn !== null && !emailConn.connected && (
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleConnectEmail}
                    disabled={loadingEmailConn}
                    className="flex-1 py-2 bg-[#deb887] text-white rounded-lg text-xs font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" /> Conectar ahora
                  </button>
                  <button
                    onClick={handleResendConnectionLink}
                    disabled={loadingEmailConn}
                    className="flex-1 py-2 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                    <Send className="w-3.5 h-3.5" /> Reenviar link por correo
                  </button>
                </div>
              )}

              {emailConnMsg && (
                <p className="mt-2 text-xs text-gray-500">{emailConnMsg}</p>
              )}
            </motion.div>
          )}
        </div>

        {/* Info del sistema */}
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
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                isMaster ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {user?.role || '—'}
              </span>
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

        {!isMaster && !isClinicAdmin && (
          <p className="mt-4 text-xs text-gray-400 text-center flex items-center justify-center gap-1">
            <Info className="w-3.5 h-3.5" />
            La verificación de Google Calendar está disponible solo para master_admin.
          </p>
        )}
      </div>
    </AdminLayout>
  );
}
