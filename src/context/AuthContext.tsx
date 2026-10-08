/**
 * @file src/context/AuthContext.tsx
 * @description Contexto de autenticación multi-tenant para BIOSKIN Admin.
 *
 * ALMACENAMIENTO: sessionStorage (tab-aislado).
 * Cada pestaña del navegador mantiene su propia sesión.
 * Los datos persisten al refrescar pero NO se comparten entre pestañas,
 * lo que evita colisiones cuando dos usuarios abren el panel en la misma ventana.
 *
 * Flujo:
 *  1. Al montar <AuthProvider>, se llama `checkAuth()` que valida el token
 *     almacenado en sessionStorage contra `/api/admin-auth?action=verify`.
 *  2. `login()` persiste el token + usuario en sessionStorage.
 *  3. `logout()` limpia el storage y revoca el token en el servidor.
 *  4. `hasFeature(f)` devuelve true si el master_admin o si la clínica tiene `f` habilitado.
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import type { AuthUser } from '../types';
import { sessionUser, subscriptionAccess } from '../utils/subscriptionAccess';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del contexto
// ─────────────────────────────────────────────────────────────────────────────

interface AuthContextType {
  isAuthenticated: boolean;
  isAuthVerified: boolean;
  username: string | null;
  user: AuthUser | null;
  features: string[];
  /** Overrides de módulos por usuario: [{feature, enabled}]. enabled:false = módulo oculto para este usuario */
  userModuleOverrides: Array<{ feature: string; enabled: boolean }>;
  login: (username: string, password: string, turnstileToken: string) => Promise<{ ok: boolean; error?: string; user?: import('../types').AuthUser; requiresOTP?: boolean; otpToken?: string; maskedEmail?: string }>;
  logout: () => void;
  checkAuth: () => Promise<boolean>;
  hasFeature: (feature: string) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claves de sessionStorage (tab-aislado — evita colisión entre pestañas)
// ───────────────────────────────────────────────────────────────────────────────

const SS_TOKEN  = 'adminSessionToken';
const SS_USER   = 'adminUser';
const SS_EXPIRY = 'adminSessionExpiry';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de persistencia
// ─────────────────────────────────────────────────────────────────────────────

function persistAuth(token: string, user: AuthUser, expiry: string, features: string[]): void {
  sessionStorage.setItem(SS_TOKEN,  token);
  sessionStorage.setItem(SS_USER,   JSON.stringify({ ...user, features }));
  sessionStorage.setItem(SS_EXPIRY, expiry);
}

function clearAuth(): void {
  sessionStorage.removeItem(SS_TOKEN);
  sessionStorage.removeItem(SS_USER);
  sessionStorage.removeItem(SS_EXPIRY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Creación del contexto
// ─────────────────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hidratar solo datos de presentación: ningún módulo se monta antes de verify.
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthVerified, setIsAuthVerified] = useState(false);
  const verification = useRef<{ token: string | null; promise: Promise<boolean> } | null>(null);
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const stored = sessionStorage.getItem(SS_USER);
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      // features van dentro del objeto SS_USER (ver persistAuth)
      const userWithoutFeatures = { ...parsed };
      delete userWithoutFeatures.features;
      return userWithoutFeatures as AuthUser;
    } catch { return null; }
  });
  const [features, setFeatures] = useState<string[]>(() => {
    try {
      const stored = sessionStorage.getItem(SS_USER);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed.features) ? parsed.features : [];
    } catch { return []; }
  });
  const [userModuleOverrides, setUserModuleOverrides] = useState<Array<{ feature: string; enabled: boolean }>>([]);

  const applySession = (u: AuthUser, feat: string[], overrides: Array<{ feature: string; enabled: boolean }> = []): void => {
    setIsAuthVerified(true);
    setIsAuthenticated(true);
    setUser(u);
    setFeatures(feat);
    setUserModuleOverrides(overrides);
  };

  const resetSession = (): void => {
    setIsAuthVerified(true);
    setIsAuthenticated(false);
    setUser(null);
    setFeatures([]);
    setUserModuleOverrides([]);
  };

  /**
   * Verifica si el token almacenado sigue siendo válido en el servidor.
   * Se llama automáticamente en el montaje del provider y desde páginas protegidas.
   */
  const checkAuth = useCallback((): Promise<boolean> => {
    const token = sessionStorage.getItem(SS_TOKEN);
    if (verification.current?.token === token) return verification.current.promise;
    const request = (async () => {
      try {
        if (!token) { resetSession(); return false; }

        const res = await fetch('/api/admin-auth?action=verify', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        // Un verify tardío no puede resucitar una sesión cerrada o reemplazada.
        if (sessionStorage.getItem(SS_TOKEN) !== token) return false;

        if (res.ok && data.success && data.valid && data.user) {
          const freshUser = sessionUser(data);
          persistAuth(token, freshUser, data.expiresAt || sessionStorage.getItem(SS_EXPIRY) || '', data.features || []);
          applySession(freshUser, data.features || [], data.user_module_overrides || []);
          return true;
        }
        clearAuth();
        resetSession();
        return false;
      } catch {
        if (sessionStorage.getItem(SS_TOKEN) === token) resetSession();
        return false;
      }
    })();
    verification.current = { token, promise: request };
    void request.finally(() => { if (verification.current?.promise === request) verification.current = null; });
    return request;
  }, []);

  useEffect(() => {
    void checkAuth();
    const refresh = () => { if (sessionStorage.getItem(SS_TOKEN)) void checkAuth(); };
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, [checkAuth]);

  /**
   * Realiza el login contra `/api/admin-auth?action=login`.
   * Persiste la sesión verificada en sessionStorage si es exitoso.
   */
  const login = async (
    username: string,
    password: string,
    turnstileToken: string,
  ): Promise<{ ok: boolean; error?: string; user?: AuthUser; requiresOTP?: boolean; otpToken?: string; maskedEmail?: string }> => {
    try {
      const res  = await fetch('/api/admin-auth?action=login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password, turnstileToken, device_token: localStorage.getItem('bioskin_device_token') || '' }),
      });
      const data = await res.json();

      if (data.success && data.user) {
        const freshUser = sessionUser(data);
        persistAuth(data.sessionToken, freshUser, data.expiresAt, data.features || []);
        applySession(freshUser, data.features || [], data.user_module_overrides || []);
        return { ok: true, user: freshUser };
      }
      // 2FA required — return structured data for the caller to handle OTP modal
      if (data.requiresOTP) {
        return { ok: false, requiresOTP: true, otpToken: data.otpToken, maskedEmail: data.maskedEmail };
      }
      return { ok: false, error: data.error || 'Credenciales inválidas' };
    } catch {
      return { ok: false, error: 'Error de conexión' };
    }
  };

  /** Revoca el token en el servidor y limpia la sesión local */
  const logout = (): void => {
    const token = sessionStorage.getItem(SS_TOKEN);
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
   * Luego se comprueba si la feature está habilitada a nivel clínica.
   * Finalmente se aplica el override a nivel usuario (si existe).
   */
  const hasFeature = (feature: string): boolean => {
    if (!isAuthVerified) return false;
    const access = subscriptionAccess(user);
    if (!access.canOperate) return feature === 'backup' && access.canAccessBackup;
    if (user?.role === 'master_admin') return true;
    if (!features.includes(feature)) return false; // deshabilitado en clínica
    const override = userModuleOverrides.find(o => o.feature === feature);
    return override?.enabled === false ? false : true; // override de usuario
  };

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      isAuthVerified,
      username: user?.username ?? null,
      user,
      features,
      userModuleOverrides,
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
