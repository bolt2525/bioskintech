/**
 * @file src/constants/theme.ts
 * @description Design tokens centralizados para BIOSKIN Admin.
 *
 * ¿Por qué este archivo?
 * Los colores, etiquetas y estilos de roles estaban hardcodeados en 15+ archivos.
 * Centralizar aquí permite cambiar el tema en un solo lugar.
 *
 * USO:
 *   import { COLORS, ROLE_LABELS, ROLE_COLORS } from '@constants/theme';
 *   className={ROLE_COLORS[user.role]}
 */

// ─────────────────────────────────────────────────────────────────────────────
// Paleta de colores principales
// ─────────────────────────────────────────────────────────────────────────────

/** Tokens de color del sistema — corresponden a la configuración de Tailwind */
export const COLORS = {
  /** Color dorado BIOSKIN — también definido en tailwind.config.js como `gold` */
  gold:       '#deb887',
  goldDark:   '#d4a574',
  goldLight:  '#f5e6d3',

  // Estados
  success: 'text-emerald-600',
  error:   'text-red-500',
  warning: 'text-amber-500',
  info:    'text-indigo-600',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Roles de usuario
// ─────────────────────────────────────────────────────────────────────────────

/** Etiquetas legibles en español para cada rol */
export const ROLE_LABELS: Record<string, string> = {
  master_admin: 'Master Admin',
  clinic_admin:  'Admin Clínica',
  clinic_user:   'Usuario',
} as const;

/**
 * Clases Tailwind para badges de rol.
 * Se usan en tablas de usuarios y encabezados de perfil.
 */
export const ROLE_COLORS: Record<string, string> = {
  master_admin: 'bg-amber-100 text-amber-800',
  clinic_admin:  'bg-purple-100 text-purple-800',
  clinic_user:   'bg-green-100 text-green-700',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Animaciones reutilizables (Tailwind class strings)
// ─────────────────────────────────────────────────────────────────────────────

/** Clases de transición estándar para botones y tarjetas */
export const TRANSITIONS = {
  button:  'transition-colors duration-200',
  card:    'transition-all duration-200 hover:shadow-md',
  opacity: 'transition-opacity duration-300',
} as const;
