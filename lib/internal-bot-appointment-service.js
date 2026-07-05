/**
 * Servicio de Agendamiento para WhatsApp Chatbot
 * Permite verificar disponibilidad y crear citas directamente desde el chat
 */

// Usar fetch nativo de Node 18+ (Vercel usa Node 18)
const fetch = globalThis.fetch;

// Importar catálogo de servicios centralizado (nueva fuente unificada)
import { 
  findServiceByKeyword as findTreatmentByKeyword,
  getAllTreatments 
} from './services-adapter.js';

// URL completa de la API de Calendar en producción
const CALENDAR_API = 'https://saludbioskin.vercel.app/api/calendar';

// URL completa de la API de Email en producción  
const EMAIL_API = 'https://saludbioskin.vercel.app/api/sendEmail';

// Link público de agendamiento
export const APPOINTMENT_LINK = 'https://saludbioskin.vercel.app/#/appointment';

/**
 * Horario de atención de BIOSKIN
 */
export const BUSINESS_HOURS = {
  start: '09:00',
  end: '19:00',
  availableHours: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']
};

/**
 * Verifica si una fecha es válida (no es domingo, no es pasada)
 */
export function isValidDate(dateStr) {
  try {
    const date = new Date(dateStr + 'T00:00:00-05:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // No puede ser fecha pasada
    if (date < today) {
      return { valid: false, reason: 'La fecha ya pasó' };
    }
    
    // No puede ser domingo (día 0)
    if (date.getDay() === 0) {
      return { valid: false, reason: 'No atendemos los domingos' };
    }
    
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: 'Formato de fecha inválido' };
  }
}

/**
 * Verifica si una hora está en el rango de atención
 */
export function isValidHour(hour) {
  return BUSINESS_HOURS.availableHours.includes(hour);
}

/**
 * Verifica disponibilidad de una fecha y hora específica
 * @param {string} date - Fecha en formato YYYY-MM-DD
 * @param {string} hour - Hora en formato HH:MM
 * @returns {Promise<Object>} - { available: boolean, reason?: string, occupiedTimes?: Array }
 */
