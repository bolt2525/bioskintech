/**
 * @file src/types/index.ts
 * @description Interfaces TypeScript centralizadas del sistema BIOSKIN Admin.
 *
 * Toda interfaz que se usa en más de un archivo debe definirse aquí.
 * Los componentes que necesiten tipos locales pueden declararlos dentro del propio archivo.
 *
 * Organización:
 *  - Auth / Roles
 *  - Clínicas (multi-tenant)
 *  - Pacientes / Fichas Clínicas
 *  - Agenda / Citas
 *  - Inventario
 *  - Finanzas
 *  - Servicio Técnico
 *  - UI compartida
 */

// ─────────────────────────────────────────────────────────────────────────────
// Auth / Roles
// ─────────────────────────────────────────────────────────────────────────────

/** Roles disponibles en el sistema multi-tenant */
export type UserRole = 'master_admin' | 'clinic_admin' | 'clinic_user';

/** Alcance de acceso a registros */
export type AccessScope = 'all' | 'own';

/** Usuario autenticado (payload del token) */
export interface AuthUser {
  id?: number;
  username: string;
  full_name?: string;
  role: UserRole;
  clinic_id: number | null;
  access_scope: AccessScope;
}

/** Respuesta genérica de éxito/error de la API */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Clínicas (multi-tenant)
// ─────────────────────────────────────────────────────────────────────────────

/** Clínica registrada en el sistema */
export interface Clinic {
  id: number;
  name: string;
  slug: string;
  email: string;
  phone: string;
  address: string;
  is_active: boolean;
  user_count: number;
  patient_count: number;
}

/** Usuario de una clínica */
export interface ClinicUser {
  id: number;
  username: string;
  full_name: string;
  email: string;
  role: UserRole;
  access_scope: AccessScope;
  is_active: boolean;
  last_login: string;
  clinic_id: number | null;
  clinic_name: string;
}

/** Feature habilitada/deshabilitada para una clínica */
export interface FeatureRow {
  clinic_id: number;
  feature: string;
  enabled: boolean;
  clinic_name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agenda / Citas
// ─────────────────────────────────────────────────────────────────────────────

/** Cita próxima (para notificaciones del dashboard) */
export interface UpcomingAppointment {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  daysUntil: number;
  isToday: boolean;
  isTomorrow: boolean;
}

/** Evento de Google Calendar */
export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pacientes / Fichas Clínicas
// ─────────────────────────────────────────────────────────────────────────────

/** Paciente registrado */
export interface Patient {
  id: number;
  first_name: string;
  last_name: string;
  rut?: string;
  email?: string;
  phone?: string;
  birth_date?: string;
  gender?: string;
  address?: string;
  occupation?: string;
  clinic_id?: number;
  created_at: string;
  updated_at: string;
}

/** Expediente/ficha clínica de un paciente */
export interface ClinicalRecord {
  id: number;
  patient_id: number;
  record_date: string;
  chief_complaint?: string;
  diagnosis?: string;
  treatment_plan?: string;
  notes?: string;
  created_by?: string;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventario
// ─────────────────────────────────────────────────────────────────────────────

/** Producto de inventario */
export interface InventoryProduct {
  id: number;
  name: string;
  sku?: string;
  category?: string;
  stock: number;
  unit?: string;
  min_stock?: number;
  expiry_date?: string;
  clinic_id?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finanzas
// ─────────────────────────────────────────────────────────────────────────────

/** Transacción financiera */
export interface FinanceTransaction {
  id: number;
  type: 'income' | 'expense';
  amount: number;
  description: string;
  category?: string;
  date: string;
  clinic_id?: number;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Servicio Técnico
// ─────────────────────────────────────────────────────────────────────────────

/** Documento/reporte de servicio técnico */
export interface TechnicalDocument {
  id: number;
  title: string;
  device_name?: string;
  issue_description?: string;
  solution?: string;
  status: 'pending' | 'in_progress' | 'completed';
  technician?: string;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Compartida
// ─────────────────────────────────────────────────────────────────────────────

/** Ítem de navegación tipo breadcrumb */
export interface Breadcrumb {
  label: string;
  path: string;
}

/** Estado de carga de peticiones async */
export type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';
