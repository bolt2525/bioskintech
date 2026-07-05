import React, { useState, useEffect } from 'react';
import { 
  Calendar,
  Clock,
  X,
  ArrowLeft,
  Save,
  Trash2,
  CalendarDays,
  ShieldCheck,
  Settings,
  AlertTriangle,
  CheckCircle,
  Ban
} from 'lucide-react';

interface BlockScheduleProps {
  onBack: () => void;
}

interface BlockedEvent {
  date: string;
  hours: string[];
  reason: string;
  created: string;
  events?: Array<{
    id: string;
    hour: string;
    summary: string;
    description?: string;
    htmlLink?: string;
  }>;
}

type EventType = { start: string; end: string };

// Helpers para español (igual que en Appointment)
const daysOfWeek = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function getNextDays(count = 30) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    days.push({
      dayName: daysOfWeek[date.getDay()],
      dateNum: date.getDate(),
      month: months[date.getMonth()],
      iso: [
        date.getFullYear(),
        (date.getMonth() + 1).toString().padStart(2, '0'),
        date.getDate().toString().padStart(2, '0')
      ].join('-')
    });
  }
  return days;
}

const allTimes = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

// Función para verificar si una hora ya pasó en el día actual (igual que en Appointment)
function isHourPast(selectedDay: string, hour: string): boolean {
  if (!selectedDay || !hour) return false;
  
  const today = new Date();
  
  // CORREGIDO: usar fechas locales en lugar de UTC para evitar problemas de zona horaria
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  
  // Formatear fechas como strings locales YYYY-MM-DD
  const todayString = `${todayLocal.getFullYear()}-${(todayLocal.getMonth() + 1).toString().padStart(2, '0')}-${todayLocal.getDate().toString().padStart(2, '0')}`;
  const selectedString = selectedDay; // Ya está en formato YYYY-MM-DD
  
  // Debug: mostrar las fechas que se están comparando
  console.log('🗓️ AdminBlockSchedule - Comparando fechas (CORREGIDO):', { 
    hoy: todayString, 
    seleccionado: selectedString, 
    esHoy: todayString === selectedString,
    horaActual: today.toLocaleTimeString('es-ES', { timeZone: 'America/Guayaquil' })
  });
  
  // Si no es el día de hoy, no está en el pasado
  if (todayString !== selectedString) {
    return false;
  }
  
  // Si es hoy, verificar si la hora ya pasó
  const [hourNum, minuteNum] = hour.split(':').map(Number);
  const appointmentTime = new Date();
  appointmentTime.setHours(hourNum, minuteNum || 0, 0, 0);
  
  const currentTime = new Date();
  return appointmentTime <= currentTime;
}

// Función para verificar si una hora está ocupada (igual que en Appointment)
function isHourOccupied(selectedDay: string, hour: string, events: EventType[]): boolean {
  if (!selectedDay) return true;
  const startTime = new Date(selectedDay + 'T' + hour + ':00');
  const endTime = new Date(startTime.getTime() + 1 * 60 * 60 * 1000); // 1 hora para bloqueos
  return events.some(ev => {
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    return (startTime < evEnd && endTime > evStart);
  });
}

const formatTimeLabel = (time24: string) => {
  const parts = time24.split(':');
  const hour = parseInt(parts[0], 10);
  const minuteStr = parts[1];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const hourStr = hour12 < 10 ? '0' + hour12 : hour12.toString();
  return hourStr + ':' + minuteStr + ' ' + suffix;
};

