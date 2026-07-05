import { getAllServices } from './services-adapter.js';
import { getAllProducts } from './products-adapter.js';

/**
 * Servicio de gestión de promociones
 * Lee y valida promociones activas directamente de los catálogos de servicios y productos
 * Reemplaza la dependencia de promotions.json
 */
export class PromotionsService {
  constructor() {
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutos de cache (aunque ahora es dinámico, mantenemos la estructura)
    
    // Configuración del bot (migrada de promotions.json)
    this.botConfig = {
      roles: {
        medico: {
          greeting: "Hola, soy el Asistente Interno de BIOSKIN. 🏥 Estoy aquí para ayudar al staff con protocolos, precios y consultas médicas.",
          contact: { name: "Dra. Daniela Creamer", role: "Médico Estético", phone: "+593969890689" }
        },
        tecnico: {
          greeting: "Buenos días, soy el Asistente Técnico de BIOSKIN. 😊 ¿Le interesa información sobre nuestros equipos médicos estéticos?",
          contact: { name: "Ing. Rafael Larrea", role: "Ingeniero de Equipos Médicos", phone: "+593969890689" }
        }
      },
      bot_instructions: {
        roleDetectionKeywords: {
          medico: ["tratamiento", "facial", "limpieza", "consulta", "cita", "piel", "acné", "manchas", "arrugas", "rejuvenecimiento"],
          tecnico: ["equipo", "aparato", "dispositivo", "máquina", "laser", "hifu", "tecnología", "compra", "precio equipo", "cotización"]
        },
        checkBeforePrice: true,
        alwaysMentionIfActive: true,
        suggestBestDeal: true,
        priority: 'promotion_first'
      }
    };
  }

  /**
   * Carga las promociones dinámicamente desde los adaptadores
   */
  loadPromotions() {
    try {
      const services = getAllServices();
      const products = getAllProducts();

      const servicePromotions = services
        .filter(s => s.promotion && s.promotion.active)
        .map(s => ({
          ...s.promotion,
          serviceId: s.id,
          serviceName: s.title,
          type: 'service',
          displayMessage: `🎉 *PROMOCIÓN EN ${s.title.toUpperCase()}*\n${s.promotion.description}\n💰 Precio Promo: $${s.promotion.promoPrice} (Ahorro: $${s.promotion.savings})\n📅 Válido hasta: ${s.promotion.validUntil}`
        }));

      const productPromotions = products
        .filter(p => p.promotion && p.promotion.active)
        .map(p => ({
          ...p.promotion,
          productId: p.name, // Usamos nombre como ID si no hay ID explícito
          productName: p.name,
          type: p.category === 'equipment' ? 'equipment' : 'product',
          displayMessage: `🎉 *OFERTA EN ${p.name.toUpperCase()}*\n${p.promotion.description}\n💰 Precio Promo: $${p.promotion.promoPrice}\n📅 Válido hasta: ${p.promotion.validUntil}`
        }));

      // Separar equipos de otros productos si es necesario, pero por ahora los agrupamos
      // Para mantener compatibilidad con la estructura anterior:
      const equipmentPromotions = productPromotions.filter(p => p.type === 'equipment');
      const cosmeticPromotions = productPromotions.filter(p => p.type === 'product');

      return {
        active: true,
        promotions: {
          services: servicePromotions,
          products: cosmeticPromotions,
          equipment: equipmentPromotions
        },
        ...this.botConfig
      };
    } catch (error) {
      console.error('❌ [Promotions] Error cargando promociones dinámicas:', error.message);
      return { 
        active: false, 
        promotions: { services: [], products: [], equipment: [] },
        ...this.botConfig
      };
    }
  }

  /**
   * Cuenta el número de promociones activas
   */
  countActivePromotions(promotions) {
    if (!promotions || !promotions.promotions) return 0;
    const services = promotions.promotions.services.length;
    const products = promotions.promotions.products.length;
    const equipment = promotions.promotions.equipment.length;
    return services + products + equipment;
  }

