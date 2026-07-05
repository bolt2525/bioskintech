/**
 * Sistema de almacenamiento de respaldo cuando Neon no responde
 * Guarda datos en memoria temporal y los sincroniza después
 */

// Almacenamiento en memoria (se pierde al reiniciar la función)
const pendingMessages = new Map();
const conversations = new Map();

export class FallbackStorage {
  /**
   * Guarda conversación en memoria
   * Retorna objeto con conversación e indicador isNew
   */
  static saveConversation(sessionId, phoneNumber) {
    const existing = conversations.get(sessionId);
    const isNew = !existing;
    
    const conversation = {
      session_id: sessionId,
      phone_number: phoneNumber,
      created_at: existing?.created_at || new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      total_messages: (existing?.total_messages || 0) + 1,
      is_active: true
    };
    
    conversations.set(sessionId, conversation);
    console.log(`💾 [FALLBACK] Conversación guardada en memoria: ${sessionId}, Nueva: ${isNew}`);
    return { conversation, isNew };
  }

  /**
   * Guarda mensaje en memoria
   */
  static saveMessage(sessionId, role, content, tokensUsed = 0, messageId = null) {
    const message = {
      session_id: sessionId,
      role,
      content,
      timestamp: new Date().toISOString(),
      tokens_used: tokensUsed,
      message_id: messageId
    };
    
    if (!pendingMessages.has(sessionId)) {
      pendingMessages.set(sessionId, []);
    }
    
    pendingMessages.get(sessionId).push(message);
    console.log(`💾 [FALLBACK] Mensaje guardado en memoria: ${role} - ${content.substring(0, 30)}...`);
    return message;
  }

  /**
   * Obtiene historial de conversación desde memoria
   */
  static getConversationHistory(sessionId, limit = 20) {
    const messages = pendingMessages.get(sessionId) || [];
    console.log(`📜 [FALLBACK] Historial desde memoria: ${messages.length} mensajes`);
    
    // Devolver en formato compatible
    return messages.slice(-limit).map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      tokens_used: msg.tokens_used
    }));
  }

  /**
   * Obtiene estadísticas desde memoria
   */
  static getStats() {
    const totalSessions = conversations.size;
    let totalMessages = 0;
    
    for (const messages of pendingMessages.values()) {
      totalMessages += messages.length;
    }
    
    return {
      storage: {
        sizeMB: '0.00',
        percentUsed: '0.0',
        limit: 'Memoria temporal'
      },
      activity: {
        totalSessions,
        totalMessages,
        avgMessagesPerSession: totalSessions > 0 ? (totalMessages / totalSessions).toFixed(2) : '0.00',
        activeSessions: totalSessions,
        activeLast24h: totalSessions
      }
    };
  }

  /**
   * Intenta sincronizar datos pendientes con Neon (llamar en background)
   */
  static async syncToNeon(dbModule) {
    console.log('🔄 [FALLBACK] Intentando sincronizar datos pendientes...');
    
    let syncedSessions = 0;
    let syncedMessages = 0;
    
    try {
      // Sincronizar conversaciones
      for (const [sessionId, conv] of conversations.entries()) {
        try {
          await dbModule.upsertConversation(conv.session_id, conv.phone_number);
          syncedSessions++;
        } catch (error) {
          console.error(`❌ [FALLBACK] Error sincronizando conversación ${sessionId}:`, error.message);
        }
      }
      
      // Sincronizar mensajes
      for (const [sessionId, messages] of pendingMessages.entries()) {
        for (const msg of messages) {
          try {
            await dbModule.saveMessage(
              msg.session_id,
              msg.role,
              msg.content,
              msg.tokens_used,
              msg.message_id
            );
            syncedMessages++;
          } catch (error) {
            console.error(`❌ [FALLBACK] Error sincronizando mensaje:`, error.message);
          }
        }
      }
      
      console.log(`✅ [FALLBACK] Sincronizado: ${syncedSessions} sesiones, ${syncedMessages} mensajes`);
      
      // Limpiar datos sincronizados exitosamente
      if (syncedSessions === conversations.size) {
        conversations.clear();
      }
      if (syncedMessages === Array.from(pendingMessages.values()).reduce((sum, msgs) => sum + msgs.length, 0)) {
        pendingMessages.clear();
      }
      
      return { syncedSessions, syncedMessages };
    } catch (error) {
      console.error('❌ [FALLBACK] Error en sincronización:', error);
      return { syncedSessions, syncedMessages };
    }
  }
}

export default FallbackStorage;
