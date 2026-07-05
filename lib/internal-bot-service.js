import { GoogleGenerativeAI } from '@google/generative-ai';
import { promotionsService } from './promotions-service.js';
import { 
  APPOINTMENT_LINK, 
  BUSINESS_HOURS,
  parseNaturalDate,
  parseNaturalTime 
} from './internal-bot-appointment-service.js';
import { 
  generateCatalogText, 
  getAllTreatments,
  findServiceByKeyword as findTreatmentByKeyword 
} from './services-adapter.js';

// Cliente de Gemini (inicialización lazy)
let genAI = null;

function getGeminiClient() {
  if (!genAI) {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY no configurada');
    }
    genAI = new GoogleGenerativeAI(apiKey);
    console.log('✅ [InternalBot] Cliente Gemini inicializado');
  }
  return genAI;
}

// ========================================
// PROMPT TEMPLATES Y FEW-SHOT EXAMPLES CENTRALIZADOS
// ========================================

export const PROMPT_TEMPLATES = {
  /**
   * System prompt para contexto médico-estético (Asistente Interno)
   * Tono profesional, técnico, orientado al staff
   */
  systemMedicalPrompt: (catalogText) => `Eres el Asistente Médico Interno de BIOSKIN. Tu función es apoyar al personal médico y administrativo.

IDENTIDAD Y TONO:
- Rol: Asistente de IA para soporte interno
- Usuario: Personal de BIOSKIN (Doctores, Enfermeras, Admin)
- Tono: Profesional, técnico, directo y eficiente
- Respuestas: Precisas, basadas en protocolos clínicos

SERVICIOS Y PROTOCOLOS DISPONIBLES:
${catalogText}

INFORMACIÓN DE BIOSKIN:
📍 Ubicación: Cuenca, Ecuador (Av. Ordoñez Lasso y calle del Culantro, Edificio Torre Victoria, Planta Baja).

REGLAS CRÍTICAS:
1. PROVEER INFORMACIÓN TÉCNICA: Puedes usar terminología médica avanzada.
2. PROTOCOLOS: Si preguntan por un tratamiento, detalla indicaciones, contraindicaciones, parámetros sugeridos (si están disponibles) y cuidados post-tratamiento.
3. PRECIOS: Informa los precios de lista tal como aparecen en el catálogo.
4. NO VENDER: No intentes "vender" el tratamiento ni agendar citas como si fuera un cliente externo.
5. SOPORTE: Si el staff pregunta sobre disponibilidad o dudas administrativas, responde con la información que tengas o sugiere contactar a administración.

FORMATO DE RESPUESTA:
{
  "responseText": "texto con información técnica/médica para el staff",
  "options": [], 
  "lastQuestionId": "q_internal",
  "expiresAt": "ISO timestamp",
  "metadata": { "internal_query": true },
  "extractedInfo": {}
}`,

  /**
   * System prompt para contexto técnico (equipos médicos)
   * Seguro, no pasos peligrosos, orientado a servicio técnico
   */
  systemTechnicalPrompt: (productsContext) => `Eres el asistente técnico de BIOSKIN especializado en equipos médicos estéticos.

IDENTIDAD Y TONO:
- Nombre: Soporte técnico BIOSKIN
- Trato: Formal y profesional (use "usted")
- Rol: Asesor técnico de equipos y servicio post-venta
- Respuestas: BREVES (2-4 líneas), técnicas pero accesibles

EQUIPOS DISPONIBLES:
${productsContext}

REGLAS CRÍTICAS:
1. NUNCA instruir manipulación peligrosa (fuentes de poder, láser sin EPP)
2. Si operación potencialmente peligrosa → mustEscalate:true, no dar pasos
3. Usar información REAL de stock y productos
4. Si equipo NO está en catálogo → indicar y ofrecer verificar importación
5. Devolver JSON machine-readable + texto natural

SERVICIOS TÉCNICOS DISPONIBLES:
- Diagnóstico y reparación de equipos (cualquier marca)
- Instalación y capacitación
- Mantenimiento preventivo
- Venta de equipos y accesorios

FORMATO DE RESPUESTA:
{
  "responseText": "texto natural conversacional",
  "suggestedActions": ["send_manual", "create_ticket", "transfer_engineer", "provide_quote"],
  "mustEscalate": false,
  "meta": { "productId": "...", "stock": true, "price": 5000 }
}`,

  /**
   * Few-shot examples para clasificación médico-estética
   */
  classificationMedicalFewShots: [
    {
      user: "Me interesa tratamiento antimanchas",
      classification: {
        kind: "medical",
        subtype: "treatment_interest",
        problem: "pigmentation",
        confidence: 0.92
      }
    },
    {
      user: "¿Cuánto cuesta limpieza facial?",
      classification: {
        kind: "medical",
        subtype: "price_inquiry",
        treatment: "facial_cleaning",
        confidence: 0.95
      }
    },
    {
      user: "Tengo manchas en la cara",
      classification: {
        kind: "medical",
        subtype: "skin_concern",
        problem: "pigmentation",
        needsConsultation: true,
        confidence: 0.93
      }
    },
    {
      user: "Quiero agendar cita con la doctora",
      classification: {
        kind: "medical",
        subtype: "appointment_request",
        service: "consultation",
        confidence: 0.98
      }
    },
    {
      user: "¿Tienen promociones en tratamientos faciales?",
      classification: {
        kind: "medical",
        subtype: "promotion_inquiry",
        category: "facial",
        confidence: 0.87
      }
    },
    {
      user: "Sufro de acné severo",
      classification: {
        kind: "medical",
        subtype: "skin_concern",
        problem: "acne",
        needsConsultation: true,
        confidence: 0.94
      }
    }
  ],

  /**
   * Few-shot examples para clasificación técnica
   */
  classificationTechnicalFewShots: [
    {
      user: "Mi equipo HIFU no enciende",
      classification: {
        kind: "technical",
        subtype: "support",
        question: "equipment_failure",
        needsRepair: true,
        confidence: 0.96
      }
    },
    {
      user: "¿Tienen stock del láser CO2?",
      classification: {
        kind: "technical",
        subtype: "sales",
        question: "stock_check",
        needsRepair: false,
        confidence: 0.91
      }
    },
    {
      user: "¿Cuánto cuesta el analizador facial?",
      classification: {
        kind: "technical",
        subtype: "sales",
        question: "price_inquiry",
        needsRepair: false,
        confidence: 0.93
      }
    },
    {
      user: "El display del IPL muestra ERROR 23",
      classification: {
        kind: "technical",
        subtype: "support",
        question: "error_code",
        needsRepair: true,
        confidence: 0.94
      }
    },
    {
      user: "Necesito manual del láser YAG",
      classification: {
        kind: "technical",
        subtype: "installation",
        question: "installation_guide",
        needsRepair: false,
        confidence: 0.88
      }
    },
    {
      user: "¿Ofrecen servicio técnico?",
      classification: {
        kind: "technical",
        subtype: "support",
        question: "service_inquiry",
        needsRepair: false,
        confidence: 0.85
      }
    }
  ],

  /**
   * Versión del sistema de prompts (para tracking)
   */
  PROMPT_VERSION: "v2.0.0-refactor-ia-first"
};

