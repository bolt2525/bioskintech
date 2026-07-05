/**
 * @file src/pages/AdminMasterDashboard.tsx
 * @description Dashboard exclusivo del master_admin.
 *
 * Funcionalidades:
 *  - Vista global de todas las clínicas registradas
 *  - Control de features habilitadas por clínica (toggle switches)
 *  - Gestión completa de usuarios (CRUD + reset password)
 *  - Acceso directo a todos los módulos del sistema
 *  - Stats globales y acciones de mantenimiento
 *
 * La configuración de módulos y features viene de src/constants/features.ts
 * (mismo origen que AdminDashboard → sin duplicación).
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  LogOut, Building2, Users, Shield, RefreshCw, ChevronDown, ChevronUp,
  Plus, Edit, Trash2, Eye, EyeOff, Key, X, Check, AlertCircle,
  Activity, ClipboardList, ChevronRight, Sparkles,
} from 'lucide-react';

// Constantes centralizadas — no duplicar aquí
import { ALL_FEATURES, FEATURE_META, MODULE_LIST } from '../constants/features';
import { ROLE_LABELS, ROLE_COLORS } from '../constants/theme';

// Tipos centralizados
import type { Clinic, ClinicUser, FeatureRow } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos locales (solo usados en este archivo)
// ─────────────────────────────────────────────────────────────────────────────

type TabKey = 'clinics' | 'users' | 'modules' | 'system';

// ─────────────────────────────────────────────────────────────────────────────
// Componentes pequeños reutilizables dentro de este módulo
// ─────────────────────────────────────────────────────────────────────────────

/** Toggle switch para activar/desactivar una feature */
function FeatureToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-indigo-600' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 mt-0.5 ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

/** Modal genérico con título y botón de cerrar */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="h-0.5 bg-gradient-to-r from-indigo-400 to-purple-500" />
        <div className="p-5 border-b flex justify-between items-center">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Panel desplegable de features por clínica.
 * Muestra toggles para cada feature de ALL_FEATURES.
 */
function ClinicFeaturesPanel({
  clinic,
  featMap,
  onToggle,
}: {
  clinic: Clinic;
  featMap: Record<string, boolean>;
  onToggle: (clinicId: number, feature: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm text-indigo-600 font-medium hover:underline"
      >
        <Shield className="w-3.5 h-3.5" />
        Módulos ({ALL_FEATURES.filter(f => featMap[f] !== false).length}/{ALL_FEATURES.length})
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ALL_FEATURES.map(feat => {
            const meta    = FEATURE_META[feat];
            const Icon    = meta.icon;
            const enabled = featMap[feat] !== false;
            return (
              <div key={feat} className="flex items-center justify-between p-2 rounded-lg bg-gray-50 border border-gray-100">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${meta.color}`} />
                  <span className="text-xs text-gray-700 truncate">{meta.label}</span>
                </div>
                <FeatureToggle checked={enabled} onChange={v => onToggle(clinic.id, feat, v)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminMasterDashboard() {
  const navigate = useNavigate();
  const { user, logout, checkAuth } = useAuth();

  // ── Estado general ───────────────────────────────────────────────────────
  const [tab, setTab] = useState<TabKey>('clinics');
  const [selectedModuleClinic, setSelectedModuleClinic] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg]         = useState<{ text: string; type: 'ok' | 'err' } | null>(null);

  // ── Datos remotos ────────────────────────────────────────────────────────
  const [clinics, setClinics]   = useState<Clinic[]>([]);
  const [allUsers, setAllUsers] = useState<ClinicUser[]>([]);
  const [featData, setFeatData] = useState<FeatureRow[]>([]);

  // ── Estado modales ───────────────────────────────────────────────────────
  const [userModal,   setUserModal]   = useState<{ open: boolean; userId?: number }>({ open: false });
  const [clinicModal, setClinicModal] = useState<{ open: boolean; clinicId?: number }>({ open: false });
  const [pwdModal,    setPwdModal]    = useState<{ open: boolean; userId?: number }>({ open: false });

  // ── Formularios ──────────────────────────────────────────────────────────
  const [userForm, setUserForm]     = useState({ username: '', full_name: '', email: '', role: 'clinic_user', access_scope: 'own', clinic_id: '', password: '', password2: '' });
  const [clinicForm, setClinicForm] = useState({ name: '', slug: '', email: '', phone: '', address: '' });
  const [pwdForm, setPwdForm]       = useState({ password: '', password2: '' });

  // ── Filtros de usuarios ──────────────────────────────────────────────────
  const [userSearch, setUserSearch]           = useState('');
  const [userClinicFilter, setUserClinicFilter] = useState('');

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const token      = () => localStorage.getItem('adminSessionToken') || '';
  const authHeader = () => ({ 'Authorization': `Bearer ${token()}`, 'Content-Type': 'application/json' });

  /** Muestra un toast durante 4 segundos */
  const flash = (text: string, type: 'ok' | 'err' = 'ok') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };

  // ─── Carga de datos ───────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, uRes, fRes] = await Promise.all([
        fetch('/api/admin-auth?action=listClinics',       { headers: authHeader() }),
        fetch('/api/admin-auth?action=listUsers',         { headers: authHeader() }),
        fetch('/api/admin-auth?action=getClinicFeatures', { headers: authHeader() }),
      ]);
      const [cData, uData, fData] = await Promise.all([cRes.json(), uRes.json(), fRes.json()]);

      if (Array.isArray(cData))  setClinics(cData);
      else if (cData.clinics)    setClinics(cData.clinics);

      if (Array.isArray(uData))  setAllUsers(uData);
      else if (uData.users)      setAllUsers(uData.users);

      if (fData.data) setFeatData(fData.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth().then(ok => {
      if (!ok) { navigate('/admin/login'); return; }
      if (user && user.role !== 'master_admin') { navigate('/admin'); return; }
    });
    loadAll();
  }, []);

  // Mapa de features: { clinicId: { feature: enabled } }
  const featMap = featData.reduce<Record<number, Record<string, boolean>>>((acc, row) => {
    if (!acc[row.clinic_id]) acc[row.clinic_id] = {};
    acc[row.clinic_id][row.feature] = row.enabled;
    return acc;
  }, {});

  /** Activa/desactiva una feature con optimistic update */
  const handleToggleFeature = async (clinicId: number, feature: string, enabled: boolean) => {
    setFeatData(prev => {
      const existing = prev.find(r => r.clinic_id === clinicId && r.feature === feature);
      if (existing) return prev.map(r => (r.clinic_id === clinicId && r.feature === feature) ? { ...r, enabled } : r);
      return [...prev, { clinic_id: clinicId, feature, enabled, clinic_name: '' }];
    });
    try {
      await fetch('/api/admin-auth?action=setFeature', {
        method: 'POST', headers: authHeader(),
        body:   JSON.stringify({ clinicId, feature, enabled }),
      });
    } catch {
      flash('Error al actualizar feature', 'err');
      loadAll();
    }
  };

  // ─── CRUD Usuarios ────────────────────────────────────────────────────────

  const openCreateUser = () => {
    setUserForm({ username: '', full_name: '', email: '', role: 'clinic_user', access_scope: 'own', clinic_id: String(clinics[0]?.id || ''), password: '', password2: '' });
    setUserModal({ open: true });
  };

  const openEditUser = (u: ClinicUser) => {
    setUserForm({ username: u.username, full_name: u.full_name || '', email: u.email || '', role: u.role, access_scope: u.access_scope, clinic_id: String(u.clinic_id || ''), password: '', password2: '' });
    setUserModal({ open: true, userId: u.id });
  };

  const saveUser = async () => {
    if (!userModal.userId && userForm.password !== userForm.password2)
      return flash('Las contraseñas no coinciden', 'err');

    const action = userModal.userId ? 'updateUser' : 'createUser';
    const body   = { ...userForm, id: userModal.userId, clinic_id: userForm.clinic_id ? parseInt(userForm.clinic_id) : null };
    const res    = await fetch(`/api/admin-auth?action=${action}`, { method: 'POST', headers: authHeader(), body: JSON.stringify(body) });
    const data   = await res.json();
    if (data.error) return flash(data.error, 'err');
    flash(userModal.userId ? 'Usuario actualizado' : 'Usuario creado');
    setUserModal({ open: false });
    loadAll();
  };

  const toggleUserActive = async (u: ClinicUser) => {
    await fetch('/api/admin-auth?action=updateUser', {
      method: 'POST', headers: authHeader(),
      body:   JSON.stringify({ id: u.id, is_active: !u.is_active }),
    });
    loadAll();
  };

  const deleteUser = async (u: ClinicUser) => {
    if (!confirm(`¿Desactivar a ${u.username}? Su acceso será revocado.`)) return;
    await fetch(`/api/admin-auth?action=deleteUser&id=${u.id}`, { method: 'DELETE', headers: authHeader() });
    loadAll();
  };

  const doResetPwd = async () => {
    if (pwdForm.password !== pwdForm.password2) return flash('Las contraseñas no coinciden', 'err');
    const res  = await fetch('/api/admin-auth?action=resetPassword', {
      method: 'POST', headers: authHeader(),
      body:   JSON.stringify({ id: pwdModal.userId, newPassword: pwdForm.password }),
    });
    const data = await res.json();
    if (data.error) return flash(data.error, 'err');
    flash('Contraseña restablecida');
    setPwdModal({ open: false });
  };

  // ─── CRUD Clínicas ────────────────────────────────────────────────────────

  const openCreateClinic = () => {
    setClinicForm({ name: '', slug: '', email: '', phone: '', address: '' });
    setClinicModal({ open: true });
  };

  const openEditClinic = (c: Clinic) => {
    setClinicForm({ name: c.name, slug: c.slug, email: c.email || '', phone: c.phone || '', address: c.address || '' });
    setClinicModal({ open: true, clinicId: c.id });
  };

  const saveClinic = async () => {
    const action = clinicModal.clinicId ? 'updateClinic' : 'createClinic';
    const body   = { ...clinicForm, id: clinicModal.clinicId };
    const res    = await fetch(`/api/admin-auth?action=${action}`, { method: 'POST', headers: authHeader(), body: JSON.stringify(body) });
    const data   = await res.json();
    if (data.error) return flash(data.error, 'err');
    flash(clinicModal.clinicId ? 'Clínica actualizada' : 'Clínica creada');
    setClinicModal({ open: false });
    loadAll();
  };

  // ─── Filtros ──────────────────────────────────────────────────────────────

  const filteredUsers = allUsers.filter(u => {
    const q            = userSearch.toLowerCase();
    const matchSearch  = !q || u.username.toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q);
    const matchClinic  = !userClinicFilter || String(u.clinic_id) === userClinicFilter;
    return matchSearch && matchClinic;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Header Master Admin ──────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-indigo-600 to-purple-700 text-white shadow-lg">
        <div className="container-custom py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">

            {/* Título */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold">Master Admin Panel</h1>
                  <span className="bg-[#deb887] text-white px-2 py-0.5 rounded-lg text-xs font-bold tracking-wide">BIOSKIN</span>
                </div>
                <p className="text-white/70 text-sm">Control total del sistema · {user?.username}</p>
              </div>
            </div>

            {/* Acciones del header */}
            <div className="flex items-center gap-2">
              <button onClick={loadAll} className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors" title="Recargar datos">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => { logout(); navigate('/admin/login'); }}
                className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors text-sm"
              >
                <LogOut className="w-4 h-4" /> Salir
              </button>
            </div>
          </div>

          {/* Stats globales */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
            {[
              { label: 'Clínicas',  value: clinics.length,                                            icon: Building2,    color: 'bg-blue-500' },
              { label: 'Usuarios',  value: allUsers.length,                                           icon: Users,         color: 'bg-purple-500' },
              { label: 'Pacientes', value: clinics.reduce((s, c) => s + (c.patient_count || 0), 0),   icon: ClipboardList, color: 'bg-pink-500' },
              { label: 'Activos',   value: allUsers.filter(u => u.is_active).length,                  icon: Activity,      color: 'bg-emerald-500' },
            ].map(s => (
              <div key={s.label} className="bg-white/10 rounded-xl p-3 flex items-center gap-3">
                <div className={`w-9 h-9 ${s.color} rounded-lg flex items-center justify-center flex-shrink-0`}>
                  <s.icon className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-xl font-bold">{s.value}</div>
                  <div className="text-white/70 text-xs">{s.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Tabs de navegación */}
          <div className="flex gap-1 mt-5 bg-white/10 rounded-xl p-1 w-fit">
            {([
              ['clinics', '🏥 Clínicas'],
              ['users',   '👥 Usuarios'],
              ['modules', '📦 Módulos'],
              ['system',  '⚙️ Sistema'],
            ] as [TabKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === key ? 'bg-white text-indigo-700 shadow' : 'text-white/80 hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Toast de feedback */}
      {msg && (
        <div className={`fixed top-4 right-4 z-50 px-5 py-3 rounded-xl shadow-lg text-white font-medium flex items-center gap-2 ${msg.type === 'ok' ? 'bg-emerald-600' : 'bg-red-600'}`}>
          {msg.type === 'ok' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {msg.text}
        </div>
      )}

      <div className="container-custom py-8">

        {/* ── Tab: Clínicas ────────────────────────────────────────────── */}
        {tab === 'clinics' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold text-gray-900">Clínicas registradas</h2>
              <button onClick={openCreateClinic} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> Nueva Clínica
              </button>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <RefreshCw className="w-6 h-6 animate-spin mr-2" /> Cargando…
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-5">
                {clinics.map(clinic => (
                  <div key={clinic.id} className={`bg-white rounded-2xl shadow border ${clinic.is_active ? 'border-gray-100' : 'border-red-200 opacity-70'}`}>
                    <div className="p-5">
                      {/* Encabezado de la clínica */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center text-white font-bold text-sm">
                            {clinic.name.charAt(0)}
                          </div>
                          <div>
                            <h3 className="font-bold text-gray-900">{clinic.name}</h3>
                            <p className="text-gray-400 text-xs">@{clinic.slug}</p>
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${clinic.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {clinic.is_active ? 'Activa' : 'Inactiva'}
                        </span>
                      </div>

                      {/* Stats de la clínica */}
                      <div className="grid grid-cols-3 gap-2 mb-4">
                        {[
                          { label: 'Usuarios',  value: clinic.user_count || 0 },
                          { label: 'Pacientes', value: clinic.patient_count || 0 },
                          { label: 'Módulos',   value: ALL_FEATURES.filter(f => (featMap[clinic.id] || {})[f] !== false).length },
                        ].map(s => (
                          <div key={s.label} className="text-center p-2 bg-gray-50 rounded-lg">
                            <div className="text-lg font-bold text-gray-900">{s.value}</div>
                            <div className="text-xs text-gray-400">{s.label}</div>
                          </div>
                        ))}
                      </div>

                      {/* Panel de features toggleable */}
                      <ClinicFeaturesPanel
                        clinic={clinic}
                        featMap={featMap[clinic.id] || {}}
                        onToggle={handleToggleFeature}
                      />

                      {/* Acciones de la clínica */}
                      <div className="flex gap-2 mt-4 pt-4 border-t">
                        <button onClick={() => openEditClinic(clinic)} className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors">
                          <Edit className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button onClick={() => { setUserClinicFilter(String(clinic.id)); setTab('users'); }} className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors">
                          <Users className="w-3.5 h-3.5" /> Ver Usuarios
                        </button>
                        <button onClick={() => { setSelectedModuleClinic(clinic.id); setTab('modules'); }} className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-[#c5a075] bg-[#deb887]/10 hover:bg-[#deb887]/20 rounded-lg transition-colors">
                          <Sparkles className="w-3.5 h-3.5" /> Módulos
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Usuarios ────────────────────────────────────────────── */}
        {tab === 'users' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
              <h2 className="text-lg font-bold text-gray-900">Gestión de Usuarios</h2>
              <div className="flex gap-2 flex-wrap">
                <input
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  placeholder="Buscar usuario…"
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none w-48"
                />
                <select
                  value={userClinicFilter}
                  onChange={e => setUserClinicFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none"
                >
                  <option value="">Todas las clínicas</option>
                  {clinics.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  <option value="null">Sin clínica (master)</option>
                </select>
                <button onClick={openCreateUser} className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
                  <Plus className="w-4 h-4" /> Nuevo
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      {['Usuario', 'Nombre', 'Rol', 'Clínica', 'Acceso', 'Estado', 'Acciones'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredUsers.map(u => (
                      <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${!u.is_active ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                              {(u.username || '?')[0].toUpperCase()}
                            </div>
                            <span className="font-medium text-gray-900 text-sm">{u.username}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">{u.full_name || '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS[u.role] || 'bg-gray-100 text-gray-600'}`}>
                            {ROLE_LABELS[u.role] || u.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {u.clinic_name || <span className="text-amber-600 font-medium">Global</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${u.access_scope === 'all' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {u.access_scope === 'all' ? 'Todos' : 'Solo propios'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => toggleUserActive(u)} title={u.is_active ? 'Desactivar' : 'Activar'}>
                            {u.is_active ? <Eye className="w-4 h-4 text-green-600" /> : <EyeOff className="w-4 h-4 text-gray-400" />}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            <button onClick={() => openEditUser(u)} className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded" title="Editar">
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => { setPwdForm({ password: '', password2: '' }); setPwdModal({ open: true, userId: u.id }); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Cambiar contraseña">
                              <Key className="w-3.5 h-3.5" />
                            </button>
                            {u.role !== 'master_admin' && (
                              <button onClick={() => deleteUser(u)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Desactivar">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredUsers.length === 0 && (
                  <div className="p-10 text-center text-gray-400">
                    <Users className="w-10 h-10 mx-auto mb-2 opacity-20" />
                    <p>No se encontraron usuarios</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Tab: Módulos ─────────────────────────────────────────────── */}
        {tab === 'modules' && (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#deb887] flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Módulos del Sistema</h2>
                  <p className="text-sm text-gray-400">Acceso directo a todos los módulos</p>
                </div>
              </div>
              {clinics.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Contexto:</span>
                  <select
                    value={selectedModuleClinic ?? ''}
                    onChange={e => setSelectedModuleClinic(e.target.value ? parseInt(e.target.value) : null)}
                    className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] focus:outline-none"
                  >
                    <option value="">Global (master)</option>
                    {clinics.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* Indicador de clínica seleccionada */}
            {selectedModuleClinic && (
              <div className="mb-4 p-3 bg-[#deb887]/10 border border-[#deb887]/20 rounded-xl flex items-center gap-2 text-sm text-[#c5a075]">
                <Shield className="w-4 h-4 flex-shrink-0" />
                <span>
                  Clínica: <strong>{clinics.find(c => c.id === selectedModuleClinic)?.name}</strong>
                  {' '}— {ALL_FEATURES.filter(f => (featMap[selectedModuleClinic] || {})[f] !== false).length}/{ALL_FEATURES.length} módulos activos
                </span>
              </div>
            )}

            {/* Grid de módulos — usa MODULE_LIST del constants, sin duplicar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {MODULE_LIST.map((item, idx) => {
                const Icon      = item.icon;
                const isEnabled = !selectedModuleClinic || (featMap[selectedModuleClinic] || {})[item.feat] !== false;
                return (
                  <button
                    key={`${item.feat}-${idx}`}
                    onClick={() => navigate(item.path)}
                    className={`group bg-white rounded-2xl border shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 text-left p-5 flex flex-col ${
                      isEnabled ? 'border-gray-100 hover:border-[#deb887]/40' : 'border-gray-100 opacity-40'
                    }`}
                  >
                    <div className={`w-11 h-11 rounded-xl ${item.bgColor} flex items-center justify-center mb-4`}>
                      <Icon className={`w-5 h-5 ${item.iconColor}`} />
                    </div>
                    <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 group-hover:text-[#deb887] transition-colors">
                      {item.title}
                    </h3>
                    <p className="text-gray-400 text-xs leading-relaxed flex-1">{item.description}</p>
                    <div className="flex items-center justify-between mt-3">
                      {!isEnabled && selectedModuleClinic && (
                        <span className="text-[10px] text-gray-300 font-medium">Módulo desactivado</span>
                      )}
                      <div className="flex items-center gap-1 text-[#deb887] text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
                        <span>Acceder</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab: Sistema ─────────────────────────────────────────────── */}
        {tab === 'system' && (
          <div className="max-w-2xl">
            <h2 className="text-lg font-bold text-gray-900 mb-5">Información del Sistema</h2>
            <div className="space-y-4">

              {/* Resumen visual de features por clínica */}
              <div className="bg-white rounded-2xl p-5 shadow border border-gray-100">
                <h3 className="font-semibold text-gray-900 mb-3">Resumen de Features</h3>
                <div className="space-y-2">
                  {clinics.map(c => (
                    <div key={c.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                      <span className="text-sm font-medium text-gray-700">{c.name}</span>
                      <div className="flex gap-1">
                        {ALL_FEATURES.map(f => (
                          <span
                            key={f}
                            title={FEATURE_META[f]?.label}
                            className={`w-2 h-2 rounded-full ${(featMap[c.id] || {})[f] !== false ? 'bg-indigo-500' : 'bg-gray-200'}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Acciones de mantenimiento */}
              <div className="bg-white rounded-2xl p-5 shadow border border-gray-100">
                <h3 className="font-semibold text-gray-900 mb-3">Acciones de Mantenimiento</h3>
                <div className="space-y-2">
                  <button
                    onClick={async () => {
                      const res = await fetch('/api/admin-auth?action=initFeatures', { headers: authHeader() });
                      const d   = await res.json();
                      flash(d.message || 'Listo');
                      loadAll();
                    }}
                    className="w-full flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm text-left"
                  >
                    <span className="font-medium text-gray-700">Re-inicializar features de todas las clínicas</span>
                    <RefreshCw className="w-4 h-4 text-gray-400" />
                  </button>
                  <button
                    onClick={() => navigate('/admin')}
                    className="w-full flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm text-left"
                  >
                    <span className="font-medium text-gray-700">Ir a la vista de clínica estándar</span>
                    <Building2 className="w-4 h-4 text-gray-400" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Modal: Crear / Editar Usuario ─────────────────────────────── */}
      {userModal.open && (
        <Modal title={userModal.userId ? 'Editar Usuario' : 'Nuevo Usuario'} onClose={() => setUserModal({ open: false })}>
          <div className="space-y-4">
            {[
              { label: 'Usuario *',       key: 'username',   type: 'text',  disabled: !!userModal.userId },
              { label: 'Nombre completo', key: 'full_name',  type: 'text',  disabled: false },
              { label: 'Email',           key: 'email',      type: 'email', disabled: false },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={(userForm as Record<string, string>)[f.key]}
                  onChange={e => setUserForm(p => ({ ...p, [f.key]: e.target.value }))}
                  disabled={f.disabled}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none disabled:bg-gray-50"
                />
              </div>
            ))}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Rol *</label>
                <select value={userForm.role} onChange={e => setUserForm(p => ({ ...p, role: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none">
                  <option value="master_admin">Master Admin</option>
                  <option value="clinic_admin">Admin Clínica</option>
                  <option value="clinic_user">Usuario</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Acceso</label>
                <select value={userForm.access_scope} onChange={e => setUserForm(p => ({ ...p, access_scope: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none">
                  <option value="all">Todos los pacientes</option>
                  <option value="own">Solo propios</option>
                </select>
              </div>
            </div>

            {userForm.role !== 'master_admin' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clínica</label>
                <select value={userForm.clinic_id} onChange={e => setUserForm(p => ({ ...p, clinic_id: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none">
                  <option value="">Sin clínica</option>
                  {clinics.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                </select>
              </div>
            )}

            {/* Contraseña (solo en creación) */}
            {!userModal.userId && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña *</label>
                  <input type="password" value={userForm.password} onChange={e => setUserForm(p => ({ ...p, password: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar *</label>
                  <input type="password" value={userForm.password2} onChange={e => setUserForm(p => ({ ...p, password2: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none" />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setUserModal({ open: false })} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={saveUser} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Guardar</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Modal: Reset Password ──────────────────────────────────────── */}
      {pwdModal.open && (
        <Modal title="Restablecer Contraseña" onClose={() => setPwdModal({ open: false })}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nueva contraseña</label>
              <input type="password" value={pwdForm.password} onChange={e => setPwdForm(p => ({ ...p, password: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar contraseña</label>
              <input type="password" value={pwdForm.password2} onChange={e => setPwdForm(p => ({ ...p, password2: e.target.value }))} className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none" />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setPwdModal({ open: false })} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={doResetPwd} className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600">Restablecer</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Modal: Clínica ────────────────────────────────────────────── */}
      {clinicModal.open && (
        <Modal title={clinicModal.clinicId ? 'Editar Clínica' : 'Nueva Clínica'} onClose={() => setClinicModal({ open: false })}>
          <div className="space-y-4">
            {[
              { label: 'Nombre *',     key: 'name' },
              { label: 'Slug (URL) *', key: 'slug' },
              { label: 'Email',        key: 'email' },
              { label: 'Teléfono',     key: 'phone' },
              { label: 'Dirección',    key: 'address' },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input
                  type="text"
                  value={(clinicForm as Record<string, string>)[f.key]}
                  onChange={e => setClinicForm(p => ({ ...p, [f.key]: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-300 focus:outline-none"
                />
              </div>
            ))}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setClinicModal({ open: false })} className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={saveClinic} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Guardar</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