export async function checkAvailability(date, hour) {
  console.log(`📅 [Appointment] Verificando disponibilidad: ${date} a las ${hour}`);
  console.log(`🔍 [Appointment] Iniciando verificación de disponibilidad...`);
  
  try {
    // Validar fecha
    const dateValidation = isValidDate(date);
    if (!dateValidation.valid) {
      return {
        available: false,
        reason: dateValidation.reason
      };
    }
    
    // Validar hora
    if (!isValidHour(hour)) {
      return {
        available: false,
        reason: `La hora debe estar entre ${BUSINESS_HOURS.start} y ${BUSINESS_HOURS.end}`
      };
    }
    
    // Verificar si la hora ya pasó (solo para hoy)
    const today = new Date();
    const selectedDate = new Date(date + 'T00:00:00-05:00');
    const isSameDay = today.toDateString() === selectedDate.toDateString();
    
    if (isSameDay) {
      const [hourNum, minuteNum] = hour.split(':').map(Number);
      const appointmentTime = new Date();
      appointmentTime.setHours(hourNum, minuteNum, 0, 0);
      
      if (appointmentTime <= today) {
        return {
          available: false,
          reason: 'Esta hora ya pasó'
        };
      }
    }
    
    // Consultar eventos ocupados en Google Calendar
    console.log(`🌐 [Appointment] Consultando Calendar API: ${CALENDAR_API}`);
    console.log(`📤 [Appointment] Enviando: { action: 'getEvents', date: '${date}' }`);
    
    const response = await fetch(CALENDAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'getEvents',
        date: date
      })
    });
    
    console.log(`📥 [Appointment] Response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [Appointment] Error response body:`, errorText);
      throw new Error(`Error consultando calendario: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    const occupiedTimes = data.occupiedTimes || [];
    
    console.log(`📋 [Appointment] Horarios ocupados del día:`, occupiedTimes);
    
    // Verificar si la hora solicitada está ocupada (considerando 2 horas de duración)
    const startTime = new Date(date + 'T' + hour + ':00-05:00');
    const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // +2 horas
    
    const isOccupied = occupiedTimes.some(slot => {
      const slotStart = new Date(slot.start);
      const slotEnd = new Date(slot.end);
      // Hay conflicto si los rangos se superponen
      return (startTime < slotEnd && endTime > slotStart);
    });
    
    if (isOccupied) {
      return {
        available: false,
        reason: 'Esta hora ya está ocupada',
        occupiedTimes: occupiedTimes.map(slot => ({
          start: new Date(slot.start).toLocaleTimeString('es-ES', { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: 'America/Guayaquil'
          }),
          end: new Date(slot.end).toLocaleTimeString('es-ES', { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: 'America/Guayaquil'
          })
        }))
      };
    }
    
    return {
      available: true,
      message: `✅ La hora ${hour} del ${formatDate(date)} está disponible`
    };
    
  } catch (error) {
    console.error(`❌ [Appointment] Error verificando disponibilidad:`, error);
    console.error(`❌ [Appointment] Error name: ${error.name}`);
    console.error(`❌ [Appointment] Error message: ${error.message}`);
    console.error(`❌ [Appointment] Stack:`, error.stack);
    throw error;
  }
}

/**
 * Obtiene horarios disponibles para un día específico
 * @param {string} date - Fecha en formato YYYY-MM-DD
 * @returns {Promise<Object>} - { available: Array, occupied: Array }
 */
export async function getAvailableHours(date) {
  try {
    console.log(`🔍 [Appointment] Obteniendo horarios disponibles para ${date}`);
    
    // Validar fecha
    const dateValidation = isValidDate(date);
    if (!dateValidation.valid) {
      return {
        available: [],
        reason: dateValidation.reason
      };
    }
    
    // Obtener eventos del día
    console.log(`🌐 [Appointment] Consultando Calendar API: ${CALENDAR_API}`);
    console.log(`📤 [Appointment] Enviando: { action: 'getEvents', date: '${date}' }`);
    
    const response = await fetch(CALENDAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'getEvents',
        date: date
      })
    });
    
    console.log(`📥 [Appointment] Response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [Appointment] Error response body:`, errorText);
      throw new Error(`Error consultando calendario: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    const occupiedTimes = data.occupiedTimes || [];
    
    // Verificar cada hora disponible
    const today = new Date();
    const selectedDate = new Date(date + 'T00:00:00-05:00');
    const isSameDay = today.toDateString() === selectedDate.toDateString();
    
    const availableHours = [];
    const occupiedHours = [];
    
    for (const hour of BUSINESS_HOURS.availableHours) {
      // Si es hoy, verificar si la hora ya pasó
      if (isSameDay) {
        const [hourNum, minuteNum] = hour.split(':').map(Number);
        const appointmentTime = new Date();
        appointmentTime.setHours(hourNum, minuteNum, 0, 0);
        
        if (appointmentTime <= today) {
          occupiedHours.push(hour);
          continue;
        }
      }
      
      // Verificar si está ocupada
      const startTime = new Date(date + 'T' + hour + ':00-05:00');
      const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000);
      
      const isOccupied = occupiedTimes.some(slot => {
        const slotStart = new Date(slot.start);
        const slotEnd = new Date(slot.end);
        return (startTime < slotEnd && endTime > slotStart);
      });
      
      if (isOccupied) {
        occupiedHours.push(hour);
      } else {
        availableHours.push(hour);
      }
    }
    
    return {
      date: date,
      dateFormatted: formatDate(date),
      available: availableHours,
      occupied: occupiedHours,
      total: BUSINESS_HOURS.availableHours.length
    };
    
  } catch (error) {
    console.error('❌ [Appointment] Error obteniendo horarios:', error);
    return {
      available: [],
      error: error.message
    };
  }
}

