/**
 * @file src/components/layout/moduleNav.ts
 * @description Lógica pura (sin React) del menú flyout de módulos.
 */

/** Rutas del módulo Fichas Clínicas (lista, alta/edición, perfil y expediente), con o sin prefijo de clínica. */
export const isClinicalRoute = (pathname: string): boolean =>
  /\/(clinical-records|ficha-clinica)(\/|$)/.test(pathname);

/** Pantallas donde puede haber datos en captura: expediente, alta y edición de paciente. */
export const isFichaInProgressRoute = (pathname: string): boolean =>
  /\/ficha-clinica\/expediente\//.test(pathname) || /\/clinical-records\/(new|edit)(\/|$)/.test(pathname);

/**
 * ¿Hay que pedir confirmación antes de salir?
 * - Si algún formulario reporta su estado, manda ese estado (limpio = sin aviso).
 * - Si nadie reporta (pestañas que aún no exponen su estado), se avisa de forma
 *   conservadora al salir de pantallas de captura.
 */
export function shouldConfirmLeave(pathname: string, dirty: boolean, hasReporters: boolean): boolean {
  if (hasReporters) return dirty;
  return isFichaInProgressRoute(pathname);
}

/** Ruta del módulo activo (las rutas de ficha pertenecen a Fichas Clínicas). */
export function isModuleActive(pathname: string, href: string, modulePath: string): boolean {
  if (modulePath === '/admin/clinical-records' && isClinicalRoute(pathname)) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Ítems navegables con flechas/Home/End (circular). */
export function nextFocusIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  if (key === 'ArrowDown') return (current + 1) % length;
  if (key === 'ArrowUp') return (current - 1 + length) % length;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}

export interface FlyoutState { open: boolean; pinned: boolean }

/**
 * Clic en el botón. Regresión QA: con mouse, el hover abre el menú y el clic posterior
 * lo cerraba (parpadeo). Si el menú está abierto por hover, el clic lo FIJA; un clic
 * sobre un menú fijado lo cierra.
 */
export function onTriggerClick({ open, pinned }: FlyoutState): FlyoutState {
  if (!open) return { open: true, pinned: true };
  if (!pinned) return { open: true, pinned: true };
  return { open: false, pinned: false };
}

/** Un menú abierto por hover se cierra al salir el puntero; uno fijado no. */
export const shouldCloseOnPointerLeave = ({ open, pinned }: FlyoutState): boolean => open && !pinned;
