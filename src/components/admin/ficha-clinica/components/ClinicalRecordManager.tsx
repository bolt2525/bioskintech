import React, { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import recordsFetch from '../../../../utils/recordsFetch';
import { useAdminNav } from '../../../../hooks/useAdminNav';
import { 
  ClipboardList, 
  Activity, 
  Stethoscope, 
  Syringe, 
  Pill, 
  FileSignature, 
  ArrowLeft,
  MessageSquare,
  Droplets,
  Printer,
  Lock,
  Camera
} from 'lucide-react';
import ConsultationActivatedModal from './ConsultationActivatedModal';
import PrintModal from './PrintModal';
import AdminLayout from '../../../layout/AdminLayout';
import ConsultationTab from './tabs/ConsultationTab';
import { Skeleton } from '../../../ui/Skeleton';

const HistoryTab = React.lazy(() => import('./tabs/HistoryTab'));
const PhysicalExamTab = React.lazy(() => import('./tabs/PhysicalExamTab'));
const DiagnosisTab = React.lazy(() => import('./tabs/DiagnosisTab'));
const TreatmentTab = React.lazy(() => import('./tabs/TreatmentTab'));
const PrescriptionTab = React.lazy(() => import('./tabs/PrescriptionTab'));
const ConsentimientosTab = React.lazy(() => import('./tabs/ConsentimientosTab'));
const InjectablesTab = React.lazy(() => import('./tabs/InjectablesTab'));
const PhotosTab = React.lazy(() => import('./tabs/PhotosTab'));

interface TabButtonProps {
  id: ClinicalTabId;
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}

const CLINICAL_TABS = ['history', 'consultation', 'physical', 'diagnosis', 'treatment', 'prescription', 'consent', 'injectables', 'photos'] as const;
type ClinicalTabId = typeof CLINICAL_TABS[number];

const TabButton: React.FC<TabButtonProps> = ({ id, label, icon: Icon, active, onClick, onKeyDown, disabled }) => (  // ponytail: disabled → greyed out until consultation selected
  <button
    id={`clinical-tab-${id}`}
    type="button"
    role="tab"
    onClick={disabled ? undefined : onClick}
    onKeyDown={onKeyDown}
    disabled={disabled}
    aria-selected={active}
    aria-controls="clinical-tabpanel"
    tabIndex={active ? 0 : -1}
    title={disabled ? 'Selecciona o crea una consulta para habilitar este tab' : undefined}
    className={`admin-focus-ring relative flex min-h-12 shrink-0 items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
      disabled ? 'text-gray-300 cursor-not-allowed' : active ? 'text-emerald-950' : 'text-gray-500 hover:text-gray-700'
    }`}
  >
    {active && (
      <motion.div
        layoutId="activeTab"
        className="absolute inset-0 rounded-t-lg border-b-2 border-emerald-800 bg-emerald-950/5"
        initial={false}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    )}
    <span className="relative z-10 flex items-center gap-2">
      <Icon className="w-4 h-4" />
      {label}
    </span>
  </button>
);

interface ClinicalPatient {
  id: number;
  first_name: string;
  last_name: string;
  identification_type?: string;
  identification_number?: string;
  birth_date?: string;
  [key: string]: unknown;
}

interface ClinicalConsultation {
  id: number;
  record_id: number;
  reason: string;
  current_illness: string;
  enable_injectables: boolean;
  enable_consents: boolean;
  created_at: string;
  updated_at: string;
}

interface ClinicalRecordData {
  recordId: number;
  patient?: ClinicalPatient;
  consultations?: ClinicalConsultation[];
  history?: {
    allergies?: string;
    [key: string]: unknown;
  };
  physicalExams?: {
    id?: number;
    record_id: number;
    consultation_id?: number;
    skin_type: string;
    phototype: string;
    glogau_scale: string;
    hydration: string;
    elasticity: string;
    lesions_description: string;
    photoprotection?: string;
    texture?: string;
    pores?: string;
    pigmentation?: string;
    sensitivity?: string;
    face_map_data?: string | import('./FaceMapCanvas').Mark[];
    body_map_data?: string | import('./FaceMapCanvas').Mark[];
    created_at?: string;
  }[];
  diagnoses?: {
    id?: number;
    record_id: number;
    consultation_id?: number;
    date?: string;
    diagnosis_text: string;
    cie10_code: string;
    type: string;
    severity: string;
    notes: string;
  }[];
  treatments?: {
    id?: number;
    consultation_id?: number;
    date: string;
    procedure_name: string;
    equipment_used: string;
    parameters?: Record<string, import('./tabs/TreatmentParametersModal').TreatmentParameters> | null;
    area_treated: string;
    duration_minutes: number;
    cost: number;
    notes: string;
  }[];
  prescriptions?: unknown[];
  consentForms?: unknown[];
  injectables?: unknown[];
}

export default function ClinicalRecordManager() {
  const { recordId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { nav } = useAdminNav();
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<ClinicalTabId>(
    CLINICAL_TABS.includes(requestedTab as ClinicalTabId) ? requestedTab as ClinicalTabId : 'consultation'
  );
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<ClinicalPatient | null>(null);
  const [recordData, setRecordData] = useState<ClinicalRecordData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hub de consulta activa
  const [activeConsultation, setActiveConsultation] = useState<ClinicalConsultation | null>(null);
  const [showActivatedModal, setShowActivatedModal] = useState(false);
  const [pendingNewConsultation, setPendingNewConsultation] = useState<ClinicalConsultation | null>(null);
  const [showPrintModal, setShowPrintModal] = useState(false);

  // Tabs opcionales habilitados por la consulta activa
  const enabledOptional = {
    injectables: activeConsultation?.enable_injectables ?? false,
    consents: activeConsultation?.enable_consents ?? false,
  };

  const visibleTabs: ClinicalTabId[] = [
    'history', 'consultation', 'physical', 'diagnosis', 'treatment', 'prescription',
    ...(enabledOptional.consents ? ['consent' as const] : []),
    ...(enabledOptional.injectables ? ['injectables' as const] : []),
    'photos',
  ];

  const isTabDisabled = (tab: ClinicalTabId) =>
    !activeConsultation && !['history', 'consultation', 'photos'].includes(tab);

  const activateTab = (tab: ClinicalTabId) => {
    if (isTabDisabled(tab)) return;
    setActiveTab(tab);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const handleSelectConsultation = (consultation: ClinicalConsultation | null) => {
    setActiveConsultation(consultation);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (consultation) next.set('consultation', String(consultation.id));
      else next.delete('consultation');
      return next;
    }, { replace: true });
  };

  const handleTabKeyDown = (currentTab: ClinicalTabId, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabledTabs = visibleTabs.filter(tab => !isTabDisabled(tab));
    const currentIndex = enabledTabs.indexOf(currentTab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabledTabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + enabledTabs.length) % enabledTabs.length;
    const nextTab = enabledTabs[nextIndex];
    activateTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`clinical-tab-${nextTab}`)?.focus());
  };

  useEffect(() => {
    if (!CLINICAL_TABS.includes(requestedTab as ClinicalTabId)) return;
    const nextTab = requestedTab as ClinicalTabId;
    const optionalTabUnavailable =
      (nextTab === 'consent' && !enabledOptional.consents) ||
      (nextTab === 'injectables' && !enabledOptional.injectables);
    const consultationRequired =
      !activeConsultation && !['history', 'consultation', 'photos'].includes(nextTab);
    if (nextTab !== activeTab && !optionalTabUnavailable && !consultationRequired) setActiveTab(nextTab);
  }, [requestedTab, activeTab, activeConsultation, enabledOptional.consents, enabledOptional.injectables]);

  useEffect(() => {
    if (loading) return;
    const optionalTabUnavailable =
      (activeTab === 'consent' && !enabledOptional.consents) ||
      (activeTab === 'injectables' && !enabledOptional.injectables);
    const consultationRequired =
      !activeConsultation && !['history', 'consultation', 'photos'].includes(activeTab);

    if (optionalTabUnavailable || consultationRequired) {
      setActiveTab('consultation');
      setSearchParams(previous => {
        const next = new URLSearchParams(previous);
        next.set('tab', 'consultation');
        return next;
      }, { replace: true });
    }
  }, [activeTab, activeConsultation, enabledOptional.consents, enabledOptional.injectables, loading, setSearchParams]);

  useEffect(() => {
    if (recordId) {
      fetchData();
    }
  }, [recordId]);

  const fetchData = async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);
      
      // Fetch record data first
      const recordRes = await recordsFetch(`/api/records?action=getRecordData&recordId=${recordId}`);
      if (recordRes.ok) {
        const rData = await recordRes.json();
        setRecordData(rData);
        setPatient(rData.patient || null);
        const requestedConsultationId = Number(searchParams.get('consultation'));
        if (requestedConsultationId > 0) {
          const requestedConsultation = (rData.consultations || []).find(
            (consultation: ClinicalConsultation) => Number(consultation.id) === requestedConsultationId
          );
          if (requestedConsultation) setActiveConsultation(requestedConsultation);
        }
      } else {
        const errData = await recordRes.json().catch(() => ({ error: 'Error desconocido' }));
        setError(errData.error || 'Error al cargar el expediente');
      }
    } catch (error) {
      console.error('Error loading clinical record:', error);
      setError(error instanceof Error ? error.message : 'Error de conexión');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const handleConsultationActivated = (consultation: ClinicalConsultation) => {
    handleSelectConsultation(consultation);
    setPendingNewConsultation(consultation);
    setShowActivatedModal(true);
  };

  const handleModalConfirm = async (enableInj: boolean, enableCons: boolean) => {
    if (!pendingNewConsultation) return;
    try {
      const r = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateConsultation',
          id: pendingNewConsultation.id,
          enable_injectables: enableInj,
          enable_consents: enableCons,
        }),
      });
      if (r.ok) {
        const updated = await r.json();
        handleSelectConsultation(updated);
        fetchData(false);
      }
    } catch (e) { console.error('Error updating consultation tabs:', e); }
    setShowActivatedModal(false);
    setPendingNewConsultation(null);
  };

  const calculateAge = (birthDate: string) => {
    if (!birthDate) return '';
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  };

  if (loading) {
    return (
      <AdminLayout title="Cargando..." showBack={false}>
        <div className="space-y-6 p-6">
          <div className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex border-b border-gray-100 p-2 gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Skeleton key={i} className="h-10 w-32" />
              ))}
            </div>
            <div className="p-6 space-y-4">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (!recordData || error) {
    return (
      <AdminLayout title="Error" showBack={true}>
        <div className="text-center py-12">
          <h3 className="text-xl font-semibold text-gray-800">Expediente no encontrado</h3>
          {error && <p className="text-red-500 mt-2">{error}</p>}
          <button 
            onClick={() => nav('clinical-records')}
            className="mt-4 text-[#deb887] hover:underline"
          >
            Volver a la lista
          </button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title={patient ? `${patient.first_name} ${patient.last_name}` : 'Cargando...'} 
      subtitle={`Expediente #${recordId} • ${patient?.identification_type === 'ruc' ? 'RUC' : patient?.identification_type === 'cedula' ? 'Cédula' : 'Identificación'} ${patient?.identification_number || 'no registrada'}`}
      backPath={patient ? `/admin/ficha-clinica/paciente/${patient.id}` : '/admin/clinical-records'}
    >
      <div className="space-y-5">
        <section className="overflow-hidden rounded-lg border border-emerald-950/10 bg-[#172522] text-white shadow-sm">
          <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
            <button 
              onClick={() => nav(`ficha-clinica/paciente/${patient?.id}`)}
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-emerald-50/70 transition-colors hover:bg-white/5 hover:text-white"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Volver al perfil del paciente</span>
            </button>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-2">
                <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-100/60">Expediente #{recordId}</span>
                <span className="flex items-center gap-1.5 rounded-md bg-emerald-400/10 px-2 py-1 text-xs font-medium text-emerald-200">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" /> Ficha activa
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-2 lg:justify-end lg:pl-0">
              {activeConsultation && (
                <div className="mr-auto min-w-0 max-w-[260px] lg:mr-2 lg:text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-emerald-100/50">
                    {new Date(activeConsultation.created_at).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                  <span
                    className="mt-1 block max-w-full truncate text-sm font-medium text-white"
                    title={activeConsultation.reason || 'Consulta activa'}
                  >
                    {activeConsultation.reason || 'Consulta activa'}
                  </span>
                </div>
              )}
              <button
                onClick={() => setShowPrintModal(true)}
                title="Imprimir ficha clínica"
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-emerald-50 transition-colors hover:bg-white/10"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">Imprimir</span>
              </button>
            </div>
          </div>
        </section>

        {/* Tabs Navigation */}
        <div className="admin-surface min-h-[600px] overflow-hidden">
          <div className="flex snap-x snap-mandatory overflow-x-auto border-b border-gray-100 px-2 scrollbar-hide" role="tablist" aria-label="Secciones del expediente clínico">
            <TabButton id="history" label="Antecedentes" icon={ClipboardList}
              active={activeTab === 'history'} onClick={() => activateTab('history')} onKeyDown={event => handleTabKeyDown('history', event)} />
            <TabButton id="consultation" label="Consulta" icon={MessageSquare}
              active={activeTab === 'consultation'} onClick={() => activateTab('consultation')} onKeyDown={event => handleTabKeyDown('consultation', event)} />
            <TabButton id="physical" label="Examen Físico" icon={Activity}
              active={activeTab === 'physical'} onClick={() => activateTab('physical')} onKeyDown={event => handleTabKeyDown('physical', event)}
              disabled={!activeConsultation} />
            <TabButton id="diagnosis" label="Diagnóstico" icon={Stethoscope}
              active={activeTab === 'diagnosis'} onClick={() => activateTab('diagnosis')} onKeyDown={event => handleTabKeyDown('diagnosis', event)}
              disabled={!activeConsultation} />
            <TabButton id="treatment" label="Tratamientos" icon={Syringe}
              active={activeTab === 'treatment'} onClick={() => activateTab('treatment')} onKeyDown={event => handleTabKeyDown('treatment', event)}
              disabled={!activeConsultation} />
            <TabButton id="prescription" label="Recetas" icon={Pill}
              active={activeTab === 'prescription'} onClick={() => activateTab('prescription')} onKeyDown={event => handleTabKeyDown('prescription', event)}
              disabled={!activeConsultation} />
            {enabledOptional.consents && (
              <TabButton id="consent" label="Consentimientos" icon={FileSignature}
                active={activeTab === 'consent'} onClick={() => activateTab('consent')} onKeyDown={event => handleTabKeyDown('consent', event)}
                disabled={!activeConsultation} />
            )}
            {enabledOptional.injectables && (
              <TabButton id="injectables" label="Inyectables" icon={Droplets}
                active={activeTab === 'injectables'} onClick={() => activateTab('injectables')} onKeyDown={event => handleTabKeyDown('injectables', event)}
                disabled={!activeConsultation} />
            )}
            <TabButton id="photos" label="Fotos" icon={Camera}
              active={activeTab === 'photos'} onClick={() => activateTab('photos')} onKeyDown={event => handleTabKeyDown('photos', event)} />
          </div>

          {/* Tab Content */}
          <div id="clinical-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`clinical-tab-${activeTab}`} className="clinical-workspace min-w-0 bg-gray-50/30 p-4 outline-none sm:p-6">
            {/* Banner cuando no hay consulta activa */}
            {!activeConsultation && activeTab !== 'history' && activeTab !== 'consultation' && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 flex items-center gap-3 px-4 py-3 bg-amber-50 border border-[#deb887]/40 rounded-xl text-sm text-[#b8944d]"
              >
                <Lock className="w-4 h-4 flex-shrink-0" />
                <span>Selecciona o crea una consulta en el tab <strong>Consulta</strong> para habilitar este tab.</span>
              </motion.div>
            )}
            <React.Suspense fallback={<div className="min-h-40 flex items-center justify-center text-sm text-gray-500" role="status">Cargando sección clínica...</div>}>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
              >
                {activeTab === 'history' && (
                  <HistoryTab
                    recordId={recordData?.recordId}
                    initialData={recordData?.history}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'consultation' && (
                  <ConsultationTab
                    recordId={parseInt(recordId!)}
                    consultations={recordData?.consultations || []}
                    activeConsultation={activeConsultation}
                    onSelectConsultation={handleSelectConsultation}
                    onConsultationCreated={handleConsultationActivated}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'physical' && activeConsultation && (
                  <PhysicalExamTab
                    recordId={recordData?.recordId}
                    physicalExams={recordData?.physicalExams || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'diagnosis' && activeConsultation && (
                  <DiagnosisTab
                    recordId={recordData?.recordId}
                    diagnoses={recordData?.diagnoses || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'treatment' && activeConsultation && (
                  <TreatmentTab
                    recordId={recordData?.recordId}
                    treatments={recordData?.treatments || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'prescription' && activeConsultation && (
                  <PrescriptionTab
                    recordId={recordData?.recordId}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    patientAge={patient?.birth_date ? calculateAge(patient.birth_date) : ''}
                    patientIdentification={patient?.identification_number || ''}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    diagnoses={recordData?.diagnoses || []}
                    allergies={recordData?.history?.allergies || ''}
                    initialPrescriptions={(recordData?.prescriptions || []) as never[]}
                  />
                )}
                {activeTab === 'consent' && activeConsultation && enabledOptional.consents && patient && (
                  <ConsentimientosTab
                    patientId={patient.id}
                    recordId={parseInt(recordId!)}
                    patient={patient}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    initialConsents={(recordData?.consentForms || []) as never[]}
                  />
                )}
                {activeTab === 'injectables' && activeConsultation && enabledOptional.injectables && (
                  <InjectablesTab
                    recordId={recordData?.recordId}
                    injectables={(recordData?.injectables || []) as never[]}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'photos' && (
                  <PhotosTab
                    recordId={parseInt(recordId!)}
                    consultationId={activeConsultation?.id}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                  />
                )}
              </motion.div>
            </AnimatePresence>
            </React.Suspense>
          </div>
        </div>
        {/* Modal de consulta activada */}
        {showActivatedModal && pendingNewConsultation && (
          <ConsultationActivatedModal
            consultationId={pendingNewConsultation.id}
            onConfirm={handleModalConfirm}
            onClose={() => { setShowActivatedModal(false); setPendingNewConsultation(null); }}
          />
        )}
        {showPrintModal && (
          <PrintModal
            patient={patient}
            recordId={parseInt(recordId!)}
            recordData={recordData}
            activeConsultation={activeConsultation}
            onClose={() => setShowPrintModal(false)}
          />
        )}
      </div>
    </AdminLayout>
  );
}
