/**
 * @file src/pages/InviteRegister.tsx
 * @description Página de registro por link de invitación.
 *
 * Flujo:
 *  1. Lee ?token= de la URL
 *  2. Llama getInvite → obtiene clínica + rol sin consumir el link
 *  3. Muestra formulario personal (sin campos de clínica)
 *  4. Submit → useInvite → login automático
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  User, Mail, Lock, Eye, EyeOff, Building2, CheckCircle2,
  AlertCircle, Loader2, ShieldCheck, KeyRound, AtSign,
} from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';
import { useAuth } from '../context/AuthContext';

const API = '/api/admin-auth';

const ROLE_LABEL: Record<string, string> = {
  clinic_admin: 'Administrador de Clínica',
  clinic_user:  'Usuario',
};

export default function InviteRegister() {
  const navigate        = useNavigate();
  const [searchParams]  = useSearchParams();
  const { checkAuth }   = useAuth();
  const token           = searchParams.get('token') || '';

  const [loading,    setLoading]    = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState('');

  const [invite, setInvite] = useState<{
    clinic_name: string; role: string; email: string | null;
    access_scope: string; features: string[];
  } | null>(null);
  const [inviteError, setInviteError] = useState('');

  // Campos del formulario — alineados con AdminRegister.tsx
  const [gentilicio,       setGentilicio]       = useState('');
  const [firstName,        setFirstName]        = useState('');
  const [lastName,         setLastName]         = useState('');
  const [profession,       setProfession]       = useState('');
  const [especialidad,     setEspecialidad]     = useState('');
  const [cedulaPro,        setCedulaPro]        = useState('');
  const [matriculaSenescyt, setMatriculaSenescyt] = useState('');
  const [email,            setEmail]            = useState('');
  const [username,         setUsername]         = useState('');
  const [password,         setPassword]         = useState('');
  const [showPwd,          setShowPwd]          = useState(false);
  const [acceptedTerms,    setAcceptedTerms]    = useState(false);
  const [emailTaken,       setEmailTaken]       = useState(false);
  const [emailChecking,    setEmailChecking]    = useState(false);
  const [uCheck,           setUCheck]           = useState<'idle'|'checking'|'ok'|'taken'>('idle');

  useEffect(() => {
    if (!token) { setInviteError('No se encontró el token de invitación.'); setLoading(false); return; }
    fetch(`${API}?action=getInvite&token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (!d.valid) { setInviteError(d.error || 'Enlace inválido o expirado'); return; }
        setInvite(d);
        if (d.email && !d.email.includes('***')) setEmail(d.email);
      })
      .catch(() => setInviteError('Error al verificar la invitación'))
      .finally(() => setLoading(false));
  }, [token]);

  function buildUsername(fn: string, ln: string): string {
    const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const f = norm(fn); const l = norm(ln);
    if (!f && !l) return '';
    if (!l) return f.substring(0, 12);
    return `${f[0] || ''}${l}`.substring(0, 20);
  }

  const handleNameChange = (fn: string, ln: string) => {
    const s = buildUsername(fn, ln);
    if (s) { setUsername(s); setUCheck('idle'); }
  };

  const checkUsername = async (val: string) => {
    const u = val.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!u || u.length < 3) return;
    setUCheck('checking');
    try {
      const r = await fetch(`${API}?action=checkUsernamePublic&username=${encodeURIComponent(u)}`);
      const d = await r.json();
      setUCheck(d.available ? 'ok' : 'taken');
    } catch { setUCheck('idle'); }
  };

  const checkEmail = async (val: string) => {
    const e = val.trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    setEmailChecking(true);
    try {
      const r = await fetch(`${API}?action=checkEmail&email=${encodeURIComponent(e)}`);
      const d = await r.json();
      setEmailTaken(!d.available);
    } catch { /* ignore */ }
    finally { setEmailChecking(false); }
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!firstName.trim() || !lastName.trim()) { setError('Nombre y apellido son requeridos'); return; }
    if (!email.trim() || !email.includes('@'))  { setError('Email válido requerido'); return; }
    if (emailTaken) { setError('Este email ya está en uso. Usa otro correo.'); return; }
    if (!username.trim() || username.trim().length < 3) { setError('El usuario debe tener al menos 3 caracteres'); return; }
    if (uCheck === 'taken') { setError('El nombre de usuario ya está en uso'); return; }
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError('La contraseña debe contener al menos una letra y un número'); return;
    }
    if (!acceptedTerms) { setError('Debes aceptar los Términos de Servicio para continuar'); return; }

    setSubmitting(true);
    try {
      const r = await fetch(`${API}?action=useInvite`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          email:              email.trim().toLowerCase(),
          username:           username.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
          password,
          first_name:         firstName.trim(),
          last_name:          lastName.trim(),
          gentilicio:         gentilicio || undefined,
          profession:         profession.trim() || undefined,
          especialidad:       especialidad.trim() || undefined,
          cedula_profesional: cedulaPro.trim() || undefined,
          matricula_senescyt: matriculaSenescyt.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!d.success) {
        if (d.field === 'email') setEmailTaken(true);
        if (d.field === 'username') setUCheck('taken');
        setError(d.error || 'Error al registrarse');
        return;
      }
      localStorage.setItem('adminToken', d.sessionToken);
      await checkAuth();
      navigate('/admin', { replace: true });
    } catch { setError('Error de conexión. Intenta de nuevo.'); }
    finally { setSubmitting(false); }
  }

  // ─── Render: cargando ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea]">
        <Loader2 className="w-8 h-8 text-[#deb887] animate-spin" />
      </div>
    );
  }

  // ─── Render: error de invite ─────────────────────────────────────────────
  if (inviteError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea] px-4">
        <div className="bg-white rounded-2xl shadow-xl border border-red-100 p-8 max-w-sm w-full text-center space-y-4">
          <div className="w-14 h-14 bg-red-50 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-7 h-7 text-red-500" />
          </div>
          <h2 className="text-lg font-bold text-gray-900">Enlace inválido</h2>
          <p className="text-sm text-gray-500">{inviteError}</p>
          <button
            onClick={() => navigate('/admin/login')}
            className="w-full py-2.5 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] transition-colors"
          >
            Ir al inicio de sesión
          </button>
        </div>
      </div>
    );
  }

  // ─── Render: formulario ──────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea] flex items-center justify-center px-4 py-10 relative overflow-hidden">
      {/* Blobs decorativos */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-48 -right-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-48 -left-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-md w-full">
        {/* Branding */}
        <div className="text-center mb-6">
          <BrandLogo className="h-20 w-auto object-contain mx-auto" />
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-[#deb887]/20 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />

          {/* Cabecera con clínica */}
          <div className="px-6 pt-6 pb-4 bg-gradient-to-br from-[#fdf8f0] to-white border-b border-[#deb887]/15">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-[#deb887]/15 rounded-xl flex items-center justify-center flex-shrink-0">
                <Building2 className="w-5 h-5 text-[#deb887]" />
              </div>
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">Invitación de</p>
                <p className="text-lg font-bold text-gray-900 leading-tight">{invite?.clinic_name}</p>
                <p className="text-sm text-[#deb887] font-medium mt-0.5">
                  Rol: {ROLE_LABEL[invite?.role || ''] || invite?.role}
                </p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
              Enlace de un solo uso — seguro y verificado
            </div>
          </div>

          {/* Formulario */}
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Crea tu cuenta</h2>
              <p className="text-xs text-gray-400 mt-0.5">Completa tus datos para unirte a {invite?.clinic_name}</p>
            </div>

            {/* Gentilicio */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Título / Gentilicio</label>
              <select value={gentilicio} onChange={e => setGentilicio(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none bg-white transition-all">
                <option value="">Sin título</option>
                <option>Dr.</option><option>Dra.</option>
                <option>Md.</option>
                <option>Odont.</option>
                <option>Lcdo.</option><option>Lcda.</option>
                <option>Lic.</option>
                <option>Enf.</option>
                <option>Psic.</option>
                <option>Nut.</option>
                <option>Bioquím.</option>
                <option>Farm.</option>
                <option>Ing.</option>
                <option>Mg.</option><option>Mgtr.</option>
                <option>Ph.D.</option>
                <option>Cosm.</option>
                <option>Cosmiatra</option>
                <option>Esteticista</option>
                <option>Sr.</option><option>Sra.</option>
              </select>
            </div>

            {/* Nombre + Apellido */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nombres *</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-3.5 h-3.5" />
                  <input type="text" value={firstName} required
                    onChange={e => { setFirstName(e.target.value); handleNameChange(e.target.value, lastName); }}
                    placeholder="Ana María"
                    className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Apellidos *</label>
                <input type="text" value={lastName} required
                  onChange={e => { setLastName(e.target.value); handleNameChange(firstName, e.target.value); }}
                  placeholder="García López"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
            </div>

            {/* Profesión + Especialidad */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Profesión</label>
                <input type="text" value={profession} onChange={e => setProfession(e.target.value)}
                  placeholder="Médico Estético, Cosmiatra..."
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Especialidad</label>
                <input type="text" value={especialidad} onChange={e => setEspecialidad(e.target.value)}
                  placeholder="Medicina Estética..."
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
            </div>

            {/* Cédula e identidad + Matrícula SENESCYT */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Cédula / RUC</label>
                <input type="text" value={cedulaPro} onChange={e => setCedulaPro(e.target.value)}
                  placeholder="Ej: 0987654321"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Matrícula SENESCYT</label>
                <input type="text" value={matriculaSenescyt} onChange={e => setMatriculaSenescyt(e.target.value)}
                  placeholder="Ej: 1020-12-86012345"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
            </div>

            {/* Email */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Correo electrónico de acceso *</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-3.5 h-3.5" />
                <input type="email" value={email} required
                  onChange={e => { setEmail(e.target.value); setEmailTaken(false); }}
                  onBlur={e => checkEmail(e.target.value)}
                  placeholder="tucorreo@ejemplo.com"
                  className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
              </div>
              {emailChecking && <p className="text-xs text-gray-400 mt-1">Verificando disponibilidad...</p>}
              {emailTaken    && <p className="text-xs text-red-500 mt-1">Este email ya está en uso. Usa otro correo.</p>}
            </div>

            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1 flex items-center gap-1.5">
                <AtSign className="w-3 h-3" />
                Nombre de usuario *
                {uCheck === 'checking' && <span className="text-gray-400 font-normal ml-1">verificando...</span>}
                {uCheck === 'ok'       && <span className="text-emerald-600 font-normal ml-1">✓ disponible</span>}
                {uCheck === 'taken'    && <span className="text-red-500 font-normal ml-1">ya en uso</span>}
              </label>
              <input type="text" value={username} required
                onChange={e => { setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); setUCheck('idle'); }}
                onBlur={e => checkUsername(e.target.value)}
                placeholder="usuario_clinica"
                minLength={3} maxLength={20}
                className={`w-full px-3 py-2.5 border rounded-xl text-sm font-mono text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all ${uCheck === 'taken' ? 'border-red-300' : 'border-gray-200'}`}
              />
              <p className="text-xs text-gray-400 mt-1">Solo letras, números y guión bajo. También puedes ingresar con este nombre.</p>
            </div>

            {/* Contraseña */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Contraseña *</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 w-3.5 h-3.5" />
                <input type={showPwd ? 'text' : 'password'} value={password} required
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Mínimo 8 caracteres, letras y números"
                  className="w-full pl-9 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                <button type="button" onClick={() => setShowPwd(p => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {password.length > 0 && password.length < 8 && (
                <p className="text-xs text-amber-500 mt-1">Mínimo 8 caracteres</p>
              )}
            </div>

            {/* Términos */}
            <label className="flex items-start gap-3 p-3 rounded-xl border border-[#deb887]/20 bg-[#fdf8f0] cursor-pointer hover:bg-[#fdf0e0] transition-colors">
              <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded accent-[#deb887] flex-shrink-0" />
              <span className="text-xs text-gray-600 leading-relaxed">
                He leído y acepto las{' '}
                <a href="/condiciones-de-servicio" target="_blank" rel="noopener noreferrer" className="text-[#deb887] font-semibold hover:underline">Condiciones de Servicio</a>
                {' '}y la{' '}
                <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="text-[#deb887] font-semibold hover:underline">Política de Privacidad</a>
                {' '}de BioSkinTech. <span className="text-red-500">(Obligatorio)</span>
              </span>
            </label>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            {/* Submit */}
            <button type="submit" disabled={submitting || uCheck === 'taken' || emailTaken || !acceptedTerms}
              className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-bold hover:bg-[#c9a876] disabled:opacity-50 transition-colors flex items-center justify-center gap-2 shadow-md shadow-[#deb887]/30">
              {submitting
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Creando cuenta...</>
                : <><CheckCircle2 className="w-4 h-4" /> Crear mi cuenta</>
              }
            </button>

            <p className="text-center text-xs text-gray-400">
              ¿Ya tienes cuenta?{' '}
              <button type="button" onClick={() => navigate('/admin/login')}
                className="text-[#deb887] hover:underline font-medium">Inicia sesión</button>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
