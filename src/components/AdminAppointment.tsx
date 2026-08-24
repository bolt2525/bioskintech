// src/components/AdminAppointment.tsx
// Componente de agendamiento avanzado para administradores

import React, { useState, useEffect } from 'react';
import { Calendar, Clock, User, Phone, Mail, MessageSquare, Save, ArrowLeft, ChevronLeft, ChevronRight, UserCheck, MessageCircle, X, CheckSquare, Square, AlertTriangle } from 'lucide-react';
import recordsFetch from '../utils/recordsFetch';
import { services } from '../data/services';
import { useAuth } from '../context/AuthContext';

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

// Generates time slots at slotMinutes intervals between startHour and endHour
function generateTimeSlots(startHour: string, endHour: string, slotMinutes: number): string[] {
  const [sH, sM] = startHour.split(':').map(Number);
  const [eH, eM] = endHour.split(':').map(Number);
  const endTotal = eH * 60 + eM;
  const slots: string[] = [];
  let total = sH * 60 + sM;
  while (total < endTotal) {
    const h = Math.floor(total / 60), m = total % 60;
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    total += slotMinutes;
  }
  return slots;
}

type EventType = { start: string; end: string };
// ponytail: endHour param blocks slots that would overflow business hours
function isHourOccupied(selectedDay: string, hour: string, events: EventType[], slotMinutes: number): boolean {
  if (!selectedDay) return true;
  const startTime = new Date(selectedDay + 'T' + hour + ':00');
  const endTime = new Date(startTime.getTime() + slotMinutes * 60 * 1000);
  return events.some(ev => {
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    return (startTime < evEnd && endTime > evStart);
  });
}