  /**
   * Detecta el rol del bot según el contexto de la conversación
   */
  detectRole(userMessage, conversationHistory = []) {
    const keywords = this.botConfig.bot_instructions.roleDetectionKeywords;

    // Combinar mensaje actual con últimos 3 mensajes del historial
    const recentMessages = conversationHistory.slice(-3).map(m => m.content).join(' ');
    const fullContext = (userMessage + ' ' + recentMessages).toLowerCase();

    // Contar coincidencias por rol
    const medicoMatches = keywords.medico.filter(kw => fullContext.includes(kw.toLowerCase())).length;
    const tecnicoMatches = keywords.tecnico.filter(kw => fullContext.includes(kw.toLowerCase())).length;

    console.log(`🔍 [Promotions] Detección de rol: médico=${medicoMatches}, técnico=${tecnicoMatches}`);

    // Si hay más coincidencias técnicas, es técnico; por defecto, médico
    return tecnicoMatches > medicoMatches ? 'tecnico' : 'medico';
  }

  /**
   * Obtiene el saludo según el rol detectado
   */
  getRoleGreeting(role) {
    const roleData = this.botConfig.roles[role];
    return roleData?.greeting || 'Hola, soy el Asistente Interno de BIOSKIN. 🏥 ¿En qué puedo ayudarte?';
  }

  /**
   * Obtiene información del contacto según el rol
   */
  getRoleContact(role) {
    const roleData = this.botConfig.roles[role];
    return roleData?.contact || {
      name: 'Dra. Daniela Creamer',
      role: 'Médico Estético',
      phone: '+593969890689'
    };
  }

  /**
   * Obtiene todas las promociones activas
   */
  getActivePromotions() {
    const data = this.loadPromotions();
    if (!data.active) return [];

    return [
      ...data.promotions.services,
      ...data.promotions.products,
      ...data.promotions.equipment
    ];
  }

  /**
   * Obtiene todas las promociones activas filtradas por rol
   */
  getActivePromotionsByRole(role) {
    const allPromotions = this.getActivePromotions();
    // Filtrar por tipo según el rol
    if (role === 'tecnico') {
      return allPromotions.filter(p => p.type === 'equipment');
    } else {
      return allPromotions.filter(p => p.type === 'service' || p.type === 'product');
    }
  }

  /**
   * Busca promociones para un servicio/producto específico
   */
  findPromotionByService(serviceName) {
    const activePromotions = this.getActivePromotions();
    const lowerServiceName = serviceName.toLowerCase();

    return activePromotions.find(promo => {
      const promoService = (promo.serviceName || promo.productName || '').toLowerCase();
      const promoName = (promo.name || '').toLowerCase();
      
      return promoService.includes(lowerServiceName) || 
             lowerServiceName.includes(promoService) ||
             promoName.includes(lowerServiceName);
    });
  }

  /**
   * Genera mensaje de promoción para el chatbot
   */
  getPromotionMessage(serviceName) {
    const promo = this.findPromotionByService(serviceName);
    if (!promo) return null;

    return {
      hasPromotion: true,
      message: promo.displayMessage,
      details: promo
    };
  }

  /**
   * Obtiene resumen de todas las promociones activas
   */
  getPromotionsSummary() {
    const activePromotions = this.getActivePromotions();
    
    if (activePromotions.length === 0) {
      return {
        hasPromotions: false,
        message: 'Por el momento no contamos con promociones activas.'
      };
    }

    const messages = activePromotions.map(promo => promo.displayMessage);
    
    return {
      hasPromotions: true,
      count: activePromotions.length,
      message: `🎉 PROMOCIONES ACTIVAS:\n\n${messages.join('\n\n')}`,
      promotions: activePromotions
    };
  }

  /**
   * Verifica si hay promociones para categoría específica
   */
  hasPromotionsInCategory(category) {
    const data = this.loadPromotions();
    if (!data.active) return false;
    const categoryPromotions = data.promotions[category] || [];
    return categoryPromotions.length > 0;
  }

  /**
   * Obtiene instrucciones del bot sobre cómo manejar promociones
   */
  getBotInstructions() {
    return this.botConfig.bot_instructions;
  }

  /**
   * Invalida el cache (no-op en esta versión dinámica, pero mantenido por compatibilidad)
   */
  clearCache() {
    console.log('🔄 [Promotions] Cache limpiado (no-op)');
  }
}

// Instancia singleton
export const promotionsService = new PromotionsService();
