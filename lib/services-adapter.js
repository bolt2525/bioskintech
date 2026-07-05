/**
 * BIOSKIN - Adaptador de Servicios para Backend
 * 
 * Lee servicios desde la fuente centralizada src/data/services.ts
 * y los adapta para uso en el chatbot de WhatsApp
 * 
 * Reemplaza: lib/treatments-data.js
 * 
 * PATRÓN: Similar a products-adapter.js
 * - Lee desde src/data/services.ts (fuente web)
 * - Proporciona funciones para el chatbot
 * - Mantiene compatibilidad con código existente
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// LECTURA DE SERVICIOS DESDE FUENTE WEB
// ============================================================================

/**
 * Lee y parsea el archivo services.ts desde src/data/
 * @returns {Array} Array de servicios
 */
function loadServicesFromSource() {
  try {
    // Intentar primero desde services.ts (desarrollo)
    const servicesPath = path.join(process.cwd(), 'src', 'data', 'services.ts');
    
    if (fs.existsSync(servicesPath)) {
      const fileContent = fs.readFileSync(servicesPath, 'utf-8');
      
      // Extraer el array de servicios del archivo TypeScript
      const servicesMatch = fileContent.match(/export const services: Service\[\] = (\[[\s\S]*?\n\]);/);
      
      if (!servicesMatch) {
        console.error('❌ No se pudo extraer array de servicios desde services.ts');
        throw new Error('No se pudo parsear services.ts');
      }
      
      // Convertir TypeScript a JavaScript válido y parsear
      let servicesString = servicesMatch[1];
      
      // Evaluar en contexto seguro
      const services = eval(servicesString);
      
      console.log(`✅ Cargados ${services.length} servicios desde src/data/services.ts`);
      return services;
    }
    
    // Fallback: JSON para producción (Vercel)
    console.log('⚠️ services.ts no encontrado, usando data/services.json');
    const jsonPath = path.join(process.cwd(), 'data', 'services.json');
    const services = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    console.log(`✅ Cargados ${services.length} servicios desde data/services.json (producción)`);
    return services;
    
  } catch (error) {
    console.error('❌ Error al cargar servicios desde fuente:', error.message);
    return [];
  }
}

// Cargar servicios al inicializar el módulo
const ALL_SERVICES = loadServicesFromSource();

// ============================================================================
// FUNCIONES PÚBLICAS PARA EL CHATBOT
// ============================================================================

/**
 * Obtiene todos los servicios disponibles
 * @returns {Array} Array completo de servicios
 */
function getAllServices() {
  return ALL_SERVICES;
}

/**
 * Normaliza texto para búsqueda: elimina guiones, acentos, espacios extra
 */
function normalizeSearchText(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/-/g, '') // Eliminar guiones
    .replace(/\s+/g, ' ') // Espacios múltiples a uno solo
    .normalize('NFD') // Separar caracteres base de diacríticos
    .replace(/[\u0300-\u036f]/g, ''); // Eliminar diacríticos
}

/**
 * Busca un servicio por palabra clave flexible
 * @param {string} keyword - Palabra clave o frase de búsqueda
 * @returns {Object|null} Primer servicio encontrado o null
 */
function findServiceByKeyword(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return null;
  }
  
  const searchTerm = normalizeSearchText(keyword);
  
  return ALL_SERVICES.find(service => {
    // Normalizar keywords del servicio
    const normalizedKeywords = service.keywords.map(k => normalizeSearchText(k));
    const normalizedTitle = normalizeSearchText(service.title);
    const normalizedShortDesc = normalizeSearchText(service.shortDescription);
    const normalizedDesc = normalizeSearchText(service.description);
    
    return normalizedKeywords.some(k => k.includes(searchTerm) || searchTerm.includes(k)) ||
           normalizedTitle.includes(searchTerm) ||
           normalizedShortDesc.includes(searchTerm) ||
           normalizedDesc.includes(searchTerm);
  }) || null;
}

/**
 * Busca múltiples servicios que coincidan con un término
 * @param {string} searchTerm - Término de búsqueda
 * @returns {Array} Array de servicios que coinciden
 */
