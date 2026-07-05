// lib/ai-service.js

import OpenAI from 'openai';

// Configurar OpenAI de forma perezosa (lazy) para evitar errores en tiempo de carga
let openaiInstance = null;

export function getOpenAIClient() {
  if (!openaiInstance) {
    // Si no hay API Key, no fallamos aquí, pero la instancia podría no funcionar para llamadas
    // El SDK de OpenAI lanza error si no hay key, así que lo manejamos
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn(' OPENAI_API_KEY no está definida. Las funciones de IA fallarán.');
      // Retornamos un objeto dummy o null, o dejamos que falle controladamente
      // Para mantener compatibilidad, instanciamos con un string vacío si es necesario, 
      // pero mejor es dejar que el caller maneje el error.
      // Sin embargo, para evitar crash en import, esto es suficiente.
    }
    
    try {
      openaiInstance = new OpenAI({
        apiKey: apiKey || 'dummy-key-to-prevent-crash', // Evita crash inicial
      });
    } catch (error) {
      console.error('Error inicializando OpenAI:', error);
    }
  }
  return openaiInstance;
}

// Función para validar configuración de OpenAI
export function validateAIConfiguration() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY no está configurada en las variables de entorno');
  }
  
  console.log('Configuración de OpenAI validada correctamente');
  return true;
}
