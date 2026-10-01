import React, { useState, useEffect } from 'react';
import { Search, Plus, FileText, User, Users, Edit2, Trash2, Clock, X, ArrowRightLeft, Share2, Eye, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import AdminLayout from '../../../layout/AdminLayout';
import recordsFetch from '../../../../utils/recordsFetch';
import PatientAuditModal from './PatientAuditModal';
import { useAdminNav } from '../../../../hooks/useAdminNav';
import { useAuth } from '../../../../hooks/useAuth';
import { useMasterView } from '../../../../context/MasterViewContext';
import { Dialog } from '../../../ui/Dialog';

/** Formats a stable per-clinic patient code: {INITIALS}-{YEAR}-{SEQ:03} */
function clinicCode(clinicName: string, seq: number, createdAt?: string): string {
  const words = (clinicName || 'CL').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const initials = words.length === 1 ? words[0].substring(0, 2) : words.slice(0, 3).map(w => w[0]).join('');
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
  return `${initials}-${year}-${String(seq).padStart(3, '0')}`;
}

interface Patient {
  id: number;
  seq?: number;
  created_at?: string;
  first_name: string;
  last_name: string;
  identification_type: string;
  identification_number: string;
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
  const { hasFeature } = useAuth();

  // Modal "Ver Paciente"
  const [patientModal, setPatientModal] = useState<{ id: number; full: any | null; record: any | null; loading: boolean } | null>(null);

  const openPatientModal = async (patientId: number) => {
    setPatientModal({ id: patientId, full: null, record: null, loading: true });
    try {
      const pRes = await recordsFetch(`/api/records?action=getPatient&id=${patientId}`);
      const full = pRes.ok ? await pRes.json() : null;
      let record = null;
      // full.active_record_id is returned by getPatient (joins clinical_records)
      if (hasFeature('treatment_notes_view') && full?.active_record_id) {
        const rrRes = await recordsFetch(`/api/records?action=getRecordData&recordId=${full.active_record_id}`);
        if (rrRes.ok) record = await rrRes.json();
      }
      setPatientModal({ id: patientId, full, record, loading: false });
    } catch {
      setPatientModal(prev => prev ? { ...prev, loading: false } : null);
    }
  };

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
    p.identification_number?.includes(searchTerm)
  );

  return (
    <AdminLayout title="Fichas Clínicas" subtitle="Gestión de pacientes y expedientes médicos" backPath="/admin">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-lg border border-emerald-950/10 bg-[#172522] p-5 text-white shadow-sm sm:p-6">
          <div className="absolute inset-y-0 right-0 w-1/3 bg-[radial-gradient(circle_at_center,rgba(222,184,135,0.16),transparent_68%)]" aria-hidden="true" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-emerald-100/70">
                <ShieldCheck className="h-4 w-4 text-[#deb887]" />
                Centro clínico
              </div>
              <h2 className="font-serif text-2xl font-semibold sm:text-3xl">Pacientes y expedientes</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-emerald-50/70">
                Busca pacientes, abre expedientes y consulta su trazabilidad clínica.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-h-11 items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4">
                <Users className="h-4 w-4 text-[#deb887]" />
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-emerald-100/60">Pacientes visibles</p>
                  <p className="text-lg font-semibold leading-5">{patients.length}</p>
                </div>
              </div>
              <button
                onClick={() => nav('clinical-records/new')}
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg bg-[#deb887] px-4 py-2 font-semibold text-[#172522] transition-colors hover:bg-[#e8cda9]"
              >
                <Plus className="h-4 w-4" />
                Nuevo paciente
              </button>
            </div>
          </div>
        </section>

        <div className="admin-surface flex flex-col gap-4 p-4 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">Buscar paciente</span>
            <span className="relative block">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                placeholder="Nombre, cédula o RUC"
                autoComplete="off"
                className="admin-focus-ring min-h-11 w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-10 pr-4 outline-none"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </span>
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            {/* Filtro por profesional — solo para admins en vista clínica (no en impersonación MasterView) */}
            {isAdmin && !isMasterView && clinicUsers.length > 0 && (
              <label>
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">Profesional</span>
                <select
                  value={filterUserId}
                  onChange={e => setFilterUserId(e.target.value ? Number(e.target.value) : '')}
                  className="admin-focus-ring min-h-11 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none sm:w-auto"
                >
                  <option value="">Todos</option>
                  {clinicUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">
            <p className="font-bold">Error cargando pacientes:</p>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div className="grid gap-3 md:hidden">
            {filteredPatients.length === 0 ? (
              <div className="admin-surface px-5 py-10 text-center text-sm text-gray-500">No se encontraron pacientes</div>
            ) : filteredPatients.map((patient) => (
              <article key={patient.id} className="admin-surface overflow-hidden p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-emerald-950/5 text-emerald-900">
                    <User className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold text-gray-900">{patient.first_name} {patient.last_name}</h3>
                    <p className="mt-0.5 text-xs text-gray-500">{patient.seq ? clinicCode(user?.clinic_name || '', patient.seq, patient.created_at) : `#${patient.id}`}</p>
                    {isAdmin && patient.created_by_user_name && <p className="mt-1 truncate text-xs text-gray-500">Profesional: {patient.created_by_user_name}</p>}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-gray-50 p-3 text-xs">
                  <div><span className="block text-gray-400">Identificación</span><span className="font-medium text-gray-700">{patient.identification_number || 'Pendiente'}</span></div>
                  <div><span className="block text-gray-400">Teléfono</span><span className="font-medium text-gray-700">{patient.phone || 'No registrado'}</span></div>
                </div>
                <button onClick={() => nav(`ficha-clinica/paciente/${patient.id}`)} className="admin-focus-ring mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#172522] px-4 text-sm font-semibold text-white hover:bg-[#21332f]">
                  <FileText className="h-4 w-4" /> Abrir expediente
                </button>
                <div className="mt-2 grid grid-cols-4 gap-1 border-t border-gray-100 pt-2">
                  <button onClick={() => openPatientModal(patient.id)} className="admin-focus-ring flex min-h-11 items-center justify-center rounded-lg text-gray-500 hover:bg-teal-50 hover:text-teal-700" aria-label={`Vista rápida de ${patient.first_name}`}><Eye className="h-4 w-4" /></button>
                  <button onClick={() => nav(`clinical-records/edit/${patient.id}`)} className="admin-focus-ring flex min-h-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100" aria-label={`Editar a ${patient.first_name}`}><Edit2 className="h-4 w-4" /></button>
                  <button onClick={() => setAuditModal({ patientId: patient.id, patientName: `${patient.first_name} ${patient.last_name}` })} className="admin-focus-ring flex min-h-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100" aria-label={`Historial de ${patient.first_name}`}><Clock className="h-4 w-4" /></button>
                  <details className="group relative">
                    <summary className="admin-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100" aria-label={`Más acciones para ${patient.first_name}`}><span className="text-lg leading-none">•••</span></summary>
                    <div className="absolute bottom-12 right-0 z-20 w-56 rounded-lg border border-gray-200 bg-white p-1.5 shadow-xl">
                      {isAdmin && <button onClick={() => setAssignModal({ patient, mode: 'assign' })} className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-gray-50"><Share2 className="h-4 w-4" /> Copiar acceso</button>}
                      {isAdmin && <button onClick={() => setAssignModal({ patient, mode: 'transfer' })} className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-gray-50"><ArrowRightLeft className="h-4 w-4" /> Trasladar</button>}
                      <button onClick={(event) => handleDelete(patient.id, event)} className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /> Eliminar</button>
                    </div>
                  </details>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* Patients Table */}
        <div className="admin-surface hidden overflow-hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">Pacientes registrados y acciones disponibles</caption>
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
                    <tr key={patient.id} className="transition-colors hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-[#deb887]/10 flex items-center justify-center text-[#deb887]">
                            <User className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-medium text-gray-900">{patient.first_name} {patient.last_name}</div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-gray-400">{patient.seq ? clinicCode(user?.clinic_name || '', patient.seq, patient.created_at) : `#${patient.id}`}</span>
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
                      <td className="px-6 py-4 text-gray-600">{patient.identification_number ? `${patient.identification_type === 'ruc' ? 'RUC' : patient.identification_type === 'cedula' ? 'Cédula' : 'ID pendiente'} · ${patient.identification_number}` : '-'}</td>
                      <td className="px-6 py-4">
                        <div className="text-sm text-gray-600">{patient.email}</div>
                        <div className="text-sm text-gray-500">{patient.phone}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={(e) => { e.stopPropagation(); nav(`clinical-records/edit/${patient.id}`); }}
                            className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                            title="Editar"
                            aria-label={`Editar a ${patient.first_name}`}
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => handleDelete(patient.id, e)}
                            className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-red-50 hover:text-red-500"
                            title="Eliminar"
                            aria-label={`Eliminar a ${patient.first_name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setAuditModal({ patientId: patient.id, patientName: `${patient.first_name} ${patient.last_name}` }); }}
                            className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                            title="Historial de cambios"
                            aria-label={`Historial de cambios de ${patient.first_name}`}
                          >
                            <Clock className="w-4 h-4" />
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                onClick={e => { e.stopPropagation(); setAssignModal({ patient, mode: 'assign' }); }}
                                className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600"
                                title="Copiar acceso a otro usuario"
                                aria-label={`Copiar acceso a ${patient.first_name}`}
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); setAssignModal({ patient, mode: 'transfer' }); }}
                                className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-purple-50 hover:text-purple-600"
                                title="Trasladar a otro usuario"
                                aria-label={`Trasladar a ${patient.first_name}`}
                              >
                                <ArrowRightLeft className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          <button 
                            onClick={(e) => { e.stopPropagation(); openPatientModal(patient.id); }}
                            className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-teal-50 hover:text-teal-600"
                            title="Ver datos del paciente"
                            aria-label={`Vista rápida de ${patient.first_name}`}
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); nav(`ficha-clinica/paciente/${patient.id}`); }}
                            className="admin-focus-ring ml-2 flex min-h-11 items-center gap-1 rounded-lg px-3 font-medium text-emerald-900 hover:bg-emerald-950/5"
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

      {/* Modal Ver Paciente */}
      {patientModal && (
        <Dialog open onClose={() => setPatientModal(null)} labelledBy="patient-preview-title">
          <div className="flex max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#deb887]/20 flex items-center justify-center">
                  <User className="w-5 h-5 text-[#deb887]" />
                </div>
                <div>
                  <h3 id="patient-preview-title" className="font-bold text-gray-900 text-base">
                    {patientModal.full ? `${patientModal.full.first_name} ${patientModal.full.last_name}` : 'Cargando...'}
                  </h3>
                  <p className="text-xs text-gray-400">Datos del paciente</p>
                </div>
              </div>
              <button onClick={() => setPatientModal(null)} className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Cerrar vista rápida">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 p-5 space-y-5">
              {patientModal.loading ? (
                <div className="flex justify-center py-10">
                  <div className="w-8 h-8 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : patientModal.full ? (
                <>
                  {/* Información del paciente */}
                  <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Información personal</h4>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                      {[
                        ['Nombre completo', `${patientModal.full.first_name} ${patientModal.full.last_name}`],
                        [patientModal.full.identification_type === 'ruc' ? 'RUC' : patientModal.full.identification_type === 'cedula' ? 'Cédula' : 'Identificación', patientModal.full.identification_number || '—'],
                        ['Correo', patientModal.full.email || '—'],
                        ['Teléfono', patientModal.full.phone || '—'],
                        ['Fecha de nacimiento', patientModal.full.birth_date ? new Date(patientModal.full.birth_date).toLocaleDateString('es-EC') : '—'],
                        ['Género', patientModal.full.gender || '—'],
                        ['Tipo de sangre', patientModal.full.tipo_sangre || '—'],
                        ['Estado civil', patientModal.full.estado_civil || '—'],
                        ['Ocupación', patientModal.full.occupation || '—'],
                        ['Dirección', patientModal.full.address || '—'],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span className="text-gray-400 text-xs">{label}</span>
                          <p className="text-gray-800 font-medium truncate">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Notas de tratamiento (solo si feature activa) */}
                  {hasFeature('treatment_notes_view') && (
                    <div className="border border-teal-100 rounded-xl overflow-hidden">
                      <div className="bg-teal-50 px-4 py-2.5 flex items-center gap-2">
                        <Eye className="w-4 h-4 text-teal-600" />
                        <span className="text-xs font-semibold text-teal-700 uppercase tracking-wider">Notas de tratamiento</span>
                      </div>
                      {!patientModal.record ? (
                        <p className="text-xs text-gray-400 px-4 py-3">Sin expediente disponible</p>
                      ) : (() => {
                        const treatments = (patientModal.record.treatments || []) as any[];
                        const consultations = (patientModal.record.consultations || []) as any[];
                        const withNotes = treatments.filter(t => t.notes?.trim());
                        if (!withNotes.length) return <p className="text-xs text-gray-400 px-4 py-3">Sin notas de tratamiento registradas</p>;
                        return (
                          <div className="divide-y divide-gray-50 max-h-56 overflow-y-auto">
                            {consultations
                              .slice().sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                              .map((consult: any) => {
                                const ts = withNotes.filter(t => Number(t.consultation_id) === Number(consult.id));
                                if (!ts.length) return null;
                                return (
                                  <div key={consult.id}>
                                    <div className="bg-gray-50 px-4 py-1.5">
                                      <span className="text-xs text-gray-500 font-medium">
                                        {new Date(consult.created_at?.split('T')[0]+'T12:00:00').toLocaleDateString('es-EC', { year:'numeric', month:'short', day:'numeric' })}
                                        {consult.reason ? ` — ${consult.reason}` : ''}
                                      </span>
                                    </div>
                                    {ts.map((t: any, i: number) => (
                                      <div key={t.id ?? i} className="px-4 py-2">
                                        <p className="text-xs font-semibold text-gray-600">{t.procedure_name}</p>
                                        <p className="text-xs text-gray-700 mt-0.5 whitespace-pre-wrap">{t.notes}</p>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-400 text-center py-6">No se pudo cargar la información</p>
              )}
            </div>

            <div className="p-4 border-t border-gray-100 flex justify-end">
              <button
                onClick={() => { setPatientModal(null); nav(`ficha-clinica/paciente/${patientModal.id}`); }}
                className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] text-sm font-medium transition-colors"
              >
                <FileText className="w-4 h-4" /> Ver Ficha Completa
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Modal de asignación / traslado */}
      {assignModal && (
        <Dialog open onClose={() => setAssignModal(null)} labelledBy="patient-assignment-title" describedBy="patient-assignment-description">
          <div className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between p-6 border-b">
              <div>
                <h3 id="patient-assignment-title" className="text-lg font-bold text-gray-900">
                  {assignModal.mode === 'transfer' ? 'Trasladar paciente' : 'Copiar acceso a paciente'}
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {assignModal.patient.first_name} {assignModal.patient.last_name}
                </p>
              </div>
              <button onClick={() => setAssignModal(null)} className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-gray-100" aria-label="Cerrar asignación">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <p id="patient-assignment-description" className="text-sm text-gray-600 mb-4">
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
        </Dialog>
      )}
    </AdminLayout>
  );
}
