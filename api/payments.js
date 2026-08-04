/**
 * @file api/payments.js
 * @description Integración con PayPhone para pagos de suscripciones BIOSKIN.
 *
 * Credenciales (env vars):
 *   PAYPHONE_APP_TOKEN        — App Token (Bearer para todas las llamadas API)
 *   PAYPHONE_CLIENT_ID        — ID Cliente de la aplicación
 *   PAYPHONE_SECRET_KEY       — Clave Secreta (verificación de identidad)
 *   PAYPHONE_ENCODING_PASSWORD — Contraseña de codificación (verificación webhook)
 *
 * Flujo:
 *  1. POST ?action=preparePayment   → crea transacción, devuelve paymentUrl
 *  2. Usuario paga en PayPhone
 *  3. POST ?action=webhook          → PayPhone notifica resultado (verificado con firma)
 *  4. POST ?action=confirmStatus    → frontend verifica estado después del pago
 */

import { sql } from '@vercel/postgres';
import crypto from 'crypto';

const PAYPHONE_BASE = 'https://pay.payphonetodoesposible.com/api';

// Planes de suscripción — mismos que admin-auth.js (ponytail: extraer a lib/plans.js si crece)
const PLANS = {
  plan_completo: { name: 'Plan Completo BIOSKIN',  amount_cents: 9900, description: 'Todos los módulos, pacientes ilimitados' },
  plan_clinica:  { name: 'Plan Clínica BIOSKIN',   amount_cents: 6900, description: 'Módulos principales' },
  plan_personal: { name: 'Plan Personal BIOSKIN',  amount_cents: 2900, description: 'Solo tus pacientes' },
};

// ─────────────────────────────────────────────────────────────────────────────
// CORS + headers
// ─────────────────────────────────────────────────────────────────────────────

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintech.vercel.app,http://localhost:5173').split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─────────────────────────────────────────────────────────────────────────────
// PayPhone helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCredentials() {
  const appToken = (process.env.PAYPHONE_APP_TOKEN || '').trim();
  if (!appToken || appToken === 'placeholder_configure_later')
    throw new Error('PAYPHONE_APP_TOKEN no configurado en Vercel');
  return {
    appToken,
    clientId:         (process.env.PAYPHONE_CLIENT_ID         || '').trim(),
    secretKey:        (process.env.PAYPHONE_SECRET_KEY        || '').trim(),
    encodingPassword: (process.env.PAYPHONE_ENCODING_PASSWORD || '').trim(),
  };
}

/**
 * Verifica la firma del webhook de PayPhone.
 * PayPhone firma el payload con la contraseña de codificación (HMAC-SHA256).
 * ponytail: si PayPhone cambia el mecanismo de firma, actualizar aquí.
 */
