import { 
  initChatbotDatabase, 
  upsertConversation, 
  saveMessage, 
  getConversationHistory,
  saveTrackingEvent,
  upsertTemplate,
  saveAppState,
  updateUserPreferences,
  updateUserInfo,
  getGlobalSettings
} from '../lib/neon-chatbot-db-vercel.js';
import { cleanupService } from '../lib/internal-bot-cleanup.js';
import { chatbotAI } from '../lib/internal-bot-service.js';
import { FallbackStorage } from '../lib/fallback-storage.js';
import { STAFF_NUMBERS } from '../lib/config.js';
import { 
  classifyTechnical, 
  generateTechnicalReply,
  generateEngineerTransferSummary,
  generateEngineerWhatsAppLink 
} from '../lib/internal-bot-technical-service.js';
import {
  classifyMedical,
  generateMedicalReply,
  generateDoctorTransferSummary,
  generateDoctorWhatsAppLink
} from '../lib/internal-bot-medical-service.js';
import { findServiceByKeyword as findTreatmentByKeyword } from '../lib/services-adapter.js';
import {
  checkAvailability,
  getAvailableHours,
  createAppointment,
  suggestAvailableHours,
  APPOINTMENT_LINK
} from '../lib/internal-bot-appointment-service.js';
import { 
  getStateMachine, 
  saveStateMachine,
  APPOINTMENT_STATES 
} from '../lib/appointment-state-machine.js';
import { notifyNewConversation } from '../lib/admin-notifications.js';
import { processInternalChatMessage } from '../lib/internal-chat-service.js';
import { handleFinanceMessage } from '../lib/finance-bot-handler.js';

// Flag para controlar si usar fallback
// Comenzar intentando Neon, caer a fallback si hay timeout
let useFallback = false; // ✅ Intentar Neon primero, fallback automático si falla

// Flag para DESACTIVAR OpenAI temporalmente (debug)
const DISABLE_OPENAI = false; // ✅ OpenAI ACTIVADO - Sistema funcionando correctamente

// ========================================
// HELPERS PARA SISTEMA DE OPCIONES
// ========================================

/**
 * Almacenamiento en memoria para últimas preguntas del bot (temporal)
 * Estructura: { sessionId: { id, options, timestamp, expiresAt, type } }
 */
const lastBotQuestions = new Map();

/**
 * Guarda la última pregunta con opciones del bot
 * @param {string} sessionId - ID de la sesión
 * @param {Object} questionData - { id, options, timestamp, expiresAt, type }
 */
async function saveLastBotQuestion(sessionId, questionData) {
  console.log(`💾 [Options] Guardando pregunta: ${questionData.id} (${questionData.options?.length || 0} opciones)`);
  
  // Guardar en memoria
  lastBotQuestions.set(sessionId, {
    ...questionData,
    timestamp: questionData.timestamp || Date.now()
  });
  
  // Intentar guardar en DB para persistencia
  try {
    await saveTrackingEvent(sessionId, 'last_question', {
      questionId: questionData.id,
      optionsCount: questionData.options?.length || 0,
      expiresAt: questionData.expiresAt,
      type: questionData.type || 'medical'
    });
    console.log(`✅ [Options] Pregunta guardada en tracking`);
  } catch (error) {
    console.warn(`⚠️ [Options] No se pudo guardar en DB (no crítico):`, error.message);
  }
}

/**
 * Recupera la última pregunta con opciones del bot
 * @param {string} sessionId - ID de la sesión
 * @returns {Object|null} questionData o null si no existe o expiró
 */
function getLastBotQuestion(sessionId) {
  const question = lastBotQuestions.get(sessionId);
  
  if (!question) {
    console.log(`ℹ️ [Options] No hay pregunta guardada para ${sessionId}`);
    return null;
  }
  
  // Verificar expiración
  const now = Date.now();
  const expiresAtMs = new Date(question.expiresAt).getTime();
  
  if (now > expiresAtMs) {
    console.log(`⏰ [Options] Pregunta expirada (${Math.floor((now - expiresAtMs) / 1000 / 60)} min atrás)`);
    lastBotQuestions.delete(sessionId);
    return null;
  }
  
  console.log(`✅ [Options] Pregunta recuperada: ${question.id} (${question.options?.length || 0} opciones)`);
  return question;
}

/**
 * Parsea la respuesta del usuario intentando matchear con opciones
 * Soporta múltiples formatos: "1", "opción 1", "la 1", "uno", "primera", "1️⃣"
 * 
 * @param {string} userMessage - Mensaje del usuario
 * @param {Object} lastBotQuestion - Última pregunta con opciones
 * @returns {Object} { matched: boolean, optionId: string|null, confidence: number, option: Object|null }
 */
function parseOptionReply(userMessage, lastBotQuestion) {
  if (!lastBotQuestion || !lastBotQuestion.options || lastBotQuestion.options.length === 0) {
    return { matched: false, optionId: null, confidence: 0, option: null };
  }
  
  console.log(`🔍 [Options] Parseando respuesta: \"${userMessage}\"`);
  console.log(`🔍 [Options] Opciones disponibles: ${lastBotQuestion.options.map(o => o.id).join(', ')}`);
  
  // Normalizar mensaje
  const normalized = userMessage
    .toLowerCase()
    .trim()
    .replace(/[1-9]️⃣/g, match => match[0]) // Emoji digits → números
    .replace(/[^\w\sáéíóúñ]/g, ''); // Remover puntuación
  
  console.log(`🔍 [Options] Mensaje normalizado: \"${normalized}\"`);
  
  // PRIORIDAD 1: Match exacto numérico (1, 2, 3)
  const exactNumericMatch = normalized.match(/^(\d)$/);
  if (exactNumericMatch) {
    const optionId = exactNumericMatch[1];
    const option = lastBotQuestion.options.find(opt => opt.id === optionId);
    if (option) {
      console.log(`✅ [Options] Match EXACTO numérico: opción ${optionId}`);
      return { matched: true, optionId, confidence: 1.0, option };
    }
  }
  
  // PRIORIDAD 2: "opción 1", "opcion 1", "la 1", "numero 1"
  const optionPatternMatch = normalized.match(/(?:opci[oó]n|la|n[uú]mero|respuesta)\s*(\d)/);
  if (optionPatternMatch) {
    const optionId = optionPatternMatch[1];
    const option = lastBotQuestion.options.find(opt => opt.id === optionId);
    if (option) {
      console.log(`✅ [Options] Match PATRÓN: opción ${optionId}`);
      return { matched: true, optionId, confidence: 0.95, option };
    }
  }
  
  // PRIORIDAD 3: Palabras numéricas (uno, dos, tres)
  const wordToNumber = {
    'uno': '1', 'una': '1', 'primero': '1', 'primera': '1',
    'dos': '2', 'segundo': '2', 'segunda': '2',
    'tres': '3', 'tercero': '3', 'tercera': '3'
  };
  
  for (const [word, number] of Object.entries(wordToNumber)) {
    if (normalized === word || normalized.includes(` ${word} `) || normalized.startsWith(`${word} `) || normalized.endsWith(` ${word}`)) {
      const option = lastBotQuestion.options.find(opt => opt.id === number);
      if (option) {
        console.log(`✅ [Options] Match PALABRA: \"${word}\" → opción ${number}`);
        return { matched: true, optionId: number, confidence: 0.90, option };
      }
    }
  }
  
  // PRIORIDAD 4: Match fuzzy por label de la opción
  for (const opt of lastBotQuestion.options) {
    const labelWords = opt.label.toLowerCase().split(/\s+/);
    const matchingWords = labelWords.filter(word => normalized.includes(word));
    
    if (matchingWords.length >= 2 || (matchingWords.length === 1 && labelWords.length <= 2)) {
      console.log(`✅ [Options] Match FUZZY: label \"${opt.label}\" (palabras: ${matchingWords.join(', ')})`);
      return { matched: true, optionId: opt.id, confidence: 0.75, option: opt };
    }
  }
  
  console.log(`❌ [Options] No se encontró match`);
  return { matched: false, optionId: null, confidence: 0, option: null };
}

/**
 * Obtiene el saludo apropiado según la hora de Ecuador
 */
function getTimeBasedGreeting() {
  // Obtener hora de Ecuador usando Date con timezone
  const ecuadorDate = new Date(new Date().toLocaleString('en-US', { 
    timeZone: 'America/Guayaquil'
  }));
  const hour = ecuadorDate.getHours();
  
  console.log(`⏰ Hora Ecuador: ${hour}:${ecuadorDate.getMinutes()}`);
  
  if (hour >= 5 && hour < 12) {
    return 'Buenos días';
  } else if (hour >= 12 && hour < 19) {
    return 'Buenas tardes';
  } else {
    return 'Buenas noches';
  }
}

/**
 * Detección simple de intención sin IA
 */
function detectSimpleIntent(message) {
  const lowerMsg = message.toLowerCase();
  
  if (/^(hola|buenos días|buenas tardes|buenas noches|hey|hi|saludos)/i.test(lowerMsg)) {
    return 'greeting';
  }
  if (/(agendar|cita|reservar|turno|disponibilidad|horario)/i.test(lowerMsg)) {
    return 'appointment';
  }
  if (/(información|info|tratamiento|servicio|precio|costo|cuánto)/i.test(lowerMsg)) {
    return 'info';
  }
  return 'general';
}

/**
 * ENDPOINT PRINCIPAL DEL CHATBOT DE WHATSAPP
 * Maneja verificación del webhook y procesamiento de mensajes
 * 
 * Variables de entorno requeridas:
 * - NEON_DATABASE_URL o POSTGRES_URL: URL de conexión a PostgreSQL
 * - OPENAI_API_KEY: API key de OpenAI (ya configurada)
 * - WHATSAPP_VERIFY_TOKEN: Token para verificación del webhook
 * - WHATSAPP_ACCESS_TOKEN: Token de acceso de WhatsApp Business API
 * 
 * NOTA: Actualmente usando almacenamiento en memoria (fallback) debido a 
 * problemas de timeout con Neon PostgreSQL free tier (scale-to-zero).
 */

