/**
 * @file src/pages/AdminDashboard.tsx
 * @description Dashboard principal del panel de administración BIOSKIN.
 *
 * Muestra los módulos habilitados para la clínica del usuario autenticado.
 * El master_admin es redirigido automáticamente a /admin/master.
 *
 * Funcionalidades:
 *  - Grid de módulos según features habilitadas (role-based access)
 *  - Notificaciones de próximas citas (Google Calendar)
 *  - Modal de backup de datos
 *  - Modal de estado del sistema (Calendar + SMTP)
 */

import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useMasterView } from '../context/MasterViewContext';
import { useAdminNav } from '../hooks/useAdminNav';
import {
  LogOut, Calendar, Bell, X, AlertCircle, ChevronRight, Sparkles,
  Users, Shield, Settings, Lock, Eye, EyeOff,
} from 'lucide-react';
import { useEffect, useState } from 'react';

// Módulos y tipos de constants centralizados
import { MODULE_LIST } from '../constants/features';
import type { UpcomingAppointment } from '../types';
import recordsFetch from '../utils/recordsFetch';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de presentación (funciones puras)
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_BADGE: Record<string, string> = {
  clinic_admin: 'Administrador de Clínica',
  clinic_user:  'Usuario',
};

/** Formatea un datetime string a hora y día legibles */
function formatApt(d: string) {
  return {
    time: new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false }),
    day:  new Date(d).toLocaleDateString('es-ES',  { weekday: 'long', day: 'numeric', month: 'long' }),
  };
}

