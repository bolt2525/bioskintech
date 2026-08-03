/**
 * @file src/App.tsx
 * @description Enrutador principal del Admin Panel BIOSKIN.
 *
 * Usa BrowserRouter (rutas limpias sin #).
 * Vercel sirve siempre index.html para cualquier ruta via rewrite catch-all en vercel.json.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';

// ── Página de error ────────────────────────────────────────────────────────
import ErrorBoundary from './pages/ErrorBoundary';

// ── Auth ───────────────────────────────────────────────────────────────────
import AdminLogin    from './pages/AdminLogin';
import AdminRegister from './pages/AdminRegister';

// ── Dashboards ─────────────────────────────────────────────────────────────
import AdminDashboard       from './pages/AdminDashboard';
import AdminMasterDashboard from './pages/AdminMasterDashboard';

// ── Agenda / Citas ─────────────────────────────────────────────────────────
import AdminCalendarManager from './pages/AdminCalendarManager';
import AdminBlockSchedule   from './pages/AdminBlockSchedule';
import AdminAppointment     from './pages/AdminAppointment';

// ── Fichas Clínicas ────────────────────────────────────────────────────────
import PatientList           from './components/admin/ficha-clinica/components/PatientList';
import NewPatientForm        from './components/admin/ficha-clinica/components/NewPatientForm';
import PatientDetail         from './components/admin/ficha-clinica/components/PatientDetail';
import ClinicalRecordManager from './components/admin/ficha-clinica/components/ClinicalRecordManager';
import ConsentSigning        from './pages/ConsentSigning';

// ── Módulo IA ──────────────────────────────────────────────────────────────
import AIConsultationModule from './pages/AIConsultationModule';

// ── Gestión ────────────────────────────────────────────────────────────────
import AdminInventory from './pages/AdminInventory';
import AdminFinance   from './pages/AdminFinance';
import Clinical3D     from './pages/Clinical3D';

// ── Sistema ────────────────────────────────────────────────────────────────
import AdminSystemStatus from './pages/AdminSystemStatus';
import AdminBackup       from './pages/AdminBackup';

// ── Master admin viendo módulos de clínica ─────────────────────────────────
import MasterClinicWrapper from './pages/MasterClinicWrapper';

// ── Páginas externas ───────────────────────────────────────────────────────
import ExternalMedicalFinance from './pages/ExternalMedicalFinance';

// ── Contextos ──────────────────────────────────────────────────────────────
import { MasterViewProvider } from './context/MasterViewContext';

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <MasterViewProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/admin/login" replace />} />

            {/* Auth */}
            <Route path="/admin/login"    element={<AdminLogin />} />
            <Route path="/admin/register" element={<AdminRegister />} />

            {/* Dashboards */}
            <Route path="/admin/master" element={<AdminMasterDashboard />} />

            {/* Master admin viendo módulos de una clínica específica */}
            <Route path="/admin/master/:clinicSlug/:username" element={<MasterClinicWrapper />}>
              <Route index element={<AdminDashboard />} />
              <Route path="calendar"       element={<AdminCalendarManager />} />
              <Route path="block-schedule" element={<AdminBlockSchedule />} />
              <Route path="appointment"    element={<AdminAppointment />} />
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
            </Route>

            {/* Rutas con contexto: /admin/:clinicSlug/:username */}
            <Route path="/admin/:clinicSlug/:username" element={<AdminDashboard />} />

            {/* Agenda */}
            <Route path="/admin/:clinicSlug/:username/calendar"       element={<AdminCalendarManager />} />
            <Route path="/admin/:clinicSlug/:username/block-schedule" element={<AdminBlockSchedule />} />
            <Route path="/admin/:clinicSlug/:username/appointment"    element={<AdminAppointment />} />

            {/* Fichas Clínicas */}
            <Route path="/admin/:clinicSlug/:username/clinical-records"                    element={<PatientList />} />
            <Route path="/admin/:clinicSlug/:username/clinical-records/new"                element={<NewPatientForm />} />
            <Route path="/admin/:clinicSlug/:username/clinical-records/edit/:patientId"    element={<NewPatientForm />} />
            <Route path="/admin/:clinicSlug/:username/ficha-clinica/paciente/:patientId"   element={<PatientDetail />} />
            <Route path="/admin/:clinicSlug/:username/ficha-clinica/expediente/:recordId"  element={<ClinicalRecordManager />} />

            {/* IA */}
            <Route path="/admin/:clinicSlug/:username/ai-consultation" element={<AIConsultationModule />} />

            {/* Gestión */}
            <Route path="/admin/:clinicSlug/:username/inventory"   element={<AdminInventory />} />
            <Route path="/admin/:clinicSlug/:username/finance"     element={<AdminFinance />} />
            <Route path="/admin/:clinicSlug/:username/clinical-3d" element={<Clinical3D />} />

            {/* Sistema */}
            <Route path="/admin/:clinicSlug/:username/system-status" element={<AdminSystemStatus />} />
            <Route path="/admin/:clinicSlug/:username/backup"        element={<AdminBackup />} />

            {/* Alias legacy: /admin (sin prefijo) */}
            <Route path="/admin"                element={<AdminDashboard />} />
            <Route path="/admin/calendar"       element={<AdminCalendarManager />} />
            <Route path="/admin/block-schedule" element={<AdminBlockSchedule />} />
            <Route path="/admin/appointment"    element={<AdminAppointment />} />
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

            {/* Páginas externas */}
            <Route path="/consent-signing/:token" element={<ConsentSigning />} />
            <Route path="/medical-finance"         element={<ExternalMedicalFinance />} />

            <Route path="*" element={<Navigate to="/admin/login" replace />} />
          </Routes>
          </MasterViewProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
