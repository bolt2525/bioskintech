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

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { MasterViewProvider } from './context/MasterViewContext';
import ErrorBoundary from './pages/ErrorBoundary';

import LandingPage       from './pages/LandingPage';
import AdminLogin          from './pages/AdminLogin';
import AdminRegister       from './pages/AdminRegister';
import AdminSetupPassword  from './pages/AdminSetupPassword';
import AdminDashboard    from './pages/AdminDashboard';
import AdminMasterDashboard from './pages/AdminMasterDashboard';
import AdminCalendarManager from './pages/AdminCalendarManager';
import AdminBlockSchedule   from './pages/AdminBlockSchedule';
import AdminAppointment     from './pages/AdminAppointment';
import PatientList           from './components/admin/ficha-clinica/components/PatientList';
import NewPatientForm        from './components/admin/ficha-clinica/components/NewPatientForm';
import PatientDetail         from './components/admin/ficha-clinica/components/PatientDetail';
import ClinicalRecordManager from './components/admin/ficha-clinica/components/ClinicalRecordManager';
import ConsentSigning        from './pages/ConsentSigning';
import AIConsultationModule  from './pages/AIConsultationModule';
import AdminInventory    from './pages/AdminInventory';
import AdminFinance      from './pages/AdminFinance';
import Clinical3D        from './pages/Clinical3D';
import AdminSystemStatus from './pages/AdminSystemStatus';
import AdminBackup       from './pages/AdminBackup';
import AdminAgendaHub    from './pages/AdminAgendaHub';
import MasterClinicWrapper   from './pages/MasterClinicWrapper';
import ExternalMedicalFinance from './pages/ExternalMedicalFinance';
import SkinExplorerPage from './skin-explorer/SkinExplorerPage';

// ─────────────────────────────────────────────────────────────────────────────
// Rutas reutilizadas dentro del panel admin
// ─────────────────────────────────────────────────────────────────────────────

function AdminRoutes() {
  return (
    <AuthProvider>
      <MasterViewProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/admin/login" replace />} />

          <Route path="/admin/login"           element={<AdminLogin />} />
          {/* Ruta pública — accesible desde la página de login, sin auth requerida */}
          <Route path="/skin-explorer"          element={<SkinExplorerPage />} />
          <Route path="/admin/register"         element={<AdminRegister />} />
          <Route path="/admin/setup-password"   element={<AdminSetupPassword />} />
          <Route path="/admin/recover"          element={<AdminSetupPassword />} />
          <Route path="/admin/master"   element={<AdminMasterDashboard />} />

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
      <Routes>
        <Route path="/"                        element={<LandingPage />} />
        <Route path="/consent-signing/:token"  element={<ConsentSigning />} />
        <Route path="/medical-finance"         element={<ExternalMedicalFinance />} />
        <Route path="*"                        element={<LandingPage />} />
      </Routes>
    </BrowserRouter>
  );
}