/** Returns true if the appointment end time exceeds the clinic closing hour. */
function isOverflow(selectedDay: string, hour: string, slotMinutes: number, endHour: string): boolean {
  if (!selectedDay || !endHour) return false;
  const startTime = new Date(selectedDay + 'T' + hour + ':00');
  const endTime = new Date(startTime.getTime() + slotMinutes * 60 * 1000);
  const dayEnd = new Date(selectedDay + 'T' + endHour + ':00');
  return endTime > dayEnd;
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
  const { user } = useAuth();

  // Tratamientos desde configuración de clínica (fallback al catálogo global)
  const [clinicTreatments, setClinicTreatments] = useState<string[]>([]);
  // Profesionales del sistema para asignar a la cita
  const [clinicProfessionals, setClinicProfessionals] = useState<Array<{ id: number; username: string; full_name: string; email: string; especialidad?: string; gentilicio?: string }>>([]);
  // Staff members externos (sin login) desde clinic_settings
  const [externalStaff, setExternalStaff] = useState<Array<{ name: string; email: string }>>([]);
  // Correos CC personales del usuario logueado
  const [personalEmails, setPersonalEmails] = useState<string[]>([]);
  const [selectedPersonalEmails, setSelectedPersonalEmails] = useState<string[]>([]);
  const [notifyPersonalStaff, setNotifyPersonalStaff] = useState(false);
  // Selector de profesional
  const [showProfessionalModal, setShowProfessionalModal] = useState(false);
  const [showStaffEmailModal, setShowStaffEmailModal]     = useState(false);
  // Agenda settings from clinic config
  const [agendaSlotMinutes, setAgendaSlotMinutes] = useState(60);
  const [agendaStartHour, setAgendaStartHour]     = useState('07:00');
  const [agendaEndHour, setAgendaEndHour]         = useState('20:00');
  // Duration selected for this specific appointment (independent of display interval)
  const [appointmentDuration, setAppointmentDuration] = useState(30);
  const [hourClearedMsg, setHourClearedMsg]           = useState('');
  const [gmailNotConfigured, setGmailNotConfigured]   = useState(false);

  useEffect(() => {
    if (!user?.clinic_id) return;
    // Verificar que la clínica tenga Gmail OAuth conectado antes de mostrar el formulario
    recordsFetch(`/api/calendar?action=health&clinicId=${user.clinic_id}`)
      .then(r => r.json())
      .then(d => { if (!d.hasOAuth) setGmailNotConfigured(true); })
      .catch(() => setGmailNotConfigured(true));
    Promise.all([
      fetch(`/api/admin-auth?action=getClinicSettings&clinicId=${user.clinic_id}`, {
        headers: { 'Authorization': `Bearer ${sessionStorage.getItem('adminSessionToken')}` }
      }).then(r => r.json()),
      fetch('/api/admin-auth?action=getClinicProfessionals', {
        headers: { 'Authorization': `Bearer ${sessionStorage.getItem('adminSessionToken')}` }
      }).then(r => r.json()),
      fetch('/api/admin-auth?action=getPersonalStaffEmails', {
        headers: { 'Authorization': `Bearer ${sessionStorage.getItem('adminSessionToken')}` }
      }).then(r => r.json()),
    ]).then(([settings, professionals, staffEmails]) => {
      if (settings.settings?.treatments?.length) setClinicTreatments(settings.settings.treatments);
      if (settings.settings?.email?.staff_members?.length) setExternalStaff(settings.settings.email.staff_members);
      if (settings.settings?.agenda?.slot_minutes) {
        setAgendaSlotMinutes(settings.settings.agenda.slot_minutes);
        // ponytail: keep duration default at 30 regardless of clinic slot setting
      }
      if (settings.settings?.agenda?.start_hour)   setAgendaStartHour(settings.settings.agenda.start_hour);
      if (settings.settings?.agenda?.end_hour)     setAgendaEndHour(settings.settings.agenda.end_hour);
      if (professionals.professionals) setClinicProfessionals(professionals.professionals);
      if (staffEmails.emails?.length)  { setPersonalEmails(staffEmails.emails); setSelectedPersonalEmails(staffEmails.emails); setNotifyPersonalStaff(true); }
    }).catch(() => {});
  }, [user?.clinic_id]);
  // Display slots always every 30 min; occupancy check uses the selected appointment duration
  const availableTimes = generateTimeSlots(agendaStartHour, agendaEndHour, 30);
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
    adminNotes: '',
    selected_doctor: user?.full_name || user?.username || '', // default: usuario logueado
    selected_doctor_email: user?.email || '',
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
    recordsFetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'getEvents',
        date: selectedDay,
        clinicId: user?.clinic_id,
      }),
    })
      .then(res => res.json())
      .then(data => {
        setEvents(Array.isArray(data.occupiedTimes) ? data.occupiedTimes : []);
      })
      .catch(() => setEvents([]))
      .finally(() => setLoadingHours(false));
  }, [selectedDay]);

  useEffect(() => { setSelectedHour(''); setHourClearedMsg(''); }, [selectedDay]);

  // When duration changes: clear hour if now occupied by events; show reason message
  useEffect(() => {
    if (!selectedHour || !selectedDay) return;
    const dLabel = appointmentDuration < 60 ? `${appointmentDuration} min`
      : appointmentDuration === 60 ? '1 h' : appointmentDuration === 90 ? '1:30 h' : '2 h';
    if (isHourOccupied(selectedDay, selectedHour, events, appointmentDuration) ||
        isHourPast(selectedDay, selectedHour)) {
      setHourClearedMsg(`⚠️ ${formatTimeLabel(selectedHour)} ya no está disponible para ${dLabel}. Selecciona otra hora.`);
      setSelectedHour('');
    }
    // Overflow is handled with an inline warning — hour stays selected
  }, [appointmentDuration]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const start = `${selectedDay}T${selectedHour}:00${TIMEZONE}`;
      const pad = (n: number) => n.toString().padStart(2, '0');
      const endMs = new Date(`${selectedDay}T${selectedHour}:00`).getTime() + appointmentDuration * 60 * 1000;
      const endObj = new Date(endMs);
      const endDay = `${endObj.getFullYear()}-${pad(endObj.getMonth()+1)}-${pad(endObj.getDate())}`;
      const end = `${endDay}T${pad(endObj.getHours())}:${pad(endObj.getMinutes())}:00${TIMEZONE}`;
      const durationLabel = appointmentDuration >= 60
        ? `${appointmentDuration / 60}h`
        : `${appointmentDuration} min`;

      // Mensaje con notas del administrador
      const adminMessage = formData.adminNotes ? 
        `\n--- NOTAS DEL ADMINISTRADOR ---\n${formData.adminNotes}\n--- FIN NOTAS ---\n` : '';
      // Include professional name in calendar event description so notification bell can parse it
      const professionalLine = formData.selected_doctor ? `\nProfesional: ${formData.selected_doctor}` : '';
      const additionalEmails = notifyPersonalStaff ? selectedPersonalEmails : [];

      const res = await fetch('/api/sendEmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          clinicId: user?.clinic_id,
          sessionToken: sessionStorage.getItem('adminSessionToken'),
          message:
            'Teléfono: ' + formData.phone + '\n' +
            'Email: ' + formData.email + '\n' +
            'Servicio: ' + formData.service + '\n' +
            'Fecha: ' + selectedDay + '\n' +
            'Hora: ' + selectedHour + ` (${durationLabel})` + '\n' +
            'Comentario del paciente: ' + formData.message + 
            adminMessage + professionalLine +
            '\n[AGENDADO POR ADMINISTRADOR]',
          start,
          end,
          service: formData.service,
          phone: formData.phone,
          selected_staff_email: formData.selected_doctor_email || undefined,
          selected_staff_name:  formData.selected_doctor       || undefined,
          additional_notify_emails: additionalEmails.length ? additionalEmails : undefined,
        }),
      });
      const result = await res.json();
      if (!result.success) {
        // Error real — mostrar mensaje descriptivo
        const errMsg = result.errors?.join(' | ') || result.message || 'Error al agendar';
        setError(errMsg.includes('Gmail') || errMsg.includes('Google')
          ? '⚠️ No hay cuenta Gmail conectada para esta clínica. Pide al Master Admin que conecte Gmail desde los Ajustes de la clínica.'
          : errMsg);
      } else {
        setSubmitted(true);
        setFormData({ name: '', email: '', phone: '', service: '', message: '', adminNotes: '', selected_doctor: '', selected_doctor_email: '' });
      }
    } catch (e) {
      setError('Error al enviar');
    }
    setSubmitting(false);
  };

  const resetAll = () => {
    setStep(1);
    setSelectedDay('');
    setSelectedHour('');
    setFormData({ name: '', email: '', phone: '', service: '', message: '', adminNotes: '',
      selected_doctor: user?.full_name || user?.username || '',
      selected_doctor_email: user?.email || '' });
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

  if (gmailNotConfigured) {
    return (
      <div className="max-w-6xl mx-auto bg-white rounded-lg shadow-lg p-6">
        <button onClick={onBack} className="flex items-center gap-2 text-[#deb887] hover:text-[#d4a574] font-medium mb-6">
          <ArrowLeft className="w-5 h-5" />
          Volver al Dashboard
        </button>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <AlertTriangle className="w-16 h-16 text-amber-400 mb-4" />
          <h3 className="text-xl font-semibold text-gray-800 mb-2">Cuenta Gmail no conectada</h3>
          <p className="text-gray-500 max-w-sm">
            Esta clínica no tiene una cuenta Gmail vinculada. Para agendar citas es necesario conectar Gmail
            desde el panel del Master Admin → Ajustes de la clínica → Email / Gmail.
          </p>
        </div>
      </div>
    );
  }

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
          <h4 className="text-lg font-semibold mb-3 text-[#0d5c6c] text-center">2. Selecciona hora y duración</h4>

          {/* Duration selector */}
          <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
            <span className="text-sm text-gray-500 mr-1">Duración:</span>
            {([30, 60, 90, 120] as const).map(min => (
              <button
                key={min}
                type="button"
                onClick={() => setAppointmentDuration(min)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold border-2 transition-all ${
                  appointmentDuration === min
                    ? 'bg-[#deb887] border-[#deb887] text-white shadow'
                    : 'bg-white border-[#dde7eb] text-[#0d5c6c] hover:border-[#deb887]'
                }`}
              >
                {min < 60 ? `${min} min` : min === 60 ? '1 h' : min === 90 ? '1:30 h' : '2 h'}
              </button>
            ))}
          </div>

          {/* Warning: hora liberada por cambio de duración */}
          {hourClearedMsg && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mb-3 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
              <span>{hourClearedMsg}</span>
              <button onClick={() => setHourClearedMsg('')} className="ml-auto text-amber-400 hover:text-amber-600"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}

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
              availableTimes.map(h => {
                const isOccupied = isHourOccupied(selectedDay, h, events, appointmentDuration);
                const isPast = isHourPast(selectedDay, h);
                const overflow = !isOccupied && !isPast && isOverflow(selectedDay, h, appointmentDuration, agendaEndHour);
                const isDisabled = isOccupied || isPast;
                
                return (
                  <button
                    key={h}
                    disabled={isDisabled}
                    onClick={() => { setSelectedHour(h); setHourClearedMsg(''); }}
                    className={`rounded-xl p-4 border-2 text-[#0d5c6c] flex flex-col items-center transition-all duration-150
                      ${selectedHour === h
                        ? overflow
                          ? 'bg-amber-100 border-amber-400 font-bold shadow-lg scale-105'
                          : 'bg-[#ffcfc4] border-[#fa9271] font-bold shadow-lg scale-105'
                        : overflow
                          ? 'bg-amber-50 border-amber-300 hover:bg-amber-100 text-amber-800'
                          : 'bg-white border-[#dde7eb] hover:bg-[#ffe2db]'}
                      ${isDisabled ? 'opacity-30 cursor-not-allowed' : ''}
                    `}
                  >
                    <Clock className={`w-5 h-5 mb-2 ${overflow && selectedHour !== h ? 'text-amber-500' : ''}`} />
                    <span className="text-lg font-semibold">{formatTimeLabel(h)}</span>
                    {isOccupied && <span className="text-xs text-red-500 mt-1">Ocupado</span>}
                    {isPast && !isOccupied && <span className="text-xs text-gray-500 mt-1">Pasado</span>}
                    {overflow && <span className="text-[10px] text-amber-600 mt-1 font-medium leading-tight text-center">⚠️ Excede<br/>horario</span>}
                  </button>
                );
              })
            )}
          </div>
          
          {/* Overflow confirmation banner when selected hour exceeds business hours */}
          {selectedHour && isOverflow(selectedDay, selectedHour, appointmentDuration, agendaEndHour) && (() => {
            const endMs = new Date(`${selectedDay}T${selectedHour}:00`).getTime() + appointmentDuration * 60 * 1000;
            const endObj = new Date(endMs);
            const endLabel = endObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: true });
            return (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 mb-3 text-sm">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
                <div>
                  <p className="font-semibold text-amber-800">La cita terminaría a las {endLabel}</p>
                  <p className="text-amber-700 text-xs mt-0.5">El horario de atención cierra a las {formatTimeLabel(agendaEndHour)}. Puedes continuar o cambiar la duración.</p>
                </div>
              </div>
            );
          })()}

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
                  {(clinicTreatments.length > 0 ? clinicTreatments : services.map(s => s.title)).map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>

                {/* Profesional asignado a la cita */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                      <UserCheck className="w-4 h-4 text-[#deb887]" /> Profesional asignado
                    </p>
                    <button type="button" onClick={() => setShowProfessionalModal(true)}
                      className="text-xs text-[#deb887] hover:text-[#c5a075] font-medium underline">
                      Cambiar
                    </button>
                  </div>
                  {formData.selected_doctor ? (
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[#deb887]/20 flex items-center justify-center text-[#99652f] font-bold text-sm">
                        {(formData.selected_doctor).charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{formData.selected_doctor}</p>
                        <p className="text-xs text-gray-400 truncate">{formData.selected_doctor_email || '—'}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 italic">Sin profesional asignado</p>
                  )}
                </div>

                {/* Notificar staff personal */}
                {personalEmails.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <button type="button" onClick={() => setNotifyPersonalStaff(p => !p)}
                        className="flex-shrink-0 text-[#deb887]">
                        {notifyPersonalStaff ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-gray-400" />}
                      </button>
                      <span className="text-sm font-medium text-amber-800">Notificar a mi staff personal</span>
                    </label>
                    {notifyPersonalStaff && (
                      <div className="mt-1.5">
                        <p className="text-xs text-amber-700 mb-1">Se enviará copia a:</p>
                        <div className="flex flex-wrap gap-1">
                          {selectedPersonalEmails.map(e => (
                            <span key={e} className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">{e}</span>
                          ))}
                        </div>
                        <button type="button" onClick={() => setShowStaffEmailModal(true)}
                          className="text-xs text-amber-700 underline mt-1">Ver/cambiar correos</button>
                      </div>
                    )}
                  </div>
                )}

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
                      <p className="text-gray-900">{selectedHour && formatTimeLabel(selectedHour)} ({appointmentDuration < 60 ? `${appointmentDuration} min` : appointmentDuration % 60 === 0 ? `${appointmentDuration / 60} h` : `${Math.floor(appointmentDuration / 60)}:30 h`})</p>
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
            {formData.phone && (() => {
              const phoneClean = formData.phone.replace(/[\s\-+]/g, '').replace(/^0/, '');
              const waText = encodeURIComponent(
                `Hola ${formData.name}, ¡gracias por agendar tu cita! 🧴✨\n` +
                `Hemos registrado tu cita para el servicio "${formData.service}" el ${selectedDay} a las ${selectedHour}.\n` +
                `Si tienes alguna pregunta, responde este mensaje.\n¡Nos vemos pronto!`
              );
              return (
                <a href={`https://wa.me/593${phoneClean}?text=${waText}`} target="_blank" rel="noopener noreferrer"
                  className="mt-3 flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium text-sm transition-colors">
                  <MessageCircle className="w-4 h-4" />
                  Enviar mensaje de WhatsApp al paciente
                </a>
              );
            })()}
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

      {/* ── Modal: Selector de profesional ───────────────────────────── */}
      {showProfessionalModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
            <div className="px-4 py-3 border-b flex justify-between items-center">
              <h4 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-[#deb887]" /> Seleccionar Profesional
              </h4>
              <button onClick={() => setShowProfessionalModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
              {/* Option: assign to self */}
              <button onClick={() => {
                  setFormData(f => ({ ...f, selected_doctor: user?.full_name || user?.username || '', selected_doctor_email: user?.email || '' }));
                  setShowProfessionalModal(false);
                }}
                className="w-full flex items-center gap-3 p-3 rounded-xl border-2 border-[#deb887]/40 bg-[#deb887]/5 hover:border-[#deb887] text-left transition-colors">
                <div className="w-8 h-8 rounded-full bg-[#deb887] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                  {(user?.full_name || user?.username || 'Y').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{user?.full_name || user?.username} <span className="text-[10px] text-[#deb887] ml-1">(yo)</span></p>
                  <p className="text-xs text-gray-400 truncate">{user?.email || '—'}</p>
                </div>
              </button>

              {/* System users */}
              {clinicProfessionals.filter(p => p.id !== user?.id).map(p => (
                <button key={p.id} onClick={() => {
                    setFormData(f => ({ ...f, selected_doctor: p.full_name || p.username, selected_doctor_email: p.email || '' }));
                    setShowProfessionalModal(false);
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-[#deb887]/60 hover:bg-[#deb887]/5 text-left transition-colors">
                  <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 font-bold text-sm flex-shrink-0">
                    {(p.full_name || p.username).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.full_name || p.username}</p>
                    <p className="text-xs text-gray-400 truncate">{p.email || '—'}{p.especialidad ? ` · ${p.especialidad}` : ''}</p>
                  </div>
                </button>
              ))}

              {/* External staff (no system login) */}
              {externalStaff.length > 0 && (
                <>
                  <p className="text-xs text-gray-400 pt-1 pb-0.5 font-medium">Externos (sin acceso al sistema)</p>
                  {externalStaff.map((m, i) => (
                    <button key={i} onClick={() => {
                        setFormData(f => ({ ...f, selected_doctor: m.name, selected_doctor_email: m.email }));
                        setShowProfessionalModal(false);
                      }}
                      className="w-full flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-[#deb887]/60 hover:bg-[#deb887]/5 text-left transition-colors">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 font-bold text-sm flex-shrink-0">
                        {m.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                        <p className="text-xs text-gray-400 truncate">{m.email}</p>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {/* No-one option */}
              <button onClick={() => { setFormData(f => ({ ...f, selected_doctor: '', selected_doctor_email: '' })); setShowProfessionalModal(false); }}
                className="w-full p-2.5 rounded-xl border border-dashed border-gray-200 text-xs text-gray-400 hover:bg-gray-50 transition-colors text-center">
                Sin profesional asignado
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Selección de correos staff ────────────────────────── */}
      {showStaffEmailModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="h-0.5 bg-gradient-to-r from-[#deb887] to-[#c5a075]" />
            <div className="px-4 py-3 border-b flex justify-between items-center">
              <h4 className="font-semibold text-gray-900 text-sm">Correos staff personal</h4>
              <button onClick={() => setShowStaffEmailModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-2">
              {personalEmails.map(e => {
                const selected = selectedPersonalEmails.includes(e);
                return (
                  <button key={e} onClick={() => setSelectedPersonalEmails(p => selected ? p.filter(x => x !== e) : [...p, e])}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-left text-sm transition-colors ${selected ? 'border-[#deb887] bg-[#deb887]/8 text-gray-900' : 'border-gray-200 text-gray-600'}`}>
                    {selected ? <CheckSquare className="w-4 h-4 text-[#deb887] flex-shrink-0" /> : <Square className="w-4 h-4 text-gray-300 flex-shrink-0" />}
                    <span className="truncate">{e}</span>
                  </button>
                );
              })}
              <button onClick={() => setShowStaffEmailModal(false)}
                className="w-full mt-1 py-2 rounded-xl text-white text-sm font-medium"
                style={{ background: 'linear-gradient(135deg,#deb887,#c5a075)' }}>
                Listo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminAppointment;