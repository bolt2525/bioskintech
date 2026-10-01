// src/components/AdminDashboard.tsx
// Panel principal de administración con múltiples opciones

import React, { useState, useEffect } from 'react';
import recordsFetch from '../utils/recordsFetch';
import { 
  Settings, 
  Users, 
  Calendar, 
  BarChart3, 
  Mail, 
  Image, 
  Database,
  Monitor,
  Shield,
  Clock,
  Bell,
  X,
  AlertCircle,
  CalendarDays,
  Ban
} from 'lucide-react';
import AdminAppointment from './AdminAppointment';
import AdminCalendar from './AdminCalendar';
import AdminBlockSchedule from './AdminBlockSchedule';
import CalendarManager from './CalendarManager';

interface AdminOption {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  available: boolean;
}

interface UpcomingAppointment {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  daysUntil: number;
  isToday: boolean;
  isTomorrow: boolean;
}

const AdminDashboard: React.FC = () => {
  const [activeSection, setActiveSection] = useState<string>('dashboard');
  const [showNotifications, setShowNotifications] = useState(false);
  const [upcomingAppointments, setUpcomingAppointments] = useState<UpcomingAppointment[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);

  // Función para obtener citas de los próximos 15 días
  const fetchUpcomingAppointments = async () => {
    setLoadingNotifications(true);
    try {
      console.log('🔔 Cargando notificaciones de citas próximas...');
      
      const appointments: UpcomingAppointment[] = [];
      const today = new Date();
      
      // Obtener eventos para los próximos 15 días
      for (let i = 0; i <= 15; i++) {
        const currentDate = new Date(today);
        currentDate.setDate(today.getDate() + i);
        const dateString = currentDate.toISOString().split('T')[0];
        
        try {
          const response = await recordsFetch('/api/calendar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              action: 'getEvents',
              date: dateString 
            }),
          });
          
          const data = await response.json();
          
          if (data.events && Array.isArray(data.events)) {
            data.events.forEach((event: UpcomingAppointment) => {
              appointments.push({
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                description: event.description,
                daysUntil: i,
                isToday: i === 0,
                isTomorrow: i === 1
              });
            });
          }
        } catch (err) {
          console.error(`Error fetching events for ${dateString}:`, err);
        }
      }
      
      // Ordenar por fecha/hora
      appointments.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      
      console.log(`✅ ${appointments.length} citas próximas encontradas`);
      setUpcomingAppointments(appointments);
      
    } catch (err) {
      console.error('Error cargando notificaciones:', err);
    } finally {
      setLoadingNotifications(false);
    }
  };

  // Cargar notificaciones al entrar al dashboard
  useEffect(() => {
    fetchUpcomingAppointments();
  }, []);

  // Cerrar notificaciones al hacer click fuera
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (showNotifications && !target.closest('.notifications-panel')) {
        setShowNotifications(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotifications]);

  // Función para formatear la fecha/hora de la cita
  const formatAppointmentDateTime = (dateString: string) => {
    const date = new Date(dateString);
    const time = date.toLocaleTimeString('es-ES', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
    const day = date.toLocaleDateString('es-ES', { 
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
    return { time, day };
  };

  // Obtener mensaje de urgencia para la cita
  const getUrgencyMessage = (appointment: UpcomingAppointment) => {
    if (appointment.isToday) {
      return { 
        text: 'HOY', 
        color: 'bg-red-500 text-white',
        priority: 1 
      };
    }
    if (appointment.isTomorrow) {
      return { 
        text: 'MAÑANA', 
        color: 'bg-orange-500 text-white',
        priority: 2 
      };
    }
    if (appointment.daysUntil <= 3) {
      return { 
        text: `${appointment.daysUntil} días`, 
        color: 'bg-yellow-500 text-white',
        priority: 3 
      };
    }
    if (appointment.daysUntil <= 7) {
      return { 
        text: `${appointment.daysUntil} días`, 
        color: 'bg-blue-500 text-white',
        priority: 4 
      };
    }
    return { 
      text: `${appointment.daysUntil} días`, 
      color: 'bg-gray-500 text-white',
      priority: 5 
    };
  };

  const adminOptions: AdminOption[] = [
    {
      id: 'analytics',
      title: 'Analíticas Detalladas',
      description: 'Estadísticas completas de visitas',
      icon: <BarChart3 className="w-6 h-6" />,
      color: 'bg-blue-500',
      available: true
    },
    {
      id: 'appointments',
      title: 'Gestión de Citas',
      description: 'Agendar nuevas citas y horarios',
      icon: <Calendar className="w-6 h-6" />,
      color: 'bg-green-500',
      available: true
    },
    {
      id: 'calendar',
      title: 'Visualizar Agenda',
      description: 'Ver citas programadas del calendario',
      icon: <Calendar className="w-6 h-6" />,
      color: 'bg-blue-500',
      available: true
    },
    {
      id: 'block-schedule',
      title: 'Bloquear Horarios',
      description: 'Reservar horarios para reuniones o mantenimiento',
      icon: <Ban className="w-6 h-6" />,
      color: 'bg-red-500',
      available: true
    },
    {
      id: 'calendar-manager',
      title: 'Gestión Completa del Calendario',
      description: 'Ver, gestionar y eliminar todos los eventos del calendario',
      icon: <CalendarDays className="w-6 h-6" />,
      color: 'bg-indigo-500',
      available: true
    },
    {
      id: 'users',
      title: 'Gestión de Usuarios',
      description: 'Administrar pacientes y personal',
      icon: <Users className="w-6 h-6" />,
      color: 'bg-purple-500',
      available: false
    },
    {
      id: 'analytics',
      title: 'Analíticas',
      description: 'Estadísticas y métricas del sitio',
      icon: <BarChart3 className="w-6 h-6" />,
      color: 'bg-orange-500',
      available: false
    },
    {
      id: 'email',
      title: 'Marketing por Email',
      description: 'Campañas y newsletters',
      icon: <Mail className="w-6 h-6" />,
      color: 'bg-pink-500',
      available: false
    },
    {
      id: 'media',
      title: 'Gestión de Medios',
      description: 'Imágenes y archivos multimedia',
      icon: <Image className="w-6 h-6" />,
      color: 'bg-yellow-500',
      available: false
    },
    {
      id: 'database',
      title: 'Base de Datos',
      description: 'Backup y mantenimiento',
      icon: <Database className="w-6 h-6" />,
      color: 'bg-red-500',
      available: false
    },
    {
      id: 'monitoring',
      title: 'Monitoreo',
      description: 'Performance y logs del sistema',
      icon: <Monitor className="w-6 h-6" />,
      color: 'bg-indigo-500',
      available: false
    },
    {
      id: 'security',
      title: 'Seguridad',
      description: 'Configuración de acceso y permisos',
      icon: <Shield className="w-6 h-6" />,
      color: 'bg-gray-500',
      available: false
    },
    {
      id: 'settings',
      title: 'Configuración',
      description: 'Ajustes generales del sitio',
      icon: <Settings className="w-6 h-6" />,
      color: 'bg-teal-500',
      available: false
    }
  ];

  const todayAppointments = upcomingAppointments.filter(appointment => appointment.isToday).length;
  const tomorrowAppointments = upcomingAppointments.filter(appointment => appointment.isTomorrow).length;

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'appointments':
        return (
          <AdminAppointment onBack={() => setActiveSection('dashboard')} />
        );
      case 'calendar':
        return (
          <AdminCalendar onBack={() => setActiveSection('dashboard')} />
        );
      case 'block-schedule':
        return (
          <AdminBlockSchedule onBack={() => setActiveSection('dashboard')} />
        );
      case 'calendar-manager':
        return (
          <CalendarManager onBack={() => setActiveSection('dashboard')} />
        );
      case 'dashboard':
      default:
        return (
          <div className="dashboard-page space-y-7">
            {/* Header del Dashboard con Notificaciones */}
            <section className="dashboard-hero relative overflow-hidden rounded-3xl border border-white/70 p-6 shadow-xl sm:p-8">
              <div className="relative z-10 flex flex-col justify-between gap-6 md:flex-row md:items-end">
                <div className="max-w-2xl">
                  <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-gold/40 bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    BIOSKIN · Panel de gestión
                  </span>
                  <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">Panel Administrativo</h1>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600 sm:text-base">
                    Una vista clara de la agenda y las herramientas de tu clínica.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setActiveSection('appointments')}
                    className="admin-focus-ring admin-interactive inline-flex min-h-11 items-center gap-2 rounded-xl bg-gold-ink px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-gold-ink/90"
                  >
                    <Calendar className="h-4 w-4" />
                    Agendar cita
                  </button>
                  <button
                    onClick={() => setActiveSection('calendar')}
                    className="admin-focus-ring admin-interactive inline-flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white/80 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-white"
                  >
                    <CalendarDays className="h-4 w-4" />
                    Ver agenda
                  </button>
                </div>
              </div>

              <div className="dashboard-summary mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="dashboard-summary-card">
                  <span className="dashboard-summary-label">Próximos 15 días</span>
                  <span className="dashboard-summary-value" aria-live="polite">
                    {loadingNotifications ? '—' : upcomingAppointments.length}
                  </span>
                  <span className="dashboard-summary-note">citas programadas</span>
                </div>
                <div className="dashboard-summary-card">
                  <span className="dashboard-summary-label">Hoy</span>
                  <span className="dashboard-summary-value" aria-live="polite">
                    {loadingNotifications ? '—' : todayAppointments}
                  </span>
                  <span className="dashboard-summary-note">citas para atender</span>
                </div>
                <div className="dashboard-summary-card">
                  <span className="dashboard-summary-label">Mañana</span>
                  <span className="dashboard-summary-value" aria-live="polite">
                    {loadingNotifications ? '—' : tomorrowAppointments}
                  </span>
                  <span className="dashboard-summary-note">citas previstas</span>
                </div>
              </div>
            </section>
            
            {/* Botón Flotante de Notificaciones */}
            <div className="notifications-panel fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                aria-expanded={showNotifications}
                aria-controls="dashboard-notifications"
                aria-label={loadingNotifications ? 'Cargando notificaciones' : `Notificaciones de citas: ${upcomingAppointments.length}`}
                className={`admin-focus-ring admin-interactive flex items-center gap-2 rounded-full border border-white/80 px-4 py-3 text-white shadow-xl hover:-translate-y-0.5 hover:shadow-2xl sm:gap-3 sm:px-5 ${
                  loadingNotifications 
                    ? 'bg-gradient-to-r from-blue-500 to-blue-600'
                    : upcomingAppointments.length > 0 
                    ? 'bg-gradient-to-r from-[#deb887] to-[#d4a574]' 
                    : 'bg-gradient-to-r from-gray-500 to-gray-600'
                }`}
              >
                <div className="relative">
                  <Bell className={`w-6 h-6 ${loadingNotifications ? 'animate-pulse' : ''}`} />
                  {loadingNotifications ? (
                    <div className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-blue-500 text-xs font-bold">
                      <Clock className="w-3 h-3" />
                    </div>
                  ) : upcomingAppointments.length > 0 ? (
                    <div className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-red-600 px-1 text-[10px] font-bold">
                      {upcomingAppointments.length > 9 ? '9+' : upcomingAppointments.length}
                    </div>
                  ) : null}
                </div>
                <span className="text-sm font-semibold">
                  {loadingNotifications ? (
                    'Cargando...'
                  ) : upcomingAppointments.length > 0 ? (
                    <>
                      Notificaciones
                      <span className="ml-1 text-xs opacity-90">
                        ({upcomingAppointments.length})
                      </span>
                    </>
                  ) : (
                    'Sin Notificaciones'
                  )}
                </span>
              </button>

              {/* Panel de Notificaciones Reposicionado */}
              {showNotifications && (
                <div id="dashboard-notifications" role="region" aria-label="Citas próximas" className="admin-page-enter absolute bottom-full right-0 mb-4 max-h-[min(26rem,75vh)] w-[calc(100vw_-_2rem)] max-w-sm overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-[#deb887] to-[#d4a574] text-white rounded-t-xl">
                    <h3 className="font-semibold flex items-center gap-2">
                      <CalendarDays className="w-5 h-5" />
                      Citas Próximas (15 días)
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fetchUpcomingAppointments()}
                        disabled={loadingNotifications}
                        className="admin-focus-ring rounded-lg p-1 text-white hover:bg-white/15"
                        title="Actualizar notificaciones"
                        aria-label="Actualizar notificaciones"
                      >
                        <Clock className={`w-4 h-4 ${loadingNotifications ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        onClick={() => setShowNotifications(false)}
                        className="admin-focus-ring rounded-lg p-1 text-white hover:bg-white/15"
                        aria-label="Cerrar notificaciones"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="max-h-[min(20rem,60vh)] overflow-y-auto">
                    {loadingNotifications ? (
                      <div className="p-6 text-center">
                        <Clock className="mx-auto mb-2 h-8 w-8 animate-spin text-[#deb887]" />
                        <p className="text-gray-600">Cargando citas...</p>
                      </div>
                    ) : upcomingAppointments.length === 0 ? (
                      <div className="p-6 text-center">
                        <Calendar className="mx-auto mb-3 h-12 w-12 text-gray-300" />
                        <p className="text-gray-500">No hay citas próximas</p>
                        <p className="mt-1 text-sm text-gray-400">en los próximos 15 días</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-gray-100">
                        {upcomingAppointments.slice(0, 10).map(appointment => {
                          const urgency = getUrgencyMessage(appointment);
                          const { time, day } = formatAppointmentDateTime(appointment.start);
                          
                          return (
                            <div key={appointment.id} className="p-4 hover:bg-gray-50 transition-colors">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-xs px-2 py-1 rounded-full font-bold ${urgency.color}`}>
                                      {urgency.text}
                                    </span>
                                    <span className="text-sm font-medium text-gray-800">
                                      {time}
                                    </span>
                                  </div>
                                  <h4 className="font-semibold text-gray-800 mb-1">
                                    {appointment.summary}
                                  </h4>
                                  <p className="text-sm text-gray-600 mb-2">
                                    {day}
                                  </p>
                                  {appointment.description && (
                                    <p className="text-xs text-gray-500 line-clamp-2">
                                      {appointment.description.split('\n')[0]}
                                    </p>
                                  )}
                                </div>
                                <div className="flex-shrink-0">
                                  {appointment.isToday && (
                                    <AlertCircle className="w-5 h-5 text-red-500" />
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        
                        {upcomingAppointments.length > 10 && (
                          <div className="p-4 text-center bg-gray-50">
                            <p className="text-sm text-gray-600">
                              +{upcomingAppointments.length - 10} citas más...
                            </p>
                            <button
                              onClick={() => {
                                setShowNotifications(false);
                                setActiveSection('calendar');
                              }}
                              className="text-[#deb887] hover:text-[#d4a574] font-medium text-sm mt-1"
                            >
                              Ver calendario completo
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  
                  <div className="p-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
                    <button
                      onClick={() => {
                        setShowNotifications(false);
                        setActiveSection('calendar');
                      }}
                      className="w-full text-center text-[#deb887] hover:text-[#d4a574] font-medium text-sm py-2 rounded-lg hover:bg-gray-100 transition-colors"
                    >
                      Ver Calendario Completo
                    </button>
                  </div>
                </div>
              )}
            </div>
            
            {/* Acceso directo al generador local */}
            <div className="admin-surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Generador de Blogs Local</h3>
                <p className="mt-1 text-sm text-gray-600">Acceso al sistema local de generación de blogs con IA.</p>
              </div>
              <button
                onClick={() => window.open('http://localhost:3336', '_blank')}
                className="admin-focus-ring admin-interactive inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
              >
                Abrir Generador de Blogs
              </button>
            </div>



            {/* Opciones de gestión */}
            <div>
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">Espacio de trabajo</p>
                  <h3 className="mt-1 text-xl font-semibold text-gray-900">Opciones de gestión</h3>
                </div>
                <span className="hidden text-sm text-gray-500 sm:block">Accesos disponibles para tu cuenta</span>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {adminOptions.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => option.available && setActiveSection(option.id)}
                    disabled={!option.available}
                    className={`admin-focus-ring admin-interactive group rounded-2xl border p-4 text-left ${
                      option.available
                        ? 'border-gray-200 bg-white hover:-translate-y-0.5 hover:border-gold/70 hover:shadow-lg'
                        : 'border-gray-100 bg-white/60 opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`rounded-xl p-2.5 text-white shadow-sm ${option.color}`}>
                        {option.icon}
                      </div>
                      <div className="flex-1">
                        <h4 className="mb-1 font-semibold text-gray-900">{option.title}</h4>
                        <p className="text-sm leading-relaxed text-gray-600">{option.description}</p>
                        {!option.available && (
                          <span className="mt-3 inline-flex rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
                            Próximamente
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Actividad reciente */}
            <div className="admin-surface p-5 sm:p-6">
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Actividad Reciente</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Monitor className="w-5 h-5 text-blue-500" />
                  <div>
                    <p className="text-sm font-medium">Sistema funcionando correctamente</p>
                    <p className="text-xs text-gray-500">Hace 5 minutos</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Calendar className="w-5 h-5 text-green-500" />
                  <div>
                    <p className="text-sm font-medium">Nueva cita agendada para mañana</p>
                    <p className="text-xs text-gray-500">Hace 4 horas</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Users className="w-5 h-5 text-purple-500" />
                  <div>
                    <p className="text-sm font-medium">Nuevo usuario registrado</p>
                    <p className="text-xs text-gray-500">Hace 6 horas</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb / Navegación */}
      {activeSection !== 'dashboard' && (
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => setActiveSection('dashboard')}
            className="text-[#deb887] hover:text-[#d4a574] font-medium"
          >
            Dashboard
          </button>
          <span className="text-gray-400">/</span>
          <span className="text-gray-700 font-medium">
            {adminOptions.find(opt => opt.id === activeSection)?.title || 'Sección'}
          </span>
        </div>
      )}

      {/* Contenido activo */}
      {renderActiveSection()}
    </div>
  );
};

export default AdminDashboard;