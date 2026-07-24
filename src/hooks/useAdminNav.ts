/**
 * @file src/hooks/useAdminNav.ts
 * @description Hook de navegación con prefijo de clínica/usuario.
 *
 * Genera URLs con el patrón:
 *   - Clinic user:              /admin/{clinicSlug}/{username}/{módulo}
 *   - Master admin normal:      /admin/master/{módulo}
 *   - Master viendo clínica:    /admin/master/{clinicSlug}/{username}/{módulo}
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useMasterView } from '../context/MasterViewContext';

export function useAdminNav() {
  const navigate = useNavigate();
  const { user }  = useAuth();
  const masterView = useMasterView();

  /** Base path para el usuario autenticado */
  const base = (() => {
    // Master admin viendo una clínica específica
    if (masterView.isActive && masterView.baseUrl) return masterView.baseUrl;
    if (!user) return '/admin';
    if (user.role === 'master_admin') return '/admin/master';
    const slug = user.clinic_slug || 'clinic';
    return `/admin/${slug}/${user.username}`;
  })();

  /** Construye la URL completa para un módulo */
  const to = useCallback((path: string) => {
    if (!path) return base;
    if (path.startsWith('/')) return path;
    return `${base}/${path}`;
  }, [base]);

  /** Navega a un módulo relativo al base del usuario */
  const nav = useCallback((path: string, opts?: { replace?: boolean }) => {
    navigate(to(path), opts);
  }, [navigate, to]);

  return { nav, base, to };
}