function searchServices(searchTerm) {
  if (!searchTerm || typeof searchTerm !== 'string') {
    return [];
  }
  
  const term = normalizeSearchText(searchTerm);
  
  return ALL_SERVICES.filter(service => {
    const normalizedKeywords = service.keywords.map(k => normalizeSearchText(k));
    const normalizedTitle = normalizeSearchText(service.title);
    const normalizedShortDesc = normalizeSearchText(service.shortDescription);
    const normalizedDesc = normalizeSearchText(service.description);
    
    return normalizedKeywords.some(k => k.includes(term) || term.includes(k)) ||
           normalizedTitle.includes(term) ||
           normalizedShortDesc.includes(term) ||
           normalizedDesc.includes(term);
  });
}

/**
 * Obtiene servicios por categoría
 * @param {string} category - Categoría a filtrar
 * @returns {Array} Servicios de la categoría
 */
function getServicesByCategory(category) {
  if (!category) return [];
  
  return ALL_SERVICES.filter(s => s.category === category);
}

/**
 * Obtiene solo los servicios populares
 * @returns {Array} Servicios marcados como populares
 */
function getPopularServices() {
  return ALL_SERVICES.filter(s => s.popular === true);
}

/**
 * Genera texto del catálogo completo para mostrar en el chat
 * @param {boolean} includePrices - Si true, incluye precios; si false, solo nombres
 * @returns {string} Texto formateado del catálogo
 */
function generateCatalogText(includePrices = true) {
  let text = '📋 *CATÁLOGO DE SERVICIOS BIOSKIN*\n\n';
  
  const categories = {
    evaluacion: '🔍 EVALUACIÓN',
    facial: '✨ TRATAMIENTOS FACIALES',
    laser: '⚡ TRATAMIENTOS LÁSER',
    corporal: '💪 TRATAMIENTOS CORPORALES',
    inyectable: '💉 TRATAMIENTOS INYECTABLES',
    avanzado: '🚀 TRATAMIENTOS AVANZADOS'
  };
  
  Object.entries(categories).forEach(([catKey, catName]) => {
    const categoryServices = ALL_SERVICES.filter(s => s.category === catKey);
    if (categoryServices.length > 0) {
      text += `*${catName}*\n`;
      categoryServices.forEach(service => {
        if (includePrices) {
          text += `• ${service.title} - ${service.price} (${service.duration})\n`;
        } else {
          text += `• ${service.title}\n`;
        }
      });
      text += '\n';
    }
  });
  
  if (includePrices) {
    text += '📱 *Para agendar, escribe el nombre del tratamiento que te interesa*';
  } else {
    text += '📱 *Para conocer precios y detalles, pregunta por el tratamiento específico*\n';
    text += 'ℹ️ *Nota: Todos los tratamientos incluyen diagnóstico facial y evaluación previa*';
  }
  
  return text;
}

/**
 * Genera un contexto detallado para la IA con toda la info técnica
 * @returns {string} Texto detallado para el prompt del sistema
 */
function generateDetailedCatalogContext() {
  let text = 'CATÁLOGO TÉCNICO DETALLADO:\n\n';
  
  ALL_SERVICES.forEach(s => {
    text += `ID: ${s.id}\n`;
    text += `NOMBRE: ${s.title}\n`;
    text += `PRECIO: ${s.price}\n`;
    text += `DURACIÓN: ${s.duration}\n`;
    text += `DESCRIPCIÓN: ${s.description}\n`;
    if (s.promotion && s.promotion.active) {
      text += `PROMOCIÓN: ${s.promotion.name} - ${s.promotion.description}\n`;
      text += `PRECIO PROMO: $${s.promotion.promoPrice} (Ahorro: $${s.promotion.savings})\n`;
      text += `VÁLIDO HASTA: ${s.promotion.validUntil}\n`;
    }
    if (s.preCare && s.preCare.length) text += `PRE-CUIDADOS: ${s.preCare.join(', ')}\n`;
    if (s.postCare && s.postCare.length) text += `POST-CUIDADOS: ${s.postCare.join(', ')}\n`;
    if (s.contraindications && s.contraindications.length) text += `CONTRAINDICACIONES: ${s.contraindications.join(', ')}\n`;
    text += '---\n';
  });
  
  return text;
}

