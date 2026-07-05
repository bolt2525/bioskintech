/**
 * @file lib/modules/ia/index.js
 * @description Módulo de Inteligencia Artificial — diagnóstico, protocolos y asistente.
 *
 * ─── Servicios ───────────────────────────────────────────────────────────────
 *
 *  AI SERVICE (Google Gemini + OpenAI)
 *   - analyzeImage(base64, prompt)     — Análisis de imagen dermatológica
 *   - generateProtocol(equipment, indication) — Protocolo clínico con IA
 *   - generateResponse(context, query) — Asistente de respuestas (Gema)
 *
 *  CHATBOT MÉDICO
 *   - getMedicalResponse(...)   — Respuestas sobre tratamientos estéticos
 *
 *  CHATBOT TÉCNICO
 *   - getTechnicalResponse(...) — Soporte técnico de equipos BioskinTech
 *
 * ─── Variables de entorno ────────────────────────────────────────────────────
 *   OPENAI_API_KEY  — Nunca usar prefijo VITE_, solo server-side
 *   GEMINI_API_KEY  — Para análisis de imágenes con Google Gemini
 *
 * @see lib/ai-service.js                  — Servicio principal de IA
 * @see lib/chatbot-medical-ai-service.js  — IA médica
 * @see lib/chatbot-technical-ai-service.js — IA técnica
 */
export * from '../../ai-service.js';
