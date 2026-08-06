/**
 * @file src/pages/AdminLogin.tsx
 * @description Página de login del panel de administración BIOSKIN.
 *
 * Flujo:
 *  1. Si ya hay sesión activa → redirige a /admin
 *  2. Valida username/password contra /api/admin-auth?action=login
 *  3. En éxito → navega a /admin (AuthContext maneja la persistencia)
 *
 * Acceso especial: el usuario 'medical-finance' redirige a /medical-finance
 * sin pasar por el sistema de roles (página de gestión médica externa).
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, Mail, Sparkles, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import SkinExplorerButton from '../skin-explorer/SkinExplorerButton';

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminLogin() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd]   = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  // Estado del segundo paso 2FA
  const [otpStep, setOtpStep]         = useState(false);
  const [otpToken, setOtpToken]       = useState('');
  const [otpCode, setOtpCode]         = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);

  // Redirigir si ya está autenticado
  useEffect(() => {
    if (isAuthenticated) navigate('/admin');
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Acceso especial: gestión médica externa (usuario sin rol admin)
    if (username === 'mary' && password === 'b10sk1n.1125') {
      setLoading(false);
      navigate('/medical-finance');
      return;
    }

    try {
      const result = await login(username, password) as any;
      if (result.requiresOTP) {
        setOtpStep(true); setOtpToken(result.otpToken || ''); setMaskedEmail(result.maskedEmail || '');
        setLoading(false); return;
      }
      if (result.ok) {
        const u = result.user;
        if (u?.role === 'master_admin') navigate('/admin/master');
        else if (u?.clinic_slug && u?.username) navigate(`/admin/${u.clinic_slug}/${u.username}`);
        else navigate('/admin');
      } else {
        setError(result.error || 'Usuario o contraseña incorrectos');
      }
    } catch {
      setError('Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otpCode.length < 6) return;
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/admin-auth?action=verifyOTP', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otpToken, code: otpCode }),
      });
      const d = await r.json();
      if (d.success) {
        if (trustDevice) {
          const newDeviceToken = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
          localStorage.setItem('bioskin_device_token', newDeviceToken);
          try {
            await fetch('/api/admin-auth?action=trustDevice', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${d.sessionToken}` },
              body: JSON.stringify({ device_token: newDeviceToken }),
            });
          } catch { /* non-fatal */ }
        }
        sessionStorage.setItem('adminSessionToken', d.sessionToken);
        sessionStorage.setItem('adminUser', JSON.stringify({ ...d.user, subscriptionWarningDays: d.subscriptionWarningDays }));
        sessionStorage.setItem('adminSessionExpiry', String(d.expiresAt));
        const u = d.user;
        if (u.role === 'master_admin') navigate('/admin/master');
        else if (u.clinic_slug) navigate(`/admin/${u.clinic_slug}/${u.username}`);
        else navigate('/admin');
      } else {
        setError(d.error || 'Código incorrecto');
      }
    } catch { setError('Error de conexión'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea] flex items-center justify-center px-4 relative overflow-hidden">

      {/* Blobs decorativos de fondo */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-48 -right-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-48 -left-48 w-96 h-96 bg-[#deb887]/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-[#deb887]/5 rounded-full blur-3xl" />
      </div>

      <div className="relative max-w-md w-full">

        {/* ── Branding ─────────────────────────────────────────────── */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[#deb887] rounded-2xl shadow-lg shadow-[#deb887]/30 mb-4">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1
            className="text-4xl font-bold text-gray-900 tracking-tight"
            style={{ fontFamily: 'Playfair Display, serif' }}
          >
            BIOSKIN
          </h1>
          <p className="text-gray-400 mt-1.5 text-sm tracking-wide uppercase">
            Sistema de Gestión Clínica
          </p>
        </div>

        {/* ── Card de login ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-xl border border-[#deb887]/20 overflow-hidden">
          {/* Barra dorada superior */}
          <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />

          <div className="p-8">
            {otpStep ? (
              /* ── Segundo paso: verificación OTP ──────────────────── */
              <form onSubmit={handleVerifyOTP} className="space-y-5">
                <div className="text-center">
                  <ShieldCheck className="w-12 h-12 text-[#deb887] mx-auto mb-3" />
                  <h2 className="text-lg font-semibold text-gray-900">Verificación en dos pasos</h2>
                  <p className="text-gray-400 text-sm mt-1">
                    Enviamos un código de 6 dígitos a <strong>{maskedEmail}</strong>
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Código de verificación</label>
                  <input
                    type="text" inputMode="numeric" maxLength={6} autoFocus required
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="w-full px-4 py-3 border border-gray-200 rounded-xl text-center text-3xl font-mono tracking-widest text-gray-800 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={trustDevice} onChange={e => setTrustDevice(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#deb887]" />
                  <span className="text-xs text-gray-500">No pedir código en este dispositivo por 30 días</span>
                </label>
                {error && (
                  <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                    <p className="text-red-600 text-sm">{error}</p>
                  </div>
                )}
                <button type="submit" disabled={loading || otpCode.length < 6}
                  className="w-full py-2.5 bg-[#deb887] text-white rounded-xl font-semibold text-sm hover:bg-[#c5a075] disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm shadow-[#deb887]/20">
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      Verificando...
                    </span>
                  ) : 'Confirmar acceso'}
                </button>
                <button type="button" onClick={() => { setOtpStep(false); setOtpCode(''); setError(''); }}
                  className="w-full text-sm text-gray-400 hover:text-gray-600 transition-colors py-1">
                  ← Volver al inicio de sesión
                </button>
                <p className="text-center text-xs text-gray-400">
                  ¿No llegó el código?{' '}
                  <button type="button" onClick={() => navigate('/admin/recover')}
                    className="text-[#deb887] hover:underline font-medium">
                    Recuperar acceso
                  </button>
                </p>
              </form>
            ) : (
              /* ── Primer paso: usuario + contraseña ───────────────── */
              <>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Acceso al Panel</h2>
              <p className="text-gray-400 text-sm mt-0.5">
                Ingresa tus credenciales para continuar
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">

              {/* Correo / Usuario */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Correo electrónico o usuario
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                    placeholder="tu@correo.com"
                    autoComplete="username"
                    required
                  />
                </div>
              </div>

              {/* Contraseña */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Contraseña
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                  <button type="button" onClick={() => setShowPwd(p => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition-colors">
                    {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Mensaje de error */}
              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 flex items-start gap-2.5">
                  <div className="w-1.5 h-1.5 bg-red-400 rounded-full mt-1.5 flex-shrink-0" />
                  <p className="text-red-600 text-sm">{error}</p>
                </div>
              )}

              {/* Botón de submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#deb887] text-white py-2.5 rounded-xl font-semibold text-sm hover:bg-[#c5a075] active:scale-[0.98] transition-all shadow-sm shadow-[#deb887]/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Verificando...
                  </span>
                ) : (
                  'Ingresar al Sistema'
                )}
              </button>


            </form>
            </>
            )}
          </div>
        </div>

        {/* Link de registro */}
        <p className="text-center text-xs text-gray-400 mt-4">
          ¿Eres nuevo en BIOSKIN?{' '}
          <button onClick={() => navigate('/admin/register')} className="text-[#deb887] hover:underline font-medium">
            Registra tu clínica
          </button>
        </p>

        {/* DermoAtlas 3D — teaser interactivo */}
        <SkinExplorerButton />

        <p className="text-center text-xs text-gray-300 mt-2">
          BIOSKIN © {new Date().getFullYear()} · Panel Administrativo Interno
        </p>
      </div>
    </div>
  );
}