/**
 * Formatea un servicio para mostrarlo en el chat
 * @param {Object} service - Objeto de servicio
 * @returns {string} Texto formateado para WhatsApp
 */
function formatServiceForChat(service) {
  if (!service) return '';
  
  let text = `✨ *${service.title}*\n\n`;
  text += `📝 ${service.description}\n\n`;
  
  if (service.promotion && service.promotion.active) {
    text += `💰 *PRECIO EN PROMOCIÓN*\n`;
    text += `~~Antes: ${service.price}~~\n`;
    text += `*Ahora: $${service.promotion.promoPrice}*\n`;
    text += `🎉 ${service.promotion.name}: ${service.promotion.description}\n`;
    text += `📅 Válido hasta: ${service.promotion.validUntil}\n`;
  } else {
    text += `💵 *Precio:* ${service.price}\n`;
  }

  text += `⏱️ *Duración:* ${service.duration}\n`;
  
  if (service.benefits && service.benefits.length > 0) {
    text += `\n✅ *Beneficios:*\n`;
    service.benefits.forEach(benefit => {
      text += `  • ${benefit}\n`;
    });
  }
  
  if (service.indications && service.indications.length > 0) {
    text += `\n🎯 *Indicaciones:*\n`;
    service.indications.forEach(indication => {
      text += `  • ${indication}\n`;
    });
  }
  
  text += `\nℹ️ *Este tratamiento incluye diagnóstico facial y evaluación previa para personalizar su atención.*`;
  text += `\n\n¿Desea agendar una cita para este tratamiento?`;
  
  return text;
}

/**
 * Obtiene información de un servicio por ID
 * @param {string} serviceId - ID del servicio
 * @returns {Object|null} Servicio encontrado o null
 */
function getServiceById(serviceId) {
  if (!serviceId) return null;
  
  return ALL_SERVICES.find(s => s.id === serviceId) || null;
}

/**
 * Detecta si el mensaje del usuario menciona algún servicio
 * @param {string} userMessage - Mensaje del usuario
 * @returns {Object|null} Primer servicio detectado o null
 */
function detectServiceInMessage(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return null;
  }
  
  const message = userMessage.toLowerCase();
  
  // Buscar por keywords primero (más específico)
  for (const service of ALL_SERVICES) {
    for (const keyword of service.keywords) {
      if (message.includes(keyword)) {
        return service;
      }
    }
  }
  
  // Buscar por título parcial
  for (const service of ALL_SERVICES) {
    const titleWords = service.title.toLowerCase().split(' ');
    if (titleWords.some(word => word.length > 3 && message.includes(word))) {
      return service;
    }
  }
  
  return null;
}

// ============================================================================
// CAPA DE COMPATIBILIDAD - Para código existente que usa TREATMENTS_CATALOG
// ============================================================================

const TREATMENTS_CATALOG = {
  evaluation: ALL_SERVICES.filter(s => s.category === 'evaluacion'),
  cleaning: ALL_SERVICES.filter(s => ['limpieza-facial', 'limpieza-crioradio'].includes(s.id)),
  regeneration: ALL_SERVICES.filter(s => ['microneedling', 'prp', 'bioestimuladores', 'exosomas'].includes(s.id)),
  laser: ALL_SERVICES.filter(s => s.category === 'laser'),
  advanced: ALL_SERVICES.filter(s => ['hifu', 'relleno-labios', 'antimanchas', 'lipopapada'].includes(s.id))
};

/**
 * Función de compatibilidad - Obtiene todos los tratamientos
 * @returns {Array} Todos los servicios
 */
function getAllTreatments() {
  return ALL_SERVICES;
}

// ============================================================================
// EXPORTS (ES Modules)
// ============================================================================

export {
  // Funciones principales
  getAllServices,
  findServiceByKeyword,
  searchServices,
  getServicesByCategory,
  getPopularServices,
  generateCatalogText,
  generateDetailedCatalogContext,
  formatServiceForChat,
  getServiceById,
  detectServiceInMessage,
  
  // Compatibilidad con código existente
  TREATMENTS_CATALOG,
  getAllTreatments,
  
  // Datos crudos (por si se necesitan)
  ALL_SERVICES as services
};