export default async function handler(req, res) {
  try {
    // ============================================
    // VERIFICACIÓN DEL WEBHOOK (GET)
    // ============================================
    if (req.method === 'GET') {
      try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        console.log('🔐 Verificación de webhook:', { mode, token: token ? '***' : 'missing', challenge: challenge ? '***' : 'missing' });

        // Si no hay parámetros, mostrar página de información
        if (!mode && !token && !challenge) {
          return res.status(200).json({
            status: 'ok',
            message: 'WhatsApp Chatbot Webhook',
            info: 'Este endpoint está configurado para recibir webhooks de WhatsApp Business API',
            verification: {
              url: 'https://saludbioskin.vercel.app/api/whatsapp-chatbot',
              method: 'GET',
              requiredParams: ['hub.mode', 'hub.verify_token', 'hub.challenge']
            },
            environment: {
              hasVerifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
              hasAccessToken: !!process.env.WHATSAPP_ACCESS_TOKEN,
              hasPhoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
              hasPostgresDb: !!process.env.POSTGRES_URL,
              hasOpenAI: !!process.env.OPENAI_API_KEY
            }
          });
        }

        // Verificar token
        if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
          console.log('✅ Webhook verificado correctamente');
          return res.status(200).send(challenge);
        }

        console.log('❌ Verificación fallida - token incorrecto o parámetros faltantes');
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Token verification failed',
          received: {
            mode: mode || 'missing',
            hasToken: !!token,
            hasChallenge: !!challenge
          }
        });
      } catch (error) {
        console.error('❌ Error en verificación:', error);
        return res.status(500).json({ 
          error: 'Error en verificación',
          message: error.message,
          stack: error.stack 
        });
      }
    }

    // ============================================
    // PROCESAMIENTO DE MENSAJES (POST)
    // ============================================
    if (req.method === 'POST') {
      try {
        console.log('🔵 Webhook POST recibido:', JSON.stringify(req.body, null, 2));
        
        // Procesar mensaje de forma síncrona pero rápida
        await processWhatsAppMessage(req.body);
        
        // Responder OK después de procesar
        return res.status(200).send('OK');

      } catch (error) {
        console.error('❌ Error en endpoint:', error);
        // Responder OK incluso si hay error para que WhatsApp no reintente
        return res.status(200).send('OK');
      }
    }

    // Método no permitido
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (topLevelError) {
    console.error('❌ ERROR CRÍTICO EN HANDLER:', topLevelError);
    return res.status(500).json({
      error: 'Critical handler error',
      message: topLevelError.message,
      stack: topLevelError.stack,
      type: topLevelError.constructor.name
    });
  }
}

/**
 * Procesa un mensaje entrante de WhatsApp
 */
