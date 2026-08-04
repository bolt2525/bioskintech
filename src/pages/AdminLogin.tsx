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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, Mail, Sparkles, Eye, EyeOff } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminLogin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, isAuthenticated } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd]   = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  // Redirigir si ya está autenticado
  useEffect(() => {
    if (isAuthenticated) navigate('/admin');
  }, [isAuthenticated, navigate]);

  // Manejar token de Google OAuth callback
  useEffect(() => {
    const token = searchParams.get('token');
    const googleError = searchParams.get('googleError');
    if (googleError) { setError(decodeURIComponent(googleError)); return; }
    if (token) {
      localStorage.setItem('bioskin_session_token', token);
      navigate('/admin'); // basename lo convierte a /gestionestetica/admin
    }
  }, [searchParams, navigate]);

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
      const result = await login(username, password);
      if (result.ok) {
        const u = result.user;
        if (u?.role === 'master_admin') {
          navigate('/admin/master');
        } else if (u?.clinic_slug && u?.username) {
          navigate(`/admin/${u.clinic_slug}/${u.username}`);
        } else {
          navigate('/admin');
        }
      } else {
        setError(result.error || 'Usuario o contraseña incorrectos');
      }
    } catch {
      setError('Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/admin-auth?action=googleAuthUrl&purpose=login');
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else setError(d.error || 'Error al conectar con Google');
    } catch { setError('Error al iniciar sesión con Google'); }
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

              {/* Divisor */}
              <div className="relative flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-100" />
                <span className="text-xs text-gray-300">o</span>
                <div className="flex-1 h-px bg-gray-100" />
              </div>

              {/* Google OAuth */}
              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:border-gray-300 hover:bg-gray-50 transition-all disabled:opacity-50"
              >
                <svg className="w-4 h-4" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.1 0 5.9 1.1 8 2.9l5.9-5.9C34.3 3.2 29.4 1 24 1 14.7 1 6.8 6.7 3.4 14.9l6.9 5.3C12 14.5 17.5 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7C35.8 32.5 32.3 35.5 28 36.9v5.6h7.9c4.6-4.2 7.3-10.5 7.3-18z"/><path fill="#FBBC05" d="M10.3 28.5A14.7 14.7 0 0 1 9.5 24c0-1.6.3-3.1.8-4.5L3.4 14.2A23.8 23.8 0 0 0 1 24c0 3.8.9 7.4 2.4 10.6l6.9-5.6z"/><path fill="#34A853" d="M24 47c6.4 0 11.8-2.1 15.7-5.7l-7.9-5.6c-2.1 1.4-4.8 2.2-7.8 2.2-6.3 0-11.6-4.2-13.5-9.8l-6.9 5.3C6.8 41.3 14.7 47 24 47z"/></svg>
                Continuar con Google
              </button>

            </form>
          </div>
        </div>

        {/* Link de registro */}
        <p className="text-center text-xs text-gray-400 mt-4">
          ¿Eres nuevo en BIOSKIN?{' '}
          <button onClick={() => navigate('/admin/register')} className="text-[#deb887] hover:underline font-medium">
            Registra tu clínica
          </button>
        </p>

        <p className="text-center text-xs text-gray-300 mt-2">
          BIOSKIN © {new Date().getFullYear()} · Panel Administrativo Interno
        </p>
      </div>
    </div>
  );
}
