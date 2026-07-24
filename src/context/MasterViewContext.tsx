/**
 * @file src/context/MasterViewContext.tsx
 * @description Contexto para cuando el master_admin está navegando
 * en el contexto de una clínica/usuario específico.
 *
 * Patrón de URL: /admin/master/:clinicSlug/:username/:module
 *
 * Cuando está activo:
 *  - Las llamadas API incluyen el header X-Target-Clinic-Id
 *  - hasFeature() usa los features de la clínica destino
 *  - useAdminNav() genera URLs bajo /admin/master/:clinicSlug/:username
 *  - Se muestra un banner "Viendo como: clínica / usuario"
 */

import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { setMasterTargetClinicId } from '../utils/recordsFetch';

interface MasterViewState {
  isActive: boolean;
  clinicId: number | null;
  clinicSlug: string | null;
  clinicName: string | null;
  targetUsername: string | null;
  targetUserId: number | null;
  features: string[];
}

interface MasterViewContextType extends MasterViewState {
  enterClinicView: (clinicId: number, clinicSlug: string, clinicName: string, username: string, userId: number, features: string[]) => void;
  exitClinicView: () => void;
  hasFeatureInContext: (feature: string) => boolean;
  baseUrl: string;
}

const EMPTY: MasterViewState = {
  isActive: false,
  clinicId: null,
  clinicSlug: null,
  clinicName: null,
  targetUsername: null,
  targetUserId: null,
  features: [],
};

const MasterViewContext = createContext<MasterViewContextType | undefined>(undefined);

export function MasterViewProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MasterViewState>(EMPTY);

  const enterClinicView = useCallback((
    clinicId: number,
    clinicSlug: string,
    clinicName: string,
    username: string,
    userId: number,
    features: string[],
  ) => {
    setState({ isActive: true, clinicId, clinicSlug, clinicName, targetUsername: username, targetUserId: userId, features });
    setMasterTargetClinicId(clinicId);
  }, []);

  const exitClinicView = useCallback(() => {
    setState(EMPTY);
    setMasterTargetClinicId(null);
  }, []);

  // Limpiar al desmontar
  useEffect(() => () => { setMasterTargetClinicId(null); }, []);

  const hasFeatureInContext = useCallback((feature: string) => {
    if (!state.isActive) return true; // master_admin has all features normally
    return state.features.includes(feature);
  }, [state]);

  const baseUrl = state.isActive
    ? `/admin/master/${state.clinicSlug}/${state.targetUsername}`
    : '/admin/master';

  return (
    <MasterViewContext.Provider value={{ ...state, enterClinicView, exitClinicView, hasFeatureInContext, baseUrl }}>
      {children}
    </MasterViewContext.Provider>
  );
}

export function useMasterView() {
  const ctx = useContext(MasterViewContext);
  if (!ctx) throw new Error('useMasterView must be used inside <MasterViewProvider>');
  return ctx;
}
