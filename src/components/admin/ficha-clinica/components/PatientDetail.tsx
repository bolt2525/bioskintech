import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, FileText, Calendar, Clock, ArrowRight, Edit2, Trash2 } from 'lucide-react';
import AdminLayout from '../../../layout/AdminLayout';
import recordsFetch from '../../../../utils/recordsFetch';
import { useAdminNav } from '../../../../hooks/useAdminNav';
import { useAuth } from '../../../../hooks/useAuth';

/** Formats clinical record code: {INITIALS}-{YEAR}-{SEQ:03} */
function clinicCode(clinicName: string, seq: number, createdAt?: string): string {
  const words = (clinicName || 'CL').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const initials = words.length === 1 ? words[0].substring(0, 2) : words.slice(0, 3).map(w => w[0]).join('');
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
  return `${initials}-${year}-${String(seq).padStart(3, '0')}`;
}

interface Patient {
  id: number;
  first_name: string;
  last_name: string;
  identification_type: string;
  identification_number: string;
  email: string;
  phone: string;
  birth_date: string;
  gender: string;
  address: string;
  occupation: string;
}

interface ClinicalRecord {
  id: number;
  created_at: string;
  status: string;
  updated_at: string;
  created_by_full_name?: string;
  created_by_gentilicio?: string;
}