function verifyWebhookSignature(body, signature, encodingPassword) {
  if (!encodingPassword || !signature) return true; // sin config → pasar (dev mode)
  const expected = crypto
    .createHmac('sha256', encodingPassword)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Llama a la API de PayPhone */
async function payphoneRequest(path, body) {
  const { appToken } = getCredentials();
  const res = await fetch(`${PAYPHONE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${appToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `PayPhone error ${res.status}`);
  return data;
}

/** Consulta estado de una transacción */
async function payphoneGetTransaction(transactionId) {
  const { appToken } = getCredentials();
  const res = await fetch(`${PAYPHONE_BASE}/button/${transactionId}`, {
    headers: { 'Authorization': `Bearer ${appToken}` },
  });
  if (!res.ok) throw new Error(`PayPhone status error ${res.status}`);
  return await res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;

  try {
    // ── Preparar pago (inicio del flujo) ──────────────────────────────────
    if (action === 'preparePayment') {
      const { plan_key, email } = req.body || {};
      if (!plan_key || !PLANS[plan_key]) return res.status(400).json({ error: 'plan_key inválido. Opciones: ' + Object.keys(PLANS).join(', ') });
      if (!email?.trim()) return res.status(400).json({ error: 'email requerido' });

      const plan = PLANS[plan_key];
      const clientTxId = `bioskin-${plan_key}-${crypto.randomBytes(8).toString('hex')}`;
      const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).trim();
      const { clientId } = getCredentials();

      // IVA Ecuador = 15%
      const amountWithTax    = Math.round(plan.amount_cents * 0.15);
      const amountWithoutTax = plan.amount_cents - amountWithTax;

      const payphoneData = await payphoneRequest('/button/Prepare', {
        amount:              plan.amount_cents,
        amountWithTax,
        amountWithoutTax,
        tax:                 amountWithTax,
        service:             0,
        tip:                 0,
        currency:            'USD',
        reference:           plan.name,
        clientTransactionId: clientTxId,
        ...(clientId && { storeId: clientId }),
        responseUrl:         `${appUrl}/gestionestetica/admin/register?payment=confirm`,
        cancellationUrl:     `${appUrl}/gestionestetica/admin/register?payment=cancelled`,
        notifyUrl:           `${appUrl}/api/payments?action=webhook`,
        lang:                'es',
      });

      // Guardar suscripción pendiente
      const sub = await sql`
        INSERT INTO subscriptions
          (plan_name, amount_cents, currency, status, payphone_client_id, payphone_response)
        VALUES
          (${plan.name}, ${plan.amount_cents}, 'USD', 'pending', ${clientTxId}, ${JSON.stringify(payphoneData)})
        RETURNING id
      `;

      return res.status(200).json({
        success: true,
        subscription_id: sub.rows[0].id,
        clientTransactionId: clientTxId,
        paymentUrl: payphoneData.payWithCard || payphoneData.paymentUrl || payphoneData.url || null,
        payphoneResponse: payphoneData,
      });
    }

    // ── Webhook de PayPhone (notificación automática) ─────────────────────
    if (action === 'webhook') {
      const { clientTransactionId, transactionStatus, id: transId } = req.body || {};
      if (!clientTransactionId) return res.status(400).json({ error: 'clientTransactionId requerido' });

      // Verificar firma del webhook con la contraseña de codificación
      const signature = req.headers['x-signature'] || req.headers['x-payphone-signature'] || '';
      const { encodingPassword } = getCredentials();
      if (signature && encodingPassword && !verifyWebhookSignature(req.body, signature, encodingPassword)) {
        console.warn('⚠️  Webhook PayPhone: firma inválida — posible solicitud fraudulenta');
        return res.status(401).json({ error: 'Firma inválida' });
      }

      // Verificar estado real con la API (no confiar solo en el webhook)
      let confirmed = false;
      try {
        const txData = await payphoneGetTransaction(transId || clientTransactionId);
        confirmed = txData.transactionStatus === 3; // 3 = Aprobado en PayPhone
      } catch (e) {
        console.error('❌ Error verificando transacción PayPhone:', e.message);
      }

      const status = confirmed ? 'paid' : 'failed';
      await sql`
        UPDATE subscriptions SET
          status = ${status},
          payphone_transaction_id = ${transId || clientTransactionId},
          paid_at = ${confirmed ? new Date() : null},
          expires_at = ${confirmed ? new Date(Date.now() + 30 * 24 * 3600000) : null}
        WHERE payphone_client_id = ${clientTransactionId}
      `;

      console.log(`💳 PayPhone webhook: ${clientTransactionId} → ${status}`);
      return res.status(200).json({ received: true });
    }

    // ── Confirmar estado desde el frontend (después del redirect) ─────────
    if (action === 'confirmStatus') {
      const { clientTransactionId, subscription_id } = req.body || req.query || {};
      if (!clientTransactionId && !subscription_id)
        return res.status(400).json({ error: 'clientTransactionId o subscription_id requerido' });

      const q = subscription_id
        ? await sql`SELECT * FROM subscriptions WHERE id=${subscription_id}`
        : await sql`SELECT * FROM subscriptions WHERE payphone_client_id=${clientTransactionId}`;

      if (!q.rows.length) return res.status(404).json({ error: 'Suscripción no encontrada' });
      const sub = q.rows[0];

      // Si aún está pendiente, verificar con PayPhone directamente
      if (sub.status === 'pending' && sub.payphone_transaction_id) {
        try {
          const txData = await payphoneGetTransaction(sub.payphone_transaction_id);
          if (txData.transactionStatus === 3) {
            await sql`UPDATE subscriptions SET status='paid', paid_at=NOW(), expires_at=${new Date(Date.now() + 30 * 24 * 3600000)} WHERE id=${sub.id}`;
            sub.status = 'paid';
          }
        } catch { /* non-fatal — devolver estado actual */ }
      }

      return res.status(200).json({ success: true, status: sub.status, subscription_id: sub.id, plan_name: sub.plan_name });
    }

    // ── Listar planes (público) ────────────────────────────────────────────
    if (action === 'getPlans') {
      return res.status(200).json({ plans: PLANS });
    }

    return res.status(400).json({ error: 'Acción no válida' });

  } catch (err) {
    console.error('❌ Error en payments:', err.message);
    // No exponer detalles de error de PayPhone al cliente
    return res.status(500).json({ error: 'Error al procesar el pago. Intenta de nuevo.' });
  }
}
