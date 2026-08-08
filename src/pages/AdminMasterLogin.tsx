/**
 * @file src/pages/AdminMasterLogin.tsx
 * @description Página de acceso exclusivo para el Master Admin de BIOSKIN.
 *
 * Seguridad adicional vs login normal:
 *  - Requiere un tercer campo: la clave de acceso master (MASTER_LOGIN_KEY).
 *  - La URL no está enlazada desde ninguna parte del panel público.
 *  - No usar OTP para evitar circunvalar el login si el email cae.
 *
 * Flujo:
 *  username + password + master_key → /api/admin-auth?action=login → master_admin session
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, ShieldAlert, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import BrandLogo from '../components/ui/BrandLogo';

export default function AdminMasterLogin() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [showPwd, setShowPwd]     = useState(false);
  const [showKey, setShowKey]     = useState(false);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  // Estado del 2FA OTP
  const [otpStep, setOtpStep]         = useState(false);
  const [otpToken, setOtpToken]       = useState('');
  const [otpCode, setOtpCode]         = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');

  useEffect(() => {
    if (isAuthenticated) navigate('/admin/master');
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || !masterKey) {
      setError('Todos los campos son obligatorios');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/admin-auth?action=login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password, master_key: masterKey }),
      });
      const data = await res.json();

      if (data.requiresOTP) {
        setOtpStep(true);
        setOtpToken(data.otpToken || '');
        setMaskedEmail(data.maskedEmail || '');
        setLoading(false);
        return;
      }
      if (data.success && data.user?.role === 'master_admin') {
        sessionStorage.setItem('adminSessionToken', data.sessionToken);
        sessionStorage.setItem('adminUser', JSON.stringify(data.user));
        sessionStorage.setItem('adminSessionExpiry', String(data.expiresAt));
        navigate('/admin/master');
      } else {
        setError(data.error || 'Acceso denegado');
      }
    } catch {
      setError('Error de conexión');
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
      if (d.success && d.user?.role === 'master_admin') {
        sessionStorage.setItem('adminSessionToken', d.sessionToken);
        sessionStorage.setItem('adminUser', JSON.stringify(d.user));
        sessionStorage.setItem('adminSessionExpiry', String(d.expiresAt));
        navigate('/admin/master');
      } else {
        setError(d.error || 'Código incorrecto o acceso no autorizado');
      }
    } catch { setError('Error de conexión'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Branding */}
        <div className="text-center mb-8">
          <BrandLogo className="h-20 w-auto object-contain mx-auto opacity-90" />
          <div className="flex items-center justify-center gap-2 mt-3">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            <p className="text-amber-500 text-xs font-semibold tracking-widest uppercase">
              Acceso Maestro
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-gray-800 rounded-2xl border border-gray-700 overflow-hidden shadow-2xl">
          <div className="h-1 bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600" />

          <div className="p-8">
            {otpStep ? (
              <form onSubmit={handleVerifyOTP} className="space-y-5">
                <div className="text-center">
                  <ShieldCheck className="w-10 h-10 text-amber-400 mx-auto mb-2" />
                  <h2 className="text-base font-semibold text-gray-100">Verificación 2FA</h2>
                  <p className="text-gray-400 text-sm mt-1">
                    Código enviado a <strong className="text-gray-200">{maskedEmail}</strong>
                  </p>
                </div>
                <input
                  type="text" inputMode="numeric" maxLength={6} autoFocus required
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-center text-3xl font-mono tracking-widest text-white focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 outline-none"
                />
                {error && <p className="text-red-400 text-sm text-center">{error}</p>}
                <button type="submit" disabled={loading || otpCode.length < 6}
                  className="w-full py-2.5 bg-amber-600 text-white rounded-xl font-semibold text-sm hover:bg-amber-500 disabled:opacity-50 transition-all">
                  {loading ? 'Verificando...' : 'Confirmar acceso'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <h2 className="text-gray-100 font-semibold text-base mb-1">Autenticación de sistema</h2>
                  <p className="text-gray-500 text-xs">Acceso restringido — solo personal autorizado.</p>
                </div>

                {/* Username */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Usuario</label>
                  <input
                    type="text" autoComplete="off" required
                    value={username} onChange={e => setUsername(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-700 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 outline-none text-sm"
                  />
                </div>

                {/* Password */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">Contraseña</label>
                  <div className="relative">
                    <input
                      type={showPwd ? 'text' : 'password'} autoComplete="current-password" required
                      value={password} onChange={e => setPassword(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-700 border border-gray-600 rounded-xl text-white placeholder-gray-500 focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 outline-none text-sm pr-10"
                    />
                    <button type="button" onClick={() => setShowPwd(!showPwd)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                      {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Master Key */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    <Lock className="w-3 h-3 inline mr-1 text-amber-500" />
                    Clave de acceso maestro
                  </label>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'} autoComplete="off" required
                      value={masterKey} onChange={e => setMasterKey(e.target.value)}
                      placeholder="MASTER_LOGIN_KEY"
                      className="w-full px-4 py-2.5 bg-gray-700 border border-amber-700/50 rounded-xl text-white placeholder-gray-600 focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 outline-none text-sm pr-10 font-mono"
                    />
                    <button type="button" onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3">
                    <p className="text-red-400 text-sm">{error}</p>
                  </div>
                )}

                <button type="submit" disabled={loading}
                  className="w-full py-2.5 bg-amber-600 text-white rounded-xl font-semibold text-sm hover:bg-amber-500 disabled:opacity-50 transition-all shadow-lg shadow-amber-900/30 mt-2">
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Verificando...
                    </span>
                  ) : 'Acceder al sistema'}
                </button>
              </form>
            )}
          </div>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          Acceso registrado y monitoreado. Panel de administración BIOSKIN.
        </p>
      </div>
    </div>
  );
}
