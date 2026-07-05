// src/components/AdminAppointment.tsx
// Componente de agendamiento avanzado para administradores

import React, { useState, useEffect } from 'react';
import { Calendar, Clock, User, Phone, Mail, MessageSquare, Save, ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { services } from '../data/services';

// Helpers para español
const daysOfWeek = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Función para generar días desde una fecha específica
function getDaysFromDate(startDate: Date, count = 30) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    days.push({
      dayName: daysOfWeek[date.getDay()],
      dateNum: date.getDate(),
      month: months[date.getMonth()],
      year: date.getFullYear(),
      iso: [
        date.getFullYear(),
        (date.getMonth() + 1).toString().padStart(2, '0'),
        date.getDate().toString().padStart(2, '0')
      ].join('-')
    });
  }
  return days;
}

const allTimes = ['07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'];

type EventType = { start: string; end: string };
function isHourOccupied2h(selectedDay: string, hour: string, events: EventType[]): boolean {
  if (!selectedDay) return true;
  const startTime = new Date(selectedDay + 'T' + hour + ':00');
  const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000);
  return events.some(ev => {
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    return (startTime < evEnd && endTime > evStart);
  });
}

// Función para verificar si una hora ya pasó en el día actual
function isHourPast(selectedDay: string, hour: string): boolean {
  if (!selectedDay || !hour) return false;
  
  const today = new Date();
  
  // CORREGIDO: usar fechas locales en lugar de UTC para evitar problemas de zona horaria
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const selectedDate = new Date(selectedDay);
  
  // Formatear fechas como strings locales YYYY-MM-DD
  const todayString = `${todayLocal.getFullYear()}-${(todayLocal.getMonth() + 1).toString().padStart(2, '0')}-${todayLocal.getDate().toString().padStart(2, '0')}`;
  const selectedString = selectedDay; // Ya está en formato YYYY-MM-DD
  
  // Debug: mostrar las fechas que se están comparando
  console.log('🗓️ AdminAppointment - Comparando fechas (CORREGIDO):', { 
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
  
  // Crear tiempo de la cita
  const appointmentTime = new Date();
  appointmentTime.setHours(hourNum, minuteNum || 0, 0, 0);
  
  // Crear tiempo actual
  const currentTime = new Date();
  
  return appointmentTime <= currentTime;
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

const TIMEZONE = "-05:00"; // Ecuador

interface AdminAppointmentProps {
  onBack: () => void;
}

const AdminAppointment: React.FC<AdminAppointmentProps> = ({ onBack }) => {
  // Estado para navegación de fechas
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  
  // Estados del agendamiento
  const [step, setStep] = useState(1);
  const [selectedDay, setSelectedDay] = useState('');
  const [selectedHour, setSelectedHour] = useState('');
  const [events, setEvents] = useState<{ start: string, end: string }[]>([]);
  const [loadingHours, setLoadingHours] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    service: '',
    message: '',
    adminNotes: '', // Campo adicional para administradores
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  // Generar días para el mes/año seleccionado
  const getMonthDays = () => {
    const firstDay = new Date(selectedYear, selectedMonth, 1);
    const lastDay = new Date(selectedYear, selectedMonth + 1, 0);
    const daysInMonth = lastDay.getDate();
    return getDaysFromDate(firstDay, daysInMonth);
  };

  const days = getMonthDays();

  // Trae los eventos ocupados del backend cuando se selecciona un día
  useEffect(() => {
    if (!selectedDay) {
      setEvents([]);
      return;
    }
    setLoadingHours(true);
    fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'getEvents',
        date: selectedDay 
      }),
    })
      .then(res => res.json())
      .then(data => {
        setEvents(Array.isArray(data.occupiedTimes) ? data.occupiedTimes : []);
      })
      .catch(() => setEvents([]))
      .finally(() => setLoadingHours(false));
  }, [selectedDay]);

  useEffect(() => { setSelectedHour(''); }, [selectedDay]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const start = `${selectedDay}T${selectedHour}:00${TIMEZONE}`;
      const [h, m] = selectedHour.split(':').map(Number);
      let endHour = h + 2;
      let endDay = selectedDay;
      if (endHour >= 24) {
        endHour -= 24;
        const [year, month, day] = selectedDay.split('-').map(Number);
        const nextDate = new Date(year, month - 1, day + 1);
        endDay = [
          nextDate.getFullYear(),
          (nextDate.getMonth() + 1).toString().padStart(2, '0'),
          nextDate.getDate().toString().padStart(2, '0')
        ].join('-');
      }
      const pad = (n: number) => n.toString().padStart(2, '0');
      const end = `${endDay}T${pad(endHour)}:${pad(m)}:00${TIMEZONE}`;

      // Mensaje con notas del administrador
      const adminMessage = formData.adminNotes ? 
        `\n--- NOTAS DEL ADMINISTRADOR ---\n${formData.adminNotes}\n--- FIN NOTAS ---\n` : '';

      await fetch('/api/sendEmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          message:
            'Teléfono: ' + formData.phone + '\n' +
            'Email: ' + formData.email + '\n' +
            'Servicio: ' + formData.service + '\n' +
            'Fecha: ' + selectedDay + '\n' +
            'Hora: ' + selectedHour + ' (2 horas)' + '\n' +
            'Comentario del paciente: ' + formData.message + 
            adminMessage +
            '\n[AGENDADO POR ADMINISTRADOR]',
          start,
          end,
        }),
      });
      setSubmitted(true);
      setFormData({ name: '', email: '', phone: '', service: '', message: '', adminNotes: '' });
    } catch (e) {
      setError('Error al enviar');
    }
    setSubmitting(false);
  };

  const resetAll = () => {
    setStep(1);
    setSelectedDay('');
    setSelectedHour('');
    setFormData({ name: '', email: '', phone: '', service: '', message: '', adminNotes: '' });
    setSubmitted(false);
    setError('');
    setConfirming(false);
  };

  const navigateMonth = (direction: number) => {
    const newDate = new Date(selectedYear, selectedMonth + direction, 1);
    setSelectedMonth(newDate.getMonth());
    setSelectedYear(newDate.getFullYear());
    setSelectedDay(''); // Limpiar selección de día
  };

  const goToToday = () => {
    const today = new Date();
    setSelectedMonth(today.getMonth());
    setSelectedYear(today.getFullYear());
    setSelectedDay('');
  };

  return (
    <div className="max-w-6xl mx-auto bg-white rounded-lg shadow-lg p-6">
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
          <h2 className="text-2xl font-bold text-gray-800">Agendamiento Avanzado</h2>
        </div>
        <div className="text-sm text-gray-600">
          Modo Administrador - Sin límite de fechas
        </div>
      </div>

      {/* Wizard paso a paso */}
      {step === 1 && (
        <>
          {/* Navegación de mes/año */}
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => navigateMonth(-1)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Mes Anterior
            </button>
            
            <div className="text-center">
              <h3 className="text-xl font-bold text-[#0d5c6c]">
                {months[selectedMonth]} {selectedYear}
              </h3>
              <button
                onClick={goToToday}
                className="text-sm text-[#deb887] hover:text-[#d4a574] mt-1"
              >
                Ir a hoy
              </button>
            </div>
            
            <button
              onClick={() => navigateMonth(1)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              Mes Siguiente
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">1. Selecciona el día</h4>
          
          {/* Grid de días */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-3 mb-8">
            {days.map(d => {
              // Bloquear días ANTERIORES al día actual (no incluir hoy)
              const today = new Date();
              const todayString = today.toISOString().split('T')[0]; // YYYY-MM-DD
              const dayString = d.iso; // Ya está en formato YYYY-MM-DD
              const isPast = dayString < todayString; // Solo días anteriores a hoy
              
              return (
                <button
                  key={d.iso}
                  onClick={() => !isPast && setSelectedDay(d.iso)}
                  disabled={isPast}
                  className={`text-center rounded-xl border-2 p-4 transition-all duration-200 min-h-[100px]
                    ${selectedDay === d.iso 
                      ? 'bg-[#ffcfc4] text-[#0d5c6c] border-[#fa9271] shadow-lg scale-105' 
                      : isPast 
                        ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-50'
                        : 'bg-white text-[#0d5c6c] border-[#dde7eb] hover:bg-[#ffe2db]'}
                  `}
                >
                  <span className="block font-semibold italic text-sm">{d.dayName}</span>
                  <span className="block text-2xl font-bold mt-1">{d.dateNum}</span>
                  <span className="block text-xs">{d.month}</span>
                  {isPast && <span className="block text-xs mt-1">Pasado</span>}
                </button>
              );
            })}
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
          <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">2. Selecciona la hora (2 horas de cita)</h4>
          <div className="mb-4 text-center text-sm text-gray-600">
            Fecha seleccionada: {selectedDay && (() => {
              const [year, month, day] = selectedDay.split('-').map(Number);
              const dateObj = new Date(year, month - 1, day);
              return `${daysOfWeek[dateObj.getDay()]} ${day} de ${months[month - 1]} ${year}`;
            })()}
          </div>
          
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
            {loadingHours ? (
              <div className="text-center col-span-full w-full">Cargando horarios...</div>
            ) : (
              allTimes.map(h => {
                const isOccupied = isHourOccupied2h(selectedDay, h, events);
                const isPast = isHourPast(selectedDay, h);
                const isDisabled = isOccupied || isPast;
                
                return (
                  <button
                    key={h}
                    disabled={isDisabled}
                    onClick={() => setSelectedHour(h)}
                    className={`rounded-xl p-4 border-2 text-[#0d5c6c] flex flex-col items-center transition-all duration-150
                      ${selectedHour === h 
                        ? 'bg-[#ffcfc4] border-[#fa9271] font-bold shadow-lg scale-105' 
                        : 'bg-white border-[#dde7eb] hover:bg-[#ffe2db]'}
                      ${isDisabled ? 'opacity-30 cursor-not-allowed' : ''}
                    `}
                  >
                    <Clock className="w-5 h-5 mb-2" />
                    <span className="text-lg font-semibold">{formatTimeLabel(h)}</span>
                    {isOccupied && <span className="text-xs text-red-500 mt-1">Ocupado</span>}
                    {isPast && !isOccupied && <span className="text-xs text-gray-500 mt-1">Pasado</span>}
                  </button>
                );
              })
            )}
          </div>
          
          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="px-6 py-2 rounded-lg bg-[#fa9271] text-white font-bold shadow"
            >
              Volver
            </button>
            <button
              disabled={!selectedHour}
              onClick={() => setStep(3)}
              className={`px-6 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow ${!selectedHour ? 'opacity-50' : ''}`}
            >
              Siguiente
            </button>
          </div>
        </>
      )}

      {/* Paso 3 - Formulario */}
      {step === 3 && !submitted && (
        <>
          {!confirming ? (
            <>
              <h4 className="text-lg font-semibold mb-5 text-[#0d5c6c] text-center">3. Datos del paciente</h4>
              <form onSubmit={e => {
                e.preventDefault();
                setConfirming(true);
              }} className="space-y-4 max-w-2xl mx-auto">
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="relative">
                    <User className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                    <input
                      name="name" 
                      placeholder="Nombre completo" 
                      required
                      value={formData.name}
                      onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
                      className="w-full pl-10 p-3 rounded border border-gray-200 focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887] focus:ring-opacity-20"
                    />
                  </div>
                  
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                    <input
                      name="email" 
                      type="email" 
                      placeholder="Correo electrónico" 
                      required
                      value={formData.email}
                      onChange={e => setFormData(f => ({ ...f, email: e.target.value }))}
                      className="w-full pl-10 p-3 rounded border border-gray-200 focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887] focus:ring-opacity-20"
                    />
                  </div>
                </div>

                <div className="relative">
                  <Phone className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <input
                    name="phone" 
                    type="tel" 
                    placeholder="Teléfono" 
                    required
                    value={formData.phone}
                    onChange={e => setFormData(f => ({ ...f, phone: e.target.value }))}
                    className="w-full pl-10 p-3 rounded border border-gray-200 focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887] focus:ring-opacity-20"
                  />
                </div>

                <select
                  name="service"
                  required
                  value={formData.service}
                  onChange={e => setFormData(f => ({ ...f, service: e.target.value }))}
                  className="w-full p-3 rounded border border-gray-200 bg-white focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887] focus:ring-opacity-20"
                >
                  <option value="">Selecciona un servicio</option>
                  <option value="OTRO">OTRO</option>
                  {services.map(service => (
                    <option key={service.id} value={service.title}>
                      {service.title}
                    </option>
                  ))}
                </select>

                <div className="relative">
                  <MessageSquare className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <textarea
                    name="message" 
                    placeholder="Comentarios del paciente (opcional)" 
                    rows={3}
                    value={formData.message}
                    onChange={e => setFormData(f => ({ ...f, message: e.target.value }))}
                    className="w-full pl-10 p-3 rounded border border-gray-200 focus:border-[#deb887] focus:ring-2 focus:ring-[#deb887] focus:ring-opacity-20"
                  />
                </div>

                {/* Campo especial para administradores */}
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <label className="block text-sm font-medium text-yellow-800 mb-2">
                    Notas del Administrador (privadas)
                  </label>
                  <textarea
                    name="adminNotes" 
                    placeholder="Notas internas, observaciones especiales, etc." 
                    rows={2}
                    value={formData.adminNotes}
                    onChange={e => setFormData(f => ({ ...f, adminNotes: e.target.value }))}
                    className="w-full p-3 rounded border border-yellow-300 focus:border-yellow-500 focus:ring-2 focus:ring-yellow-500 focus:ring-opacity-20"
                  />
                </div>

                {error && <div className="text-red-600 mb-2">{error}</div>}
                
                <div className="flex justify-between mt-6">
                  <button
                    onClick={() => setStep(2)}
                    className="px-6 py-2 rounded-lg bg-[#fa9271] text-white font-bold shadow"
                    type="button"
                  >
                    Volver
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="px-6 py-2 rounded-lg bg-[#deb887] text-white font-bold shadow"
                  >
                    {submitting ? 'Procesando...' : 'Revisar cita'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            // Confirmación
            <div className="max-w-2xl mx-auto">
              <div className="bg-gradient-to-r from-[#deb887] to-[#d4a574] text-white p-6 rounded-t-lg">
                <h4 className="text-xl font-semibold flex items-center gap-2">
                  <Save className="w-6 h-6" />
                  Confirmar Agendamiento
                </h4>
              </div>
              
              <div className="bg-gray-50 p-6 rounded-b-lg">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                  <div className="space-y-3">
                    <div>
                      <span className="font-semibold text-gray-700">Fecha:</span>
                      <p className="text-gray-900">
                        {selectedDay && (() => {
                          const [year, month, day] = selectedDay.split('-').map(Number);
                          const dateObj = new Date(year, month - 1, day);
                          return `${daysOfWeek[dateObj.getDay()]} ${day} de ${months[month - 1]} ${year}`;
                        })()}
                      </p>
                    </div>
                    
                    <div>
                      <span className="font-semibold text-gray-700">Hora:</span>
                      <p className="text-gray-900">{selectedHour && formatTimeLabel(selectedHour)} (2 horas)</p>
                    </div>
                    
                    <div>
                      <span className="font-semibold text-gray-700">Servicio:</span>
                      <p className="text-gray-900">{formData.service}</p>
                    </div>
                  </div>
                  
                  <div className="space-y-3">
                    <div>
                      <span className="font-semibold text-gray-700">Paciente:</span>
                      <p className="text-gray-900">{formData.name}</p>
                    </div>
                    
                    <div>
                      <span className="font-semibold text-gray-700">Email:</span>
                      <p className="text-gray-900">{formData.email}</p>
                    </div>
                    
                    <div>
                      <span className="font-semibold text-gray-700">Teléfono:</span>
                      <p className="text-gray-900">{formData.phone}</p>
                    </div>
                  </div>
                </div>
                
                {formData.message && (
                  <div className="mb-4">
                    <span className="font-semibold text-gray-700">Comentarios del paciente:</span>
                    <p className="text-gray-900 bg-white p-3 rounded border">{formData.message}</p>
                  </div>
                )}
                
                {formData.adminNotes && (
                  <div className="mb-4">
                    <span className="font-semibold text-yellow-700">Notas del administrador:</span>
                    <p className="text-yellow-900 bg-yellow-100 p-3 rounded border border-yellow-300">{formData.adminNotes}</p>
                  </div>
                )}
                
                <div className="flex flex-col sm:flex-row gap-4 justify-center mt-6">
                  <button
                    className="px-8 py-3 rounded-lg bg-[#deb887] text-white font-bold shadow-lg hover:bg-[#d4a574] transition-colors"
                    onClick={async e => {
                      e.preventDefault();
                      await handleSubmit(e);
                      setConfirming(false);
                    }}
                    disabled={submitting}
                  >
                    {submitting ? 'Agendando...' : 'Confirmar y Agendar'}
                  </button>
                  <button
                    className="px-8 py-3 rounded-lg bg-gray-200 text-gray-700 font-bold shadow hover:bg-gray-300 transition-colors"
                    onClick={e => {
                      e.preventDefault();
                      setConfirming(false);
                    }}
                  >
                    Volver a editar
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Confirmación de éxito */}
      {step === 3 && submitted && (
        <div className="text-center py-12 max-w-2xl mx-auto">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <Save className="w-10 h-10 text-green-600" />
          </div>
          
          <h3 className="text-2xl font-semibold mb-4 text-[#0d5c6c]">¡Cita agendada exitosamente!</h3>
          
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
            <p className="text-green-800 font-medium">
              La cita ha sido registrada en el calendario y se ha enviado la confirmación por email.
            </p>
            <p className="text-green-700 text-sm mt-2">
              El paciente recibirá también una notificación por WhatsApp.
            </p>
          </div>
          
          <div className="space-y-3 mb-6">
            <button 
              onClick={resetAll} 
              className="w-full sm:w-auto px-6 py-3 rounded-lg bg-[#deb887] text-white font-bold shadow-lg hover:bg-[#d4a574] transition-colors"
            >
              Agendar otra cita
            </button>
            <button 
              onClick={onBack}
              className="w-full sm:w-auto px-6 py-3 rounded-lg bg-gray-200 text-gray-700 font-bold shadow hover:bg-gray-300 transition-colors ml-0 sm:ml-4"
            >
              Volver al Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminAppointment;