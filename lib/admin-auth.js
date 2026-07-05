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

/**
 * Verifica el token de la petición y devuelve el usuario autenticado.
 * Si el token es inválido, responde con 401 y retorna null.
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @param {import('@vercel/node').VercelResponse} res
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
      SELECT s.username, s.role, s.clinic_id, s.access_scope, s.clinic_user_id
      FROM admin_sessions s
      LEFT JOIN clinic_users cu ON cu.id = s.clinic_user_id
      WHERE s.session_token = ${token}
        AND s.is_active      = true
        AND s.expires_at     > NOW()
        AND (s.clinic_user_id IS NULL OR cu.is_active = true)
    `;

    if (!r.rows.length) {
      res.status(401).json({ success: false, error: 'Sesión inválida o expirada' });
      return null;
    }

    const s = r.rows[0];
    return {
      id:           s.clinic_user_id,
      username:     s.username,
      role:         s.role || 'clinic_admin',
      clinic_id:    s.clinic_id,
      access_scope: s.access_scope || 'all',
    };
  } catch {
    res.status(500).json({ success: false, error: 'Error al verificar sesión' });
    return null;
  }
}

/**
 * Verifica que el usuario tenga al menos uno de los roles indicados.
 * Si no, responde con 403.
 * @param {object} user - Resultado de requireAuth()
 * @param {import('@vercel/node').VercelResponse} res
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
