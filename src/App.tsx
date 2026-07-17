/**
 * @file src/App.tsx
 * @description Enrutador principal del Admin Panel BIOSKIN.
 *
 * Usa HashRouter (#) requerido para Vercel SPA sin SSR.
 *
 * Patrones de ruta:
 *   /admin/login                          → login
 *   /admin/master                         → master_admin dashboard
 *   /admin/:clinicSlug/:username          → dashboard de clínica
 *   /admin/:clinicSlug/:username/{módulo} → módulos con contexto de clínica
 *
 * Las rutas antiguas (/admin/clinical-records etc.) se mantienen como alias
 * para compatibilidad con sesiones existentes.
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

// ── Módulos de IA ──────────────────────────────────────────────────────────
import AdminDiagnosis    from './pages/AdminDiagnosis';
import AdminProtocols    from './pages/AdminProtocols';
import AdminChatAssistant from './pages/AdminChatAssistant';

// ── Gestión ────────────────────────────────────────────────────────────────
import AdminInventory from './pages/AdminInventory';
import AdminFinance   from './pages/AdminFinance';

// ── Visualización 3D ───────────────────────────────────────────────────────
import Clinical3D from './pages/Clinical3D';

// ── Servicio Técnico ───────────────────────────────────────────────────────
import TechnicalDashboard    from './components/admin/technical/TechnicalDashboard';
import TechnicalDocumentForm from './components/admin/technical/TechnicalDocumentForm';
import TechnicalDocumentView from './components/admin/technical/TechnicalDocumentView';

// ── Módulos externos ───────────────────────────────────────────────────────
import ExternalMedicalFinance from './pages/ExternalMedicalFinance';
import BlogAdminPage          from './pages/BlogAdminPage';

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  return (
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <Routes>

            {/* Redirigir raíz al login */}
            <Route path="/" element={<Navigate to="/admin/login" replace />} />

            {/* ── Auth ───────────────────────────────────────────────── */}
            <Route path="/admin/login" element={<AdminLogin />} />

            {/* ── Dashboards ─────────────────────────────────────────── */}
            <Route path="/admin/master" element={<AdminMasterDashboard />} />

            {/* ── Rutas con contexto: /admin/:clinicSlug/:username ─────── */}
            {/* Dashboard de clínica */}
            <Route path="/admin/:clinicSlug/:username" element={<AdminDashboard />} />

            {/* Agenda */}
            <Route path="/admin/:clinicSlug/:username/calendar"       element={<AdminCalendarManager />} />
            <Route path="/admin/:clinicSlug/:username/block-schedule" element={<AdminBlockSchedule />} />
            <Route path="/admin/:clinicSlug/:username/appointment"    element={<AdminAppointment />} />

            {/* Fichas Clínicas */}
            <Route path="/admin/:clinicSlug/:username/clinical-records"              element={<PatientList />} />
            <Route path="/admin/:clinicSlug/:username/clinical-records/new"          element={<NewPatientForm />} />
            <Route path="/admin/:clinicSlug/:username/clinical-records/edit/:patientId" element={<NewPatientForm />} />
            <Route path="/admin/:clinicSlug/:username/ficha-clinica/paciente/:patientId"  element={<PatientDetail />} />
            <Route path="/admin/:clinicSlug/:username/ficha-clinica/expediente/:recordId" element={<ClinicalRecordManager />} />

            {/* IA */}
            <Route path="/admin/:clinicSlug/:username/diagnosis"      element={<AdminDiagnosis />} />
            <Route path="/admin/:clinicSlug/:username/protocols"      element={<AdminProtocols />} />
            <Route path="/admin/:clinicSlug/:username/chat-assistant" element={<AdminChatAssistant />} />

            {/* Gestión */}
            <Route path="/admin/:clinicSlug/:username/inventory" element={<AdminInventory />} />
            <Route path="/admin/:clinicSlug/:username/finance"   element={<AdminFinance />} />
            <Route path="/admin/:clinicSlug/:username/clinical-3d" element={<Clinical3D />} />

            {/* Técnico */}
            <Route path="/admin/:clinicSlug/:username/technical"          element={<TechnicalDashboard />} />
            <Route path="/admin/:clinicSlug/:username/technical/new"      element={<TechnicalDocumentForm />} />
            <Route path="/admin/:clinicSlug/:username/technical/edit/:id" element={<TechnicalDocumentForm />} />
            <Route path="/admin/:clinicSlug/:username/technical/view/:id" element={<TechnicalDocumentView />} />

            {/* ── Alias legacy: /admin (sin prefijo) ─────────────────── */}
            <Route path="/admin"                element={<AdminDashboard />} />
            <Route path="/admin/calendar"       element={<AdminCalendarManager />} />
            <Route path="/admin/block-schedule" element={<AdminBlockSchedule />} />
            <Route path="/admin/appointment"    element={<AdminAppointment />} />
            <Route path="/admin/clinical-records"              element={<PatientList />} />
            <Route path="/admin/clinical-records/new"          element={<NewPatientForm />} />
            <Route path="/admin/clinical-records/edit/:patientId" element={<NewPatientForm />} />
            <Route path="/admin/ficha-clinica/paciente/:patientId"  element={<PatientDetail />} />
            <Route path="/admin/ficha-clinica/expediente/:recordId" element={<ClinicalRecordManager />} />
            <Route path="/admin/diagnosis"      element={<AdminDiagnosis />} />
            <Route path="/admin/protocols"      element={<AdminProtocols />} />
            <Route path="/admin/chat-assistant" element={<AdminChatAssistant />} />
            <Route path="/admin/inventory" element={<AdminInventory />} />
            <Route path="/admin/finance"   element={<AdminFinance />} />
            <Route path="/admin/clinical-3d" element={<Clinical3D />} />
            <Route path="/admin/technical"          element={<TechnicalDashboard />} />
            <Route path="/admin/technical/new"      element={<TechnicalDocumentForm />} />
            <Route path="/admin/technical/edit/:id" element={<TechnicalDocumentForm />} />
            <Route path="/admin/technical/view/:id" element={<TechnicalDocumentView />} />

            {/* ── Páginas externas ────────────────────────────────────── */}
            <Route path="/consent-signing/:token" element={<ConsentSigning />} />
            <Route path="/medical-finance"        element={<ExternalMedicalFinance />} />
            <Route path="/blog-admin"             element={<BlogAdminPage />} />

            {/* Cualquier ruta desconocida → login */}
            <Route path="*" element={<Navigate to="/admin/login" replace />} />

          </Routes>
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
