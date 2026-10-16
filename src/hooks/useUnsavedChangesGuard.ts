/**
 * @file src/hooks/useUnsavedChangesGuard.ts
 * @description Registro mínimo de "cambios sin guardar" para proteger la navegación
 * (menú flyout de módulos). No guarda nada: solo permite a un formulario declarar
 * que tiene datos pendientes para que la navegación pida confirmación.
 *
 * USO en un formulario:  useUnsavedChangesGuard(isDirty);
 */

import { useEffect, useId } from 'react';

const reporters = new Map<string, boolean>();

/** true si algún formulario montado reporta cambios pendientes */
export const hasUnsavedChanges = (): boolean => [...reporters.values()].some(Boolean);

/** true si al menos un formulario reporta su estado (sea limpio o sucio) */
export const hasUnsavedReporters = (): boolean => reporters.size > 0;

/** Solo para pruebas */
export const resetUnsavedChanges = (): void => reporters.clear();

export function useUnsavedChangesGuard(dirty: boolean): void {
  const id = useId();

  useEffect(() => {
    reporters.set(id, dirty);
    return () => { reporters.delete(id); };
  }, [id, dirty]);

  // Recarga/cierre de pestaña con datos pendientes
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