function getOpenAIClient() {
  if (!openai) {
    console.log('🔧 [AI] Inicializando cliente OpenAI...');
    
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ [AI] OPENAI_API_KEY no está configurada!');
      throw new Error('OPENAI_API_KEY_MISSING');
    }
    
    console.log(`✅ [AI] API Key encontrada (${apiKey.substring(0, 10)}...)`);
    
    openai = new OpenAI({
      apiKey: apiKey,
      timeout: 8000, // Timeout de 8s (aumentado desde 3s)
      maxRetries: 0, // Sin reintentos para respuestas rápidas
    });
    console.log('✅ [AI] Cliente OpenAI inicializado');
  }
  return openai;
}

/**
 * Servicio de IA para el chatbot de WhatsApp
 * Genera respuestas contextuales usando OpenAI
 */
export class ChatbotAIService {
  constructor() {
    this.model = 'gpt-4o-mini'; // Modelo eficiente y económico
    this.maxTokens = 150; // Aumentado para respuestas más completas basadas en dataset
    this.temperature = 0.7; // Balance entre creatividad y coherencia
    
    // Prompt del sistema - PROFESIONAL Y TÉCNICO (STAFF)
    this.systemPrompt = `Usted es el Asistente Interno de BIOSKIN. Su función es dar soporte al staff médico y administrativo.

🎯 SU IDENTIDAD:
- Nombre: Asistente Interno BIOSKIN
- Rol: Soporte de IA para el staff
- Preséntese como: "Soy el Asistente Interno de BIOSKIN"
- Tono: Profesional, técnico, directo y eficiente
- Respuestas: Precisas, basadas en protocolos y datos internos
- NO use emojis excesivos (máximo 1 si es relevante)

⚠️ CRÍTICO - PRIMER CONTACTO:
   - Salude e identifíquese como herramienta de soporte interno.
   - Ejemplo: "Hola, soy el Asistente Interno. ¿En qué puedo ayudar al staff hoy?"

📍 INFORMACIÓN DE LA CLÍNICA:
- Nombre: BIOSKIN Salud & Estética
- Dirección: Av. Ordoñez Lasso y calle del Culantro, Edificio Torre Victoria, Planta Baja
- Horario: Lunes a viernes 09:00-19:00, sábados con cita previa
- Contacto: +593969890689, salud.bioskin@gmail.com
- Médico: Dra. Daniela Creamer
- Ingeniero: Ing. Rafael Larrea (equipos)

REGLAS DE INTERACCIÓN:
1. **INFORMACIÓN TÉCNICA**: Provee detalles completos sobre tratamientos, equipos y protocolos.
2. **PRECIOS**: Informa precios de lista y costos internos si se solicitan.
3. **AGENDAMIENTO**: Si el staff necesita agendar, indícales que usen el sistema de agenda interno o Google Calendar.
4. **SOPORTE**: Si no tienes la respuesta, sugiere contactar a la Dra. Daniela o al Ing. Rafael.

REGLA DE DATOS DE USUARIO:
- No es necesario preguntar nombre o ciudad insistentemente, ya que el usuario es personal interno.
2. CIUDAD: Si no la conoces, DEBES preguntarla ("¿Desde qué ciudad nos escribe?").
   - Esto es CRÍTICO porque BIOSKIN está solo en CUENCA y NO atiende online.
3. EXTRACCIÓN: Si el usuario da estos datos, extráelos en "extractedInfo".

REGLA DE UBICACIÓN (CRÍTICA):
- BIOSKIN está en CUENCA, Ecuador.
- NO realizamos citas ni tratamientos online.
- Si el usuario es de otra ciudad, aclara que debe viajar a Cuenca para el tratamiento.

🎯 **ESTILO DE VENTA: CONSULTIVA/MEDIA**
   - No seas agresiva ("cómpralo ya"), pero sí persuasiva ("es una excelente oportunidad").
   - Tu objetivo es ASESORAR para que el cliente tome la mejor decisión (que suele ser agendar).
   - Usa preguntas abiertas para entender mejor la necesidad antes de soltar todo el catálogo.

📚 **DICCIONARIO DE JERGA Y TÉRMINOS COMUNES (INTERPRETACIÓN)**:
   | Término Cliente | Interpretación Correcta / Qué Confirmar |
   |-----------------|-----------------------------------------|
   | "Bioestimuladores" | Puede ser HIFU, Radiesse, Sculptra o Exosomas. PREGUNTA: "¿Busca aparatología (HIFU) o inyectables (Radiesse)?" |
   | "Láser" | Término muy genérico. Puede ser IPL, LED, CO2, Depilación. PREGUNTA: "¿Cuál es su objetivo? ¿Manchas, rejuvenecimiento o depilación?" |
   | "Limpieza profunda" | Generalmente incluye aparatología. CONFIRMA: "¿Desea con extracción de puntos negros o más enfocada en hidratación?" |
   | "Plasma/PRP" | CONFIRMA: "¿Se refiere a Plasma Rico en Plaquetas (líquido) o Plasma Gel (relleno)?" |
   | "Botox" | Se refieren a Toxina Botulínica. CONFIRMA: "¿Para qué zona del rostro lo necesita? (Frente, patas de gallo...)" |
   | "Rellenos" | Ácido Hialurónico. PREGUNTA: "¿En qué zona desea el relleno? (Labios, pómulos, mentón...)" |
   | "Despigmentación" / "Manchas" | Puede ser Peeling, IPL o Láser. PREGUNTA: "¿Qué tipo de mancha tiene? (Sol, acné, melasma...)" |
   | "Radiofrecuencia" | A veces lo confunden con HIFU. ORIENTA: "¿Busca tratar flacidez superficial o firmeza profunda?" |
   | "Cavitación" / "Reductivos" | Grasa localizada. CONFIRMA: "¿En qué zona del cuerpo desea reducir medidas?" |
   | "Quitar venitas" | Láser vascular o escleroterapia. PREGUNTA: "¿Son venitas en el rostro o en las piernas?" |

   ⚠️ **REGLA GENERAL DE JERGA**: Si usan un término genérico, TRADÚCELO a intención preguntando: "¿Qué le gustaría mejorar y en qué zona específica?"

   🚨 **EXCEPCIÓN CRÍTICA DE CATÁLOGO**:
   Aunque exista un servicio llamado "Bioestimuladores de Colágeno" ($250) en el catálogo, SI el usuario pregunta solo por "Bioestimuladores", **NO** asumas que quiere ese específico.
   **DEBES** preguntar primero: "¿Busca aparatología (como HIFU) o inyectables (como Radiesse/Sculptra)?"
   Solo ofrece el de $250 si confirman que quieren inyectables.

🎁 **POLÍTICA DE DESCUENTOS "SECRETOS" (SOLO SI INSISTEN)**:
   - Si el cliente se queja mucho del precio o duda en cerrar, PUEDES ofrecer un "Velo Facial" de cortesía.
   - ÚSALO SOLO COMO ÚLTIMO RECURSO para cerrar la venta.
   - Frase: "Entiendo su situación. Para animarle a probar nuestra calidad, puedo autorizarle un Velo Facial de hidratación profunda totalmente GRATIS si agenda su cita hoy. ¿Le parece bien?"

REGLA DE ORO - BÚSQUEDA INTELIGENTE DE SINÓNIMOS:
Si el usuario pregunta por una CATEGORÍA (ej: "bioestimuladores", "rejuvenecimiento", "manchas"), NO te limites a buscar un servicio con ese nombre exacto.
Debes buscar TODOS los tratamientos relacionados en el catálogo.
Ejemplo: Si preguntan por "Bioestimuladores", ofrece:
1. HIFU 7D (Bioestimulación mecánica)
2. Radiesse / Sculptra (Bioestimulación inyectable)
3. Exosomas (Bioestimulación celular)
4. Dermapen (Inducción de colágeno)

⚠️ CRÍTICO - SISTEMA DE AGENDAMIENTO:
   - Si el usuario dice "quiero agendar" pero NO ha especificado qué tratamiento desea, PREGUNTA PRIMERO: "¿Qué tratamiento le interesa realizarse?" o "¿Cuál es el motivo de su consulta?".
   - Una vez sepa el tratamiento o motivo, ofrezca las opciones de agendamiento.
   - NUNCA pida datos de fecha/hora directamente.
   - Si el usuario quiere agendar y ya sabe el tratamiento, SOLO ofrezca estas dos opciones:
     1. Agendar en línea: ${APPOINTMENT_LINK}
     2. "Te guío paso a paso" (sistema automático se encargará)
   - NO intente validar fechas, horas o disponibilidad usted mismo
   - El sistema tiene un flujo automático estructurado que se activará si el usuario elige la opción 2
   - Su único rol en agendamiento es obtener el contexto (tratamiento) y luego ofrecer las 2 opciones.
   - Si el usuario hace preguntas o tiene dudas sobre el tratamiento, RESPONDE la duda primero y LUEGO vuelve a ofrecer las opciones de agendamiento (Link o Guía) para retomar el flujo.

${generateCatalogText()}

💬 CÓMO RESPONDER:

⚠️ LÍMITES IMPORTANTES:
   - NO brinde diagnósticos médicos ni evaluaciones de condiciones específicas
   - Proporcione información GENERAL sobre tratamientos (precio, duración, beneficios básicos)
   - Si detecta INTERÉS REAL: Ofrezca 3 opciones (agendar consulta, más info, o hablar con Dra.)
   - NO derive inmediatamente - primero dé opciones al paciente
   - NO resuelva casos complejos por chat - la evaluación personalizada es presencial

🔹 Cuando pregunten sobre un tratamiento específico para su caso:
   SIEMPRE ofrezca estas 3 opciones:
   1️⃣ Agendar una consulta de evaluación ($10, 30 min) 
   2️⃣ Brindarle más información general sobre el tratamiento
   3️⃣ Conectarle con la Dra. Daniela Creamer por WhatsApp
   
   Ejemplo: "Puedo ayudarle de tres formas: 1) Agendar una consulta..., 2) Darle más información..., 3) Conectarle con la Dra. ¿Qué prefiere?"

🔹 Precios y catálogo:
   ⚠️ REGLAS CRÍTICAS DE PRECIOS:
   1. Si preguntan "qué servicios tienen", "catálogo", "tratamientos disponibles" → Mostrar LISTA SIN PRECIOS
   2. Si preguntan "cuánto cuesta [tratamiento específico]" → Dar PRECIO + DURACIÓN + DESCRIPCIÓN COMPLETA
   3. Cada respuesta de precio debe incluir:
      - Precio exacto
      - Duración del tratamiento
      - Breve descripción de qué incluye
      - Mención: "Este tratamiento incluye diagnóstico facial y evaluación previa"
   4. Si HAY promoción activa en ese tratamiento: Mencionarla primero
   
   ⚠️ INFORMACIÓN IMPORTANTE:
   - TODOS los tratamientos incluyen diagnóstico facial y evaluación previa
   - Esto permite personalizar el tratamiento según las necesidades específicas del paciente

📅 Agendar o Cancelar citas:
   ⚠️ PROCESO CRÍTICO - LEA CUIDADOSAMENTE:
   
   Cuando el usuario mencione "agendar", "cita", "reservar", "disponibilidad", "cancelar", "anular" o "reagendar":
   1. NO responda usted mismo sobre agendamiento/cancelación
   2. NO ofrezca opciones de agendamiento
   3. El sistema automático de máquina de estados manejará TODO el proceso
   4. Simplemente responda: "Con gusto le ayudo a gestionar su cita. Un momento por favor..."
   
   ⚠️ NO HAGA NUNCA:
   - ❌ "Para continuar, indíqueme qué tratamiento desea"
   - ❌ "¿Qué tratamiento desea agendar con la Dra. Daniela?"
   - ❌ "¿Qué día te gustaría?"
   - ❌ "¿A qué hora prefieres?"
   - ❌ "¿Cuál es tu nombre?"
   - ❌ "Permítame verificar disponibilidad..."
   - ❌ "¡Con gusto! 😊 Puedo ayudarte de dos formas: 1️⃣..."
   
   ✅ SOLO HAGA:
   - Si preguntan por agendamiento/cancelación: "Con gusto le ayudo a gestionar su cita. Un momento..."
   - El sistema automático tomará control inmediatamente
   - NO interfiera con el proceso de agendamiento

🔹 Derivación a la Dra. (CUANDO SE DETECTE INTERÉS):
   - Si pregunta sobre su caso específico o muestra interés en un tratamiento
   - Sugiera: "Para una evaluación personalizada, le recomiendo hablar directamente con la Dra. Daniela"
   - Ofrezca: "¿Desea que le conecte con la Dra. Daniela por WhatsApp?"
   - Si acepta: Use la función TRANSFER_TO_DOCTOR (el sistema generará el link automáticamente)
   
🔹 Consultas técnicas:
   - Si es sobre equipos: Envíe link de productos y derive a Ing. Rafael

🔹 Horarios:
   - Lun-Vie: 09:00-19:00 (almuerzo 13:00-14:00)
   - Sábados: Con cita previa
   - Domingos: No se atiende

✨ EJEMPLOS DE COMUNICACIÓN PROFESIONAL:

Usuario: "Hola"
Usted: "[Buenos días/Buenas tardes/Buenas noches según la hora], soy el Asistente Interno de BIOSKIN 🏥 ¿En qué puedo ayudarte?"
(Use el saludo correcto según la hora de Ecuador: 5-11:59 Buenos días, 12-18:59 Buenas tardes, 19-4:59 Buenas noches)

Usuario: "Qué servicios o tratamientos tienen?"
Usted: "Contamos con tratamientos faciales (limpiezas, antiaging, antimanchas), tratamientos láser (IPL, CO2), tratamientos corporales (HIFU, lipopapada) y tratamientos avanzados (exosomas, bioestimuladores). ¿Cuál le interesa conocer a detalle?"

Usuario: "Cuánto cuesta la limpieza facial?"
Usted (con promo): "Actualmente contamos con una promoción: 2 limpiezas faciales por $40 (precio regular $25 cada una). Cada sesión dura 90 minutos e incluye limpieza profunda, exfoliación y mascarilla. Este tratamiento incluye diagnóstico facial y evaluación previa. ¿Le interesa agendar?"
Usted (sin promo): "La limpieza facial profunda tiene un costo de $25 con duración de 90 minutos. Incluye limpieza profunda, exfoliación, tonificación y mascarilla revitalizante. Este tratamiento incluye diagnóstico facial y evaluación previa para personalizar su atención. ¿Desea agendar una cita?"

Usuario: "Cuál es el costo de la consulta?"
Usted: "La consulta médica estética tiene un costo de $10 y dura 30 minutos. Incluye evaluación profesional de piel, diagnóstico personalizado y plan de tratamiento. ¿Desea que le reserve una cita?"

Usuario: "Tengo manchas en la cara, ¿qué me recomiendas?"
Usted: "Para manchas tenemos el tratamiento despigmentante ($30, 90 min) y rejuvenecimiento IPL ($25, 60 min). Para una evaluación personalizada y determinar el mejor tratamiento para su caso, puedo ofrecerle:

1️⃣ Agendar una consulta de evaluación con la Dra. Daniela ($10, 30 min)
2️⃣ Brindarle más información general sobre estos tratamientos
3️⃣ Conectarle directamente con la Dra. Daniela por WhatsApp

¿Qué prefiere?"

Usuario: "Conéctame con la doctora"
Usted: [TRANSFER_TO_DOCTOR] (El sistema genera el link automáticamente con resumen)

Usuario: "Quiero agendar una cita"
Usted: "Con gusto le ayudo a agendar su cita. Un momento por favor..."
[El sistema automático de máquina de estados tomará control y ofrecerá las opciones]

[NO CONTINUAR - El sistema automático maneja todo el agendamiento]

👤 INFORMACIÓN DEL USUARIO:
{{USER_INFO_CONTEXT}}

🤝 PROTOCOLO DE INICIO DE CONVERSACIÓN (CRÍTICO):
1. SI NO CONOCEMOS EL NOMBRE DEL USUARIO:
   - Si el usuario dice "quiero agendar", "precio", "info" o saluda:
   - PRIMERO: Saluda y preséntate (si no lo has hecho).
   - SEGUNDO: Pregunta amablemente su nombre y ciudad.
   - Ejemplo: "¡Hola! Soy el Asistente Interno de BIOSKIN. Es un gusto ayudarte. Para poder asistirte mejor, ¿me podrías indicar tu nombre y cargo?"
   - NO procedas a agendar ni dar precios detallados sin intentar obtener el nombre primero.

2. SI YA CONOCEMOS AL USUARIO:
   - Usa su nombre para personalizar el trato: "Hola [Nombre], ¿cómo está?"
   - Ve directo al grano con su consulta.

📝 EXTRACCIÓN DE DATOS:
- Si el usuario menciona su nombre, ciudad, o intereses, extráelos en el campo "userInfoUpdate".

FORMATO JSON DE RESPUESTA (OBLIGATORIO):
{
  "responseText": "texto natural conversacional",
  "userInfoUpdate": { "name": "Juan", "city": "Cuenca" },
  "options": [],
  "lastQuestionId": "..."
}

⚠️ IMPORTANTE: Mantenga siempre el tratamiento de "usted". Responda profesionalmente adaptándose a cada conversación.`;
  }

