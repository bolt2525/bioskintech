/**
 * @file src/App.tsx
 * @description Enrutador principal BIOSKIN.
 *
 * Estructura de URLs:
 *   bioskintechapp.com/                    → Landing page global
 *   bioskintechapp.com/gestionestetica/**  → Panel admin (SPA con basename)
 *   bioskintechapp.com/admin/**            → Redirige a /gestionestetica/admin/** (legacy)
 *   bioskintechapp.com/consent-signing/**  → Firma de consentimientos (público)
 *   bioskintechapp.com/medical-finance     → Gestión médica externa
 *
 * Truco: se usa `basename="/gestionestetica"` en BrowserRouter para que todos los
 * navigate('/admin/...') internos del panel funcionen sin cambio alguno.
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { MasterViewProvider } from './context/MasterViewContext';
import ErrorBoundary from './pages/ErrorBoundary';
import SubscriptionGate from './components/layout/SubscriptionGate';

const LandingPage = lazy(() => import('./pages/LandingPage'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const AdminLogin = lazy(() => import('./pages/AdminLogin'));
const AdminMasterLogin = lazy(() => import('./pages/AdminMasterLogin'));
const AdminRegister = lazy(() => import('./pages/AdminRegister'));
const InviteRegister = lazy(() => import('./pages/InviteRegister'));
const AdminSetupPassword = lazy(() => import('./pages/AdminSetupPassword'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AdminMasterDashboard = lazy(() => import('./pages/AdminMasterDashboard'));
const AdminCalendarManager = lazy(() => import('./pages/AdminCalendarManager'));
const AdminBlockSchedule = lazy(() => import('./pages/AdminBlockSchedule'));
const AdminAppointment = lazy(() => import('./pages/AdminAppointment'));
const PatientList = lazy(() => import('./components/admin/ficha-clinica/components/PatientList'));
const NewPatientForm = lazy(() => import('./components/admin/ficha-clinica/components/NewPatientForm'));
const PatientDetail = lazy(() => import('./components/admin/ficha-clinica/components/PatientDetail'));
const ClinicalRecordManager = lazy(() => import('./components/admin/ficha-clinica/components/ClinicalRecordManager'));
const ConsentSigning = lazy(() => import('./pages/ConsentSigning'));
const AIConsultationModule = lazy(() => import('./pages/AIConsultationModule'));
const AdminSystemStatus = lazy(() => import('./pages/AdminSystemStatus'));
const AdminBackup = lazy(() => import('./pages/AdminBackup'));
const AdminAgendaHub = lazy(() => import('./pages/AdminAgendaHub'));
const AdminWhatsAppCRM = lazy(() => import('./pages/AdminWhatsAppCRM'));
const MasterClinicWrapper = lazy(() => import('./pages/MasterClinicWrapper'));
const PublicBookingPage = lazy(() => import('./pages/PublicBookingPage'));
const AdminInventory = lazy(() => import('./pages/AdminInventory'));
const AdminFinance = lazy(() => import('./pages/AdminFinance'));
const Clinical3D = lazy(() => import('./pages/Clinical3D'));
const ExternalMedicalFinance = lazy(() => import('./pages/ExternalMedicalFinance'));
const SkinExplorerPage = lazy(() => import('./skin-explorer/SkinExplorerPage'));

const routeFallback = (
  <div className="flex min-h-screen items-center justify-center bg-[#f4f7f6] text-sm font-medium text-slate-600" role="status">
    Cargando módulo...
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Rutas reutilizadas dentro del panel admin
// ─────────────────────────────────────────────────────────────────────────────

function AdminRoutes() {
  return (
    <AuthProvider>
      <MasterViewProvider>
        <SubscriptionGate>
        <Suspense fallback={routeFallback}>
        <Routes>
          <Route path="/" element={<Navigate to="/admin/login" replace />} />

          <Route path="/admin/login"           element={<AdminLogin />} />
          {/* Ruta de acceso master — no enlazada desde el panel público */}
          <Route path="/admin/sys"             element={<AdminMasterLogin />} />
          {/* Ruta pública — accesible desde la página de login, sin auth requerida */}
          <Route path="/skin-explorer"          element={<SkinExplorerPage />} />
          <Route path="/admin/register"         element={<AdminRegister />} />
          <Route path="/admin/invite"           element={<InviteRegister />} />
          <Route path="/admin/setup-password"   element={<AdminSetupPassword />} />
          <Route path="/admin/recover"          element={<AdminSetupPassword />} />
          <Route path="/admin/master"   element={<AdminMasterDashboard />} />
          <Route path="/admin/master/whatsapp" element={<AdminWhatsAppCRM />} />

          <Route path="/admin/master/:clinicSlug/:username" element={<MasterClinicWrapper />}>
            <Route index element={<AdminDashboard />} />
            <Route path="calendar"       element={<AdminCalendarManager />} />
            <Route path="block-schedule" element={<AdminBlockSchedule />} />
            <Route path="appointment"    element={<AdminAppointment />} />
            <Route path="agenda"         element={<AdminAgendaHub />} />
            <Route path="clinical-records"                    element={<PatientList />} />
            <Route path="clinical-records/new"                element={<NewPatientForm />} />
            <Route path="clinical-records/edit/:patientId"    element={<NewPatientForm />} />
            <Route path="ficha-clinica/paciente/:patientId"   element={<PatientDetail />} />
            <Route path="ficha-clinica/expediente/:recordId"  element={<ClinicalRecordManager />} />
            <Route path="ai-consultation" element={<AIConsultationModule />} />
            <Route path="inventory"   element={<AdminInventory />} />
            <Route path="finance"     element={<AdminFinance />} />
            <Route path="clinical-3d" element={<Clinical3D />} />
            <Route path="system-status" element={<AdminSystemStatus />} />
            <Route path="backup"        element={<AdminBackup />} />
            <Route path="skin-explorer" element={<SkinExplorerPage />} />
          </Route>

          {/* Rutas con slug de clínica */}
          <Route path="/admin/:clinicSlug/:username"                                          element={<AdminDashboard />} />
          <Route path="/admin/:clinicSlug/:username/calendar"                                 element={<AdminCalendarManager />} />
          <Route path="/admin/:clinicSlug/:username/block-schedule"                           element={<AdminBlockSchedule />} />
          <Route path="/admin/:clinicSlug/:username/appointment"                              element={<AdminAppointment />} />
          <Route path="/admin/:clinicSlug/:username/agenda"                                   element={<AdminAgendaHub />} />
          <Route path="/admin/:clinicSlug/:username/clinical-records"                         element={<PatientList />} />
          <Route path="/admin/:clinicSlug/:username/clinical-records/new"                     element={<NewPatientForm />} />
          <Route path="/admin/:clinicSlug/:username/clinical-records/edit/:patientId"         element={<NewPatientForm />} />
          <Route path="/admin/:clinicSlug/:username/ficha-clinica/paciente/:patientId"        element={<PatientDetail />} />
          <Route path="/admin/:clinicSlug/:username/ficha-clinica/expediente/:recordId"       element={<ClinicalRecordManager />} />
          <Route path="/admin/:clinicSlug/:username/ai-consultation"                          element={<AIConsultationModule />} />
          <Route path="/admin/:clinicSlug/:username/inventory"                                element={<AdminInventory />} />
          <Route path="/admin/:clinicSlug/:username/finance"                                  element={<AdminFinance />} />
          <Route path="/admin/:clinicSlug/:username/clinical-3d"                              element={<Clinical3D />} />
          <Route path="/admin/:clinicSlug/:username/system-status"                            element={<AdminSystemStatus />} />
          <Route path="/admin/:clinicSlug/:username/backup"                                   element={<AdminBackup />} />
          <Route path="/admin/:clinicSlug/:username/skin-explorer"                            element={<SkinExplorerPage />} />

          {/* Alias legacy /admin (sin slug) */}
          <Route path="/admin"                element={<AdminDashboard />} />
          <Route path="/admin/calendar"       element={<AdminCalendarManager />} />
          <Route path="/admin/block-schedule" element={<AdminBlockSchedule />} />
          <Route path="/admin/appointment"    element={<AdminAppointment />} />
          <Route path="/admin/agenda"         element={<AdminAgendaHub />} />
          <Route path="/admin/clinical-records"                    element={<PatientList />} />
          <Route path="/admin/clinical-records/new"                element={<NewPatientForm />} />
          <Route path="/admin/clinical-records/edit/:patientId"    element={<NewPatientForm />} />
          <Route path="/admin/ficha-clinica/paciente/:patientId"   element={<PatientDetail />} />
          <Route path="/admin/ficha-clinica/expediente/:recordId"  element={<ClinicalRecordManager />} />
          <Route path="/admin/ai-consultation" element={<AIConsultationModule />} />
          <Route path="/admin/inventory"   element={<AdminInventory />} />
          <Route path="/admin/finance"     element={<AdminFinance />} />
          <Route path="/admin/clinical-3d" element={<Clinical3D />} />
          <Route path="/admin/system-status" element={<AdminSystemStatus />} />
          <Route path="/admin/backup"        element={<AdminBackup />} />
          <Route path="/admin/skin-explorer" element={<SkinExplorerPage />} />

          <Route path="*" element={<Navigate to="/admin/login" replace />} />
        </Routes>
        </Suspense>
        </SubscriptionGate>
      </MasterViewProvider>
    </AuthProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App principal
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const path = window.location.pathname;

  // Legacy: redirigir /admin/* → /gestionestetica/admin/*
  if (path.startsWith('/admin')) {
    window.location.replace('/gestionestetica' + path + window.location.search);
    return null;
  }

  // Panel admin → BrowserRouter con basename /gestionestetica
  // Todos los navigate('/admin/...') internos funcionan sin cambio alguno
  if (path.startsWith('/gestionestetica')) {
    return (
      <ErrorBoundary>
        <BrowserRouter basename="/gestionestetica">
          <AdminRoutes />
        </BrowserRouter>
      </ErrorBoundary>
    );
  }

  // Landing page, consent-signing, medical-finance → sin basename
  return (
    <BrowserRouter>
      <Suspense fallback={routeFallback}>
      <Routes>
        <Route path="/"                        element={<LandingPage />} />
        <Route path="/reservar/:clinicSlug/:username" element={<PublicBookingPage />} />
        <Route path="/reservar/:clinicSlug" element={<PublicBookingPage />} />
        <Route path="/consent-signing/:token"   element={<ConsentSigning />} />
        <Route path="/politica-de-privacidad"   element={<PrivacyPolicy />} />
        <Route path="/condiciones-de-servicio"   element={<TermsOfService />} />
        <Route path="/medical-finance"          element={<ExternalMedicalFinance />} />
        <Route path="*"                         element={<LandingPage />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
