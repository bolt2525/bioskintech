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
  Users, Shield, Settings, Lock, Eye, EyeOff, Pencil, Check,
  UserCircle, CalendarDays, Building2, KeyRound, Plus, Trash2, UserCheck,
} from 'lucide-react';
import { useEffect, useState, useRef } from 'react';
import { Fragment } from 'react';
import AppFooter from '../components/layout/AppFooter';

// Módulos y tipos de constants centralizados
import { MODULE_LIST } from '../constants/features';
import type { UpcomingAppointment } from '../types';
import recordsFetch from '../utils/recordsFetch';

type SettingsTab = 'profile' | 'password' | 'agenda' | 'clinic';

type ProfileForm = {
  full_name: string; first_name: string; last_name: string; email: string;
  cedula_profesional: string; matricula_senescyt: string;
  especialidad: string; gentilicio: string; profession: string;
};

type ClinicForm = {
  name: string; phone: string; address: string;
  city: string; website: string; description: string;
};

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

  // ─── Settings modal ─────────────────────────────────────────────────────
  const [showSettings, setShowSettings]   = useState(false);
  const [settingsTab, setSettingsTab]     = useState<SettingsTab>('profile');
  const settingsMenuRef                   = useRef<HTMLDivElement>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);

  // Profile tab
  const [profileForm, setProfileForm]     = useState<ProfileForm>({ full_name: '', first_name: '', last_name: '', email: '', cedula_profesional: '', matricula_senescyt: '', especialidad: '', gentilicio: '', profession: '' });
  const [editingField, setEditingField]   = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg]       = useState<{ text: string; ok: boolean } | null>(null);

  // Password tab
  const [pwdStep, setPwdStep]             = useState<1 | 2 | 3>(1);
  const [pwdForm, setPwdForm]             = useState({ current: '', next: '', confirm: '' });
  const [otpCode, setOtpCode]             = useState('');
  const [pwdMsg, setPwdMsg]               = useState<{ text: string; ok: boolean } | null>(null);
  const [pwdSaving, setPwdSaving]         = useState(false);
  const [showPwds, setShowPwds]           = useState({ current: false, next: false });
  const [logoutCountdown, setLogoutCountdown] = useState(3);

  // Agenda tab
  const [clinicTreatments, setClinicTreatments] = useState<string[]>([]);
  const [newTreatment, setNewTreatment]     = useState('');
  const [personalEmails, setPersonalEmails] = useState<string[]>([]);
  const [newPersonalEmail, setNewPersonalEmail] = useState('');
  const [agendaSettings, setAgendaSettings] = useState({ start_hour: '08:00', end_hour: '19:00', slot_minutes: 60, calendar_prefix: '' });
  const [agendaSaving, setAgendaSaving]     = useState(false);
  const [agendaMsg, setAgendaMsg]           = useState<{ text: string; ok: boolean } | null>(null);

  // Clinic tab (clinic_admin only)
  const [clinicForm, setClinicForm]         = useState<ClinicForm>({ name: '', phone: '', address: '', city: '', website: '', description: '' });
  const [editingClinicField, setEditingClinicField] = useState<string | null>(null);
  const [clinicSaving, setClinicSaving]     = useState(false);
  const [clinicMsg, setClinicMsg]           = useState<{ text: string; ok: boolean } | null>(null);
  const [registeredClinicEmail, setRegisteredClinicEmail] = useState<string>('');

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

  // ─── Fetch de citas próximas — rango de 5 días ──────────────────────────
  const fetchUpcomingAppointments = async () => {
    setLoadingNotifications(true);
    try {
      const res  = await recordsFetch('/api/calendar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'getCalendarEvents', days: 5 }),
      });
      const data = await res.json();
      const today = new Date();
      today.setHours(0,0,0,0);
      const appointments: UpcomingAppointment[] = (data.events || [])
        .filter((ev: any) => ev.eventType !== 'block')
        .map((ev: any) => {
          const startStr = ev.startDateTime || ev.start?.dateTime || ev.start?.date || '';
          const start = new Date(startStr);
          const diffDays = Math.floor((start.getTime() - today.getTime()) / 86_400_000);
          // ponytail: parse "Profesional: X" from Calendar event description
          const professional = (ev.description || '').match(/Profesional:\s*([^\n]+)/)?.[1]?.trim() || '';
          return { ...ev, start: startStr, daysUntil: diffDays, isToday: diffDays === 0, isTomorrow: diffDays === 1, professional };
        })
        .sort((a: any, b: any) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime());
      setUpcomingAppointments(appointments);
    } catch { /* calendar no configurado — ignorar */ }
    finally { setLoadingNotifications(false); }
  };

  // ─── Cargar datos del settings al abrir modal ────────────────────────────
  const openSettings = async (tab: SettingsTab = 'profile') => {
    setSettingsTab(tab);
    setEditingField(null);
    setEditingClinicField(null);
    setPwdStep(1);
    setPwdForm({ current: '', next: '', confirm: '' });
    setOtpCode('');
    setPwdMsg(null); setProfileMsg(null); setAgendaMsg(null); setClinicMsg(null);
    setShowSettingsMenu(false);
    // Pre-fill profile from auth context
    if (user) {
      setProfileForm({
        full_name: user.full_name || '', first_name: user.first_name || '',
        last_name: user.last_name || '', email: user.email || '',
        cedula_profesional: user.cedula_profesional || '', matricula_senescyt: user.matricula_senescyt || '',
        especialidad: user.especialidad || '', gentilicio: user.gentilicio || '', profession: user.profession || '',
      });
    }
    setShowSettings(true);
    // Load agenda data
    if (user?.clinic_id) {
      try {
        const [settingsRes, staffRes] = await Promise.all([
          fetch(`/api/admin-auth?action=getClinicSettings&clinicId=${user.clinic_id}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` } }).then(r => r.json()),
          fetch('/api/admin-auth?action=getPersonalStaffEmails', { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` } }).then(r => r.json()),
        ]);
        if (settingsRes.settings?.treatments?.length) setClinicTreatments(settingsRes.settings.treatments);
        if (staffRes.emails) setPersonalEmails(staffRes.emails);
        if (settingsRes.settings?.agenda) {
          const a = settingsRes.settings.agenda;
          setAgendaSettings({ start_hour: a.start_hour || '08:00', end_hour: a.end_hour || '19:00', slot_minutes: a.slot_minutes || 60, calendar_prefix: a.calendar_prefix || '' });
        }
        // Pre-fill clinic form for clinic_admin
        if (user.role === 'clinic_admin') {
          const g = settingsRes.settings?.general || {};
          setClinicForm({
            name: g.name || '', phone: g.phone || '', address: g.address || '',
            city: g.city || '', website: g.website || '', description: g.description || '',
          });
          if (settingsRes.clinic_email) setRegisteredClinicEmail(settingsRes.clinic_email);
        }
      } catch { /* silencioso */ }
    }
  };

  // ─── Guardar perfil propio ───────────────────────────────────────────────
  const handleSaveProfile = async () => {
    setProfileSaving(true); setProfileMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=updateOwnProfile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify(profileForm),
      });
      const d = await res.json();
      setProfileMsg({ text: d.error || '¡Perfil actualizado!', ok: !!d.success });
      if (d.success) setEditingField(null);
    } finally { setProfileSaving(false); }
  };

  // ─── Paso 1 de cambio de contraseña: validar + enviar OTP ───────────────
  const handleSendOtp = async () => {
    if (pwdForm.next !== pwdForm.confirm) { setPwdMsg({ text: 'Las contraseñas nuevas no coinciden', ok: false }); return; }
    if (pwdForm.next.length < 8) { setPwdMsg({ text: 'Mínimo 8 caracteres', ok: false }); return; }
    setPwdSaving(true); setPwdMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=sendPasswordChangeCode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify({ currentPassword: pwdForm.current, newPassword: pwdForm.next }),
      });
      const d = await res.json();
      if (d.success) { setPwdStep(2); setPwdMsg({ text: d.message, ok: true }); }
      else setPwdMsg({ text: d.error || 'Error', ok: false });
    } finally { setPwdSaving(false); }
  };

  // ─── Paso 2: verificar OTP y cambiar contraseña ─────────────────────────
  const handleVerifyOtp = async () => {
    if (otpCode.length !== 6) { setPwdMsg({ text: 'El código debe tener 6 dígitos', ok: false }); return; }
    setPwdSaving(true); setPwdMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=verifyAndChangePassword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify({ otpCode, newPassword: pwdForm.next }),
      });
      const d = await res.json();
      if (d.success) {
        setPwdStep(3);
        let count = 3;
        setLogoutCountdown(count);
        const timer = setInterval(() => {
          count--; setLogoutCountdown(count);
          if (count <= 0) { clearInterval(timer); logout(); navigate('/admin/login'); }
        }, 1000);
      } else {
        setPwdMsg({ text: d.error || 'Código incorrecto', ok: false });
      }
    } finally { setPwdSaving(false); }
  };

  // ─── Guardar horario de agenda (clinic_admin) ──────────────────────────────
  const handleSaveAgendaSettings = async () => {
    if (!user?.clinic_id) return;
    setAgendaSaving(true); setAgendaMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=saveClinicSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify({ clinicId: user.clinic_id, section: 'agenda', data: agendaSettings }),
      });
      const d = await res.json();
      setAgendaMsg({ text: d.error || '¡Horario guardado!', ok: !!d.success });
    } finally { setAgendaSaving(false); }
  };

  // ─── Guardar tratamientos de clínica ────────────────────────────────────
  const handleSaveTreatments = async () => {
    if (!user?.clinic_id) return;
    setAgendaSaving(true); setAgendaMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=saveClinicSettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify({ clinicId: user.clinic_id, section: 'treatments', data: clinicTreatments }),
      });
      const d = await res.json();
      setAgendaMsg({ text: d.error || '¡Tratamientos guardados!', ok: !!d.success });
    } finally { setAgendaSaving(false); }
  };

  // ─── Guardar staff personal CC ──────────────────────────────────────────
  const handleSavePersonalEmails = async () => {
    setAgendaSaving(true); setAgendaMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=updatePersonalStaffEmails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify({ emails: personalEmails }),
      });
      const d = await res.json();
      setAgendaMsg({ text: d.error || '¡Correos guardados!', ok: !!d.success });
    } finally { setAgendaSaving(false); }
  };

  // ─── Guardar info básica de clínica (clinic_admin) ──────────────────────
  const handleSaveClinic = async () => {
    setClinicSaving(true); setClinicMsg(null);
    try {
      const res = await fetch('/api/admin-auth?action=updateClinicBasicInfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken')}` },
        body: JSON.stringify(clinicForm),
      });
      const d = await res.json();
      setClinicMsg({ text: d.error || '¡Clínica actualizada!', ok: !!d.success });
      if (d.success) setEditingClinicField(null);
    } finally { setClinicSaving(false); }
  };

  // Close settings dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showSettingsMenu && !settingsMenuRef.current?.contains(e.target as Node))
        setShowSettingsMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettingsMenu]);

  // ─── Guard ────────────────────────────────────────────────────────────
  // En modo master-view se permite renderizar aunque el user sea master_admin
  if (!isAuthenticated || !user) return null;
  if (user.role === 'master_admin' && !masterView.isActive) return null;

  // Filtrar módulos habilitados para este usuario/clínica + aplicar overrides por usuario
  const disabledByOverride = new Set(
    userModuleOverrides.filter(o => !o.enabled).map(o => o.feature)
  );
  const tiles = MODULE_LIST.filter(m => !m.hidden && effectiveHasFeature(m.feat) && !disabledByOverride.has(m.feat));

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
                  {effectiveUser?.clinic_name || 'BioSkinTech'}
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
                                {(apt as any).professional && (
                                  <div className="flex items-center gap-1 text-xs text-[#c5a075] mt-0.5">
                                    <UserCheck className="w-3 h-3" />
                                    <span>{(apt as any).professional}</span>
                                  </div>
                                )}
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
                        onClick={() => nav('calendar')}
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
                  onClick={() => nav('users')}
                  className="flex items-center gap-1.5 px-3 py-2 text-[#c5a075] bg-[#deb887]/10 hover:bg-[#deb887]/20 rounded-xl transition-colors text-sm font-medium"
                >
                  <Users className="w-4 h-4" /> Usuarios
                </button>
              )}

              {/* Perfil / Contraseña — dropdown */}
              <div className="relative" ref={settingsMenuRef}>
                <button
                  onClick={() => setShowSettingsMenu(s => !s)}
                  className="p-2 text-gray-400 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-xl transition-colors"
                  title="Ajustes"
                >
                  <Settings className="w-5 h-5" />
                </button>
                {showSettingsMenu && (
                  <div className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden z-50">
                    <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
                    <div className="py-1">
                      {user?.role === 'clinic_admin' && (
                        <button onClick={() => openSettings('clinic')} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-[#deb887]/8 transition-colors">
                          <Building2 className="w-4 h-4 text-[#deb887]" /> Mi Clínica
                        </button>
                      )}
                      <button onClick={() => openSettings('profile')} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-[#deb887]/8 transition-colors">
                        <UserCircle className="w-4 h-4 text-[#deb887]" /> Mi Información
                      </button>
                      <button onClick={() => openSettings('password')} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-[#deb887]/8 transition-colors">
                        <KeyRound className="w-4 h-4 text-[#deb887]" /> Cambiar Contraseña
                      </button>
                      <button onClick={() => openSettings('agenda')} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-[#deb887]/8 transition-colors">
                        <CalendarDays className="w-4 h-4 text-[#deb887]" /> Ajustes de Agenda
                      </button>
                    </div>
                  </div>
                )}
              </div>

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

      {/* ── Modal: Ajustes tabbed ─────────────────────────────────────── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
            {/* Header */}
            <div className="px-5 py-3.5 border-b flex justify-between items-center bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#deb887] to-[#c5a075] flex items-center justify-center text-white font-bold text-sm">
                  {(effectiveUser?.full_name || effectiveUser?.username || '?').charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 leading-none">Configuración</p>
                  <h3 className="font-bold text-gray-900 text-sm leading-tight">{effectiveUser?.full_name || effectiveUser?.username}</h3>
                </div>
              </div>
              <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar */}
              <nav className="w-44 flex-shrink-0 border-r bg-gray-50 p-2 flex flex-col gap-0.5">
                {([
                  ['profile',  <UserCircle  className="w-4 h-4" />, 'Mi Perfil'],
                  ['password', <KeyRound    className="w-4 h-4" />, 'Contraseña'],
                  ['agenda',   <CalendarDays className="w-4 h-4" />, 'Agenda'],
                  ...(user?.role === 'clinic_admin' ? [['clinic', <Building2 className="w-4 h-4" />, 'Mi Clínica']] : []),
                ] as [SettingsTab, React.ReactNode, string][]).map(([key, icon, label]) => (
                  <button key={key} onClick={() => { setSettingsTab(key); setPwdMsg(null); setProfileMsg(null); setAgendaMsg(null); setClinicMsg(null); }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                      settingsTab === key
                        ? 'bg-gradient-to-r from-[#deb887]/20 to-[#c5a075]/10 text-[#99652f] font-semibold border border-[#deb887]/30'
                        : 'text-gray-600 hover:bg-white hover:text-gray-900'
                    }`}
                  >
                    <span className="flex-shrink-0">{icon}</span>
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </nav>

              {/* Content */}
              <div className="flex-1 overflow-y-auto flex flex-col">
                <div className="flex-1 p-5 space-y-4">

                  {/* ── MI PERFIL ── */}
                  {settingsTab === 'profile' && (
                    <>
                      <p className="text-xs text-gray-400">Haz clic en el ícono ✏️ de cada campo para editarlo.</p>
                      <div className="grid grid-cols-2 gap-3">
                        {([
                          ['full_name',          'Nombre completo',    'text',  'col-span-2'],
                          ['first_name',         'Primer nombre',      'text',  ''],
                          ['last_name',          'Apellido',           'text',  ''],
                          ['email',              'Email',              'email', ''],
                          ['gentilicio',         'Título (Dr./Dra.)',  'text',  ''],
                          ['profession',         'Profesión',          'text',  ''],
                          ['especialidad',       'Especialidad',       'text',  ''],
                          ['cedula_profesional', 'Cédula profesional', 'text',  ''],
                          ['matricula_senescyt', 'Matrícula',          'text',  ''],
                        ] as [keyof ProfileForm, string, string, string][]).map(([k, label, type, span]) => {
                          const isEditing = editingField === k;
                          return (
                            <div key={k} className={span || ''}>
                              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
                              <div className="relative">
                                <input
                                  type={type}
                                  value={profileForm[k]}
                                  disabled={!isEditing}
                                  onChange={e => setProfileForm(p => ({ ...p, [k]: e.target.value }))}
                                  placeholder={`Ingresa ${label.toLowerCase()}`}
                                  className={`w-full px-3 py-2 pr-9 border rounded-lg text-sm transition-colors ${isEditing ? 'bg-white border-[#deb887] ring-2 ring-[#deb887]/20 outline-none' : 'bg-gray-50 border-gray-200 text-gray-700'}`}
                                />
                                <button type="button" onClick={() => setEditingField(isEditing ? null : k)}
                                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors ${isEditing ? 'text-[#deb887]' : 'text-gray-300 hover:text-[#deb887]'}`}>
                                  {isEditing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {profileMsg && <p className={`text-sm ${profileMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{profileMsg.text}</p>}
                    </>
                  )}

                  {/* ── CONTRASEÑA ── */}
                  {settingsTab === 'password' && (
                    <>
                      {/* Progress steps */}
                      <div className="flex items-center gap-2 mb-2">
                        {[1,2,3].map(s => (
                        <Fragment key={s}>
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${pwdStep >= s ? 'bg-[#deb887] text-white' : 'bg-gray-100 text-gray-400'}`}>{s}</div>
                            {s < 3 && <div className={`flex-1 h-0.5 rounded ${pwdStep > s ? 'bg-[#deb887]' : 'bg-gray-100'}`} />}
                          </Fragment>
                        ))}
                      </div>

                      {pwdStep === 1 && (
                        <>
                          <p className="text-xs text-gray-400">Ingresa tu contraseña actual y la nueva. Se enviará un código de verificación a tu email.</p>
                          {!user?.email && (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700 flex items-start gap-2">
                              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                              <span>Debes registrar tu email en <button onClick={() => setSettingsTab('profile')} className="font-semibold underline">Mi Perfil</button> antes de cambiar la contraseña.</span>
                            </div>
                          )}
                          <div className="space-y-3">
                            {(['current', 'next', 'confirm'] as const).map(k => (
                              <div key={k} className="relative">
                                <input
                                  type={showPwds[k === 'confirm' ? 'next' : k] ? 'text' : 'password'}
                                  placeholder={k === 'current' ? 'Contraseña actual' : k === 'next' ? 'Nueva contraseña (mín. 8 car.)' : 'Confirmar nueva contraseña'}
                                  value={pwdForm[k]}
                                  onChange={e => setPwdForm(p => ({ ...p, [k]: e.target.value }))}
                                  className="w-full pl-3 pr-9 py-2.5 border rounded-lg text-sm focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none"
                                />
                                {k !== 'confirm' && (
                                  <button type="button" onClick={() => setShowPwds(p => ({ ...p, [k]: !p[k] }))}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                                    {showPwds[k] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                          {pwdMsg && <p className={`text-sm ${pwdMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{pwdMsg.text}</p>}
                        </>
                      )}

                      {pwdStep === 2 && (
                        <>
                          <p className="text-xs text-gray-400">Revisa tu correo y escribe el código de 6 dígitos. Expira en 15 minutos.</p>
                          {pwdMsg && <p className={`text-sm ${pwdMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{pwdMsg.text}</p>}
                          <input
                            type="text" inputMode="numeric" maxLength={6}
                            placeholder="000000"
                            value={otpCode}
                            onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            className="w-full text-center text-3xl font-bold tracking-[12px] py-4 border-2 rounded-xl focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887]/20 outline-none text-[#99652f]"
                          />
                        </>
                      )}

                      {pwdStep === 3 && (
                        <div className="text-center py-6">
                          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Check className="w-8 h-8 text-emerald-600" />
                          </div>
                          <h4 className="font-semibold text-gray-900 mb-2">¡Contraseña cambiada!</h4>
                          <p className="text-sm text-gray-400">Cerrando sesión en <span className="font-bold text-[#deb887]">{logoutCountdown}s</span>...</p>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── AGENDA ── */}
                  {settingsTab === 'agenda' && (
                    <>
                      {/* Horario laboral */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-gray-700">Horario de atención</p>
                          {user?.role !== 'clinic_admin' && <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Solo el admin puede editar</span>}
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Hora inicio</label>
                            <input type="time" value={agendaSettings.start_hour}
                              disabled={user?.role !== 'clinic_admin'}
                              onChange={e => setAgendaSettings(p => ({ ...p, start_hour: e.target.value }))}
                              className={`w-full px-3 py-2 border rounded-lg text-sm outline-none ${
                                user?.role === 'clinic_admin'
                                  ? 'focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] bg-white'
                                  : 'bg-gray-50 text-gray-500'
                              }`} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Hora fin</label>
                            <input type="time" value={agendaSettings.end_hour}
                              disabled={user?.role !== 'clinic_admin'}
                              onChange={e => setAgendaSettings(p => ({ ...p, end_hour: e.target.value }))}
                              className={`w-full px-3 py-2 border rounded-lg text-sm outline-none ${
                                user?.role === 'clinic_admin'
                                  ? 'focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] bg-white'
                                  : 'bg-gray-50 text-gray-500'
                              }`} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Slot por defecto</label>
                            <select value={agendaSettings.slot_minutes}
                              disabled={user?.role !== 'clinic_admin'}
                              onChange={e => setAgendaSettings(p => ({ ...p, slot_minutes: parseInt(e.target.value) }))}
                              className={`w-full px-3 py-2 border rounded-lg text-sm outline-none ${
                                user?.role === 'clinic_admin'
                                  ? 'focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] bg-white'
                                  : 'bg-gray-50 text-gray-500'
                              }`}>
                              {[30, 45, 60, 90, 120].map(m => (
                                <option key={m} value={m}>{m < 60 ? `${m} min` : m === 60 ? '1 h' : m === 90 ? '1:30 h' : '2 h'}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-gray-100 pt-3">
                      {/* Tratamientos */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-gray-700">Tratamientos disponibles ({clinicTreatments.length})</p>
                          {user?.role !== 'clinic_admin' && <span className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Solo el admin puede editar</span>}
                        </div>
                        <div className="flex flex-wrap gap-1.5 min-h-[40px] p-2 border rounded-lg bg-gray-50 mb-2">
                          {clinicTreatments.map((t, i) => (
                            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-full text-xs text-gray-700">
                              {t}
                              {user?.role === 'clinic_admin' && (
                                <button onClick={() => setClinicTreatments(p => p.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                              )}
                            </span>
                          ))}
                          {clinicTreatments.length === 0 && <span className="text-xs text-gray-400 italic">Sin tratamientos configurados</span>}
                        </div>
                        {user?.role === 'clinic_admin' && (
                          <div className="flex gap-2">
                            <input value={newTreatment} onChange={e => setNewTreatment(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && newTreatment.trim()) { setClinicTreatments(p => [...p, newTreatment.trim()]); setNewTreatment(''); } }}
                              placeholder="Agregar tratamiento y Enter…"
                              className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none" />
                            <button onClick={() => { if (newTreatment.trim()) { setClinicTreatments(p => [...p, newTreatment.trim()]); setNewTreatment(''); } }}
                              className="px-3 py-2 rounded-lg text-white" style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                      </div>

                      <div className="border-t border-gray-100 pt-4">
                        <p className="text-xs font-semibold text-gray-700 mb-1">Mis correos de copia</p>
                        <p className="text-xs text-gray-400 mb-2">Recibirán copia de las citas que tú agendes (máx. 10).</p>
                        <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 border rounded-lg bg-gray-50 mb-2">
                          {personalEmails.map((e, i) => (
                            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-gray-200 rounded-full text-xs text-gray-700">
                              {e}
                              <button onClick={() => setPersonalEmails(p => p.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                            </span>
                          ))}
                          {personalEmails.length === 0 && <span className="text-xs text-gray-400 italic">Sin correos registrados</span>}
                        </div>
                        {personalEmails.length < 10 && (
                          <div className="flex gap-2">
                            <input type="email" value={newPersonalEmail} onChange={e => setNewPersonalEmail(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newPersonalEmail)) { setPersonalEmails(p => [...p, newPersonalEmail.trim().toLowerCase()]); setNewPersonalEmail(''); } }}
                              placeholder="correo@ejemplo.com y Enter…"
                              className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none" />
                            <button onClick={() => { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newPersonalEmail)) { setPersonalEmails(p => [...p, newPersonalEmail.trim().toLowerCase()]); setNewPersonalEmail(''); } }}
                              className="px-3 py-2 rounded-lg text-white" style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      {agendaMsg && <p className={`text-sm ${agendaMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{agendaMsg.text}</p>}
                    </>
                  )}

                  {/* ── MI CLÍNICA (clinic_admin) ── */}
                  {settingsTab === 'clinic' && user?.role === 'clinic_admin' && (
                    <>
                      <p className="text-xs text-gray-400">Haz clic en ✏️ para editar cada campo.</p>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Correo de la clínica — solo lectura, solo master admin puede cambiarlo */}
                        {registeredClinicEmail && (
                          <div className="col-span-2">
                            <label className="block text-xs font-medium text-gray-500 mb-1">Correo de la clínica</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="email"
                                value={registeredClinicEmail}
                                disabled
                                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                              />
                              <span className="text-xs text-gray-400 whitespace-nowrap">Solo el master admin puede modificarlo</span>
                            </div>
                          </div>
                        )}
                        {([
                          ['name',        'Nombre de la clínica', 'text',  'col-span-2'],
                          ['phone',       'Teléfono',             'tel',   ''],
                          ['city',        'Ciudad',               'text',  ''],
                          ['address',     'Dirección',            'text',  'col-span-2'],
                          ['website',     'Sitio web',            'url',   'col-span-2'],
                          ['description', 'Descripción',          'text',  'col-span-2'],
                        ] as [keyof ClinicForm, string, string, string][]).map(([k, label, type, span]) => {
                          const isEditing = editingClinicField === k;
                          return (
                            <div key={k} className={span || ''}>
                              <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
                              <div className="relative">
                                <input
                                  type={type}
                                  value={clinicForm[k]}
                                  disabled={!isEditing}
                                  onChange={e => setClinicForm(p => ({ ...p, [k]: e.target.value }))}
                                  placeholder={`Ingresa ${label.toLowerCase()}`}
                                  className={`w-full px-3 py-2 pr-9 border rounded-lg text-sm transition-colors ${isEditing ? 'bg-white border-[#deb887] ring-2 ring-[#deb887]/20 outline-none' : 'bg-gray-50 border-gray-200 text-gray-700'}`}
                                />
                                <button type="button" onClick={() => setEditingClinicField(isEditing ? null : k)}
                                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors ${isEditing ? 'text-[#deb887]' : 'text-gray-300 hover:text-[#deb887]'}`}>
                                  {isEditing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {clinicMsg && <p className={`text-sm ${clinicMsg.ok ? 'text-emerald-600' : 'text-red-500'}`}>{clinicMsg.text}</p>}
                    </>
                  )}

                </div>

                {/* Footer save */}
                <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
                  <button onClick={() => setShowSettings(false)} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-100">Cancelar</button>
                  {settingsTab === 'profile' && (
                    <button onClick={handleSaveProfile} disabled={profileSaving}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                      style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                      {profileSaving ? 'Guardando...' : 'Guardar perfil'}
                    </button>
                  )}
                  {settingsTab === 'password' && pwdStep === 1 && (
                    <button onClick={handleSendOtp} disabled={pwdSaving || !user?.email}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                      style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                      {pwdSaving ? 'Enviando...' : 'Enviar código'}
                    </button>
                  )}
                  {settingsTab === 'password' && pwdStep === 2 && (
                    <button onClick={handleVerifyOtp} disabled={pwdSaving || otpCode.length !== 6}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                      style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                      {pwdSaving ? 'Verificando...' : 'Verificar y cambiar'}
                    </button>
                  )}
                  {settingsTab === 'agenda' && (
                    <>
                      {user?.role === 'clinic_admin' && (
                        <button onClick={handleSaveAgendaSettings} disabled={agendaSaving}
                          className="px-4 py-2 rounded-lg text-sm font-medium border border-[#deb887] text-[#99652f] hover:bg-[#deb887]/10 disabled:opacity-60">
                          {agendaSaving ? '...' : 'Guardar horario'}
                        </button>
                      )}
                      {user?.role === 'clinic_admin' && (
                        <button onClick={handleSaveTreatments} disabled={agendaSaving}
                          className="px-4 py-2 rounded-lg text-sm font-medium border border-[#deb887] text-[#99652f] hover:bg-[#deb887]/10 disabled:opacity-60">
                          {agendaSaving ? '...' : 'Guardar tratamientos'}
                        </button>
                      )}
                      <button onClick={handleSavePersonalEmails} disabled={agendaSaving}
                        className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                        style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                        {agendaSaving ? 'Guardando...' : 'Guardar mis correos'}
                      </button>
                    </>
                  )}
                  {settingsTab === 'clinic' && user?.role === 'clinic_admin' && (
                    <button onClick={handleSaveClinic} disabled={clinicSaving}
                      className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
                      style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                      {clinicSaving ? 'Guardando...' : 'Guardar clínica'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <AppFooter theme="light" />
    </div>
  );
}
