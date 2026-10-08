/**
 * @file src/components/layout/AdminLayout.tsx
 * @description Layout base para todas las páginas del panel de administración.
 *
 * Provee:
 *  - Header con título, subtítulo y breadcrumbs opcionales
 *  - Botón de regreso configurable
 *  - Usuario autenticado + botón de cerrar sesión
 *  - Fondo claro con retícula sutil para el área de contenido
 *
 * USO:
 *   <AdminLayout title="Fichas Clínicas" subtitle="Gestión de pacientes" showBack backPath="/admin">
 *     {children}
 *   </AdminLayout>
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, LogOut, User, ChevronRight } from 'lucide-react';
import { MotionConfig } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';
import type { Breadcrumb } from '../../types';
import AppFooter from './AppFooter';

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
    <div className="admin-layout-shell min-h-screen">
      {/* Demo banner */}
      {user?.is_demo && (
        <div className="bg-amber-500 text-white text-center text-xs py-2 px-4 font-medium sticky top-0 z-[60] flex items-center justify-center gap-2">
          <span className="inline-flex items-center gap-1">
            ⏱ <strong>Cuenta Demo</strong> — Tiempo restante: <strong>{demoTimeLeft}</strong>
          </span>
          <span className="opacity-75">· Los datos serán eliminados al vencer</span>
        </div>
      )}

      {/* ── Header fijo ───────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-white/70 bg-white/95 shadow-sm backdrop-blur-xl">
        <div className="container-custom py-3 md:py-4">
          <div className="flex items-center justify-between">

            {/* Izquierda: botón back + título + breadcrumbs */}
            <div className="flex min-w-0 items-center gap-2 sm:gap-4">
              {showBack && (
                <button
                  onClick={handleBack}
                  className="admin-focus-ring admin-interactive shrink-0 rounded-full p-2 hover:bg-gray-100"
                  aria-label="Volver"
                >
                  <ArrowLeft className="w-5 h-5 text-gray-600" />
                </button>
              )}

              <div className="min-w-0">
                {/* Breadcrumbs opcionales */}
                {breadcrumbs && breadcrumbs.length > 0 && (
                  <nav className="flex items-center gap-1 mb-1" aria-label="Ruta de navegación">
                    {breadcrumbs.map((crumb, i) => (
                      <React.Fragment key={crumb.path}>
                        {i > 0 && <ChevronRight className="w-3 h-3 text-gray-400" />}
                        <button
                          onClick={() => navigate(crumb.path)}
                          className="admin-focus-ring rounded text-xs font-medium text-[#8b6840] transition-colors hover:text-[#6f5030] hover:underline"
                        >
                          {crumb.label}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                )}
                <h1 className="truncate text-xl font-bold text-gray-900 sm:text-2xl">{title}</h1>
                {subtitle && <p className="line-clamp-2 text-xs text-gray-600 sm:text-sm">{subtitle}</p>}
              </div>
            </div>

            {/* Derecha: usuario + logout */}
            <div className="ml-2 flex shrink-0 items-center gap-2 sm:gap-4">
              <div className="hidden max-w-48 items-center gap-2 text-gray-700 md:flex">
                <User className="w-5 h-5" />
                <span className="truncate font-medium">{username}</span>
              </div>
              <button
                onClick={handleLogout}
                className="admin-focus-ring admin-interactive flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:border-red-200 hover:bg-red-100 sm:px-4"
                aria-label="Cerrar sesión"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden md:inline">Cerrar Sesión</span>
              </button>
            </div>

          </div>
        </div>
      </header>

      {/* ── Contenido ─────────────────────────────────────────────────── */}
      <main className="container-custom admin-page-enter py-5 sm:py-8">
        <MotionConfig reducedMotion="user">
          {children}
        </MotionConfig>
      </main>
      <AppFooter theme="light" />
    </div>
  );
}
