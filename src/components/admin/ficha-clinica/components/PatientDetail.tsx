import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, FileText, Calendar, Clock, ArrowRight, Edit2, Trash2 } from 'lucide-react';
import AdminLayout from '../../../layout/AdminLayout';

interface Patient {
  id: number;
  first_name: string;
  last_name: string;
  rut: string;
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
}

export default function PatientDetail() {
  const { patientId } = useParams();
  const navigate = useNavigate();
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
      const patientRes = await fetch(`/api/records?action=getPatient&id=${patientId}`);
      if (patientRes.ok) {
        setPatient(await patientRes.json());
      }

      // Fetch records
      const recordsRes = await fetch(`/api/records?action=listRecords&patient_id=${patientId}`);
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
      const response = await fetch(`/api/records?action=deleteRecord&id=${recordId}`, {
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
      const response = await fetch('/api/records?action=createRecord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patientId }),
      });

      if (response.ok) {
        const newRecord = await response.json();
        navigate(`/admin/ficha-clinica/expediente/${newRecord.id}`);
      }
    } catch (error) {
      console.error('Error creating record:', error);
    }
  };

  const handleDeletePatient = async () => {
    if (!confirm('¿Está seguro de eliminar este paciente y todo su historial? Esta acción no se puede deshacer.')) return;

    try {
      const response = await fetch(`/api/records?action=deletePatient&id=${patientId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        navigate('/admin/clinical-records');
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
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 relative">
          <div className="absolute top-6 right-6 flex gap-2">
            <button 
              onClick={() => navigate(`/admin/clinical-records/edit/${patient.id}`)}
              className="p-2 text-gray-500 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-lg transition-colors"
              title="Editar Información"
            >
              <Edit2 className="w-5 h-5" />
            </button>
            <button 
              onClick={handleDeletePatient}
              className="p-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Eliminar Paciente"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="text-sm text-gray-500">Identificación / Cédula / RUC</label>
              <p className="font-medium text-gray-900">{patient.rut || 'No registrado'}</p>
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
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold text-gray-800">Expedientes Clínicos</h2>
            <button 
              onClick={handleCreateRecord}
              className="bg-[#deb887] text-white px-4 py-2 rounded-lg hover:bg-[#c5a075] transition-colors flex items-center gap-2"
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
              records.map((record) => (
                <div 
                  key={record.id}
                  className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow flex justify-between items-center group"
                >
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-[#deb887]/10 rounded-lg text-[#deb887]">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">Expediente #{record.id}</h3>
                      <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
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
                  
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteRecord(record.id);
                      }}
                      className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="Eliminar Expediente"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => navigate(`/admin/ficha-clinica/expediente/${record.id}`)}
                      className="flex items-center gap-2 text-[#deb887] font-medium group-hover:translate-x-1 transition-transform"
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
