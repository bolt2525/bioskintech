import React, { useState, useEffect } from 'react';
import recordsFetch from "../../../../utils/recordsFetch";
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft, AlertCircle, Users, X } from 'lucide-react';
import AdminLayout from '../../../layout/AdminLayout';
import { useAdminNav } from '../../../../hooks/useAdminNav';

interface DuplicatePatient { id: number; first_name: string; last_name: string; rut: string; sameUser?: boolean; }

export default function NewPatientForm() {
  const navigate = useNavigate();
  const { nav } = useAdminNav();
  const { patientId } = useParams();
  const isEditing = Boolean(patientId);

  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    rut: '',
    email: '',
    phone: '',
    birth_date: '',
    gender: '',
    address: '',
    occupation: ''
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicatePatient | null>(null);
  const [importFields, setImportFields] = useState({ basic: true, history: true });
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (isEditing && patientId) {
      loadPatient();
    }
  }, [patientId]);

  const loadPatient = async () => {
    setLoading(true);
    try {
      const res = await recordsFetch(`/api/records?action=getPatient&id=${patientId}`);
      if (res.ok) {
        const data = await res.json();
        // Format date for input
        const formattedDate = data.birth_date ? new Date(data.birth_date).toISOString().split('T')[0] : '';
        setFormData({
          first_name: data.first_name || '',
          last_name: data.last_name || '',
          rut: data.rut || '',
          email: data.email || '',
          phone: data.phone || '',
          birth_date: formattedDate,
          gender: data.gender || '',
          address: data.address || '',
          occupation: data.occupation || ''
        });
      } else {
        throw new Error('Error cargando datos del paciente');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const action = isEditing ? 'updatePatient' : 'createPatient';
      const body = isEditing ? { id: patientId, ...formData } : formData;
      const token = sessionStorage.getItem('adminSessionToken') || '';

      const response = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const result = await response.json();
        nav(`ficha-clinica/paciente/${result.id}`);
      } else if (response.status === 409) {
        const data = await response.json();
        if (data.conflict === 'same_user' || data.conflict === 'same_clinic') {
          setDuplicate({ ...data.patient, sameUser: data.conflict === 'same_user' });
          return;
        }
        throw new Error(data.error || 'Conflicto al crear paciente');
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Error desconocido del servidor' }));
        throw new Error(errorData.error || `Error al ${isEditing ? 'actualizar' : 'crear'} paciente`);
      }
    } catch (err: any) {
      console.error('Error saving patient:', err);
      setError(err.message || 'No se pudo guardar el paciente. Verifique los datos.');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!duplicate) return;
    setImporting(true);
    try {
      const fields = [
        importFields.basic && 'basic',
        importFields.history && 'history',
      ].filter(Boolean);
      const token = sessionStorage.getItem('adminSessionToken') || '';
      const res = await recordsFetch('/api/records?action=importPatientSnapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source_patient_id: duplicate.id, import_fields: fields }),
      });
      if (res.ok) {
        const data = await res.json();
        nav(`ficha-clinica/paciente/${data.patient.id}`);
      } else {
        const err = await res.json();
        setError(err.error || 'Error al importar');
        setDuplicate(null);
      }
    } finally { setImporting(false); }
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

  return (
    <AdminLayout 
      title={isEditing ? "Editar Paciente" : "Nuevo Paciente"} 
      subtitle={isEditing ? "Modificar datos del paciente" : "Registro de nuevo paciente en el sistema"}
    >
      <div className="max-w-3xl mx-auto space-y-6">
        <form onSubmit={handleSubmit} className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 text-red-700 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          {/* Modal de paciente duplicado en la misma clínica */}
          {duplicate && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
                <div className="h-1 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
                <div className="px-5 py-4 border-b flex justify-between items-center">
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2 text-sm">
                    <Users className="w-4 h-4 text-[#deb887]" />
                    {duplicate.sameUser ? 'Paciente ya registrado por ti' : 'Paciente existente en tu clínica'}
                  </h3>
                  <button onClick={() => setDuplicate(null)} className="text-gray-300 hover:text-gray-500">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-5 space-y-4">
                  <p className="text-sm text-gray-600">
                    {duplicate.sameUser
                      ? 'Este paciente ya existe en tu expediente:'
                      : 'Este paciente ya fue registrado por otro profesional de tu clínica:'}
                  </p>
                  <div className="bg-[#deb887]/10 border border-[#deb887]/20 rounded-xl p-3">
                    <p className="font-semibold text-gray-900">{duplicate.first_name} {duplicate.last_name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Cédula / RUC / RUT: {duplicate.rut}</p>
                  </div>
                  {duplicate.sameUser ? (
                    <div className="flex gap-2 pt-2">
                      <button onClick={() => nav(`ficha-clinica/paciente/${duplicate.id}`)}
                        className="flex-1 py-2.5 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] transition-colors">
                        Ir al expediente existente
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-500">Selecciona qué datos importar para crear tu expediente:</p>
                      <div className="space-y-2">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input type="checkbox" checked={importFields.basic} onChange={e => setImportFields(p => ({ ...p, basic: e.target.checked }))}
                            className="w-4 h-4 accent-[#deb887]" />
                          <span className="text-sm text-gray-700">Importar datos básicos del paciente</span>
                        </label>
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input type="checkbox" checked={importFields.history} onChange={e => setImportFields(p => ({ ...p, history: e.target.checked }))}
                            className="w-4 h-4 accent-[#deb887]" />
                          <span className="text-sm text-gray-700">Importar antecedentes médicos</span>
                        </label>
                      </div>
                      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                        Debes importar el paciente para poder acceder a su expediente desde tu cuenta.
                      </p>
                      <div className="flex gap-2 pt-2">
                        <button onClick={handleImport} disabled={importing || (!importFields.basic && !importFields.history)}
                          className="flex-1 py-2.5 bg-[#deb887] text-white rounded-xl text-sm font-semibold hover:bg-[#c9a876] disabled:opacity-50 transition-colors">
                          {importing ? 'Importando...' : 'Importar y abrir expediente'}
                        </button>
                        <button onClick={() => setDuplicate(null)}
                          className="py-2.5 px-4 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">
                          Cancelar
                        </button>
                      </div>
                    </>
                  )}
                  <button onClick={() => setDuplicate(null)} className="w-full text-xs text-gray-400 hover:text-gray-600 transition-colors py-1">
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Nombres *</label>
              <input
                type="text"
                name="first_name"
                required
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.first_name}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Apellidos *</label>
              <input
                type="text"
                name="last_name"
                required
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.last_name}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Identificación / Cédula / RUC</label>
              <input
                type="text"
                name="rut"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.rut}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Fecha de Nacimiento</label>
              <input
                type="date"
                name="birth_date"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.birth_date}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Email</label>
              <input
                type="email"
                name="email"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.email}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Teléfono</label>
              <input
                type="tel"
                name="phone"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.phone}
                onChange={handleChange}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Género</label>
              <select
                name="gender"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.gender}
                onChange={handleChange}
              >
                <option value="">Seleccionar...</option>
                <option value="Femenino">Femenino</option>
                <option value="Masculino">Masculino</option>
                <option value="Otro">Otro</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Ocupación</label>
              <input
                type="text"
                name="occupation"
                className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
                value={formData.occupation}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Dirección</label>
            <input
              type="text"
              name="address"
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none"
              value={formData.address}
              onChange={handleChange}
            />
          </div>

          <div className="flex justify-end pt-6">
            <button
              type="submit"
              disabled={saving}
              className="bg-[#deb887] text-white px-8 py-3 rounded-lg hover:bg-[#c5a075] transition-colors flex items-center gap-2 font-medium disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {saving ? 'Guardando...' : (isEditing ? 'Actualizar Paciente' : 'Crear Paciente')}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
}
