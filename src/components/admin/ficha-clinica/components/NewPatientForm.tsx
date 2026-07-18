import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, ArrowLeft, AlertCircle } from 'lucide-react';
import AdminLayout from '../../../layout/AdminLayout';

export default function NewPatientForm() {
  const navigate = useNavigate();
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
      const token = localStorage.getItem('adminSessionToken') || '';

      const response = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const result = await response.json();
        navigate(`/admin/ficha-clinica/paciente/${result.id}`);
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
