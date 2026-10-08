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

/** Contrato de login/verify; permisos de clínica, aún intersectados con el rol. */
export interface SubscriptionLifecycle {
  state: 'ACTIVE' | 'GRACE' | 'RECOVERY' | 'CLOSED';
  policy: 'paid' | 'demo' | 'legacy' | 'invalid';
  policyVersion: string | null;
  policy_accepted: boolean;
  enrollment_status: 'ENROLLED' | 'SCHEDULED' | 'EXCLUDED' | 'REQUIRES_CONTRACT_REVIEW';
  opt_in: boolean;
  effective_at: string | null;
  expires_at: string | null;
  grace_ends_at: string | null;
  recovery_ends_at: string | null;
  purge_after: string | null;
  remainingdays: number | null;
  auto_purge_eligible: boolean;
  canoperate: boolean;
  canexport: boolean;
  canlogin: boolean;
  can_auto_backup: boolean;
  canimport: boolean;
  canrestore: boolean;
  can_manual_snapshot: boolean;
}

/** Usuario autenticado (payload del token) */
export interface AuthUser {
  id?: number;
  username: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  role: UserRole;
  clinic_id: string | null;   // UUID string
  clinic_name?: string;
  clinic_slug?: string;
  access_scope: AccessScope;
  finance_scope?: string;
  inventory_scope?: string;
  calendar_scope?: 'own';
  phone?: string | null;
  gentilicio?: string | null;
  profession?: string | null;
  cedula_profesional?: string | null;
  matricula_senescyt?: string | null;
  registro_acess?: string | null;
  especialidad?: string | null;
  is_demo?: boolean;
  demo_expires_at?: string | null;
  must_change_password?: boolean;
  subscriptionWarningDays?: number | null;
  subscription_lifecycle?: SubscriptionLifecycle | null;
  delivery_only?: boolean;
}

/** Respuesta genérica de éxito/error de la API */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface AnnualPhotoBackupPart {
  index: number;
  size?: number;
  sha256?: string;
  status?: string;
}

export interface AnnualPhotoBackupRequest {
  id: string;
  clinic_id: string;
  clinic_name?: string;
  status: 'PENDING' | 'PAYMENT_PENDING' | 'NEEDS_QUOTE' | 'APPROVED' | 'PROCESSING' | 'READY' | 'EXPIRED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
  entitlement_kind?: 'FREE' | 'PAID';
  payment_status?: 'NOT_REQUIRED' | 'NEEDS_QUOTE' | 'PAYMENT_PENDING' | 'PAID';
  needs_quote?: boolean;
  original_total_bytes?: number | null;
  quote_total_cents?: number | null;
  quote_accepted_at?: string | null;
  paid_at?: string | null;
  entitlement_deadline_at?: string | null;
  created_at: string;
  expires_at?: string | null;
  photo_count?: number;
  total_bytes?: number;
  error_code?: string | null;
  notification_error?: string | null;
  parts?: AnnualPhotoBackupPart[];
}

export interface AnnualPhotoBackupStatus {
  configured: boolean;
  processor_ready?: boolean;
  can_request?: boolean;
  additional_requires_payment?: boolean;
  eligible: boolean;
  reason: string | null;
  period: { id: string; start_date: string; end_date: string; request_deadline_at?: string | null } | null;
  period_suggestion?: {
    starts_at: string;
    ends_at: string;
    source: string;
    duration_days: number;
    requires_master_confirmation: boolean;
  } | null;
  requests: AnnualPhotoBackupRequest[];
}

export interface AnnualPhotoBackupQuote {
  requestId: string;
  quote_complete: boolean;
  original_total_bytes?: number;
  bytes_measured?: number;
  quote_total_cents?: number | null;
  currency?: 'USD';
  iva_included?: boolean;
  gb_unit_bytes?: number;
  needs_prior_quote?: boolean;
}

export interface AnnualPhotoBackupNotification {
  request_id: string;
  kind: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attempts: number;
  last_error?: string | null;
}

export interface AnnualPhotoBackupProviderStatus {
  configured: boolean;
  processor_ready?: boolean;
  reason?: string | null;
  requests: AnnualPhotoBackupRequest[];
  pending_count?: number;
  notifications?: AnnualPhotoBackupNotification[];
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
  subscription_expires_at?: string | null;
  subscription_days?: number;
  subscription_lifecycle?: SubscriptionLifecycle | null;
  purge_state?: string | null;
  purge_completed_at?: string | null;
}

/** Usuario de una clínica */
export interface ClinicUser {
  id: number;
  username: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  gentilicio?: string;
  profession?: string;
  cedula_profesional?: string;
  especialidad?: string;
  email: string;
  phone?: string | null;
  role: UserRole;
  access_scope: AccessScope;
  finance_scope?: AccessScope;
  inventory_scope?: AccessScope;
  calendar_scope?: 'own';
  is_active: boolean;
  last_login: string | null;
  clinic_id: number | null;
  clinic_name: string;
  clinic_slug?: string;
  is_demo?: boolean;
  demo_expires_at?: string | null;
  whatsapp_bot_enabled?: boolean;
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

/** Ayudante del usuario: ocupa horarios en paralelo dentro del mismo calendario */
export interface StaffResource {
  id: number;
  name: string;
  color: string;
  work_hours: { start_hour?: string; end_hour?: string };
  active: boolean;
}

/** Recurso seleccionable al agendar: el titular o uno de sus ayudantes */
export interface AgendaResourceOption {
  id: string;
  name: string;
  color: string;
  work_hours: { start_hour?: string; end_hour?: string };
}

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
  identification_type?: 'cedula' | 'ruc' | null;
  identification_number?: string;
  email?: string;
  phone?: string;
  birth_date?: string;
  gender?: string;
  address?: string;
  occupation?: string;
  tipo_sangre?: string;
  estado_civil?: string;
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
  created_by_full_name?: string;
  created_by_gentilicio?: string;
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
