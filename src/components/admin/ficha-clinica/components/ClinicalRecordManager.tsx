import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ClipboardList, 
  Activity, 
  Stethoscope, 
  Syringe, 
  Pill, 
  FileSignature, 
  ArrowLeft,
  Save,
  MessageSquare,
  Droplets
} from 'lucide-react';
import AdminLayout from '../../../layout/AdminLayout';
import ConsultationTab from './tabs/ConsultationTab';
import HistoryTab from './tabs/HistoryTab';
import PhysicalExamTab from './tabs/PhysicalExamTab';
import DiagnosisTab from './tabs/DiagnosisTab';
import TreatmentTab from './tabs/TreatmentTab';
import PrescriptionTab from './tabs/PrescriptionTab';
import ConsentimientosTab from './tabs/ConsentimientosTab';
import InjectablesTab from './tabs/InjectablesTab';
import { Skeleton } from '../../../ui/Skeleton';

interface TabButtonProps {
  id: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ id, label, icon: Icon, active, onClick }) => (
  <button
    onClick={onClick}
    className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
      active ? 'text-[#deb887]' : 'text-gray-500 hover:text-gray-700'
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
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('history');
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<any>(null);
  const [recordData, setRecordData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

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
      const recordRes = await fetch(`/api/records?action=getRecordData&recordId=${recordId}`);
      if (recordRes.ok) {
        const rData = await recordRes.json();
        setRecordData(rData);

        // Fetch patient info using patientId from record
        if (rData.patientId) {
          const patientRes = await fetch(`/api/records?action=getPatient&id=${rData.patientId}`);
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
            onClick={() => navigate('/admin/clinical-records')}
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
              onClick={() => navigate(`/admin/ficha-clinica/paciente/${patient?.id}`)}
              className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Volver al perfil del paciente</span>
            </button>
            <div className="flex items-center gap-2">
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
            <TabButton 
              id="history" 
              label="Antecedentes" 
              icon={ClipboardList} 
              active={activeTab === 'history'} 
              onClick={() => setActiveTab('history')} 
            />
            <TabButton 
              id="consultation" 
              label="Consulta" 
              icon={MessageSquare} 
              active={activeTab === 'consultation'} 
              onClick={() => setActiveTab('consultation')} 
            />
            <TabButton 
              id="physical" 
              label="Examen Físico" 
              icon={Activity} 
              active={activeTab === 'physical'} 
              onClick={() => setActiveTab('physical')} 
            />
            <TabButton 
              id="diagnosis" 
              label="Diagnóstico" 
              icon={Stethoscope} 
              active={activeTab === 'diagnosis'} 
              onClick={() => setActiveTab('diagnosis')} 
            />
            <TabButton 
              id="treatment" 
              label="Tratamientos" 
              icon={Syringe} 
              active={activeTab === 'treatment'} 
              onClick={() => setActiveTab('treatment')} 
            />
            <TabButton 
              id="prescription" 
              label="Recetas" 
              icon={Pill} 
              active={activeTab === 'prescription'} 
              onClick={() => setActiveTab('prescription')} 
            />
            <TabButton 
              id="consent" 
              label="Consentimientos" 
              icon={FileSignature} 
              active={activeTab === 'consent'} 
              onClick={() => setActiveTab('consent')} 
            />
            <TabButton 
              id="injectables" 
              label="Inyectables" 
              icon={Droplets} 
              active={activeTab === 'injectables'} 
              onClick={() => setActiveTab('injectables')} 
            />
          </div>

          {/* Tab Content */}
          <div className="p-6 bg-gray-50/30">
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
                    initialData={recordData.consultation} 
                    historyData={recordData.consultationHistory}
                    onSave={() => fetchData(false)} 
                  />
                )}
                {activeTab === 'physical' && (
                  <PhysicalExamTab 
                    recordId={recordData?.recordId} 
                    physicalExams={recordData?.physicalExams || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'diagnosis' && (
                  <DiagnosisTab 
                    recordId={recordData?.recordId} 
                    diagnoses={recordData?.diagnoses || []}
                    physicalExams={recordData?.physicalExams || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'treatment' && (
                  <TreatmentTab 
                    recordId={recordData?.recordId} 
                    treatments={recordData?.treatments || []}
                    physicalExams={recordData?.physicalExams || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    patientAge={patient?.birth_date ? calculateAge(patient.birth_date) : ''}
                    onSave={() => fetchData(false)}
                  />
                )}
                {activeTab === 'prescription' && (
                  <PrescriptionTab 
                    recordId={recordData?.recordId} 
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    patientAge={patient?.birth_date ? calculateAge(patient.birth_date) : ''}
                  />
                )}
                {activeTab === 'consent' && (
                  <ConsentimientosTab 
                    patientId={patient?.id}
                    recordId={parseInt(recordId!)}
                    patient={patient}
                  />
                )}
                {activeTab === 'injectables' && (
                  <InjectablesTab 
                    recordId={recordData?.recordId}
                    injectables={recordData?.injectables || []}
                    patientName={patient ? `${patient.first_name} ${patient.last_name}` : ''}
                    onSave={() => fetchData(false)}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
