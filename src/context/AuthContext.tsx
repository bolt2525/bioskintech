/**
 * @file src/context/AuthContext.tsx
 * @description Contexto de autenticación multi-tenant para BIOSKIN Admin.
 *
 * Flujo:
 *  1. Al montar <AuthProvider>, se llama `checkAuth()` que valida el token
 *     almacenado en localStorage contra el endpoint `/api/admin-auth?action=verify`.
 *  2. `login()` persiste el token + usuario en localStorage.
 *  3. `logout()` limpia el storage y revoca el token en el servidor.
 *  4. `hasFeature(f)` devuelve true si el master_admin o si la clínica tiene `f` habilitado.
 *
 * Roles:
 *  - master_admin → acceso total, sin clinic_id
 *  - clinic_admin → acceso total a su clínica
 *  - clinic_user  → acceso limitado (access_scope: 'own')
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import type { AuthUser } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del contexto
// ─────────────────────────────────────────────────────────────────────────────

interface AuthContextType {
  isAuthenticated: boolean;
  /** username del usuario actual, o null si no hay sesión */
  username: string | null;
  user: AuthUser | null;
  /** Lista de feature-keys habilitadas para la clínica del usuario */
  features: string[];
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string; user?: import('../types').AuthUser }>;
  logout: () => void;
  checkAuth: () => Promise<boolean>;
  /** Devuelve true si el usuario tiene acceso a la feature dada */
  hasFeature: (feature: string) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claves de localStorage
// ─────────────────────────────────────────────────────────────────────────────

const LS_TOKEN  = 'adminSessionToken';
const LS_USER   = 'adminUser';
const LS_EXPIRY = 'adminSessionExpiry';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de persistencia
// ─────────────────────────────────────────────────────────────────────────────

function persistAuth(token: string, user: AuthUser, expiry: string, features: string[]): void {
  localStorage.setItem(LS_TOKEN,  token);
  localStorage.setItem(LS_USER,   JSON.stringify({ ...user, features }));
  localStorage.setItem(LS_EXPIRY, expiry);
}

function clearAuth(): void {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
  localStorage.removeItem(LS_EXPIRY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Creación del contexto
// ─────────────────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser]                       = useState<AuthUser | null>(null);
  const [features, setFeatures]               = useState<string[]>([]);

  /** Aplica datos de sesión al estado React */
  const applySession = (u: AuthUser, feat: string[]): void => {
    setIsAuthenticated(true);
    setUser(u);
    setFeatures(feat);
  };

  /** Limpia el estado React de sesión */
  const resetSession = (): void => {
    setIsAuthenticated(false);
    setUser(null);
    setFeatures([]);
  };

  /**
   * Verifica si el token almacenado sigue siendo válido en el servidor.
   * Se llama automáticamente en el montaje del provider y desde páginas protegidas.
   */
  const checkAuth = useCallback(async (): Promise<boolean> => {
    try {
      const token = localStorage.getItem(LS_TOKEN);
      if (!token) { resetSession(); return false; }

      const res  = await fetch('/api/admin-auth?action=verify', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();

      if (data.success && data.valid && data.user) {
        applySession(data.user, data.features || []);
        return true;
      }
      clearAuth();
      resetSession();
      return false;
    } catch {
      resetSession();
      return false;
    }
  }, []);

  /**
   * Realiza el login contra `/api/admin-auth?action=login`.
   * Persiste la sesión en localStorage si es exitoso.
   */
  const login = async (
    username: string,
    password: string,
  ): Promise<{ ok: boolean; error?: string; user?: AuthUser }> => {
    try {
      const res  = await fetch('/api/admin-auth?action=login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (data.success && data.user) {
        persistAuth(data.sessionToken, data.user, data.expiresAt, data.features || []);
        applySession(data.user, data.features || []);
        return { ok: true, user: data.user };
      }
      return { ok: false, error: data.error || 'Credenciales inválidas' };
    } catch {
      return { ok: false, error: 'Error de conexión' };
    }
  };

  /** Revoca el token en el servidor y limpia la sesión local */
  const logout = (): void => {
    const token = localStorage.getItem(LS_TOKEN);
    if (token) {
      // Fire-and-forget: no bloquea la UI
      fetch('/api/admin-auth?action=logout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ sessionToken: token }),
      }).catch(() => {});
    }
    clearAuth();
    resetSession();
  };

  /**
   * El master_admin siempre tiene acceso a todo.
   * El resto solo si la feature está habilitada para su clínica.
   */
  const hasFeature = (feature: string): boolean =>
    user?.role === 'master_admin' || features.includes(feature);

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      username: user?.username ?? null,
      user,
      features,
      login,
      logout,
      checkAuth,
      hasFeature,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook de consumo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook para consumir el contexto de autenticación.
 * Lanza un error si se usa fuera de <AuthProvider>.
 */
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}

// Re-exportar el tipo para que los componentes puedan importarlo desde aquí
export type { AuthUser };
