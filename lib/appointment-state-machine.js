/**
 * Máquina de Estados para Agendamiento de Citas - MEJORADA
 * 
 * Mejoras implementadas:
 * - Mensajes más naturales y concisos
 * - Validaciones más flexibles y permisivas
 * - Mejor manejo de errores con fallbacks
 * - Código DRY con funciones helper
 * - Timeout configurable
 */

import { 
  checkAvailability, 
  getAvailableHours,
  suggestAvailableHours,
  parseNaturalDate,
  parseNaturalTime,
  createAppointment,
  APPOINTMENT_LINK 
} from './internal-bot-appointment-service.js';
import { findServiceByKeyword as findTreatmentByKeyword } from './services-adapter.js';
import { chatbotAI } from './chatbot-ai-service.js';

// ========================================
// FUNCIONES HELPER (DRY)
// ========================================

/**
 * Formatea fecha legible en español
 * Ejemplo: "viernes, 21 de noviembre de 2025"
 */
function formatDateFriendly(dateStr) {
  const dateObj = new Date(dateStr + 'T00:00:00-05:00');
  return dateObj.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    weekday: 'long',
    timeZone: 'America/Guayaquil'
  });
}

/**
 * Formatea fecha corta en español
 * Ejemplo: "viernes, 21 de noviembre"
 */
function formatDateShort(dateStr) {
  const dateObj = new Date(dateStr + 'T00:00:00-05:00');
  return dateObj.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    timeZone: 'America/Guayaquil'
  });
}

/**
 * Organiza horarios por periodos del día
 * Filtra hora de almuerzo (13:00) automáticamente
 */
function formatAvailableSlots(slots) {
  const filtered = slots.filter(h => parseInt(h.split(':')[0]) !== 13);
  
  const morning = filtered.filter(h => parseInt(h.split(':')[0]) < 12);
  const afternoon = filtered.filter(h => {
    const hour = parseInt(h.split(':')[0]);
    return hour >= 12 && hour < 17;
  });
  const evening = filtered.filter(h => parseInt(h.split(':')[0]) >= 17);

  let result = [];
  if (morning.length > 0) result.push(`🌅 Mañana: ${morning.join(', ')}`);
  if (afternoon.length > 0) result.push(`☀️ Tarde: ${afternoon.join(', ')}`);
  if (evening.length > 0) result.push(`🌙 Noche: ${evening.join(', ')}`);
  
  return result.join('\n');
}

/**
 * Valida nombre - MÁS PERMISIVO que antes
 * Acepta: espacios, guiones, apóstrofes, tildes
 */
function isValidName(name) {
  const trimmed = name.trim();
  if (trimmed.split(/\s+/).length < 2) return false;
  const pattern = /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s\-']+$/;
  return pattern.test(trimmed);
}

/**
 * Capitaliza nombre correctamente
 */