/**
 * Crea una cita en el calendario
 * @param {Object} appointmentData - Datos de la cita
 * @returns {Promise<Object>} - { success: boolean, message: string }
 */
export async function createAppointment(appointmentData) {
  console.log(`📝 [Appointment] === INICIANDO CREACIÓN DE CITA ===`);
  console.log(`📝 [Appointment] Datos recibidos:`, JSON.stringify(appointmentData, null, 2));
  
  try {
    const { 
      name, 
      phone, 
      service, 
      date, 
      hour,
      email = `${phone}@whatsapp.user` // Email temporal si no lo proporciona
    } = appointmentData;
    
    console.log(`📝 [Appointment] Datos parseados:`, { name, phone, service, date, hour, email });
    
    // Validar datos requeridos
    if (!name || !phone || !service || !date || !hour) {
      console.error(`❌ [Appointment] Datos faltantes:`, { name: !!name, phone: !!phone, service: !!service, date: !!date, hour: !!hour });
      return {
        success: false,
        message: 'Faltan datos requeridos para crear la cita'
      };
    }
    
    console.log(`✅ [Appointment] Todos los datos requeridos presentes`);
    
    // Verificar disponibilidad una vez más
    console.log(`🔍 [Appointment] Verificando disponibilidad antes de crear...`);
    const availability = await checkAvailability(date, hour);
    console.log(`📋 [Appointment] Resultado verificación:`, availability);
    
    if (!availability.available) {
      console.warn(`⚠️ [Appointment] Horario no disponible:`, availability.reason);
      return {
        success: false,
        message: `No se pudo agendar: ${availability.reason}`
      };
    }
    
    console.log(`✅ [Appointment] Horario confirmado como disponible`);
    
    // Construir fechas para Google Calendar
    const startDateTime = `${date}T${hour}:00-05:00`;
    const [hourNum, minuteNum] = hour.split(':').map(Number);
    const endHour = (hourNum + 2).toString().padStart(2, '0');
    const endDateTime = `${date}T${endHour}:${minuteNum.toString().padStart(2, '0')}:00-05:00`;
    
    console.log(`📅 [Appointment] Evento Calendar:`, { startDateTime, endDateTime });
    
    // Construir mensaje para email
    const message = `CITA AGENDADA VÍA WHATSAPP CHATBOT
    
Paciente: ${name}
Teléfono: ${phone}
Servicio: ${service}
Fecha: ${formatDate(date)}
Hora: ${hour}

Agendado automáticamente desde WhatsApp por Asistente Interno (Chatbot)
`;
    
    // Enviar a la API de email (que también crea el evento en Calendar)
    console.log(`📧 [Appointment] Enviando a EMAIL_API: ${EMAIL_API}`);
    console.log(`📦 [Appointment] Payload:`, JSON.stringify({
      name, email, phone, service, start: startDateTime, end: endDateTime
    }, null, 2));
    
    const response = await fetch(EMAIL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        email: email,
        phone: phone,
        service: service,
        message: message,
        start: startDateTime,
        end: endDateTime
      })
    });
    
    console.log(`📥 [Appointment] Response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [Appointment] Error response:`, errorText);
      throw new Error(`Error al crear la cita: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`📋 [Appointment] Response data:`, result);
    
    if (result.success) {
      console.log(`✅ [Appointment] Cita creada exitosamente para ${name}`);
      return {
        success: true,
        message: `✅ ¡Cita agendada exitosamente!\n\n📅 ${formatDate(date)} a las ${hour}\n🏥 Servicio: ${service}\n\nTe esperamos en BIOSKIN 😊`
      };
    } else {
      return {
        success: false,
        message: 'Error al crear la cita en el sistema'
      };
    }
    
  } catch (error) {
    console.error('❌ [Appointment] Error creando cita:', error);
    return {
      success: false,
      message: 'Error al procesar la cita',
      error: error.message
    };
  }
}

/**
 * Sugiere horarios disponibles según preferencias
 * @param {Object} preferences - Preferencias del paciente
 * @returns {Promise<Object>} - Sugerencias de horarios
 */
export async function suggestAvailableHours(preferences = {}) {
  try {
    const {
      preferredTime = 'any', // 'morning', 'afternoon', 'evening', 'any'
      daysAhead = 7,
      isWeekend = false
    } = preferences;
    
    console.log(`💡 [Appointment] Sugiriendo horarios:`, preferences);
    
    const suggestions = [];
    const today = new Date();
    
    // Buscar en los próximos días
    for (let i = 0; i < daysAhead; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + i);
      
      // Saltar domingos
      if (checkDate.getDay() === 0) continue;
      
      // Filtrar por preferencia de fin de semana
      const isWeekendDay = checkDate.getDay() === 6; // Sábado
      if (isWeekend && !isWeekendDay) continue;
      if (!isWeekend && isWeekendDay) continue;
      
      const dateStr = checkDate.toISOString().split('T')[0];
      const availability = await getAvailableHours(dateStr);
      
      if (availability.available.length > 0) {
        // Filtrar por hora preferida
        let filteredHours = availability.available;
        
        if (preferredTime === 'morning') {
          filteredHours = filteredHours.filter(h => parseInt(h.split(':')[0]) < 12);
        } else if (preferredTime === 'afternoon') {
          filteredHours = filteredHours.filter(h => {
            const hour = parseInt(h.split(':')[0]);
            return hour >= 12 && hour < 17;
          });
        } else if (preferredTime === 'evening') {
          filteredHours = filteredHours.filter(h => parseInt(h.split(':')[0]) >= 17);
        }
        
        if (filteredHours.length > 0) {
          suggestions.push({
            date: dateStr,
            dateFormatted: formatDate(dateStr),
            dayName: getDayName(checkDate),
            availableHours: filteredHours.slice(0, 3) // Mostrar máximo 3 horas
          });
        }
      }
      
      // Limitar a 3 días con disponibilidad
      if (suggestions.length >= 3) break;
    }
    
    return {
      suggestions,
      totalDays: suggestions.length
    };
    
  } catch (error) {
    console.error('❌ [Appointment] Error sugiriendo horarios:', error);
    return {
      suggestions: [],
      error: error.message
    };
  }
}

/**
 * Formatea una fecha a texto legible en español
 */
function formatDate(dateStr) {
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 
                  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const date = new Date(dateStr + 'T00:00:00-05:00');
  return `${date.getDate()} de ${months[date.getMonth()]} de ${date.getFullYear()}`;
}

/**
 * Obtiene el nombre del día en español
 */
function getDayName(date) {
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  return days[date.getDay()];
}

/**
 * Parsea una fecha en lenguaje natural a formato YYYY-MM-DD
 * Ejemplos: "mañana", "pasado mañana", "lunes", "viernes 20"
 */
export function parseNaturalDate(text) {
  console.log(`🔍 [Parse] Parseando fecha de: "${text}"`);
  
  // Obtener fecha actual en zona horaria de Ecuador (UTC-5)
  const now = new Date();
  const ecuadorTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  console.log(`📅 [Parse] Fecha actual Ecuador: ${ecuadorTime.toISOString().split('T')[0]}`);
  
  text = text.toLowerCase().trim();
  
  // HOY (explícito)
  if (/\bhoy\b/.test(text) && !text.includes('mañana')) {
    const result = ecuadorTime.toISOString().split('T')[0];
    console.log(`✅ [Parse] Fecha detectada: ${result} (HOY)`);
    return result;
  }
  
  // MAÑANA (debe ser +1 día desde HOY)
  if (text.includes('mañana') && !text.includes('pasado')) {
    const tomorrow = new Date(ecuadorTime);
    tomorrow.setDate(ecuadorTime.getDate() + 1);
    const result = tomorrow.toISOString().split('T')[0];
    console.log(`✅ [Parse] Fecha detectada: ${result} (MAÑANA = hoy ${ecuadorTime.getDate()} + 1 día)`);
    return result;
  }
  
  // Pasado mañana
  if (text.includes('pasado mañana')) {
    const dayAfter = new Date(ecuadorTime);
    dayAfter.setDate(ecuadorTime.getDate() + 2);
    const result = dayAfter.toISOString().split('T')[0];
    console.log(`✅ [Parse] Fecha detectada: ${result} (PASADO MAÑANA)`);
    return result;
  }
  
  // Días de la semana
  const days = {
    'lunes': 1, 'martes': 2, 'miércoles': 3, 'miercoles': 3,
    'jueves': 4, 'viernes': 5, 'sábado': 6, 'sabado': 6
  };
  
  for (const [dayName, dayNum] of Object.entries(days)) {
    if (text.includes(dayName)) {
      const targetDate = new Date(ecuadorTime);
      let daysToAdd = dayNum - ecuadorTime.getDay();
      if (daysToAdd <= 0) daysToAdd += 7; // Próxima semana
      targetDate.setDate(ecuadorTime.getDate() + daysToAdd);
      const result = targetDate.toISOString().split('T')[0];
      console.log(`✅ [Parse] Fecha detectada: ${result} (${dayName})`);
      return result;
    }
  }
  
  // Formato "DD de NOMBREMES" o "DD de NOMBREMES de YYYY"
  // Ejemplo: "19 de noviembre", "15 de diciembre de 2025"
  const monthNames = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
  };
  
  const namedDateMatch = text.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?/i);
  if (namedDateMatch) {
    const day = namedDateMatch[1].padStart(2, '0');
    const monthName = namedDateMatch[2].toLowerCase();
    const month = monthNames[monthName].toString().padStart(2, '0');
    const year = namedDateMatch[3] || ecuadorTime.getFullYear();
    const result = `${year}-${month}-${day}`;
    console.log(`✅ [Parse] Fecha detectada: ${result} (formato DD de MES)`);
    return result;
  }
  
  // Formato YYYY-MM-DD
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }
  
  // Formato DD/MM o DD-MM (asume año actual)
  const dateMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, '0');
    const month = dateMatch[2].padStart(2, '0');
    const result = `${ecuadorTime.getFullYear()}-${month}-${day}`;
    console.log(`✅ [Parse] Fecha detectada: ${result} (formato DD/MM)`);
    return result;
  }
  
  console.log(`❌ [Parse] No se pudo parsear fecha de: "${text}"`);
  return null;
}

/**
 * Parsea una hora en lenguaje natural a formato HH:MM
 * Ejemplos: "10am", "3pm", "15:30", "tres de la tarde"
 */
export function parseNaturalTime(text) {
  console.log(`🔍 [Parse] Parseando hora de: "${text}"`);
  text = text.toLowerCase().trim();
  
  // Formato HH:MM
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const result = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
    console.log(`✅ [Parse] Hora detectada: ${result} (formato HH:MM)`);
    return result;
  }
  
  // Formato con AM/PM
  const ampmMatch = text.match(/(\d{1,2})\s*(am|pm)/);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1]);
    if (ampmMatch[2] === 'pm' && hour < 12) hour += 12;
    if (ampmMatch[2] === 'am' && hour === 12) hour = 0;
    const result = `${hour.toString().padStart(2, '0')}:00`;
    console.log(`✅ [Parse] Hora detectada: ${result} (formato AM/PM)`);
    return result;
  }
  
  // Horas en texto
  const hourTexts = {
    'nueve': '09:00', 'diez': '10:00', 'once': '11:00', 'doce': '12:00',
    'una': '13:00', 'dos': '14:00', 'tres': '15:00', 'cuatro': '16:00',
    'cinco': '17:00', 'seis': '18:00', 'siete': '19:00'
  };
  
  for (const [word, time] of Object.entries(hourTexts)) {
    if (text.includes(word)) {
      return time;
    }
  }
  
  return null;
}
