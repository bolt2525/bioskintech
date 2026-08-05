import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Sparkles, Eye, EyeOff, CheckCircle2, AlertCircle } from 'lucide-react';

export default function AdminSetupPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword]     = useState('');
  const [password2, setPassword2]   = useState('');
  const [showPwd, setShowPwd]       = useState(false);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [done, setDone]             = useState(false);

  useEffect(() => { if (!token) navigate('/admin/login'); }, [token, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (password !== password2) { setError('Las contraseñas no coinciden'); return; }
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/admin-auth?action=claimSetupToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const d = await r.json();
      if (d.success) { setDone(true); setTimeout(() => navigate('/admin/login'), 2500); }
      else setError(d.error || 'Enlace inválido o expirado');
    } catch { setError('Error de conexión'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#fdf8f0] via-white to-[#faf4ea] flex items-center justify-center px-4">
      <div className="relative max-w-md w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[#deb887] rounded-2xl shadow-lg shadow-[#deb887]/30 mb-4">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900" style={{ fontFamily: 'Playfair Display, serif' }}>BIOSKIN</h1>
          <p className="text-gray-400 mt-1 text-sm uppercase tracking-wide">Configura tu contraseña</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-[#deb887]/20 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-[#deb887] via-[#e8c98a] to-[#deb887]" />
          <div className="p-8">
            {done ? (
              <div className="text-center space-y-4 py-6">
                <CheckCircle2 className="w-14 h-14 text-green-500 mx-auto" />
                <h2 className="text-xl font-bold text-gray-900">¡Contraseña configurada!</h2>
                <p className="text-gray-500 text-sm">Redirigiendo al inicio de sesión...</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Crear contraseña</h2>
                  <p className="text-gray-400 text-sm mt-0.5">Elige una contraseña segura para tu cuenta</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Nueva contraseña</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type={showPwd ? 'text' : 'password'} value={password}
                      onChange={e => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres"
                      className="w-full pl-10 pr-10 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                    <button type="button" onClick={() => setShowPwd(p => !p)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                      {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirmar contraseña</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 w-4 h-4" />
                    <input required type={showPwd ? 'text' : 'password'} value={password2}
                      onChange={e => setPassword2(e.target.value)} placeholder="Repite la contraseña"
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-300 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] outline-none transition-all" />
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <p className="text-red-600 text-sm">{error}</p>
                  </div>
                )}

                <button type="submit" disabled={loading}
                  className="w-full py-3 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors shadow-md shadow-[#deb887]/30">
                  {loading ? 'Guardando...' : 'Configurar contraseña'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