/** Devuelve etiqueta y color del badge de urgencia según cuántos días faltan */
function urgency(a: UpcomingAppointment) {
  if (a.isToday)       return { text: 'HOY',            color: 'bg-red-500 text-white' };
  if (a.isTomorrow)    return { text: 'MAÑANA',         color: 'bg-orange-400 text-white' };
  if (a.daysUntil <= 3) return { text: `${a.daysUntil} días`, color: 'bg-yellow-400 text-white' };
  return                      { text: `${a.daysUntil} días`, color: 'bg-gray-200 text-gray-600' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { isAuthenticated, user, hasFeature, logout, checkAuth, userModuleOverrides } = useAuth();
  const masterView = useMasterView();
  const { nav } = useAdminNav();

  // En modo master-view, usar los datos del usuario clínica objetivo
  const effectiveUser = masterView.isActive
    ? { ...user!, clinic_name: masterView.clinicName, full_name: masterView.targetUsername, username: masterView.targetUsername || '', role: 'clinic_user' as const }
    : user;
  const effectiveHasFeature = masterView.isActive
    ? masterView.hasFeatureInContext
    : hasFeature;

  // Estado de notificaciones de citas
  const [showNotifications, setShowNotifications]       = useState(false);
  const [upcomingAppointments, setUpcomingAppointments] = useState<UpcomingAppointment[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);

  // Estado modal de perfil/contraseña
  const [showProfile, setShowProfile]   = useState(false);
  const [pwdForm, setPwdForm]           = useState({ current: '', next: '', confirm: '' });
  const [pwdMsg, setPwdMsg]             = useState<{ text: string; ok: boolean } | null>(null);
  const [showPwds, setShowPwds]         = useState({ current: false, next: false });
  const [savingPwd, setSavingPwd]       = useState(false);

  // Verificar autenticación al montar
  useEffect(() => {
    checkAuth().then(ok => { if (!ok) navigate('/admin/login'); });
  }, []);

  // Redirigir master_admin a su propio panel SOLO si no está en modo master-view
  useEffect(() => {
    if (user?.role === 'master_admin' && !masterView.isActive) {
      navigate('/admin/master', { replace: true });
    }
  }, [user, masterView.isActive]);

  // Cargar citas próximas cuando hay sesión
  useEffect(() => {
    if (isAuthenticated) fetchUpcomingAppointments();
  }, [isAuthenticated]);

  // Cerrar panel de notificaciones al hacer click fuera
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showNotifications && !(e.target as Element).closest('.notifications-panel'))
        setShowNotifications(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNotifications]);

  // ─── Fetch de citas próximas — UNA sola llamada con rango de 15 días ────
  const fetchUpcomingAppointments = async () => {
    setLoadingNotifications(true);
    try {
      const res  = await recordsFetch('/api/calendar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'getCalendarEvents', days: 15 }),
      });
      const data = await res.json();
      const today = new Date();
      today.setHours(0,0,0,0);
      const appointments: UpcomingAppointment[] = (data.events || [])
        .filter((ev: any) => ev.eventType !== 'block')
        .map((ev: any) => {
          const start = new Date(ev.startDateTime || ev.start?.dateTime || ev.start?.date);
          const diffDays = Math.floor((start.getTime() - today.getTime()) / 86_400_000);
          return { ...ev, daysUntil: diffDays, isToday: diffDays === 0, isTomorrow: diffDays === 1 };
        })
        .sort((a: any, b: any) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
      setUpcomingAppointments(appointments);
    } catch { /* calendar no configurado — ignorar */ }
    finally { setLoadingNotifications(false); }
  };

  // ─── Cambio de contraseña propia ─────────────────────────────────────
  const handleChangePassword = async () => {
    if (pwdForm.next !== pwdForm.confirm) { setPwdMsg({ text: 'Las contraseñas no coinciden', ok: false }); return; }
    if (pwdForm.next.length < 6) { setPwdMsg({ text: 'Mínimo 6 caracteres', ok: false }); return; }
    setSavingPwd(true);
    try {
      const res  = await fetch('/api/admin-auth?action=changePassword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body:   JSON.stringify({ currentPassword: pwdForm.current, newPassword: pwdForm.next }),
      });
      const data = await res.json();
      setPwdMsg({ text: data.error || data.message || 'OK', ok: !!data.success });
      if (data.success) setPwdForm({ current: '', next: '', confirm: '' });
    } finally {
      setSavingPwd(false);
    }
  };

  // ─── Guard ────────────────────────────────────────────────────────────
  // En modo master-view se permite renderizar aunque el user sea master_admin
  if (!isAuthenticated || !user) return null;
  if (user.role === 'master_admin' && !masterView.isActive) return null;

  // Filtrar módulos habilitados para este usuario/clínica + aplicar overrides por usuario
  const disabledByOverride = new Set(
    userModuleOverrides.filter(o => !o.enabled).map(o => o.feature)
  );
  const tiles = MODULE_LIST.filter(m => effectiveHasFeature(m.feat) && !disabledByOverride.has(m.feat));

  return (
    <div className="min-h-screen bg-[#fafafa]">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100 sticky top-0 z-30">
        <div className="container-custom py-3.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">

            {/* Logo + nombre de clínica */}
            <div className="flex items-center gap-3">
              <div className="w-2 h-9 bg-[#deb887] rounded-full" />
              <div>
                <h1
                  className="text-xl font-bold text-gray-900 leading-tight"
                  style={{ fontFamily: 'Playfair Display, serif' }}
                >
                  {effectiveUser?.clinic_name || 'BIOSKIN'}
                </h1>
                <p className="text-xs text-gray-400 leading-tight">
                  {ROLE_BADGE[effectiveUser?.role || ''] || 'Usuario'} · {effectiveUser?.full_name || effectiveUser?.username}
                </p>
              </div>
            </div>

            {/* Acciones del header */}
            <div className="flex items-center gap-2">

              {/* Notificaciones de citas */}
              <div className="relative notifications-panel">
                <button
                  onClick={() => setShowNotifications(!showNotifications)}
                  className="relative p-2 text-gray-400 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-xl transition-colors"
                  aria-label="Notificaciones"
                >
                  <Bell className="w-5 h-5" />
                  {upcomingAppointments.length > 0 && (
                    <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full">
                      {upcomingAppointments.length > 9 ? '9+' : upcomingAppointments.length}
                    </span>
                  )}
                </button>

                {/* Panel de notificaciones */}
                {showNotifications && (
                  <div className="absolute right-0 mt-2 w-80 md:w-96 bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden z-50">
                    <div className="h-0.5 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />
                    <div className="px-4 py-3 border-b border-gray-50 flex justify-between items-center">
                      <h3 className="font-semibold text-gray-900 flex items-center gap-2 text-sm">
                        <Bell className="w-4 h-4 text-[#deb887]" /> Próximas Citas
                      </h3>
                      <button onClick={() => setShowNotifications(false)} className="text-gray-300 hover:text-gray-500">
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="max-h-72 overflow-y-auto">
                      {loadingNotifications ? (
                        <div className="p-8 text-center text-gray-400">
                          <div className="w-6 h-6 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                          <p className="text-sm">Cargando...</p>
                        </div>
                      ) : upcomingAppointments.length > 0 ? (
                        <div className="divide-y divide-gray-50">
                          {upcomingAppointments.map(apt => {
                            const { time, day } = formatApt(apt.start);
                            const u = urgency(apt);
                            return (
                              <div key={apt.id} className="px-4 py-3 hover:bg-gray-50 transition-colors">
                                <div className="flex justify-between items-center mb-1">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${u.color}`}>
                                    {u.text}
                                  </span>
                                  <span className="text-xs text-gray-400 font-mono">{time}</span>
                                </div>
                                <p className="font-medium text-gray-900 text-sm leading-snug">{apt.summary}</p>
                                <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
                                  <Calendar className="w-3 h-3" />
                                  <span className="capitalize">{day}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="p-8 text-center text-gray-300">
                          <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                          <p className="text-sm">Sin citas próximas</p>
                        </div>
                      )}
                    </div>

                    <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-center">
                      <button
                        onClick={() => navigate('/admin/calendar')}
                        className="text-sm text-[#deb887] font-medium hover:text-[#c5a075] transition-colors"
                      >
                        Ver calendario completo →
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Gestión de usuarios (solo clinic_admin) */}
              {user.role === 'clinic_admin' && (
                <button
                  onClick={() => navigate('/admin/users')}
                  className="flex items-center gap-1.5 px-3 py-2 text-[#c5a075] bg-[#deb887]/10 hover:bg-[#deb887]/20 rounded-xl transition-colors text-sm font-medium"
                >
                  <Users className="w-4 h-4" /> Usuarios
                </button>
              )}

              {/* Perfil / Contraseña */}
              <button
                onClick={() => { setPwdForm({ current: '', next: '', confirm: '' }); setPwdMsg(null); setShowProfile(true); }}
                className="p-2 text-gray-400 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-xl transition-colors"
                title="Mi perfil"
              >
                <Settings className="w-5 h-5" />
              </button>

              {/* Cerrar sesión */}
              <button
                onClick={() => { logout(); navigate('/admin/login'); }}
                className="flex items-center gap-1.5 px-3 py-2 text-red-500 bg-red-50 hover:bg-red-100 rounded-xl transition-colors text-sm font-medium"
              >
                <LogOut className="w-4 h-4" /> Salir
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Cuerpo ──────────────────────────────────────────────────────── */}
      <div className="container-custom py-8">

        {/* Saludo */}
        <div className="mb-8 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#deb887] flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Bienvenido, {effectiveUser?.full_name?.split(' ')[0] || effectiveUser?.username}
            </h2>
            <p className="text-sm text-gray-400">Selecciona un módulo para continuar</p>
          </div>
        </div>

        {/* Estado sin módulos */}
        {tiles.length === 0 && (
          <div className="text-center py-24 text-gray-300">
            <Shield className="w-16 h-16 mx-auto mb-4 opacity-20" />
            <p className="text-lg font-medium text-gray-500">Sin módulos habilitados</p>
            <p className="text-sm mt-1">Contacta al administrador de tu clínica.</p>
          </div>
        )}

        {/* Grid de módulos */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {tiles.map((item, idx) => {
            const Icon = item.icon;
            return (
              <button
                key={`${item.feat}-${idx}`}
                onClick={() => nav(item.path.replace(/^\/admin\//, ''))}
                className="group bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-[#deb887]/40 hover:-translate-y-0.5 transition-all duration-200 text-left p-5 flex flex-col"
              >
                <div className={`w-11 h-11 rounded-xl ${item.bgColor} flex items-center justify-center mb-4`}>
                  <Icon className={`w-5 h-5 ${item.iconColor}`} />
                </div>
                <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 group-hover:text-[#deb887] transition-colors">
                  {item.title}
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed flex-1">{item.description}</p>
                <div className="flex items-center gap-1 mt-3 text-[#deb887] text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  <span>Acceder</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </button>
            );
          })}

        </div>
      </div>

      {/* ── Modal: Mi Perfil / Cambiar Contraseña ─────────────────────── */}
      {showProfile && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
            <div className="px-5 py-4 border-b flex justify-between items-center">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <Settings className="w-4 h-4 text-[#deb887]" /> Mi Perfil
              </h3>
              <button onClick={() => setShowProfile(false)} className="text-gray-300 hover:text-gray-500"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-5">
              {/* Info del usuario */}
              <div className="bg-[#deb887]/8 border border-[#deb887]/20 rounded-xl p-4 space-y-1">
                <p className="font-semibold text-gray-900">{effectiveUser?.full_name || effectiveUser?.username}</p>
                <p className="text-sm text-gray-400">@{user.username} · {ROLE_BADGE[user.role] || user.role}</p>
                {user.clinic_name && <p className="text-sm text-[#c5a075]">{user.clinic_name}</p>}
              </div>

              {/* Cambio de contraseña */}
              <div>
                <p className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Cambiar contraseña</p>
                <div className="space-y-3">
                  {[
                    { key: 'current', label: 'Contraseña actual', showKey: 'current' },
                    { key: 'next',    label: 'Nueva contraseña',  showKey: 'next' },
                    { key: 'confirm', label: 'Confirmar nueva',   showKey: 'next' },
                  ].map(f => (
                    <div key={f.key} className="relative">
                      <input
                        type={showPwds[f.showKey as keyof typeof showPwds] ? 'text' : 'password'}
                        placeholder={f.label}
                        value={pwdForm[f.key as keyof typeof pwdForm]}
                        onChange={e => setPwdForm(p => ({ ...p, [f.key]: e.target.value }))}
                        className="w-full pl-3 pr-9 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none"
                      />
                      {(f.showKey === 'current' || f.key === 'next') && (
                        <button type="button" onClick={() => setShowPwds(p => ({ ...p, [f.showKey]: !p[f.showKey as keyof typeof showPwds] }))}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                          {showPwds[f.showKey as keyof typeof showPwds] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {pwdMsg && (
                  <p className={`mt-2 text-sm ${pwdMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{pwdMsg.text}</p>
                )}
                <button
                  onClick={handleChangePassword}
                  disabled={savingPwd}
                  className="mt-3 w-full py-2 rounded-lg text-white text-sm font-medium transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}
                >
                  {savingPwd ? 'Guardando...' : 'Actualizar contraseña'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
