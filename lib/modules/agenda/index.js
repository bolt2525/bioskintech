/**
 * @file lib/modules/agenda/index.js
 * @description Módulo de Agenda — Google Calendar + gestión de citas.
 *
 * ─── Funcionalidades ─────────────────────────────────────────────────────────
 *  - getEvents(date)        — Eventos del calendario para una fecha
 *  - getDayEvents(date)     — Eventos detallados del día
 *  - blockSchedule(...)     — Bloquear un horario
 *  - getBlockedSchedules()  — Listar bloqueos activos
 *  - deleteBlockedSchedule(id) — Eliminar bloqueo
 *  - deleteEvent(eventId)   — Eliminar evento del calendario
 *
 * ─── Integración ─────────────────────────────────────────────────────────────
 * Google Calendar API via cuenta de servicio.
 * Variables de entorno: GOOGLE_CREDENTIALS_BASE64
 *
 * @see api/calendar.js                   — Handler HTTP
 * @see lib/google-calendar-service.js    — Lógica de negocio
 */
export { googleCalendarService } from '../../google-calendar-service.js';
