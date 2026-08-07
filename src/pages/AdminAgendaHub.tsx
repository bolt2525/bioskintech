import { Calendar, Clock, Ban, ChevronRight } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../hooks/useAuth';
import { useAdminNav } from '../hooks/useAdminNav';

const SUB_MODULES = [
  {
    feat: 'calendar',
    title: 'Gestión de Agenda',
    description: 'Visualiza y administra citas del calendario',
    icon: Calendar,
    path: 'calendar',
    iconColor: 'text-indigo-500',
    bgColor: 'bg-indigo-50',
  },
  {
    feat: 'appointment',
    title: 'Agendar Cita',
    description: 'Crea citas manualmente para un paciente',
    icon: Clock,
    path: 'appointment',
    iconColor: 'text-orange-500',
    bgColor: 'bg-orange-50',
  },
  {
    feat: 'block_schedule',
    title: 'Bloquear Horarios',
    description: 'Marca franjas horarias como no disponibles',
    icon: Ban,
    path: 'block-schedule',
    iconColor: 'text-red-500',
    bgColor: 'bg-red-50',
  },
] as const;

export default function AdminAgendaHub() {
  const { hasFeature } = useAuth();
  const { nav } = useAdminNav();

  const visibleModules = SUB_MODULES.filter(m => hasFeature(m.feat));

  return (
    <AdminLayout
      title="Agenda"
      subtitle="Selecciona una opción"
      showBack
      backPath="/admin"
    >
      <div className="max-w-3xl mx-auto p-4 md:p-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleModules.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.feat}
                onClick={() => nav(item.path)}
                className="group bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-indigo-200 hover:-translate-y-0.5 transition-all duration-200 text-left p-5 flex flex-col"
              >
                <div className={`w-11 h-11 rounded-xl ${item.bgColor} flex items-center justify-center mb-4`}>
                  <Icon className={`w-5 h-5 ${item.iconColor}`} />
                </div>
                <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 group-hover:text-indigo-600 transition-colors">
                  {item.title}
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed flex-1">{item.description}</p>
                <div className="flex items-center gap-1 mt-3 text-indigo-500 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  <span>Acceder</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </AdminLayout>
  );
}
