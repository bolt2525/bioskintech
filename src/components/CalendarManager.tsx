import React, { useState, useEffect } from 'react';
import recordsFetch from '../utils/recordsFetch';
import { useClinicSettings } from '../hooks/useClinicSettings';
import { useAuth } from '../context/AuthContext';
import { 
  Calendar,
  Trash2,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  ArrowLeft,
  User,
  MapPin,
  FileText,
  Ban,
  MessageCircle
} from 'lucide-react';

interface CalendarManagerProps {
  onBack: () => void;
}

interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  location?: string;
  creator?: {
    email?: string;
    displayName?: string;
  };
  organizer?: {
    email?: string;
    displayName?: string;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  status?: string;
  eventType: 'appointment' | 'block';
  isBlockEvent: boolean;
  created?: string;
  updated?: string;
}

const CalendarManager: React.FC<CalendarManagerProps> = ({ onBack }) => {
  const { settings: clinicSettings } = useClinicSettings();
  const { user } = useAuth();
  const clinicName         = clinicSettings.general.name || user?.clinic_name || 'nuestra clínica';
  const establishmentType  = clinicSettings.general.establishment_type || '';
  // e.g. "Centro Estético BIOSKIN" or just "BIOSKIN"
  const clinicIdentity     = establishmentType ? `${establishmentType} ${clinicName}` : clinicName;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [calendarNotConfigured, setCalendarNotConfigured] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | ''>('');
  const [dateRange, setDateRange] = useState(30); // días hacia adelante
  const [deletingEvents, setDeletingEvents] = useState<Set<string>>(new Set());

  // Cargar eventos del calendario
  const loadCalendarEvents = async () => {
    setLoading(true);
    setMessage('');
    
    try {
      console.log(`🔍 Cargando eventos del calendario para los próximos ${dateRange} días...`);
      
      const response = await recordsFetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'getCalendarEvents',
          days: dateRange
        }),
      });

      const data = await response.json();
      
      if (data.calendarNotConfigured) {
        setCalendarNotConfigured(true);
        return;
      }
      if (data.success) {
        setEvents(data.events || []);
        setMessage(`✅ ${data.events?.length || 0} eventos cargados`);
        setMessageType('success');
        console.log(`✅ ${data.events?.length || 0} eventos cargados del calendario`);
      } else {
        throw new Error(data.message || 'Error al cargar eventos');
      }
      
    } catch (error) {
      console.error('❌ Error cargando eventos del calendario:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setMessage(`❌ Error: ${errorMessage}`);
      setMessageType('error');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  // Eliminar evento individual
  const deleteEvent = async (event: CalendarEvent) => {
    const confirmDelete = window.confirm(
      `¿Estás seguro de eliminar este ${event.eventType === 'appointment' ? 'cita' : 'bloqueo'}?\n\n` +
      `"${event.summary}"\n` +
      `${formatEventDateTime(event)}`
    );

    if (!confirmDelete) return;

    setDeletingEvents(prev => new Set(prev).add(event.id));

    try {
      const response = await recordsFetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deleteEvent',
          eventId: event.id,
          eventType: event.eventType,
          date: event.start.dateTime?.split('T')[0] || event.start.date
        }),
      });

      const data = await response.json();

      if (data.success) {
        setMessage(`✅ ${event.eventType === 'appointment' ? 'Cita cancelada' : 'Bloqueo eliminado'} exitosamente`);
        setMessageType('success');
        
        // Remover evento de la lista
        setEvents(prev => prev.filter(e => e.id !== event.id));
        
      } else {
        throw new Error(data.message || 'Error al eliminar evento');
      }
      
    } catch (error) {
      console.error('❌ Error eliminando evento:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setMessage(`❌ Error: ${errorMessage}`);
      setMessageType('error');
    } finally {
      setDeletingEvents(prev => {
        const newSet = new Set(prev);
        newSet.delete(event.id);
        return newSet;
      });
    }
  };

  // Formatear fecha y hora del evento
  const formatEventDateTime = (event: CalendarEvent) => {
    const startDateTime = event.start.dateTime || event.start.date;
    const endDateTime = event.end.dateTime || event.end.date;
    
    if (!startDateTime) return 'Fecha no disponible';
    
    const start = new Date(startDateTime);
    const end = endDateTime ? new Date(endDateTime) : start;
    
    // Formatear fecha
    const dateStr = start.toLocaleDateString('es-ES', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Formatear hora si existe
    if (event.start.dateTime) {
      const timeStr = `${start.toLocaleTimeString('es-ES', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      })} - ${end.toLocaleTimeString('es-ES', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      })}`;
      return `${dateStr} • ${timeStr}`;
    } else {
      return `${dateStr} • Todo el día`;
    }
  };

  // Generar link de WhatsApp para recordatorio
  const getWhatsAppLink = (event: CalendarEvent) => {
    if (event.eventType !== 'appointment') return null;

    // Intentar extraer teléfono de la descripción
    // Formato esperado en descripción: "Teléfono: 09..."
    const phoneMatch = event.description?.match(/Teléfono:\s*([\d\+\-\s]+)/);
    let phone = phoneMatch ? phoneMatch[1].replace(/\D/g, '') : '';
    
    if (!phone) return null;
    
    // Formatear a 593 (Ecuador)
    if (phone.startsWith('0')) {
      phone = '593' + phone.substring(1);
    } else if (!phone.startsWith('593') && phone.length === 9) {
       phone = '593' + phone;
    }

    // Extraer nombre
    let patientName = "Paciente";
    if (event.summary.startsWith('Cita: ')) {
        const parts = event.summary.substring(6).split(' - ');
        if (parts.length > 0) patientName = parts[0];
    } else {
        patientName = event.summary;
    }

    const start = new Date(event.start.dateTime || event.start.date || '');
    const dateStr = start.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeStr = event.start.dateTime ? start.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

    const message = `Hola ${patientName} 👋, le saludamos de ${clinicIdentity}.\n\nLe recordamos su cita agendada para el ${dateStr} a las ${timeStr}.\n\nPor favor confirme su asistencia respondiendo este mensaje. ¡Le esperamos! 🗓️`;
    
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  };

  // Filtrar eventos por tipo
  const appointmentEvents = events.filter(e => e.eventType === 'appointment');
  const blockEvents = events.filter(e => e.eventType === 'block');

  // Cargar eventos al montar el componente
  useEffect(() => {
    loadCalendarEvents();
  }, [dateRange]);

  if (calendarNotConfigured) {
    return (
      <section className="py-16 bg-gray-50 min-h-screen flex items-center justify-center">
        <div className="max-w-md text-center bg-white rounded-3xl shadow-2xl p-10">
          <button onClick={onBack} className="flex items-center gap-2 text-[#deb887] hover:text-[#d4a574] font-medium mb-6 mx-auto">
            <ArrowLeft className="w-5 h-5" />
            Volver
          </button>
          <Calendar className="w-16 h-16 text-amber-400 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-gray-800 mb-2">Calendario no conectado</h3>
          <p className="text-gray-500 text-sm">Esta clínica no tiene una cuenta de Gmail vinculada. Conecta Google Calendar desde el panel del Master Admin para gestionar citas.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-16 bg-gray-50 min-h-screen">
      <div className="max-w-6xl w-full mx-auto bg-white rounded-3xl shadow-2xl p-6 md:p-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 text-gray-600 hover:text-[#deb887] hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h2 className="text-2xl font-bold text-[#99652f] flex items-center gap-2">
                <Calendar className="w-6 h-6" />
                Gestión Completa del Calendario
              </h2>
              <p className="text-gray-600">Visualiza y gestiona todas las citas y bloqueos del calendario</p>
            </div>
          </div>
          <button
            onClick={loadCalendarEvents}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-[#deb887] hover:bg-[#d4a574] text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Días a mostrar
            </label>
            <select
              value={dateRange}
              onChange={(e) => setDateRange(Number(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
            >
              <option value={7}>Próximos 7 días</option>
              <option value={15}>Próximos 15 días</option>
              <option value={30}>Próximos 30 días</option>
              <option value={60}>Próximos 60 días</option>
              <option value={90}>Próximos 90 días</option>
            </select>
          </div>
        </div>

        {/* Mensaje de estado */}
        {message && (
          <div className={`p-4 rounded-lg flex items-center gap-3 mb-6 ${
            messageType === 'success' 
              ? 'bg-green-50 border border-green-200 text-green-800' 
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            {messageType === 'success' ? (
              <CheckCircle className="w-5 h-5" />
            ) : (
              <AlertTriangle className="w-5 h-5" />
            )}
            <span>{message}</span>
          </div>
        )}

        {/* Estadísticas */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <User className="w-8 h-8 text-blue-600" />
              <div>
                <p className="text-sm text-blue-600 font-medium">Citas Programadas</p>
                <p className="text-2xl font-bold text-blue-800">{appointmentEvents.length}</p>
              </div>
            </div>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Ban className="w-8 h-8 text-red-600" />
              <div>
                <p className="text-sm text-red-600 font-medium">Horarios Bloqueados</p>
                <p className="text-2xl font-bold text-red-800">{blockEvents.length}</p>
              </div>
            </div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Calendar className="w-8 h-8 text-gray-600" />
              <div>
                <p className="text-sm text-gray-600 font-medium">Total Eventos</p>
                <p className="text-2xl font-bold text-gray-800">{events.length}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Lista de eventos — agrupada por día */}
        {loading ? (
          <div className="text-center py-12">
            <div className="inline-block w-12 h-12 border-4 border-[#deb887] border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Cargando eventos del calendario...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Calendar className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h3 className="text-lg font-semibold mb-2">No hay eventos programados</h3>
            <p className="text-sm">No se encontraron citas ni bloqueos en el rango seleccionado</p>
          </div>
        ) : (() => {
          // Group events by date
          const grouped = new Map<string, CalendarEvent[]>();
          [...events]
            .sort((a, b) => new Date(a.start.dateTime || a.start.date || 0).getTime() - new Date(b.start.dateTime || b.start.date || 0).getTime())
            .forEach(ev => {
              const dateKey = (ev.start.dateTime || ev.start.date || '').split('T')[0];
              if (!grouped.has(dateKey)) grouped.set(dateKey, []);
              grouped.get(dateKey)!.push(ev);
            });

          return (
            <div className="space-y-6">
              {[...grouped.entries()].map(([dateKey, dayEvents]) => {
                const dateObj = new Date(dateKey + 'T12:00:00');
                const dayLabel = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
                return (
                  <div key={dateKey}>
                    {/* Day header */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-2 h-2 rounded-full bg-[#deb887]" />
                      <h3 className="text-sm font-semibold text-gray-500 capitalize">{dayLabel}</h3>
                      <div className="flex-1 h-px bg-gray-100" />
                      <span className="text-xs text-gray-400">{dayEvents.length} evento{dayEvents.length !== 1 ? 's' : ''}</span>
                    </div>

                    {/* Event cards for this day */}
                    <div className="space-y-2">
                      {dayEvents.map(event => {
                        const isBlock = event.eventType === 'block';
                        const startDt = event.start.dateTime;
                        const endDt = event.end.dateTime;
                        const timeStart = startDt ? new Date(startDt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                        const timeEnd = endDt ? new Date(endDt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';

                        // Parse patient info from summary + description
                        let patientName = event.summary;
                        if (event.summary.startsWith('Cita: ')) {
                          patientName = event.summary.substring(6).split(' - ')[0];
                        }
                        const service = event.description?.match(/Servicio:\s*([^\n]+)/)?.[1]?.trim() || '';
                        const phone = event.description?.match(/Teléfono:\s*([\d\+\-\s]+)/)?.[1]?.trim() || '';
                        const professional = event.description?.match(/Profesional:\s*([^\n]+)/)?.[1]?.trim() || '';

                        return (
                          <div key={event.id}
                            className={`flex items-center gap-3 p-3 rounded-xl border transition-all hover:shadow-sm ${
                              isBlock
                                ? 'border-red-200 bg-red-50/60'
                                : 'border-gray-200 bg-white hover:border-[#deb887]/40'
                            }`}
                          >
                            {/* Time badge */}
                            <div className={`flex-shrink-0 text-center px-3 py-2 rounded-lg min-w-[72px] ${
                              isBlock ? 'bg-red-100 text-red-700' : 'bg-[#deb887]/15 text-[#99652f]'
                            }`}>
                              <p className="text-xs font-bold leading-tight">{timeStart}</p>
                              {timeEnd && <p className="text-[10px] leading-tight opacity-70">{timeEnd}</p>}
                            </div>

                            {/* Main info */}
                            <div className="flex-1 min-w-0">
                              {isBlock ? (
                                <div className="flex items-center gap-1.5">
                                  <Ban className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                                  <p className="text-sm font-semibold text-red-700 truncate">Horario bloqueado</p>
                                </div>
                              ) : (
                                <p className="text-sm font-semibold text-gray-900 truncate">{patientName}</p>
                              )}
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {service && (
                                  <span className="text-xs text-[#deb887] font-medium truncate">{service}</span>
                                )}
                                {professional && (
                                  <span className="text-xs text-gray-400 truncate">· {professional}</span>
                                )}
                                {phone && !isBlock && (
                                  <span className="text-xs text-gray-400 truncate">· {phone}</span>
                                )}
                                {!service && !professional && !phone && (
                                  <span className="text-xs text-gray-400 truncate">{event.summary}</span>
                                )}
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {getWhatsAppLink(event) && (
                                <a href={getWhatsAppLink(event)!} target="_blank" rel="noopener noreferrer"
                                  className="p-2 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                                  title="Enviar recordatorio por WhatsApp">
                                  <MessageCircle className="w-4 h-4" />
                                </a>
                              )}
                              <button onClick={() => deleteEvent(event)} disabled={deletingEvents.has(event.id)}
                                className="p-2 rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40"
                                title={isBlock ? 'Eliminar bloqueo' : 'Cancelar cita'}>
                                {deletingEvents.has(event.id)
                                  ? <RefreshCw className="w-4 h-4 animate-spin" />
                                  : <Trash2 className="w-4 h-4" />}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </section>
  );
};

export default CalendarManager;