const AdminBlockSchedule: React.FC<BlockScheduleProps> = ({ onBack }) => {
  // Estados similares a Appointment - NUEVA INTERFAZ PASO A PASO 
  const [step, setStep] = useState(1);
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedHours, setSelectedHours] = useState<string[]>([]);
  const [events, setEvents] = useState<EventType[]>([]);
  const [loadingHours, setLoadingHours] = useState(false);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error' | ''>('');
  const [existingBlocks, setExistingBlocks] = useState<BlockedEvent[]>([]);
  const [showExisting, setShowExisting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dayEvents, setDayEvents] = useState<any[]>([]);
  const [loadingDayEvents, setLoadingDayEvents] = useState(false);
  const [showDayEvents, setShowDayEvents] = useState(false);

  const days = getNextDays(30); // 30 días para admin

  // Razones predefinidas
  const predefinedReasons = [
    'Reunión de equipo',
    'Mantenimiento de equipos',
    'Capacitación del personal',
    'Día festivo',
    'Emergencia médica',
    'Cierre temporal',
    'Evento especial',
    'Ausencia del doctor',
    'Inventario',
    'Otro'
  ];

  // Cargar eventos ocupados cuando se selecciona un día (igual que en Appointment)
  useEffect(() => {
    if (!selectedDay) {
      setEvents([]);
      return;
    }
    setLoadingHours(true);
    console.log(`🔍 Cargando eventos ocupados para: ${selectedDay}`);
    
    fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getEvents', date: selectedDay }),
    })
      .then(res => res.json())
      .then(data => {
        console.log('📋 Respuesta getEvents:', data);
        setEvents(Array.isArray(data.occupiedTimes) ? data.occupiedTimes : []);
        console.log(`✅ ${data.occupiedTimes?.length || 0} horarios ocupados encontrados`);
      })
      .catch((error) => {
        console.error('❌ Error cargando eventos ocupados:', error);
        setEvents([]);
      })
      .finally(() => setLoadingHours(false));
  }, [selectedDay]);

  // Limpiar horas seleccionadas cuando cambia el día
  useEffect(() => { 
    setSelectedHours([]);
    setShowDayEvents(false);
    setDayEvents([]);
  }, [selectedDay]);

  // Cargar eventos detallados del día seleccionado
  const loadDayEvents = async (date: string) => {
    if (!date) return;
    
    setLoadingDayEvents(true);
    try {
      console.log(`🔍 Cargando eventos detallados para: ${date}`);
      
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getDayEvents', date }),
      });
      
      const data = await response.json();
      console.log('📋 Respuesta getDayEvents:', data);
      
      if (data.success) {
        setDayEvents(data.events || []);
        console.log(`✅ ${data.events?.length || 0} eventos cargados para vista detallada`);
      } else {
        console.error('❌ Error loading day events:', data.message);
        setDayEvents([]);
      }
    } catch (error) {
      console.error('❌ Error loading day events:', error);
      setDayEvents([]);
    } finally {
      setLoadingDayEvents(false);
    }
  };

  // Eliminar evento individual (cita o bloqueo)
  const handleDeleteEvent = async (eventId: string, eventType: 'appointment' | 'block', eventTitle: string) => {
    const confirmDelete = window.confirm(
      `¿Estás seguro de eliminar este ${eventType === 'appointment' ? 'cita' : 'bloqueo'}?\n\n"${eventTitle}"`
    );

    if (!confirmDelete) return;

    try {
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deleteEvent',
          eventId,
          eventType,
          date: selectedDay
        }),
      });

      const data = await response.json();

      if (data.success) {
        setMessage(`✅ ${eventType === 'appointment' ? 'Cita cancelada' : 'Bloqueo eliminado'} exitosamente`);
        setMessageType('success');
        
        // Recargar eventos del día y eventos ocupados
        loadDayEvents(selectedDay);
        
        // Recargar eventos ocupados para la validación de horas
        const eventsResponse = await fetch('/api/calendar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'getEvents', date: selectedDay }),
        });
        const eventsData = await eventsResponse.json();
        setEvents(Array.isArray(eventsData.occupiedTimes) ? eventsData.occupiedTimes : []);
        
      } else {
        throw new Error(data.message || 'Error al eliminar evento');
      }
      
    } catch (error) {
      console.error('❌ Error deleting event:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setMessage(`❌ Error: ${errorMessage}`);
      setMessageType('error');
    }
  };

  // Toggle mostrar eventos del día
  const toggleShowDayEvents = () => {
    if (!showDayEvents && selectedDay) {
      loadDayEvents(selectedDay);
    }
    setShowDayEvents(!showDayEvents);
  };

  // Toggle selección de hora
  const toggleHour = (hour: string) => {
    setSelectedHours(prev => 
      prev.includes(hour) 
        ? prev.filter(h => h !== hour)
        : [...prev, hour]
    );
  };

  // Cargar bloqueos existentes
  const loadExistingBlocks = async () => {
    try {
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getBlockedSchedules' }),
      });
      const data = await response.json();
      
      if (data.success) {
        setExistingBlocks(data.data.blocks || []);
      } else {
        setExistingBlocks([]);
      }
    } catch (error) {
      console.error('❌ Error al cargar bloqueos:', error);
      setExistingBlocks([]);
    }
  };

  // Enviar bloqueo
  const handleSubmit = async () => {
    if (selectedHours.length === 0) {
      setMessage('Por favor selecciona al menos una hora');
      setMessageType('error');
      return;
    }

    if (!reason.trim()) {
      setMessage('Por favor especifica el motivo del bloqueo');
      setMessageType('error');
      return;
    }

    setIsSubmitting(true);
    setMessage('');

    try {
      // Crear bloqueo en Google Calendar
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'blockSchedule',
          date: selectedDay,
          hours: selectedHours,
          reason: reason.trim(),
          adminName: 'Administrador BIOSKIN'
        }),
      });

      const data = await response.json();

      if (data.success) {
        // Enviar notificación por email al equipo
        await fetch('/api/sendEmail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Sistema BIOSKIN - Bloqueo de Horarios',
            email: 'admin@bioskin.com',
            message: `NOTIFICACIÓN: HORARIOS BLOQUEADOS\n\n` +
                    `Fecha: ${selectedDay}\n` +
                    `Horarios bloqueados: ${selectedHours.map(h => formatTimeLabel(h)).join(', ')}\n` +
                    `Motivo: ${reason.trim()}\n` +
                    `Administrador: BIOSKIN Admin\n` +
                    `Fecha de bloqueo: ${new Date().toLocaleString('es-ES', { timeZone: 'America/Guayaquil' })}\n\n` +
                    `Los horarios han sido bloqueados automáticamente en Google Calendar y no estarán disponibles para citas de pacientes.\n\n` +
                    `Este es un mensaje automático del sistema de gestión BIOSKIN.`,
          }),
        });

        setSubmitted(true);
        setMessage(data.message);
        setMessageType('success');
        
        // Limpiar formulario
        setSelectedDay('');
        setSelectedHours([]);
        setReason('');
        setStep(1);
        setConfirming(false);
        
        // Recargar bloqueos existentes
        loadExistingBlocks();
        
      } else {
        throw new Error(data.message || 'Error al bloquear horarios');
      }
      
    } catch (error) {
      console.error('❌ Error blocking schedule:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setMessage(`❌ Error al bloquear horarios: ${errorMessage}`);
      setMessageType('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Eliminar bloqueo
  const handleDeleteBlock = async (block: BlockedEvent) => {
    if (!block.events || block.events.length === 0) {
      setMessage('❌ No se encontraron eventos para eliminar');
      setMessageType('error');
      return;
    }

    const confirmDelete = window.confirm(
      `¿Estás seguro de eliminar el bloqueo del ${new Date(block.date).toLocaleDateString('es-ES')} para ${block.hours.length} hora(s)?\n\nMotivo: ${block.reason}`
    );

    if (!confirmDelete) return;

    try {
      const eventIds = block.events.map(event => event.id);
      
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deleteBlockedSchedule',
          eventIds,
          date: block.date,
          reason: block.reason
        }),
      });

      const data = await response.json();

      if (data.success) {
        setMessage(`✅ Bloqueo eliminado exitosamente`);
        setMessageType('success');
        
        // Recargar bloqueos existentes
        loadExistingBlocks();
      } else {
        throw new Error(data.message || 'Error al eliminar bloqueo');
      }
      
    } catch (error) {
      console.error('❌ Error deleting block:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      setMessage(`❌ Error al eliminar bloqueo: ${errorMessage}`);
      setMessageType('error');
    }
  };

  // Reset todo
  const resetAll = () => {
    setStep(1);
    setSelectedDay('');
    setSelectedHours([]);
    setReason('');
    setSubmitted(false);
    setMessage('');
    setMessageType('');
    setConfirming(false);
  };

  useEffect(() => {
    loadExistingBlocks();
  }, []);

  return (
    <>
      <section className="py-16 bg-gray-50 min-h-screen">
        <div className="max-w-4xl w-full mx-auto bg-white rounded-3xl shadow-2xl p-6 md:p-10">
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
                  <Ban className="w-6 h-6" />
                  Bloquear Horarios
                </h2>
                <p className="text-gray-600">Reserva horarios para reuniones o mantenimiento</p>
              </div>
            </div>
            <button
              onClick={() => setShowExisting(!showExisting)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
            >
              <Settings className="w-4 h-4" />
              {showExisting ? 'Ocultar Existentes' : 'Ver Existentes'}
            </button>
          </div>

          {/* Panel informativo */}
          <div className="flex flex-col md:flex-row md:items-center gap-6 mb-10">
            <div className="flex-1">
              <h3 className="text-lg font-semibold mb-3 text-[#0d5c6c]">Gestión de Disponibilidad</h3>
              <ul className="space-y-2 text-gray-700 text-sm">
                <li className="flex items-center">
                  <CalendarDays className="w-5 h-5 text-[#deb887] mr-2" />
                  Los horarios bloqueados no estarán disponibles para citas
                </li>
                <li className="flex items-center">
                  <ShieldCheck className="w-5 h-5 text-[#deb887] mr-2" />
                  Se crean eventos automáticamente en Google Calendar
                </li>
                <li className="flex items-center">
                  <Clock className="w-5 h-5 text-[#deb887] mr-2" />
                  Puedes bloquear múltiples horarios simultáneamente
                </li>
              </ul>
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

          {/* Wizard de pasos (igual que Appointment) */}
          {!submitted && (
            <>
              {step === 1 && (
                <>
                  <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">1. Selecciona el día</h4>
                  <div className="flex flex-wrap gap-4 justify-center mb-8 max-h-96 overflow-y-auto">
                    {days.map(d => (
                      <button
                        key={d.iso}
                        onClick={() => setSelectedDay(d.iso)}
                        className={`text-center rounded-xl border-2 p-5 w-28 md:w-32 transition-all duration-200
                          ${selectedDay === d.iso ? 'bg-[#ffcfc4] text-[#0d5c6c] border-[#fa9271] shadow-lg scale-105' : 'bg-white text-[#0d5c6c] border-[#dde7eb] hover:bg-[#ffe2db]'}
                        `}
                        style={{ minHeight: 100 }}
                      >
                        <span className="block font-semibold italic text-base">{d.dayName}</span>
                        <span className="block text-3xl font-bold mt-1">{d.dateNum}</span>
                        <span className="block text-base">{d.month}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <button
                      disabled={!selectedDay}
                      onClick={() => setStep(2)}
                      className={`px-7 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow transition ${!selectedDay ? 'opacity-50' : ''}`}
                    >
                      Siguiente
                    </button>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">2. Selecciona las horas a bloquear</h4>
                  
                  {/* Botón para ver eventos del día */}
                  <div className="flex justify-center mb-4">
                    <button
                      onClick={toggleShowDayEvents}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg transition-colors"
                    >
                      <Calendar className="w-4 h-4" />
                      {showDayEvents ? 'Ocultar eventos del día' : 'Ver eventos del día'}
                    </button>
                  </div>

                  {/* Panel de eventos del día */}
                  {showDayEvents && (
                    <div className="mb-6 bg-gray-50 rounded-lg p-4">
                      <h5 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <Calendar className="w-4 h-4" />
                        Eventos en {selectedDay && (() => {
                          const [year, month, day] = selectedDay.split('-').map(Number);
                          const dateObj = new Date(year, month - 1, day);
                          return `${daysOfWeek[dateObj.getDay()]} ${day} de ${months[month - 1]}`;
                        })()}
                      </h5>
                      
                      {loadingDayEvents ? (
                        <div className="text-center py-4">
                          <div className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                          <p className="mt-2 text-sm text-gray-600">Cargando eventos...</p>
                        </div>
                      ) : dayEvents.length === 0 ? (
                        <div className="text-center py-4 text-gray-500">
                          <Calendar className="w-8 h-8 mx-auto mb-2 opacity-50" />
                          <p className="text-sm">No hay eventos programados para este día</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {dayEvents.map((event, index) => {
                            // Arreglar zona horaria - forzar interpretación en zona horaria de Ecuador
                            const startDateTime = event.start.dateTime || event.start.date;
                            const endDateTime = event.end.dateTime || event.end.date;
                            
                            // Si es dateTime, ya tiene zona horaria; si es date, agregar zona horaria de Ecuador
                            const startTime = new Date(startDateTime);
                            const endTime = new Date(endDateTime);
                            
                            // Ajustar para zona horaria de Ecuador si es necesario
                            if (!startDateTime.includes('T')) {
                              // Es solo fecha, ajustar a medianoche Ecuador
                              startTime.setHours(startTime.getHours() + 5); // UTC-5 -> UTC
                            }
                            if (!endDateTime.includes('T')) {
                              endTime.setHours(endTime.getHours() + 5);
                            }
                            
                            const isBlockEvent = event.summary?.includes('BIOSKIN - BLOQUEO');
                            
                            return (
                              <div key={index} className={`border rounded-lg p-3 ${
                                isBlockEvent ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'
                              }`}>
                                <div className="flex items-start justify-between">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      {isBlockEvent ? (
                                        <Ban className="w-4 h-4 text-red-600" />
                                      ) : (
                                        <Clock className="w-4 h-4 text-blue-600" />
                                      )}
                                      <span className={`font-medium ${
                                        isBlockEvent ? 'text-red-800' : 'text-blue-800'
                                      }`}>
                                        {startTime.toLocaleTimeString('es-ES', { 
                                          hour: '2-digit', 
                                          minute: '2-digit',
                                          hour12: true 
                                        })} - {endTime.toLocaleTimeString('es-ES', { 
                                          hour: '2-digit', 
                                          minute: '2-digit',
                                          hour12: true 
                                        })}
                                      </span>
                                    </div>
                                    <p className={`text-sm font-medium ${
                                      isBlockEvent ? 'text-red-700' : 'text-blue-700'
                                    }`}>
                                      {isBlockEvent ? 'HORARIO BLOQUEADO' : 'CITA PROGRAMADA'}
                                    </p>
                                    <p className="text-sm text-gray-600 mt-1">
                                      {event.summary}
                                    </p>
                                    {event.description && (
                                      <p className="text-xs text-gray-500 mt-1">
                                        {event.description}
                                      </p>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => handleDeleteEvent(
                                      event.id, 
                                      isBlockEvent ? 'block' : 'appointment',
                                      event.summary
                                    )}
                                    className={`text-red-500 hover:text-red-700 p-2 hover:bg-red-100 rounded-lg transition-colors ml-2 ${
                                      isBlockEvent ? 'hover:bg-red-200' : 'hover:bg-red-100'
                                    }`}
                                    title={isBlockEvent ? 'Eliminar bloqueo' : 'Cancelar cita'}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 mb-8">
                    {loadingHours ? (
                      <div className="text-center col-span-6 w-full">Cargando horarios...</div>
                    ) : (
                      allTimes.map(h => {
                        const isOccupied = isHourOccupied(selectedDay, h, events);
                        const isPast = isHourPast(selectedDay, h);
                        const isDisabled = isOccupied || isPast;
                        const isSelected = selectedHours.includes(h);
                        
                        return (
                          <button
                            key={h}
                            disabled={isDisabled}
                            onClick={() => {
                              if (!isDisabled) {
                                toggleHour(h);
                              }
                            }}
                            className={`w-full rounded-xl p-3 border-2 text-[#0d5c6c] flex flex-col items-center transition-all duration-150 min-h-[90px]
                              ${isSelected ? 'bg-[#ffcfc4] border-[#fa9271] font-bold shadow-lg scale-105' : 'bg-white border-[#dde7eb] hover:bg-[#ffe2db]'}
                              ${isDisabled ? 'opacity-30 cursor-not-allowed' : ''}
                            `}
                          >
                            <span className="text-lg font-semibold mb-1">
                              {isSelected ? '🚫' : <Clock className="w-4 h-4" />}
                            </span>
                            <span className="text-sm font-bold">{formatTimeLabel(h)}</span>
                            {isOccupied && <span className="text-xs text-red-500 mt-1">Ocupado</span>}
                            {isPast && !isOccupied && <span className="text-xs text-gray-500 mt-1">Pasado</span>}
                            {/* Debug visual - igual que Appointment */}
                            {isPast && <span className="text-xs text-orange-500 mt-1">🚫 PASADO</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                  
                  <div className="text-center mb-6">
                    <p className="text-sm text-gray-600">
                      Seleccionadas: <span className="font-bold">{selectedHours.length}</span> hora(s)
                      {selectedHours.length > 0 && (
                        <>
                          <br />
                          <span className="text-xs">
                            {selectedHours.map(h => formatTimeLabel(h)).join(', ')}
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex justify-between">
                    <button
                      onClick={() => setStep(1)}
                      className="px-6 py-2 rounded-lg bg-[#fa9271] text-white font-bold shadow"
                    >
                      Volver
                    </button>
                    <button
                      disabled={selectedHours.length === 0}
                      onClick={() => setStep(3)}
                      className={`px-6 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow ${selectedHours.length === 0 ? 'opacity-50' : ''}`}
                    >
                      Siguiente
                    </button>
                  </div>
                </>
              )}

              {step === 3 && !confirming && (
                <>
                  <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">3. Especifica el motivo</h4>
                  
                  <div className="max-w-md mx-auto space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Motivo del bloqueo
                      </label>
                      <select
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
                      >
                        <option value="">Selecciona un motivo</option>
                        {predefinedReasons.map((reasonOption) => (
                          <option key={reasonOption} value={reasonOption}>
                            {reasonOption}
                          </option>
                        ))}
                      </select>
                      
                      {reason === 'Otro' && (
                        <input
                          type="text"
                          placeholder="Especifica el motivo..."
                          value={reason === 'Otro' ? '' : reason}
                          onChange={(e) => setReason(e.target.value)}
                          className="w-full mt-3 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#deb887] focus:border-transparent"
                        />
                      )}
                    </div>

                    <div className="flex justify-between mt-6">
                      <button
                        onClick={() => setStep(2)}
                        className="px-6 py-2 rounded-lg bg-[#fa9271] text-white font-bold shadow"
                      >
                        Volver
                      </button>
                      <button
                        disabled={!reason.trim()}
                        onClick={() => setConfirming(true)}
                        className={`px-6 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow ${!reason.trim() ? 'opacity-50' : ''}`}
                      >
                        Revisar
                      </button>
                    </div>
                  </div>
                </>
              )}

              {step === 3 && confirming && (
                <div className="py-10 px-6 text-center bg-gray-50 rounded-2xl shadow mt-6">
                  <h4 className="text-xl font-semibold mb-4 text-[#ba9256]">¿Confirmar bloqueo?</h4>
                  <div className="mb-6 text-gray-700 space-y-2">
                    <div><b>Día:</b> {selectedDay && (() => {
                      const [year, month, day] = selectedDay.split('-').map(Number);
                      const dateObj = new Date(year, month - 1, day);
                      return `${daysOfWeek[dateObj.getDay()]} ${day} de ${months[month - 1]}`;
                    })()}</div>
                    <div><b>Horarios:</b> {selectedHours.map(h => formatTimeLabel(h)).join(', ')} ({selectedHours.length} hora{selectedHours.length !== 1 ? 's' : ''})</div>
                    <div><b>Motivo:</b> {reason}</div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <button
                      className="px-8 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow"
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? 'Bloqueando...' : 'Sí, bloquear'}
                    </button>
                    <button
                      className="px-8 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold shadow"
                      onClick={() => setConfirming(false)}
                    >
                      No, volver a editar
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Pantalla de éxito */}
          {submitted && (
            <div className="text-center py-12">
              <svg className="mx-auto mb-5 text-[#deb887]" width={60} height={60} fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="30" cy="30" r="28" stroke="#deb887" strokeWidth="4" />
                <path d="M18 30l8 8 16-16" stroke="#deb887" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <h3 className="text-2xl font-semibold mb-2 text-[#0d5c6c]">¡Horarios bloqueados!</h3>
              <p className="mb-6 text-gray-700">Los horarios han sido bloqueados exitosamente y no estarán disponibles para citas.</p>
              <button onClick={resetAll} className="bg-[#deb887] text-white py-2 px-6 rounded-lg font-bold">Bloquear más horarios</button>
            </div>
          )}

          {/* Bloqueos existentes */}
          {showExisting && !submitted && (
            <div className="mt-8 border-t pt-8">
              <h4 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-gray-600" />
                Bloqueos Existentes
              </h4>
              
              {existingBlocks.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No hay bloqueos programados</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {existingBlocks.map((block, index) => (
                    <div key={index} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="font-medium text-gray-800 mb-2">
                            {new Date(block.date).toLocaleDateString('es-ES', {
                              weekday: 'long',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric'
                            })}
                          </div>
                          <div className="text-sm text-gray-600 mb-1">
                            <span className="font-medium">Horarios:</span> {
                              block.hours.map(h => formatTimeLabel(h)).join(', ')
                            } ({block.hours.length} hora{block.hours.length !== 1 ? 's' : ''})
                          </div>
                          <div className="text-sm text-gray-600 mb-2">
                            <span className="font-medium">Motivo:</span> {block.reason}
                          </div>
                          <div className="text-xs text-gray-500">
                            Creado: {new Date(block.created).toLocaleDateString('es-ES')}
                            {block.events && block.events.length > 0 && (
                              <span className="ml-2">• {block.events.length} evento{block.events.length !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteBlock(block)}
                          className="text-red-500 hover:text-red-700 p-2 hover:bg-red-50 rounded-lg transition-colors ml-4"
                          title="Eliminar bloqueo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
};

export default AdminBlockSchedule;