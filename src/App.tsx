/**
 * @file src/App.tsx
 * @description Enrutador principal del Admin Panel BIOSKIN.
 *
 * Usa HashRouter (#) requerido para Vercel SPA sin SSR.
 */

import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';

// ── Página de error ────────────────────────────────────────────────────────
import ErrorBoundary from './pages/ErrorBoundary';

// ── Auth ───────────────────────────────────────────────────────────────────
import AdminLogin from './pages/AdminLogin';

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

// ── Páginas externas ───────────────────────────────────────────────────────
import ExternalMedicalFinance from './pages/ExternalMedicalFinance';

function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/admin/login" replace />} />

            {/* Auth */}
            <Route path="/admin/login" element={<AdminLogin />} />

            {/* Dashboards */}
            <Route path="/admin/master" element={<AdminMasterDashboard />} />

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
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