async function processWhatsAppMessage(body) {
  try {
    console.log('📱 Procesando mensaje de WhatsApp...');

    // Extraer datos del webhook de WhatsApp
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // 💰 FINANCE BOT CHECK (Ing. Rafael & Dra. Daniela)
    if (message) {
      try {
        const from = message.from;
        const msgType = message.type;
        const msgBody = message.text?.body || '';
        
        const financeResult = await handleFinanceMessage(from, msgBody, msgType, body);
        
        if (financeResult && financeResult.handled) {
          console.log('💰 [FinanceBot] Mensaje manejado por el bot financiero');
          if (financeResult.response) {
            await sendWhatsAppMessage(from, financeResult.response);
          }
          return; // Detener procesamiento del bot normal
        }
      } catch (finErr) {
        console.error('❌ Error en FinanceBot:', finErr);
        // Continuar con flujo normal si falla
      }
    }

    // Ignorar webhooks de estado (sent, delivered, read)
    if (!message && value?.statuses) {
      console.log('ℹ️ Webhook de estado ignorado:', value.statuses[0]?.status);
      return;
    }

    // ============================================
    // PROCESAMIENTO DE WEBHOOKS ADICIONALES
    // ============================================

    // 1. Message Echoes (sincronización con Business Manager)
    if (message?.is_echo === true) {
      console.log('🔄 Message echo detectado (mensaje desde Business Manager)');
      try {
        await saveTrackingEvent(
          `admin_${message.from}`,
          'message_echo',
          {
            messageId: message.id,
            from: message.from,
            text: message.text?.body,
            timestamp: message.timestamp
          }
        );
        console.log('✅ Echo registrado en tracking');
      } catch (error) {
        console.error('❌ Error procesando echo:', error);
      }
      return;
    }

    // 2. Tracking Events (análisis de interacciones)
    if (entry[0]?.changes?.[0]?.value?.tracking_data) {
      const trackingData = entry[0].changes[0].value.tracking_data;
      console.log('📊 Tracking event recibido:', trackingData.event_type);
      try {
        await saveTrackingEvent(
          trackingData.wa_id,
          trackingData.event_type,
          trackingData
        );
        console.log('✅ Tracking guardado');
      } catch (error) {
        console.error('❌ Error guardando tracking:', error);
      }
      return;
    }

    // 3. Template Updates (actualizaciones de plantillas de marketing)
    if (entry[0]?.changes?.[0]?.field === 'message_template_status_update') {
      const templateUpdate = entry[0].changes[0].value;
      console.log('📋 Template update:', templateUpdate.message_template_name);
      try {
        await upsertTemplate(
          templateUpdate.message_template_id,
          templateUpdate.category,
          templateUpdate.event,
          {
            name: templateUpdate.message_template_name,
            language: templateUpdate.message_template_language,
            reason: templateUpdate.reason,
            rejectionReason: templateUpdate.rejection_reason
          }
        );
        console.log('✅ Template actualizado');
      } catch (error) {
        console.error('❌ Error actualizando template:', error);
      }
      return;
    }

    // 4. App State Sync (estado online/offline)
    if (entry[0]?.changes?.[0]?.field === 'smb_app_state_sync') {
      const appState = entry[0].changes[0].value;
      console.log('🔄 App state sync:', appState.status);
      try {
        await saveAppState('whatsapp_status', {
          status: appState.status,
          phoneNumber: appState.phone_number,
          timestamp: new Date().toISOString()
        });
        console.log('✅ Estado de app guardado');
      } catch (error) {
        console.error('❌ Error guardando estado:', error);
      }
      return;
    }

    // 5. User Preferences (preferencias de comunicación)
    if (entry[0]?.changes?.[0]?.value?.preferences) {
      const prefs = entry[0].changes[0].value.preferences;
      const userId = entry[0].changes[0].value.wa_id;
      console.log('⚙️ Preferencias de usuario actualizadas');
      try {
        await updateUserPreferences(`whatsapp_${userId}`, {
          notificationsEnabled: prefs.notifications_enabled,
          language: prefs.language,
          marketingOptIn: prefs.marketing_opt_in,
          updatedAt: new Date().toISOString()
        });
        console.log('✅ Preferencias guardadas');
      } catch (error) {
        console.error('❌ Error guardando preferencias:', error);
      }
      return;
    }

    if (!message) {
      console.log('⚠️ No hay mensaje en el webhook');
      return;
    }

    // Información del mensaje
    const from = message.from; // Número de teléfono
    const messageId = message.id;
    const messageType = message.type;
    const timestamp = message.timestamp;

    // Solo procesar mensajes de texto por ahora
    if (messageType !== 'text') {
      console.log(`⚠️ Tipo de mensaje no soportado: ${messageType}`);
      await sendWhatsAppMessage(from, 'Lo siento, solo puedo procesar mensajes de texto por ahora. 📝');
      return;
    }

    const userMessage = message.text.body;
    console.log(`📨 Mensaje de ${from}: "${userMessage}"`);

    // =================================================================================
    // 🛡️ STAFF FILTER & INTERNAL ASSISTANT ROUTING
    // =================================================================================
    const normalizedFrom = from.replace(/\D/g, '');
    
    // Check if sender is staff
    const isStaff = STAFF_NUMBERS.some(num => normalizedFrom.includes(num) || num.includes(normalizedFrom));

    if (isStaff) {
      console.log(`🛡️ STAFF DETECTADO (${from}) - Enrutando a Asistente Interno...`);
      
      try {
        // Call Internal Assistant Logic (reusing api/internal-chat logic but directly)
        // We need to fetch the response from the internal chat API or import the logic.
        // Since we are in the same Vercel project, we can call the handler logic if we refactor,
        // but for now, let's make a fetch call to our own API or replicate the call.
        // Better: Let's use the same Gemini logic here but with the "assistant" mode prompt.
        
        // 1. Save message to DB (to keep history)
        const sessionId = `staff_${normalizedFrom}`;
        await upsertConversation(sessionId, from);
        await saveMessage(sessionId, 'user', userMessage, 0, messageId);

        // 2. Call Internal Chat Service directly
        console.log(`🔄 Procesando con Asistente Interno (Direct Call)`);
        
        const aiResponse = await processInternalChatMessage({
          message: userMessage,
          sessionId: sessionId,
          mode: 'assistant',
          isNewSession: false // We manage session persistence in DB
        });

        // 3. Save AI response (already done inside processInternalChatMessage)
        // But we need to ensure it's saved in the same place where we look for history.
        // processInternalChatMessage uses 'chat_messages' table.
        // saveMessage uses 'chat_messages' table (in neon-chatbot-db-vercel.js).
        // So it should be fine.
        
        // 4. Send to WhatsApp
        await sendWhatsAppMessage(from, aiResponse);
        
        console.log('✅ Respuesta de Asistente Interno enviada al staff');
        return; // STOP HERE for staff

      } catch (error) {
        console.error('❌ Error en Asistente Interno:', error);
        await sendWhatsAppMessage(from, '⚠️ Error en el Asistente Interno. Por favor revisa los logs.');
        return;
      }
    }
    // =================================================================================

    // Generar ID de sesión (número de teléfono como identificador)
    const sessionId = `whatsapp_${from}`;
    console.log(`🔑 Session ID generado: ${sessionId}`);

    // Wrapper para intentar operaciones con fallback
    const withFallback = async (operation, fallbackFn, description) => {
      if (useFallback) {
        console.log(`⚡ [FALLBACK ACTIVO] ${description}`);
        return fallbackFn();
      }
      
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 2000) // 2s timeout para Neon
        );
        return await Promise.race([operation(), timeoutPromise]);
      } catch (error) {
        console.warn(`⚠️ ${description} falló, activando fallback:`, error.message);
        useFallback = true; // Activar fallback para próximas operaciones
        return fallbackFn();
      }
    };

    // Crear/actualizar conversación (con fallback)
    console.log('💾 Paso 2: Creando/actualizando conversación...');
    const conversationResult = await withFallback(
      () => upsertConversation(sessionId, from),
      () => FallbackStorage.saveConversation(sessionId, from),
      'Upsert conversación'
    );
    console.log('✅ Conversación actualizada');
    
    // Obtener info del usuario si existe
    const userInfo = conversationResult?.conversation?.user_info || {};
    console.log('👤 Info de usuario:', userInfo);

    // Obtener historial de conversación ANTES de la notificación (con fallback)
    console.log('💾 Paso 3: Obteniendo historial...');
    const history = await withFallback(
      () => getConversationHistory(sessionId, 20),
      () => FallbackStorage.getConversationHistory(sessionId, 20),
      'Obtener historial'
    );
    console.log(`✅ Historial obtenido: ${history.length} mensajes`);

    // Determinar si es una nueva conversación (historial vacío = primera vez)
    const isNewConversation = history.length === 0;
    console.log(`🔍 ¿Es nueva conversación? ${isNewConversation ? 'SÍ' : 'NO'} (historial: ${history.length} mensajes)`);
    
    // Calcular inactividad (solo si hay historial previo)
    let inactivityMinutes = 0;
    let shouldNotifyInactive = false;
    
    if (!isNewConversation && history.length > 0) {
      // Buscar último mensaje del usuario (antes del actual)
      const userMessages = history.filter(msg => msg.role === 'user');
      
      console.log(`🔍 [DEBUG INACTIVIDAD] Total mensajes en historial: ${history.length}`);
      console.log(`🔍 [DEBUG INACTIVIDAD] Mensajes del usuario: ${userMessages.length}`);
      
      if (userMessages.length > 0) {
        // 🔥 ORDENAR EXPLÍCITAMENTE por timestamp DESC (más reciente primero)
        userMessages.sort((a, b) => {
          const timeA = new Date(a.created_at || a.timestamp).getTime();
          const timeB = new Date(b.created_at || b.timestamp).getTime();
          return timeB - timeA; // DESC: más reciente primero
        });
        
        const lastUserMsg = userMessages[0]; // Ahora GARANTIZADO el más reciente
        
        console.log(`🔍 [DEBUG INACTIVIDAD] Último mensaje del usuario (después de ordenar):`);
        console.log(`   - Contenido: "${lastUserMsg.content?.substring(0, 50)}"`);
        console.log(`   - Timestamp: ${lastUserMsg.created_at || lastUserMsg.timestamp}`);
        console.log(`   - ID: ${lastUserMsg.id}`);
        
        const lastMsgTime = new Date(lastUserMsg.created_at || lastUserMsg.timestamp).getTime();
        const currentTime = Date.now();
        inactivityMinutes = Math.floor((currentTime - lastMsgTime) / 60000);
        
        console.log(`⏱️ Inactividad calculada: ${inactivityMinutes} minutos desde último mensaje del usuario`);
        console.log(`   - Última actividad: ${new Date(lastMsgTime).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}`);
        console.log(`   - Hora actual: ${new Date(currentTime).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}`);
        
        // Notificar si han pasado más de 10 minutos
        shouldNotifyInactive = inactivityMinutes > 10;
        console.log(`🔔 ¿Notificar por inactividad? ${shouldNotifyInactive ? 'SÍ' : 'NO'} (umbral: 10 min)`);
      }
    }
    
    // 🔔 Notificar nueva conversación al staff (SOLO EMAIL)
    if (isNewConversation) {
      console.log('🆕 Nueva conversación detectada - enviando notificación EMAIL al staff');
      console.log('📧 [DEBUG] Destinatarios: salud.bioskin@gmail.com, rafa1227_g@hotmail.com, dannypau.95@gmail.com');
      console.log('📧 [DEBUG] Teléfono cliente:', from);
      console.log('📧 [DEBUG] Mensaje:', userMessage.substring(0, 100));
      
      try {
        const response = await fetch('https://saludbioskin.vercel.app/api/sendEmail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notificationType: 'chatbot_new_conversation',
            phone: from,
            message: userMessage,
            name: 'Chatbot BIOSKIN',
            email: 'noreply@bioskin.com'
          })
        });
        
        // ✅ VERIFICAR RESPUESTA HTTP
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: 'Sin detalles' }));
          console.error('❌ Email nueva conversación FALLÓ');
          console.error('❌ Status:', response.status, response.statusText);
          console.error('❌ Error:', errorData);
        } else {
          const result = await response.json().catch(() => ({ message: 'OK' }));
          console.log('✅ Notificación EMAIL de nueva conversación enviada CORRECTAMENTE');
          console.log('✅ Resultado:', result.message || 'Email enviado');
        }
      } catch (notifyError) {
        console.error('❌ Error CRÍTICO enviando notificación de nueva conversación:', notifyError.message);
        console.error('❌ Tipo:', notifyError.name);
        console.error('❌ Stack:', notifyError.stack);
      }
    }

    // 🔔 Notificar reactivación de conversación inactiva (>10 minutos)
    if (shouldNotifyInactive) {
      console.log(`⏰ Cliente volvió después de ${inactivityMinutes} minutos - enviando notificación EMAIL al staff`);
      console.log('📧 [DEBUG] Destinatarios: salud.bioskin@gmail.com, rafa1227_g@hotmail.com, dannypau.95@gmail.com');
      console.log('📧 [DEBUG] Inactividad:', inactivityMinutes, 'minutos');
      
      try {
        const response = await fetch('https://saludbioskin.vercel.app/api/sendEmail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notificationType: 'chatbot_reactivation',
            phone: from,
            message: userMessage,
            inactivityMinutes: inactivityMinutes,
            name: 'Chatbot BIOSKIN',
            email: 'noreply@bioskin.com'
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: 'Sin detalles' }));
          console.error('❌ Email reactivación FALLÓ');
          console.error('❌ Status:', response.status, response.statusText);
          console.error('❌ Error:', errorData);
        } else {
          const result = await response.json().catch(() => ({ message: 'OK' }));
          console.log('✅ Notificación EMAIL de reactivación enviada CORRECTAMENTE');
          console.log('✅ Resultado:', result.message || 'Email enviado');
        }
      } catch (notifyError) {
        console.error('❌ Error CRÍTICO enviando notificación de reactivación:', notifyError.message);
        console.error('❌ Stack:', notifyError.stack);
      }
    }


    // Guardar mensaje del usuario (con fallback)
    console.log('💾 Paso 4: Guardando mensaje del usuario...');
    
    // 🛡️ PREVENCIÓN DE DUPLICADOS (REINTENTOS DE WHATSAPP)
    // Si el mensaje ya existe en la DB (mismo ID), es un reintento.
    // Debemos ignorarlo para evitar respuestas duplicadas.
    if (messageId) {
      const existingMessages = await withFallback(
        () => getConversationHistory(sessionId, 5), // Revisar últimos 5
        () => FallbackStorage.getConversationHistory(sessionId, 5),
        'Verificar duplicados'
      );
      
      const isDuplicate = existingMessages.some(m => m.message_id === messageId);
      if (isDuplicate) {
        console.log(`🛑 DUPLICADO DETECTADO: Mensaje ${messageId} ya procesado. Ignorando reintento.`);
        return; // Salir silenciosamente, ya se procesó
      }
    }

    await withFallback(
      () => saveMessage(sessionId, 'user', userMessage, 0, messageId),
      () => FallbackStorage.saveMessage(sessionId, 'user', userMessage, 0, messageId),
      'Guardar mensaje usuario'
    );
    console.log('✅ Mensaje del usuario guardado');

    // =================================================================================
    // ⏳ DEBOUNCE / ESPERA INTELIGENTE (NUEVO)
    // =================================================================================
    // Esperar un momento para permitir que el usuario envíe mensajes consecutivos
    // y evitar respuestas fragmentadas.
    // ✅ AHORA SEGURO: La detección de duplicados (arriba) maneja los reintentos de WhatsApp.
    // Restauramos a 10s como solicitó el usuario (tiempo probado que funciona bien).
    const DEBOUNCE_TIME_MS = 10000; 
    console.log(`⏳ Iniciando espera de ${DEBOUNCE_TIME_MS}ms para agrupar mensajes...`);
    
    // Simular espera (sleep)
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_TIME_MS));

    // Verificar si este proceso sigue siendo el "último"
    // Obtenemos el historial MÁS RECIENTE (solo el último mensaje)
    const latestMessages = await withFallback(
      () => getConversationHistory(sessionId, 1),
      () => FallbackStorage.getConversationHistory(sessionId, 1),
      'Verificar último mensaje'
    );

    if (latestMessages && latestMessages.length > 0) {
      const lastDbMessage = latestMessages[0]; // El más reciente (orden DESC en DB, pero getConversationHistory devuelve reverse... espera)
      
      // getConversationHistory devuelve [oldest, ..., newest]
      // Así que el último elemento del array es el más reciente.
      // Pero si pedimos LIMIT 1, devuelve un array de 1 elemento.
      
      // Verifiquemos la implementación de getConversationHistory:
      // return messages.rows.reverse();
      // Si DB devuelve [Newest], reverse es [Newest].
      // Así que latestMessages[0] es el mensaje más reciente.
      
      // Comparamos IDs si existen, o contenido/timestamp
      let isLatest = false;
      
      if (messageId && lastDbMessage.message_id) {
        isLatest = lastDbMessage.message_id === messageId;
        console.log(`🔍 Comparando IDs: Local=${messageId} vs DB=${lastDbMessage.message_id} -> ${isLatest}`);
      } else {
        // Fallback a contenido si no hay IDs (ej. FallbackStorage)
        isLatest = lastDbMessage.content === userMessage;
        console.log(`🔍 Comparando Contenido: Local="${userMessage.substring(0,20)}" vs DB="${lastDbMessage.content?.substring(0,20)}" -> ${isLatest}`);
      }
      
      if (!isLatest) {
         console.log(`🛑 DEBOUNCE: Detectado mensaje más reciente en DB. Abortando respuesta para mensaje anterior.`);
         return; // Salir silenciosamente, el otro proceso responderá
      }
      console.log(`✅ DEBOUNCE: Este es el último mensaje. Procediendo a responder.`);
    }
    // =================================================================================

    // Actualizar historial después de guardar el mensaje del usuario
    console.log('💾 Paso 5: Actualizando historial...');
    const updatedHistory = await withFallback(
      () => getConversationHistory(sessionId, 20),
      () => FallbackStorage.getConversationHistory(sessionId, 20),
      'Actualizar historial'
    );
    console.log(`✅ Historial actualizado: ${updatedHistory.length} mensajes`);

    // ============================================
    // CHECK GLOBAL SETTINGS (AFTER SAVING MESSAGE)
    // ============================================
    try {
      const settings = await getGlobalSettings();
      if (settings && settings.chatbotEnabled === false) {
        console.log('🛑 Chatbot DESHABILITADO globalmente. Mensaje guardado, pero no se generará respuesta automática.');
        return;
      }
    } catch (settingsError) {
      console.error('⚠️ Error verificando configuración global (continuando por seguridad):', settingsError);
    }

    // ============================================
    // PASO 4.3: SISTEMA DE OPCIONES Y RECONOCIMIENTO NUMÉRICO
    // ============================================
    console.log('🔢 Paso 4.3: Verificando si responde a opciones previas...');
    
    const lastBotQuestion = getLastBotQuestion(sessionId);
    
    if (lastBotQuestion) {
      console.log(`✅ [Options] Última pregunta encontrada: ${lastBotQuestion.id}`);
      
      const parseResult = parseOptionReply(userMessage, lastBotQuestion);
      
      if (parseResult.matched) {
        console.log(`✅ [Options] Match encontrado: opción ${parseResult.optionId} (confidence: ${parseResult.confidence})`);
        
        // Guardar evento de tracking
        try {
          await saveTrackingEvent(sessionId, 'option_chosen', {
            questionId: lastBotQuestion.id,
            optionId: parseResult.optionId,
            optionLabel: parseResult.option.label,
            parseConfidence: parseResult.confidence,
            rawMessage: userMessage
          });
          console.log(`✅ [Options] Evento option_chosen guardado`);
        } catch (trackError) {
          console.warn(`⚠️ [Options] No se pudo guardar tracking (no crítico):`, trackError.message);
        }
        
        // Ejecutar acción según la opción elegida
        const action = parseResult.option.action;
        const payload = parseResult.option.payload;
        
        console.log(`🎯 [Options] Ejecutando acción: ${action}`);
        
        // Variable para respuesta directa
        let directResponse = null;
        let skipAI = true; // Bypass IA cuando se ejecuta acción de opción
        
        if (action === 'book_treatment') {
          console.log(`📅 [Options] Acción: Agendar tratamiento ${payload.treatmentId}`);
          
          // Verificar que stateMachine esté en IDLE antes de iniciar
          const stateMachine = getStateMachine(sessionId, from);
          
          if (stateMachine.state === APPOINTMENT_STATES.IDLE) {
            const result = stateMachine.start(from, {
              treatmentId: payload.treatmentId || payload.treatmentName,
              contextQuestionId: lastBotQuestion.id,
              treatmentPrice: payload.treatmentPrice,
              consultationIncluded: true,
              name: userInfo?.name
            });
            directResponse = result.message;
            saveStateMachine(sessionId, stateMachine);
            
            // Limpiar pregunta procesada
            lastBotQuestions.delete(sessionId);
          } else {
            directResponse = `Ya hay un proceso de agendamiento activo. ¿Desea cancelarlo y empezar uno nuevo?`;
          }
        }
        else if (action === 'more_info') {
          console.log(`ℹ️ [Options] Acción: Más información sobre ${payload.treatmentId}`);
          
          // 🤖 USAR IA CON CONTEXTO COMPLETO en lugar de respuesta predefinida
          try {
            // Crear prompt específico para IA con contexto completo
            const infoRequestPrompt = `El usuario solicitó más información sobre: ${payload.treatmentName || payload.treatmentId}`;
            
            // Agregar mensaje del usuario al historial para contexto
            await withFallback(
              () => saveMessage(sessionId, 'user', infoRequestPrompt, Date.now()),
              () => FallbackStorage.saveMessage(sessionId, 'user', infoRequestPrompt, Date.now()),
              'Guardar solicitud de más información'
            );
            
            // Actualizar historial
            updatedHistory.push({ role: 'user', content: infoRequestPrompt });
            
            // Generar respuesta con IA Medical usando contexto completo
            const medicalResponse = await generateMedicalReply(
              {
                subtype: 'treatment_inquiry',
                treatment: payload.treatmentId,
                confidence: 0.95,
                needsConsultation: false
              },
              updatedHistory,
              null,
              userInfo
            );
            
            directResponse = medicalResponse.responseText;
            console.log(`✅ [Options] Respuesta de IA generada con contexto completo`);
            
          } catch (error) {
            console.error(`❌ [Options] Error generando respuesta con IA:`, error.message);
            
            // Fallback: buscar tratamiento básico
            const treatment = findServiceByKeyword(payload.treatmentId);
            
            if (treatment) {
              directResponse = `📋 *${treatment.title}*\n\n`;
              directResponse += `${treatment.description}\n\n`;
              
              // Verificar promoción activa
              if (treatment.promotion && treatment.promotion.active) {
                const promo = treatment.promotion;
                const now = new Date();
                const validFrom = new Date(promo.validFrom);
                const validUntil = new Date(promo.validUntil);
                
                if (now >= validFrom && now <= validUntil) {
                  directResponse += `🎁 ${promo.displayMessage}\n`;
                  directResponse += `💰 Precio promocional: ${promo.promoPrice}\n`;
                  directResponse += `💵 Precio regular: ${treatment.price}\n\n`;
                } else {
                  directResponse += `💰 Inversión: ${treatment.price}\n\n`;
                }
              } else {
                directResponse += `💰 Inversión: ${treatment.price}\n\n`;
              }
              
              directResponse += `⏱️ Duración: ${treatment.duration}\n\n`;
              directResponse += `¿Le gustaría agendar una cita o tiene alguna otra consulta?`;
            } else {
              directResponse = `Lo siento, no encontré información adicional sobre ese tratamiento. ¿Puedo ayudarle con algo más?`;
            }
          }
          
          // Limpiar pregunta procesada
          lastBotQuestions.delete(sessionId);
        }
        else if (action === 'transfer_doctor') {
          console.log(`👩‍⚕️ [Options] Acción: Transferir a Dra. Daniela`);
          
          // Generar link de WhatsApp con contexto
          const whatsappLink = generateDoctorWhatsAppLink(
            updatedHistory,
            { isTechnical: false, patientName: null }
          );
          
          directResponse = `Perfecto. Aquí está el enlace para contactar directamente con la Dra. Daniela:\n\n${whatsappLink}\n\nElla le brindará una atención personalizada 😊`;
          
          // Limpiar pregunta procesada
          lastBotQuestions.delete(sessionId);
        }
        
        // Si hay respuesta directa, usarla y saltear el resto del flujo
        if (directResponse) {
          console.log(`✅ [Options] Respuesta directa generada: "${directResponse.substring(0, 60)}..."`);
          
          // Guardar respuesta y enviar
          await withFallback(
            () => saveMessage(sessionId, 'assistant', directResponse, 0),
            () => FallbackStorage.saveMessage(sessionId, 'assistant', directResponse, 0),
            'Guardar respuesta directa'
          );
          
          await sendWhatsAppMessage(from, directResponse);
          console.log('✅ Mensaje enviado (opción procesada)');
          return;
        }
      } else {
        // No coincidió - pero NO asumir que está fuera de contexto
        console.log(`❌ [Options] No match de opción, pero puede ser consulta válida: "${userMessage}"`);
        
        // En lugar de forzar clarificación, verificar si es una consulta médica real
        const seemsLikeMedicalQuery = /(tratamiento|bioestimulador|colágeno|manchas|arrugas|piel|rostro|facial|láser|hifu|botox|relleno|precio|costo|cuánto|promoción|valor|cuesta|dólares|usd)/i.test(userMessage);
        
        if (seemsLikeMedicalQuery) {
          console.log(`🤖 [Options] Mensaje parece consulta médica válida, permitiendo que IA procese con contexto completo`);
          // NO enviar clarificación, permitir que continúe el flujo normal de IA
          // Limpiar la pregunta previa para no seguir esperando opciones
          lastBotQuestions.delete(sessionId);
          
        } else {
          // Solo clarificar si realmente parece fuera de contexto (mensajes muy cortos sin contenido médico)
          // AUMENTADO UMBRAL: Mensajes de menos de 4 caracteres son sospechosos, pero "cuanto cuesta" tiene 13
          const seemsOffContext = userMessage.length < 4 && 
                                 !/^(hola|buenos|gracias|no|si|sí|ok|ya)/i.test(userMessage);
          
          if (seemsOffContext) {
            console.log(`🤔 [Options] Respuesta muy corta y sin contenido médico, clarificando opciones...`);
            
            const clarificationText = `Disculpe, no entendí. Estaba preguntándole sobre:\n\n` +
              lastBotQuestion.options.map((opt, idx) => `${opt.id}. ${opt.label}`).join('\n') +
              `\n\n¿Podría responder con el número de su opción preferida?`;
            
            // Enviar clarificación sin pasar por el resto del flujo
            await withFallback(
              () => saveMessage(sessionId, 'assistant', clarificationText, 0),
              () => FallbackStorage.saveMessage(sessionId, 'assistant', clarificationText, 0),
              'Guardar clarificación'
            );
            
            await sendWhatsAppMessage(from, clarificationText);
            console.log('✅ Clarificación enviada');
            return;
          } else {
            console.log(`✅ [Options] Mensaje tiene contenido, permitiendo procesamiento normal con IA`);
            // Limpiar la pregunta previa
            lastBotQuestions.delete(sessionId);
          }
        }
      }
    } else {
      console.log(`ℹ️ [Options] No hay pregunta previa guardada`);
    }

    // ============================================
    // PASO 4.5: SISTEMA DE MÁQUINA DE ESTADOS PARA AGENDAMIENTO
    // ============================================
    console.log('📅 Paso 4.5: Verificando estado de agendamiento...');
    
    // Obtener o crear máquina de estados para esta sesión
    const stateMachine = getStateMachine(sessionId, from);
    console.log(`🔧 [StateMachine] Estado actual: ${stateMachine.state}`);
    
    // Variable para respuesta directa (bypass IA si estamos en flujo de agendamiento)
    let directResponse = null;
    let skipAI = false; // ⚠️ CRÍTICO: Si true, NO usar IA bajo ninguna circunstancia
    
    // Detectar intención básica
    const intent = chatbotAI.detectIntent(userMessage);
    
    // CASO 0: Usuario quiere cancelar una cita existente
    if (intent === 'cancellation') {
      console.log('🚫 [StateMachine] Usuario quiere cancelar cita');
      directResponse = "Entiendo completamente, son cosas que pasan. No te preocupes. 🍃\n\nCuando desees retomar tu tratamiento, estaré aquí para ayudarte. Si gustas, podemos buscar otro espacio ahora mismo, o puedes escribirme cuando tengas disponibilidad.\n\n¿Prefieres que busquemos un nuevo horario ahora o lo dejamos para después?";
      skipAI = true;
    }
    // CASO 1: Usuario quiere iniciar agendamiento y está en IDLE
    else if (intent === 'appointment' && stateMachine.state === APPOINTMENT_STATES.IDLE) {
      console.log('🎯 [StateMachine] Usuario solicita agendamiento');
      
      // Verificar si el usuario ya eligió la opción 2 (guía paso a paso) o muestra intención clara de agendar en el chat
      // Patrones ampliados para capturar "agendemos", "reservar ya", "hazlo tú", etc.
      const wantsGuidance = /(por\s+)?aqu[íi]|opci[óo]n\s*2|la\s*2|gu[íi]a|ayuda|paso\s+a\s+paso|contigo|asist|agendemos|reservar\s*ya|hazme\s*la\s*cita|an[óo]tame|ap[úu]ntame|dale\s*de\s*una|hazlo\s*t[úu]|quiero\s*la\s*cita/i.test(userMessage);
      
      console.log(`🔍 [StateMachine] ¿Usuario quiere guía? ${wantsGuidance} (mensaje: "${userMessage}")`);
      
      if (wantsGuidance) {
        // Iniciar la máquina de estados
        console.log('✅ [StateMachine] Iniciando flujo guiado');
        skipAI = true; // 🔥 CRÍTICO: Evitar que la IA responda
        const result = stateMachine.start(from, { name: userInfo?.name });
        directResponse = result.message;
        saveStateMachine(sessionId, stateMachine);
      } else {
        // ⚠️ CAMBIO: NO ofrecer opciones inmediatamente si es un mensaje genérico.
        // Dejar que la IA converse primero para obtener contexto (tratamiento de interés).
        console.log('🤖 [StateMachine] Usuario quiere agendar pero dejaremos que la IA converse primero para obtener contexto');
        skipAI = false; 
      }
    }
    // CASO 1.5: Usuario está en IDLE pero responde con preferencia de opción (sin mencionar "agendar")
    else if (stateMachine.state === APPOINTMENT_STATES.IDLE) {
      // Detectar si el usuario está respondiendo a la pregunta "¿Cuál prefieres?"
      const lastBotMsg = updatedHistory.filter(m => m.role === 'assistant').pop()?.content || '';
      const botOfferedOptions = lastBotMsg.includes('Puedo ayudarte de dos formas') || 
                                lastBotMsg.includes('¿Cuál prefieres?') ||
                                lastBotMsg.includes('Te ayudo aquí mismo') ||
                                lastBotMsg.includes('reviso horarios disponibles');
      
      if (botOfferedOptions) {
        // 🔥 DETECCIÓN AGRESIVA: Capturar "2" o cualquier indicación de opción 2
        const wantsGuidance = /(por\s+)?aqu[íi]|opci[óo]n\s*2|la\s*2|gu[íi]a|ayuda|paso\s+a\s+paso|contigo|asist|^2$|^\s*2\s*$|agendemos|reservar\s*ya|hazme\s*la\s*cita|an[óo]tame|ap[úu]ntame|dale\s*de\s*una|hazlo\s*t[úu]|quiero\s*la\s*cita/i.test(userMessage);
        const wantsLink = /opci[óo]n\s*1|la\s*1|link|directo|solo|dame|^1$|^\s*1\s*$/i.test(userMessage);
        
        console.log(`🔍 [StateMachine] Bot ofreció opciones, usuario respondió: guidance=${wantsGuidance}, link=${wantsLink}`);
        console.log(`🔍 [StateMachine] Mensaje exacto: "${userMessage}"`);
        console.log(`🔍 [StateMachine] Último mensaje del bot: "${lastBotMsg.substring(0, 100)}..."`);
        
        if (wantsGuidance) {
          console.log('✅ [StateMachine] Usuario eligió guía paso a paso - ACTIVANDO MÁQUINA DE ESTADOS');
          skipAI = true; // 🔥 CRÍTICO: Evitar que la IA responda
          const result = stateMachine.start(from, { name: userInfo?.name });
          directResponse = result.message;
          saveStateMachine(sessionId, stateMachine);
        } else if (wantsLink) {
          console.log('✅ [StateMachine] Usuario eligió link directo');
          skipAI = true; // 🔥 CRÍTICO: Evitar que la IA responda
          directResponse = `Perfecto, aquí está el link para agendar:\n\n${APPOINTMENT_LINK}\n\n¡Te esperamos! 😊`;
        }
      }
      
      // CASO ESPECIAL: Usuario pregunta directamente por disponibilidad de una fecha
      // Ejemplo: "Podrías decirme si hay disponibilidad para mañana"
      const asksAvailability = /(disponibilidad|disponible|libre|horario|puedo\s+ir).*?(ma[ñn]ana|pasado|lunes|martes|miércoles|jueves|viernes|sábado|\d{1,2}\/\d{1,2})/i.test(userMessage);
      
      if (asksAvailability && !botOfferedOptions) {
        console.log('🔍 [StateMachine] Usuario pregunta por disponibilidad de fecha específica');
        skipAI = true; // 🔥 CRÍTICO: Evitar que la IA responda
        // Iniciar el flujo automáticamente sin ofrecer opciones
        const result = stateMachine.start(from, { name: userInfo?.name });
        directResponse = result.message;
        saveStateMachine(sessionId, stateMachine);
      }
    }
    // CASO 2: Ya hay un flujo de agendamiento activo
    else if (stateMachine.isActive()) {
      console.log('🔄 [StateMachine] Procesando mensaje en flujo activo');
      skipAI = true; // ⚠️ CRÍTICO: Máquina de estados tiene control total
      
      try {
        // Crear callback para notificar al staff cuando se crea una cita (WhatsApp + Email)
        const onAppointmentCreated = async (appointmentData) => {
          console.log('📢 [Webhook] === INICIANDO NOTIFICACIONES AL STAFF (AGENDAMIENTO) ===');
          console.log('📢 [DEBUG] appointmentData:', JSON.stringify(appointmentData, null, 2));
          console.log('📢 [DEBUG] Número paciente (from):', from);
          console.log('📢 [DEBUG] Número BIOSKIN destino: +593969890689');
          console.log('📢 [DEBUG] WHATSAPP_ACCESS_TOKEN presente:', !!process.env.WHATSAPP_ACCESS_TOKEN);
          console.log('📢 [DEBUG] WHATSAPP_PHONE_NUMBER_ID presente:', !!process.env.WHATSAPP_PHONE_NUMBER_ID);
          
          try {
            // 1. Notificación por WhatsApp
            console.log('📱 [WhatsApp] Llamando a notifyStaffNewAppointment...');
            const whatsappResult = await notifyStaffNewAppointment(appointmentData, from);
            
            // ✅ VERIFICAR RESULTADO DE WHATSAPP
            if (!whatsappResult || !whatsappResult.success) {
              console.error('❌ [WhatsApp] FALLÓ notificación de agendamiento');
              console.error('❌ [WhatsApp] Error:', whatsappResult?.error || 'Sin detalles');
              console.error('❌ [WhatsApp] Stack:', whatsappResult?.stack || 'N/A');
              console.error('❌ [WhatsApp] Número destino intentado:', whatsappResult?.number || 'desconocido');
            } else {
              console.log('✅ [WhatsApp] Notificación de agendamiento enviada CORRECTAMENTE');
              console.log('✅ [WhatsApp] Destinatario:', whatsappResult.recipient);
              console.log('✅ [WhatsApp] Número:', whatsappResult.number);
            }
            
            // 2. Notificación por Email
            console.log('📧 [Email] Enviando notificación de agendamiento...');
            const emailResponse = await fetch('https://saludbioskin.vercel.app/api/sendEmail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                notificationType: 'chatbot_appointment',
                name: appointmentData.name,
                phone: from,
                service: appointmentData.service,
                message: appointmentData.date,
                email: appointmentData.hour
              })
            });
            
            // ✅ VERIFICAR RESPUESTA HTTP DEL EMAIL
            if (!emailResponse.ok) {
              const emailError = await emailResponse.json().catch(() => ({ message: 'Sin detalles' }));
              console.error('❌ [Email] FALLÓ notificación de agendamiento');
              console.error('❌ [Email] Status:', emailResponse.status, emailResponse.statusText);
              console.error('❌ [Email] Error:', emailError);
            } else {
              const emailResult = await emailResponse.json().catch(() => ({ message: 'OK' }));
              console.log('✅ [Email] Notificación de agendamiento enviada CORRECTAMENTE');
              console.log('✅ [Email] Resultado:', emailResult.message || 'Email enviado');
            }
            
            console.log('✅ [Webhook] Proceso de notificaciones completado');
          } catch (notifyError) {
            console.error('❌ [Webhook] Error CRÍTICO en notificaciones:', notifyError.message);
            console.error('❌ [Webhook] Tipo de error:', notifyError.name);
            console.error('❌ [Webhook] Stack trace completo:', notifyError.stack);
            // No lanzar error para que el agendamiento se complete de todos modos
          }
        };

        const result = await stateMachine.processMessage(userMessage, onAppointmentCreated);
        directResponse = result.message;
        
        // Guardar estado actualizado
        saveStateMachine(sessionId, stateMachine);
        
        // Si se completó el agendamiento, limpiar la máquina
        if (result.completed) {
          console.log('✅ [StateMachine] Agendamiento completado, limpiando máquina');
          stateMachine.reset();
          skipAI = false; // Permitir IA de nuevo después de completar
        }
        
        console.log(`✅ [StateMachine] Nuevo estado: ${stateMachine.state}`);
      } catch (error) {
        console.error('❌ [StateMachine] Error procesando mensaje:', error);
        directResponse = `⚠️ Hubo un problema procesando tu solicitud.\n\n¿Quieres empezar de nuevo o prefieres agendar en: ${APPOINTMENT_LINK}?`;
        stateMachine.reset();
        skipAI = false;
      }
    }

    // ============================================
    // PASO 4.7: SISTEMA DUAL DE IA ESPECIALIZADA (MÉDICO + TÉCNICO)
    // ============================================
    console.log('🧬 Paso 4.7: Verificando tipo de consulta (Médico-Estético vs Técnico)...');
    
    // 🚨 CRÍTICO: Si skipAI está activado (máquina de estados activa), saltar toda la clasificación
    if (skipAI) {
      console.log('⏭️ [Dual AI] skipAI=true detectado, saltando clasificación y respuesta de IA');
    }
    
    let technicalClassification = null;
    let medicalClassification = null;
    let specializedResponse = null;
    let userConfirmsEngineerContact = false;
    let userConfirmsDoctorContact = false;
    let userProvidingName = false;
    
    // Detectar confirmación de contacto con especialistas
    const lastBotMsg = updatedHistory.filter(m => m.role === 'assistant').pop()?.content || '';
    const botOfferedEngineerContact = /(departamento técnico|equipo técnico|nuestro técnico).*contacte/i.test(lastBotMsg);
    const botOfferedDoctorContact = /(dra\.|doctora|daniela).*contacte/i.test(lastBotMsg);
    const botAskedForName = /por favor, indíqueme su nombre completo/i.test(lastBotMsg);
    
    userConfirmsEngineerContact = botOfferedEngineerContact && /^(si|sí|ok|dale|claro|por favor|quiero|me gustaría|confirmo|acepto)$/i.test(userMessage.trim());
    userConfirmsDoctorContact = botOfferedDoctorContact && /^(si|sí|ok|dale|claro|por favor|quiero|me gustaría|confirmo|acepto)$/i.test(userMessage.trim());
    userProvidingName = botAskedForName && userMessage.trim().length > 3 && !/^(no|nada|otro|otra)/i.test(userMessage.trim());
    
    // CASO 1A: Usuario confirma que quiere contacto con departamento técnico
    if (userConfirmsEngineerContact) {
      console.log('✅ [Technical] Usuario CONFIRMÓ que quiere contacto con departamento técnico');
      
      // Solicitar nombre
      directResponse = `Perfecto 😊 Para que nuestro departamento técnico pueda contactarle adecuadamente, por favor indíqueme su nombre completo.`;
      skipAI = true;
    }
    // CASO 1B: Usuario confirma que quiere contacto con doctora
    else if (userConfirmsDoctorContact) {
      console.log('✅ [Medical] Usuario CONFIRMÓ que quiere contacto con Dra. Daniela');
      
      // Solicitar nombre
      directResponse = `Perfecto 😊 Para que la Dra. Daniela pueda contactarle adecuadamente, por favor indíqueme su nombre completo.`;
      skipAI = true;
    }
    // CASO 2: Usuario proporciona su nombre
    else if (userProvidingName) {
      console.log('✅ Usuario proporcionó nombre:', userMessage);
      
      const userName = userMessage.trim();
      
      // Determinar si es transferencia técnica o médica basado en historial
      const isTechnicalTransfer = botOfferedEngineerContact;
      const transferType = isTechnicalTransfer ? 'technical' : 'medical';
      
      console.log(`🔀 Tipo de transferencia: ${transferType}`);
      
      if (isTechnicalTransfer) {
        // TRANSFERENCIA TÉCNICA
        const engineerSummary = generateEngineerTransferSummary(
          updatedHistory,
          { subtype: 'technical_transfer', question: 'solicitud_contacto', confidence: 1.0 },
          { productsFound: 0, productIds: [] }
        );
        
        try {
          console.log('📱 [Technical] Enviando notificación interna a BIOSKIN...');
          
          const notificationResult = await notifyStaffGroup('technical_inquiry', {
            name: userName,
            reason: 'Solicitud de contacto con Departamento Técnico',
            summary: engineerSummary,
            query: updatedHistory.filter(m => m.role === 'user').slice(-4).map(m => m.content).join('\n\n')
          }, from);
          
          if (notificationResult.success) {
            console.log('✅ [Technical] Notificación enviada exitosamente a BIOSKIN');
            directResponse = `Perfecto, ${userName} 😊\n\nHe notificado a nuestro departamento técnico sobre su consulta. Se comunicarán con usted a este número (${from}) a la brevedad posible para coordinar la revisión de su equipo.\n\n¿Hay algo más en lo que pueda asistirle mientras tanto?`;
          } else {
            console.error('❌ [Technical] Error enviando notificación:', notificationResult.error);
            directResponse = `Gracias, ${userName} 😊\n\nHe registrado su solicitud. Nuestro departamento técnico se comunicará con usted pronto al ${from}. ¿Hay algo más en lo que pueda ayudarle?`;
          }
        } catch (error) {
          console.error('❌ [Technical] Error crítico en notificación:', error.message);
          directResponse = `Gracias, ${userName} 😊\n\nSu solicitud ha sido registrada. Nos comunicaremos con usted pronto. ¿Puedo ayudarle con algo más?`;
        }
      } else {
        // TRANSFERENCIA MÉDICA
        const doctorSummary = generateDoctorTransferSummary(
          updatedHistory,
          { subtype: 'medical_transfer', concern: 'solicitud_contacto', confidence: 1.0 },
          { treatmentsFound: 0, treatmentIds: [] }
        );
        
        // Generar link de WhatsApp para Dra. Daniela
        const whatsappLink = generateDoctorWhatsAppLink(updatedHistory, userName);
        
        directResponse = `Perfecto, ${userName} 😊\n\nAquí está el enlace para contactar directamente con la Dra. Daniela:\n\n${whatsappLink}\n\nElla le brindará una atención personalizada y podrá resolver todas sus dudas sobre tratamientos estéticos ✨\n\n¿Hay algo más en lo que pueda asistirle?`;
        
        console.log('✅ [Medical] Link de WhatsApp generado para Dra. Daniela');
      }
      
      skipAI = true;
    }
    
    // 🚨 CRÍTICO: Solo clasificar si skipAI NO está activado
    // (skipAI se activa cuando la máquina de estados toma control o hay directResponse)
    if (!skipAI && !directResponse && !userConfirmsEngineerContact && !userConfirmsDoctorContact && !userProvidingName) {
      try {
        // 🔬 CLASIFICACIÓN DUAL EN PARALELO (Médico-Estético + Técnico)
        console.log('🔄 Ejecutando clasificación dual en paralelo...');
        
        const [technicalResult, medicalResult] = await Promise.all([
          classifyTechnical(userMessage, updatedHistory).catch(err => {
            console.error('❌ Error en clasificación técnica:', err.message);
            return { kind: 'general', confidence: 0, subtype: 'error' };
          }),
          classifyMedical(userMessage, updatedHistory).catch(err => {
            console.error('❌ Error en clasificación médica:', err.message);
            return { kind: 'general', confidence: 0, subtype: 'error' };
          })
        ]);
        
        technicalClassification = technicalResult;
        medicalClassification = medicalResult;
        
        console.log(`🔍 [Technical] ${technicalClassification.kind}/${technicalClassification.subtype} (${technicalClassification.confidence.toFixed(2)})`);
        console.log(`🔍 [Medical] ${medicalClassification.kind}/${medicalClassification.subtype} (${medicalClassification.confidence.toFixed(2)})`);
        
        // 🎯 DECISIÓN DE ENRUTAMIENTO BASADA EN CONFIANZA
        const CONFIDENCE_THRESHOLD = 0.70;
        const isTechnical = technicalClassification.kind === 'technical' && technicalClassification.confidence >= CONFIDENCE_THRESHOLD;
        const isMedical = medicalClassification.kind === 'medical' && medicalClassification.confidence >= CONFIDENCE_THRESHOLD;
        
        // CASO 1: Ambos sistemas detectan alta confianza (conflicto) - usar el de mayor confianza
        if (isTechnical && isMedical) {
          console.log('⚠️ [Dual AI] Ambos sistemas detectaron alta confianza, usando el mayor...');
          
          if (technicalClassification.confidence > medicalClassification.confidence) {
            console.log(`✅ [Dual AI] Priorizando TÉCNICO (${technicalClassification.confidence.toFixed(2)} > ${medicalClassification.confidence.toFixed(2)})`);
            specializedResponse = await generateTechnicalReply(technicalClassification, updatedHistory);
            
            await withFallback(
              () => saveTrackingEvent(sessionId, 'technical_detected', {
                classification: technicalClassification.subtype,
                confidence: technicalClassification.confidence,
                medicalConfidence: medicalClassification.confidence,
                conflict: true
              }),
              () => FallbackStorage.saveEvent(sessionId, 'technical_detected', { subtype: technicalClassification.subtype }),
              'Guardar tracking técnico'
            );
          } else {
            console.log(`✅ [Dual AI] Priorizando MÉDICO (${medicalClassification.confidence.toFixed(2)} > ${technicalClassification.confidence.toFixed(2)})`);
            specializedResponse = await generateMedicalReply(medicalClassification, updatedHistory, null, userInfo);
            
            await withFallback(
              () => saveTrackingEvent(sessionId, 'medical_detected', {
                classification: medicalClassification.subtype,
                confidence: medicalClassification.confidence,
                technicalConfidence: technicalClassification.confidence,
                conflict: true
              }),
              () => FallbackStorage.saveEvent(sessionId, 'medical_detected', { subtype: medicalClassification.subtype }),
              'Guardar tracking médico'
            );
          }
        }
        // CASO 2: Solo técnico tiene alta confianza
        else if (isTechnical) {
          console.log('✅ [Technical] Consulta técnica detectada, generando respuesta especializada...');
          
          specializedResponse = await generateTechnicalReply(technicalClassification, updatedHistory);
          
          console.log(`✅ [Technical] Respuesta generada: ${specializedResponse.responseText.substring(0, 60)}...`);
          console.log(`🎯 [Technical] Acciones sugeridas: ${specializedResponse.suggestedActions.join(', ')}`);
          
          await withFallback(
            () => saveTrackingEvent(sessionId, 'technical_detected', {
              classification: technicalClassification.subtype,
              confidence: technicalClassification.confidence,
              productsFound: specializedResponse.meta.productsFound,
              suggestedActions: specializedResponse.suggestedActions
            }),
            () => FallbackStorage.saveEvent(sessionId, 'technical_detected', { subtype: technicalClassification.subtype }),
            'Guardar tracking técnico'
          );
          
          // Contar mensajes técnicos previos
          const technicalMessagesCount = updatedHistory.filter(msg => 
            msg.role === 'user' && 
            (/(equipo|dispositivo|aparato|hifu|laser|ipl|yag|co2|analizador)/i.test(msg.content))
          ).length;
          
          const userRequestsContact = /(hablar|contactar|comunicar|llamar|técnico|especialista|que me contacte|quiero hablar|necesito ayuda)/i.test(userMessage);
          const shouldOfferContact = userRequestsContact || 
                                    (technicalClassification.subtype === 'warranty' && technicalMessagesCount > 1) ||
                                    (technicalMessagesCount > 3);
          
          if (specializedResponse.suggestedActions.includes('transfer_engineer') && shouldOfferContact) {
            specializedResponse.responseText += `\n\n¿Le gustaría que nuestro departamento técnico le contacte directamente para resolver esta consulta? 🔧`;
            console.log(`📞 [Technical] Ofreciendo contacto con departamento técnico (${technicalMessagesCount} msgs técnicos)`);
          }
        }
        // CASO 3: Solo médico tiene alta confianza
        else if (isMedical) {
          console.log('✅ [Medical] Consulta médico-estética detectada, generando respuesta especializada...');
          
          // 🚨 CRÍTICO: Si es solicitud de agendamiento, activar máquina de estados directamente
          if (medicalClassification.subtype === 'appointment_request') {
            console.log('🚨 [URGENT] appointment_request detectado - ACTIVANDO MÁQUINA DE ESTADOS');
            skipAI = true; // ⚠️ CRÍTICO: Evitar generación de IA
            const result = stateMachine.start(from, { name: userInfo?.name });
            // ✅ FIX: Agregar mensaje de transición amigable antes del menú
            directResponse = `¡Perfecto! Te comunico con nuestro *Asistente Virtual* para agendar tu cita paso a paso. 🤖📅\n\n${result.message}`;
            saveStateMachine(sessionId, stateMachine);
            
            await withFallback(
              () => saveTrackingEvent(sessionId, 'appointment_started', {
                classification: 'appointment_request',
                confidence: medicalClassification.confidence,
                source: 'dual_ai_medical'
              }),
              () => FallbackStorage.saveEvent(sessionId, 'appointment_started', { subtype: 'appointment_request' }),
              'Guardar tracking de inicio de agendamiento'
            );
          } else {
            // Procesar normalmente otros tipos de consultas médicas
            specializedResponse = await generateMedicalReply(medicalClassification, updatedHistory, null, userInfo);
            
            console.log(`✅ [Medical] Respuesta generada: ${specializedResponse.responseText.substring(0, 60)}...`);
            console.log(`🎯 [Medical] Acciones sugeridas: ${specializedResponse.suggestedActions.join(', ')}`);
            
            await withFallback(
              () => saveTrackingEvent(sessionId, 'medical_detected', {
                classification: medicalClassification.subtype,
                confidence: medicalClassification.confidence,
                treatmentsFound: specializedResponse.meta.treatmentsFound,
                suggestedActions: specializedResponse.suggestedActions
              }),
              () => FallbackStorage.saveEvent(sessionId, 'medical_detected', { subtype: medicalClassification.subtype }),
              'Guardar tracking médico'
            );
            
            // Contar mensajes sobre tratamientos previos
            const medicalMessagesCount = updatedHistory.filter(msg => 
              msg.role === 'user' && 
              (/(tratamiento|manchas|arrugas|acné|piel|rostro|rejuvenec|lifting|botox|relleno)/i.test(msg.content))
            ).length;
            
            const userRequestsContact = /(hablar|contactar|comunicar|llamar|doctora|dra|especialista|que me contacte|quiero hablar|necesito consulta)/i.test(userMessage);
            const shouldOfferContact = userRequestsContact || 
                                      (medicalClassification.subtype === 'skin_concern' && medicalMessagesCount > 2) ||
                                      (medicalMessagesCount > 4);
            
            if (specializedResponse.suggestedActions.includes('transfer_doctor') && shouldOfferContact) {
              specializedResponse.responseText += `\n\n¿Le gustaría que la Dra. Daniela le contacte directamente para una evaluación personalizada? 👩‍⚕️✨`;
              console.log(`📞 [Medical] Ofreciendo contacto con Dra. Daniela (${medicalMessagesCount} msgs médicos)`);
            }
          }
        }
        // CASO 4: Ninguno tiene alta confianza - continuar con IA general
        else {
          console.log(`ℹ️ [Dual AI] Ambas confianzas bajas (T:${technicalClassification.confidence.toFixed(2)}, M:${medicalClassification.confidence.toFixed(2)}), usando IA general`);
        }
        
        // Si se generó respuesta especializada, usarla
        if (specializedResponse) {
          directResponse = specializedResponse.responseText;
          skipAI = true;
          console.log('✅ [Dual AI] Respuesta especializada establecida como directResponse');
          
          // Si la respuesta médica incluye opciones, guardarlas
          if (specializedResponse.options && specializedResponse.options.length > 0) {
            console.log(`🔢 [Options] Respuesta con ${specializedResponse.options.length} opciones detectada`);
            
            await saveLastBotQuestion(sessionId, {
              id: specializedResponse.lastQuestionId,
              options: specializedResponse.options,
              timestamp: Date.now(),
              expiresAt: specializedResponse.expiresAt,
              type: isMedical ? 'medical' : 'technical'
            });
            
            console.log(`✅ [Options] Pregunta guardada para reconocimiento posterior`);
          }

          // Si la respuesta incluye información extraída del usuario, guardarla
          if (specializedResponse.extractedInfo) {
            console.log('👤 [Dual AI] Información de usuario extraída:', specializedResponse.extractedInfo);
            await updateUserInfo(sessionId, specializedResponse.extractedInfo);
          }
        }
        
      } catch (error) {
        console.error('❌ [Dual AI] Error en sistema de clasificación dual:', error.message);
        // Continuar con flujo normal si falla el sistema dual
      }
    }

    // ============================================
    // PASO 5: PREPARAR HERRAMIENTAS DE CALENDAR PARA LA IA
    // ============================================
    const calendarTools = {
      checkAvailability,
      getAvailableHours,
      suggestAvailableHours,
      APPOINTMENT_LINK
    };

    // Generar respuesta con IA (con timeout global de 5s)
    console.log('🤖 Paso 5: Generando respuesta con IA...');
    console.log(`🔑 [AI] OPENAI_API_KEY configurado: ${!!process.env.OPENAI_API_KEY}`);
    let aiResult;
    
    // ✅ SI HAY RESPUESTA DIRECTA (de flujo de agendamiento), USARLA EN LUGAR DE IA
    if (directResponse) {
      console.log(`✅ Usando respuesta directa del flujo de agendamiento: "${directResponse.substring(0, 50)}..."`);
      aiResult = {
        response: directResponse,
        tokensUsed: 0,
        fallback: false,
        direct: true
      };
    }
    // ⚠️ CRÍTICO: Si skipAI está activado, NO usar IA bajo ninguna circunstancia
    else if (skipAI) {
      console.log('⚠️ [CRÍTICO] skipAI activado - Máquina de estados tiene control total');
      // Esto no debería pasar, pero si pasa, informar al usuario
      aiResult = {
        response: 'Estoy procesando tu solicitud de agendamiento. Por favor espera un momento...',
        tokensUsed: 0,
        fallback: false,
        error: 'skipAI activo sin directResponse'
      };
    }
    // TEMPORAL: Usar solo fallback para debug
    else if (DISABLE_OPENAI) {
      console.log('⚠️ [DEBUG] OpenAI desactivado, usando fallback directo');
      const intent = detectSimpleIntent(userMessage);
      let fallbackResponse;
      
      switch (intent) {
        case 'greeting':
          fallbackResponse = `${getTimeBasedGreeting()}, soy el Asistente Interno de BIOSKIN 🏥 ¿En qué puedo ayudarte?`;
          break;
        case 'appointment':
          fallbackResponse = '¿Le gustaría ver todas las opciones disponibles o prefiere agendar en: https://saludbioskin.vercel.app/#/appointment?';
          break;
        case 'info':
          fallbackResponse = 'Contamos con diversos tratamientos de medicina estética ✨ ¿Sobre qué tratamiento desea información?';
          break;
        default:
          fallbackResponse = 'Gracias por su mensaje. ¿En qué puedo asistirle hoy?';
      }
      
      aiResult = {
        response: fallbackResponse,
        tokensUsed: 0,
        fallback: true,
        debug: true
      };
      
      console.log(`✅ Fallback DEBUG activado (${intent}): "${fallbackResponse.substring(0, 30)}..."`);
    } else {
      // Configurar timeout global ANTES de llamar a generateResponse
      let timeoutReached = false;
      const globalTimeoutId = setTimeout(() => {
        timeoutReached = true;
        console.log('⏰ [WEBHOOK] ¡TIMEOUT GLOBAL alcanzado! (15s)');
      }, 15000); // Aumentado a 15 segundos
      
      try {
        console.log('🚀 [WEBHOOK] Iniciando generación de respuesta...');
        aiResult = await chatbotAI.generateResponse(userMessage, updatedHistory, calendarTools, userInfo);
        clearTimeout(globalTimeoutId); // Limpiar timeout si se resuelve
        
        if (timeoutReached) {
          console.log('⚠️ [WEBHOOK] Respuesta llegó DESPUÉS del timeout global');
          throw new Error('RESPONSE_AFTER_TIMEOUT');
        }
        
        console.log(`✅ Respuesta generada: "${aiResult.response.substring(0, 50)}..." (${aiResult.tokensUsed || 0} tokens)`);
        
        // Actualizar info de usuario si la IA extrajo datos nuevos
        if (aiResult.userInfoUpdate) {
          console.log('👤 [AI] Actualizando info de usuario:', aiResult.userInfoUpdate);
          await updateUserInfo(sessionId, aiResult.userInfoUpdate);
        }
        
        if (aiResult.error) {
          console.error('⚠️ Error en generación de respuesta:', aiResult.error);
        }
      } catch (error) {
        clearTimeout(globalTimeoutId);
        console.error('❌ Error CRÍTICO generando respuesta:', error.message);
        console.log('🔄 Usando fallback de emergencia...');
        
        // Fallback de emergencia con detección de intención
        const intent = detectSimpleIntent(userMessage);
        let fallbackResponse;
        
        switch (intent) {
          case 'greeting':
            fallbackResponse = `${getTimeBasedGreeting()}, soy el Asistente Interno de BIOSKIN 🏥 ¿En qué puedo ayudarte?`;
            break;
          case 'appointment':
            fallbackResponse = '¿Le gustaría ver todas las opciones disponibles o prefiere agendar en: https://saludbioskin.vercel.app/#/appointment?';
            break;
          case 'info':
            fallbackResponse = 'Contamos con diversos tratamientos de medicina estética ✨ ¿Sobre qué tratamiento desea información?';
            break;
          default:
            fallbackResponse = 'Gracias por su mensaje. ¿En qué puedo asistirle hoy?';
        }
        
        aiResult = {
          response: fallbackResponse,
          tokensUsed: 0,
          error: error.message,
          fallback: true,
          emergency: true
        };
        
        console.log(`✅ Fallback de emergencia activado (${intent}): "${fallbackResponse.substring(0, 30)}..."`);
      }
    }

    // 🔄 DETECCIÓN DE HANDOFF DE AGENDAMIENTO (IA -> STATE MACHINE)
    // Si la IA dice "Con gusto le ayudo a agendar...", activamos la máquina de estados
    if (aiResult && aiResult.response && 
        (aiResult.response.includes('Con gusto le ayudo a agendar') || 
         aiResult.response.includes('Con gusto le ayudo a gestionar su cita') ||
         (aiResult.response.includes('Un momento por favor') && (aiResult.response.includes('agendar') || aiResult.response.includes('gestionar'))))) {
        
        console.log('🔄 [Handoff] IA indica inicio de agendamiento/gestión. Transfiriendo a Máquina de Estados...');
        
        // Iniciar máquina de estados
        const result = stateMachine.start(from, { name: userInfo?.name });
        
        // Combinar respuesta de transición de IA con el inicio de la máquina
        // Esto asegura que el usuario vea "Con gusto le ayudo..." antes de las opciones
        aiResult.response = `${aiResult.response}\n\n🤖 *Transfiriendo al Asistente Virtual de Reservas...*\n\n${result.message}`;
        
        // Guardar estado
        saveStateMachine(sessionId, stateMachine);
        
        console.log(`✅ [Handoff] Respuesta combinada (IA + StateMachine): "${aiResult.response.substring(0, 50)}..."`);
    }

    // Guardar respuesta del asistente (con fallback)
    console.log('💾 Paso 6: Guardando respuesta del asistente...');
    
    // 🔍 DETECTAR SI SE DEBE TRANSFERIR A LA DOCTORA (ambos sistemas de IA)
    const shouldTransfer = chatbotAI.detectIntent(userMessage) === 'transfer_doctor' ||
                          aiResult.response?.includes('[TRANSFER_TO_DOCTOR]') ||
                          (userMessage.toLowerCase().includes('sí') && 
                           updatedHistory.slice(-2).some(m => m.role === 'assistant' && 
                           m.content.toLowerCase().includes('conecte con la dra')));
    
    let finalResponse = aiResult.response;
    
    if (shouldTransfer) {
      console.log('📞 Transferencia a Dra. Daniela solicitada');
      
      // Generar link de WhatsApp con resumen (usar función del sistema médico si está disponible)
      const whatsappLink = typeof generateDoctorWhatsAppLink === 'function' 
        ? generateDoctorWhatsAppLink(updatedHistory)
        : chatbotAI.generateDoctorWhatsAppLink(updatedHistory);
      
      // Reemplazar [TRANSFER_TO_DOCTOR] o agregar al final
      if (finalResponse.includes('[TRANSFER_TO_DOCTOR]')) {
        finalResponse = finalResponse.replace('[TRANSFER_TO_DOCTOR]', 
          `Perfecto. Aquí está el enlace para contactar directamente con la Dra. Daniela:\n\n${whatsappLink}\n\nElla le brindará una atención personalizada 😊`);
      } else {
        finalResponse += `\n\nPerfecto. Aquí está el enlace para contactar directamente con la Dra. Daniela:\n\n${whatsappLink}\n\nElla le brindará una atención personalizada 😊`;
      }
      
      console.log('✅ Link de WhatsApp generado y agregado a la respuesta');
    }
    
    await withFallback(
      () => saveMessage(sessionId, 'assistant', finalResponse, aiResult.tokensUsed),
      () => FallbackStorage.saveMessage(sessionId, 'assistant', finalResponse, aiResult.tokensUsed),
      'Guardar respuesta asistente'
    );
    console.log('✅ Respuesta del asistente guardada');

    // Enviar respuesta a WhatsApp (DEBE ser síncrono para que funcione en Vercel)
    console.log('📤 Paso 7: Enviando respuesta a WhatsApp...');
    try {
      await sendWhatsAppMessage(from, finalResponse);
      console.log('✅ Respuesta enviada a WhatsApp exitosamente');
    } catch (error) {
      console.error('❌ Error enviando a WhatsApp:', error.message);
      console.error('❌ Error type:', error.name);
      // No lanzar el error para que el proceso continúe
    }

    // Limpieza ligera ocasional (10% de probabilidad)
    if (Math.random() < 0.1) {
      console.log('🧹 Ejecutando limpieza ligera...');
      cleanupService.lightCleanup().catch(err => {
        console.log('⚠️ Error en limpieza ligera:', err);
      });
    }

    console.log('✅ Mensaje procesado exitosamente');
  } catch (error) {
    console.error('❌ Error en processWhatsAppMessage:', error);
    console.error('❌ Stack trace completo:', error.stack);
    
    // Intentar enviar mensaje de error al usuario (sin await)
    try {
      sendWhatsAppMessage(from, 'Disculpa, tuvimos un problema procesando tu mensaje. Por favor intenta de nuevo. 🙏').catch(() => {});
    } catch {}
    
    throw error;
  }
}