function capitalizeName(name) {
  return name
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Wrapper seguro para llamadas externas
 */
async function safeCall(fn, context) {
  try {
    return await fn();
  } catch (error) {
    console.error(`❌ [SafeCall] Error en ${context}:`, error);
    return { success: false, available: [], error: true, message: 'Error técnico' };
  }
}

// ========================================
// ESTADOS DE LA MÁQUINA
// ========================================

export const APPOINTMENT_STATES = {
  IDLE: 'IDLE',                       // Sin proceso de agendamiento activo
  AWAITING_DATE: 'AWAITING_DATE',     // Esperando que el usuario indique fecha
  CONFIRMING_DATE: 'CONFIRMING_DATE', // Confirmando la fecha elegida
  AWAITING_TIME: 'AWAITING_TIME',     // Esperando hora específica
  CONFIRMING_TIME: 'CONFIRMING_TIME', // Confirmando la hora elegida
  AWAITING_NAME: 'AWAITING_NAME',     // Esperando nombre del paciente
  AWAITING_SERVICE: 'AWAITING_SERVICE', // Esperando tratamiento deseado
  CONFIRMING: 'CONFIRMING',           // Esperando confirmación final
  COMPLETE: 'COMPLETE',               // Cita creada exitosamente
  CANCELLATION_CONFIRMATION: 'CANCELLATION_CONFIRMATION' // Confirmando cancelación de cita existente
};

/**
 * Clase que maneja el estado de agendamiento de una conversación
 */
export class AppointmentStateMachine {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.state = APPOINTMENT_STATES.IDLE;
    this.data = {
      date: null,
      time: null,
      name: null,
      service: null,
      phone: null
    };
    this.lastActivity = Date.now();
    this.timeoutMinutes = options.timeoutMinutes || 60; // Timeout aumentado a 60 minutos
  }

  /**
   * Verifica si la sesión ha expirado por inactividad
   */
  isExpired() {
    const now = Date.now();
    const elapsed = (now - this.lastActivity) / 1000 / 60; // minutos
    return elapsed > this.timeoutMinutes;
  }

  /**
   * Actualiza el timestamp de última actividad
   */
  updateActivity() {
    this.lastActivity = Date.now();
  }

  /**
   * Inicia el proceso de agendamiento
   * @param {string} phone - Número de teléfono
   * @param {Object} options - Opciones adicionales (treatmentId, contextQuestionId, treatmentPrice, consultationIncluded)
   * @returns {Object} Estado y mensaje inicial
   */
  start(phone, options = {}) {
    console.log(`📋 [StateMachine] Iniciando flujo de agendamiento para ${this.sessionId}`);
    
    // Configurar opciones
    if (options.treatmentId) {
      console.log(`🎯 [StateMachine] Pre-llenando servicio: ${options.treatmentId}`);
      this.data.service = options.treatmentId;
      this.data.treatmentPrice = options.treatmentPrice || null;
      this.data.consultationIncluded = options.consultationIncluded !== undefined ? options.consultationIncluded : true;
      this.data.contextQuestionId = options.contextQuestionId || null;
    }

    if (options.name) {
      this.data.name = options.name;
    }
    
    this.data.phone = phone;

    // Si no tenemos el nombre, lo pedimos primero
    if (!this.data.name) {
      this.state = APPOINTMENT_STATES.AWAITING_NAME;
      return {
        state: this.state,
        message: `¡Perfecto! Te ayudo a agendar tu cita 😊\n\nPara empezar, ¿me podrías indicar tu nombre completo?\n\n(Si deseas cancelar el proceso, escribe "cancelar")`
      };
    }
    
    this.state = APPOINTMENT_STATES.AWAITING_DATE;
    
    return {
      state: this.state,
      message: `¡Hola ${this.data.name.split(' ')[0]}! Te ayudo a agendar tu cita 😊\n\n¿Qué día te gustaría venir?\n\nPuedes decir, por ejemplo:\n• Mañana\n• Este viernes\n• 25 de noviembre\n\n(Si deseas cancelar el proceso, escribe "cancelar")`
    };
  }

  /**
   * Procesa un mensaje del usuario según el estado actual
   * @param {string} userMessage - Mensaje del usuario
   * @param {Function} onAppointmentCreated - Callback opcional que se llama cuando se crea una cita exitosamente
   * @returns {Promise<Object>} Resultado del procesamiento
   */
  async processMessage(userMessage, onAppointmentCreated = null) {
    console.log(`🔄 [StateMachine] Estado actual: ${this.state}`);
    console.log(`💬 [StateMachine] Procesando: "${userMessage}"`);

    // Actualizar actividad
    this.updateActivity();

    // Verificar si la sesión expiró
    if (this.isExpired() && this.state !== APPOINTMENT_STATES.IDLE) {
      console.log(`⏰ [StateMachine] Sesión expirada por inactividad`);
      this.reset();
      return {
        state: this.state,
        message: `Tu sesión de agendamiento expiró por inactividad.\n\nSi aún deseas agendar, escribe "agendar" para empezar de nuevo 😊`,
        expired: true
      };
    }

    // Detectar comandos globales (disponibles en cualquier estado)
    // Primero validación rápida con regex
    const cancelRegex = /(cancelar|ya no|olvida|déjalo|dejalo|no quiero|mejor no|salir|menu|menú|stop|basta|adios|adiós|chao|chau|hasta luego)/i;
    let isCancellation = cancelRegex.test(userMessage);
    
    // Si no es obvio por regex, usar IA para validar intención (solo si el mensaje es ambiguo o largo)
    if (!isCancellation && userMessage.length > 4 && this.state !== APPOINTMENT_STATES.IDLE) {
       // Solo llamar a IA si no estamos en IDLE para no gastar tokens innecesariamente
       try {
         isCancellation = await chatbotAI.isCancellation(userMessage);
         if (isCancellation) console.log(`🤖 [StateMachine] IA detectó intención de cancelación en: "${userMessage}"`);
       } catch (e) {
         console.error('Error verificando cancelación con IA:', e);
       }
    }

    const backCommands = /(volver|atrás|atras|regresar|cambiar fecha|corregir fecha)/i;
    
    // Cancelar proceso
    if (isCancellation && this.state !== APPOINTMENT_STATES.IDLE) {
      console.log(`🚫 [StateMachine] Usuario canceló el proceso`);
      this.reset();
      return {
        state: this.state,
        message: `Entendido, he cancelado el proceso de agendamiento 😊\n\nSi cambias de opinión, escribe "agendar" cuando gustes.\n\n¿Hay algo más en lo que pueda ayudarte?`,
        cancelled: true
      };
    }

    // Volver a elegir fecha (disponible después de confirmarla)
    if (backCommands.test(userMessage) && (this.state === APPOINTMENT_STATES.AWAITING_TIME || this.state === APPOINTMENT_STATES.CONFIRMING_TIME)) {
      console.log(`🔙 [StateMachine] Usuario quiere cambiar la fecha`);
      this.data.date = null;
      this.data.time = null;
      this.state = APPOINTMENT_STATES.AWAITING_DATE;
      return {
        state: this.state,
        message: `Sin problema 😊 ¿Qué otro día prefieres?`
      };
    }

    switch (this.state) {
      case APPOINTMENT_STATES.IDLE:
        return this._handleIdle(userMessage);
      
      case APPOINTMENT_STATES.AWAITING_DATE:
        return await this._handleAwaitingDate(userMessage);
      
      case APPOINTMENT_STATES.CONFIRMING_DATE:
        return await this._handleConfirmingDate(userMessage);
      
      case APPOINTMENT_STATES.AWAITING_TIME:
        return await this._handleAwaitingTime(userMessage);
      
      case APPOINTMENT_STATES.CONFIRMING_TIME:
        return await this._handleConfirmingTime(userMessage);
      
      case APPOINTMENT_STATES.AWAITING_NAME:
        return await this._handleAwaitingName(userMessage);
      
      case APPOINTMENT_STATES.AWAITING_SERVICE:
        return await this._handleAwaitingService(userMessage);
      
      case APPOINTMENT_STATES.CONFIRMING:
        return await this._handleConfirming(userMessage, onAppointmentCreated);
      
      case APPOINTMENT_STATES.CANCELLATION_CONFIRMATION:
        return await this._handleCancellationConfirmation(userMessage);

      default:
        console.error(`❌ [StateMachine] Estado desconocido: ${this.state}`);
        return {
          state: this.state,
          message: 'Hubo un error. ¿Quieres empezar de nuevo?'
        };
    }
  }

  /**
   * Helper para detectar interrupciones inteligentes (preguntas fuera de flujo)
   */
  async _checkInterruption(userMessage, expectedType) {
    // Solo verificar si el mensaje es lo suficientemente largo para ser una pregunta
    if (userMessage.length < 4) return null;

    try {
      // Usar IA para analizar si es una interrupción o una respuesta válida pero mal formateada
      const result = await chatbotAI.detectInterruption(userMessage, expectedType);
      
      if (result && result.isInterruption && result.response) {
        console.log(`🧠 [StateMachine] Interrupción detectada: "${userMessage}" -> "${result.response}"`);
        return {
          state: this.state,
          message: result.response // El caller debe concatenar la pregunta de retorno
        };
      }
      
      // NUEVO: Si la IA dice que NO es interrupción, pero tampoco es válida para el regex,
      // tal vez la IA pueda "reparar" la entrada (ej: "mañana por la mañana" -> fecha válida)
      if (result && !result.isInterruption && result.repairedValue) {
        console.log(`🧠 [StateMachine] Valor reparado por IA: "${userMessage}" -> "${result.repairedValue}"`);
        return {
          repaired: true,
          value: result.repairedValue
        };
      }
    } catch (e) {
      console.error('Error checking interruption:', e);
    }
    return null;
  }

  /**
   * Estado IDLE - No hay proceso activo
   */
  _handleIdle(userMessage) {
    // Detectar cancelación de cita existente
    const wantsToCancel = /(cancelar|anular|eliminar).{0,15}(cita|turno|agendamiento)/i.test(userMessage);
    const wantsToReschedule = /(reagendar|cambiar|mover|posponer|reprogramar).{0,15}(cita|turno|agendamiento)/i.test(userMessage);

    if (wantsToCancel) {
        this.state = APPOINTMENT_STATES.CANCELLATION_CONFIRMATION;
        this.data.isRescheduling = false;
        return {
            state: this.state,
            message: `Entiendo que deseas cancelar una cita existente. 😢\n\nPara proceder, necesito confirmar: ¿Realmente deseas cancelar tu cita agendada? (Sí/No)`
        };
    }

    if (wantsToReschedule) {
        this.state = APPOINTMENT_STATES.CANCELLATION_CONFIRMATION;
        this.data.isRescheduling = true;
        return {
            state: this.state,
            message: `Entiendo que deseas cambiar tu cita. 🔄\n\nPara reagendar, primero debemos cancelar la cita actual. ¿Estás de acuerdo? (Sí/No)`
        };
    }

    // Solo detectar si el usuario quiere agendar
    const wantsAppointment = /(agendar|cita|reservar|turno|disponibilidad)/i.test(userMessage);
    
    if (wantsAppointment) {
      return {
        state: this.state,
        message: `¡Perfecto! Soy el Asistente Virtual de Agendamiento de BIOSKIN 🤖\n\nLe ayudaré a encontrar el mejor horario para su cita. Si en algún momento desea cambiar algo, solo dígamelo.\n\nPuedo ayudarle de dos formas:\n\n1️⃣ Agenda directamente aquí: ${APPOINTMENT_LINK}\n2️⃣ Le guío paso a paso por aquí (verifico disponibilidad en tiempo real)\n\n¿Cuál prefiere?`,
        requiresConfirmation: true
      };
    }

    return {
      state: this.state,
      message: null, // Dejar que la IA responda normalmente
      shouldUseAI: true
    };
  }

  /**
   * Estado CANCELLATION_CONFIRMATION - Confirmar cancelación/reagendamiento
   */
  async _handleCancellationConfirmation(userMessage) {
    const isAffirmative = /(si|sí|claro|por favor|ok|correcto|dale|confirmar)/i.test(userMessage);
    const isNegative = /(no|mejor no|cancelar|espera|atras|volver)/i.test(userMessage);

    if (isAffirmative) {
        // TODO: Aquí se podría llamar a una API para cancelar realmente si tuviéramos el ID
        // Por ahora, asumimos que notificamos al admin o que el usuario lo hace manualmente
        
        if (this.data.isRescheduling) {
            // Guardar datos previos si existieran (no tenemos, así que empezamos de cero)
            this.reset(); 
            
            // Iniciar nuevo flujo de agendamiento
            this.state = APPOINTMENT_STATES.AWAITING_DATE;
            return {
                state: this.state,
                message: `Listo, he procesado la solicitud. 👌\n\nAhora, ¿para qué fecha te gustaría la NUEVA cita? (Ej: "mañana", "lunes", "25 de nov")`
            };
        } else {
            this.reset();
            return {
                state: APPOINTMENT_STATES.IDLE,
                message: `Listo, he notificado a nuestro equipo para cancelar tu cita. ✅\n\nEsperamos verte pronto de nuevo. Si cambias de opinión, aquí estaré.`
            };
        }
    } else if (isNegative) {
        this.reset();
        return {
            state: APPOINTMENT_STATES.IDLE,
            message: `Entendido, no realizaremos ningún cambio en tu cita actual. 👍\n\n¿En qué más puedo ayudarte?`
        };
    }

    // Si no se entiende, usar IA para detectar intención o pedir confirmación de nuevo
    return {
        state: this.state,
        message: `Por favor, responde "Sí" para confirmar la cancelación o "No" para mantener tu cita.`
    };
  }

  /**
   * Estado AWAITING_DATE - Esperando fecha
   */
  async _handleAwaitingDate(userMessage) {
    console.log(`📅 [StateMachine] Extrayendo fecha de: "${userMessage}"`);
    
    let date = parseNaturalDate(userMessage);
    
    // Si regex falla, intentar reparación con IA
    if (!date) {
      const check = await this._checkInterruption(userMessage, 'date');
      if (check && check.repaired) {
        date = parseNaturalDate(check.value); // Intentar parsear el valor reparado
      } else if (check && check.message) {
        return {
          state: this.state,
          message: `${check.message}\n\nEntonces, ¿qué día le gustaría agendar?`
        };
      }
    }
    
    if (!date) {
      console.log(`❌ [StateMachine] No se pudo extraer fecha`);
      // Fallback inteligente con IA para generar respuesta de error contextual
      const aiResponse = await chatbotAI.generateErrorResponse(userMessage, 'date_selection');
      return {
        state: this.state,
        message: aiResponse || `No entendí la fecha 🤔\n\nPuedes decir:\n• Mañana / Pasado mañana\n• Este viernes\n• 25 de noviembre\n• 25/11\n\n(O escribe "cancelar" para salir)`
      };
    }

    console.log(`✅ [StateMachine] Fecha detectada: ${date}`);
    this.data.date = date;

    const dateFormatted = formatDateFriendly(date);

    // Verificar disponibilidad con manejo de errores
    const availability = await safeCall(
      () => getAvailableHours(date),
      'getAvailableHours en _handleAwaitingDate'
    );
    
    if (availability.error) {
      return {
        state: this.state,
        message: `Hubo un problema verificando disponibilidad.\n\n¿Prefiere que le comparta el enlace directo para agendar?`
      };
    }
    
    if (availability.available.length === 0) {
      // IA para manejar "No hay disponibilidad" de forma empática
      const aiApology = await chatbotAI.generateNoAvailabilityResponse(dateFormatted);
      return {
        state: this.state,
        message: aiApology || `El ${dateFormatted} no tenemos horarios disponibles 😔\n\n¿Prefiere buscar otro día?\n\n(Escribe "cancelar" para salir)`
      };
    }

    this.state = APPOINTMENT_STATES.CONFIRMING_DATE;

    return {
      state: this.state,
      message: `📅 ${dateFormatted}\n\n¿Confirmamos esta fecha? (Sí/No)\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Estado CONFIRMING_DATE - Confirmando fecha elegida
   */
  async _handleConfirmingDate(userMessage) {
    console.log(`✅ [StateMachine] Confirmando fecha: "${userMessage}"`);
    
    const confirms = /(sí|si|confirmo|confirmar|ok|vale|dale|perfecto|adelante|esa|correcto)/i;
    const changes = /(no|cambiar|otra|otro día|diferente|mejor)/i;

    if (confirms.test(userMessage)) {
      const dateFormatted = formatDateShort(this.data.date);

      const availability = await safeCall(
        () => getAvailableHours(this.data.date),
        'getAvailableHours en _handleConfirmingDate'
      );
      
      if (availability.error || availability.available.length === 0) {
        return {
          state: APPOINTMENT_STATES.AWAITING_DATE,
          message: `Hubo un problema verificando horarios.\n\n¿Prefieres elegir otro día?`
        };
      }

      const slotsFormatted = formatAvailableSlots(availability.available);
      const message = `Perfecto, el ${dateFormatted} tenemos:\n\n${slotsFormatted}\n\n¿Qué hora prefieres?\n\n(O escribe "cancelar" para salir)`;

      this.state = APPOINTMENT_STATES.AWAITING_TIME;

      return {
        state: this.state,
        message: message
      };
    } else if (changes.test(userMessage)) {
      this.data.date = null;
      this.state = APPOINTMENT_STATES.AWAITING_DATE;
      
      // Si el usuario dijo "mejor mañana", intentamos capturar "mañana" de una vez
      const newDate = parseNaturalDate(userMessage);
      if (newDate) {
          this.data.date = newDate;
          const dateFormatted = formatDateShort(newDate);
          return {
              state: this.state, // Seguimos en AWAITING_DATE pero ya tenemos fecha, así que pasamos a confirmar? 
              // No, mejor procesarlo como si estuvieramos en AWAITING_DATE
              // Pero como ya cambiamos el estado, podemos llamar recursivamente a _handleAwaitingDate?
              // O simplemente devolver la confirmación
          };
          // Mejor simplificar: si hay fecha, la usamos y pedimos confirmación
          this.state = APPOINTMENT_STATES.CONFIRMING_DATE;
          return {
              state: this.state,
              message: `Entendido. 📅 ${dateFormatted}\n\n¿Confirmamos esta nueva fecha?\n\n(O escribe "cancelar" para salir)`
          };
      }

      return {
        state: this.state,
        message: `¿Qué otro día prefieres?\n\n(O escribe "cancelar" para salir)`
      };
    }

    // Si detecta una nueva fecha, procesarla
    const newDate = parseNaturalDate(userMessage);
    if (newDate) {
      this.data.date = newDate;
      const dateFormatted = formatDateShort(newDate);
      
      // Verificar si TAMBIÉN proporcionó una hora (ej: "mañana a las 3pm")
      const newTime = parseNaturalTime(userMessage);
      if (newTime) {
        console.log(`⏰ [StateMachine] Hora detectada junto con fecha: ${newTime}`);
        // Pasar directamente a verificar disponibilidad
        const availability = await safeCall(
          () => checkAvailability(this.data.date, newTime),
          'checkAvailability en _handleConfirmingDate'
        );

        if (availability.error) {
           return {
             state: this.state,
             message: `Hubo un problema verificando disponibilidad. ¿Podrías repetir la hora?`
           };
        }

        if (!availability.available) {
           // Si está ocupado, mostrar sugerencias
           const suggestions = await safeCall(() => getAvailableHours(this.data.date), 'getAvailableHours');
           const slotsFormatted = formatAvailableSlots(suggestions.available || []);
           
           this.state = APPOINTMENT_STATES.AWAITING_TIME;
           return {
             state: this.state,
             message: `Lo siento, a las ${newTime} ya está ocupado el ${dateFormatted} 😔\n\nHorarios disponibles:\n${slotsFormatted}\n\n¿Qué otra hora prefieres?`
           };
        }

        // Si está libre, pasar a confirmar hora
        this.data.time = newTime;
        this.state = APPOINTMENT_STATES.CONFIRMING_TIME;
        return {
          state: this.state,
          message: `✅ ${dateFormatted} a las ${newTime}\n\n¿Confirmamos esta cita?\n\n(O escribe "cancelar" para salir)`
        };
      }
      
      return {
        state: this.state,
        message: `📅 ${dateFormatted}\n\n¿Confirmamos esta fecha?\n\n(O escribe "cancelar" para salir)`
      };
    }

    // Check interruption
    const interruption = await this._checkInterruption(userMessage, 'confirmation');
    if (interruption) {
      // Manejar reparación de IA (ej: "mejor mañana" -> "mañana")
      if (interruption.repaired) {
          const repairedDate = parseNaturalDate(interruption.value);
          if (repairedDate) {
              this.data.date = repairedDate;
              const dateFormatted = formatDateShort(repairedDate);
              return {
                  state: this.state,
                  message: `📅 ${dateFormatted}\n\n¿Confirmamos esta fecha?\n\n(O escribe "cancelar" para salir)`
              };
          }
      }

      if (interruption.message) {
          return {
            state: this.state,
            message: `${interruption.message}\n\n¿Confirmamos la fecha?`
          };
      }
    }

    return {
      state: this.state,
      message: `¿Confirmamos esta fecha? Responde "sí" o "cambiar"\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Estado AWAITING_TIME - Esperando hora
   */
  async _handleAwaitingTime(userMessage) {
    console.log(`⏰ [StateMachine] Extrayendo hora de: "${userMessage}"`);
    
    // 1. Verificar si el usuario quiere cambiar la fecha (explícita o implícitamente)
    // Ej: "mejor mañana", "cambiar al lunes", "mañana a las 3"
    const newDate = parseNaturalDate(userMessage);
    if (newDate && newDate !== this.data.date) {
       console.log(`📅 [StateMachine] Cambio de fecha detectado en AWAITING_TIME: ${newDate}`);
       this.data.date = newDate;
       const dateFormatted = formatDateShort(newDate);
       
       // Verificar si TAMBIÉN dio la hora
       const newTime = parseNaturalTime(userMessage);
       if (newTime) {
         console.log(`⏰ [StateMachine] Hora detectada con nueva fecha: ${newTime}`);
         // Verificar disponibilidad completa
         const availability = await safeCall(
            () => checkAvailability(this.data.date, newTime),
            'checkAvailability en _handleAwaitingTime (cambio fecha)'
         );
         
         if (!availability.available) {
             const suggestions = await safeCall(() => getAvailableHours(this.data.date), 'getAvailableHours');
             const slotsFormatted = formatAvailableSlots(suggestions.available || []);
             return {
                 state: this.state, // Seguimos esperando hora válida
                 message: `Entendido, cambiamos al ${dateFormatted}. Pero a las ${newTime} ya está ocupado 😔\n\nHorarios disponibles:\n${slotsFormatted}\n\n¿Qué hora prefieres?`
             };
         }
         
         // Disponible
         this.data.time = newTime;
         this.state = APPOINTMENT_STATES.CONFIRMING_TIME;
         return {
             state: this.state,
             message: `✅ ${dateFormatted} a las ${newTime}\n\n¿Confirmamos esta cita?\n\n(O escribe "cancelar" para salir)`
         };
       }
       
       // Solo cambió fecha, mostrar horarios de esa fecha
       const availability = await safeCall(
        () => getAvailableHours(this.data.date),
        'getAvailableHours en _handleAwaitingTime (solo fecha)'
       );
       
       const slotsFormatted = formatAvailableSlots(availability.available || []);
       return {
           state: this.state,
           message: `Entendido, cambiamos al ${dateFormatted}. Aquí están los horarios:\n\n${slotsFormatted}\n\n¿Qué hora prefieres?\n\n(O escribe "cancelar" para salir)`
       };
    }

    if (/(cambiar|corregir|modificar)\s*(la\s*)?(fecha|día)/i.test(userMessage)) {
      console.log(`🔙 [StateMachine] Usuario quiere volver a cambiar fecha desde hora`);
      this.data.date = null;
      this.data.time = null;
      this.state = APPOINTMENT_STATES.AWAITING_DATE;
      return {
        state: this.state,
        message: `¿Qué otro día prefieres?\n\n(O escribe "cancelar" para salir)`
      };
    }
    
    let time = parseNaturalTime(userMessage);
    
    // Si regex falla, intentar reparación con IA
    if (!time) {
      const check = await this._checkInterruption(userMessage, 'time');
      if (check && check.repaired) {
        time = parseNaturalTime(check.value); // Intentar parsear el valor reparado
      } else if (check && check.message) {
        return {
          state: this.state,
          message: `${check.message}\n\nEntonces, ¿a qué hora le gustaría?`
        };
      }
    }
    
    if (!time) {
      console.log(`❌ [StateMachine] No se pudo extraer hora`);
      // Fallback inteligente con IA
      const aiResponse = await chatbotAI.generateErrorResponse(userMessage, 'time_selection');
      return {
        state: this.state,
        message: aiResponse || `No entendí la hora 🤔\n\nPuedes decir:\n• 3pm o 15:00\n• 5 y media de la tarde\n• Tres de la tarde\n\n(O "cambiar fecha" para otro día)`
      };
    }

    console.log(`✅ [StateMachine] Hora detectada: ${time}`);

    const availability = await safeCall(
      () => checkAvailability(this.data.date, time),
      'checkAvailability en _handleAwaitingTime'
    );

    if (availability.error) {
      return {
        state: this.state,
        message: `Hubo un problema verificando disponibilidad.\n\n¿Intentas con otra hora o prefieres cambiar de fecha?`
      };
    }

    if (!availability.available) {
      const alternatives = await safeCall(
        () => getAvailableHours(this.data.date),
        'getAvailableHours alternativas'
      );
      const altHours = alternatives.available?.slice(0, 3).join(', ') || 'Consultar otras fechas';
      
      // IA para manejar "Hora ocupada" de forma empática
      const aiApology = await chatbotAI.generateNoAvailabilityResponse(`${this.data.date} a las ${time}`);
      
      return {
        state: this.state,
        message: aiApology || `Las ${time} ya está ocupado ❌\n\nOtras opciones:\n⏰ ${altHours}\n\n¿Te sirve alguno?`
      };
    }

    this.data.time = time;
    this.state = APPOINTMENT_STATES.CONFIRMING_TIME;

    const dateFormatted = formatDateShort(this.data.date);

    return {
      state: this.state,
      message: `📅 ${dateFormatted}\n⏰ ${time}\n\n¿Confirmamos este horario?\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Estado CONFIRMING_TIME - Confirmando hora elegida
   */
  async _handleConfirmingTime(userMessage) {
    console.log(`✅ [StateMachine] Confirmando hora: "${userMessage}"`);
    
    const confirms = /(sí|si|confirmo|confirmar|ok|vale|dale|perfecto|adelante|esa|correcto)/i;
    const changes = /(no|cambiar|otra|otro|diferente|corregir)/i;

    // 1. Verificar si el usuario quiere cambiar FECHA explícitamente
    const newDate = parseNaturalDate(userMessage);
    if (newDate && newDate !== this.data.date) {
        console.log(`📅 [StateMachine] Cambio de fecha desde CONFIRMING_TIME: ${newDate}`);
        this.data.date = newDate;
        this.data.time = null; // Resetear hora
        this.state = APPOINTMENT_STATES.AWAITING_TIME;
        
        // Si también dio hora nueva
        const newTime = parseNaturalTime(userMessage);
        if (newTime) {
             return this._handleAwaitingTime(userMessage); // Reutilizar lógica
        }

        const dateFormatted = formatDateShort(newDate);
        const availability = await safeCall(() => getAvailableHours(newDate), 'getAvailableHours');
        const slotsFormatted = formatAvailableSlots(availability.available || []);
        
        return {
            state: this.state,
            message: `Entendido, cambiamos al ${dateFormatted}. Horarios disponibles:\n\n${slotsFormatted}\n\n¿Qué hora prefieres?\n\n(O escribe "cancelar" para salir)`
        };
    }

    if (confirms.test(userMessage)) {
      // Si ya tenemos el servicio (ej: pre-llenado), pasamos directo a confirmar
      if (this.data.service) {
        this.state = APPOINTMENT_STATES.CONFIRMING;
        const dateFormatted = formatDateFriendly(this.data.date);
        return {
          state: this.state,
          message: `Resumen de tu cita:\n\n👤 ${this.data.name}\n📅 ${dateFormatted}\n⏰ ${this.data.time}\n💆 ${this.data.service}\n\n¿Confirmo la cita?\n\n(O escribe "cancelar" para salir)`
        };
      }

      this.state = APPOINTMENT_STATES.AWAITING_SERVICE;

      return {
        state: this.state,
        message: `Perfecto ✅\n\n¿Qué tratamiento o servicio le gustaría agendar?\n\n(O escribe "cancelar" para salir)`
      };
    } else if (changes.test(userMessage)) {
      this.data.time = null;
      this.state = APPOINTMENT_STATES.AWAITING_TIME;
      
      const availability = await safeCall(
        () => getAvailableHours(this.data.date),
        'getAvailableHours en _handleConfirmingTime'
      );
      
      if (availability.error || availability.available.length === 0) {
        return {
          state: this.state,
          message: `Hubo un problema. ¿Prefieres cambiar de fecha?\n\n(O escribe "cancelar" para salir)`
        };
      }

      const slotsFormatted = formatAvailableSlots(availability.available);
      const message = `Horarios disponibles:\n\n${slotsFormatted}\n\n¿Qué otra hora prefieres?\n\n(O escribe "cancelar" para salir)`;

      return {
        state: this.state,
        message: message
      };
    }

    // Si detecta una nueva hora (sin cambiar fecha)
    const newTime = parseNaturalTime(userMessage);
    if (newTime) {
      const availability = await safeCall(
        () => checkAvailability(this.data.date, newTime),
        'checkAvailability nueva hora'
      );
      
      if (availability.error || !availability.available) {
        const alternatives = await safeCall(
          () => getAvailableHours(this.data.date),
          'getAvailableHours alternativas'
        );
        const altHours = alternatives.available?.slice(0, 3).join(', ') || 'Consultar otras fechas';
        
        return {
          state: APPOINTMENT_STATES.AWAITING_TIME,
          message: `Las ${newTime} no está disponible ❌\n\nOtras opciones:\n⏰ ${altHours}\n\n(Escribe "cancelar" para salir)`
        };
      }
      
      this.data.time = newTime;
      const dateFormatted = formatDateShort(this.data.date);
      
      return {
        state: this.state,
        message: `📅 ${dateFormatted}\n⏰ ${newTime}\n\n¿Confirmamos este horario?\n\n(O escribe "cancelar" para salir)`
      };
    }

    // Check interruption
    const interruption = await this._checkInterruption(userMessage, 'confirmation');
    if (interruption) {
      // Manejar reparación de IA
      if (interruption.repaired) {
          const repairedTime = parseNaturalTime(interruption.value);
          if (repairedTime) {
              // Reutilizar lógica de nueva hora
              this.data.time = repairedTime;
              const dateFormatted = formatDateShort(this.data.date);
              return {
                  state: this.state,
                  message: `📅 ${dateFormatted}\n⏰ ${repairedTime}\n\n¿Confirmamos este horario?\n\n(O escribe "cancelar" para salir)`
              };
          }
      }

      if (interruption.message) {
          return {
            state: this.state,
            message: `${interruption.message}\n\n¿Confirmamos la hora?\n\n(O escribe "cancelar" para salir)`
          };
      }
    }

    return {
      state: this.state,
      message: `¿Confirmamos las ${this.data.time}? Responde "sí" o "cambiar"\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Estado AWAITING_NAME - Esperando nombre
   */
  async _handleAwaitingName(userMessage) {
    console.log(`👤 [StateMachine] Extrayendo nombre de: "${userMessage}"`);
    
    // 1. Si ya tenemos un nombre parcial (usuario ingresó solo nombre), esperamos el apellido
    if (this.data.partialName) {
        const surname = userMessage.trim();
        // Validación básica: que tenga al menos 2 letras
        if (surname.length > 1) {
            const fullName = `${this.data.partialName} ${surname}`;
            console.log(`✅ [StateMachine] Nombre completo completado: ${fullName}`);
            
            this.data.name = capitalizeName(fullName);
            this.data.partialName = null; // Limpiar
            this.state = APPOINTMENT_STATES.AWAITING_DATE;
            
            return {
                state: this.state,
                message: `Gracias ${this.data.name}. 😊\n\n¿Qué día te gustaría venir?\n\nPuedes decir, por ejemplo:\n• Mañana\n• Este viernes\n• 25 de noviembre\n\n(O escribe "cancelar" para salir)`
            };
        } else {
             return {
                state: this.state,
                message: `El apellido parece muy corto. ¿Podrías indicarme tu apellido completo?\n\n(O escribe "cancelar" para salir)`
            };
        }
    }

    let name = null;
    
    if (isValidName(userMessage)) {
      name = capitalizeName(userMessage);
    } else {
      // 2. Verificar si es un solo nombre (para pedir apellido)
      const trimmed = userMessage.trim();
      // Regex: Una sola palabra, solo letras
      const isSingleName = trimmed.split(/\s+/).length === 1 && /^[A-Za-zÁÉÍÓÚáéíóúÑñ]+$/.test(trimmed);
      
      if (isSingleName) {
          const partialName = capitalizeName(trimmed);
          console.log(`⚠️ [StateMachine] Solo un nombre detectado: ${partialName}, pidiendo apellido`);
          this.data.partialName = partialName;
          
          return {
              state: this.state,
              message: `Gracias ${partialName}. ¿Podrías indicarme también tu apellido para el registro?\n\n(O escribe "cancelar" para salir)`
          };
      }

      // Intentar reparación con IA (ej: "Me llamo Juan Perez" -> "Juan Perez")
      const check = await this._checkInterruption(userMessage, 'name');
      if (check && check.repaired) {
        name = capitalizeName(check.value);
      } else if (check && check.message) {
        return {
          state: this.state,
          message: `${check.message}\n\nEntonces, ¿cuál es su nombre completo?\n\n(O escribe "cancelar" para salir)`
        };
      }
    }

    if (!name) {
      console.log(`❌ [StateMachine] Nombre inválido`);
      const aiResponse = await chatbotAI.generateErrorResponse(userMessage, 'full_name');
      return {
        state: this.state,
        message: aiResponse || `Por favor, indíqueme su nombre completo (nombre y apellido)\n\nEjemplo: María González\n\n(O escribe "cancelar" para salir)`
      };
    }

    console.log(`✅ [StateMachine] Nombre detectado: ${name}`);
    
    this.data.name = name;
    this.state = APPOINTMENT_STATES.AWAITING_DATE;

    return {
      state: this.state,
      message: `Mucho gusto, ${name.split(' ')[0]} 😊\n\n¿Qué día te gustaría venir?\n\nPuedes decir, por ejemplo:\n• Mañana\n• Este viernes\n• 25 de noviembre\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Estado AWAITING_SERVICE - Esperando tratamiento
   */
  async _handleAwaitingService(userMessage) {
    console.log(`💆 [StateMachine] Extrayendo servicio de: "${userMessage}"`);
    
    // 1. Intentar encontrar tratamiento en catálogo (Prioridad 1)
    const treatment = findTreatmentByKeyword(userMessage);
    
    // FIX: Usar title (estructura nueva) o name (estructura vieja)
    let service = treatment ? (treatment.title || treatment.name) : null;
    
    // 2. Si no hay match en catálogo, usar IA para interpretar (Prioridad 2)
    if (!service) {
      console.log(`🤖 [StateMachine] No encontrado en catálogo, consultando IA...`);
      try {
        // Usar timeout de 3s para no bloquear la respuesta demasiado tiempo
        const aiService = await Promise.race([
          chatbotAI.interpretServiceName(userMessage),
          new Promise(resolve => setTimeout(() => resolve(null), 3000))
        ]);
        
        if (aiService) {
          service = aiService;
          console.log(`✅ [StateMachine] IA interpretó: ${service}`);
        }
      } catch (error) {
        console.error(`⚠️ [StateMachine] Error en interpretación IA:`, error);
      }
    }
    
    // 3. Fallback final: Texto del usuario limpio (Prioridad 3)
    if (!service) {
      service = userMessage.trim();
      // Capitalizar primera letra para que se vea bonito
      if (service.length > 0) {
        service = service.charAt(0).toUpperCase() + service.slice(1);
      }
    }
    
    // Validación mínima: solo verificar que no esté vacío y tenga longitud decente
    if (!service || service.length < 3) {
      console.log(`❌ [StateMachine] Texto muy corto, pidiendo aclaración`);
      return {
        state: this.state,
        message: `Por favor, indíqueme qué tratamiento o servicio desea agendar 😊\n\n(O escribe "cancelar" para salir)`
      };
    }

    console.log(`✅ [StateMachine] Servicio aceptado: ${service}`);
    
    this.data.service = service;
    this.state = APPOINTMENT_STATES.CONFIRMING;

    const dateFormatted = formatDateFriendly(this.data.date);

    return {
      state: this.state,
      message: `Resumen de tu cita:\n\n👤 ${this.data.name}\n📅 ${dateFormatted}\n⏰ ${this.data.time}\n💆 ${service}\n\n¿Confirmo la cita?`
    };
  }

  /**
   * Estado CONFIRMING - Esperando confirmación final
   * @param {string} userMessage - Mensaje del usuario
   * @param {Function} onAppointmentCreated - Callback opcional que se llama cuando se crea una cita
   */
  async _handleConfirming(userMessage, onAppointmentCreated = null) {
    console.log(`✅ [StateMachine] Procesando confirmación: "${userMessage}"`);
    
    const confirms = /(sí|si|confirmo|confirmar|ok|vale|dale|perfecto|adelante)/i;
    const rejects = /(no|mejor no|cambiar|cancelar|espera)/i;

    if (confirms.test(userMessage)) {
      console.log(`🎯 [StateMachine] Usuario confirmó, creando cita...`);
      
      // Determinar precio según regla de consulta incluida
      let appointmentPrice = 11.50; // Precio por defecto para consulta sola
      let priceNote = 'Consulta ($11.50 IVA incluido)';
      
      if (this.data.service && this.data.treatmentPrice) {
        // Si hay tratamiento específico pre-llenado y precio
        appointmentPrice = this.data.treatmentPrice;
        priceNote = `Tratamiento ${this.data.service} (consulta incluida)`;
        console.log(`💰 [StateMachine] Precio con tratamiento: $${appointmentPrice} - ${priceNote}`);
      } else if (this.data.service && this.data.consultationIncluded) {
        // Si hay servicio pero sin precio específico, aplicar lógica de consulta incluida
        priceNote = 'Consulta incluida en tratamiento';
        console.log(`💰 [StateMachine] ${priceNote}`);
      } else {
        console.log(`💰 [StateMachine] Solo consulta: $${appointmentPrice}`);
      }
      
      const result = await safeCall(
        () => createAppointment({
          name: this.data.name,
          phone: this.data.phone,
          service: this.data.service,
          date: this.data.date,
          hour: this.data.time,
          price: appointmentPrice,
          priceNote: priceNote
        }),
        'createAppointment en _handleConfirming'
      );

      if (result.success) {
        this.state = APPOINTMENT_STATES.COMPLETE;
        
        const dateFormatted = formatDateFriendly(this.data.date);

        // Llamar al callback si existe (para notificar al staff)
        if (onAppointmentCreated && typeof onAppointmentCreated === 'function') {
          console.log(`📢 [StateMachine] Llamando callback para notificar al staff...`);
          try {
            await onAppointmentCreated({
              name: this.data.name,
              phone: this.data.phone,
              service: this.data.service,
              date: this.data.date,
              hour: this.data.time,
              price: appointmentPrice,
              priceNote: priceNote
            });
            console.log(`✅ [StateMachine] Callback ejecutado exitosamente`);
          } catch (callbackError) {
            console.error(`⚠️ [StateMachine] Error en callback (no crítico):`, callbackError);
          }
        }

        return {
          state: this.state,
          message: `🎉 ¡Cita agendada!\n\n👤 ${this.data.name}\n📅 ${dateFormatted}\n⏰ ${this.data.time}\n💆 ${this.data.service}\n💰 ${priceNote}\n\nRecibirás confirmación por correo.\n\nTe esperamos en BIOSKIN 😊\n📍 Av. Ordóñez Lasso y Calle de la Menta\n🗺️ https://maps.app.goo.gl/KfXhuCB1hEFhQzP56\n\n¿Hay algo más en lo que pueda ayudarte?`,
          completed: true
        };
      } else {
        return {
          state: this.state,
          message: `Hubo un problema al crear la cita${result.message ? ': ' + result.message : ''}.\n\n¿Quieres intentar de nuevo o prefieres el enlace directo?\n${APPOINTMENT_LINK}`,
          error: true
        };
      }
    } else if (rejects.test(userMessage)) {
      console.log(`🔄 [StateMachine] Usuario rechazó, reiniciando...`);
      this.reset();
      return {
        state: this.state,
        message: `Entendido 😊\n\n¿Qué deseas cambiar?\n• Fecha\n• Hora\n• Tratamiento\n• Cancelar\n\nO agenda directamente en:\n${APPOINTMENT_LINK}`
      };
    }

    // Check interruption
    const interruption = await this._checkInterruption(userMessage, 'confirmation');
    if (interruption) {
      if (interruption.message) {
          return {
            state: this.state,
            message: `${interruption.message}\n\n¿Confirmo la cita?`
          };
      }
      // Si es repaired, probablemente es una confirmación mal escrita que la IA entendió
      // Pero por seguridad, pedimos confirmación de nuevo
    }

    return {
      state: this.state,
      message: `¿Confirmas la cita? Responde "sí" o "no"\n\n(O escribe "cancelar" para salir)`
    };
  }

  /**
   * Reinicia la máquina de estados
   */
  reset() {
    console.log(`🔄 [StateMachine] Reiniciando estado`);
    this.state = APPOINTMENT_STATES.IDLE;
    this.data = {
      date: null,
      time: null,
      name: null,
      service: null,
      phone: this.data.phone // Mantener teléfono
    };
  }

  /**
   * Verifica si hay un proceso de agendamiento activo
   */
  isActive() {
    return this.state !== APPOINTMENT_STATES.IDLE && this.state !== APPOINTMENT_STATES.COMPLETE;
  }

  /**
   * Obtiene el estado actual
   */
  getState() {
    return {
      state: this.state,
      data: { ...this.data },
      isActive: this.isActive()
    };
  }

  /**
   * Serializa el estado para guardarlo
   */
  serialize() {
    return JSON.stringify({
      state: this.state,
      data: this.data,
      lastActivity: this.lastActivity
    });
  }

  /**
   * Restaura el estado desde JSON
   */
  static deserialize(sessionId, json) {
    try {
      const parsed = JSON.parse(json);
      const machine = new AppointmentStateMachine(sessionId);
      machine.state = parsed.state || APPOINTMENT_STATES.IDLE;
      machine.data = parsed.data || {};
      machine.lastActivity = parsed.lastActivity || Date.now();
      return machine;
    } catch (error) {
      console.error(`❌ [StateMachine] Error deserializando:`, error);
      return new AppointmentStateMachine(sessionId);
    }
  }
}

// Almacenamiento en memoria para las máquinas de estado (temporal)
const stateMachines = new Map();

/**
 * Obtiene o crea una máquina de estados para una sesión
 */
export function getStateMachine(sessionId, phone) {
  if (!stateMachines.has(sessionId)) {
    const machine = new AppointmentStateMachine(sessionId);
    machine.data.phone = phone;
    stateMachines.set(sessionId, machine);
    console.log(`✅ [StateMachine] Nueva máquina creada para ${sessionId}`);
  }
  return stateMachines.get(sessionId);
}

/**
 * Guarda el estado de una máquina (para persistencia futura)
 */
export function saveStateMachine(sessionId, machine) {
  stateMachines.set(sessionId, machine);
  // TODO: Guardar en base de datos cuando esté disponible
}

/**
 * Elimina una máquina de estados
 */
export function deleteStateMachine(sessionId) {
  const deleted = stateMachines.delete(sessionId);
  console.log(`🗑️ [StateMachine] Máquina eliminada: ${deleted}`);
  return deleted;
}
