/**
 * @file lib/admin-auth.js
 * @description Helper de autenticación para funciones serverless internas.
 * Verifica el token Bearer contra la base de datos de sesiones.
 *
 * USO en otras API functions:
 *   import { requireAuth } from '../lib/admin-auth.js';
 *   const user = await requireAuth(req, res); // retorna null y envía 401 si no autenticado
 */

import { sql } from '@vercel/postgres';
import { subscriptionLifecycle, subscriptionRequestAllowed, annualPurgeProtection } from './subscription-lifecycle.js';

/**
 * @typedef {import('node:http').IncomingMessage & {
 *   body?: { action?: string, sessionToken?: string } | null,
 *   query?: { action?: string | string[] },
 * }} AuthRequest
 * @typedef {import('node:http').ServerResponse & {
 *   status(code: number): AuthResponse,
 *   json(body: unknown): AuthResponse,
 * }} AuthResponse
 */

/**
 * Verifica el token de la petición y devuelve el usuario autenticado.
 * Si el token es inválido, responde con 401 y retorna null.
 *
 * @param {AuthRequest} req
 * @param {AuthResponse} res
 * @returns {Promise<{id: number, username: string, role: string, clinic_id: number|null}|null>}
 */
export async function requireAuth(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.body?.sessionToken;

  if (!token) {
    res.status(401).json({ success: false, error: 'No autenticado' });
    return null;
  }

  try {
    const r = await sql`
            SELECT s.username, s.role, s.clinic_id, s.access_scope, s.clinic_user_id,
              cu.finance_scope, cu.inventory_scope, cu.calendar_scope, cu.is_demo,cu.demo_expires_at,
              c.subscription_expires_at,c.is_active AS clinic_active,cs.general,
              EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id
                AND sub.status IN ('paid','registered') AND sub.paid_at IS NOT NULL AND sub.amount_cents>0
                AND coalesce(sub.plan_name,'') !~* '(trial|demo|prueba)') AS paid_subscription,
              EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id
                AND coalesce(sub.plan_name,'') ~* '(trial|demo|prueba)') AS trial_subscription
      FROM admin_sessions s
      LEFT JOIN clinic_users cu ON cu.id = s.clinic_user_id
      LEFT JOIN clinics c ON c.id = s.clinic_id
      LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id
      WHERE s.session_token = ${token}
        AND s.is_active      = true
        AND s.expires_at     > NOW()
        AND (s.clinic_user_id IS NULL OR cu.is_active = true)
        AND (s.clinic_id IS NULL OR c.is_active = true)
    `;

    if (!r.rows.length) {
      res.status(401).json({ success: false, error: 'Sesión inválida o expirada' });
      return null;
    }

    const s = r.rows[0];
    const policy = await sessionPolicy(s, req);
    if (!policy.allowed) {
      res.status(403).json({ success: false, error: 'Acceso limitado por la suscripción', subscription_lifecycle: policy.lifecycle });
      return null;
    }
    return {
      id:           s.clinic_user_id,
      username:     s.username,
      role:         s.role || 'clinic_admin',
      clinic_id:    s.clinic_id,
      access_scope: s.access_scope || 'all',
      finance_scope: s.finance_scope || 'all',
      inventory_scope: s.inventory_scope || 'all',
      calendar_scope: s.calendar_scope || 'own',
      subscription_lifecycle: policy.lifecycle,
    };
  } catch {
    res.status(500).json({ success: false, error: 'Error al verificar sesión' });
    return null;
  }
}

/**
 * Versión sin-efecto: verifica el token y devuelve el estado de autenticación.
 * No envía ninguna respuesta HTTP — el caller decide qué hacer.
 *
 * Cuando el usuario es master_admin y la petición incluye el header
 * `X-Target-Clinic-Id`, la función devuelve `effective_clinic_id` con ese valor
 * para que las queries de la API operen en el contexto de esa clínica.
 *
 * @param {AuthRequest} req
 * @returns {Promise<{valid: boolean, username?: string, role?: string, clinic_id?: string|null, effective_clinic_id?: string|null, finance_enabled?: boolean, clinical_records_enabled?: boolean, inventory_enabled?: boolean}>}
 */
export async function authenticateRequest(req) {
  const token = (req.headers?.authorization || '').replace('Bearer ', '').trim()
                || req.body?.sessionToken;
  if (!token) return { valid: false };

  try {
    const r = await sql`
            SELECT s.username, s.role, s.clinic_id, s.access_scope, s.clinic_user_id,
              cu.finance_scope, cu.inventory_scope, cu.calendar_scope,cu.is_demo,cu.demo_expires_at,
              c.subscription_expires_at,c.is_active AS clinic_active,cs.general,
              EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id
                AND sub.status IN ('paid','registered') AND sub.paid_at IS NOT NULL AND sub.amount_cents>0
                AND coalesce(sub.plan_name,'') !~* '(trial|demo|prueba)') AS paid_subscription,
              EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id
                AND coalesce(sub.plan_name,'') ~* '(trial|demo|prueba)') AS trial_subscription,
              COALESCE((
                SELECT enabled FROM clinic_features
                WHERE clinic_id = s.clinic_id AND feature = 'finance'
              ), true)
              AND NOT EXISTS (
                SELECT 1 FROM user_module_overrides
                WHERE clinic_user_id = s.clinic_user_id
                  AND feature IN ('finance', 'finanzas_visible')
                  AND enabled = false
              ) AS finance_enabled,
              COALESCE((
                SELECT enabled FROM clinic_features
                WHERE clinic_id = s.clinic_id AND feature = 'clinical_records'
              ), true)
              AND NOT EXISTS (
                SELECT 1 FROM user_module_overrides
                WHERE clinic_user_id = s.clinic_user_id
                  AND feature = 'clinical_records' AND enabled = false
              ) AS clinical_records_enabled,
              COALESCE((
                SELECT enabled FROM clinic_features
                WHERE clinic_id = s.clinic_id AND feature = 'inventory'
              ), true)
              AND NOT EXISTS (
                SELECT 1 FROM user_module_overrides
                WHERE clinic_user_id = s.clinic_user_id
                  AND feature = 'inventory' AND enabled = false
              ) AS inventory_enabled
      FROM admin_sessions s
      LEFT JOIN clinic_users cu ON cu.id = s.clinic_user_id
      LEFT JOIN clinics c ON c.id = s.clinic_id
      LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id
      WHERE s.session_token = ${token}
        AND s.is_active      = true
        AND s.expires_at     > NOW()
        AND (s.clinic_user_id IS NULL OR cu.is_active = true)
        AND (s.clinic_id IS NULL OR c.is_active = true)
    `;
    if (!r.rows.length) return { valid: false };
    const s = r.rows[0];
    const role = s.role || 'clinic_admin';
    let policy = await sessionPolicy(s, req);
    if (!policy.allowed) return { valid: false, subscriptionBlocked: true, subscription_lifecycle: policy.lifecycle };

    // Para master_admin: permite operar en nombre de otra clínica si se especifica
    let effective_clinic_id = s.clinic_id;
    if (role === 'master_admin') {
      const targetHeader = req.headers?.['x-target-clinic-id'];
      // A supplied but invalid target must not fall back to platform-wide scope.
      if (targetHeader !== undefined && (typeof targetHeader !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetHeader)))
        return { valid: false };
      if (targetHeader !== undefined) {
        const target = await sql`SELECT c.id,cs.general->'_purge' AS purge,c.subscription_expires_at,
          c.is_active AS clinic_active,cs.general,
          EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id AND sub.status IN ('paid','registered')
            AND sub.paid_at IS NOT NULL AND sub.amount_cents>0
            AND coalesce(sub.plan_name,'') !~* '(trial|demo|prueba)') AS paid_subscription,
          EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.clinic_id=c.id
            AND coalesce(sub.plan_name,'') ~* '(trial|demo|prueba)') AS trial_subscription
          FROM clinics c LEFT JOIN clinic_settings cs ON cs.clinic_id=c.id WHERE c.id=${targetHeader}`;
        if (!target.rows.length || target.rows[0].purge) return { valid: false };
        effective_clinic_id = targetHeader;
        // Master can administer the contract, not bypass operational closure
        // using a target header. Recovery reads use the clinic-admin policy.
        const lifecycle = subscriptionLifecycle({ ...target.rows[0], is_active: target.rows[0].clinic_active });
        policy = { lifecycle, allowed: subscriptionRequestAllowed(lifecycle, 'clinic_admin', req) };
        if (!policy.allowed) return { valid: false, subscriptionBlocked: true, subscription_lifecycle: lifecycle };
      }
    }

    return {
      valid:               true,
      id:                  s.clinic_user_id,
      username:            s.username,
      role,
      clinic_id:           s.clinic_id,
      effective_clinic_id, // clinic_id real para queries (puede diferir si master está viendo otra clínica)
      access_scope:        s.access_scope || 'all',
      finance_scope:       s.finance_scope || 'all',
      finance_enabled:     s.finance_enabled === true,
      clinical_records_enabled: s.clinical_records_enabled === true,
      inventory_enabled:   s.inventory_enabled === true,
      inventory_scope:     s.inventory_scope || 'all',
      calendar_scope:      s.calendar_scope || 'own',
      subscription_lifecycle: policy.lifecycle,
    };
  } catch {
    return { valid: false };
  }
}

export async function sessionPolicy(s, req, { login = false } = {}) {
  if (s.role === 'master_admin' || !s.clinic_id) return { allowed: true, lifecycle: null };
  const lifecycle = subscriptionLifecycle({ ...s, is_active: s.clinic_active });
  if (s.general?._purge || (s.is_demo && s.demo_expires_at && new Date(s.demo_expires_at).getTime() <= Date.now()))
    return { allowed: false, lifecycle };
  let delivery = false;
  const action = req.query?.action || req.body?.action;
  if (lifecycle.state === 'CLOSED' && s.role === 'clinic_admin' &&
      (login || ['verify', 'photoBackupStatus', 'photoBackupDownload'].includes(action))) {
    const protection = await annualPurgeProtection(sql, s.clinic_id, lifecycle.recovery_ends_at);
    delivery = protection.protected;
  }
  const verifying = String(req.url || '').split('?')[0] === '/api/admin-auth' && action === 'verify';
  const allowed = login || verifying
    ? (lifecycle.canlogin && (lifecycle.state !== 'RECOVERY' || s.role === 'clinic_admin')) || delivery
    : subscriptionRequestAllowed(lifecycle, s.role || 'clinic_admin', req, { delivery });
  return { allowed, lifecycle, delivery_only: delivery && lifecycle.state === 'CLOSED' };
}

/**
 * Verifica que el usuario tenga al menos uno de los roles indicados.
 * Si no, responde con 403.
 * @param {object} user - Resultado de requireAuth()
 * @param {AuthResponse} res
 * @param {...string} roles
 * @returns {boolean}
 */
export function requireRole(user, res, ...roles) {
  if (!user || !roles.includes(user.role)) {
    res.status(403).json({ success: false, error: 'Sin permiso para esta acción' });
    return false;
  }
  return true;
}
