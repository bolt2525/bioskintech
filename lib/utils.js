/**
 * @file lib/utils.js
 * @description Utilidades compartidas del servidor (funciones puras, sin dependencias).
 */

/**
 * Convierte un texto a formato slug URL-friendly.
 * Ejemplo: "Fichas Clínicas" → "fichas-clinicas"
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * Formatea una fecha a string legible en español.
 * @param {string|Date} date
 * @returns {string}
 */
export function formatDate(date) {
  return new Date(date).toLocaleDateString('es-EC', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * Extrae el token Bearer de un header Authorization.
 * @param {string} authHeader
 * @returns {string}
 */
export function extractBearerToken(authHeader) {
  return (authHeader || '').replace('Bearer ', '').trim();
}
