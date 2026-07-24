/**
 * @file src/pages/MasterClinicWrapper.tsx
 * @description Wrapper para las páginas de módulos cuando el master_admin
 * está navegando en el contexto de una clínica/usuario específico.
 *
 * URL: /admin/master/:clinicSlug/:username/:module/*
 *
 * - Muestra un banner "Viendo como: clinica / usuario"
 * - Inicializa MasterViewContext con los datos de la clínica
 * - Renderiza el módulo correspondiente
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate, Outlet } from 'react-router-dom';
import { ArrowLeft, Eye, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useMasterView } from '../context/MasterViewContext';
import AdminDashboard from './AdminDashboard';

interface ClinicUserInfo {
  id: number;
  username: string;
  full_name: string;
  clinic_id: number;
  clinic_name: string;
  clinic_slug: string;
  role: string;
  features: string[];
}

const authFetch = (url: string) =>
  fetch(url, { headers: { Authorization: `Bearer ${sessionStorage.getItem('adminSessionToken') || ''}` } });

export default function MasterClinicWrapper() {
  const { clinicSlug, username } = useParams<{ clinicSlug: string; username: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { enterClinicView, exitClinicView, isActive } = useMasterView();

  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [info, setInfo]      = useState<ClinicUserInfo | null>(null);

  // Solo master_admin puede acceder a estas rutas
  useEffect(() => {
    if (user && user.role !== 'master_admin') {
      navigate('/admin/login', { replace: true });
    }
  }, [user]);

  // Cargar datos de la clínica/usuario
  useEffect(() => {
    if (!clinicSlug || !username) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1. Buscar la clínica por slug
        const clinicRes = await authFetch(`/api/admin-auth?action=listClinics`);
        if (!clinicRes.ok) throw new Error('No se pudo cargar la lista de clínicas');
        const clinicList = await clinicRes.json();
        // listClinics devuelve array directo
        const clinics = Array.isArray(clinicList) ? clinicList : (clinicList.clinics || []);
        const clinic = clinics.find((c: any) => c.slug === clinicSlug);
        if (!clinic) throw new Error(`Clínica "${clinicSlug}" no encontrada`);

        // 2. Buscar usuario por username dentro de la clínica
        const usersRes = await authFetch(`/api/admin-auth?action=listUsers&clinicId=${clinic.id}`);
        if (!usersRes.ok) throw new Error('No se pudo cargar usuarios de la clínica');
        const users = await usersRes.json();
        const userList = Array.isArray(users) ? users : (users.users || []);
        const targetUser = userList.find((u: any) => u.username === username);
        if (!targetUser) throw new Error(`Usuario "${username}" no encontrado en ${clinic.name}`);

        // 3. Cargar features de la clínica
        const featRes = await authFetch(`/api/admin-auth?action=getFeatures&clinicId=${clinic.id}`);
        const featData = featRes.ok ? await featRes.json() : { features: [] };
        const features: string[] = featData.features || [];

        const result: ClinicUserInfo = {
          id: targetUser.id,
          username: targetUser.username,
          full_name: targetUser.full_name,
          clinic_id: clinic.id,
          clinic_name: clinic.name,
          clinic_slug: clinic.slug,
          role: targetUser.role,
          features,
        };

        setInfo(result);
        enterClinicView(clinic.id, clinic.slug, clinic.name, targetUser.username, targetUser.id, features);
      } catch (e: any) {
        setError(e.message || 'Error cargando contexto de clínica');
      } finally {
        setLoading(false);
      }
    };

    load();

    return () => { exitClinicView(); };
  }, [clinicSlug, username]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-[#deb887] mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Cargando contexto de clínica...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-8 max-w-md text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
          <h2 className="font-bold text-gray-800 mb-2">Error de contexto</h2>
          <p className="text-sm text-gray-500 mb-6">{error}</p>
          <button
            onClick={() => navigate('/admin/master')}
            className="px-6 py-2 bg-[#deb887] text-white rounded-xl font-medium hover:bg-[#d4a76a] transition-colors"
          >
            Volver al panel master
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Banner de contexto master */}
      {info && (
        <div className="bg-gradient-to-r from-purple-600 to-purple-800 text-white px-4 py-2 flex items-center justify-between text-sm sticky top-0 z-50 shadow-md">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/admin/master')}
              className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
              title="Volver al panel master"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <Eye className="w-4 h-4 opacity-70" />
            <span className="opacity-80">Vista master como:</span>
            <span className="font-semibold">{info.clinic_name}</span>
            <span className="opacity-60">/</span>
            <span className="font-semibold">{info.full_name || info.username}</span>
            <span className="text-xs opacity-60 bg-white/20 px-2 py-0.5 rounded-full">{info.role}</span>
          </div>
          <button
            onClick={() => navigate('/admin/master')}
            className="text-xs opacity-70 hover:opacity-100 transition-opacity underline"
          >
            Salir de la vista
          </button>
        </div>
      )}
      {/* El Outlet renderiza el módulo específico (o el dashboard si no hay módulo) */}
      <Outlet />
    </div>
  );
}
