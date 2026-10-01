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
      <div className="mx-auto max-w-5xl py-2 sm:py-5">
        <div className="mb-6 max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">Organiza tu jornada</p>
          <h2 className="mt-1 text-2xl font-semibold text-white">Herramientas de agenda</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-300">Elige una acción para consultar citas, agendar pacientes o gestionar la disponibilidad.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleModules.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.feat}
                onClick={() => nav(item.path)}
                className="admin-focus-ring admin-interactive group admin-surface flex min-h-52 flex-col p-5 text-left hover:-translate-y-0.5 hover:border-gold/60 hover:shadow-lg"
              >
                <div className={`mb-4 flex h-11 w-11 items-center justify-center rounded-xl ${item.bgColor}`}>
                  <Icon className={`w-5 h-5 ${item.iconColor}`} />
                </div>
                <h3 className="mb-1 text-sm font-semibold leading-snug text-gray-900 transition-colors group-hover:text-gold-ink">
                  {item.title}
                </h3>
                <p className="flex-1 text-xs leading-relaxed text-gray-500">{item.description}</p>
                <div className="mt-4 flex items-center gap-1 text-xs font-semibold text-gold-ink">
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
