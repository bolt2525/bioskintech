import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { sql } from '@vercel/postgres';
import { requireAuth } from './admin-auth.js';
import { getPool } from './neon-clinical-db.js';
import { lockClinicWriters, requireClinicWritable } from './clinic-lifecycle.js';
import { withIdentityReadLock } from './identity-reservations.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const assetId = value => typeof value === 'string' && /^[0-9]{5,40}$/.test(value);
const channelFields = 'waba_id, phone_number_id, phone_number, status, connected_at, updated_at';

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, status: statusCode });
}

export async function withWhatsAppChannelLock(userId, operation, clinicId) {
  return withIdentityReadLock(() => withCurrentWhatsAppChannelLock(userId, operation, clinicId));
}

async function withCurrentWhatsAppChannelLock(userId, operation, clinicId) {
  const pool = getPool();
  if (!pool) throw fail(503, 'No se puede verificar la conexión de WhatsApp.');
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '15s'");
    if (clinicId) {
      await lockClinicWriters(client, [String(clinicId)]);
      await requireClinicWritable(client, String(clinicId));
    }
    const result = await client.query('SELECT pg_try_advisory_xact_lock(724813, $1) AS locked', [userId]);
    if (result.rows[0]?.locked !== true) throw fail(409, 'Hay una conexión de WhatsApp en curso. Espera a que termine y vuelve a intentarlo.');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
      throw fail(503, 'No se confirmó el estado de la conexión. Actualiza antes de reintentar.');
    }
    throw error;
  } finally { client.release(releaseError); }
}

export async function initWhatsAppChannels(query) {
  await query('ALTER TABLE clinic_users ADD COLUMN IF NOT EXISTS whatsapp_coexistence_enabled BOOLEAN NOT NULL DEFAULT false');
  await query(`CREATE TABLE IF NOT EXISTS user_whatsapp_channels (
    user_id INTEGER PRIMARY KEY REFERENCES clinic_users(id) ON DELETE CASCADE,
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    waba_id VARCHAR(40) NOT NULL,
    phone_number_id VARCHAR(40) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    token_encrypted TEXT,
    status VARCHAR(30) NOT NULL CHECK (status IN ('pending_validation','setup_failed','disconnected')),
    contacts_request_id TEXT,
    history_request_id TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_user_whatsapp_channels_active_number
    ON user_whatsapp_channels(phone_number_id) WHERE status <> 'disconnected'`);
  await query(`CREATE TABLE IF NOT EXISTS whatsapp_signup_attempts (
    user_id INTEGER PRIMARY KEY REFERENCES clinic_users(id) ON DELETE CASCADE,
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    session_hash CHAR(64) NOT NULL,
    state_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  // Credenciales administrativas: como clinic_oauth_tokens, nunca accesibles al rol clínico.
  for (const table of ['user_whatsapp_channels', 'whatsapp_signup_attempts']) {
    await query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await query(`REVOKE ALL ON ${table} FROM PUBLIC`);
    await query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bioskin_app') THEN
        REVOKE ALL ON ${table} FROM bioskin_app;
      END IF;
    END $$`);
  }
}

function settings() {
  const appId = (process.env.WHATSAPP_META_APP_ID || '').trim();
  const configId = (process.env.WHATSAPP_SIGNUP_CONFIG_ID || '').trim();
  const version = (process.env.WHATSAPP_GRAPH_VERSION || 'v26.0').trim();
  const enabled = process.env.WHATSAPP_COEXISTENCE_PILOT_ENABLED === 'true';
  const configured = assetId(appId) && assetId(configId) && /^v\d{2}\.0$/.test(version)
    && Boolean(process.env.WHATSAPP_APP_SECRET)
    && /^[a-f0-9]{64}$/i.test(process.env.WHATSAPP_CHANNEL_ENCRYPTION_KEY || '');
  return { enabled: enabled && configured, appId, configId, version };
}

function tokenKey() {
  const key = process.env.WHATSAPP_CHANNEL_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(key)) throw fail(503, 'Falta configurar el cifrado del canal.');
  return Buffer.from(key, 'hex');
}

export function encryptChannelToken(token, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(buffer => buffer.toString('base64url')).join('.');
}

export function decryptChannelToken(encrypted, context) {
  const [iv, tag, data] = encrypted.split('.').map(value => Buffer.from(value, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', tokenKey(), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}

async function graph(path, token, { method = 'GET', body, version = 'v26.0' } = {}) {
  let response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw fail(502, 'Meta no respondió a tiempo. Revisa la conexión antes de volver a vincular.');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw fail(502, 'Meta devolvió una respuesta no válida. Revisa la conexión con el proveedor.'); }
  if (!response.ok || payload.error) {
    console.error('WhatsApp coexistencia: petición Meta rechazada', {
      status: response.status, code: payload.error?.code, subcode: payload.error?.error_subcode,
    });
    throw fail(502, 'Meta rechazó la conexión. Revisa permisos, configuración y estado del negocio.');
  }
  return payload;
}

async function completeConnection(user, body, sessionToken, config, db) {
  if (typeof body.state !== 'string' || !/^[a-f0-9]{64}$/.test(body.state)
      || typeof body.code !== 'string' || !body.code || body.code.length > 4096
      || !assetId(body.wabaId) || (body.phoneNumberId !== undefined && !assetId(body.phoneNumberId))) {
    throw fail(400, 'Respuesta de conexión inválida.');
  }
  // El challenge se consume en autocommit: no revive si el canje externo falla y se revierte el alta.
  const attempt = await sql.query(`DELETE FROM whatsapp_signup_attempts
    WHERE user_id=$1 AND clinic_id=$2 AND session_hash=$3 AND state_hash=$4 AND expires_at>NOW()
    RETURNING user_id`, [user.id, user.clinic_id, hash(sessionToken), hash(body.state)]);
  if (!attempt.rows.length) throw fail(409, 'El intento expiró o ya fue utilizado. Prepara una nueva conexión.');
  const current = await db.query('SELECT status FROM user_whatsapp_channels WHERE user_id=$1 AND clinic_id=$2', [user.id, user.clinic_id]);
  if (current.rows.length && current.rows[0].status !== 'disconnected') {
    throw fail(409, 'Ya existe una conexión. Revisa su estado antes de volver a vincular.');
  }
  const exchanged = await graph('oauth/access_token', '', {
    method: 'POST', version: config.version,
    body: { client_id: config.appId, client_secret: process.env.WHATSAPP_APP_SECRET, code: body.code },
  });
  if (typeof exchanged.access_token !== 'string' || !exchanged.access_token) {
    throw fail(502, 'Meta no devolvió una credencial de negocio.');
  }
  const token = exchanged.access_token;
  const debug = await graph(`debug_token?input_token=${encodeURIComponent(token)}`,
    `${config.appId}|${process.env.WHATSAPP_APP_SECRET}`, { version: config.version });
  if (!debug.data?.is_valid || String(debug.data.app_id) !== config.appId
      || !['whatsapp_business_management', 'whatsapp_business_messaging'].every(scope => debug.data.scopes?.includes(scope))
      || (debug.data.expires_at && debug.data.expires_at * 1000 <= Date.now())) {
    throw fail(403, 'La autorización de Meta no corresponde a esta app o no tiene los permisos necesarios.');
  }
  const phones = await graph(`${body.wabaId}/phone_numbers?fields=id,display_phone_number,is_on_biz_app,platform_type`,
    token, { version: config.version });
  const candidates = (Array.isArray(phones.data) ? phones.data : []).filter(phone =>
    assetId(phone.id) && phone.is_on_biz_app === true && phone.platform_type === 'CLOUD_API'
    && (!body.phoneNumberId || phone.id === body.phoneNumberId));
  if (candidates.length !== 1) {
    throw fail(409, 'El piloto requiere un único número de WhatsApp Business en coexistencia en la cuenta seleccionada.');
  }
  const phone = candidates[0];
  if (phone.id === (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim()) {
    throw fail(409, 'El número del chatbot del sistema no puede vincularse como canal personal.');
  }
  const context = `${user.clinic_id}:${user.id}:${body.wabaId}:${phone.id}`;
  await db.query(`INSERT INTO user_whatsapp_channels
    (user_id,clinic_id,waba_id,phone_number_id,phone_number,token_encrypted,status)
    SELECT id,clinic_id,$3,$4,$5,$6,'setup_failed' FROM clinic_users
    WHERE id=$1 AND clinic_id=$2 AND is_active=true AND whatsapp_coexistence_enabled=true
    ON CONFLICT (user_id) DO UPDATE SET waba_id=EXCLUDED.waba_id,
      phone_number_id=EXCLUDED.phone_number_id,phone_number=EXCLUDED.phone_number,
      token_encrypted=EXCLUDED.token_encrypted,status='setup_failed',
      contacts_request_id=NULL,history_request_id=NULL,connected_at=NOW(),updated_at=NOW()
    WHERE user_whatsapp_channels.clinic_id=EXCLUDED.clinic_id
      AND user_whatsapp_channels.status='disconnected'
    RETURNING user_id`, [user.id, user.clinic_id, body.wabaId, phone.id,
    String(phone.display_phone_number || '').slice(0, 50), encryptChannelToken(token, context)])
    .then(result => { if (!result.rows.length) throw fail(409, 'La conexión cambió. Actualiza su estado.'); });
  // En coexistencia NO se llama /register. Estas solicitudes solo inician la sincronización.
  try {
    const subscription = await graph(`${body.wabaId}/subscribed_apps`, token, { method: 'POST', version: config.version });
    if (subscription.success !== true) throw fail(502, 'Meta no confirmó la suscripción a eventos.');
    // Never import pre-release conversations into a new signup.
    for (const [syncType, column] of [['smb_app_state_sync', 'contacts_request_id']]) {
      const sync = await graph(`${phone.id}/smb_app_data`, token, {
        method: 'POST', version: config.version, body: { messaging_product: 'whatsapp', sync_type: syncType },
      });
      if (typeof sync.request_id !== 'string' || !sync.request_id) throw fail(502, 'Meta no confirmó el inicio de sincronización.');
      await db.query(`UPDATE user_whatsapp_channels SET ${column}=$3,updated_at=NOW()
        WHERE user_id=$1 AND clinic_id=$2`, [user.id, user.clinic_id, sync.request_id]);
    }
  } catch (error) {
    // Persistir setup_failed e IDs recibidos antes de comunicar un fallo externo parcial.
    if (error.statusCode === 502) return error;
    throw error;
  }
  const updated = await db.query(`UPDATE user_whatsapp_channels SET status='pending_validation',updated_at=NOW()
    WHERE user_id=$1 AND clinic_id=$2 AND status='setup_failed' RETURNING user_id`, [user.id, user.clinic_id]);
  if (!updated.rows.length) throw fail(409, 'La conexión fue revocada durante la configuración.');
}

export async function handleWhatsAppChannelAction(req, res, readRawBody) {
  const user = await requireAuth(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!user.clinic_id || !Number.isSafeInteger(user.id) || user.role === 'master_admin'
      || req.headers['x-target-clinic-id'] || req.headers['x-target-user-id']) {
    return res.status(403).json({ success: false, error: 'Conecta únicamente desde tu propia cuenta de clínica.' });
  }
  const action = Array.isArray(req.query.action) ? req.query.action[0] : req.query.action;
  if (req.method !== (action === 'channelConfig' ? 'GET' : 'POST')) {
    res.setHeader('Allow', action === 'channelConfig' ? 'GET' : 'POST');
    return res.status(405).json({ success: false, error: 'Método no permitido.' });
  }
  try {
    const config = settings();
    const permission = await sql.query(`SELECT whatsapp_coexistence_enabled FROM clinic_users
      WHERE id=$1 AND clinic_id=$2 AND is_active=true`, [user.id, user.clinic_id]);
    const authorized = permission.rows[0]?.whatsapp_coexistence_enabled === true;
    config.enabled = config.enabled && authorized;
    // Siempre se permite eliminar la credencial propia aunque el piloto esté deshabilitado.
    if (!config.enabled && !['channelConfig', 'channelDisconnect'].includes(action)) throw fail(403, 'El piloto de coexistencia no está habilitado.');
    if (action === 'channelConfig') {
      const result = await sql.query(`SELECT ${channelFields} FROM user_whatsapp_channels WHERE user_id=$1 AND clinic_id=$2`,
        [user.id, user.clinic_id]);
      return res.status(200).json({ success: true, authorized, enabled: config.enabled, channel: result.rows[0] || null,
        message: config.enabled ? '' : 'Piloto desactivado o configuración de Meta pendiente. Contacta al proveedor del sistema.' });
    }
    const result = await withWhatsAppChannelLock(user.id, async db => {
      if (action === 'channelDisconnect') {
        await db.query(`UPDATE user_whatsapp_channels SET token_encrypted=NULL,status='disconnected',updated_at=NOW()
          WHERE user_id=$1 AND clinic_id=$2`, [user.id, user.clinic_id]);
        await db.query('DELETE FROM whatsapp_signup_attempts WHERE user_id=$1 AND clinic_id=$2', [user.id, user.clinic_id]);
        return { success: true };
      }
      const fresh = await db.query(`SELECT whatsapp_coexistence_enabled FROM clinic_users
        WHERE id=$1 AND clinic_id=$2 AND is_active=true`, [user.id, user.clinic_id]);
      if (fresh.rows[0]?.whatsapp_coexistence_enabled !== true) throw fail(403, 'El permiso de coexistencia fue deshabilitado.');
      const sessionToken = (req.headers.authorization || '').replace(/^Bearer /, '').trim();
      if (!sessionToken) throw fail(401, 'No autenticado.');
      if (action === 'channelStart') {
        const state = randomBytes(32).toString('hex');
        const result = await db.query(`INSERT INTO whatsapp_signup_attempts
          (user_id,clinic_id,session_hash,state_hash,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '10 minutes')
          ON CONFLICT(user_id) DO UPDATE SET clinic_id=EXCLUDED.clinic_id,session_hash=EXCLUDED.session_hash,
            state_hash=EXCLUDED.state_hash,created_at=NOW(),expires_at=EXCLUDED.expires_at
          WHERE whatsapp_signup_attempts.created_at<NOW()-INTERVAL '1 minute' RETURNING user_id`,
        [user.id, user.clinic_id, hash(sessionToken), hash(state)]);
        if (!result.rows.length) throw fail(429, 'Espera un minuto antes de preparar otro intento.');
        return { success: true, state, appId: config.appId, configId: config.configId, version: config.version };
      }
      const body = JSON.parse((await readRawBody(req)).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Solicitud inválida.');
      const error = await completeConnection(user, body, sessionToken, config, db);
      return error || { success: true };
    }, user.clinic_id);
    if (result instanceof Error) throw result;
    return res.status(200).json(result);
  } catch (error) {
    const status = error.statusCode || error.status || (error instanceof SyntaxError ? 400 : error.code === '23505' ? 409 : 500);
    console.error('WhatsApp coexistencia: operación fallida', { action, status, code: error.code });
    return res.status(status).json({ success: false, error: error.statusCode || error.status ? error.message
      : status === 409 ? 'Este número ya está vinculado a otro usuario.'
        : status === 400 ? 'Solicitud inválida.' : 'No se pudo completar la conexión de WhatsApp.' });
  }
}

export function systemWhatsAppWebhook(body, systemPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID) {
  return { ...body, entry: (body?.entry || []).map(entry => ({ ...entry,
    changes: (entry.changes || []).filter(change => systemPhoneId
      && change.value?.metadata?.phone_number_id === systemPhoneId && change.field === 'messages'),
  })).filter(entry => entry.changes.length) };
}

export async function processChannelLifecycle(body) {
  return withIdentityReadLock(() => processCurrentChannelLifecycle(body));
}

async function processCurrentChannelLifecycle(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'account_update' || change.value?.event !== 'PARTNER_REMOVED' || !assetId(entry.id)) continue;
      // Meta's signed event time must belong to the current connection. Missing
      // or stale events are not proof that a newly provisioned token is revoked.
      if (!Number.isSafeInteger(entry.time) || entry.time <= 0 || entry.time > Math.floor(Date.now() / 1000)) continue;
      await sql.query(`UPDATE user_whatsapp_channels SET status='disconnected',token_encrypted=NULL,updated_at=NOW()
        WHERE waba_id=$1 AND status<>'disconnected' AND connected_at<to_timestamp($2)`, [entry.id, entry.time]);
    }
  }
}