/**
 * Envía un mensaje a través de WhatsApp Business API
 */
async function sendWhatsAppMessage(to, text) {
  try {
    console.log(`📤 [sendWhatsAppMessage] Intentando enviar mensaje a ${to}`);
    console.log(`📝 [sendWhatsAppMessage] Texto (${text.length} chars): "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    
    const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    console.log(`🔑 [sendWhatsAppMessage] Phone Number ID: ${phoneNumberId ? phoneNumberId.substring(0, 10) + '...' : '❌ MISSING'}`);
    console.log(`🔑 [sendWhatsAppMessage] Access Token: ${accessToken ? '✅ Presente (longitud: ' + accessToken.length + ')' : '❌ MISSING'}`);
    console.log(`🔑 [sendWhatsAppMessage] API URL: ${WHATSAPP_API_URL}`);

    if (!phoneNumberId || !accessToken) {
      console.error('❌ [sendWhatsAppMessage] CRÍTICO: Credenciales de WhatsApp no configuradas');
      console.error('❌ [sendWhatsAppMessage] Verificar variables de entorno en Vercel:');
      console.error('   - WHATSAPP_PHONE_NUMBER_ID');
      console.error('   - WHATSAPP_ACCESS_TOKEN');
      throw new Error('Credenciales de WhatsApp faltantes');
    }

    const url = `${WHATSAPP_API_URL}/${phoneNumberId}/messages`;
    console.log(`🌐 URL de API: ${url}`);

    const payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    };
    console.log('📦 Payload:', JSON.stringify(payload, null, 2));

    console.log('🚀 Enviando request a WhatsApp API...');
    
    // Agregar timeout de 5 segundos al fetch (total función debe ser < 10s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('⏰ [WHATSAPP] Timeout de 5s alcanzado, abortando...');
      controller.abort();
    }, 5000);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    console.log(`📊 Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ Error de WhatsApp API:', JSON.stringify(errorData, null, 2));
      throw new Error(`WhatsApp API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    console.log('✅ Respuesta de WhatsApp API:', JSON.stringify(data, null, 2));
    console.log('✅ Mensaje enviado a WhatsApp con ID:', data.messages?.[0]?.id);
    
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ TIMEOUT enviando a WhatsApp: Request abortado después de 5s');
    } else {
      console.error('❌ Error en sendWhatsAppMessage:', error.message);
      console.error('❌ Stack trace:', error.stack);
    }
    throw error;
  }
}

/**
 * ⚠️ IMPORTANTE: Según documentación oficial, NO se pueden agregar participantes
 * directamente al crear el grupo. El flujo correcto es:
 * 1. Crear grupo (solo subject y description)
 * 2. Recibir webhook con invite_link
 * 3. Enviar invite_link a los usuarios
 * 4. Usuarios hacen clic y se unen
 * 
 * Por simplicidad operativa, usamos fallback a mensajes individuales.
 * @returns {Promise<string|null>} Group ID o null si falla
 */
async function ensureStaffGroupExists() {
  let groupId = process.env.WHATSAPP_STAFF_GROUP_ID;
  
  if (groupId) {
    console.log(`✅ [STAFF GROUP] Group ID configurado: ${groupId}`);
    return groupId;
  }

  console.log('⚠️ [STAFF GROUP] Group ID no configurado');
  console.log('📖 [STAFF GROUP] Para crear grupo, ver: docs/WHATSAPP-GROUP-SETUP-CORRECTED.md');
  console.log('🔄 [STAFF GROUP] Usando fallback a mensajes individuales');
  
  return null;
}

/**
 * Notifica al grupo de staff sobre eventos importantes
 * @param {string} eventType - Tipo de evento: 'appointment', 'referral', 'consultation'
 * @param {Object} data - Datos del evento
 * @param {string} patientPhone - Número de teléfono del paciente
 */
/**
 * Notifica al personal de BIOSKIN sobre eventos importantes
 * Usa el número principal con diferenciación por tema (médico/técnico)
 */
async function notifyStaffGroup(eventType, data, patientPhone) {
  console.log(`📢 [NOTIFICACIÓN BIOSKIN] Evento tipo: ${eventType}`);
  
  // Enviar directamente al número principal de BIOSKIN
  // La función sendToStaffIndividually maneja la diferenciación por tema
  return await sendToStaffIndividually(eventType, data, patientPhone);
}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 

/**
 * Envía notificación al número principal de BIOSKIN
 * Diferencia entre temas médicos (Dra. Daniela) y técnicos (Departamento Técnico)
 */
async function sendToStaffIndividually(eventType, data, patientPhone) {
  const BIOSKIN_NUMBER = '+593969890689'; // Número principal de BIOSKIN

  console.log(`📤 [NOTIFICACIÓN] Enviando al número principal de BIOSKIN`);

  // Determinar destinatario según el tipo de consulta
  let recipient = '';
  let isMedical = true;
  
  // Detectar si es tema técnico o de equipos
  const technicalKeywords = /(equipo|aparato|dispositivo|máquina|laser|hifu|tecnología|compra|precio.*equipo|producto.*estético|aparatología)/i;
  const dataText = JSON.stringify(data).toLowerCase();
  
  if (technicalKeywords.test(dataText) || eventType === 'technical_inquiry') {
    recipient = 'Departamento Técnico (Ing. Rafael Larrea)';
    isMedical = false;
  } else {
    recipient = 'Dra. Daniela Creamer';
    isMedical = true;
  }

  // Construir mensaje
  const patientChatLink = `https://wa.me/${patientPhone.replace(/\D/g, '')}`;
  let message = '';
  
  switch (eventType) {
    case 'appointment':
      const dateObj = new Date(data.date + 'T00:00:00-05:00');
      const dateFormatted = dateObj.toLocaleDateString('es-ES', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        weekday: 'long',
        timeZone: 'America/Guayaquil'
      });
      
      message = `🗓️ *NUEVA CITA AGENDADA*\n` +
        `📋 *Para:* ${recipient}\n\n` +
        `👤 *Paciente:* ${data.name}\n` +
        `📱 *Teléfono:* ${patientPhone}\n` +
        `💆 *Tratamiento:* ${data.service}\n` +
        `📅 *Fecha:* ${dateFormatted}\n` +
        `⏰ *Hora:* ${data.hour}\n\n` +
        `💬 *Chat directo:* ${patientChatLink}`;
      break;
      
    case 'referral':
      message = `👨‍⚕️ *DERIVACIÓN*\n` +
        `📋 *Para:* ${recipient}\n\n` +
        `👤 *Paciente:* ${data.name || 'No proporcionado'}\n` +
        `📱 *Teléfono:* ${patientPhone}\n` +
        `🔍 *Motivo:* ${data.reason}\n` +
        `📝 *Resumen:*\n${data.summary}\n\n` +
        `💬 *Chat directo:* ${patientChatLink}`;
      break;
      
    case 'technical_inquiry':
      message = `🔧 *CONSULTA TÉCNICA*\n` +
        `📋 *Para:* ${recipient}\n\n` +
        `👤 *Cliente:* ${data.name || 'Solicitó contacto'}\n` +
        `📱 *Teléfono:* ${patientPhone}\n` +
        `🔍 *Motivo:* ${data.reason || 'Consulta técnica sobre equipos'}\n` +
        `📝 *Resumen:*\n${data.summary || data.query}\n\n` +
        `💬 *Chat directo:* ${patientChatLink}`;
      break;
      
    case 'consultation':
      message = `❓ *CONSULTA IMPORTANTE*\n` +
        `📋 *Para:* ${recipient}\n\n` +
        `👤 *Paciente:* ${data.name || 'No identificado'}\n` +
        `📱 *Teléfono:* ${patientPhone}\n` +
        `💬 *Consulta:* ${data.query}\n` +
        `🤖 *Respuesta bot:* ${data.botResponse || 'Pendiente'}\n\n` +
        `💬 *Chat directo:* ${patientChatLink}`;
      break;
      
    default:
      message = `📢 *NOTIFICACIÓN DEL CHATBOT*\n` +
        `📋 *Para:* ${recipient}\n\n` +
        `👤 *Cliente:* ${data.name || 'Sin identificar'}\n` +
        `📱 *Teléfono:* ${patientPhone}\n` +
        `📝 *Tipo:* ${eventType}\n` +
        `📄 *Datos:* ${JSON.stringify(data, null, 2).substring(0, 200)}\n\n` +
        `💬 *Chat directo:* ${patientChatLink}`;
      break;
  }

  try {
    console.log(`📤 Enviando notificación a BIOSKIN (${recipient})...`);
    console.log(`📤 Mensaje a enviar: ${message.substring(0, 100)}...`);
    
    // ✅ VALIDACIÓN: Verificar que el mensaje no esté vacío
    if (!message || message.trim().length === 0) {
      console.error('❌ [CRÍTICO] Mensaje vacío detectado. EventType:', eventType);
      console.error('❌ [CRÍTICO] Data recibida:', JSON.stringify(data, null, 2));
      throw new Error(`No se generó mensaje para eventType: ${eventType}`);
    }
    
    await sendWhatsAppMessage(BIOSKIN_NUMBER, message);
    
    console.log(`✅ Notificación enviada exitosamente al número ${BIOSKIN_NUMBER}`);
    console.log(`✅ Destinatario: ${recipient}`);
    
    return {
      success: true,
      target: 'bioskin_main',
      recipient: recipient,
      number: BIOSKIN_NUMBER
    };
  } catch (error) {
    console.error(`❌ Error enviando notificación a BIOSKIN:`, error.message);
    console.error(`❌ Stack trace completo:`, error.stack);
    console.error(`❌ Número destino:`, BIOSKIN_NUMBER);
    console.error(`❌ Tipo de error:`, error.name);
    
    // Intentar fallback a email de emergencia
    try {
      console.log('🔄 Intentando fallback a notificación por email...');
      const emailPayload = {
        to: 'bioskin@example.com', // Configurar email real en producción
        subject: `⚠️ Notificación WhatsApp fallida - ${eventType}`,
        body: `No se pudo enviar notificación WhatsApp al staff.\n\nMensaje original:\n${message}\n\nError: ${error.message}`
      };
      console.log('📧 Email de emergencia preparado (implementar envío real)');
    } catch (emailError) {
      console.error('❌ También falló el fallback a email:', emailError.message);
    }
    
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

/**
 * DEPRECATED: Usar notifyStaffGroup() en su lugar
 * Notifica al staff cuando se crea una nueva cita
 * @param {Object} appointmentData - Datos de la cita creada
 * @param {string} patientPhone - Número de teléfono del paciente
 */
async function notifyStaffNewAppointment(appointmentData, patientPhone) {
  return notifyStaffGroup('appointment', appointmentData, patientPhone);
}
