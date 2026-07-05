import React, { useState, useEffect } from 'react';
import { Search, Plus, FileText, User, Calendar, Edit2, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../../../layout/AdminLayout';

interface Patient {
  id: number;
  first_name: string;
  last_name: string;
  rut: string;
  email: string;
  phone: string;
  active_record_id?: number;
}

export default function PatientList() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchPatients();
  }, []);

  const fetchPatients = async () => {
    try {
      setError(null);
      const response = await fetch('/api/records?action=listPatients');
      
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
      const response = await fetch(`/api/records?action=deletePatient&id=${id}`, {
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

  const filteredPatients = patients.filter(p => 
    `${p.first_name} ${p.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.rut?.includes(searchTerm)
  );

  return (
    <AdminLayout title="Fichas Clínicas" subtitle="Gestión de pacientes y expedientes médicos" backPath="/admin">
      <div className="space-y-6">
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl shadow-sm">
          <h2 className="text-xl font-bold text-gray-800">Pacientes Registrados</h2>
          <button 
            onClick={() => navigate('/admin/clinical-records/new')}
            className="bg-[#deb887] text-white px-4 py-2 rounded-lg hover:bg-[#c5a075] transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Nuevo Paciente
          </button>
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
                    <tr key={patient.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => navigate(`/admin/ficha-clinica/paciente/${patient.id}`)}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-[#deb887]/10 flex items-center justify-center text-[#deb887]">
                            <User className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-medium text-gray-900">{patient.first_name} {patient.last_name}</div>
                            <div className="text-sm text-gray-500">ID: {patient.id}</div>
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
                            onClick={(e) => { e.stopPropagation(); navigate(`/admin/clinical-records/edit/${patient.id}`); }}
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
                            onClick={(e) => { e.stopPropagation(); navigate(`/admin/ficha-clinica/paciente/${patient.id}`); }}
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
    </AdminLayout>
  );
}
