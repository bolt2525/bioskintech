/**
 * Sistema de notificaciones del navegador para el panel admin
 * Permite recibir alertas en tiempo real de nuevas conversaciones y mensajes
 */

class BrowserNotifications {
  constructor() {
    this.permission = null;
    this.pollInterval = null;
    this.lastCheck = Date.now();
    this.knownConversations = new Set();
  }

  /**
   * Verifica si el navegador soporta notificaciones
   */
  isSupported() {
    return 'Notification' in window;
  }

  /**
   * Obtiene el estado actual de los permisos
   */
  getPermissionStatus() {
    if (!this.isSupported()) {
      return 'unsupported';
    }
    return Notification.permission;
  }

  /**
   * Solicita permisos de notificación al usuario
   */
  async requestPermission() {
    if (!this.isSupported()) {
      throw new Error('Este navegador no soporta notificaciones');
    }

    if (Notification.permission === 'granted') {
      this.permission = 'granted';
      return true;
    }

    if (Notification.permission === 'denied') {
      throw new Error('Los permisos de notificación fueron denegados. Debes habilitarlos manualmente en la configuración del navegador.');
    }

    try {
      const permission = await Notification.requestPermission();
      this.permission = permission;
      return permission === 'granted';
    } catch (error) {
      console.error('Error solicitando permisos:', error);
      throw error;
    }
  }

  /**
   * Muestra una notificación
   */
  show(title, options = {}) {
    if (!this.isSupported() || Notification.permission !== 'granted') {
      console.warn('No se puede mostrar notificación - permisos no concedidos');
      return null;
    }

    const defaultOptions = {
      icon: '/images/bioskin-logo.png',
      badge: '/images/bioskin-badge.png',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      ...options
    };

    try {
      const notification = new Notification(title, defaultOptions);
      
      // Auto-cerrar después de 10 segundos si no requiere interacción
      if (!defaultOptions.requireInteraction) {
        setTimeout(() => notification.close(), 10000);
      }

      return notification;
    } catch (error) {
      console.error('Error mostrando notificación:', error);
      return null;
    }
  }

  /**
   * Notifica sobre una nueva conversación
   */
  notifyNewConversation(phoneNumber, firstMessage) {
    const notification = this.show('🆕 Nueva conversación iniciada', {
      body: `📱 ${phoneNumber}\n💬 ${firstMessage.substring(0, 80)}...`,
      tag: `new-conv-${phoneNumber}`,
      data: {
        type: 'new_conversation',
        phoneNumber,
        url: window.location.href
      }
    });

    if (notification) {
      notification.onclick = (event) => {
        event.preventDefault();
        window.focus();
        // El evento se maneja en el panel principal
        document.dispatchEvent(new CustomEvent('notification-clicked', {
          detail: { type: 'new_conversation', phoneNumber }
        }));
      };
    }

    return notification;
  }

  /**
   * Notifica sobre un nuevo mensaje
   */
  notifyNewMessage(phoneNumber, message, isFromUser = true) {
    const notification = this.show(
      isFromUser ? '💬 Nuevo mensaje recibido' : '✅ Mensaje enviado',
      {
        body: `📱 ${phoneNumber}\n${message.substring(0, 100)}`,
        tag: `msg-${phoneNumber}-${Date.now()}`,
        requireInteraction: isFromUser,
        data: {
          type: 'new_message',
          phoneNumber,
          url: window.location.href
        }
      }
    );

    if (notification) {
      notification.onclick = (event) => {
        event.preventDefault();
        window.focus();
        document.dispatchEvent(new CustomEvent('notification-clicked', {
          detail: { type: 'new_message', phoneNumber }
        }));
      };
    }

    return notification;
  }

  /**
   * Inicia el polling para detectar nuevas conversaciones
   */
  startPolling(intervalSeconds = 30) {
    if (this.pollInterval) {
      console.warn('Polling ya está activo');
      return;
    }

    console.log(`🔔 Iniciando polling de notificaciones cada ${intervalSeconds}s`);
    
    this.pollInterval = setInterval(async () => {
      await this.checkForNewConversations();
    }, intervalSeconds * 1000);

    // Primera verificación inmediata
    this.checkForNewConversations();
  }

  /**
   * Detiene el polling
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('🔕 Polling de notificaciones detenido');
    }
  }

  /**
   * Verifica si hay nuevas conversaciones
   */
  async checkForNewConversations() {
    try {
      const response = await fetch('/api/chatbot-manager?action=getAll');
      
      if (!response.ok) {
        console.error('Error verificando conversaciones:', response.status);
        return;
      }

      const data = await response.json();
      
      if (!data.success || !data.conversations) {
        return;
      }

      // Verificar conversaciones nuevas
      for (const conv of data.conversations) {
        const convId = conv.session_id;
        
        // Si es una conversación que no conocíamos
        if (!this.knownConversations.has(convId)) {
          this.knownConversations.add(convId);
          
          // Solo notificar si la conversación es reciente (últimos 5 minutos)
          const lastMessageTime = new Date(conv.last_message_at).getTime();
          const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
          
          if (lastMessageTime > fiveMinutesAgo && lastMessageTime > this.lastCheck) {
            console.log('🆕 Nueva conversación detectada:', conv.phone_number);
            this.notifyNewConversation(conv.phone_number, 'Nueva conversación iniciada');
          }
        }
      }

      this.lastCheck = Date.now();
    } catch (error) {
      console.error('Error en polling de conversaciones:', error);
    }
  }

  /**
   * Inicializa el sistema de notificaciones cargando conversaciones existentes
   */
  async initialize() {
    try {
      const response = await fetch('/api/chatbot-manager?action=getAll');
      
      if (response.ok) {
        const data = await response.json();
        
        if (data.success && data.conversations) {
          // Cargar todas las conversaciones existentes sin notificar
          data.conversations.forEach(conv => {
            this.knownConversations.add(conv.session_id);
          });
          
          console.log(`✅ Sistema de notificaciones inicializado con ${this.knownConversations.size} conversaciones conocidas`);
        }
      }
    } catch (error) {
      console.error('Error inicializando sistema de notificaciones:', error);
    }
  }

  /**
   * Muestra notificación de prueba
   */
  showTestNotification() {
    return this.show('🔔 Notificaciones activadas', {
      body: '¡Recibirás alertas de nuevas conversaciones y mensajes!',
      requireInteraction: false
    });
  }
}

// Exportar instancia singleton
export const browserNotifications = new BrowserNotifications();
