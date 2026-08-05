/**
 * @file src/components/layout/AdminLayout.tsx
 * @description Layout base para todas las páginas del panel de administración.
 *
 * Provee:
 *  - Header con título, subtítulo y breadcrumbs opcionales
 *  - Botón de regreso configurable
 *  - Usuario autenticado + botón de cerrar sesión
 *  - Fondo oscuro gradient para el área de contenido
 *
 * USO:
 *   <AdminLayout title="Fichas Clínicas" subtitle="Gestión de pacientes" showBack backPath="/admin">
 *     {children}
 *   </AdminLayout>
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, LogOut, User, ChevronRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import type { Breadcrumb } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  showBack?: boolean;
  backPath?: string;
  breadcrumbs?: Breadcrumb[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminLayout({
  children,
  title,
  subtitle,
  showBack = true,
  backPath,
  breadcrumbs,
}: AdminLayoutProps) {
  const navigate = useNavigate();
  const { username, logout, user } = useAuth();
  const [demoTimeLeft, setDemoTimeLeft] = useState('');

  useEffect(() => {
    if (!user?.is_demo || !user?.demo_expires_at) return;
    const update = () => {
      const ms = new Date(user.demo_expires_at!).getTime() - Date.now();
      if (ms <= 0) { setDemoTimeLeft('Expirada'); return; }
      const d = Math.floor(ms / 86400000);
      const h = Math.floor((ms % 86400000) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      setDemoTimeLeft(d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, [user?.is_demo, user?.demo_expires_at]);

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  const handleBack = () => {
    if (backPath) navigate(backPath);
    else navigate(-1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Demo banner */}
      {user?.is_demo && (
        <div className="bg-amber-500 text-white text-center text-xs py-2 px-4 font-medium sticky top-0 z-[60] flex items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1">
            ⏱ <strong>Cuenta Demo</strong> — Tiempo restante: <strong>{demoTimeLeft}</strong>
          </span>
          <span className="opacity-75">· Los datos serán eliminados al vencer</span>
        </div>
      )}

      {/* Subscription warning banner */}
      {!user?.is_demo && typeof user?.subscriptionWarningDays === 'number' && user.subscriptionWarningDays <= 21 && (
        <div className={`text-white text-center text-xs py-2 px-4 font-medium sticky top-0 z-[60] flex items-center justify-center gap-2 ${user.subscriptionWarningDays <= 7 ? 'bg-red-500' : 'bg-orange-500'}`}>
          <span>
            ⚠️ Tu suscripción vence en <strong>{user.subscriptionWarningDays} días</strong>
          </span>
          <span className="opacity-80">· Contacta al administrador para renovar</span>
        </div>
      )}

      {/* ── Header fijo ───────────────────────────────────────────────── */}
      <div className="bg-white shadow-lg sticky top-0 z-50">
        <div className="container-custom py-4">
          <div className="flex items-center justify-between">

            {/* Izquierda: botón back + título + breadcrumbs */}
            <div className="flex items-center gap-4">
              {showBack && (
                <button
                  onClick={handleBack}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  aria-label="Volver"
                >
                  <ArrowLeft className="w-5 h-5 text-gray-600" />
                </button>
              )}

              <div>
                {/* Breadcrumbs opcionales */}
                {breadcrumbs && breadcrumbs.length > 0 && (
                  <nav className="flex items-center gap-1 mb-1" aria-label="Ruta de navegación">
                    {breadcrumbs.map((crumb, i) => (
                      <React.Fragment key={crumb.path}>
                        {i > 0 && <ChevronRight className="w-3 h-3 text-gray-400" />}
                        <button
                          onClick={() => navigate(crumb.path)}
                          className="text-xs text-[#deb887] hover:text-[#c9a96e] hover:underline transition-colors font-medium"
                        >
                          {crumb.label}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                )}
                <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
                {subtitle && <p className="text-gray-600 text-sm">{subtitle}</p>}
              </div>
            </div>

            {/* Derecha: usuario + logout */}
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 text-gray-700">
                <User className="w-5 h-5" />
                <span className="font-medium">{username}</span>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors text-sm"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden md:inline">Cerrar Sesión</span>
              </button>
            </div>

          </div>
        </div>
      </div>

      {/* ── Contenido ─────────────────────────────────────────────────── */}
      <div className="container-custom py-8">
        {children}
      </div>
    </div>
  );
}
