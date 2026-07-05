import { 
  getAllConversations, 
  getConversationMessages,
  saveMessage,
  getTrackingEvents,
  getWhatsAppTemplates,
  getUserPreferences,
  getGlobalSettings,
  updateGlobalSettings,
  getDatabaseStats
} from '../lib/neon-chatbot-db-vercel.js';
import { cleanupService } from '../lib/internal-bot-cleanup.js';
import { FallbackStorage } from '../lib/fallback-storage.js';
import { sql } from '@vercel/postgres';
import { processInternalChatMessage } from '../lib/internal-chat-service.js';
import { googleCalendarService } from '../lib/google-calendar-service.js';
import { sendWhatsAppMessage } from '../lib/admin-notifications.js';
import { STAFF_NUMBERS } from '../lib/config.js';

/**
 * API UNIFICADA PARA HERRAMIENTAS INTERNAS Y CHATBOT
 * 
 * Incluye:
 * - Gestión de Chatbot WhatsApp (Manager/Monitor)
 * - Chat Interno (Staff)
 * - Herramientas AI (Diagnóstico/Protocolos)
 * - Analytics (Básico)
 */
export default async function handler(req, res) {
  // CORS para desarrollo
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { type, action, limit = '50' } = req.query;
    const limitNum = parseInt(limit, 10);

    // ==========================================
    // SECCIÓN: INTERNAL CHAT (Chat Staff)
    // ==========================================
    if (type === 'internal-chat') {
      return await handleInternalChatEndpoints(req, res, action);
    }

    // ==========================================
    // SECCIÓN: AI TOOLS (Diagnóstico/Protocolos)
    // ==========================================
    if (type === 'ai') {
      return await handleAIToolsEndpoints(req, res, action);
    }

    // ==========================================
    // SECCIÓN: ANALYTICS (Web Analytics)
    // ==========================================
    if (type === 'analytics') {
      return await handleAnalyticsEndpoints(req, res);
    }

    // ==========================================
    // SECCIÓN: SETTINGS (Configuración Global)
    // ==========================================
    if (type === 'settings') {
      return await handleSettingsEndpoints(req, res);
    }

    // ==========================================
    // SECCIÓN: STATS (Estadísticas Detalladas)
    // ==========================================
    if (type === 'stats') {
      return await handleStatsEndpoints(req, res);
    }

    // Sin type especificado
    return res.status(400).json({
      success: false,
      error: 'Falta parámetro "type". Usa: internal-chat, ai, analytics',
      examples: [
        '/api/internal-bot-api?type=internal-chat&action=list'
      ]
    });

  } catch (error) {
    console.error('❌ [Internal API] Error general:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// ==========================================
// HANDLER: INTERNAL CHAT ENDPOINTS
// ==========================================
async function handleInternalChatEndpoints(req, res, action) {
  // GET: List Conversations, Get Messages, or Cron Jobs
  if (req.method === 'GET') {
    const { sessionId } = req.query;

    try {
      // --- CRON JOB: DAILY AGENDA ---
      if (action === 'daily-agenda') {
        // Verify Cron Secret
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.query.key !== process.env.CRON_SECRET) {
          return res.status(401).json({ error: 'Unauthorized' });
        }

        console.log('⏰ Ejecutando Cron Job: Agenda Diaria (Internal Chat Endpoint)');

        // 1. Get Events for Next 3 Days (72h)
        const events = await googleCalendarService.getUpcomingEvents(72);
        
        if (!events || events.length === 0) {
          console.log('ℹ️ No hay eventos para los próximos 3 días');
        }

        // 2. Format Message
        const now = new Date();
        const options = { timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long' };
        const todayStr = now.toLocaleDateString('es-EC', options);
        
        let message = `🌅 *Buenos días, equipo BIOSKIN* ☀️\n\n`;
        message += `📅 *Resumen de Agenda - ${todayStr}*\n\n`;

        // Group by day
        const groupedEvents = {};
        
        // Initialize keys for next 3 days
        for (let i = 0; i < 3; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() + i);
          const dayKey = d.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric' });
          groupedEvents[dayKey] = [];
        }

        if (events) {
          events.forEach(e => {
            const eventDate = new Date(e.start.dateTime || e.start.date);
            const dayKey = eventDate.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric' });
            const timeStr = eventDate.toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit' });
            const summary = `• *${timeStr}* - ${e.summary}`;
            
            if (groupedEvents[dayKey]) {
              groupedEvents[dayKey].push(summary);
            }
          });
        }

        // Build message body
        Object.keys(groupedEvents).forEach((day, index) => {
          const label = index === 0 ? 'HOY' : (index === 1 ? 'MAÑANA' : day.toUpperCase());
          const dayEvents = groupedEvents[day];
          
          message += `*${label}:*\n`;
          if (dayEvents.length > 0) {
            message += `${dayEvents.join('\n')}\n\n`;
          } else {
            message += `Sin citas programadas.\n\n`;
          }
        });

        // Motivational Quote (AI Generated)
        let randomQuote = "¡Que tengas un excelente día!";
        try {
          const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
          if (apiKey) {
            const quotePrompt = "Genera una frase corta, inspiradora y motivadora para un equipo de trabajo de una clínica estética. Enfocada en el éxito, la calidad, el trabajo en equipo y el crecimiento profesional. Solo la frase y el autor (si aplica) o anónimo.";
            
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: quotePrompt }] }],
                generationConfig: { maxOutputTokens: 100 }
              })
            });

            if (response.ok) {
              const data = await response.json();
              const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (aiText) randomQuote = aiText.trim();
            }
          }
        } catch (err) {
          console.error('Error generating AI quote:', err);
          randomQuote = "\"El éxito es la suma de pequeños esfuerzos repetidos día tras día.\"";
        }
        
        message += `💡 *Frase del día:*\n_${randomQuote}_\n\n`;
        message += `_Asistente Virtual BIOSKIN_ 🤖`;

        // 3. Send to Staff
        console.log(`📤 Enviando notificación a ${STAFF_NUMBERS.length} miembros del staff...`);
        
        const results = await Promise.allSettled(
          STAFF_NUMBERS.map(number => sendWhatsAppMessage(number, message))
        );

        const successCount = results.filter(r => r.status === 'fulfilled').length;
        console.log(`✅ Notificaciones enviadas: ${successCount}/${STAFF_NUMBERS.length}`);

        return res.status(200).json({ 
          success: true, 
          sentTo: successCount, 
          totalEvents: events ? events.length : 0 
        });
      }

      if (action === 'list') {
        // List all internal conversations
        const result = await sql`
          SELECT session_id, last_message_at, total_messages, user_info
          FROM internal_bot_conversations 
          WHERE session_id LIKE 'internal_%'
          ORDER BY last_message_at DESC
          LIMIT 50
        `;
        return res.status(200).json({ conversations: result.rows });
      }

      if (action === 'get' && sessionId) {
        // Get messages for a specific session
        const result = await sql`
          SELECT role, content, timestamp
          FROM internal_bot_messages 
          WHERE session_id = ${sessionId}
          ORDER BY timestamp ASC
        `;
        return res.status(200).json({ messages: result.rows });
      }

      return res.status(400).json({ error: 'Invalid action or missing sessionId' });
    } catch (error) {
      console.error('GET Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // DELETE: Delete Conversation
  if (req.method === 'DELETE') {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    try {
      await sql`DELETE FROM internal_bot_conversations WHERE session_id = ${sessionId}`;
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('DELETE Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // POST: Send Message (Chat Logic)
  if (req.method === 'POST') {
    const { message, sessionId, isNewSession, isNewPatient, mode } = req.body;

    try {
      const aiResponse = await processInternalChatMessage({
        message,
        sessionId,
        isNewSession,
        isNewPatient,
        mode
      });

      return res.status(200).json({ response: aiResponse });

    } catch (error) {
      console.error('Internal Chat Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
}

// ==========================================
// HANDLER: AI TOOLS ENDPOINTS
// ==========================================
async function handleAIToolsEndpoints(req, res, action) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error: Missing API Key' });
  }

  const { prompt, images, context } = req.body;

  try {
    let systemInstruction = "";
    let userPrompt = prompt;

    if (action === 'diagnosis') {
      systemInstruction = "Eres un asistente experto en dermatología. Analiza las imágenes proporcionadas y describe las condiciones visibles de la piel, posibles afecciones y características relevantes. Responde en español detalladamente. Incluye un descargo de responsabilidad de que esto es una herramienta de ayuda y no sustituye el diagnóstico médico profesional.";
      if (context) {
        userPrompt += `\n\nContexto adicional del paciente: ${context}`;
      }
    } else if (action === 'protocol') {
      systemInstruction = "Eres un asistente clínico experto en aparatología estética (Nd:YAG, CO2, IPL, HIFU, Radiofrecuencia, etc.). Proporciona protocolos detallados, parámetros sugeridos y recomendaciones de seguridad. Responde en español.";
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Construct the payload for Gemini API (REST)
    const models = [
      'gemini-2.0-flash',      // Stable
      'gemini-2.5-flash',      // Newest
      'gemini-1.5-flash'       // Fallback
    ];

    let lastError = null;
    let successResponse = null;

    for (const model of models) {
      try {
        console.log(`[Gemini API] Trying model: ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const contents = [
          {
            role: "user",
            parts: [
              { text: systemInstruction + "\n\n" + userPrompt }
            ]
          }
        ];

        // Add images if present (for diagnosis)
        if (images && Array.isArray(images)) {
          for (const img of images) {
            contents[0].parts.push({
              inline_data: {
                mime_type: img.mimeType,
                data: img.data
              }
            });
          }
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: contents
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          const errorCode = errorData.error?.code;
          const errorMessage = errorData.error?.message;
          
          console.warn(`[Gemini API] Model ${model} failed: ${errorCode} - ${errorMessage}`);
          
          if (errorCode === 429 || errorCode === 404 || errorMessage?.includes('not found') || errorMessage?.includes('quota')) {
            lastError = new Error(errorMessage);
            continue; 
          } else {
            lastError = new Error(errorMessage);
            continue;
          }
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          throw new Error('No response generated');
        }

        successResponse = text;
        break;

      } catch (error) {
        console.error(`[Gemini API] Error with model ${model}:`, error);
        lastError = error;
      }
    }

    if (successResponse) {
      return res.status(200).json({ result: successResponse });
    } else {
      throw lastError || new Error('All AI models failed to generate a response.');
    }

  } catch (error) {
    console.error('Gemini API Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ==========================================
// HANDLER: ANALYTICS ENDPOINTS
// ==========================================
async function handleAnalyticsEndpoints(req, res) {
  try {
    if (req.method === 'GET') {
      // Mock stats for now (since original was in-memory)
      // In future, connect to DB
      const stats = {
        pageViews: { total: 0, daily: {} },
        sessions: { total: 0 },
        startDate: new Date().toISOString()
      };
      return res.status(200).json(stats);
    }

    if (req.method === 'POST') {
      // Log event (mock)
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (error) {
    console.error('Error en analytics:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}




// ==========================================
// HANDLER: SETTINGS ENDPOINTS
// ==========================================
async function handleSettingsEndpoints(req, res) {
  // 1. Verify Auth
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  
  try {
    const session = await sql`
      SELECT * FROM admin_sessions 
      WHERE session_token = ${token} 
      AND is_active = true 
      AND expires_at > NOW()
    `;
    
    if (session.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  } catch (error) {
    console.error('Auth error:', error);
    if (req.method === 'POST') {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  // 2. Handle Request
  try {
    if (req.method === 'GET') {
      const settings = await getGlobalSettings();
      return res.status(200).json(settings);
    } else if (req.method === 'POST') {
      const { chatbotEnabled } = req.body;
      if (typeof chatbotEnabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid payload' });
      }
      
      await updateGlobalSettings({ chatbotEnabled });
      return res.status(200).json({ success: true, chatbotEnabled });
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Settings error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// ==========================================
// HANDLER: STATS ENDPOINTS
// ==========================================
async function handleStatsEndpoints(req, res) {
  try {
    if (req.method === 'GET') {
      console.log('📊 Obteniendo estadísticas del chatbot...');

      let dbStats;
      let usedFallback = false;
      
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 3000)
        );
        dbStats = await Promise.race([getDatabaseStats(), timeoutPromise]);
      } catch (error) {
        console.warn('⚠️ Base de datos no disponible, usando fallback:', error.message);
        dbStats = FallbackStorage.getStats();
        usedFallback = true;
      }

      const storageCheck = usedFallback 
        ? { needsCleanup: false, currentMB: 0, maxMB: 512, percentUsed: 0, sizePretty: '0 MB' }
        : await cleanupService.checkStorageUsage();

      const stats = {
        timestamp: new Date().toISOString(),
        status: storageCheck.needsCleanup ? 'warning' : (usedFallback ? 'fallback' : 'healthy'),
        dataSource: usedFallback ? 'memory (database unavailable)' : 'database',
        storage: {
          current: `${storageCheck.currentMB} MB`,
          limit: `${storageCheck.maxMB} MB`,
          percentUsed: `${storageCheck.percentUsed}%`,
          needsCleanup: storageCheck.needsCleanup
        },
        database: dbStats,
        system: {
          nodeVersion: process.version,
          memoryUsage: process.memoryUsage(),
          uptime: process.uptime()
        }
      };

      return res.status(200).json(stats);
    } else if (req.method === 'POST') {
      // Mantenimiento manual
      const { action } = req.body;
      
      if (action === 'cleanup') {
        console.log('🧹 Ejecutando limpieza manual...');
        const result = await cleanupService.runCleanup();
        return res.status(200).json(result);
      }
      
      return res.status(400).json({ error: 'Acción no válida' });
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function getTimeAgo(dateString) {
  if (!dateString) return 'Nunca';
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Hace un momento';
  if (diffMins < 60) return `Hace ${diffMins} min`;
  if (diffHours < 24) return `Hace ${diffHours}h`;
  if (diffDays < 7) return `Hace ${diffDays} días`;
  if (diffDays < 30) return `Hace ${Math.floor(diffDays / 7)} semanas`;
  return `Hace ${Math.floor(diffDays / 30)} meses`;
}

function isRecent(dateString, hoursThreshold = 24) {
  if (!dateString) return false;
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffHours = diffMs / 3600000;

  return diffHours <= hoursThreshold;
}
