// src/components/AdminCalendar.tsx
// Componente para visualizar la agenda desde Google Calendar

import React, { useState, useEffect } from 'react';
import { Calendar, Clock, User, Phone, Mail, ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Grid, List } from 'lucide-react';

// Helpers para español
const daysOfWeek = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
}

interface AdminCalendarProps {
  onBack: () => void;
}

type ViewMode = 'month' | 'week';

const AdminCalendar: React.FC<AdminCalendarProps> = ({ onBack }) => {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [monthEvents, setMonthEvents] = useState<{[key: string]: CalendarEvent[]}>({});
  
  // Generar días del mes actual
  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();
    
    const days = [];
    
    // Días vacíos al inicio
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(null);
    }
    
    // Días del mes
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(new Date(year, month, day));
    }
    
    return days;
  };

  // Generar días de la semana actual
  const getWeekDays = (date: Date) => {
    const startOfWeek = new Date(date);
    const day = startOfWeek.getDay();
    startOfWeek.setDate(startOfWeek.getDate() - day);
    
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const weekDay = new Date(startOfWeek);
      weekDay.setDate(startOfWeek.getDate() + i);
      weekDays.push(weekDay);
    }
    
    return weekDays;
  };

  const days = viewMode === 'month' ? getDaysInMonth(selectedDate) : getWeekDays(selectedDate);

  // Obtener eventos de Google Calendar para el día seleccionado
  const fetchEventsForDate = async (date: Date) => {
    if (!date) return;
    
    const dateString = date.toISOString().split('T')[0];
    
    // Primero verificar si ya tenemos los datos en monthEvents
    if (monthEvents[dateString]) {
      console.log(`📋 Usando eventos cacheados para ${dateString}`);
      setEvents(monthEvents[dateString]);
      return;
    }
    
    // Si no están cacheados, cargar individualmente
    setLoading(true);
    setError('');
    
    try {
      console.log(`🔄 Cargando eventos para ${dateString}...`);
      const response = await fetch('/api/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'getEvents',
          date: dateString 
        }),
      });
      
      const data = await response.json();
      
      if (data.events && Array.isArray(data.events)) {
        setEvents(data.events);
        console.log(`✅ ${data.events.length} eventos cargados para ${dateString}`);
      } else {
        setEvents([]);
        console.log(`ℹ️ No hay eventos para ${dateString}`);
      }
    } catch (err) {
      console.error('❌ Error fetching events:', err);
      setError('Error al cargar los eventos del calendario');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  // Obtener eventos de todo el mes para mostrar indicadores
  const fetchMonthEvents = async (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const lastDay = new Date(year, month + 1, 0);
    
    setLoadingMonth(true);
    setError('');
    const monthEventsMap: {[key: string]: CalendarEvent[]} = {};
    
    try {
      console.log(`🗓️ Cargando eventos para ${months[month]} ${year}...`);
      
      // Obtener eventos día por día para el mes completo
      const promises = [];
      for (let day = 1; day <= lastDay.getDate(); day++) {
        const currentDate = new Date(year, month, day);
        const dateString = currentDate.toISOString().split('T')[0];
        
        // Crear promesa para cada día
        promises.push(
          fetch('/api/calendar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              action: 'getEvents',
              date: dateString 
            }),
          })
          .then(response => response.json())
          .then(data => {
            if (data.events && Array.isArray(data.events) && data.events.length > 0) {
              monthEventsMap[dateString] = data.events;
              return { date: dateString, count: data.events.length };
            }
            return null;
          })
          .catch(err => {
            console.error(`❌ Error fetching events for ${dateString}:`, err);
            return null;
          })
        );
      }
      
      // Esperar a que todas las promesas se resuelvan
      const results = await Promise.all(promises);
      const validResults = results.filter(result => result !== null);
      
      console.log(`✅ Eventos cargados: ${validResults.length} días con citas en ${months[month]} ${year}`);
      validResults.forEach(result => {
        console.log(`📅 ${result.date}: ${result.count} eventos`);
      });
      
      setMonthEvents(monthEventsMap);
      
      // Actualizar eventos del día seleccionado si está en este mes
      const selectedDateString = selectedDate.toISOString().split('T')[0];
      if (monthEventsMap[selectedDateString]) {
        setEvents(monthEventsMap[selectedDateString]);
      } else if (selectedDate.getMonth() === month && selectedDate.getFullYear() === year) {
        setEvents([]);
      }
      
    } catch (err) {
      console.error('❌ Error general cargando eventos del mes:', err);
      setError('Error al cargar los eventos del mes');
    } finally {
      setLoadingMonth(false);
    }
  };

  // Cargar eventos del mes cuando cambia el mes o el modo de vista
  useEffect(() => {
    console.log(`🔄 Mes/año cambiado: ${months[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`);
    fetchMonthEvents(selectedDate);
  }, [selectedDate.getMonth(), selectedDate.getFullYear()]);

  // Cargar eventos del día cuando cambia la fecha seleccionada (solo si no están ya cargados)
  useEffect(() => {
    const dateString = selectedDate.toISOString().split('T')[0];
    if (monthEvents[dateString]) {
      // Si ya tenemos los eventos del mes, usar esos datos
      console.log(`📋 Eventos ya disponibles para ${dateString}`);
      setEvents(monthEvents[dateString]);
    } else {
      // Si no tenemos los datos del mes aún, cargar individualmente
      fetchEventsForDate(selectedDate);
    }
  }, [selectedDate, monthEvents]);

  // Navegar entre meses/semanas
  const navigateMonth = (direction: number) => {
    const newDate = new Date(selectedDate);
    const oldMonth = newDate.getMonth();
    const oldYear = newDate.getFullYear();
    
    if (viewMode === 'month') {
      newDate.setMonth(newDate.getMonth() + direction);
    } else {
      newDate.setDate(newDate.getDate() + (direction * 7));
    }
    
    const newMonth = newDate.getMonth();
    const newYear = newDate.getFullYear();
    
    // Si cambiamos de mes/año, limpiar eventos cacheados
    if (oldMonth !== newMonth || oldYear !== newYear) {
      console.log(`🗂️ Limpiando cache: ${months[oldMonth]} ${oldYear} → ${months[newMonth]} ${newYear}`);
      setMonthEvents({});
      setEvents([]);
    }
    
    setSelectedDate(newDate);
  };

  // Ir a hoy
  const goToToday = () => {
    const today = new Date();
    const currentMonth = selectedDate.getMonth();
    const currentYear = selectedDate.getFullYear();
    const todayMonth = today.getMonth();
    const todayYear = today.getFullYear();
    
    // Si cambiamos de mes/año, limpiar cache
    if (currentMonth !== todayMonth || currentYear !== todayYear) {
      console.log(`🏠 Ir a hoy: ${months[currentMonth]} ${currentYear} → ${months[todayMonth]} ${todayYear}`);
      setMonthEvents({});
      setEvents([]);
    }
    
    setSelectedDate(today);
  };

  // Formatear hora
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('es-ES', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  // Formatear fecha
  const formatDate = (date: Date) => {
    return `${daysOfWeek[date.getDay()]} ${date.getDate()} de ${months[date.getMonth()]} ${date.getFullYear()}`;
  };

  // Verificar si una fecha tiene eventos
  const hasEvents = (date: Date) => {
    if (!date) return false;
    const dateString = date.toISOString().split('T')[0];
    const events = monthEvents[dateString];
    const hasEventsResult = events && events.length > 0;
    
    // Debug: log para verificar
    if (hasEventsResult) {
      console.log(`Día ${dateString} tiene ${events.length} eventos:`, events);
    }
    
    return hasEventsResult;
  };

  // Obtener número de eventos para una fecha
  const getEventCount = (date: Date) => {
    if (!date) return 0;
    const dateString = date.toISOString().split('T')[0];
    const events = monthEvents[dateString];
    return events ? events.length : 0;
  };

  // Extraer información del paciente de la descripción del evento
  const parseEventDescription = (description: string = '') => {
    const lines = description.split('\n');
    let phone = '';
    let email = '';
    let service = '';
    let notes = '';
    
    lines.forEach(line => {
      if (line.startsWith('Teléfono:')) {
        phone = line.replace('Teléfono:', '').trim();
      } else if (line.startsWith('Correo:') || line.includes('@')) {
        email = line.replace('Correo:', '').trim();
      } else if (line.startsWith('Servicio:')) {
        service = line.replace('Servicio:', '').trim();
      } else if (line.includes('Comentario adicional:')) {
        notes = line.replace('Comentario adicional:', '').trim();
      }
    });
    
    return { phone, email, service, notes };
  };

  return (
    <div className="max-w-7xl mx-auto bg-white rounded-lg shadow-lg p-6 relative">
      {/* Overlay de carga para escritorio */}
      {(loading || loadingMonth) && (
        <div className="absolute inset-0 bg-white bg-opacity-95 flex items-center justify-center z-50 rounded-lg">
          <div className="text-center">
            <RefreshCw className="w-12 h-12 text-[#deb887] animate-spin mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-800 mb-2">
              {loadingMonth ? 'Cargando Calendario' : 'Obteniendo Eventos'}
            </h3>
            <p className="text-gray-600">
              {loadingMonth 
                ? `Obteniendo eventos de ${months[selectedDate.getMonth()]} ${selectedDate.getFullYear()}...`
                : 'Cargando eventos del día seleccionado...'
              }
            </p>
            <div className="mt-4 w-64 bg-gray-200 rounded-full h-2 mx-auto">
              <div className="bg-[#deb887] h-2 rounded-full animate-pulse transition-all duration-300" 
                   style={{width: loadingMonth ? '70%' : '40%'}}></div>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              {loadingMonth ? 'Esto puede tomar unos segundos...' : 'Casi listo...'}
            </p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-[#deb887] hover:text-[#d4a574] font-medium"
          >
            <ArrowLeft className="w-5 h-5" />
            Volver al Dashboard
          </button>
          <div className="h-6 w-px bg-gray-300"></div>
          <h2 className="text-2xl font-bold text-gray-800">Visualizar Agenda</h2>
        </div>
        <div className="flex items-center gap-4">
          {/* Selector de vista */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('month')}
              className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
                viewMode === 'month' 
                  ? 'bg-white text-[#deb887] shadow-sm' 
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <Grid className="w-4 h-4" />
              Mes
            </button>
            <button
              onClick={() => setViewMode('week')}
              className={`flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
                viewMode === 'week' 
                  ? 'bg-white text-[#deb887] shadow-sm' 
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <List className="w-4 h-4" />
              Semana
            </button>
          </div>
          <button
            onClick={() => {
              console.log('🔄 Actualizando calendario...');
              // Recargar todo el mes (esto también actualizará el día seleccionado)
              fetchMonthEvents(selectedDate);
            }}
            disabled={loading || loadingMonth}
            className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#d4a574] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${(loading || loadingMonth) ? 'animate-spin' : ''}`} />
            {(loading || loadingMonth) ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Calendario */}
        <div className="bg-gray-50 rounded-lg p-6">
          {/* Banner de carga adicional */}
          {loadingMonth && (
            <div className="mb-4 p-3 bg-[#deb887] bg-opacity-10 border border-[#deb887] rounded-lg flex items-center justify-center">
              <RefreshCw className="w-4 h-4 text-[#deb887] animate-spin mr-2" />
              <span className="text-[#deb887] font-medium">
                Cargando eventos de {months[selectedDate.getMonth()]} {selectedDate.getFullYear()}...
              </span>
            </div>
          )}
          
          {/* Navegación de mes/semana */}
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => navigateMonth(-1)}
              className="flex items-center gap-2 px-3 py-2 bg-white hover:bg-gray-100 rounded-lg transition-colors border"
            >
              <ChevronLeft className="w-4 h-4" />
              {viewMode === 'month' ? 'Mes Anterior' : 'Semana Anterior'}
            </button>
            
            <div className="text-center">
              <h3 className="text-xl font-bold text-gray-800">
                {viewMode === 'month' 
                  ? `${months[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`
                  : `Semana del ${getWeekDays(selectedDate)[0].getDate()} - ${getWeekDays(selectedDate)[6].getDate()} ${months[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`
                }
              </h3>
              <button
                onClick={goToToday}
                className="text-sm text-[#deb887] hover:text-[#d4a574] mt-1"
              >
                Ir a hoy
              </button>
              {viewMode === 'month' && (
                <div className="text-xs text-gray-500 mt-1">
                  {loadingMonth 
                    ? '⏳ Cargando eventos del mes...'
                    : `${Object.keys(monthEvents).filter(date => monthEvents[date].length > 0).length} días con citas`
                  }
                </div>
              )}
            </div>
            
            <button
              onClick={() => navigateMonth(1)}
              className="flex items-center gap-2 px-3 py-2 bg-white hover:bg-gray-100 rounded-lg transition-colors border"
            >
              {viewMode === 'month' ? 'Mes Siguiente' : 'Semana Siguiente'}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Grid del calendario */}
          <div className="grid grid-cols-7 gap-1 mb-4">
            {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map(day => (
              <div key={day} className="text-center text-sm font-semibold text-gray-600 p-2">
                {day}
              </div>
            ))}
          </div>

          <div className={`grid grid-cols-7 gap-1 ${viewMode === 'week' ? 'auto-rows-fr' : ''}`}>
            {viewMode === 'month' ? (
              // Vista mensual
              days.map((day, index) => (
                <button
                  key={index}
                  onClick={() => day && setSelectedDate(day)}
                  disabled={!day || loadingMonth}
                  className={`h-12 text-sm font-medium rounded transition-colors relative ${
                    !day 
                      ? 'invisible' 
                      : loadingMonth
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed animate-pulse'
                      : day.toDateString() === selectedDate.toDateString()
                      ? 'bg-[#deb887] text-white'
                      : day.toDateString() === new Date().toDateString()
                      ? 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                      : hasEvents(day)
                      ? 'bg-red-50 hover:bg-red-100 text-gray-700 border-2 border-red-300'
                      : 'bg-white hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  {day?.getDate()}
                  {day && !loadingMonth && hasEvents(day) && (
                    <div className="absolute top-1 right-1 flex items-center">
                      <div className="w-3 h-3 bg-red-500 rounded-full flex items-center justify-center">
                        <span className="text-white text-xs font-bold" style={{ fontSize: '8px', lineHeight: '1' }}>
                          {getEventCount(day)}
                        </span>
                      </div>
                    </div>
                  )}
                  {day && loadingMonth && (
                    <div className="absolute top-1 right-1">
                      <div className="w-3 h-3 bg-gray-300 rounded-full animate-pulse"></div>
                    </div>
                  )}
                </button>
              ))
            ) : (
              // Vista semanal
              days.filter(day => day !== null).map((day, index) => {
                const dayEvents = monthEvents[day!.toISOString().split('T')[0]] || [];
                return (
                  <div
                    key={index}
                    className={`border rounded-lg p-2 min-h-[120px] ${
                      day!.toDateString() === selectedDate.toDateString()
                        ? 'bg-[#ffcfc4] border-[#fa9271]'
                        : day!.toDateString() === new Date().toDateString()
                        ? 'bg-blue-50 border-blue-200'
                        : 'bg-white border-gray-200'
                    } cursor-pointer hover:bg-gray-50 transition-colors`}
                    onClick={() => setSelectedDate(day!)}
                  >
                    <div className="text-sm font-semibold text-gray-800 mb-2">
                      {day!.getDate()}
                    </div>
                    <div className="space-y-1">
                      {dayEvents.slice(0, 3).map((event, eventIndex) => (
                        <div
                          key={eventIndex}
                          className="text-xs bg-[#deb887] text-white rounded px-2 py-1 truncate"
                          title={event.summary}
                        >
                          {formatTime(event.start)} {event.summary}
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="text-xs text-gray-500">
                          +{dayEvents.length - 3} más
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Lista de eventos */}
        <div className="bg-gray-50 rounded-lg p-6">
          <div className="flex items-center gap-3 mb-6">
            <Calendar className="w-6 h-6 text-[#deb887]" />
            <h3 className="text-xl font-bold text-gray-800">
              Agenda del {formatDate(selectedDate)}
            </h3>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-6 h-6 text-[#deb887] animate-spin mr-2" />
              <span className="text-gray-600">Cargando eventos...</span>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <div className="text-red-600 mb-2">{error}</div>
              <button
                onClick={() => fetchEventsForDate(selectedDate)}
                className="text-[#deb887] hover:text-[#d4a574] font-medium"
              >
                Intentar nuevamente
              </button>
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p>No hay citas programadas para este día</p>
            </div>
          ) : (
            <div className="space-y-4 max-h-96 overflow-y-auto">
              {events.map((event, index) => {
                const eventInfo = parseEventDescription(event.description);
                return (
                  <div
                    key={event.id || index}
                    className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-[#deb887]" />
                        <span className="font-semibold text-gray-800">
                          {formatTime(event.start)} - {formatTime(event.end)}
                        </span>
                      </div>
                    </div>
                    
                    <h4 className="font-semibold text-gray-800 mb-2">
                      {event.summary || 'Cita sin título'}
                    </h4>
                    
                    {eventInfo.service && (
                      <div className="flex items-center gap-2 mb-2">
                        <User className="w-4 h-4 text-gray-500" />
                        <span className="text-sm text-gray-600">
                          <strong>Servicio:</strong> {eventInfo.service}
                        </span>
                      </div>
                    )}
                    
                    {eventInfo.phone && (
                      <div className="flex items-center gap-2 mb-2">
                        <Phone className="w-4 h-4 text-gray-500" />
                        <span className="text-sm text-gray-600">
                          <strong>Teléfono:</strong> {eventInfo.phone}
                        </span>
                      </div>
                    )}
                    
                    {eventInfo.email && (
                      <div className="flex items-center gap-2 mb-2">
                        <Mail className="w-4 h-4 text-gray-500" />
                        <span className="text-sm text-gray-600">
                          <strong>Email:</strong> {eventInfo.email}
                        </span>
                      </div>
                    )}
                    
                    {eventInfo.notes && (
                      <div className="mt-3 p-3 bg-gray-50 rounded text-sm text-gray-600">
                        <strong>Notas:</strong> {eventInfo.notes}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminCalendar;