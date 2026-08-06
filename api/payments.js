/**
 * @file api/payments.js
 * @description PayPhone Boton de Pago con redireccion al formulario de pago.
 *
 * Credenciales requeridas (Vercel env vars):
 *   PAYPHONE_APP_TOKEN  -- Bearer token de la aplicacion tipo "WEB" en PayPhone Developer
 *   PAYPHONE_STORE_ID   -- StoreId (UUID) del listado de tiendas en PayPhone Developer
 *
 * Flujo:
 *  1. POST ?action=preparePayment  -> llama /button/Prepare -> devuelve payWithCard URL
 *  2. Frontend redirige al usuario a payWithCard URL (nueva pestana)
 *  3. Usuario paga en el formulario hosted de PayPhone
 *  4. PayPhone redirige a responseUrl?payment=confirm&id=X&clientTransactionId=Y
 *  5. POST ?action=confirmPayment  -> llama /button/V2/Confirm -> verifica y registra el pago
 */

import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import axios from 'axios';

const PAYPHONE_BASE = 'https://pay.payphonetodoesposible.com/api';

const PLANS = {
  plan_lanzamiento: {
    name:          'Plan Lanzamiento BioskinTech',
    subtitle:      'Precio especial de lanzamiento',
    amount_cents:   24500,
    base_cents:     21304,
    tax_cents:       3196,
    period:         'anual',
    features:       ['calendar','block_schedule','appointment','clinical_records','finance','inventory','clinical_3d','system_status','backup'],
  },
};

function setCors(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintechapp.com,http://localhost:5173')
    .split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getToken() {
  const raw = (process.env.PAYPHONE_APP_TOKEN || '').trim();
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  if (!token) throw new Error('PAYPHONE_APP_TOKEN no configurado');
  return token;
}

function getStoreId() {
  const id = (process.env.PAYPHONE_STORE_ID || '').trim();
  if (!id) throw new Error('PAYPHONE_STORE_ID no configurado');
  return id;
}

async function ensureSubscriptionsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                      SERIAL PRIMARY KEY,
      plan_name               TEXT    NOT NULL,
      amount_cents            INTEGER NOT NULL,
      currency                TEXT    DEFAULT 'USD',
      status                  TEXT    DEFAULT 'pending',
      payphone_client_id      TEXT    UNIQUE,
      payphone_transaction_id TEXT,
      payphone_response       JSONB,
      email                   TEXT,
      paid_at                 TIMESTAMP,
      expires_at              TIMESTAMP,
      created_at              TIMESTAMP DEFAULT NOW()
    )
  `;
  // ponytail: migración idempotente para tablas ya existentes sin la columna
  await sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS email TEXT`;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;

  try {
    if (action === 'preparePayment') {
      const { plan_key = 'plan_lanzamiento', email } = req.body || {};
      if (!PLANS[plan_key]) return res.status(400).json({ error: 'plan_key invalido' });

      const plan       = PLANS[plan_key];
      // ponytail: clientTransactionId sin guiones -- rechazados por algunos parsers de PayPhone
      const clientTxId = `BSKT${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const appUrl     = (process.env.APP_URL || 'https://bioskintechapp.com').replace(/\/$/, '');

      let token, storeId;
      try { token = getToken(); storeId = getStoreId(); }
      catch (e) { return res.status(503).json({ error: e.message }); }

      const responseUrl     = `${appUrl}/gestionestetica/admin/register?payment=confirm`;
      const cancellationUrl = `${appUrl}/gestionestetica/admin/register?payment=cancelled`;

      // Payload con orden y campos idénticos al ejemplo PHP oficial de PayPhone
      const payload = {
        amount:              plan.amount_cents,   // 26450
        amountWithoutTax:    0,
        amountWithTax:       plan.base_cents,     // 23000
        tax:                 plan.tax_cents,      // 3450
        service:             0,
        tip:                 0,
        storeId,
        clientTransactionId: clientTxId,
        currency:            'USD',
        responseUrl,
        reference:           'BioskinTech',
      };

      const authHeader = `Bearer ${token}`;

      console.log('=== PAYPHONE REQUEST (axios) ===');
      console.log(`URL: POST ${PAYPHONE_BASE}/button/Prepare`);
      console.log(`Headers: Content-Type=application/json | Authorization=Bearer ${token.substring(0,10)}...[${token.length} chars]`);
      console.log(`Payload: ${JSON.stringify(payload)}`);
      console.log('================================');

      let ppData;
      try {
        const ppRes = await axios.post(`${PAYPHONE_BASE}/button/Prepare`, payload, {
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          timeout: 15000,
        });
        console.log(`=== PAYPHONE RESPONSE === status=${ppRes.status} data=${JSON.stringify(ppRes.data)}`);
        ppData = ppRes.data;
      } catch (e) {
        const status = e.response?.status || 0;
        const body   = typeof e.response?.data === 'string' ? e.response.data.substring(0, 400) : JSON.stringify(e.response?.data || e.message);
        console.error(`[PayPhone Prepare] error status=${status}: ${body}`);
        return res.status(502).json({ error: `PayPhone error ${status || e.message}. Intenta de nuevo.` });
      }
      const paymentUrl = ppData.payWithCard || ppData.payWithPayPhone || null;
      if (!paymentUrl) {
        console.error('[PayPhone Prepare] respuesta sin URL:', ppData);
        return res.status(502).json({ error: 'PayPhone no devolvio URL de pago' });
      }

      await ensureSubscriptionsTable();
      const sub = await sql`
        INSERT INTO subscriptions (plan_name, amount_cents, currency, status, payphone_client_id, email, payphone_response)
        VALUES (${plan.name}, ${plan.amount_cents}, 'USD', 'pending', ${clientTxId}, ${email?.trim().toLowerCase() || null}, ${JSON.stringify(ppData)})
        RETURNING id
      `;

      return res.status(200).json({
        success:             true,
        subscription_id:     sub.rows[0].id,
        clientTransactionId: clientTxId,
        paymentUrl,
      });
    }

    if (action === 'confirmPayment') {
      // id y clientTransactionId los adjunta PayPhone al responseUrl al redirigir
      const { id, clientTransactionId } = req.body || {};
      if (!id || !clientTransactionId)
        return res.status(400).json({ error: 'id y clientTransactionId requeridos' });

      let token;
      try { token = getToken(); }
      catch (e) { return res.status(503).json({ error: e.message }); }

      let txData;
      try {
        const confirmRes = await axios.post(`${PAYPHONE_BASE}/button/V2/Confirm`,
          { id: Number(id), clientTxId: clientTransactionId },
          { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, timeout: 15000 }
        );
        txData = confirmRes.data;
      } catch (e) {
        console.error(`[PayPhone Confirm] error: ${e.response?.status} ${JSON.stringify(e.response?.data || e.message)}`);
        return res.status(502).json({ error: 'Error al verificar el pago con PayPhone' });
      }
      console.log(`[PayPhone Confirm] clientTxId=${clientTransactionId} statusCode=${txData.statusCode}`);

      // statusCode 3 = Aprobado | 2 = Cancelado
      const approved = txData.statusCode === 3;

      await ensureSubscriptionsTable();
      if (approved) {
        await sql`
          UPDATE subscriptions SET
            status                  = 'paid',
            payphone_transaction_id = ${String(id)},
            paid_at                 = NOW(),
            expires_at              = NOW() + INTERVAL '1 year'
          WHERE payphone_client_id = ${clientTransactionId}
        `;
      } else {
        await sql`UPDATE subscriptions SET status = 'failed' WHERE payphone_client_id = ${clientTransactionId}`;
      }

      if (!approved) {
        return res.status(200).json({ success: false, status: 'cancelled', message: txData.message || 'Pago cancelado o rechazado' });
      }

      const sub = await sql`SELECT id, plan_name FROM subscriptions WHERE payphone_client_id = ${clientTransactionId}`;
      return res.status(200).json({
        success:         true,
        status:          'paid',
        subscription_id: sub.rows[0]?.id,
        plan_name:       sub.rows[0]?.plan_name,
      });
    }

    if (action === 'getPlans') {
      return res.status(200).json({ plans: PLANS });
    }

    return res.status(400).json({ error: 'Accion no valida' });

  } catch (err) {
    console.error('payments handler error:', err.message);
    return res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
}