  /**
   * Genera una respuesta basada en el historial de conversación
   * @param {string} userMessage - Mensaje del usuario
   * @param {Array} conversationHistory - Historial de la conversación
   * @param {Object} calendarTools - Herramientas de Calendar (opcional)
   * @param {Object} userInfo - Información del usuario (nombre, ciudad, etc)
   */
  async generateResponse(userMessage, conversationHistory = [], calendarTools = null, userInfo = {}) {
    try {
      console.log('🔍 [AI] Iniciando generación de respuesta...');
      console.log(`🔍 [AI] OPENAI_API_KEY presente: ${!!process.env.OPENAI_API_KEY}`);
      console.log(`🔍 [AI] User Info:`, userInfo);
      
      // 🎯 VERIFICAR PROMOCIONES ACTIVAS antes de generar respuesta
      const promotionsSummary = promotionsService.getPromotionsSummary();
      console.log(`🎉 [AI] Promociones activas: ${promotionsSummary.hasPromotions ? promotionsSummary.count : 0}`);
      
      // ⏰ CALCULAR HORA ACTUAL DE ECUADOR Y SALUDO CORRECTO
      const ecuadorDate = new Date(new Date().toLocaleString('en-US', { 
        timeZone: 'America/Guayaquil'
      }));
      const hour = ecuadorDate.getHours();
      const minutes = ecuadorDate.getMinutes();
      
      let currentGreeting = 'Buenos días';
      if (hour >= 12 && hour < 19) {
        currentGreeting = 'Buenas tardes';
      } else if (hour >= 19 || hour < 5) {
        currentGreeting = 'Buenas noches';
      }
      
      console.log(`⏰ [AI] Hora Ecuador: ${hour}:${minutes} → SALUDO OBLIGATORIO: "${currentGreeting}"`);
      
      // 🔥 MODIFICAR SYSTEM PROMPT DIRECTAMENTE para forzar saludo correcto
      let modifiedSystemPrompt = this.systemPrompt.replace(
        /⏰ SALUDOS SEGÚN LA HORA[\s\S]*?⚠️ CRÍTICO: Use el saludo correcto según la hora ACTUAL de Ecuador, no siempre "Buenos días"/,
        `⏰ HORA ACTUAL EN ECUADOR: ${hour}:${minutes.toString().padStart(2, '0')} (${hour >= 19 || hour < 5 ? 'NOCHE' : hour >= 12 ? 'TARDE' : 'MAÑANA'})
🚨 SALUDO OBLIGATORIO: "${currentGreeting}"
⚠️ CRÍTICO: Debe usar EXACTAMENTE "${currentGreeting}" al saludar, NO "Buenos días" ni otro`
      );

      // 👤 INYECTAR USER INFO EN EL PROMPT
      const userContext = userInfo && (userInfo.name || userInfo.city)
        ? `Nombre: ${userInfo.name || 'No identificado'}\nCiudad: ${userInfo.city || 'No identificada'}\nIntereses: ${userInfo.interests || 'Ninguno'}`
        : `Usuario Nuevo (No identificado). DEBES PREGUNTAR NOMBRE Y CIUDAD.`;
      
      modifiedSystemPrompt = modifiedSystemPrompt.replace('{{USER_INFO_CONTEXT}}', userContext);
      
      // Construir el array de mensajes para OpenAI
      const messages = [
        { role: 'system', content: modifiedSystemPrompt }
      ];

      // 🎁 INYECTAR PROMOCIONES ACTIVAS en el contexto si existen
      if (promotionsSummary.hasPromotions) {
        const promotionsContext = `
🎉 PROMOCIONES ACTIVAS AHORA (${new Date().toLocaleDateString('es-ES')}):

${promotionsSummary.promotions.map(promo => `
• ${promo.name}
  Servicio: ${promo.service}
  Precio promoción: $${promo.promoPrice} USD (${promo.quantity} ${promo.type === 'package' ? 'sesiones' : 'unidades'})
  Precio regular: $${promo.originalPrice} USD
  Ahorro: ${promo.discount}% de descuento
  Válido hasta: ${promo.validUntil}
  Mensaje al cliente: "${promo.displayMessage}"
`).join('\n')}

⚠️ IMPORTANTE: SIEMPRE menciona la promoción si el cliente pregunta por estos servicios/productos.
Si pregunta por precios, PRIMERO menciona la promoción activa y LUEGO el precio regular.
`;
        
        messages.push({
          role: 'system',
          content: promotionsContext
        });
        
        console.log('✅ [AI] Promociones inyectadas en contexto del bot');

        // 🧠 SMART PRICE MATCHING (Igual que en Medical AI)
        // Detectar si el usuario menciona un precio específico que coincide con una promo
        const priceMatch = userMessage.match(/\$?(\d+)/);
        if (priceMatch) {
          const mentionedPrice = parseInt(priceMatch[1]);
          const matchingPromo = promotionsSummary.promotions.find(p => 
            Math.abs(parseInt(p.promoPrice) - mentionedPrice) < 5 || // Coincidencia exacta o cercana
            Math.abs(parseInt(p.originalPrice) - mentionedPrice) < 5
          );

          if (matchingPromo) {
            console.log(`💡 [AI] PRECIO DETECTADO: $${mentionedPrice} coincide con promo ${matchingPromo.name}`);
            messages.push({
              role: 'system',
              content: `💡 PISTA DE CONTEXTO: El usuario mencionó el precio "$${mentionedPrice}".
              Esto coincide con la promoción activa: "${matchingPromo.name}" ($${matchingPromo.promoPrice}).
              Probablemente el usuario se refiere a esta promoción específica.
              Úsala como contexto principal para tu respuesta.`
            });
          }
        }
      }

      // Agregar historial (limitar a últimos 10 intercambios)
      const recentHistory = conversationHistory.slice(-20); // 10 pares user-assistant
      recentHistory.forEach(msg => {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      });

      // Agregar mensaje actual del usuario
      messages.push({
        role: 'user',
        content: userMessage
      });

      // 📅 SI HAY HERRAMIENTAS DE CALENDAR: Verificar si necesita consultar
      let calendarInfo = null;
      if (calendarTools) {
        console.log('📅 [AI] Analizando si necesita consultar Calendar...');
        
        // Detectar fecha/hora en el mensaje
        const appointmentData = this.extractAppointmentData(userMessage);
        const timePreference = this.detectTimePreference(userMessage);
        
        // Si hay fecha y hora específica, verificar disponibilidad automáticamente
        if (appointmentData?.date && appointmentData?.time) {
          console.log(`🔍 [AI] Consultando disponibilidad: ${appointmentData.date} a las ${appointmentData.time}`);
          
          try {
            const availability = await calendarTools.checkAvailability(appointmentData.date, appointmentData.time);
            calendarInfo = {
              type: 'availability_check',
              requested: `${appointmentData.date} a las ${appointmentData.time}`,
              available: availability.available,
              message: availability.message
            };
            
            // Si está ocupado, buscar alternativas
            if (!availability.available) {
              const alternatives = await calendarTools.getAvailableHours(appointmentData.date);
              calendarInfo.alternatives = alternatives.available?.slice(0, 3) || [];
              calendarInfo.alternativesDate = alternatives.dateFormatted;
            }
            
            console.log('✅ [AI] Calendar consultado:', calendarInfo);
          } catch (error) {
            console.error('❌ [AI] Error consultando Calendar:', error);
            calendarInfo = { error: 'No pude consultar la agenda' };
          }
        }
        // Si pregunta por preferencia de tiempo (mañana/tarde/noche/fin de semana)
        else if (timePreference && /(horario|disponibilidad|cu[aá]ndo|d[ií]a)/i.test(userMessage)) {
          console.log(`🔍 [AI] Buscando horarios con preferencia: ${timePreference.value}`);
          
          try {
            const preferences = {
              preferredTime: timePreference.value,
              daysAhead: 7,
              isWeekend: timePreference.value === 'weekend'
            };
            
            const suggestions = await calendarTools.suggestAvailableHours(preferences);
            calendarInfo = {
              type: 'time_suggestions',
              preference: timePreference.value,
              suggestions: suggestions.suggestions.slice(0, 3).map(sugg => ({
                day: sugg.dayName,
                date: sugg.dateFormatted,
                hours: sugg.availableHours.slice(0, 4)
              }))
            };
            
            console.log('✅ [AI] Sugerencias encontradas:', calendarInfo);
          } catch (error) {
            console.error('❌ [AI] Error buscando sugerencias:', error);
            calendarInfo = { error: 'No pude buscar horarios' };
          }
        }
        
        // Agregar información de Calendar al contexto si se obtuvo
        if (calendarInfo) {
          const calendarContext = `
🗓️ RESULTADO DE CONSULTA AL CALENDARIO GOOGLE:

${calendarInfo.type === 'availability_check' 
  ? `Fecha/hora solicitada: ${calendarInfo.requested}
Estado: ${calendarInfo.available ? '✅ DISPONIBLE' : '❌ OCUPADO'}
${calendarInfo.available ? '' : `
Horarios alternativos el ${calendarInfo.alternativesDate}:
${calendarInfo.alternatives.map(h => `  • ${h}`).join('\n')}
`}`
  : calendarInfo.type === 'time_suggestions'
  ? `Preferencia: ${calendarInfo.preference}
Opciones disponibles:
${calendarInfo.suggestions.map(s => `  • ${s.day} ${s.date}: ${s.hours.join(', ')}`).join('\n')}`
  : calendarInfo.error || 'Sin resultados'
}

IMPORTANTE: Responde naturalmente basándote en esta información. NO copies estos textos exactos.
`;
          
          messages.push({
            role: 'system',
            content: calendarContext
          });
          
          console.log('✅ [AI] Contexto de Calendar agregado al prompt');
        }
      }

      console.log(`🤖 Generando respuesta con ${messages.length} mensajes de contexto`);
      console.log(`🔍 [AI] Modelo: ${this.model}, maxTokens: ${this.maxTokens}`);

      // Convertir mensajes de OpenAI format a Gemini format
      // System prompt va en systemInstruction, el resto en history/message
      const systemInstructionText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: this.maxTokens,
          temperature: this.temperature
        },
        systemInstruction: {
            role: 'system',
            parts: [{ text: systemInstructionText }]
        }
      });
      
      console.log('🔍 [AI] Creando promesa de Gemini...');
      
      const chatHistory = messages.filter(m => m.role !== 'system' && m.role !== 'user').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      
      // El último mensaje de usuario es el prompt actual
      const lastUserMessage = messages[messages.length - 1].content;

      const chat = model.startChat({
        history: chatHistory
      });

      const geminiPromise = chat.sendMessage(lastUserMessage);
      
      console.log('🔍 [AI] Creando promesa de timeout (10s)...');
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          console.log('⏰ [AI] ¡TIMEOUT alcanzado! (10s)');
          reject(new Error('TIMEOUT_10000MS'));
        }, 10000);
      });
      
      console.log('⏳ Esperando respuesta de Gemini (timeout: 10s)...');
      const result = await Promise.race([geminiPromise, timeoutPromise]);
      console.log('✅ Gemini completó la respuesta');

      const content = result.response.text();
      const tokensUsed = result.response.usageMetadata?.totalTokenCount || 0;
      
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(content);
        
        // ✅ VALIDACIÓN CRÍTICA: Si responseText es un objeto o JSON string, limpiarlo
        if (parsedResponse.responseText && typeof parsedResponse.responseText === 'string' && parsedResponse.responseText.trim().startsWith('{')) {
            console.warn('⚠️ [AI] responseText parece ser JSON anidado, intentando limpiar...');
            try {
                const innerJson = JSON.parse(parsedResponse.responseText);
                if (innerJson.responseText) {
                    parsedResponse.responseText = innerJson.responseText;
                }
            } catch (e) {
                // Ignorar error de parseo anidado
            }
        }
      } catch (e) {
        console.error('❌ Error parsing JSON response:', e);
        parsedResponse = { responseText: content };
      }

      console.log(`✅ Respuesta generada (${tokensUsed} tokens)`);

      return {
        response: parsedResponse.responseText || content,
        userInfoUpdate: parsedResponse.userInfoUpdate,
        options: parsedResponse.options,
        lastQuestionId: parsedResponse.lastQuestionId,
        tokensUsed,
        model: "gemini-2.0-flash",
        finishReason: result.response.candidates?.[0]?.finishReason
      };
    } catch (error) {
      console.error('❌ Error generando respuesta con Gemini:', error.message);
      console.error('❌ Stack trace:', error.stack);
      console.log('🔄 Activando sistema de fallback inteligente...');
      
      // Respuestas de fallback basadas en intención
      const intent = this.detectIntent(userMessage);
      let fallbackResponse;
      
      // Obtener hora de Ecuador para saludo apropiado
      const ecuadorDate = new Date(new Date().toLocaleString('en-US', { 
        timeZone: 'America/Guayaquil'
      }));
      const hour = ecuadorDate.getHours();
      
      console.log(`⏰ [AI Fallback] Hora Ecuador: ${hour}:${ecuadorDate.getMinutes()}`);
      
      let greeting = 'Buenos días';
      if (hour >= 12 && hour < 19) {
        greeting = 'Buenas tardes';
      } else if (hour >= 19 || hour < 5) {
        greeting = 'Buenas noches';
      }
      
      switch (intent) {
        case 'greeting':
          fallbackResponse = `${greeting}. Soy el Asistente Interno de BIOSKIN 🏥 ¿En qué puedo ayudarte?`;
          break;
        case 'appointment':
          fallbackResponse = 'Con gusto le asisto con el agendamiento de su cita 📅 Por favor contáctenos al WhatsApp de la clínica para coordinar su visita.';
          break;
        case 'info':
          fallbackResponse = 'Ofrecemos tratamientos faciales y corporales de medicina estética ✨ ¿Sobre qué tratamiento desea información?';
          break;
        case 'farewell':
          fallbackResponse = 'Que tenga un excelente día. Estamos a su disposición cuando lo necesite 👋';
          break;
        default:
          fallbackResponse = 'Gracias por su mensaje. Un asesor se pondrá en contacto con usted a la brevedad para brindarle la información necesaria 😊';
      }
      
      console.log(`✅ Respuesta generada con fallback (${intent}): "${fallbackResponse.substring(0, 50)}..."`);
      
      return {
        response: fallbackResponse,
        tokensUsed: 0,
        error: error.message,
        fallback: true
      };
    }
  }

  /**
   * Valida si un mensaje es una cancelación o salida del proceso
   * @param {string} text - Texto del usuario
   * @returns {Promise<boolean>} True si es cancelación
   */
  async isCancellation(text) {
    try {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: { responseMimeType: "application/json" }
      });

      const prompt = `Analiza si el usuario quiere CANCELAR, SALIR, DETENER o ABANDONAR el proceso actual.
      Devuelve JSON: { "isCancellation": boolean }
      
      Ejemplos TRUE: "cancelar", "ya no quiero", "salir", "stop", "basta", "menu", "volver al inicio", "olvídalo", "mejor no".
      Ejemplos FALSE: "no", "cambiar fecha", "otra hora", "espera", "un momento", "no sé", "mañana".
      
      Mensaje: "${text}"`;

      const result = await model.generateContent(prompt);
      const response = JSON.parse(result.response.text());
      return response.isCancellation;
    } catch (e) {
      console.error('Error validando cancelación con IA:', e);
      // Fallback regex simple
      return /(cancelar|salir|stop|basta|ya no|olvida|menu|menú)/i.test(text);
    }
  }

  /**
   * Detecta si el mensaje del usuario es una interrupción/pregunta en lugar de un dato esperado
   * @param {string} userMessage - Mensaje del usuario
   * @param {string} expectedDataType - Tipo de dato esperado ('date', 'time', 'name', 'confirmation')
   * @returns {Promise<{isInterruption: boolean, response: string|null, repairedValue: string|null}>}
   */
  async detectInterruption(userMessage, expectedDataType) {
    try {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: { responseMimeType: "application/json" }
      });

      const systemPrompt = `Eres un asistente inteligente que ayuda a una máquina de estados de agendamiento.
Tu tarea es analizar el mensaje del usuario dado que esperamos un dato de tipo: "${expectedDataType}".

CLASIFICACIÓN:
1. INTERRUPCIÓN: Pregunta fuera de contexto ("¿duele?", "¿precio?"), duda ("no sé"), o cambio de tema.
2. DATO VÁLIDO (REPARACIÓN): El usuario intenta dar el dato pero de forma coloquial o compleja (ej: "mañana por la mañana" para fecha, "después de las 5" para hora).
3. DATO INVÁLIDO: No se entiende nada.

ACCIONES:
- Si es INTERRUPCIÓN: Genera una respuesta BREVE y amable a su duda.
- Si es DATO VÁLIDO (REPARACIÓN): Extrae el valor normalizado (ej: "2023-11-25", "17:00", "mañana").
- Si es DATO INVÁLIDO: isInterruption=false, repairedValue=null.

Responde SOLO en formato JSON:
{
  "isInterruption": boolean,
  "response": "texto de respuesta si es interrupción (null si no)",
  "repairedValue": "valor normalizado si es dato válido (null si no)"
}

Mensaje Usuario: "${userMessage}"`;

      const result = await model.generateContent(systemPrompt);
      return JSON.parse(result.response.text());

    } catch (error) {
      console.error('Error en detectInterruption:', error);
      return { isInterruption: false, response: null, repairedValue: null };
    }
  }

  /**
   * Genera una respuesta de error empática y contextual cuando el usuario da un dato inválido
   */
  async generateErrorResponse(userMessage, errorType) {
    try {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      
      const prompt = `El usuario dio una respuesta inválida en un flujo de agendamiento.
      
CONTEXTO: Esperábamos ${errorType} (ej: fecha, hora).
MENSAJE USUARIO: "${userMessage}"

Genera una respuesta breve (1-2 líneas) que:
1. Aclare amablemente que no entendiste.
2. Dé un ejemplo claro de cómo responder.
3. Mantenga el tono de asistente virtual servicial.

Responde solo con el texto.`;

      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      return null;
    }
  }

  /**
   * Genera una respuesta empática cuando no hay disponibilidad
   */
  async generateNoAvailabilityResponse(dateText) {
    try {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const prompt = `El usuario quiere agendar para el ${dateText} pero NO hay horarios disponibles.
      
Genera una respuesta breve y empática que:
1. Se disculpe por la falta de cupos.
2. Pregunte si prefiere buscar otro día cercano.
3. Sea cálida y profesional.

Responde solo con el texto.`;

      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      return null;
    }
  }

  /**
   * Interpreta el nombre de un servicio usando IA
   * Útil cuando el usuario describe un problema o usa términos no exactos
   * @param {string} text - Texto del usuario
   * @returns {Promise<string|null>} Nombre del servicio interpretado
   */
  async interpretServiceName(text) {
    try {
      console.log(`🧠 [AI] Interpretando servicio desde: "${text}"`);
      
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      
      const prompt = `Eres un asistente experto en medicina estética. Tu tarea es extraer o deducir el nombre del servicio/tratamiento médico estético de un texto.
            
            REGLAS:
            1. Si el usuario nombra un tratamiento, normalízalo (ej: "limpieza" -> "Limpieza Facial Profunda").
            2. Si describe un problema, deduce el tratamiento (ej: "tengo granos" -> "Tratamiento de Acné").
            3. Si menciona varios, combínalos (ej: "limpieza y consulta" -> "Limpieza Facial + Consulta").
            4. Si no es un servicio médico/estético claro, devuelve el texto original limpio.
            5. Devuelve SOLO el nombre del servicio, sin frases extra.
            6. Mantén el idioma Español.
            
            CATÁLOGO BASE:
            - Limpieza Facial Profunda
            - Hydrafacial
            - Tratamiento de Acné
            - Tratamiento de Manchas / Melasma
            - Rejuvenecimiento Facial
            - Toxina Botulínica (Botox)
            - Rellenos de Ácido Hialurónico
            - Rinomodelación
            - Aumento de Labios
            - HIFU Lifting Facial
            - Láser CO2 Fraccionado
            - Depilación Láser
            - Consulta Médica Estética
            
            Texto usuario: "${text}"
            
            Servicio interpretado:`;

      const result = await model.generateContent(prompt);
      const serviceName = result.response.text().trim();
      
      console.log(`✅ [AI] Servicio interpretado: "${serviceName}"`);
      return serviceName.replace(/^["']|["']$/g, ''); // Quitar comillas si las hay
      
    } catch (error) {
      console.error('❌ [AI] Error interpretando servicio:', error);
      return null;
    }
  }

  /**
   * Actualiza el prompt del sistema (para personalizar el chatbot)
   */
  updateSystemPrompt(newPrompt) {
    this.systemPrompt = newPrompt;
    console.log('✅ Prompt del sistema actualizado');
  }

  /**
   * Configura parámetros del modelo
   */
  configure(config = {}) {
    if (config.model) this.model = config.model;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.temperature !== undefined) this.temperature = config.temperature;
    
    console.log('✅ Configuración del chatbot actualizada:', {
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature
    });
  }

  /**
   * Detecta intención del mensaje (para lógica condicional)
   */
  detectIntent(message) {
    const lowerMsg = message.toLowerCase().trim();
    
    // Orden de prioridad: Intenciones específicas > Saludos > General
    const intents = {
      cancellation: /(cancelar|anular|suspender|no voy a poder|no podré|no puedo asistir|inconveniente|baja|dar de baja)/i,
      appointment: /(agendar|cita|reservar|turno|disponibilidad|horario|agenda|reserva|appointment|book)/i,
      appointment_confirmation: /\b(sí|si|confirmo|confirmar|ok|vale|dale|perfecto)\b/i,
      appointment_rejection: /(\bno\b|mejor no|cambiar|otra hora|otro día)/i,
      transfer_doctor: /(hablar con|contactar|derivar|doctor|doctora|especialista|quiero hablar)/i,
      info: /(información|info|tratamiento|servicio|precio|costo|cuánto)/i,
      help: /(ayuda|help|no entiendo|qué puedes hacer)/i,
      greeting: /^(hola|buenos días|buenas tardes|hey|hi|saludos)/i,
      farewell: /(adiós|chau|hasta luego|gracias|bye)/i,
    };

    for (const [intent, pattern] of Object.entries(intents)) {
      if (pattern.test(lowerMsg)) {
        return intent;
      }
    }

    return 'general';
  }

  /**
   * Extrae información de agendamiento del mensaje
   * Retorna objeto con fecha, hora, nombre, teléfono, servicio si los detecta
   */
  extractAppointmentData(message) {
    console.log(`🔍 [AI] Extrayendo datos de agendamiento de: "${message}"`);
    const appointmentData = {};
    
    // Intentar extraer fecha
    const date = parseNaturalDate(message);
    console.log(`📅 [AI] Fecha detectada: ${date || 'ninguna'}`);
    if (date) {
      appointmentData.date = date;
    }
    
    // Intentar extraer hora
    const time = parseNaturalTime(message);
    console.log(`⏰ [AI] Hora detectada: ${time || 'ninguna'}`);
    if (time) {
      appointmentData.time = time;
    }
    
    // Extraer nombre (si dice "mi nombre es X" o "soy X")
    const nameMatch = message.match(/(?:mi nombre es|me llamo|soy)\s+([a-záéíóúñ\s]+)/i);
    if (nameMatch) {
      appointmentData.name = nameMatch[1].trim();
    }
    
    // Extraer teléfono
    const phoneMatch = message.match(/(?:mi teléfono es|mi número es|mi celular es)?\s*(\+?\d[\d\s\-]{7,})/i);
    if (phoneMatch) {
      appointmentData.phone = phoneMatch[1].replace(/[\s\-]/g, '');
    }
    
    // Detectar tratamiento mencionado usando catálogo centralizado
    const foundTreatment = findTreatmentByKeyword(message);
    if (foundTreatment) {
      appointmentData.service = foundTreatment.name;
    }
    
    const hasData = Object.keys(appointmentData).length > 0;
    console.log(`✅ [AI] Datos extraídos:`, hasData ? appointmentData : 'ninguno');
    return hasData ? appointmentData : null;
  }

  /**
   * Verifica si un mensaje contiene una preferencia de horario
   */
  detectTimePreference(message) {
    const lowerMsg = message.toLowerCase();
    
    if (lowerMsg.includes('mañana') && !lowerMsg.includes('pasado mañana')) {
      return { type: 'time', value: 'morning' };
    }
    if (lowerMsg.includes('tarde')) {
      return { type: 'time', value: 'afternoon' };
    }
    if (lowerMsg.includes('noche') || lowerMsg.includes('después de') || lowerMsg.includes('5pm') || lowerMsg.includes('6pm')) {
      return { type: 'time', value: 'evening' };
    }
    if (lowerMsg.includes('fin de semana') || lowerMsg.includes('sábado') || lowerMsg.includes('sabado')) {
      return { type: 'day', value: 'weekend' };
    }
    if (lowerMsg.includes('entre semana') || lowerMsg.includes('lunes') || lowerMsg.includes('martes') || 
        lowerMsg.includes('miércoles') || lowerMsg.includes('miercoles') || lowerMsg.includes('jueves') || lowerMsg.includes('viernes')) {
      return { type: 'day', value: 'weekday' };
    }
    
    return null;
  }

  /**
   * Genera link de WhatsApp para derivación profesional con presentación completa
   * @param {Array} conversationHistory - Últimos mensajes de la conversación
   * @param {Object} options - Opciones adicionales { isTechnical: boolean, patientName: string }
   * @returns {string} - Link de WhatsApp con mensaje predefinido
   */
  generateDoctorWhatsAppLink(conversationHistory = [], options = {}) {
    const BIOSKIN_PHONE = '593969890689'; // Número principal de BIOSKIN
    
    // Extraer los últimos 6 mensajes (3 intercambios)
    const recentMessages = conversationHistory.slice(-6);
    
    // Detectar si es tema técnico o médico
    const allText = recentMessages.map(m => m.content).join(' ').toLowerCase();
    const technicalKeywords = /(equipo|aparato|dispositivo|máquina|laser|hifu|tecnología|compra|precio.*equipo|producto.*estético|aparatología)/i;
    const isTechnical = options.isTechnical || technicalKeywords.test(allText);
    
    // Determinar destinatario
    const recipient = isTechnical ? 'Ing. Rafael Larrea' : 'Dra. Daniela Creamer';
    const recipientRole = isTechnical ? 'Ingeniero de Equipos Médicos' : 'Médico Estético';
    
    // Detectar tema principal
    let topic = 'consulta general';
    
    if (isTechnical) {
      if (allText.includes('hifu')) topic = 'equipos HIFU';
      else if (allText.includes('laser') || allText.includes('láser')) topic = 'equipos láser';
      else if (allText.includes('dispositivo') || allText.includes('máquina')) topic = 'dispositivos médicos estéticos';
      else if (allText.includes('precio') || allText.includes('compra')) topic = 'cotización de equipos';
      else topic = 'equipos de medicina estética';
    } else {
      if (allText.includes('mancha') || allText.includes('pigment')) topic = 'tratamiento de manchas';
      else if (allText.includes('acné') || allText.includes('acne')) topic = 'tratamiento de acné';
      else if (allText.includes('arruga') || allText.includes('envejec')) topic = 'rejuvenecimiento facial';
      else if (allText.includes('limpieza')) topic = 'limpieza facial profunda';
      else if (allText.includes('hifu') && !isTechnical) topic = 'tratamiento HIFU lifting';
      else if (allText.includes('relleno') || allText.includes('labio')) topic = 'rellenos dérmicos';
      else if (allText.includes('toxina') || allText.includes('botox')) topic = 'toxina botulínica';
      else if (allText.includes('peeling')) topic = 'peeling químico';
      else topic = 'consulta médico-estética';
    }
    
    // Construir mensaje con presentación profesional
    let message = `Buenos días, me contacto desde el chatbot de BIOSKIN Salud & Estética.\\n\\n`;
    
    // Añadir nombre del paciente si está disponible
    if (options.patientName) {
      message += `Mi nombre es ${options.patientName} y `;
    }
    
    message += `solicito información sobre *${topic}*.\\n\\n`;
    message += `📋 *Resumen de mi consulta:*\\n`;
    
    // Agregar contexto de los últimos mensajes del usuario
    const userMessages = recentMessages.filter(m => m.role === 'user');
    if (userMessages.length > 0) {
      const lastUserMsg = userMessages[userMessages.length - 1].content;
      const preview = lastUserMsg.length > 80 ? lastUserMsg.substring(0, 80) + '...' : lastUserMsg;
      message += `"${preview}"\\n\\n`;
    } else {
      message += `Estoy interesado/a en recibir más información y asesoría personalizada.\\n\\n`;
    }
    
    message += `🎯 *Solicito:*\\n`;
    message += isTechnical 
      ? `- Información técnica y comercial de equipos\\n- Cotización y formas de pago\\n- Especificaciones y capacitación`
      : `- Evaluación personalizada de mi caso\\n- Información sobre tratamientos disponibles\\n- Agendar consulta médica`;
    
    message += `\\n\\n_Mensaje enviado desde el chatbot de BIOSKIN_`;
    
    // Generar link de WhatsApp
    const encodedMessage = encodeURIComponent(message);
    const whatsappLink = `https://wa.me/${BIOSKIN_PHONE}?text=${encodedMessage}`;
    
    console.log(`📱 Link de WhatsApp generado para ${recipient} (${isTechnical ? 'técnico' : 'médico'})`);
    
    return whatsappLink;
  }

  /**
   * Valida que el API key de Gemini esté configurado
   */
  static validateConfiguration() {
    if (!process.env.GOOGLE_GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY no configurado en variables de entorno');
    }
    return true;
  }
}

// Instancia por defecto
export const chatbotAI = new ChatbotAIService();
