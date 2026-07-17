/**
 * @file src/hooks/useAdminNav.ts
 * @description Hook de navegación con prefijo de clínica/usuario.
 *
 * Genera URLs con el patrón: /admin/{clinicSlug}/{username}/{módulo}/{tab}
 * Para master_admin usa el prefijo /admin/master (sin slug/usuario).
 *
 * USO:
 *   const { nav, base, to } = useAdminNav();
 *   nav('clinical-records');              // navega a base + /clinical-records
 *   nav('ficha-clinica/paciente/123');    // navega a base + /ficha-clinica/paciente/123
 *   to('appointment');                    // retorna la URL (sin navegar)
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function useAdminNav() {
  const navigate = useNavigate();
  const { user }  = useAuth();

  /** Base path para el usuario autenticado */
  const base = (() => {
    if (!user) return '/admin';
    if (user.role === 'master_admin') return '/admin/master';
    const slug = user.clinic_slug || 'clinic';
    return `/admin/${slug}/${user.username}`;
  })();

  /** Construye la URL completa para un módulo */
  const to = useCallback((path: string) => {
    if (!path) return base;
    // Rutas que siempre son absolutas (login, consent-signing, etc.)
    if (path.startsWith('/')) return path;
    return `${base}/${path}`;
  }, [base]);

  /** Navega a un módulo relativo al base del usuario */
  const nav = useCallback((path: string, opts?: { replace?: boolean }) => {
    navigate(to(path), opts);
  }, [navigate, to]);

  return { nav, base, to };
}