export default function PatientDetail() {
  const { patientId } = useParams();
  const { nav } = useAdminNav();
  const { user } = useAuth();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [records, setRecords] = useState<ClinicalRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (patientId) {
      fetchData();
    }
  }, [patientId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Fetch patient
      const patientRes = await recordsFetch(`/api/records?action=getPatient&id=${patientId}`);
      if (patientRes.ok) {
        setPatient(await patientRes.json());
      }

      // Fetch records
      const recordsRes = await recordsFetch(`/api/records?action=listRecords&patient_id=${patientId}`);
      if (recordsRes.ok) {
        setRecords(await recordsRes.json());
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteRecord = async (recordId: number) => {
    if (!window.confirm('¿Estás seguro de que deseas eliminar este expediente? Esta acción no se puede deshacer.')) {
      return;
    }

    try {
      const response = await recordsFetch(`/api/records?action=deleteRecord&id=${recordId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setRecords(records.filter(r => r.id !== recordId));
      } else {
        alert('Error al eliminar el expediente');
      }
    } catch (error) {
      console.error('Error deleting record:', error);
      alert('Error al eliminar el expediente');
    }
  };

  const handleCreateRecord = async () => {
    if (!confirm('¿Está seguro de crear un nuevo expediente para este paciente?')) return;

    try {
      const response = await recordsFetch('/api/records?action=createRecord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId }),
      });

      if (response.ok) {
        const newRecord = await response.json();
        nav(`ficha-clinica/expediente/${newRecord.id}`);
      }
    } catch (error) {
      console.error('Error creating record:', error);
    }
  };

  const handleDeletePatient = async () => {
    if (!confirm('¿Está seguro de eliminar este paciente y todo su historial? Esta acción no se puede deshacer.')) return;

    try {
      const response = await recordsFetch(`/api/records?action=deletePatient&id=${patientId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        nav('clinical-records');
      } else {
        alert('Error al eliminar el paciente');
      }
    } catch (error) {
      console.error('Error deleting patient:', error);
      alert('Error al eliminar el paciente');
    }
  };

  const calculateAge = (birthDate: string) => {
    if (!birthDate) return 0;
    const today = new Date();
    const birth = new Date(birthDate);
    
    // Use UTC methods for birth date to avoid timezone shifts
    let age = today.getFullYear() - birth.getUTCFullYear();
    const m = today.getMonth() - birth.getUTCMonth();
    
    if (m < 0 || (m === 0 && today.getDate() < birth.getUTCDate())) {
      age--;
    }
    return age;
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'No registrado';
    // Create date using UTC components to ensure it matches the input exactly
    const date = new Date(dateString);
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).toLocaleDateString();
  };

  if (loading) {
    return (
      <AdminLayout title="Cargando..." showBack={true}>
        <div className="flex justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-[#deb887] border-t-transparent rounded-full"></div>
        </div>
      </AdminLayout>
    );
  }

  if (!patient) {
    return (
      <AdminLayout title="Error" showBack={true}>
        <div className="text-center py-12">Paciente no encontrado</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout 
      title={`${patient.first_name} ${patient.last_name}`} 
      subtitle="Historial de Expedientes Clínicos"
      showBack={true}
      backPath="/admin/clinical-records"
    >
      <div className="space-y-8">
        {/* Patient Info Card */}
        <div className="admin-surface relative p-5 sm:p-6">
          <div className="absolute right-4 top-4 flex gap-1 sm:right-6 sm:top-6 sm:gap-2">
            <button 
              onClick={() => nav(`clinical-records/edit/${patient.id}`)}
              className="admin-focus-ring admin-interactive rounded-lg p-2 text-gray-500 hover:bg-gold/10 hover:text-gold-ink"
              title="Editar Información"
              aria-label="Editar información del paciente"
            >
              <Edit2 className="w-5 h-5" />
            </button>
            <button 
              onClick={handleDeletePatient}
              className="admin-focus-ring admin-interactive rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600"
              title="Eliminar Paciente"
              aria-label="Eliminar paciente"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-x-6 gap-y-4 pr-16 sm:grid-cols-2 sm:pr-20 lg:grid-cols-3">
            <div>
              <label className="text-sm text-gray-500">{patient.identification_type === 'ruc' ? 'RUC' : patient.identification_type === 'cedula' ? 'Cédula' : 'Identificación'}</label>
              <p className="font-medium text-gray-900">{patient.identification_number || 'No registrada'}</p>
            </div>
            <div>
              <label className="text-sm text-gray-500">Email</label>
              <p className="font-medium text-gray-900">{patient.email || 'No registrado'}</p>
            </div>
            <div>
              <label className="text-sm text-gray-500">Teléfono</label>
              <p className="font-medium text-gray-900">{patient.phone || 'No registrado'}</p>
            </div>
            <div>
              <label className="text-sm text-gray-500">Fecha de Nacimiento</label>
              <p className="font-medium text-gray-900">
                {formatDate(patient.birth_date)} 
                <span className="text-gray-500 text-sm ml-2">
                  ({calculateAge(patient.birth_date)} años)
                </span>
              </p>
            </div>
            <div>
              <label className="text-sm text-gray-500">Ocupación</label>
              <p className="font-medium text-gray-900">{patient.occupation || 'No registrado'}</p>
            </div>
            <div>
              <label className="text-sm text-gray-500">Dirección</label>
              <p className="font-medium text-gray-900">{patient.address || 'No registrado'}</p>
            </div>
          </div>
        </div>

        {/* Records List */}
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">Historial médico</p>
              <h2 className="mt-1 text-xl font-bold text-gray-900">Expedientes Clínicos</h2>
            </div>
            <button 
              onClick={handleCreateRecord}
              className="admin-focus-ring admin-interactive inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-xl bg-gold-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-gold-ink/90 sm:self-auto"
            >
              <Plus className="w-4 h-4" />
              Nuevo Expediente
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {records.length === 0 ? (
              <div className="bg-gray-50 p-8 rounded-xl text-center text-gray-500 border border-dashed border-gray-300">
                No hay expedientes registrados para este paciente.
              </div>
            ) : (
              records.map((record, recIdx) => (
                <div 
                  key={record.id}
                  className="admin-surface group flex flex-col justify-between gap-5 p-4 transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:p-5"
                >
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-gold/10 p-3 text-gold-ink">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">Expediente {clinicCode(user?.clinic_name || '', recIdx + 1, record.created_at)}</h3>
                      {record.created_by_full_name && (
                        <p className="text-sm font-medium text-[#c9a876] mt-0.5">
                          {record.created_by_gentilicio ? `${record.created_by_gentilicio} ` : ''}{record.created_by_full_name}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          {new Date(record.created_at).toLocaleDateString()}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          {new Date(record.created_at).toLocaleTimeString()}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          record.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {record.status === 'active' ? 'Activo' : 'Cerrado'}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-3 sm:border-0 sm:pt-0">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteRecord(record.id);
                      }}
                      className="admin-focus-ring admin-interactive rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="Eliminar Expediente"
                      aria-label={`Eliminar expediente ${clinicCode(user?.clinic_name || '', recIdx + 1, record.created_at)}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => nav(`ficha-clinica/expediente/${record.id}`)}
                      className="admin-focus-ring admin-interactive flex min-h-10 items-center gap-2 rounded-lg px-2 font-medium text-gold-ink hover:text-gold-ink/80"
                    >
                      Ver Detalles
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
