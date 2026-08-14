import React, { useState, useEffect } from 'react';
import { Search, Plus, FileText, User, Calendar, Edit2, Trash2, Clock, UserPlus, X, ArrowRightLeft, Share2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AdminLayout from '../../../layout/AdminLayout';
import recordsFetch from '../../../../utils/recordsFetch';
import PatientAuditModal from './PatientAuditModal';
import { useAdminNav } from '../../../../hooks/useAdminNav';
import { useAuth } from '../../../../hooks/useAuth';
import { useMasterView } from '../../../../context/MasterViewContext';

interface Patient {
  id: number;
  seq?: number;
  first_name: string;
  last_name: string;
  rut: string;
  email: string;
  phone: string;
  active_record_id?: number;
  created_by_user_name?: string;
  created_by_username?: string;
}

interface ClinicUser {
  id: number;
  username: string;
  full_name: string;
  role: string;
  access_scope: string;
}

interface AssignModalState {
  patient: Patient;
  mode: 'assign' | 'transfer'; // copy vs change owner
}

export default function PatientList() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const navigate = useNavigate();
  const { nav } = useAdminNav();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { isActive: isMasterView, targetUserId } = useMasterView();
  // clinicId pasado desde el master admin para filtrar por clínica
  const clinicId = searchParams.get('clinicId');
  // Modal de historial de auditoría
  const [auditModal, setAuditModal] = useState<{ patientId: number; patientName: string } | null>(null);
  // Modal de asignación/traslado
  const [assignModal, setAssignModal] = useState<AssignModalState | null>(null);
  const [clinicUsers, setClinicUsers] = useState<ClinicUser[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);
  // Filtro por profesional (solo vista clínica de admin)
  const [filterUserId, setFilterUserId] = useState<number | ''>('');

  const isAdmin = user?.role === 'clinic_admin' || user?.role === 'master_admin';

  useEffect(() => {
    fetchPatients();
  }, [clinicId, filterUserId]);

  // Cargar usuarios de la clínica para el filtro y el modal de asignación
  useEffect(() => {
    if (isAdmin) {
      recordsFetch('/api/records?action=listClinicUsers')
        .then(r => r.json())
        .then(data => Array.isArray(data) ? setClinicUsers(data) : null)
        .catch(() => null);
    }
  }, [isAdmin]);

  // Cargar usuarios de la clínica cuando se abre el modal
  useEffect(() => {
    if (assignModal && clinicUsers.length === 0) {
      recordsFetch('/api/records?action=listClinicUsers')
        .then(r => r.json())
        .then(data => Array.isArray(data) ? setClinicUsers(data) : null)
        .catch(() => null);
    }
  }, [assignModal]);

  const fetchPatients = async () => {
    try {
      setError(null);
      // viewAsUserId: impersonar al usuario del MasterView (ver exactamente lo que él ve)
      // filterByUserId: filtrar vista clínica por profesional
      let url = clinicId
        ? `/api/records?action=listPatients&clinicId=${clinicId}`
        : '/api/records?action=listPatients';
      if (isMasterView && targetUserId) url += `&viewAsUserId=${targetUserId}`;
      else if (filterUserId) url += `&filterByUserId=${filterUserId}`;
      const response = await recordsFetch(url);
      
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") === -1) {
        throw new Error("La respuesta de la API no es JSON. Si estás en local, usa 'vercel dev'.");
      }

      if (response.ok) {
        const data = await response.json();
        setPatients(data);
      } else {
        const errText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errText}`);
      }
    } catch (error: any) {
      console.error('Error fetching patients:', error);
      setError(error.message || 'Error desconocido al cargar pacientes');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('¿Está seguro de eliminar este paciente? Esta acción no se puede deshacer.')) return;

    try {
      const response = await recordsFetch(`/api/records?action=deletePatient&id=${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        setPatients(prev => prev.filter(p => p.id !== id));
      } else {
        alert('Error al eliminar el paciente');
      }
    } catch (error) {
      console.error('Error deleting patient:', error);
      alert('Error al eliminar el paciente');
    }
  };

  const handleAssign = async (targetUserId: number) => {
    if (!assignModal) return;
    setAssignLoading(true);
    try {
      const action = assignModal.mode === 'transfer' ? 'transferPatient' : 'assignPatient';
      const res = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: assignModal.patient.id, target_user_id: targetUserId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al procesar');
      setAssignModal(null);
      alert(assignModal.mode === 'transfer' ? 'Paciente trasladado exitosamente' : 'Paciente asignado exitosamente');
      // Si fue traslado, refrescar lista (el paciente puede desaparecer de la vista)
      if (assignModal.mode === 'transfer') fetchPatients();
    } catch (err: any) {
      alert(err.message || 'Error al asignar paciente');
    } finally {
      setAssignLoading(false);
    }
  };

  const filteredPatients = patients.filter(p => 
    `${p.first_name} ${p.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.rut?.includes(searchTerm)
  );

  return (
    <AdminLayout title="Fichas Clínicas" subtitle="Gestión de pacientes y expedientes médicos" backPath="/admin">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl shadow-sm">
          <h2 className="text-xl font-bold text-gray-800">Pacientes Registrados</h2>
          <div className="flex items-center gap-3">
            {/* Filtro por profesional — solo para admins en vista clínica (no en impersonación MasterView) */}
            {isAdmin && !isMasterView && clinicUsers.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">Profesional:</span>
                <select
                  value={filterUserId}
                  onChange={e => setFilterUserId(e.target.value ? Number(e.target.value) : '')}
                  className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-[#deb887]/40 focus:border-[#deb887] focus:outline-none"
                >
                  <option value="">Todos</option>
                  {clinicUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              onClick={() => nav('clinical-records/new')}
              className="bg-[#deb887] text-white px-4 py-2 rounded-lg hover:bg-[#c5a075] transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Nuevo Paciente
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            placeholder="Buscar por nombre o RUT..."
            className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none shadow-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl">
            <p className="font-bold">Error cargando pacientes:</p>
            <p>{error}</p>
          </div>
        )}

        {/* Patients Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-6 py-4 font-semibold text-gray-600">Paciente</th>
                  <th className="px-6 py-4 font-semibold text-gray-600">Identificación</th>
                  <th className="px-6 py-4 font-semibold text-gray-600">Contacto</th>
                  <th className="px-6 py-4 font-semibold text-gray-600">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                      <div className="flex justify-center items-center gap-2">
                        <div className="animate-spin w-5 h-5 border-2 border-[#deb887] border-t-transparent rounded-full"></div>
                        Cargando pacientes...
                      </div>
                    </td>
                  </tr>
                ) : filteredPatients.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-gray-500">
                      No se encontraron pacientes
                    </td>
                  </tr>
                ) : (
                  filteredPatients.map((patient) => (
                    <tr key={patient.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => nav(`ficha-clinica/paciente/${patient.id}`)}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-[#deb887]/10 flex items-center justify-center text-[#deb887]">
                            <User className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-medium text-gray-900">{patient.first_name} {patient.last_name}</div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-gray-400">#{patient.seq ?? patient.id}</span>
                              {isAdmin && patient.created_by_user_name && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-xs font-medium">
                                  <User className="w-2.5 h-2.5" />
                                  {patient.created_by_user_name}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-gray-600">{patient.rut || '-'}</td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-600">{patient.email}</div>
                        <div className="text-sm text-gray-500">{patient.phone}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={(e) => { e.stopPropagation(); nav(`clinical-records/edit/${patient.id}`); }}
                            className="p-2 text-gray-500 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-lg transition-colors"
                            title="Editar"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => handleDelete(patient.id, e)}
                            className="p-2 text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                            title="Eliminar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setAuditModal({ patientId: patient.id, patientName: `${patient.first_name} ${patient.last_name}` }); }}
                            className="p-2 text-gray-500 hover:text-[#deb887] hover:bg-[#deb887]/10 rounded-lg transition-colors"
                            title="Historial de cambios"
                          >
                            <Clock className="w-4 h-4" />
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                onClick={e => { e.stopPropagation(); setAssignModal({ patient, mode: 'assign' }); }}
                                className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                title="Copiar acceso a otro usuario"
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); setAssignModal({ patient, mode: 'transfer' }); }}
                                className="p-2 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors"
                                title="Trasladar a otro usuario"
                              >
                                <ArrowRightLeft className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          <button 
                            onClick={(e) => { e.stopPropagation(); nav(`ficha-clinica/paciente/${patient.id}`); }}
                            className="text-[#deb887] hover:text-[#c5a075] font-medium flex items-center gap-1 ml-2"
                          >
                            <FileText className="w-4 h-4" />
                            Ver Ficha
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal de historial de auditoría */}
      {auditModal && (
        <PatientAuditModal
          patientId={auditModal.patientId}
          patientName={auditModal.patientName}
          onClose={() => setAuditModal(null)}
        />
      )}

      {/* Modal de asignación / traslado */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b">
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {assignModal.mode === 'transfer' ? 'Trasladar paciente' : 'Copiar acceso a paciente'}
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {assignModal.patient.first_name} {assignModal.patient.last_name}
                </p>
              </div>
              <button onClick={() => setAssignModal(null)} className="p-2 hover:bg-gray-100 rounded-lg">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-600 mb-4">
                {assignModal.mode === 'transfer'
                  ? 'El paciente pasará a ser propiedad del usuario seleccionado. Ya no aparecerá en tu lista.'
                  : 'El usuario seleccionado podrá ver y editar este paciente. El propietario original no cambia.'}
              </p>
              {clinicUsers.length === 0 ? (
                <div className="text-center text-gray-500 py-4">Cargando usuarios...</div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {clinicUsers.map(u => (
                    <button
                      key={u.id}
                      onClick={() => handleAssign(u.id)}
                      disabled={assignLoading}
                      className="w-full flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-[#deb887] hover:bg-[#deb887]/5 transition-colors text-left disabled:opacity-50"
                    >
                      <div className="w-9 h-9 rounded-full bg-[#deb887]/10 flex items-center justify-center">
                        <User className="w-4 h-4 text-[#deb887]" />
                      </div>
                      <div>
                        <div className="font-medium text-gray-900 text-sm">{u.full_name || u.username}</div>
                        <div className="text-xs text-gray-500">{u.role === 'clinic_admin' ? 'Admin' : 'Usuario'} · {u.access_scope === 'all' ? 'Todos los pacientes' : 'Solo propios'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
