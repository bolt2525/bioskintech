/**
 * @file src/App.tsx
 * @description Enrutador principal del Admin Panel BIOSKIN.
 *
 * Usa HashRouter (#) requerido para Vercel SPA sin SSR.
 * Todas las rutas son de administración — no hay páginas públicas en este proyecto.
 *
 * Estructura de rutas:
 *   /                              → redirige a /admin/login
 *   /admin/login                   → página de login
 *   /admin/master                  → dashboard del master_admin
 *   /admin                         → dashboard de la clínica
 *   /admin/calendar                → gestión de agenda
 *   /admin/block-schedule          → bloqueo de horarios
 *   /admin/appointment             → agendar cita manual
 *   /admin/diagnosis               → diagnóstico IA
 *   /admin/protocols               → protocolos clínicos
 *   /admin/chat-assistant          → asistente IA
 *   /admin/inventory               → inventario
 *   /admin/finance                 → finanzas
 *   /admin/clinical-3d             → visualización 3D
 *   /admin/clinical-records        → listado de pacientes
 *   /admin/clinical-records/new    → nuevo paciente
 *   /admin/clinical-records/edit/:patientId → editar paciente
 *   /admin/ficha-clinica/paciente/:patientId → detalle de paciente
 *   /admin/ficha-clinica/expediente/:recordId → expediente clínico
 *   /admin/technical               → servicio técnico
 *   /admin/technical/new           → nuevo documento técnico
 *   /admin/technical/edit/:id      → editar documento técnico
 *   /admin/technical/view/:id      → ver documento técnico
 *   /consent-signing/:token        → firma remota de consentimientos
 *   /medical-finance               → gestión médica externa
 *   /blog-admin                    → administración del blog
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
            <Route path="/admin"        element={<AdminDashboard />} />

            {/* ── Agenda / Citas ──────────────────────────────────────── */}
            <Route path="/admin/calendar"       element={<AdminCalendarManager />} />
            <Route path="/admin/block-schedule" element={<AdminBlockSchedule />} />
            <Route path="/admin/appointment"    element={<AdminAppointment />} />

            {/* ── Fichas Clínicas ─────────────────────────────────────── */}
            <Route path="/admin/clinical-records"              element={<PatientList />} />
            <Route path="/admin/clinical-records/new"          element={<NewPatientForm />} />
            <Route path="/admin/clinical-records/edit/:patientId" element={<NewPatientForm />} />
            <Route path="/admin/ficha-clinica/paciente/:patientId"  element={<PatientDetail />} />
            <Route path="/admin/ficha-clinica/expediente/:recordId" element={<ClinicalRecordManager />} />

            {/* ── Módulos de IA ───────────────────────────────────────── */}
            <Route path="/admin/diagnosis"      element={<AdminDiagnosis />} />
            <Route path="/admin/protocols"      element={<AdminProtocols />} />
            <Route path="/admin/chat-assistant" element={<AdminChatAssistant />} />

            {/* ── Gestión ─────────────────────────────────────────────── */}
            <Route path="/admin/inventory" element={<AdminInventory />} />
            <Route path="/admin/finance"   element={<AdminFinance />} />

            {/* ── Visualización 3D ────────────────────────────────────── */}
            <Route path="/admin/clinical-3d" element={<Clinical3D />} />

            {/* ── Servicio Técnico ────────────────────────────────────── */}
            <Route path="/admin/technical"          element={<TechnicalDashboard />} />
            <Route path="/admin/technical/new"      element={<TechnicalDocumentForm />} />
            <Route path="/admin/technical/edit/:id" element={<TechnicalDocumentForm />} />
            <Route path="/admin/technical/view/:id" element={<TechnicalDocumentView />} />

            {/* ── Páginas externas ────────────────────────────────────── */}
            {/* Firma remota de consentimientos (acceso público por token) */}
            <Route path="/consent-signing/:token" element={<ConsentSigning />} />
            {/* Gestión médica externa (acceso especial, sin roles admin) */}
            <Route path="/medical-finance" element={<ExternalMedicalFinance />} />
            {/* Blog Admin */}
            <Route path="/blog-admin" element={<BlogAdminPage />} />

            {/* Cualquier ruta desconocida → login */}
            <Route path="*" element={<Navigate to="/admin/login" replace />} />

          </Routes>
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}

export default App;
