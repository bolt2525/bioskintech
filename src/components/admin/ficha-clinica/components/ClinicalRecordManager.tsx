import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
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
import HistoryTab from './tabs/HistoryTab';
import PhysicalExamTab from './tabs/PhysicalExamTab';
import DiagnosisTab from './tabs/DiagnosisTab';
import TreatmentTab from './tabs/TreatmentTab';
import PrescriptionTab from './tabs/PrescriptionTab';
import ConsentimientosTab from './tabs/ConsentimientosTab';
import InjectablesTab from './tabs/InjectablesTab';
import PhotosTab from './tabs/PhotosTab';
import { Skeleton } from '../../../ui/Skeleton';

interface TabButtonProps {
  id: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

const TabButton: React.FC<TabButtonProps> = ({ id, label, icon: Icon, active, onClick, disabled }) => (  // ponytail: disabled → greyed out until consultation selected
  <button
    onClick={disabled ? undefined : onClick}
    title={disabled ? 'Selecciona o crea una consulta para habilitar este tab' : undefined}
    className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
      disabled ? 'text-gray-300 cursor-not-allowed' : active ? 'text-[#deb887]' : 'text-gray-500 hover:text-gray-700'
    }`}
  >
    {active && (
      <motion.div
        layoutId="activeTab"
        className="absolute inset-0 bg-[#deb887]/10 border-b-2 border-[#deb887]"
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

export default function ClinicalRecordManager() {
  const { recordId } = useParams();
  const { nav } = useAdminNav();
  const [activeTab, setActiveTab] = useState('consultation');
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<any>(null);
  const [recordData, setRecordData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Hub de consulta activa
  const [activeConsultation, setActiveConsultation] = useState<any>(null);
  const [showActivatedModal, setShowActivatedModal] = useState(false);
  const [pendingNewConsultation, setPendingNewConsultation] = useState<any>(null);
  const [showPrintModal, setShowPrintModal] = useState(false);

  // Tabs opcionales habilitados por la consulta activa
  const enabledOptional = {
    injectables: activeConsultation?.enable_injectables ?? false,
    consents: activeConsultation?.enable_consents ?? false,
  };

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

        // Fetch patient info using patientId from record
        if (rData.patientId) {
          const patientRes = await recordsFetch(`/api/records?action=getPatient&id=${rData.patientId}`);
          if (patientRes.ok) {
            const pData = await patientRes.json();
            setPatient(pData);
          }
        }
      } else {
        const errData = await recordRes.json().catch(() => ({ error: 'Error desconocido' }));
        setError(errData.error || 'Error al cargar el expediente');
      }
    } catch (error: any) {
      console.error('Error loading clinical record:', error);
      setError(error.message || 'Error de conexión');
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  const handleConsultationActivated = (consultation: any) => {
    setActiveConsultation(consultation);
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
        setActiveConsultation(updated);
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
      subtitle={`Expediente #${recordId} • ${patient?.rut || 'Sin RUT'}`}
      backPath={patient ? `/admin/ficha-clinica/paciente/${patient.id}` : '/admin/clinical-records'}
    >
      <div className="space-y-6">
        {/* Header with Back Button to Patient Profile - Sticky */}
        <div className="sticky top-0 z-20 bg-gray-50/95 backdrop-blur pt-2 pb-4">
          <div className="flex items-center justify-between bg-white p-4 rounded-xl shadow-sm border border-gray-100">
            <button 
              onClick={() => nav(`ficha-clinica/paciente/${patient?.id}`)}
              className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Volver al perfil del paciente</span>
            </button>
            <div className="flex items-center gap-2">
              {activeConsultation && (
                <div className="flex flex-col items-end min-w-0 max-w-[260px]">
                  <span className="text-[10px] text-gray-400 leading-none mb-0.5">
                    {new Date(activeConsultation.created_at).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                  <span
                    className="px-2.5 py-1 bg-amber-50 text-[#b8944d] rounded-full text-xs font-medium border border-[#deb887]/30 truncate max-w-full"
                    title={activeConsultation.reason || 'Consulta activa'}
                  >
                    {activeConsultation.reason || 'Consulta activa'}
                  </span>
                </div>
              )}
              <button
                onClick={() => setShowPrintModal(true)}
                title="Imprimir ficha clínica"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-[#b8944d] hover:bg-amber-50 rounded-lg border border-gray-200 hover:border-[#deb887]/40 transition-colors"
              >
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">Imprimir</span>
              </button>
              <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium flex items-center gap-1">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                Ficha Activa
              </span>
            </div>
          </div>
        </div>

        {/* Tabs Navigation */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-hidden overflow-y-visible min-h-[600px]">
          <div className="flex overflow-x-auto border-b border-gray-100 scrollbar-hide">
            <TabButton id="history" label="Antecedentes" icon={ClipboardList}
              active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
            <TabButton id="consultation" label="Consulta" icon={MessageSquare}
              active={activeTab === 'consultation'} onClick={() => setActiveTab('consultation')} />
            <TabButton id="physical" label="Examen Físico" icon={Activity}
              active={activeTab === 'physical'} onClick={() => setActiveTab('physical')}
              disabled={!activeConsultation} />
            <TabButton id="diagnosis" label="Diagnóstico" icon={Stethoscope}
              active={activeTab === 'diagnosis'} onClick={() => setActiveTab('diagnosis')}
              disabled={!activeConsultation} />
            <TabButton id="treatment" label="Tratamientos" icon={Syringe}
              active={activeTab === 'treatment'} onClick={() => setActiveTab('treatment')}
              disabled={!activeConsultation} />
            <TabButton id="prescription" label="Recetas" icon={Pill}
              active={activeTab === 'prescription'} onClick={() => setActiveTab('prescription')}
              disabled={!activeConsultation} />
            {enabledOptional.consents && (
              <TabButton id="consent" label="Consentimientos" icon={FileSignature}
                active={activeTab === 'consent'} onClick={() => setActiveTab('consent')}
                disabled={!activeConsultation} />
            )}
            {enabledOptional.injectables && (
              <TabButton id="injectables" label="Inyectables" icon={Droplets}
                active={activeTab === 'injectables'} onClick={() => setActiveTab('injectables')}
                disabled={!activeConsultation} />
            )}
            <TabButton id="photos" label="Fotos" icon={Camera}
              active={activeTab === 'photos'} onClick={() => setActiveTab('photos')} />
          </div>

          {/* Tab Content */}
          <div className="p-6 bg-gray-50/30">
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
                    onSelectConsultation={setActiveConsultation}
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
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                  />
                )}
                {activeTab === 'consent' && activeConsultation && enabledOptional.consents && (
                  <ConsentimientosTab
                    patientId={patient?.id}
                    recordId={parseInt(recordId!)}
                    patient={patient}
                    consultationId={activeConsultation?.id}
                    consultations={recordData?.consultations || []}
                  />
                )}
                {activeTab === 'injectables' && activeConsultation && enabledOptional.injectables && (
                  <InjectablesTab
                    recordId={recordData?.recordId}
                    injectables={recordData?.injectables || []}
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
