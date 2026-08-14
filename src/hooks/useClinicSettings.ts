/**
 * @file src/hooks/useClinicSettings.ts
 * @description Hook reutilizable para cargar la configuración de la clínica actual.
 * Usado en PrescriptionTab, ConsentimientosTab y cualquier módulo que necesite
 * datos propios de la clínica (nombre, logo, teléfono, dirección, firma).
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export interface ClinicGeneralSettings {
  name:               string;
  city:               string;
  tagline:            string;
  establishment_type: string;
  logo_url:           string;
  phone:              string;
  address:            string;
  tax_id:             string;
}

export interface ClinicEmailSettings {
  staff_email:      string;
  from_name:        string;
  signature:        string;
  whatsapp_number:  string;
  staff_members?:   Array<{ name: string; email: string; clinic_user_id?: number }>;
}

export interface ClinicAgendaSettings {
  start_hour:        string;
  end_hour:          string;
  slot_minutes:      number;
  calendar_prefix:   string;
}

export interface ClinicSettings {
  general:    ClinicGeneralSettings;
  treatments: string[];
  email:      ClinicEmailSettings;
  agenda:     ClinicAgendaSettings;
}

const DEFAULTS: ClinicSettings = {
  general:    { name: '', city: '', tagline: '', establishment_type: '', logo_url: '', phone: '', address: '', tax_id: '' },
  treatments: [],
  email:      { staff_email: '', from_name: '', signature: '', whatsapp_number: '' },
  agenda:     { start_hour: '08:00', end_hour: '19:00', slot_minutes: 60, calendar_prefix: '' },
};

/**
 * Carga los settings de la clínica del usuario autenticado.
 * Devuelve defaults inmediatamente mientras carga, nunca null.
 */
export function useClinicSettings(): { settings: ClinicSettings; loading: boolean } {
  const { user } = useAuth();
  // Usar clinic_name del token como nombre inicial antes de que la API responda
  const [settings, setSettings] = useState<ClinicSettings>(() => ({
    ...DEFAULTS,
    general: { ...DEFAULTS.general, name: user?.clinic_name || '' },
  }));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const clinicId = user?.clinic_id;
    if (!clinicId) return;               // master_admin sin clinicId usa defaults
    setLoading(true);
    fetch(`/api/admin-auth?action=getClinicSettings&clinicId=${clinicId}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` },
    })
      .then(r => r.json())
      .then(d => {
        if (d.settings) {
          setSettings(prev => ({
            ...DEFAULTS,
            ...d.settings,
            general: {
              ...DEFAULTS.general,
              name: user?.clinic_name || '',  // fallback al nombre del auth token
              ...d.settings.general,
            },
          }));
        }
      })
      .catch(() => {/* silencioso — usa nombre del auth token */})
      .finally(() => setLoading(false));
  }, [user?.clinic_id, user?.clinic_name]);

  return { settings, loading };
}
