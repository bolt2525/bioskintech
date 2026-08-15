/**
 * @file lib/r2-service.js
 * @description Cliente Cloudflare R2 (compatible S3) para fotos clínicas.
 *
 * El bucket NO es público — toda lectura/escritura usa presigned URLs de corta duración.
 * Account ID: 9ea0b8c60134a90584195bf8954ad235
 *
 * Variables de entorno requeridas:
 *   R2_ACCESS_KEY_ID      — API Token con permiso R2:Edit
 *   R2_SECRET_ACCESS_KEY  — Secret del token
 *   R2_BUCKET_NAME        — Nombre del bucket (default: bioskin-fotos)
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ACCOUNT_ID  = '9ea0b8c60134a90584195bf8954ad235';
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'bioskin-fotos';

let _client = null;

function getR2Client() {
  if (_client) return _client;
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY no configuradas');
  }
  _client = new S3Client({
    region:   'auto',
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

/**
 * Genera URL pre-firmada para subida directa desde el cliente (PUT).
 * El frontend hace PUT a esta URL con el archivo — nunca pasa por el servidor.
 *
 * @param {string} r2Key   — clave S3 del objeto (ej: "clinics/{uuid}/photos/{uuid}.jpg")
 * @param {string} contentType — MIME type del archivo
 * @param {number} [expiresIn=300] — segundos de validez (máximo recomendado: 300)
 */
export async function generateUploadUrl(r2Key, contentType, expiresIn = 300) {
  const client = getR2Client();
  const cmd = new PutObjectCommand({
    Bucket:       BUCKET_NAME,
    Key:          r2Key,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });
  return getSignedUrl(client, cmd, { expiresIn });
}

/**
 * Genera URL pre-firmada para lectura (GET).
 * La URL expira — no es un enlace permanente.
 *
 * @param {string} r2Key
 * @param {number} [expiresIn=3600] — 1 hora por defecto
 */
export async function generateReadUrl(r2Key, expiresIn = 3600) {
  const client = getR2Client();
  const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: r2Key });
  return getSignedUrl(client, cmd, { expiresIn });
}

/**
 * Elimina un objeto del bucket.
 * @param {string} r2Key
 */
export async function deleteR2Object(r2Key) {
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: r2Key }));
}

/**
 * Sube un Buffer directamente a R2 (uso server-side).
 */
export async function putR2Object(r2Key, body, contentType) {
  const client = getR2Client();
  await client.send(new PutObjectCommand({
    Bucket:       BUCKET_NAME,
    Key:          r2Key,
    Body:         body,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}
