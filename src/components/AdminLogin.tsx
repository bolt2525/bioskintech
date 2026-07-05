// src/components/AdminLogin.tsx
// Componente de login para acceso administrativo

import React, { useState, useEffect } from 'react';
import { Lock, User, Eye, EyeOff } from 'lucide-react';

interface AdminLoginProps {
  onLogin: (success: boolean) => void;
}

const AdminLogin: React.FC<AdminLoginProps> = ({ onLogin }) => {
  const [credentials, setCredentials] = useState({
    username: '',
    password: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // CONFIGURACIÓN DE CREDENCIALES SEGURAS - ÚNICO ACCESO VÁLIDO
  const VALID_CREDENTIALS = 'admin:b10sk1n';
  
  // Función de validación robusta
  const validateCredentials = (username: string, password: string): boolean => {
    const inputCombination = `${username.trim()}:${password}`;
    
    // Bloquear específicamente admin/admin
    if (username.trim() === 'admin' && password === 'admin') {
      return false;
    }
    
    const isValid = inputCombination === VALID_CREDENTIALS;
    return isValid;
  };

  // Limpiar cualquier sesión anterior al cargar el componente
  useEffect(() => {
    localStorage.clear();
    // También limpiar cookies si las hay
    document.cookie.split(";").forEach((c) => {
      document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Validación de credenciales con método robusto
    setTimeout(() => {
      const isValid = validateCredentials(credentials.username, credentials.password);
      
      if (isValid) {
        // Acceso autorizado
        localStorage.clear();
        localStorage.setItem('bioskin_admin_session', 'authenticated');
        localStorage.setItem('bioskin_admin_timestamp', Date.now().toString());
        onLogin(true);
      } else {
        // Acceso denegado
        localStorage.clear();
        setError('Credenciales incorrectas');
        onLogin(false);
        setCredentials({ username: '', password: '' });
      }
      setIsLoading(false);
    }, 800);
  };

  const handleInputChange = (field: 'username' | 'password') => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setCredentials(prev => ({
      ...prev,
      [field]: e.target.value
    }));
    if (error) setError('');
  };

  const clearAllSessions = () => {
    localStorage.clear();
    setError('');
    setCredentials({ username: '', password: '' });
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 bg-[#deb887] rounded-full flex items-center justify-center mb-4">
            <Lock className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Panel de Administración</h1>
          <p className="text-gray-600 mt-2">BIOSKIN - Acceso Restringido</p>
        </div>

        {/* Login Form */}
        <div className="bg-white rounded-xl shadow-lg p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Username */}
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-2">
                Usuario
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  id="username"
                  type="text"
                  required
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  value={credentials.username}
                  onChange={handleInputChange('username')}
                  className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
                  placeholder="Ingresa tu usuario"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                Contraseña
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  value={credentials.password}
                  onChange={handleInputChange('password')}
                  className="block w-full pl-10 pr-10 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
                  placeholder="Ingresa tu contraseña"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-400 hover:text-gray-600" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-400 hover:text-gray-600" />
                  )}
                </button>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className={`w-full flex justify-center py-3 px-4 border border-transparent rounded-lg text-sm font-medium text-white ${
                isLoading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-[#deb887] hover:bg-[#d4a574] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#deb887]'
              }`}
            >
              {isLoading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                  Verificando...
                </>
              ) : (
                'Iniciar Sesión'
              )}
            </button>
          </form>

          {/* Info */}
          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500 mb-3">
              Acceso exclusivo para personal autorizado
            </p>
            <button
              type="button"
              onClick={clearAllSessions}
              className="text-xs text-red-500 hover:text-red-700 underline"
            >
              Limpiar todas las sesiones
            </button>
          </div>
        </div>

        {/* Quick Access */}
        <div className="mt-6 text-center">
          <a
            href="/#/"
            className="text-[#deb887] hover:text-[#d4a574] text-sm font-medium"
          >
            ← Volver al sitio principal
          </a>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;