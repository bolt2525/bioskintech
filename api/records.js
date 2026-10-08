import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { sql } from '@vercel/postgres';
import { initClinicalDatabase, getPool, getAppPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';
import { generateUploadUrl, generateReadUrl, deleteR2Object, putR2Object } from '../lib/r2-service.js';
import { lockClinicWriters, unlockClinicWriters, requireClinicWritable } from '../lib/clinic-lifecycle.js';
import { buildFinanceCsv } from '../lib/finance-csv.js';
import { normalizeEcuadorIdentification, hashConsentEvidence, hashSigningCode, hashConsentSession, isValidSignatureDataUrl, maskEmail, buildConsentGmailRaw } from '../lib/consent-signing.js';

console.log('✅ [API] records.js loaded');

const SIGNING_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TREATMENT_WRITE_FIELDS = new Set([
  'consultation_id', 'date', 'procedure_name', 'equipment_used', 'parameters',
  'area_treated', 'area_marker', 'duration_minutes', 'cost', 'notes',
  'performed_by', 'treatment_mode', 'package_id',
]);
const SIGNING_SESSION_COOKIE = 'bioskin_consent_session';
const CONSULTATION_CHILD_TABLES = ['physical_exams', 'diagnoses', 'treatments', 'prescriptions', 'consent_forms', 'injectables'];
const CONSENT_SAFE_COLUMNS = `id, record_id, patient_id, clinic_id, consultation_id, status, created_at, updated_at,
  created_by, procedure_type, zone, sessions, objectives, description, risks, benefits, alternatives,
  pre_care, post_care, contraindications, critical_antecedents, authorizations, declarations, signatures,
  attachments, signing_status, signing_signed_at, signing_hash, signing_copy_sent_at,
  annulled_at, annulled_by_user_id, annulled_by_name, annulment_reason, replaces_consent_id`;

function normalizeMoney(value, field, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000 || (!allowZero && amount === 0)) {
    throw new Error(`${field} inválido`);
  }
  return Math.round(amount * 100) / 100;
}

function normalizeFinancePosting(value, amount) {
  if (!value?.enabled) return null;
  if (!UUID_PATTERN.test(String(value.idempotency_key || ''))) {
    throw new Error('Identificador de envío financiero inválido');
  }
  const total = normalizeMoney(amount, 'Monto financiero', { allowZero: false });
  const invoiceNumber = String(value.invoice_number || '').trim();
  if (invoiceNumber.length > 100) throw new Error('Número de factura demasiado largo');
  return {
    idempotencyKey: value.idempotency_key,
    includesIva: value.includes_iva === true,
    invoiceNumber: invoiceNumber || null,
    total,
  };
}

export function calculateTreatmentFinanceBreakdown(total, includesIva) {
  const normalizedTotal = normalizeMoney(total, 'Monto financiero', { allowZero: false });
  const totalCents = Math.round(normalizedTotal * 100);
  const subtotalCents = includesIva ? Math.round(totalCents / 1.15) : totalCents;
  return {
    subtotal: subtotalCents / 100,
    tax: (totalCents - subtotalCents) / 100,
    total: totalCents / 100,
    taxRate: includesIva ? 15 : 0,
  };
}

async function assertConsultationBelongsToRecord(db, consultationId, recordId, clinicId) {
  const result = await db.query(
    'SELECT 1 FROM consultations WHERE id = $1 AND record_id = $2 AND clinic_id = $3',
    [consultationId, recordId, clinicId]
  );
  if (result.rowCount === 0) throw new Error('La consulta no pertenece a este expediente');
}

export function canPostTreatmentFinance(sessionUser) {
  return sessionUser?.role === 'master_admin'
    || (sessionUser?.role === 'clinic_admin' && sessionUser.finance_enabled === true);
}

function assertTreatmentFinancePermission(sessionUser) {
  if (!['clinic_admin', 'master_admin'].includes(sessionUser?.role)) {
    const error = new Error('Solo administradores con acceso a Finanzas pueden registrar cobros');
    error.code = 'FINANCE_FORBIDDEN';
    throw error;
  }
  if (!canPostTreatmentFinance(sessionUser)) {
    const error = new Error('El módulo de Finanzas no está habilitado para este usuario');
    error.code = 'FINANCE_FORBIDDEN';
    throw error;
  }
}

async function findIdempotentTreatmentPosting(db, {
  clinicId, idempotencyKey, sourceType, recordId, consultationId, sourceId = null, posting = null,
}) {
  const result = await db.query(
    `SELECT id, source_type, source_id, source_record_id, source_consultation_id,
            total, tax_rate, invoice_number
     FROM financial_records
     WHERE clinic_id = $1 AND idempotency_key = $2`,
    [clinicId, idempotencyKey]
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const compatible = isCompatibleTreatmentPosting(row, {
    sourceType, recordId, consultationId, sourceId, posting,
  });
  if (!compatible) {
    const error = new Error('La clave de envío financiero ya pertenece a otra operación');
    error.code = 'IDEMPOTENCY_CONFLICT';
    throw error;
  }
  return row;
}

export function isCompatibleTreatmentPosting(row, {
  sourceType, recordId, consultationId, sourceId = null, posting = null,
}) {
  return row.source_type === sourceType
    && Number(row.source_record_id) === Number(recordId)
    && Number(row.source_consultation_id) === Number(consultationId)
    && (sourceId == null || Number(row.source_id) === Number(sourceId))
    && (!posting || (
      Number(row.total) === posting.total
      && Number(row.tax_rate) === (posting.includesIva ? 15 : 0)
      && (row.invoice_number || null) === posting.invoiceNumber
    ));
}

async function assertPackagePaymentWithinBalance(db, {
  packageId, recordId, consultationId, clinicId, treatmentMode, amount, excludeTreatmentId = null,
}) {
  const packageResult = await db.query(
    `SELECT id, name, total_cost, initial_payment
     FROM treatment_packages
     WHERE id = $1 AND record_id = $2 AND clinic_id = $3
       AND consultation_id = $4 AND treatment_mode = $5
     FOR UPDATE`,
    [packageId, recordId, clinicId, consultationId, treatmentMode]
  );
  if (packageResult.rowCount === 0) throw new Error('package_id inválido para esta consulta');
  const paidResult = await db.query(
    `SELECT COALESCE(SUM(cost), 0)::float AS paid
     FROM treatments
     WHERE package_id = $1 AND consultation_id = $2
       AND ($3::int IS NULL OR id <> $3)`,
    [packageId, consultationId, excludeTreatmentId]
  );
  const treatmentPackage = packageResult.rows[0];
  const remaining = Math.round((
    Number(treatmentPackage.total_cost)
    - Number(treatmentPackage.initial_payment)
    - Number(paidResult.rows[0]?.paid || 0)
  ) * 100) / 100;
  if (amount > remaining) {
    throw new Error(`El abono supera el saldo pendiente del paquete ($${Math.max(0, remaining).toFixed(2)})`);
  }
  return treatmentPackage;
}

async function createTreatmentFinancePosting(db, {
  posting, clinicId, sessionUser, sourceType, sourceId, packageId = null,
  recordId, consultationId, date, description,
}) {
  if (!posting) return null;

  const patientResult = await db.query(
    `SELECT CONCAT_WS(' ', p.first_name, p.last_name) AS patient_name
     FROM clinical_records cr
     JOIN patients p ON p.id = cr.patient_id
     WHERE cr.id = $1 AND cr.clinic_id = $2`,
    [recordId, clinicId]
  );
  if (patientResult.rowCount === 0) throw new Error('Expediente no autorizado');

  const { subtotal, tax, total, taxRate } = calculateTreatmentFinanceBreakdown(posting.total, posting.includesIva);
  const entity = patientResult.rows[0].patient_name || `Expediente ${recordId}`;

  const financeResult = await db.query(
    `INSERT INTO financial_records (
       date, invoice_number, entity, description, type, subtotal, tax, total,
       registered_by, clinic_id, created_by_user_id, tax_rate,
       source_module, source_type, source_id, source_package_id,
       source_record_id, source_consultation_id, idempotency_key
     ) VALUES (
       $1,$2,$3,$4,'ingreso',$5,$6,$7,$8,$9,$10,$11,
       'treatments',$12,$13,$14,$15,$16,$17
     ) RETURNING *`,
    [
      date, posting.invoiceNumber, entity, description, subtotal, tax, total,
      sessionUser?.username || 'tratamientos', clinicId, sessionUser?.user_id ?? null, taxRate,
      sourceType, sourceId, packageId, recordId, consultationId, posting.idempotencyKey,
    ]
  );
  const financeRecord = financeResult.rows[0];
  await db.query(
    `INSERT INTO financial_items (
       record_id, clinic_id, description, quantity, unit_price, iva_rate,
       subtotal, tax, total, sort_order
     ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,0)`,
    [financeRecord.id, clinicId, description, subtotal, taxRate, subtotal, tax, total]
  );
  return financeRecord;
}

function getSigningSessionCookie(req) {
  const prefix = `${SIGNING_SESSION_COOKIE}=`;
  const item = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  const value = item?.slice(prefix.length) || '';
  return /^[a-f0-9]{64}$/i.test(value) ? value : null;
}

function matchesSigningSession(req, storedHash) {
  const session = getSigningSessionCookie(req);
  if (!session || !process.env.ADMIN_SETUP_SECRET || !/^[a-f0-9]{64}$/i.test(String(storedHash || ''))) return false;
  const expected = Buffer.from(String(storedHash), 'hex');
  const actual = Buffer.from(hashConsentSession(session, process.env.ADMIN_SETUP_SECRET), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function setSigningSessionCookie(res, session, maxAge) {
  res.setHeader('Set-Cookie', `${SIGNING_SESSION_COOKIE}=${session}; Max-Age=${maxAge}; Path=/api/records; HttpOnly; Secure; SameSite=Strict`);
}

function createConsentSnapshot(consent, patient) {
  return {
    version: 1,
    captured_at: new Date().toISOString(),
    patient: {
      first_name: patient.first_name,
      last_name: patient.last_name,
      identification_type: patient.identification_type || null,
      identification_number: patient.identification_number || patient.rut || null,
      birth_date: patient.birth_date,
    },
    procedure_type: consent.procedure_type,
    zone: consent.zone,
    sessions: consent.sessions,
    objectives: consent.objectives,
    description: consent.description,
    risks: consent.risks,
    benefits: consent.benefits,
    alternatives: consent.alternatives,
    pre_care: consent.pre_care,
    post_care: consent.post_care,
    contraindications: consent.contraindications,
    critical_antecedents: consent.critical_antecedents,
    professional: {
      name: consent.signatures?.professional_name || null,
      signature_data: consent.signatures?.professional_sig_data || null,
    },
  };
}

export function hasProfessionalSignature(signatures) {
  return typeof signatures?.professional_name === 'string' && signatures.professional_name.trim().length > 0 &&
    isValidSignatureDataUrl(signatures.professional_sig_data);
}

function escapeConsentHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function consentValueText(value, label) {
  if (value == null || value === '') return 'No especificado';
  const choice = item => item === true ? 'Sí' : item === false ? 'No' : 'No especificado';
  if (Array.isArray(value)) return value.map(item => `• ${String(item)}`).join('\n');
  if (label === 'Antecedentes críticos' && typeof value === 'object') {
    return [
      `Alergias: ${value.allergies || 'Niega'}`,
      `Medicación: ${value.medications || 'Niega'}`,
      `Embarazo/lactancia: ${choice(value.pregnancy)}`,
      `Herpes recurrente: ${choice(value.herpes)}`,
      ...(Array.isArray(value.others) && value.others.length ? [`Otros: ${value.others.join(', ')}`] : []),
    ].join('\n');
  }
  if (label === 'Declaraciones aceptadas' || label === 'Autorizaciones') {
    const names = {
      understanding: 'Información clara recibida', questions: 'Dudas resueltas',
      results: 'Variabilidad de resultados comprendida', authorization: 'Tratamiento autorizado',
      revocation: 'Derecho de revocación informado', alternatives: 'Alternativas informadas',
      privacy_policy: 'Política de privacidad aceptada', image_use: 'Uso educativo/promocional de imágenes',
      photo_video: 'Fotografías/videos para registro clínico',
    };
    return Object.entries(value).map(([key, accepted]) => `${names[key] || key}: ${choice(accepted)}`).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) =>
      `${key.replace(/_/g, ' ')}: ${typeof item === 'boolean' ? choice(item) : Array.isArray(item) ? item.join(', ') : String(item ?? '')}`
    ).join('\n');
  }
  return String(value);
}

async function getConsentSenderName(clinicId, userId) {
  try {
    const [clinicResult, userResult] = await Promise.all([
      clinicId ? sql`SELECT general FROM clinic_settings WHERE clinic_id = ${clinicId}` : Promise.resolve({ rows: [] }),
      userId ? sql`SELECT full_name, gentilicio FROM clinic_users WHERE id = ${userId}` : Promise.resolve({ rows: [] }),
    ]);
    const clinicName = clinicResult.rows[0]?.general?.name || 'BIOSKIN';
    const professional = [userResult.rows[0]?.gentilicio, userResult.rows[0]?.full_name].filter(Boolean).join(' ');
    return [clinicName, professional].filter(Boolean).join(' · ');
  } catch {
    return 'BIOSKIN';
  }
}

async function resolveConsentSenderUserId(req, sessionUser, clinicId) {
  if (sessionUser?.role !== 'master_admin') return sessionUser?.user_id ?? null;
  const rawTargetUserId = req.headers['x-target-user-id'];
  const targetUserId = Number(rawTargetUserId);
  if (!clinicId || !Number.isSafeInteger(targetUserId) || targetUserId <= 0) return null;
  const result = await sql`SELECT id, clinic_id FROM clinic_users WHERE id = ${targetUserId} AND is_active = true`;
  const target = result.rows[0];
  return target && String(target.clinic_id) === String(clinicId) ? target.id : null;
}

async function sendConsentGmail({ oauth, fromName, to, subject, text, html, signatureDataUrl, professionalSignatureDataUrl }) {
  if (!oauth?.client || !oauth.email) return false;
  const signaturePngBase64 = signatureDataUrl?.startsWith('data:image/png;base64,')
    ? signatureDataUrl.slice('data:image/png;base64,'.length)
    : null;
  const raw = buildConsentGmailRaw({
    fromEmail: oauth.email,
    fromName,
    to,
    subject,
    text,
    html,
    signaturePngBase64,
    professionalSignaturePngBase64: professionalSignatureDataUrl?.startsWith('data:image/png;base64,')
      ? professionalSignatureDataUrl.slice('data:image/png;base64,'.length)
      : null,
  });
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return true;
}

async function sendConsentEmail({ oauth, fromName, to, subject, text, html, signatureDataUrl, professionalSignatureDataUrl }) {
  if (oauth?.client && oauth.email) {
    try {
      await sendConsentGmail({ oauth, fromName, to, subject, text, html, signatureDataUrl, professionalSignatureDataUrl });
      return { senderEmail: oauth.email, senderType: 'oauth' };
    } catch (error) {
      console.error('[consent-email] Gmail OAuth failed:', error?.code || error?.name || 'UnknownError');
    }
  }
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const attachments = [
      ...(signatureDataUrl?.startsWith('data:image/png;base64,') ? [{
      filename: 'firma-paciente.png',
      content: signatureDataUrl.slice('data:image/png;base64,'.length),
      encoding: 'base64',
      cid: 'patient-signature',
      }] : []),
      ...(professionalSignatureDataUrl?.startsWith('data:image/png;base64,') ? [{
        filename: 'firma-profesional.png',
        content: professionalSignatureDataUrl.slice('data:image/png;base64,'.length),
        encoding: 'base64',
        cid: 'professional-signature',
      }] : []),
    ];
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: `${fromName || 'BIOSKIN'} <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
      attachments,
    });
    return { senderEmail: process.env.EMAIL_USER, senderType: 'fallback' };
  }
  throw new Error('No hay un Gmail conectado disponible y el correo de respaldo no está configurado.');
}

function buildSignedConsentEmail(snapshot, signatures, declarations, authorizations, signedAt, evidenceHash) {
  const rows = [
    ['Paciente', `${snapshot.patient.first_name} ${snapshot.patient.last_name}`],
    [snapshot.patient.identification_type === 'ruc' ? 'RUC' : 'Cédula', snapshot.patient.identification_number],
    ['Profesional responsable', snapshot.professional?.name],
    ['Procedimiento', snapshot.procedure_type],
    ['Profesional responsable', snapshot.professional?.name],
    ['Zona', snapshot.zone],
    ['Sesiones', snapshot.sessions],
    ['Descripción', snapshot.description],
    ['Objetivos', snapshot.objectives],
    ['Riesgos', snapshot.risks],
    ['Beneficios', snapshot.benefits],
    ['Alternativas', snapshot.alternatives],
    ['Cuidados previos', snapshot.pre_care],
    ['Cuidados posteriores', snapshot.post_care],
    ['Contraindicaciones', snapshot.contraindications],
    ['Antecedentes críticos', snapshot.critical_antecedents],
    ['Declaraciones aceptadas', declarations],
    ['Autorizaciones', authorizations],
    ['Firmado en', signedAt],
    ['Huella SHA-256 del documento firmado', evidenceHash],
  ];
  const htmlRows = rows.map(([label, value]) =>
    `<tr><th style="text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ddd">${escapeConsentHtml(label)}</th><td style="padding:8px;border-bottom:1px solid #ddd;white-space:pre-wrap">${escapeConsentHtml(consentValueText(value, label))}</td></tr>`
  ).join('');
  const signature = String(signatures.patient_sig_data || '');
  const professionalSignature = String(snapshot.professional?.signature_data || '');
  const signatureImage = signature.startsWith('data:image/png;base64,')
    ? '<p><strong>Firma del paciente</strong></p><img alt="Firma del paciente" src="cid:patient-signature" style="max-width:320px;max-height:140px">'
    : '';
  const professionalSignatureImage = professionalSignature.startsWith('data:image/png;base64,')
    ? '<p><strong>Firma del profesional</strong></p><img alt="Firma del profesional" src="cid:professional-signature" style="max-width:320px;max-height:140px">'
    : '';
  return {
    html: `<main style="font-family:Arial,sans-serif;color:#222;max-width:760px;margin:auto"><h1>Consentimiento informado firmado</h1><table style="border-collapse:collapse;width:100%">${htmlRows}</table>${professionalSignatureImage}${signatureImage}<p style="font-size:12px;color:#555">Conserve este correo como copia del documento aceptado. La huella permite detectar cambios si se compara con el registro original.</p></main>`,
    text: rows.map(([label, value]) => `${label}: ${consentValueText(value, label)}`).join('\n\n'),
    signature,
    professionalSignature,
  };
}

// Global flag to track initialization in the current container instance
let dbInitialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper — reads session from admin_sessions via @vercel/postgres (neondb_owner)
// ─────────────────────────────────────────────────────────────────────────────

/** Builds the normalized session-user object from authenticateRequest result. */
function buildSu(auth) {
  if (!auth?.valid) return null;
  return {
    role:                auth.role,
    clinic_id:           auth.clinic_id,           // UUID string
    effective_clinic_id: auth.effective_clinic_id, // UUID string (may differ for master)
    user_id:             auth.id,
    access_scope:        auth.access_scope || 'all',
    finance_scope:       auth.finance_scope || 'all',
    finance_enabled:     auth.finance_enabled === true,
    clinical_records_enabled: auth.clinical_records_enabled === true,
    inventory_enabled:   auth.inventory_enabled === true,
    inventory_scope:     auth.inventory_scope || 'all',
    calendar_scope:      auth.calendar_scope || 'own',
    username:            auth.username,
  };
}

/**
 * Registra un evento de auditoría en patient_audit_log.
 * Silencioso si falla — la auditoría nunca debe interrumpir la operación principal.
 */
async function logAudit(client, { patientId, recordId, clinicId, sessionUser, actionType, module, summary, fieldChanges }) {
  try {
    await client.query(
      `INSERT INTO patient_audit_log (patient_id, record_id, clinic_id, clinic_user_id, user_display_name, action_type, module, summary, field_changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        patientId || null,
        recordId  || null,
        clinicId ?? sessionUser?.effective_clinic_id ?? sessionUser?.clinic_id ?? null,
        sessionUser?.user_id  || null,
        sessionUser?.username || 'Sistema',
        actionType,
        module,
        summary,
        fieldChanges ? JSON.stringify(fieldChanges) : null,
      ]
    );
  } catch { /* silencioso — auditoría no bloquea operaciones */ }
}

/** IDOR guard — returns false if item doesn't belong to the current clinic */
const CLINICAL_TABLES = new Set(['physical_exams', 'diagnoses', 'treatments', 'injectables', 'consent_forms', 'treatment_packages']);
const TREATMENT_MODES = new Set(['facial', 'corporal', 'capilar']);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_TYPES = new Set(['before', 'after', 'diagnostic', 'progress', 'general']);

async function recordBelongsToClinic(pool, recordId, clinicId) {
  if (!recordId || !clinicId) return false;
  const result = await pool.query(
    'SELECT 1 FROM clinical_records WHERE id = $1 AND clinic_id = $2 LIMIT 1',
    [recordId, clinicId]
  );
  return result.rows.length > 0;
}

async function canAccessPatient(pool, sessionUser, patientId) {
  if (!patientId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM patients p
     WHERE p.id = $1 AND ($2::uuid IS NULL OR p.clinic_id = $2)
       AND ($3::boolean = false OR p.created_by_user_id = $4 OR EXISTS (
         SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id AND pa.clinic_user_id = $4
       )) LIMIT 1`,
    [patientId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.access_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

export async function canAccessRecord(pool, sessionUser, recordId) {
  if (!recordId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM clinical_records cr
     WHERE cr.id = $1 AND ($2::uuid IS NULL OR cr.clinic_id = $2)
       AND ($3::boolean = false OR cr.created_by_user_id = $4 OR EXISTS (
         SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = cr.patient_id AND pa.clinic_user_id = $4
       )) LIMIT 1`,
    [recordId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.access_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

async function canAccessFinanceRecord(pool, sessionUser, recordId) {
  if (!recordId || !sessionUser) return false;
  const clinicId = sessionUser.effective_clinic_id ?? sessionUser.clinic_id;
  const result = await pool.query(
    `SELECT 1 FROM financial_records fr
     WHERE fr.id = $1 AND ($2::uuid IS NULL OR fr.clinic_id = $2)
       AND ($3::boolean = false OR fr.created_by_user_id = $4 OR fr.created_by_user_id IN (
         SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
         JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
         WHERE sgm1.clinic_user_id = $4
       )) LIMIT 1`,
    [recordId, clinicId, sessionUser.role !== 'master_admin' && sessionUser.finance_scope === 'own', sessionUser.user_id]
  );
  return result.rows.length > 0;
}

function inventoryOwnerClause(alias, parameterIndex) {
  return `(
    ${alias}.created_by_user_id = $${parameterIndex}
    OR ${alias}.created_by_user_id IS NULL
    OR ${alias}.created_by_user_id IN (
      SELECT sgm2.clinic_user_id
      FROM sharing_group_members sgm1
      JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
      WHERE sgm1.clinic_user_id = $${parameterIndex}
    )
  )`;
}

export function isOwnedPhotoKey(key, clinicId, recordId) {
  const prefix = `clinics/${clinicId}/records/${recordId}/photos/`;
  return typeof key === 'string' && key.startsWith(prefix) &&
    /^[a-f0-9-]{36}\.(?:jpg|jpeg|png|webp|heic)$/i.test(key.slice(prefix.length));
}

export async function detachConsultationChildren(pool, consultationId) {
  let detachedRows = 0;
  for (const table of CONSULTATION_CHILD_TABLES) {
    const result = await pool.query(`UPDATE ${table} SET consultation_id = NULL WHERE consultation_id = $1`, [consultationId]);
    detachedRows += result.rowCount || 0;
  }
  return detachedRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Envío de reportes financieros (CSV por correo)
// ─────────────────────────────────────────────────────────────────────────────

/** OAuth2 client de Gmail con los tokens guardados para un usuario. */
async function getUserGmailClient(userId) {
  if (!userId) return null;
  const clientId     = (process.env.GOOGLE_CLIENT_ID     || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'bioskintech.vercel.app'}`).replace(/\/$/, '').trim();
  const r = await sql`SELECT access_token, refresh_token, token_expiry, email FROM clinic_oauth_tokens WHERE clinic_user_id = ${userId}`;
  if (!r.rows.length) return null;
  const { access_token, refresh_token, token_expiry, email } = r.rows[0];
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, `${appUrl}/api/calendar`);
  oAuth2.setCredentials({ access_token, refresh_token, expiry_date: token_expiry ? new Date(token_expiry).getTime() : null });
  oAuth2.on('tokens', async tokens => {
    if (!tokens.access_token) return;
    await sql`UPDATE clinic_oauth_tokens SET access_token = ${tokens.access_token},
      token_expiry = ${tokens.expiry_date ? new Date(tokens.expiry_date) : null}, updated_at = NOW()
      WHERE clinic_user_id = ${userId}`;
  });
  return { client: oAuth2, email };
}

/** Arma un mensaje MIME multipart (HTML + adjunto CSV) codificado para la Gmail API. */
function buildRawEmailWithCsvAttachment({ from, to, subject, html, attachmentName, attachmentContent }) {
  const boundary = `bioskin_${crypto.randomBytes(8).toString('hex')}`;
  const attachmentB64 = Buffer.from(attachmentContent, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${boundary}`,
    `Content-Type: text/csv; name="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    '',
    attachmentB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

/** Genera el CSV del rango pedido y lo envía por Gmail al correo de administración financiera configurado. */
async function sendFinanceCsvToAdmin({ pool, clinicId, userId, financeScope = 'all', startDate, endDate, periodLabel }) {
  const settingsRes = await sql`SELECT finanzas, general FROM clinic_settings WHERE clinic_id = ${clinicId}`;
  const finanzas   = settingsRes.rows[0]?.finanzas || {};
  const clinicName = settingsRes.rows[0]?.general?.name || 'la clínica';
  const adminEmail = (finanzas.admin_email || '').trim();
  if (!adminEmail) throw new Error('No hay correo de administrador financiero configurado');

  const oauth = await getUserGmailClient(userId);
  if (!oauth) throw new Error('El usuario no tiene una cuenta Gmail conectada');

  const recordsRes = financeScope === 'own'
    ? await pool.query(
      `SELECT * FROM financial_records WHERE clinic_id = $1 AND date >= $2 AND date <= $3
       AND (created_by_user_id = $4 OR created_by_user_id IN (
         SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
         JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
         WHERE sgm1.clinic_user_id = $4
       )) ORDER BY date ASC`,
      [clinicId, startDate, endDate, userId]
    )
    : await pool.query(
      'SELECT * FROM financial_records WHERE clinic_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
      [clinicId, startDate, endDate]
    );
  const csv = buildFinanceCsv(recordsRes.rows);
  const gmail = google.gmail({ version: 'v1', auth: oauth.client });
  const raw = buildRawEmailWithCsvAttachment({
    from: `${clinicName} <${oauth.email}>`,
    to: adminEmail,
    subject: `Reporte financiero (${periodLabel}) — ${clinicName}`,
    html: `<p>Adjunto el reporte financiero de <strong>${clinicName}</strong> (${periodLabel}, ${startDate} a ${endDate}).</p><p>Registros incluidos: ${recordsRes.rows.length}</p>`,
    attachmentName: `finanzas_${startDate}_${endDate}.csv`,
    attachmentContent: csv,
  });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { recordCount: recordsRes.rows.length, adminEmail };
}

/** Decide si hoy corresponde enviar el reporte programado y qué rango de fechas cubre. Retorna null si no toca hoy. */
export function resolveScheduledRange(schedule, weekday, monthDay, today = new Date()) {
  const fmt = (d) => d.toISOString().split('T')[0];
  if (schedule === 'daily') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    return { startDate: fmt(y), endDate: fmt(y), periodLabel: 'diario' };
  }
  if (schedule === 'weekly') {
    if (Number(weekday) !== today.getDay()) return null;
    const start = new Date(today); start.setDate(start.getDate() - 7);
    const end = new Date(today); end.setDate(end.getDate() - 1);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'semanal' };
  }
  if (schedule === 'monthly') {
    if (Number(monthDay) !== today.getDate()) return null;
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end   = new Date(today.getFullYear(), today.getMonth(), 0);
    return { startDate: fmt(start), endDate: fmt(end), periodLabel: 'mensual' };
  }
  return null;
}

/** Recorre las clínicas con envío programado activo y despacha el CSV correspondiente a cada una. */
async function sendScheduledFinanceCsvs() {
  const appPool = getAppPool();
  if (!appPool) return { clinicsChecked: 0, sent: 0, errors: ['NEON_APP_URL no configurada'] };

  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }));
  const clinics = await sql`
    SELECT DISTINCT ON (cs.clinic_id) cs.clinic_id, cs.finanzas, t.clinic_user_id, cu.finance_scope
    FROM clinic_settings cs
    JOIN clinic_oauth_tokens t ON t.clinic_id = cs.clinic_id AND t.clinic_user_id IS NOT NULL
    JOIN clinic_users cu ON cu.id = t.clinic_user_id AND cu.is_active = true
    LEFT JOIN clinic_features cf ON cf.clinic_id = cs.clinic_id AND cf.feature = 'finance'
    LEFT JOIN user_module_overrides umo ON umo.clinic_user_id = cu.id AND umo.feature = 'finance'
    WHERE cs.finanzas->>'csv_schedule' IN ('daily','weekly','monthly')
      AND COALESCE(cs.finanzas->>'admin_email','') != ''
      AND COALESCE(cf.enabled, true) = true
      AND COALESCE(umo.enabled, true) = true
    ORDER BY cs.clinic_id, (cu.role = 'clinic_admin') DESC, cu.id
  `;

  let sent = 0;
  const errors = [];
  for (const row of clinics.rows) {
    const f = row.finanzas || {};
    const range = resolveScheduledRange(f.csv_schedule, f.csv_weekday, f.csv_month_day, today);
    if (!range) continue;
    const client = await appPool.connect();
    try {
      await requireClinicWritable(getPool(), row.clinic_id);
      await client.query("SELECT set_config('app.current_tenant', $1, false)", [String(row.clinic_id)]);
      const tenantPool = { query: (...a) => client.query(...a) };
      await sendFinanceCsvToAdmin({ pool: tenantPool, clinicId: row.clinic_id, userId: row.clinic_user_id, financeScope: row.finance_scope, ...range });
      sent++;
    } catch (err) {
      errors.push(`clinic ${row.clinic_id}: ${err.message}`);
    } finally {
      try { await client.query("SELECT set_config('app.current_tenant', '', false)"); } catch { /* ignore */ }
      client.release();
    }
  }
  return { clinicsChecked: clinics.rows.length, sent, errors };
}

async function ownedByClinic(pool, table, itemId, clinicId) {
  if (!clinicId || !CLINICAL_TABLES.has(table)) return true;
  const r = await pool.query(
    `SELECT p.clinic_id FROM ${table} t
     JOIN clinical_records cr ON cr.id = t.record_id
     JOIN patients p ON p.id = cr.patient_id
     WHERE t.id = $1`,
    [itemId]
  );
  return r.rows.length > 0 && String(r.rows[0].clinic_id) === String(clinicId);
}

export async function resolveInventoryGroup(value, category, clinicId, sessionUser, pool) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Grupo inválido');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (name.length > 100) throw new RangeError('Grupo demasiado largo');
  if (!sessionUser || !clinicId) throw new TypeError('Selecciona una clínica para registrar el grupo');
  if (category != null && typeof category !== 'string') throw new TypeError('Categoría inválida');
  const cleanCategory = (category || '').trim();
  if (cleanCategory.length > 100) throw new RangeError('Categoría demasiado larga');
  const nameKey = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const saved = await pool.query(`
    INSERT INTO inventory_groups (clinic_id, category, name, name_key)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (clinic_id, category, name_key)
    DO UPDATE SET name = inventory_groups.name
    RETURNING name
  `, [clinicId, cleanCategory, name, nameKey]);
  return saved.rows[0].name;
}

export function validateInventoryBatchInput(quantity, costPerUnit) {
  const units = Number(quantity);
  if (!Number.isFinite(units) || units <= 0 || units > 999999999.99 || Math.round(units * 100) / 100 !== units)
    throw new RangeError('La cantidad debe ser positiva y tener hasta dos decimales.');
  if (costPerUnit == null || (typeof costPerUnit === 'string' && !costPerUnit.trim())) return { units, cost: null };
  const cost = Number(costPerUnit);
  if (!Number.isFinite(cost) || cost < 0 || cost > 99999999 || Math.round(cost * 10000) / 10000 !== cost)
    throw new RangeError('El costo unitario debe ser positivo o cero y tener hasta cuatro decimales.');
  return { units, cost };
}

export function validateReferenceCostChange(updateReferenceCost, cost, expectedCost) {
  if (updateReferenceCost !== true && updateReferenceCost !== false && updateReferenceCost != null)
    throw new RangeError('Decisión sobre costo de referencia inválida.');
  if (updateReferenceCost !== true) return null;
  if (cost == null) throw new RangeError('Indica el costo de este lote para actualizar la referencia.');
  normalizeInventoryPrice(cost);
  return normalizeInventoryPrice(expectedCost);
}

export function updateInventoryReferenceCost(pool, { cost, itemId, clinicId, expectedCost }) {
  return pool.query(`UPDATE inventory_items SET cost_price = $1, updated_at = NOW()
    WHERE id = $2 AND clinic_id = $3 AND cost_price IS NOT DISTINCT FROM $4 RETURNING id`,
    [cost, itemId, clinicId, expectedCost]);
}

export function buildInventoryArchiveUpdate({ itemId, clinicId, userId, inventoryScope, archive, reason }) {
  if (!Number.isSafeInteger(Number(itemId)) || Number(itemId) <= 0 || !clinicId ||
      typeof archive !== 'boolean' || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0)
    throw new TypeError('Producto o clínica inválidos.');
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (archive && (cleanReason.length < 8 || cleanReason.length > 300))
    throw new RangeError('El motivo de archivo debe tener entre 8 y 300 caracteres.');
  const params = [archive, Number(itemId), clinicId, Number(userId), archive ? cleanReason : null, !archive];
  let owner = '';
  if (inventoryScope === 'own') {
    owner = ` AND ${inventoryOwnerClause('inventory_items', 7)}`;
    params.push(Number(userId));
  }
  return {
    query: `UPDATE inventory_items SET
      is_archived = $1,
      archived_at = CASE WHEN $1 THEN NOW() ELSE archived_at END,
      archived_by_user_id = CASE WHEN $1 THEN $4 ELSE archived_by_user_id END,
      archive_reason = CASE WHEN $1 THEN $5 ELSE archive_reason END,
      restored_at = CASE WHEN $1 THEN restored_at ELSE NOW() END,
      restored_by_user_id = CASE WHEN $1 THEN restored_by_user_id ELSE $4 END,
      updated_at = NOW()
      WHERE id = $2 AND clinic_id = $3 AND is_archived = $6${owner}
      RETURNING id, is_archived, archived_at, archive_reason`,
    params,
  };
}

export function validateInventoryListStatus(status, role) {
  const value = status || 'active';
  if (!['active', 'archived'].includes(value)) throw new RangeError('Estado de producto inválido.');
  if (value === 'archived' && !['clinic_admin', 'master_admin'].includes(role))
    throw new TypeError('Solo administradores pueden consultar productos archivados.');
  return value;
}

export function getInventoryPermanentDeleteConflict({ isArchived, hasMovementHistory, hasRemainingStock }) {
  if (!isArchived) return 'Archiva el producto antes de eliminarlo definitivamente.';
  if (hasMovementHistory || hasRemainingStock)
    return 'Este producto conserva saldo o historial de movimientos. Manténlo archivado para preservar la trazabilidad.';
  return null;
}

export function normalizeInventoryPrice(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 9999999999.99 || Math.round(amount * 100) / 100 !== amount)
    throw new RangeError('Costo o precio inválido: usa un valor positivo con hasta dos decimales.');
  return amount;
}

export function normalizeInventoryCategory(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    throw new TypeError('Selecciona una categoría válida.');
  return value.trim().replace(/\s+/g, ' ');
}

export function validateInventorySalePrice(reason, price, quantity) {
  if (!['Venta directa', 'Venta con descuento'].includes(reason)) return null;
  const unitPrice = normalizeInventoryPrice(price);
  if (unitPrice == null || unitPrice <= 0 || unitPrice * quantity > 999999999999.99)
    throw new RangeError('Indica un precio unitario de venta válido para esta salida.');
  return unitPrice;
}

export const INVENTORY_OUTFLOW_REASONS = new Set([
  'Venta directa', 'Venta con descuento', 'Muestra gratis', 'Uso en cabina',
  'Mermas / Dano', 'Vencimiento', 'Ajuste de inventario'
]);

export function buildInventorySalesFilter({ clinicId, startDate, endDate, ownerId, userId, category, search }) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!clinicId || !validDate(startDate) || !validDate(endDate) ||
      Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`) > 366 * 86400000 || startDate > endDate) {
    throw new RangeError('Elige un rango de fechas válido de hasta 366 días.');
  }
  const params = [clinicId, startDate, endDate];
  let where = `m.clinic_id = $1 AND i.clinic_id = $1 AND m.sale_total IS NOT NULL
    AND m.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'UTC'
    AND m.created_at < (($3::date + INTERVAL '1 day') AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'UTC'`;
  if (ownerId) {
    where += ` AND ${inventoryOwnerClause('i', params.length + 1)}`;
    params.push(ownerId);
  }
  if (userId) {
    where += ` AND m.user_id = $${params.length + 1}`;
    params.push(userId);
  }
  if (category) {
    where += ` AND i.category = $${params.length + 1}`;
    params.push(category);
  }
  if (search) {
    where += ` AND (i.name ILIKE $${params.length + 1} OR i.sku ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }
  return { where, params };
}

export async function recordInventoryOutflow(client, { batchId, clinicId, quantity, reason, referenceId, userId, saleUnitPrice }) {
  return client.query(`
    INSERT INTO inventory_movements
      (batch_id, clinic_id, movement_type, quantity_change, reason, reference_id, user_id, unit_sale_price, sale_total, cost_total)
    SELECT $1, $2, 'CONSUMPTION', $3, $4, $5, $6, $7::numeric,
      CASE WHEN $7::numeric IS NOT NULL THEN ROUND(-$3::numeric * $7::numeric, 2) END,
      CASE WHEN $7::numeric IS NOT NULL AND COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) IS NOT NULL
        THEN ROUND(-$3::numeric * COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)), 2) END
    FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1
    RETURNING id, sale_total, cost_total
  `, [batchId, clinicId, -quantity, reason, referenceId, userId, saleUnitPrice]);
}

export async function decrementInventoryBatch(client, batchId, quantity, reason) {
  return client.query(`
    UPDATE inventory_batches
    SET quantity_current = quantity_current - $2,
        status = CASE WHEN quantity_current = $2 THEN 'depleted' ELSE 'active' END
    WHERE id = $1 AND status = 'active' AND quantity_current >= $2
      AND EXISTS (SELECT 1 FROM inventory_items i WHERE i.id = inventory_batches.item_id AND i.is_archived = false)
      AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE OR $3 = 'Vencimiento')
    RETURNING quantity_current, item_id, clinic_id
  `, [batchId, quantity, reason]);
}

export default async function handler(req, res) {
  console.log(`[Clinical Records API] Request received: ${req.method} /api/records`);

  // CORS headers
  const requestOrigin = req.headers.origin || '';
  const allowedOrigins = (process.env.ADMIN_CORS_ORIGIN || 'https://bioskintech.vercel.app,http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-Clinic-Id, X-Target-User-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Cron: reportes financieros programados (diario/semanal/mensual) ──────
  if (req.method === 'GET' && req.query.action === 'sendScheduledFinanceCsv') {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    try {
      const result = await sendScheduledFinanceCsvs();
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Error en CSV programado de finanzas:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  try {
    let { action } = req.query;
    const body = req.body || {};

    // Allow action to be passed in body for POST requests
    if (!action && body.action) {
      action = body.action;
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    // ponytail: whitelist mínima pública; cualquier acción nueva requiere auth por defecto
    const PUBLIC_ACTIONS = new Set(['health', 'getSigningSession', 'verifySigningCode', 'submitSignature']);
    let auth = null;
    if (!PUBLIC_ACTIONS.has(action)) {
      auth = await authenticateRequest(req);
      if (!auth?.valid) return res.status(401).json({ error: 'No autenticado' });
    }

    // Session user object compatible con código existente
    const su = buildSu(auth);
    // Gate before pool access, schema initialization or any business query.
    // Normal features default on only after a successful DB authorization read;
    // absent/invalid session flags deny. Master retains its intentional bypass.
    if (!PUBLIC_ACTIONS.has(action) && su?.role !== 'master_admin') {
      const module = typeof action === 'string' && action.startsWith('inventory') ? 'inventory'
        : (typeof action === 'string' && action.startsWith('finance')) || action === 'sendFinanceCsv'
          ? 'finance' : 'clinical_records';
      if (su?.[`${module}_enabled`] !== true) {
        return res.status(403).json({ error: `El módulo ${module} no está habilitado para este usuario` });
      }
      if (['addTreatment', 'updateTreatment', 'createPackage'].includes(action) && body.finance_posting?.enabled) {
        if (!canPostTreatmentFinance(su)) {
          return res.status(403).json({ error: 'Solo administradores con acceso a Finanzas pueden registrar cobros' });
        }
      }
    }
    // ponytail: aliases — auth ya fue verificada arriba, ambas devuelven el mismo su
    const getSessionUserOnce = async () => su;
    const getSessionUser = async (_pool, _req) => su;

    const appPool = getAppPool();
    if (!appPool) {
      return res.status(500).json({ error: 'Database connection not configured. Check NEON_DATABASE_URL.' });
    }

    // ── Health check ──────────────────────────────────────────────────────
    if (action === 'health') {
      try {
        const client = await appPool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        return res.status(200).json({ 
          status: 'ok', 
          message: 'Clinical Records API is running', 
          db_time: result.rows[0].now 
        });
      } catch (err) {
        console.error('❌ Health check failed:', err);
        return res.status(500).json({ error: 'Database connection failed', details: err.message });
      }
    }

    const normalizeOptionalText = (value) => {
      if (value == null) return null;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    };

    // Auto-inicializar el schema clínico en el primer uso del contenedor
    if (!dbInitialized) {
      try {
        await initClinicalDatabase();
        dbInitialized = true;
      } catch (e) {
        console.error('⚠️ Clinical DB init warning:', e.message);
      }
    }

    // ── Acquire tenant-scoped client ──────────────────────────────────────
    // is_local=false → session-level; se resetea a '' en el finally antes de release.
    // ponytail: más simple que BEGIN/COMMIT y compatible con early-return en cada case.
    const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
    const client = await appPool.connect();
    let lifecycleClinicId = effectiveClinicId;
    let lifecycleLocked = false;
    let clientDiscarded = false;

    try {
      if (!lifecycleClinicId && PUBLIC_ACTIONS.has(action)) {
        const signingToken = req.query.token || body.token;
        if (typeof signingToken !== 'string' || !SIGNING_TOKEN_PATTERN.test(signingToken))
          return res.status(404).json({ error: 'Session not found or expired' });
        const target = await getPool().query('SELECT clinic_id FROM consent_forms WHERE signing_token=$1', [signingToken]);
        lifecycleClinicId = target.rows[0]?.clinic_id;
        if (!lifecycleClinicId) return res.status(404).json({ error: 'Session not found or expired' });
      }
      if (lifecycleClinicId) {
        await client.query("SET statement_timeout = '15s'");
        await lockClinicWriters(client, [lifecycleClinicId], { session: true });
        lifecycleLocked = true;
        await client.query('SET statement_timeout = 0');
        await requireClinicWritable(getPool(), lifecycleClinicId);
      } else return res.status(400).json({ error: 'Selecciona una clínica para operar sus datos.' });
      await client.query(
        "SELECT set_config('app.current_tenant', $1, false)",
        [effectiveClinicId ? String(effectiveClinicId) : '']
      );

      // ponytail: pool alias para los pocos handlers que usan pool.connect() internamente
      const pool = { query: (...a) => client.query(...a), connect: () => appPool.connect() };

      const patientIdByAction = {
        getPatient: req.query.id,
        listRecords: req.query.patient_id,
        createRecord: body.patient_id,
        updatePatient: body.id,
        deletePatient: req.query.id,
        listConsents: req.query.patient_id,
        saveConsent: body.patient_id,
        listAuditLog: req.query.patient_id,
      };
      const directRecordIdByAction = {
        getRecordData: req.query.recordId,
        listConsultations: req.query.record_id,
        createConsultation: body.record_id,
        listHistorySnapshots: req.query.record_id,
        saveConsultation: body.recordId,
        saveHistory: body.record_id,
        savePhysicalExam: body.id ? null : body.record_id,
        saveDiagnosis: body.id ? null : body.record_id,
        addTreatment: body.record_id,
        createPackage: body.record_id,
        listPackagesByRecord: req.query.record_id,
        getInjectablesByRecord: req.query.record_id,
        addInjectable: body.record_id,
        listPrescriptions: req.query.record_id,
        createPrescription: body.ficha_id,
        uploadPhotoProxy: body.record_id,
        getPhotoUploadUrl: body.record_id,
        confirmPhotoUpload: body.record_id,
        listPhotos: req.query.record_id,
        deleteRecord: req.query.id,
        listConsents: req.query.record_id,
        listAuditLog: req.query.record_id,
        saveConsent: body.id ? null : body.record_id,
      };
      const childRecordTables = {
        updateConsultation: ['consultations', body.id],
        deleteConsultation: ['consultations', req.query.id],
        deleteConsultationHistory: ['consultation_history', req.query.id],
        savePhysicalExam: ['physical_exams', body.id],
        deletePhysicalExam: ['physical_exams', req.query.id],
        saveDiagnosis: ['diagnoses', body.id],
        deleteDiagnosis: ['diagnoses', req.query.id],
        updateTreatment: ['treatments', body.id],
        deleteTreatment: ['treatments', req.query.id],
        deletePackage: ['treatment_packages', req.query.id],
        getInjectablesByTreatment: ['treatments', req.query.treatment_id],
        updateInjectable: ['injectables', body.id],
        deleteInjectable: ['injectables', req.query.id],
        getPrescription: ['prescriptions', req.query.id],
        updatePrescription: ['prescriptions', body.id],
        deletePrescription: ['prescriptions', req.query.id],
        getConsent: ['consent_forms', req.query.id],
        generateSigningToken: ['consent_forms', body.id],
        annulConsent: ['consent_forms', body.id],
        deleteConsent: ['consent_forms', req.query.id],
        saveConsent: ['consent_forms', body.id],
      };

      if (su?.role !== 'master_admin' && su?.access_scope === 'own') {
        const patientId = patientIdByAction[action];
        if (patientId && !(await canAccessPatient(pool, su, patientId)))
          return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });

        let recordId = directRecordIdByAction[action];
        const child = childRecordTables[action];
        if (!recordId && child?.[1]) {
          const childRecord = await pool.query(`SELECT record_id FROM ${child[0]} WHERE id = $1 LIMIT 1`, [child[1]]);
          recordId = childRecord.rows[0]?.record_id;
        }
        if (recordId && !(await canAccessRecord(pool, su, recordId)))
          return res.status(403).json({ error: 'Acceso no autorizado a este expediente' });
      }

      switch (action) {
      case 'init':
      case 'initClinical':
        return res.status(200).json({ success: true, message: 'Clinical database initialized' });

      // ==========================================
      // INVENTORY MODULE ACTIONS
      // ==========================================

      case 'inventoryListMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const limit = req.query.limit || 100;
          const { type, startDate, endDate } = req.query;
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          const params = [];
          let paramCount = 1;
          let query = `
            SELECT m.*, i.name as item_name, i.sku, i.is_archived, b.batch_number, b.expiration_date, cu.full_name AS user_name
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            JOIN inventory_items i ON b.item_id = i.id
            LEFT JOIN clinic_users cu ON cu.id = m.user_id AND cu.clinic_id = i.clinic_id
            WHERE 1=1
          `;
          // Filtro tenant via JOIN
          if (invClinicId) {
            query += ` AND (i.clinic_id = $${paramCount} OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
            paramCount++;
          }
          if (su.inventory_scope === 'own') {
            query += ` AND ${inventoryOwnerClause('i', paramCount)}`;
            params.push(su.user_id);
            paramCount++;
          }
          if (type && type !== 'all') {
            if (type === 'IN')  query += ` AND m.quantity_change > 0`;
            if (type === 'OUT') query += ` AND m.quantity_change < 0`;
          }
          if (startDate) { query += ` AND m.created_at >= $${paramCount}`; params.push(startDate); paramCount++; }
          if (endDate)   { query += ` AND m.created_at <= $${paramCount}`; params.push(endDate);   paramCount++; }
          query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
          params.push(Math.min(parseInt(limit) || 100, 500));

          const movements = await pool.query(query, params);
          return res.status(200).json(movements.rows);
        } catch (err) {
          console.error('Error listing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventorySalesReport':
        try {
          const sessionUser = await getSessionUserOnce();
          const clinicId = sessionUser?.effective_clinic_id ?? sessionUser?.clinic_id;
          if (!clinicId) return res.status(400).json({ error: 'Selecciona una clínica.' });
          const rawUserId = req.query.filterByUserId;
          let userId = null;
          if (rawUserId) {
            if (!['clinic_admin', 'master_admin'].includes(sessionUser.role) || sessionUser.inventory_scope === 'own')
              return res.status(403).json({ error: 'Sin acceso al filtro profesional.' });
            userId = Number(rawUserId);
            if (!Number.isSafeInteger(userId) || userId <= 0)
              return res.status(400).json({ error: 'Profesional inválido.' });
            const member = await pool.query('SELECT 1 FROM clinic_users WHERE id = $1 AND clinic_id = $2', [userId, clinicId]);
            if (!member.rows.length) return res.status(400).json({ error: 'Profesional fuera de la clínica.' });
          }
          const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
          const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
          if (category.length > 100 || search.length > 100)
            return res.status(400).json({ error: 'Filtro demasiado largo.' });
          const { where, params } = buildInventorySalesFilter({
            clinicId, startDate: req.query.startDate, endDate: req.query.endDate,
            ownerId: sessionUser.inventory_scope === 'own' ? sessionUser.user_id : null,
            userId, category, search
          });
          const from = `FROM inventory_movements m
            JOIN inventory_batches b ON b.id = m.batch_id
            JOIN inventory_items i ON i.id = b.item_id WHERE ${where}`;
          const summary = await pool.query(`SELECT COUNT(*)::int AS sales_count,
            COALESCE(SUM(m.sale_total), 0) AS total,
            COALESCE(SUM(CASE WHEN m.cost_total IS NOT NULL THEN m.sale_total - m.cost_total END), 0) AS known_margin,
            COUNT(*) FILTER (WHERE m.cost_total IS NULL)::int AS sales_without_cost,
            COUNT(DISTINCT i.id)::int AS products_count
            ${from}`, params);
          const localDay = `(m.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil')::date`;
          const daily = await pool.query(`SELECT TO_CHAR(${localDay}, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS sales_count, SUM(m.sale_total) AS total
            ${from} GROUP BY ${localDay} ORDER BY ${localDay}`, params);
          const products = await pool.query(`SELECT i.id, i.name, i.sku, i.unit_of_measure, i.is_archived, SUM(-m.quantity_change) AS units,
            SUM(m.sale_total) AS total
            ${from} GROUP BY i.id, i.name, i.sku, i.unit_of_measure, i.is_archived ORDER BY total DESC LIMIT 8`, params);
          const recent = await pool.query(`SELECT m.id, m.created_at, m.reason, m.quantity_change,
            m.unit_sale_price, m.sale_total, m.cost_total, i.name AS item_name,
            i.category, i.unit_of_measure, i.is_archived, b.batch_number
            ${from} ORDER BY m.created_at DESC LIMIT 100`, params);
          return res.status(200).json({ summary: summary.rows[0], daily: daily.rows, products: products.rows, recent: recent.rows });
        } catch (error) {
          if (error instanceof RangeError) return res.status(400).json({ error: error.message });
          console.error('Error fetching inventory sales:', error);
          return res.status(500).json({ error: 'Error al consultar ventas de inventario.' });
        }

      case 'inventoryDeleteMovement':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Sin permiso' });
          const { id } = req.query;
          const deleteParams = [id];
          let deleteQuery = `DELETE FROM inventory_movements m WHERE m.id = $1
            AND m.sale_total IS NULL AND (m.reason IS NULL OR m.reason NOT ILIKE 'Venta%') AND EXISTS (
            SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
            WHERE b.id = m.batch_id`;
          if (su.inventory_scope === 'own') {
            deleteQuery += ` AND ${inventoryOwnerClause('i', 2)}`;
            deleteParams.push(su.user_id);
          }
          deleteQuery += ') RETURNING m.id';
          const deleted = await pool.query(deleteQuery, deleteParams);
          if (!deleted.rows.length) return res.status(409).json({ error: 'Movimiento no disponible o venta protegida. Las ventas no se eliminan del historial.' });
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error deleting movement:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryClearMovements':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (su.role !== 'master_admin') return res.status(403).json({ error: 'Solo master_admin' });
          const { days } = body;
          const daysInt = parseInt(days, 10);
          if (!Number.isFinite(daysInt) || daysInt <= 0)
            return res.status(400).json({ error: 'days debe ser un entero positivo' });
          // Usar parámetro — sin interpolación de string (previene inyección con días negativos)
          await pool.query(`DELETE FROM inventory_movements WHERE created_at < NOW() - ($1 * INTERVAL '1 day')
            AND sale_total IS NULL AND (reason IS NULL OR reason NOT ILIKE 'Venta%')`, [daysInt]);
          return res.status(200).json({ success: true });
        } catch (err) {
          console.error('Error clearing movements:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListBatches':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const params = [];
          let whereClause = `b.status = 'active' AND b.quantity_current > 0`;
          if (invClinicId) {
            whereClause += ` AND (i.clinic_id = $1 OR i.clinic_id IS NULL)`;
            params.push(invClinicId);
          }
          if (su.inventory_scope === 'own') {
            const ownerParam = params.length + 1;
            whereClause += ` AND ${inventoryOwnerClause('i', ownerParam)}`;
            params.push(su.user_id);
          }
          const batches = await pool.query(`
            SELECT b.*, i.name as item_name, i.sku, i.category, i.unit_of_measure, i.cost_price AS reference_cost, i.is_archived
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE ${whereClause}
            ORDER BY b.expiration_date ASC
          `, params);
          return res.status(200).json(batches.rows);
        } catch (err) {
          console.error('Error listing batches:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryListGroups':
        try {
          const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
          if (!clinicId) return res.status(400).json({ error: 'Selecciona una clínica' });
          const groups = await pool.query(
            'SELECT category, name FROM inventory_groups WHERE clinic_id = $1 ORDER BY category, name',
            [clinicId]
          );
          return res.status(200).json(groups.rows);
        } catch (err) {
          console.error('Error listing inventory groups:', err);
          return res.status(500).json({ error: 'Error al cargar subcategorías.' });
        }

      case 'inventoryListItems':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          let status;
          try {
            status = validateInventoryListStatus(req.query.status, su.role);
          } catch (error) {
            return res.status(error instanceof TypeError ? 403 : 400).json({ error: error.message });
          }
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const filterByUserId = su.inventory_scope === 'all' && ['clinic_admin','master_admin'].includes(su?.role) && req.query.filterByUserId
            ? parseInt(req.query.filterByUserId, 10) : null;

          const params = [];
          let pCount = 1;
          const wheres = [`i.is_archived = ${status === 'archived' ? 'true' : 'false'}`];

          if (invClinicId) {
            wheres.push(`(i.clinic_id = $${pCount} OR i.clinic_id IS NULL)`);
            params.push(invClinicId);
            pCount++;
          }
          if (filterByUserId) {
            // Admin filtrando por profesional → ítems propios + ítems compartidos de la clínica
            const fu = invClinicId ? await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, invClinicId]) : { rows: [{}] };
            if (fu.rows.length) {
              wheres.push(`(i.created_by_user_id = $${pCount} OR i.created_by_user_id IS NULL)`);
              params.push(filterByUserId);
              pCount++;
            }
          } else if (su.inventory_scope === 'own') {
            wheres.push(inventoryOwnerClause('i', pCount));
            params.push(su.user_id);
            pCount++;
          }

          const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
          const items = await pool.query(`
            SELECT i.*,
              cu.full_name AS created_by_user_name, cu.username AS created_by_username,
              COALESCE(SUM(CASE WHEN b.expiration_date IS NULL OR b.expiration_date >= CURRENT_DATE THEN b.quantity_current ELSE 0 END), 0) as total_stock,
              COALESCE(SUM(CASE WHEN b.expiration_date < CURRENT_DATE THEN b.quantity_current ELSE 0 END), 0) as expired_stock,
              COALESCE(SUM(b.quantity_initial), 0) as total_initial,
              COUNT(b.id) as batch_count,
              MIN(b.expiration_date) as next_expiry
            FROM inventory_items i
            LEFT JOIN inventory_batches b ON i.id = b.item_id AND b.status = 'active'
            LEFT JOIN clinic_users cu ON cu.id = i.created_by_user_id
            ${whereClause}
            GROUP BY i.id, cu.full_name, cu.username
            ORDER BY i.name ASC
          `, params);
          return res.status(200).json(items.rows);
        } catch (err) {
          console.error('Error listing inventory:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryStats':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

          // Fetch expiry_alert_days from clinic settings (default 30)
          let expiryAlertDays = 30;
          if (invClinicId) {
            try {
              const settingsRow = await pool.query(
                `SELECT inventario->>'expiry_alert_days' AS expiry_alert_days FROM clinic_settings WHERE clinic_id = $1`,
                [invClinicId]
              );
              const val = parseInt(settingsRow.rows[0]?.expiry_alert_days);
              if (!isNaN(val) && val > 0) expiryAlertDays = val;
            } catch { /* use default */ }
          }

          // Usar parámetros $1 — sin interpolación de string para clinic_id
          const clinicParam = invClinicId ? [invClinicId] : [];
          const iWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';
          const bWhere = invClinicId ? `JOIN inventory_items ii ON ii.id = b.item_id AND (ii.clinic_id = $1 OR ii.clinic_id IS NULL)` : '';
          const alertWhere = invClinicId ? `AND (i.clinic_id = $1 OR i.clinic_id IS NULL)` : '';
          const ownerParam = clinicParam.length + 1;
          const ownerWhere = su.inventory_scope === 'own' ? ` AND ${inventoryOwnerClause('i', ownerParam)}` : '';
          const batchOwnerWhere = su.inventory_scope === 'own' ? ` AND ${inventoryOwnerClause('ii', ownerParam)}` : '';
          if (su.inventory_scope === 'own') clinicParam.push(su.user_id);

          const statsResult = await pool.query(`
            SELECT
              COUNT(DISTINCT i.id)::int AS total_items,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) = 0 THEN i.id END)::int AS out_of_stock_count,
              COUNT(DISTINCT CASE WHEN COALESCE(stock.total_stock, 0) > 0 AND COALESCE(stock.total_stock, 0) <= i.min_stock_level THEN i.id END)::int AS low_stock_count
            FROM inventory_items i
            LEFT JOIN (
              SELECT item_id, SUM(CASE WHEN expiration_date IS NULL OR expiration_date >= CURRENT_DATE THEN quantity_current ELSE 0 END) AS total_stock
              FROM inventory_batches WHERE status = 'active'
              GROUP BY item_id
            ) stock ON stock.item_id = i.id
            WHERE i.is_archived = false ${iWhere}${ownerWhere}
          `, clinicParam);

          const archivedItemsResult = await pool.query(`
            SELECT COUNT(*)::int AS archived_items_count
            FROM inventory_items i WHERE i.is_archived = true ${iWhere}${ownerWhere}
          `, clinicParam);

          const batchStats = await pool.query(`
            SELECT
              COUNT(CASE WHEN b.expiration_date < CURRENT_DATE THEN 1 END)::int AS expired_count,
              COUNT(CASE WHEN b.expiration_date >= CURRENT_DATE AND b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days' THEN 1 END)::int AS expiring_soon_count
            FROM inventory_batches b ${bWhere}
            WHERE b.status = 'active'${batchOwnerWhere}
          `, clinicParam);

          const movementsStats = await pool.query(`
            SELECT COUNT(*)::int AS movements_this_month
            FROM inventory_movements m
            JOIN inventory_batches b ON b.id = m.batch_id
            JOIN inventory_items i ON i.id = b.item_id
            WHERE m.created_at >= DATE_TRUNC('month', CURRENT_DATE)
              ${iWhere}${ownerWhere}
          `, clinicParam);

          const valueStats = await pool.query(`
            SELECT
              COALESCE(SUM(CASE WHEN i.is_archived = false THEN b.quantity_current * COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) ELSE 0 END), 0) AS stock_value,
              COALESCE(SUM(CASE WHEN i.is_archived = true THEN b.quantity_current * COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) ELSE 0 END), 0) AS archived_stock_value,
              COALESCE(SUM(CASE WHEN i.is_archived = false AND i.category = 'Venta' AND i.sale_price > 0
                                AND COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) IS NOT NULL
                THEN b.quantity_current * (i.sale_price - COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)))
                ELSE 0 END), 0) AS potential_margin,
              COALESCE(SUM(CASE WHEN i.is_archived = false AND COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) IS NULL
                THEN b.quantity_current ELSE 0 END), 0) AS units_without_cost,
              COALESCE(SUM(CASE WHEN i.is_archived = true AND COALESCE(NULLIF(b.cost_per_unit, 0), NULLIF(i.cost_price, 0)) IS NULL
                THEN b.quantity_current ELSE 0 END), 0) AS archived_units_without_cost,
              COALESCE(SUM(CASE WHEN i.is_archived = false AND i.category = 'Venta' AND (i.sale_price IS NULL OR i.sale_price <= 0)
                THEN b.quantity_current ELSE 0 END), 0) AS units_without_sale_price
            FROM inventory_batches b
            JOIN inventory_items i ON i.id = b.item_id
            WHERE b.status = 'active' AND b.quantity_current > 0
              AND (b.expiration_date IS NULL OR b.expiration_date >= CURRENT_DATE)
              ${iWhere}${ownerWhere}
          `, clinicParam);

          const alertBatches = await pool.query(`
            SELECT b.id, b.batch_number, b.expiration_date, b.quantity_current,
              i.name AS item_name, i.sku, i.unit_of_measure, i.is_archived,
              CASE WHEN b.expiration_date < CURRENT_DATE THEN 'expired'
                   WHEN b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days' THEN 'expiring_soon'
              END AS alert_type
            FROM inventory_batches b
            JOIN inventory_items i ON b.item_id = i.id
            WHERE b.status = 'active'
              AND (b.expiration_date < CURRENT_DATE OR b.expiration_date <= CURRENT_DATE + INTERVAL '${expiryAlertDays} days')
              ${alertWhere}${ownerWhere}
            ORDER BY b.expiration_date ASC LIMIT 20
          `, clinicParam);

          return res.status(200).json({
            ...statsResult.rows[0],
            ...batchStats.rows[0],
            ...movementsStats.rows[0],
            ...valueStats.rows[0],
            ...archivedItemsResult.rows[0],
            alert_batches: alertBatches.rows
          });
        } catch (err) {
          console.error('Error fetching inventory stats:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryGetItem':
        try {
          const itemId = req.query.id;
          const su = await getSessionUserOnce();
          const cid = su?.effective_clinic_id ?? su?.clinic_id;
          // Tenant check: restrict item visibility to the user's clinic (A-1 fix)
          const itemParams = [itemId];
          let itemQuery = 'SELECT * FROM inventory_items i WHERE i.id = $1';
          if (cid) { itemQuery += ' AND (i.clinic_id = $2 OR i.clinic_id IS NULL)'; itemParams.push(cid); }
          if (su?.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', itemParams.length + 1)}`;
            itemParams.push(su.user_id);
          }
          const itemResult = await pool.query(itemQuery, itemParams);
          
          if (itemResult.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
          }

          const batchesResult = await pool.query(`
            SELECT * FROM inventory_batches 
            WHERE item_id = $1 AND status = 'active' 
            ORDER BY expiration_date ASC
          `, [itemId]);

          const movementsResult = await pool.query(`
            SELECT m.*, b.batch_number 
            FROM inventory_movements m
            JOIN inventory_batches b ON m.batch_id = b.id
            WHERE b.item_id = $1
            ORDER BY m.created_at DESC
            LIMIT 50
          `, [itemId]);

          return res.status(200).json({
            item: itemResult.rows[0],
            batches: batchesResult.rows,
            movements: movementsResult.rows
          });
        } catch (err) {
          console.error('Error getting inventory item:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'inventoryCreateItem':
        let creatingItem = false;
        try {
          const { sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const suInv = await getSessionUserOnce();
          const invClinicId = suInv?.effective_clinic_id ?? suInv?.clinic_id ?? null;
          const cleanCategory = normalizeInventoryCategory(category);
          await pool.query('BEGIN');
          creatingItem = true;
          const cleanGroupName = await resolveInventoryGroup(group_name, cleanCategory, invClinicId, suInv, pool);
          const newItem = await pool.query(`
            INSERT INTO inventory_items (clinic_id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price, created_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
          `, [invClinicId, cleanSku, name, cleanBrand, cleanDescription, cleanCategory, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
              normalizeInventoryPrice(cost_price),
              normalizeInventoryPrice(sale_price),
              suInv?.user_id ?? null]);
          await pool.query('COMMIT');
          creatingItem = false;
          return res.status(201).json(newItem.rows[0]);
        } catch (err) {
          if (creatingItem) await pool.query('ROLLBACK').catch(() => {});
          console.error('Error creating inventory item:', err);
          if (err instanceof RangeError || ['Grupo inválido', 'Categoría inválida', 'Selecciona una categoría válida.', 'Selecciona una clínica para registrar el grupo'].includes(err.message)) return res.status(400).json({ error: err.message });
          if (err.code === '23505') {
            return res.status(409).json({ error: 'El SKU ya existe en esta clínica. Usa otro código o deja el campo vacío.' });
          }
          return res.status(500).json({ error: 'Error al crear producto de inventario.' });
        }

      case 'inventoryUpdateItem':
        let updatingItem = false;
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          const { id, sku, name, brand, description, category, group_name, unit_of_measure, min_stock_level, requires_cold_chain, sanitary_registration, cost_price, sale_price } = body;
          const cleanSku = normalizeOptionalText(sku);
          const cleanBrand = normalizeOptionalText(brand);
          const cleanDescription = normalizeOptionalText(description);
          const cleanSanitaryRegistration = normalizeOptionalText(sanitary_registration);
          const invClinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
          const cleanCategory = normalizeInventoryCategory(category);
          await pool.query('BEGIN');
          updatingItem = true;
          const cleanGroupName = await resolveInventoryGroup(group_name, cleanCategory, invClinicId, su, pool);
          // Verificar que el item pertenece a la clínica del usuario
          const clinicCheck = invClinicId
            ? ` AND (clinic_id = $14 OR clinic_id IS NULL)`
            : '';
          const params = [cleanSku, name, cleanBrand, cleanDescription, cleanCategory, cleanGroupName, unit_of_measure, min_stock_level, requires_cold_chain, cleanSanitaryRegistration,
            normalizeInventoryPrice(cost_price), normalizeInventoryPrice(sale_price), id];
          if (invClinicId) params.push(invClinicId);
          const ownerCheck = su.inventory_scope === 'own'
            ? ` AND ${inventoryOwnerClause('inventory_items', params.length + 1)}`
            : '';
          if (su.inventory_scope === 'own') params.push(su.user_id);
          const updatedItem = await pool.query(
            `UPDATE inventory_items SET sku=$1, name=$2, brand=$3, description=$4, category=$5, group_name=$6, unit_of_measure=$7, min_stock_level=$8, requires_cold_chain=$9, sanitary_registration=$10, cost_price=$11, sale_price=$12 WHERE id=$13 AND is_archived = false${clinicCheck}${ownerCheck} RETURNING *`,
            params
          );
          if (updatedItem.rows.length === 0) {
            await pool.query('ROLLBACK');
            updatingItem = false;
            return res.status(404).json({ error: 'Item not found or not in your clinic' });
          }
          await pool.query('COMMIT');
          updatingItem = false;
          return res.status(200).json(updatedItem.rows[0]);
        } catch (err) {
          if (updatingItem) await pool.query('ROLLBACK').catch(() => {});
          console.error('Error updating inventory item:', err);
          if (err instanceof RangeError || ['Grupo inválido', 'Categoría inválida', 'Selecciona una categoría válida.', 'Selecciona una clínica para registrar el grupo'].includes(err.message)) return res.status(400).json({ error: err.message });
          if (err.code === '23505') return res.status(409).json({ error: 'El SKU ya existe. Usa otro código o deja el campo vacío.' });
          return res.status(500).json({ error: 'Error al actualizar producto de inventario.' });
        }

      case 'inventoryArchiveItem':
      case 'inventoryRestoreItem':
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden archivar o restaurar productos.' });
          const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
          const archive = action === 'inventoryArchiveItem';
          const statement = buildInventoryArchiveUpdate({
            itemId: Number(body.id ?? req.query.id), clinicId, userId: su.user_id,
            inventoryScope: su.inventory_scope, archive, reason: body.reason
          });
          const result = await pool.query(statement.query, statement.params);
          if (!result.rows.length)
            return res.status(409).json({ error: 'El producto ya cambió de estado o no pertenece a esta clínica. Actualiza el inventario e inténtalo de nuevo.' });
          return res.status(200).json({ success: true, item: result.rows[0] });
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError)
            return res.status(400).json({ error: error.message });
          console.error('Error updating archived inventory item:', error);
          return res.status(500).json({ error: 'No se pudo actualizar el estado del producto.' });
        }

      case 'inventoryDeleteItem': {
        let deletingItem = false;
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar productos' });
          const { id } = req.query;
          const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
          if (!clinicId) return res.status(400).json({ error: 'Selecciona una clínica para eliminar el producto.' });
          await pool.query('BEGIN');
          deletingItem = true;
          const itemParams = [id, clinicId];
          let itemQuery = 'SELECT i.id, i.is_archived FROM inventory_items i WHERE i.id = $1 AND i.clinic_id = $2';
          if (su.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', 3)}`;
            itemParams.push(su.user_id);
          }
          itemQuery += ' FOR UPDATE';
          const item = await pool.query(itemQuery, itemParams);
          if (!item.rows.length) {
            await pool.query('ROLLBACK');
            deletingItem = false;
            return res.status(404).json({ error: 'Producto no encontrado en esta clínica.' });
          }
          const batches = await pool.query('SELECT id, quantity_current FROM inventory_batches WHERE item_id = $1 FOR UPDATE', [id]);
          const batchIds = batches.rows.map(batch => batch.id);
          const history = batchIds.length
            ? await pool.query('SELECT 1 FROM inventory_movements WHERE batch_id = ANY($1) LIMIT 1', [batchIds])
            : { rows: [] };
          const conflict = getInventoryPermanentDeleteConflict({
            isArchived: item.rows[0].is_archived,
            hasMovementHistory: history.rows.length > 0,
            hasRemainingStock: batches.rows.some(batch => Number(batch.quantity_current) !== 0),
          });
          if (conflict) {
            await pool.query('ROLLBACK');
            deletingItem = false;
            return res.status(409).json({ error: conflict });
          }
          if (batchIds.length) await pool.query('DELETE FROM inventory_batches WHERE item_id = $1', [id]);
          await pool.query('DELETE FROM inventory_items WHERE id = $1', [id]);
          await pool.query('COMMIT');
          deletingItem = false;
          return res.status(200).json({ success: true });
        } catch (err) {
          if (deletingItem) await pool.query('ROLLBACK').catch(() => {});
          console.error('Error deleting inventory item:', err);
          return res.status(500).json({ error: 'No se pudo eliminar definitivamente el producto.' });
        }
      }

      case 'inventoryDeleteBatch': {
        let deletingBatch = false;
        try {
          const su = await getSessionUserOnce();
          if (!su) return res.status(401).json({ error: 'No autenticado' });
          if (!['clinic_admin', 'master_admin'].includes(su.role))
            return res.status(403).json({ error: 'Solo administradores pueden eliminar lotes' });
          const { id } = req.query;
          const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
          if (su.inventory_scope === 'own') {
            const owner = await pool.query(
              `SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
               WHERE b.id = $1 AND ${inventoryOwnerClause('i', 2)}`,
              [id, su.user_id]
            );
            if (!owner.rows.length) return res.status(403).json({ error: 'Sin acceso al lote' });
          }
          await pool.query('BEGIN');
          deletingBatch = true;
          const itemParams = [id, clinicId];
          let itemQuery = `SELECT i.id, i.is_archived FROM inventory_items i
            JOIN inventory_batches b ON b.item_id = i.id
            WHERE b.id = $1 AND i.clinic_id IS NOT DISTINCT FROM $2`;
          if (su.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', 3)}`;
            itemParams.push(su.user_id);
          }
          itemQuery += ' FOR UPDATE OF i';
          const product = await pool.query(itemQuery, itemParams);
          if (!product.rows.length) {
            await pool.query('ROLLBACK');
            deletingBatch = false;
            return res.status(404).json({ error: 'Lote no encontrado en esta clínica.' });
          }
          if (product.rows[0].is_archived) {
            await pool.query('ROLLBACK');
            deletingBatch = false;
            return res.status(409).json({ error: 'El producto está archivado. Restáuralo antes de modificar sus lotes.' });
          }
          const lockedBatch = await pool.query('SELECT id FROM inventory_batches WHERE id = $1 FOR UPDATE', [id]);
          if (!lockedBatch.rows.length) {
            await pool.query('ROLLBACK');
            deletingBatch = false;
            return res.status(404).json({ error: 'Lote no encontrado.' });
          }
          const sales = await pool.query(`SELECT 1 FROM inventory_movements
            WHERE batch_id = $1 AND (sale_total IS NOT NULL OR reason ILIKE 'Venta%') LIMIT 1`, [id]);
          if (sales.rows.length) {
            await pool.query('ROLLBACK');
            deletingBatch = false;
            return res.status(409).json({ error: 'Este lote tiene ventas registradas y no puede eliminarse.' });
          }
          await pool.query('DELETE FROM inventory_movements WHERE batch_id = $1', [id]);
          await pool.query('DELETE FROM inventory_batches WHERE id = $1', [id]);
          await pool.query('COMMIT');
          deletingBatch = false;
          return res.status(200).json({ success: true });
        } catch (err) {
          if (deletingBatch) await pool.query('ROLLBACK').catch(() => {});
          console.error('Error deleting batch:', err);
          return res.status(500).json({ error: 'No se pudo eliminar el lote.' });
        }
      }

      case 'inventoryAddBatch':
        try {
          const { item_id, batch_number, expiration_date, quantity, cost_per_unit, update_reference_cost, reference_cost } = body;
          const { units, cost } = validateInventoryBatchInput(quantity, cost_per_unit);
          const expectedCost = validateReferenceCostChange(update_reference_cost, cost, reference_cost);
          // Tenant check: verify item belongs to user's clinic before adding stock (A-1 fix)
          const suBatch = await getSessionUserOnce();
          const batchCid = suBatch?.effective_clinic_id ?? suBatch?.clinic_id;
          if (batchCid != null && suBatch?.role !== 'master_admin') {
            const itemChk = await pool.query('SELECT clinic_id FROM inventory_items WHERE id = $1', [item_id]);
            if (itemChk.rows.length && itemChk.rows[0].clinic_id !== batchCid)
              return res.status(403).json({ error: 'Ítem no pertenece a esta clínica' });
          }
          // Resolve clinic_id for insertion (use item's clinic_id as source of truth)
          const itemParams = [item_id];
          let itemQuery = 'SELECT clinic_id, is_archived FROM inventory_items i WHERE id = $1';
          if (suBatch?.inventory_scope === 'own') {
            itemQuery += ` AND ${inventoryOwnerClause('i', 2)}`;
            itemParams.push(suBatch.user_id);
          }
          const itemRow = await pool.query(itemQuery, itemParams);
          if (!itemRow.rows.length) return res.status(403).json({ error: 'Sin acceso al producto' });
          const resolvedClinicId = itemRow.rows[0]?.clinic_id ?? batchCid ?? null;
          if (itemRow.rows[0].is_archived) return res.status(409).json({ error: 'Este producto está archivado. Restáuralo antes de ingresar stock.' });
          // Use the outer tenant-scoped client via pool.query — avoids creating a new connection without app.current_tenant
          await pool.query('BEGIN');
          try {
            const lockedItem = await pool.query(`SELECT is_archived FROM inventory_items
              WHERE id = $1 AND clinic_id IS NOT DISTINCT FROM $2 FOR UPDATE`, [item_id, resolvedClinicId]);
            if (!lockedItem.rows.length || lockedItem.rows[0].is_archived) {
              await pool.query('ROLLBACK');
              return res.status(409).json({ error: 'El producto fue archivado. Restáuralo antes de ingresar stock.' });
            }
            if (update_reference_cost === true) {
              const updated = await updateInventoryReferenceCost(pool, {
                cost, itemId: item_id, clinicId: resolvedClinicId, expectedCost
              });
              if (!updated.rows.length) {
                await pool.query('ROLLBACK');
                return res.status(409).json({ error: 'El costo de referencia cambió mientras registrabas esta entrada. Actualiza el producto y vuelve a intentarlo.' });
              }
            }
            const newBatch = await pool.query(`
              INSERT INTO inventory_batches (item_id, clinic_id, batch_number, expiration_date, quantity_initial, quantity_current, cost_per_unit, status)
              VALUES ($1, $2, $3, $4, $5, $5, $6, 'active')
              RETURNING *
            `, [item_id, resolvedClinicId, batch_number, expiration_date, units, cost]);

            await pool.query(`
              INSERT INTO inventory_movements (batch_id, clinic_id, movement_type, quantity_change, reason, user_id)
              VALUES ($1, $2, 'PURCHASE', $3, 'Ingreso inicial de lote', $4)
            `, [newBatch.rows[0].id, resolvedClinicId, units, suBatch?.user_id ?? null]);

            await pool.query('COMMIT');
            return res.status(201).json(newBatch.rows[0]);
          } catch (e) {
            await pool.query('ROLLBACK');
            throw e;
          }
        } catch (err) {
          console.error('Error adding batch:', err);
          if (err instanceof RangeError) return res.status(400).json({ error: err.message });
          return res.status(500).json({ error: 'Error al registrar el lote.' });
        }

      case 'inventoryConsume':
        try {
          const { batch_id, quantity, reason, reference_id, preferred_display_unit, unit_sale_price } = body;
          const consumedQuantity = Number(quantity);
          if (!Number.isSafeInteger(Number(batch_id)) || Number(batch_id) <= 0 ||
              !Number.isFinite(consumedQuantity) || consumedQuantity <= 0 || consumedQuantity > 999999999.99 ||
              Math.round(consumedQuantity * 100) / 100 !== consumedQuantity ||
              typeof reason !== 'string' || !INVENTORY_OUTFLOW_REASONS.has(reason.trim()) ||
              (preferred_display_unit && !['absolute', 'percentage'].includes(preferred_display_unit))) {
            return res.status(400).json({ error: 'Lote, cantidad o motivo inválido.' });
          }
          let saleUnitPrice;
          try {
            saleUnitPrice = validateInventorySalePrice(reason.trim(), unit_sale_price, consumedQuantity);
          } catch (error) {
            return res.status(400).json({ error: error.message });
          }
          // Tenant check: verify batch belongs to user's clinic before consuming (A-1 fix)
          const suCons = await getSessionUserOnce();
          const consCid = suCons?.effective_clinic_id ?? suCons?.clinic_id;
          if (suCons?.inventory_scope === 'own') {
            const access = await pool.query(
              `SELECT 1 FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id
               WHERE b.id = $1 AND ${inventoryOwnerClause('i', 2)}`,
              [batch_id, suCons.user_id]
            );
            if (!access.rows.length) return res.status(403).json({ error: 'Sin acceso al producto' });
          }
          if (consCid != null && suCons?.role !== 'master_admin') {
            const tenantChk = await pool.query(
              'SELECT i.clinic_id FROM inventory_batches b JOIN inventory_items i ON i.id = b.item_id WHERE b.id = $1',
              [batch_id]
            );
            if (tenantChk.rows.length && tenantChk.rows[0].clinic_id !== consCid)
              return res.status(403).json({ error: 'Lote no pertenece a esta clínica' });
          }
          const client = await pool.connect();
          try {
            // Propagar tenant context al cliente interno (necesario para RLS)
            await client.query("SELECT set_config('app.current_tenant', $1, false)", [consCid ? String(consCid) : '']);
            await client.query('BEGIN');

            const lockedItem = await client.query(`SELECT i.is_archived FROM inventory_items i
              JOIN inventory_batches b ON b.item_id = i.id WHERE b.id = $1 FOR UPDATE OF i`, [batch_id]);
            if (!lockedItem.rows.length || lockedItem.rows[0].is_archived) {
              await client.query('ROLLBACK');
              return res.status(409).json({ error: 'Este producto está archivado. Restáuralo antes de registrar movimientos.' });
            }
            
            const updated = await decrementInventoryBatch(client, batch_id, consumedQuantity, reason.trim());
            if (!updated.rows.length) {
              await client.query('ROLLBACK');
              return res.status(409).json({ error: 'Lote sin stock suficiente o vencido. Actualiza el inventario; para descartarlo usa Vencimiento.' });
            }
            const { item_id: itemId, clinic_id: batchClinicId, quantity_current: newQty } = updated.rows[0];

            // Update Item Preference if provided
            if (preferred_display_unit) {
              await client.query(`
                UPDATE inventory_items
                SET preferred_display_unit = $1
                WHERE id = $2
              `, [preferred_display_unit, itemId]);
            }

            const movement = await recordInventoryOutflow(client, {
              batchId: batch_id, clinicId: batchClinicId, quantity: consumedQuantity,
              reason: reason.trim(), referenceId: reference_id, userId: suCons?.user_id ?? null, saleUnitPrice
            });
            if (!movement.rows.length) throw new Error('No se pudo registrar el movimiento de stock');

            await client.query('COMMIT');
            return res.status(200).json({ success: true, new_quantity: newQty });
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        } catch (err) {
          console.error('Error consuming inventory:', err);
          return res.status(500).json({ error: 'Error al registrar consumo.' });
        }

      case 'listPatients': {
        const su = await getSessionUser(pool, req);
        const filterMine = req.query.filterMine === 'true';
        // viewAsUserId: master_admin navegando AS un usuario específico → ver exactamente lo que ve ese usuario
        const viewAsUserId  = su?.role === 'master_admin' && req.query.viewAsUserId  ? parseInt(req.query.viewAsUserId,  10) : null;
        // filterByUserId: admin filtrando la vista clínica por profesional (no impersonación)
        const filterByUserId = su?.access_scope === 'all' && ['master_admin','clinic_admin'].includes(su?.role) && req.query.filterByUserId ? parseInt(req.query.filterByUserId, 10) : null;

        let pq, pp = [];
        const effectiveClinicId = su?.effective_clinic_id ?? su?.clinic_id;

        // ponytail: helper para queries con owner JOIN — evita repetición
        const fromOwner = `FROM patients p LEFT JOIN clinic_users cu ON cu.id = p.created_by_user_id`;
        const selOwner  = `SELECT p.*, cu.full_name AS created_by_user_name, cu.username AS created_by_username, ROW_NUMBER() OVER (PARTITION BY p.clinic_id ORDER BY p.id) AS seq`;
        // filtro de pacientes propios + asignados
        const ownFilter = `AND (p.created_by_user_id = $2 OR EXISTS (SELECT 1 FROM patient_assignments pa WHERE pa.patient_id = p.id AND pa.clinic_user_id = $2))`;

        if (!su || effectiveClinicId == null) {
          // Pre-migración o master sin contexto de clínica
          const cf = req.query.clinicId ? parseInt(req.query.clinicId) : null;
          if (cf) { pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`; pp = [cf]; }
          else    { pq = `${selOwner} ${fromOwner} ORDER BY p.last_name, p.first_name`; }

        } else if (viewAsUserId) {
          // Impersonación: aplicar scope real del usuario destino
          const vu = await pool.query(
            'SELECT access_scope FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true LIMIT 1',
            [viewAsUserId, effectiveClinicId]
          );
          if (vu.rows.length && vu.rows[0].access_scope === 'own') {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, viewAsUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (filterByUserId) {
          // Filtro por profesional en vista clínica — validar que el usuario pertenezca a esta clínica
          const fu = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 LIMIT 1', [filterByUserId, effectiveClinicId]);
          if (fu.rows.length) {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId, filterByUserId];
          } else {
            pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
            pp = [effectiveClinicId];
          }

        } else if (su.access_scope === 'own' || (su.access_scope === 'all' && filterMine)) {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ${ownFilter} ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId, su.user_id];

        } else {
          pq = `${selOwner} ${fromOwner} WHERE p.clinic_id = $1 ORDER BY p.last_name, p.first_name`;
          pp = [effectiveClinicId];
        }

        // Búsqueda por texto — usar alias p. para evitar ambigüedad con el JOIN
        const searchTerm = req.query.search?.trim();
        if (searchTerm && pp.length > 0) {
          const idx = pp.length + 1;
          const orderMarker = 'ORDER BY p.last_name, p.first_name';
          pq = pq.replace(orderMarker, `AND (CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $${idx} OR p.first_name ILIKE $${idx} OR p.last_name ILIKE $${idx} OR p.identification_number ILIKE $${idx}) ${orderMarker}`);
          pp.push(`%${searchTerm}%`);
        } else if (searchTerm) {
          pq = `${selOwner} ${fromOwner} WHERE (CONCAT_WS(' ', p.first_name, p.last_name) ILIKE $1 OR p.first_name ILIKE $1 OR p.last_name ILIKE $1 OR p.identification_number ILIKE $1) ORDER BY p.last_name, p.first_name`;
          pp = [`%${searchTerm}%`];
        }

        const limitVal = parseInt(req.query.limit || '500');
        pq += ` LIMIT ${Math.min(limitVal, 1000)}`;
        const patients = await pool.query(pq, pp);
        return res.status(200).json(patients.rows);
      }

      case 'getPatient': {
        const { id } = req.query;
        const patient = await pool.query('SELECT * FROM patients WHERE id = $1', [id]);
        if (patient.rows.length === 0) return res.status(404).json({ error: 'Patient not found' });
        // Clinic scope check
        const su = await getSessionUser(pool, req);
        if (su?.clinic_id != null && patient.rows[0].clinic_id != null && patient.rows[0].clinic_id !== su.clinic_id && su.role !== 'master_admin') {
          return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
        }
        // own-scope: solo permite acceso a pacientes propios o asignados explícitamente
        if (su?.access_scope === 'own' && su.user_id != null) {
          const owned = patient.rows[0].created_by_user_id === su.user_id;
          if (!owned) {
            const asgn = await pool.query(
              'SELECT 1 FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2 LIMIT 1',
              [patient.rows[0].id, su.user_id]
            );
            if (!asgn.rows.length) return res.status(403).json({ error: 'Acceso no autorizado a este paciente' });
          }
        }
        // Also fetch active record ID — scoped to user for 'own' access
        let recordQuery, recordParams;
        if (su?.access_scope === 'own' && su.user_id != null && su.role !== 'master_admin') {
          recordQuery = "SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' AND created_by_user_id = $2 ORDER BY created_at DESC LIMIT 1";
          recordParams = [id, su.user_id];
        } else {
          recordQuery = "SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1";
          recordParams = [id];
        }
        const record = await pool.query(recordQuery, recordParams);
        return res.status(200).json({ ...patient.rows[0], active_record_id: record.rows[0]?.id || null });
      }

      case 'listRecords': {
        const { patient_id } = req.query;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [patient_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        // Join creator name so the UI can label each expediente by doctor
        const selectWithCreator = `
          SELECT cr.*,
                 cu.full_name   AS created_by_full_name,
                 cu.username    AS created_by_username,
                 cu.gentilicio  AS created_by_gentilicio
          FROM clinical_records cr
          LEFT JOIN clinic_users cu ON cu.id = cr.created_by_user_id
          WHERE cr.patient_id = $1
        `;
        let records;
        if (su?.access_scope === 'own' && su?.user_id != null && su?.role !== 'master_admin') {
          records = await pool.query(
            selectWithCreator + ' AND cr.created_by_user_id = $2 ORDER BY cr.created_at DESC',
            [patient_id, su.user_id]
          );
        } else {
          records = await pool.query(
            selectWithCreator + ' ORDER BY cr.created_at DESC',
            [patient_id]
          );
        }
        return res.status(200).json(records.rows);
      }

      case 'createRecord': {
        const { patient_id: p_id } = body;
        const su = await getSessionUserOnce();
        const cid = su?.effective_clinic_id ?? su?.clinic_id;
        if (cid != null && su?.role !== 'master_admin') {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [p_id]);
          if (chk.rows.length && chk.rows[0].clinic_id !== cid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        const newRecord = await pool.query(
          'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
          [p_id, cid, su?.user_id || null, 'active']
        );
        return res.status(201).json(newRecord.rows[0]);
      }

      case 'createPatient':
        try {
          const { first_name, last_name, identification_type, identification_number, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil } = body;
          
          console.log('📝 Creating patient:', { first_name, last_name, identification_type, email });

          const cleanIdentification = normalizeEcuadorIdentification(identification_type, identification_number);
          if (!cleanIdentification) return res.status(400).json({ error: 'Ingrese una cédula de 10 dígitos o un RUC de 13 dígitos.' });
          const cleanBirthDate = birth_date && birth_date.trim() !== '' ? birth_date : null;

          // Obtener clinic_id y created_by_user_id desde sesión (post-migración)
          const suCreate = await getSessionUser(pool, req);
          // Para master admin viendo una clínica, usar effective_clinic_id
          const patientClinicId = suCreate?.effective_clinic_id ?? suCreate?.clinic_id ?? null;
          const patientCreatedBy = suCreate?.user_id ?? null;

          // Verificar duplicado dentro de la misma clínica antes de insertar
          if (patientClinicId != null) {
            const dup = await pool.query(
              `SELECT id, first_name, last_name, identification_type,
                COALESCE(identification_number, rut) AS identification_number, created_by_user_id
               FROM patients WHERE clinic_id = $1 AND (
                 (identification_type = $2 AND identification_number = $3) OR
                 (identification_type IS NULL AND regexp_replace(COALESCE(identification_number, rut), '[^0-9]', '', 'g') = $3)
               )`,
              [patientClinicId, identification_type, cleanIdentification]
            );
            if (dup.rows.length > 0) {
              const conflictType = dup.rows[0].created_by_user_id === patientCreatedBy ? 'same_user' : 'same_clinic';
              return res.status(409).json({ conflict: conflictType, patient: dup.rows[0] });
            }
          }

          // Usar INSERT con columnas de tenant si están disponibles
          let newPatient;
          if (patientClinicId != null) {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, identification_type, identification_number, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil, clinic_id, created_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
              [first_name, last_name, cleanIdentification, identification_type, cleanIdentification, email, phone, cleanBirthDate, gender, address, occupation, tipo_sangre || null, estado_civil || null, patientClinicId, patientCreatedBy]
            );
          } else {
            newPatient = await pool.query(
              `INSERT INTO patients (first_name, last_name, rut, identification_type, identification_number, email, phone, birth_date, gender, address, occupation, tipo_sangre, estado_civil)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
              [first_name, last_name, cleanIdentification, identification_type, cleanIdentification, email, phone, cleanBirthDate, gender, address, occupation, tipo_sangre || null, estado_civil || null]
            );
          }
          // Create an initial clinical record for the patient — with user ownership
          await pool.query(
            'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4)',
            [newPatient.rows[0].id, patientClinicId, patientCreatedBy, 'active']
          );
          // Audit
          await logAudit(pool, { patientId: newPatient.rows[0].id, sessionUser: suCreate, actionType: 'create', module: 'patient', summary: `Paciente creado: ${first_name} ${last_name}` });
          return res.status(201).json(newPatient.rows[0]);
        } catch (err) {
          console.error('❌ Error creating patient:', err);
          
          if (err.code === '23505') return res.status(400).json({ error: 'La identificación o el correo ya están registrados en la clínica.' });
          
          if (err.code === '22007') {
             return res.status(400).json({ error: 'Formato de fecha inválido.' });
          }

          return res.status(500).json({ error: `Error al crear paciente: ${err.message}` });
        }

      case 'updatePatient': {
        const { id: pid, ...updates } = body;
        // Whitelist de campos permitidos (previene SQL injection por nombres de columna)
        const suUpd = await getSessionUser(pool, req);
        const ALLOWED_PATIENT_FIELDS = ['first_name', 'last_name', 'identification_type', 'identification_number', 'email', 'phone', 'birth_date', 'gender', 'address', 'occupation', 'tipo_sangre', 'estado_civil'];
        // master_admin puede reasignar clinic_id (para corregir pacientes huérfanos)
        if (suUpd?.role === 'master_admin') ALLOWED_PATIENT_FIELDS.push('clinic_id');
        const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED_PATIENT_FIELDS.includes(k)));
        if ('identification_type' in safe || 'identification_number' in safe) {
          const normalized = normalizeEcuadorIdentification(safe.identification_type, safe.identification_number);
          if (!normalized) return res.status(400).json({ error: 'Ingrese una cédula de 10 dígitos o un RUC de 13 dígitos.' });
          const duplicate = await pool.query(
            `SELECT id FROM patients WHERE id <> $1 AND clinic_id = (SELECT clinic_id FROM patients WHERE id = $1) AND (
               (identification_type = $2 AND identification_number = $3) OR
               (identification_type IS NULL AND regexp_replace(COALESCE(identification_number, rut), '[^0-9]', '', 'g') = $3)
             ) LIMIT 1`,
            [pid, safe.identification_type, normalized]
          );
          if (duplicate.rows.length) return res.status(409).json({ error: 'La identificación ya está registrada en la clínica.' });
          safe.identification_number = normalized;
          safe.rut = normalized;
        }
        if (suUpd?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [pid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suUpd.clinic_id && suUpd.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        const fields = Object.keys(safe);
        if (!fields.length) return res.status(400).json({ error: 'Sin campos válidos para actualizar' });
        const values = Object.values(safe);
        const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        const updatedPatient = await pool.query(
          `UPDATE patients SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [pid, ...values]
        );
        return res.status(200).json(updatedPatient.rows[0]);
      }

      // ─── Importar snapshot de paciente (datos básicos + antecedentes) ────
      case 'importPatientSnapshot': {
        const { source_patient_id, import_fields = ['basic', 'history'] } = body;
        if (!source_patient_id) return res.status(400).json({ error: 'source_patient_id requerido' });

        const suImp = await getSessionUser(pool, req);
        if (!suImp) return res.status(401).json({ error: 'No autenticado' });
        const targetClinicId = suImp.effective_clinic_id ?? suImp.clinic_id;
        if (!targetClinicId) return res.status(400).json({ error: 'Sin clínica activa' });

        // Seguridad: source_patient debe pertenecer a la misma clínica
        const srcChk = await pool.query(
          'SELECT * FROM patients WHERE id = $1 AND clinic_id = $2',
          [source_patient_id, targetClinicId]
        );
        if (!srcChk.rows.length) return res.status(403).json({ error: 'Paciente fuente no encontrado en tu clínica' });
        const src = srcChk.rows[0];

        // Idempotente: solo match exacto por user_id (NULL = legacy sin dueño, no cuenta como propio)
        const existingRecord = await pool.query(
          'SELECT * FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 AND status = $3 ORDER BY created_at DESC LIMIT 1',
          [src.id, suImp.user_id, 'active']
        );
        if (existingRecord.rows.length > 0) {
          return res.status(200).json({ patient: src, record: existingRecord.rows[0], already_exists: true });
        }

        // Crear expediente propio para este médico — NO se duplica el paciente
        const newRecord = await pool.query(
          'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
          [src.id, targetClinicId, suImp.user_id || null, 'active']
        );
        const newRecordRow = newRecord.rows[0];

        // Registrar acceso del médico al paciente en patient_assignments (para listPatients own-scope)
        await pool.query(
          'INSERT INTO patient_assignments (patient_id, clinic_user_id, assigned_by, assigned_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING',
          [src.id, suImp.user_id, suImp.user_id]
        );

        // Copiar antecedentes si se solicita — desde el expediente más antiguo del paciente, excluyendo el recién creado
        if (import_fields.includes('history')) {
          const srcRec = await pool.query(
            'SELECT id FROM clinical_records WHERE patient_id = $1 AND id != $2 ORDER BY created_at ASC LIMIT 1',
            [source_patient_id, newRecordRow.id]
          );
          if (srcRec.rows.length > 0) {
            const hist = await pool.query(
              'SELECT * FROM medical_history WHERE record_id = $1 ORDER BY updated_at DESC LIMIT 1',
              [srcRec.rows[0].id]
            );
            if (hist.rows.length > 0) {
              const h = hist.rows[0];
              await pool.query(
                `INSERT INTO medical_history
                 (record_id, pathological, non_pathological, family_history, surgical_history,
                  allergies, current_medications, aesthetic_history, gynecological_history)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT DO NOTHING`,
                [newRecordRow.id, h.pathological, h.non_pathological, h.family_history,
                 h.surgical_history, h.allergies, h.current_medications, h.aesthetic_history, h.gynecological_history]
              );
            }
          }
        }

        await logAudit(pool, { patientId: src.id, sessionUser: suImp, actionType: 'create', module: 'patient', summary: `Nuevo expediente creado para paciente existente ID ${source_patient_id}: ${src.first_name} ${src.last_name}` });
        return res.status(201).json({ patient: src, record: newRecordRow });
      }

      case 'deletePatient': {
        const { id: delPid } = req.query;
        // Clinic scope check
        const suDel = await getSessionUser(pool, req);
        if (suDel?.clinic_id != null) {
          const chk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [delPid]);
          if (chk.rows.length && chk.rows[0].clinic_id != null && chk.rows[0].clinic_id !== suDel.clinic_id && suDel.role !== 'master_admin') {
            return res.status(403).json({ error: 'Acceso no autorizado' });
          }
        }
        try {
          await client.query('BEGIN');
          const consents = await pool.query(
            'SELECT id, signing_status, status, signature_data, signed_at, signing_signed_at, signatures FROM consent_forms WHERE patient_id = $1 FOR UPDATE',
            [delPid]
          );
          const hasSignedConsent = consents.rows.some(row => row.signing_status === 'signed' ||
            ['signed', 'finalized'].includes(row.status) || row.signature_data || row.signed_at || row.signing_signed_at || row.signatures?.patient_sig_data || row.signatures?.patient_signed_at);
          if (hasSignedConsent) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar un paciente con consentimientos firmados.' });
          }
          await pool.query('DELETE FROM patients WHERE id = $1', [delPid]);
          await client.query('COMMIT');
          return res.status(200).json({ success: true });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('Error deleting patient:', err);
          return res.status(500).json({ error: 'Error al eliminar paciente. Puede tener registros asociados.' });
        }
      }

      // ─── Listar usuarios de la clínica actual (para UI de asignación) ────
      case 'listClinicUsers': {
        const suLU = await getSessionUser(pool, req);
        if (!suLU) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suLU.role)) return res.status(403).json({ error: 'Sin permisos' });
        const clinicId = suLU.effective_clinic_id ?? suLU.clinic_id;
        if (clinicId == null) return res.status(400).json({ error: 'Sin clínica activa' });
        const usersRes = await pool.query(
          `SELECT id, username, full_name, role, access_scope
           FROM clinic_users WHERE clinic_id = $1 AND is_active = true ORDER BY full_name`,
          [clinicId]
        );
        return res.status(200).json(usersRes.rows);
      }

      // ─── Grupos de compartición (inventario + finanzas) ───────────────────
      case 'listSharingGroups': {
        const suSG = await getSessionUser(pool, req);
        if (!suSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suSG.effective_clinic_id ?? suSG.clinic_id;
        if (!sgClinic) return res.status(400).json({ error: 'Sin clínica activa' });
        const groups = await pool.query(
          `SELECT sg.id, sg.name, sg.description,
             COALESCE(json_agg(json_build_object('id', cu.id, 'username', cu.username, 'full_name', cu.full_name)
               ORDER BY cu.full_name) FILTER (WHERE cu.id IS NOT NULL), '[]') AS members
           FROM sharing_groups sg
           LEFT JOIN sharing_group_members sgm ON sgm.group_id = sg.id
           LEFT JOIN clinic_users cu ON cu.id = sgm.clinic_user_id
           WHERE sg.clinic_id = $1
           GROUP BY sg.id ORDER BY sg.name`,
          [sgClinic]
        );
        return res.status(200).json(groups.rows);
      }

      case 'manageSharingGroup': {
        // mode: 'create' | 'update' | 'delete'
        const suMSG = await getSessionUser(pool, req);
        if (!suMSG) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSG.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSG.effective_clinic_id ?? suMSG.clinic_id;
        const { mode, group_id, name, description } = body;
        if (mode === 'create') {
          if (!name?.trim()) return res.status(400).json({ error: 'Nombre requerido' });
          const r = await pool.query(
            'INSERT INTO sharing_groups (clinic_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description',
            [sgClinic, name.trim(), description?.trim() || null]
          );
          return res.status(201).json(r.rows[0]);
        }
        if (mode === 'update') {
          await pool.query('UPDATE sharing_groups SET name=$1, description=$2 WHERE id=$3 AND clinic_id=$4', [name?.trim(), description?.trim() || null, group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        if (mode === 'delete') {
          await pool.query('DELETE FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [group_id, sgClinic]);
          return res.status(200).json({ success: true });
        }
        return res.status(400).json({ error: 'mode inválido' });
      }

      case 'manageSharingMember': {
        // mode: 'add' | 'remove'
        const suMSM = await getSessionUser(pool, req);
        if (!suMSM) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suMSM.role)) return res.status(403).json({ error: 'Sin permisos' });
        const sgClinic = suMSM.effective_clinic_id ?? suMSM.clinic_id;
        const { mode: mMode, group_id: gId, clinic_user_id: mUid } = body;
        // Verificar que el grupo pertenece a la clínica
        const gChk = await pool.query('SELECT id FROM sharing_groups WHERE id=$1 AND clinic_id=$2', [gId, sgClinic]);
        if (!gChk.rows.length) return res.status(403).json({ error: 'Grupo no encontrado en esta clínica' });
        if (mMode === 'add') {
          await pool.query('INSERT INTO sharing_group_members (group_id, clinic_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gId, mUid]);
        } else if (mMode === 'remove') {
          await pool.query('DELETE FROM sharing_group_members WHERE group_id=$1 AND clinic_user_id=$2', [gId, mUid]);
        }
        return res.status(200).json({ success: true });
      }

      // ─── Asignar/copiar paciente a otro usuario de la clínica ─────────────
      case 'assignPatient': {
        const suAsgn = await getSessionUser(pool, req);
        if (!suAsgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suAsgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: asgnPid, target_user_id } = body;
        if (!asgnPid || !target_user_id) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        // Verificar que el paciente pertenece a la clínica del admin
        const clinicIdAsgn = suAsgn.effective_clinic_id ?? suAsgn.clinic_id;
        const patChk = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [asgnPid]);
        if (!patChk.rows.length || patChk.rows[0].clinic_id !== clinicIdAsgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        // Verificar que el usuario destino pertenece a la misma clínica
        const userChk = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [target_user_id, clinicIdAsgn]);
        if (!userChk.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        await pool.query(
          `INSERT INTO patient_assignments (patient_id, clinic_user_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT (patient_id, clinic_user_id) DO NOTHING`,
          [asgnPid, target_user_id, suAsgn.user_id]
        );
        await logAudit(pool, { patientId: asgnPid, sessionUser: suAsgn, actionType: 'assign', module: 'patient', summary: `Paciente asignado al usuario ID ${target_user_id}` });
        return res.status(200).json({ success: true });
      }

      // ─── Remover asignación de un paciente a un usuario ──────────────────
      case 'unassignPatient': {
        const suUnasgn = await getSessionUser(pool, req);
        if (!suUnasgn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suUnasgn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: unasgnPid, target_user_id: unasgnUid } = body;
        if (!unasgnPid || !unasgnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdUnasgn = suUnasgn.effective_clinic_id ?? suUnasgn.clinic_id;
        const patChkU = await pool.query('SELECT clinic_id FROM patients WHERE id = $1', [unasgnPid]);
        if (!patChkU.rows.length || patChkU.rows[0].clinic_id !== clinicIdUnasgn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [unasgnPid, unasgnUid]);
        await logAudit(pool, { patientId: unasgnPid, sessionUser: suUnasgn, actionType: 'unassign', module: 'patient', summary: `Asignación removida del usuario ID ${unasgnUid}` });
        return res.status(200).json({ success: true });
      }

      // ─── Trasladar paciente: cambia el propietario (created_by_user_id) ──
      case 'transferPatient': {
        const suTrn = await getSessionUser(pool, req);
        if (!suTrn) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(suTrn.role)) return res.status(403).json({ error: 'Sin permisos' });
        const { patient_id: trnPid, target_user_id: trnUid } = body;
        if (!trnPid || !trnUid) return res.status(400).json({ error: 'patient_id y target_user_id requeridos' });
        const clinicIdTrn = suTrn.effective_clinic_id ?? suTrn.clinic_id;
        const patChkT = await pool.query('SELECT clinic_id, created_by_user_id FROM patients WHERE id = $1', [trnPid]);
        if (!patChkT.rows.length || patChkT.rows[0].clinic_id !== clinicIdTrn) {
          return res.status(403).json({ error: 'Paciente no pertenece a esta clínica' });
        }
        const userChkT = await pool.query('SELECT id FROM clinic_users WHERE id = $1 AND clinic_id = $2 AND is_active = true', [trnUid, clinicIdTrn]);
        if (!userChkT.rows.length) return res.status(404).json({ error: 'Usuario destino no encontrado en esta clínica' });
        const prevOwner = patChkT.rows[0].created_by_user_id;
        await pool.query('UPDATE patients SET created_by_user_id = $1, updated_at = NOW() WHERE id = $2', [trnUid, trnPid]);
        // Eliminar asignación previa del nuevo propietario si existía (evita duplicado lógico)
        await pool.query('DELETE FROM patient_assignments WHERE patient_id = $1 AND clinic_user_id = $2', [trnPid, trnUid]);
        await logAudit(pool, { patientId: trnPid, sessionUser: suTrn, actionType: 'transfer', module: 'patient', summary: `Paciente trasladado de usuario ID ${prevOwner} a ID ${trnUid}` });
        return res.status(200).json({ success: true });
      }

      case 'deleteRecord': {
        const { id: delRecordId } = req.query;
        // Tenant check: verify record belongs to user's clinic (C-3 fix)
        const suDR = await getSessionUserOnce();
        const drCid = suDR?.effective_clinic_id ?? suDR?.clinic_id;
        if (drCid != null && suDR?.role !== 'master_admin') {
          const chk = await pool.query(
            'SELECT p.clinic_id FROM patients p JOIN clinical_records cr ON cr.patient_id = p.id WHERE cr.id = $1',
            [delRecordId]
          );
          if (chk.rows.length && chk.rows[0].clinic_id !== drCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        try {
          await client.query('BEGIN');
          const consents = await pool.query(
            'SELECT id, signing_status, status, signature_data, signed_at, signing_signed_at, signatures FROM consent_forms WHERE record_id = $1 FOR UPDATE',
            [delRecordId]
          );
          const hasSignedConsent = consents.rows.some(row => row.signing_status === 'signed' ||
            ['signed', 'finalized'].includes(row.status) || row.signature_data || row.signed_at || row.signing_signed_at || row.signatures?.patient_sig_data || row.signatures?.patient_signed_at);
          if (hasSignedConsent) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar un expediente con consentimientos firmados.' });
          }
          await pool.query('DELETE FROM clinical_records WHERE id = $1', [delRecordId]);
          await client.query('COMMIT');
          return res.status(200).json({ success: true });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('Error deleting record:', err);
          return res.status(500).json({ error: 'Error al eliminar expediente.' });
        }
      }

      case 'getRecordData': {
        const { recordId, patientId } = req.query;
        let targetRecordId = recordId;

        // If no recordId provided, try to find one for the patient
        if ((!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') && patientId) {
           // Find record filtered by user scope
           const isOwnScope = su?.access_scope === 'own' && su?.user_id != null && su?.role !== 'master_admin';
           let r;
           if (isOwnScope) {
             r = await pool.query(
               "SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
               [patientId, su.user_id]
             );
             if (r.rows.length === 0) {
               r = await pool.query(
                 'SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $2 ORDER BY created_at DESC LIMIT 1',
                 [patientId, su.user_id]
               );
             }
           } else {
             r = await pool.query("SELECT id FROM clinical_records WHERE patient_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [patientId]);
             if (r.rows.length === 0) {
               r = await pool.query('SELECT id FROM clinical_records WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1', [patientId]);
             }
           }
           
           // If still no record, create one with user ownership
           if (r.rows.length === 0) {
             const newRec = await pool.query(
               'INSERT INTO clinical_records (patient_id, clinic_id, created_by_user_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
               [patientId, effectiveClinicId, su?.user_id || null, 'active']
             );
             targetRecordId = newRec.rows[0].id;
           } else {
             targetRecordId = r.rows[0].id;
           }
        }

        if (!targetRecordId || targetRecordId === 'undefined' || targetRecordId === 'null') {
          return res.status(404).json({ error: 'Record not found' });
        }

        const recordDetails = await pool.query(
          `SELECT cr.*, to_jsonb(p) AS patient
           FROM clinical_records cr
           LEFT JOIN patients p ON p.id = cr.patient_id
           WHERE cr.id = $1`,
          [targetRecordId]
        );
        
        if (recordDetails.rows.length === 0) {
           return res.status(404).json({ error: 'Record ID not found in database' });
        }

        const patientIdFromRecord = recordDetails.rows[0]?.patient_id;
        const patientDetails = recordDetails.rows[0]?.patient || null;

        // Tenant check: verify the record's patient belongs to the authenticated user's clinic (C-1 fix)
        const suGrd = await getSessionUserOnce();
        const grdCid = suGrd?.effective_clinic_id ?? suGrd?.clinic_id;
        if (grdCid != null && suGrd?.role !== 'master_admin') {
          if (patientDetails?.clinic_id != null && patientDetails.clinic_id !== grdCid)
            return res.status(403).json({ error: 'Acceso no autorizado' });
        }
        // own-scope: verify this record belongs to the current user
        if (suGrd?.access_scope === 'own' && suGrd?.user_id != null && suGrd?.role !== 'master_admin') {
          if (recordDetails.rows[0].created_by_user_id !== null &&
              recordDetails.rows[0].created_by_user_id !== suGrd.user_id) {
            return res.status(403).json({ error: 'No tienes permiso para acceder a este expediente' });
          }
        }

        // Helper to safely query tables that might not exist yet
        const safeQuery = async (query, params) => {
          try {
            return await pool.query(query, params);
          } catch (err) {
            if (err.code === '42P01') { // undefined_table
              return { rows: [] };
            }
            if (err.code === '42703') { // undefined_column
              console.warn(`⚠️ Column missing in query: ${query}`, err.message);
              return { rows: [] };
            }
            throw err;
          }
        };

        const [
          history, 
          physical, 
          diagnoses, 
          treatments, 
          prescriptions, 
          consents, 
          injectables,
          consultation,
          consultationHistory
        ] = await Promise.all([
          safeQuery('SELECT * FROM medical_history WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM physical_exams WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId]),
          safeQuery('SELECT * FROM diagnoses WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM treatments WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery(`SELECT ${CONSENT_SAFE_COLUMNS} FROM consent_forms WHERE record_id = $1 ORDER BY id DESC`, [targetRecordId]),
          safeQuery('SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC', [targetRecordId]),
          safeQuery('SELECT * FROM consultation_info WHERE record_id = $1', [targetRecordId]),
          safeQuery('SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC', [targetRecordId])
        ]);

        return res.status(200).json({
          recordId: targetRecordId,
          patientId: patientIdFromRecord,
          patient: patientDetails,
          history: history.rows[0] || {},
          physicalExams: physical.rows,
          diagnoses: diagnoses.rows,
          treatments: treatments.rows,
          prescriptions: prescriptions.rows,
          consentForms: consents.rows,
          injectables: injectables.rows,
          consultation: consultation.rows[0] || {},
          consultations: consultationHistory.rows || []
        });
      }

      case 'deleteConsultationHistory': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'ID required' });
        await pool.query('DELETE FROM consultation_history WHERE id = $1', [id]);
        return res.status(200).json({ success: true });
      }

      // ── Consultas (hub de sesión) ────────────────────────────────────────

      case 'listConsultations': {
        const { record_id: lcRid } = req.query;
        if (!lcRid) return res.status(400).json({ error: 'record_id required' });
        const lcRes = await pool.query(
          'SELECT * FROM consultations WHERE record_id = $1 ORDER BY created_at DESC',
          [lcRid]
        );
        return res.status(200).json(lcRes.rows);
      }

      case 'createConsultation': {
        const { record_id: ccRid, reason: ccReason, current_illness: ccIllness,
                enable_injectables: ccInj = false, enable_consents: ccCons = false } = body;
        if (!ccRid) return res.status(400).json({ error: 'record_id required' });
        const newCons = await pool.query(
          `INSERT INTO consultations (record_id, clinic_id, reason, current_illness, enable_injectables, enable_consents)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [ccRid, effectiveClinicId, ccReason, ccIllness, ccInj, ccCons]
        );
        await logAudit(pool, { recordId: ccRid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'consultation', summary: `Nueva consulta: ${ccReason || ''}` });
        return res.status(201).json(newCons.rows[0]);
      }

      case 'updateConsultation': {
        const { id: ucId, ...ucFields } = body;
        if (!ucId) return res.status(400).json({ error: 'id required' });
        const allowed = ['reason', 'current_illness', 'enable_injectables', 'enable_consents'];
        const safe = Object.fromEntries(Object.entries(ucFields).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(safe).length) return res.status(400).json({ error: 'No valid fields' });
        const setClause = Object.keys(safe).map((f, i) => `${f} = $${i + 2}`).join(', ');
        const ucRow = await pool.query(
          `UPDATE consultations SET ${setClause}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [ucId, ...Object.values(safe)]
        );
        return res.status(200).json(ucRow.rows[0] || { success: true });
      }

      case 'deleteConsultation': {
        const { id: dcId } = req.query;
        if (!dcId) return res.status(400).json({ error: 'id required' });
        await client.query('BEGIN');
        try {
          const consultation = await pool.query(
            'SELECT id, record_id, clinic_id FROM consultations WHERE id = $1 FOR UPDATE',
            [dcId]
          );
          if (!consultation.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'La consulta ya no existe.' });
          }
          const consents = await pool.query(
            'SELECT id, signing_status, status, signature_data, signed_at, signing_signed_at, signatures FROM consent_forms WHERE consultation_id = $1 FOR UPDATE',
            [dcId]
          );
          const hasSignedConsent = consents.rows.some(row => row.signing_status === 'signed' ||
            ['signed', 'finalized'].includes(row.status) || row.signature_data || row.signed_at || row.signing_signed_at || row.signatures?.patient_sig_data || row.signatures?.patient_signed_at);
          if (hasSignedConsent) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar una consulta con consentimientos firmados.' });
          }
          const accountingDependencies = await pool.query(
            `SELECT
               EXISTS(SELECT 1 FROM treatment_packages WHERE consultation_id = $1) AS has_packages,
               EXISTS(
                 SELECT 1 FROM financial_records
                 WHERE source_module = 'treatments' AND source_consultation_id = $1
               ) AS has_finance`,
            [dcId]
          );
          if (accountingDependencies.rows[0]?.has_packages || accountingDependencies.rows[0]?.has_finance) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar una consulta con paquetes o cobros registrados.' });
          }
          const detachedRows = await detachConsultationChildren(pool, dcId);
          await pool.query('DELETE FROM consultations WHERE id = $1', [dcId]);
          await logAudit(pool, {
            recordId: consultation.rows[0].record_id,
            clinicId: consultation.rows[0].clinic_id,
            sessionUser: await getSessionUserOnce(),
            actionType: 'delete',
            module: 'consultation',
            summary: `Eliminó la consulta ${dcId}; se conservaron ${detachedRows} registros clínicos desasociados`,
          });
          await client.query('COMMIT');
          return res.status(200).json({
            success: true,
            detachedRows,
            message: `Consulta eliminada. Se conservaron ${detachedRows} registros clínicos en el expediente.`,
          });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      case 'listHistorySnapshots': {
        const { record_id: lhsRid } = req.query;
        if (!lhsRid) return res.status(400).json({ error: 'record_id required' });
        const snaps = await pool.query(
          'SELECT id, changed_by, created_at, snapshot_data FROM medical_history_snapshots WHERE record_id = $1 ORDER BY created_at DESC',
          [lhsRid]
        );
        return res.status(200).json(snaps.rows);
      }

      case 'saveConsultation': {
        const { recordId, reason, current_illness } = body;
        
        if (!recordId) return res.status(400).json({ error: 'Record ID required' });

        // Check if exists
        const existing = await pool.query('SELECT id FROM consultation_info WHERE record_id = $1', [recordId]);

        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE consultation_info SET reason = $1, current_illness = $2, updated_at = NOW() WHERE record_id = $3',
            [reason, current_illness, recordId]
          );
        } else {
          await pool.query(
            'INSERT INTO consultation_info (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
            [recordId, effectiveClinicId, reason, current_illness]
          );
        }
        
        // Save to history
        if ((reason && reason.trim()) || (current_illness && current_illness.trim())) {
          try {
            await pool.query(
              'INSERT INTO consultation_history (record_id, clinic_id, reason, current_illness) VALUES ($1, $2, $3, $4)',
              [recordId, effectiveClinicId, reason, current_illness]
            );
          } catch (histErr) {
            console.error('Error saving consultation history:', histErr);
          }
        }
        await logAudit(pool, { recordId, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'consultation', summary: 'Guardó Motivo de Consulta' });
        return res.status(200).json({ success: true });
      }

      case 'saveHistory': {
        const { record_id: hid, ...historyData } = body;
        delete historyData.id;
        delete historyData.created_at;
        delete historyData.updated_at;
        // Whitelist: solo identificadores SQL válidos (\w+) — previene SQL injection por nombres de columna
        const safeHistData = Object.fromEntries(Object.entries(historyData).filter(([k]) => /^\w+$/.test(k)));

        const existingHistory = await pool.query('SELECT id FROM medical_history WHERE record_id = $1', [hid]);
        if (existingHistory.rows.length > 0) {
           const hFields = Object.keys(safeHistData);
           const hValues = Object.values(safeHistData);
           if (hFields.length > 0) {
             const hSet = hFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE medical_history SET ${hSet}, updated_at = NOW() WHERE record_id = $1`, [hid, ...hValues]);
           }
        } else {
           const safeHistNoClinic = Object.fromEntries(Object.entries(safeHistData).filter(([k]) => k !== 'clinic_id'));
           const hFields = ['record_id', 'clinic_id', ...Object.keys(safeHistNoClinic)];
           const hValues = [hid, effectiveClinicId, ...Object.values(safeHistNoClinic)];
           const hParams = hFields.map((_, i) => `$${i + 1}`).join(', ');
           await pool.query(`INSERT INTO medical_history (${hFields.join(', ')}) VALUES (${hParams})`, hValues);
        }
        await logAudit(pool, { recordId: hid, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'history', summary: 'Guardó Antecedentes Médicos' });
        // Save full snapshot for version history
        try {
          const snapUser = (await getSessionUserOnce())?.username || 'unknown';
          await pool.query(
            'INSERT INTO medical_history_snapshots (record_id, clinic_id, snapshot_data, changed_by) VALUES ($1, $2, $3, $4)',
            [hid, effectiveClinicId, JSON.stringify(safeHistData), snapUser]
          );
        } catch (snapErr) { console.warn('Snapshot save warning:', snapErr.message); }
        return res.status(200).json({ success: true });
      }

      case 'savePhysicalExam': {
        const { id: examId, record_id: pid_exam, created_at, ...examData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id se excluye: lo fija el servidor via effectiveClinicId, nunca el cliente
        const safeExamData = Object.fromEntries(Object.entries(examData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id'));
        
        if (examId) {
           const eFields = Object.keys(safeExamData);
           const eValues = Object.values(safeExamData);
           if (eFields.length > 0) {
             const eSet = eFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE physical_exams SET ${eSet} WHERE id = $1`, [examId, ...eValues]);
           }
           return res.status(200).json({ success: true, id: examId });
        } else {
           if (!pid_exam) return res.status(400).json({ error: 'Falta el ID del expediente (record_id)' });
           const eFields = ['record_id', 'clinic_id', ...Object.keys(safeExamData)];
           const eValues = [pid_exam, effectiveClinicId, ...Object.values(safeExamData)];
           const eParams = eFields.map((_, i) => `$${i + 1}`).join(', ');
           const newExam = await pool.query(`INSERT INTO physical_exams (${eFields.join(', ')}) VALUES (${eParams}) RETURNING id`, eValues);
           return res.status(200).json({ success: true, id: newExam.rows[0].id });
        }
      }

      case 'deletePhysicalExam': {
        const { id: delExamId } = req.query;
        if (!(await ownedByClinic(pool, 'physical_exams', delExamId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM physical_exams WHERE id = $1', [delExamId]);
        return res.status(200).json({ success: true });
      }

      case 'saveDiagnosis': {
        const { id: diagId, record_id: did, date: diagDate, ...diagData } = body;
        // Whitelist: solo identificadores SQL válidos — previene SQL injection por nombres de columna
        // clinic_id se excluye: lo fija el servidor via effectiveClinicId, nunca el cliente
        const safeDiagData = Object.fromEntries(Object.entries(diagData).filter(([k]) => /^\w+$/.test(k) && k !== 'clinic_id'));
        if (diagId) {
           const dFields = Object.keys(safeDiagData);
           const dValues = Object.values(safeDiagData);
           if (dFields.length > 0) {
             const dSet = dFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
             await pool.query(`UPDATE diagnoses SET ${dSet} WHERE id = $1`, [diagId, ...dValues]);
           }
           return res.status(200).json({ success: true });
        } else {
           const dFields = ['record_id', 'clinic_id', ...Object.keys(safeDiagData)];
           const dValues = [did, effectiveClinicId, ...Object.values(safeDiagData)];
           const dParams = dFields.map((_, i) => `$${i + 1}`).join(', ');
           const newDiag = await pool.query(`INSERT INTO diagnoses (${dFields.join(', ')}) VALUES (${dParams}) RETURNING *`, dValues);
           await logAudit(pool, { recordId: did, sessionUser: await getSessionUserOnce(), actionType: 'tab_save', module: 'diagnosis', summary: 'Registró Diagnóstico' });
           return res.status(201).json(newDiag.rows[0]);
        }
      }

      case 'deleteDiagnosis': {
        const { id: delDiagId } = req.query;
        if (!(await ownedByClinic(pool, 'diagnoses', delDiagId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM diagnoses WHERE id = $1', [delDiagId]);
        return res.status(200).json({ success: true });
      }

      case 'addTreatment': {
        const { record_id: tid, finance_posting: rawFinancePosting, ...treatData } = body;
        const safeTreatData = Object.fromEntries(Object.entries(treatData).filter(([key]) => TREATMENT_WRITE_FIELDS.has(key)));
        if (safeTreatData.treatment_mode && !TREATMENT_MODES.has(safeTreatData.treatment_mode)) {
          return res.status(400).json({ error: 'treatment_mode inválido' });
        }
        const consultationId = Number(safeTreatData.consultation_id);
        if (!Number.isSafeInteger(consultationId) || consultationId <= 0) {
          return res.status(400).json({ error: 'consultation_id válido es requerido' });
        }
        try {
          safeTreatData.cost = normalizeMoney(safeTreatData.cost || 0, 'Costo');
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }
        let financePosting;
        try {
          financePosting = normalizeFinancePosting(rawFinancePosting, safeTreatData.cost);
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }
        if (safeTreatData.parameters && typeof safeTreatData.parameters === 'object') {
          safeTreatData.parameters = JSON.stringify(safeTreatData.parameters);
        }
        if (safeTreatData.area_marker && typeof safeTreatData.area_marker === 'object') {
          safeTreatData.area_marker = JSON.stringify(safeTreatData.area_marker);
        }
        try {
          await client.query('BEGIN');
          await assertConsultationBelongsToRecord(client, consultationId, tid, effectiveClinicId);
          if (financePosting) {
            assertTreatmentFinancePermission(await getSessionUserOnce());
            const existing = await findIdempotentTreatmentPosting(client, {
              clinicId: effectiveClinicId,
              idempotencyKey: financePosting.idempotencyKey,
              sourceType: 'treatment_session',
              recordId: tid,
              consultationId,
              posting: financePosting,
            });
            if (existing) {
              const existingTreatment = await client.query('SELECT * FROM treatments WHERE id = $1', [existing.source_id]);
              await client.query('COMMIT');
              return res.status(200).json(existingTreatment.rows[0]);
            }
          }
          let treatmentPackage = null;
          if (safeTreatData.package_id) {
            treatmentPackage = await assertPackagePaymentWithinBalance(client, {
              packageId: safeTreatData.package_id,
              recordId: tid,
              consultationId,
              clinicId: effectiveClinicId,
              treatmentMode: safeTreatData.treatment_mode,
              amount: safeTreatData.cost,
            });
          }
          const tFields = ['record_id', 'clinic_id', ...Object.keys(safeTreatData)];
          const tValues = [tid, effectiveClinicId, ...Object.values(safeTreatData)];
          const tParams = tFields.map((_, i) => `$${i + 1}`).join(', ');
          const newTreat = await client.query(`INSERT INTO treatments (${tFields.join(', ')}) VALUES (${tParams}) RETURNING *`, tValues);
          const treatment = newTreat.rows[0];
          if (financePosting) {
            const packageName = treatmentPackage?.name;
            await createTreatmentFinancePosting(client, {
              posting: financePosting,
              clinicId: effectiveClinicId,
              sessionUser: await getSessionUserOnce(),
              sourceType: 'treatment_session',
              sourceId: treatment.id,
              packageId: treatment.package_id || null,
              recordId: tid,
              consultationId,
              date: treatment.date,
              description: packageName
                ? `Paquete ${packageName} · sesión ${treatment.procedure_name}`
                : `Sesión individual · ${treatment.procedure_name}`,
            });
          }
          await logAudit(client, { recordId: tid, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'treatment', summary: `Agregó tratamiento: ${safeTreatData.procedure_name || ''}` });
          await client.query('COMMIT');
          return res.status(201).json(treatment);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          if (error.code === '23505' && financePosting) {
            try {
              const existing = await findIdempotentTreatmentPosting(client, {
                clinicId: effectiveClinicId,
                idempotencyKey: financePosting.idempotencyKey,
                sourceType: 'treatment_session',
                recordId: tid,
                consultationId,
                posting: financePosting,
              });
              if (existing) {
                const existingTreatment = await client.query('SELECT * FROM treatments WHERE id = $1', [existing.source_id]);
                return res.status(200).json(existingTreatment.rows[0]);
              }
            } catch (idempotencyError) {
              return res.status(409).json({ error: idempotencyError.message });
            }
          }
          if (error.code === 'FINANCE_FORBIDDEN') return res.status(403).json({ error: error.message });
          if (error.code === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ error: error.message });
          if (error.message.includes('consulta') || error.message.includes('package_id') || error.message.includes('Expediente') || error.message.includes('abono') || error.message.includes('Finanzas')) {
            return res.status(400).json({ error: error.message });
          }
          throw error;
        }
      }

      case 'updateTreatment': {
        const { id: upTreatId, finance_posting: rawFinancePosting, ...upTreatData } = body;
        if (!(await ownedByClinic(pool, 'treatments', upTreatId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        const safeUpTreat = Object.fromEntries(Object.entries(upTreatData).filter(([key]) => TREATMENT_WRITE_FIELDS.has(key)));
        if (safeUpTreat.treatment_mode && !TREATMENT_MODES.has(safeUpTreat.treatment_mode))
          return res.status(400).json({ error: 'treatment_mode inválido' });
        let financePosting;
        if (Object.hasOwn(safeUpTreat, 'cost')) {
          try {
            safeUpTreat.cost = normalizeMoney(safeUpTreat.cost, 'Costo');
          } catch (validationError) {
            return res.status(400).json({ error: validationError.message });
          }
        }
        if (safeUpTreat.parameters && typeof safeUpTreat.parameters === 'object') {
          safeUpTreat.parameters = JSON.stringify(safeUpTreat.parameters);
        }
        if (safeUpTreat.area_marker && typeof safeUpTreat.area_marker === 'object') {
          safeUpTreat.area_marker = JSON.stringify(safeUpTreat.area_marker);
        }
        try {
          await client.query('BEGIN');
          const currentResult = await client.query('SELECT * FROM treatments WHERE id = $1 FOR UPDATE', [upTreatId]);
          const currentTreatment = currentResult.rows[0];
          const mergedTreatment = { ...currentTreatment, ...safeUpTreat };
          const recordId = currentTreatment?.record_id;
          const consultationId = Number(mergedTreatment.consultation_id);
          if (!Number.isSafeInteger(consultationId) || consultationId <= 0) throw new Error('consultation_id válido es requerido');
          if (!TREATMENT_MODES.has(mergedTreatment.treatment_mode)) throw new Error('treatment_mode inválido');
          mergedTreatment.cost = normalizeMoney(mergedTreatment.cost || 0, 'Costo');
          financePosting = normalizeFinancePosting(rawFinancePosting, mergedTreatment.cost);
          await assertConsultationBelongsToRecord(client, consultationId, recordId, effectiveClinicId);
          const postedResult = await client.query(
            `SELECT id, idempotency_key FROM financial_records
             WHERE clinic_id = $1 AND source_module = 'treatments'
               AND source_type = 'treatment_session' AND source_id = $2`,
            [effectiveClinicId, upTreatId]
          );
          if (postedResult.rowCount) {
            const immutableChanged = Number(mergedTreatment.cost) !== Number(currentTreatment.cost)
              || Number(mergedTreatment.consultation_id) !== Number(currentTreatment.consultation_id)
              || Number(mergedTreatment.package_id || 0) !== Number(currentTreatment.package_id || 0)
              || String(mergedTreatment.date || '').slice(0, 10) !== String(currentTreatment.date || '').slice(0, 10)
              || String(mergedTreatment.procedure_name || '') !== String(currentTreatment.procedure_name || '');
            if (immutableChanged) {
              const error = new Error('El cobro ya fue registrado; costo, fecha, consulta, paquete y procedimiento no pueden modificarse sin un ajuste financiero');
              error.code = 'POSTED_SOURCE_LOCKED';
              throw error;
            }
          }
          if (financePosting) {
            assertTreatmentFinancePermission(await getSessionUserOnce());
            const existing = await findIdempotentTreatmentPosting(client, {
              clinicId: effectiveClinicId,
              idempotencyKey: financePosting.idempotencyKey,
              sourceType: 'treatment_session',
              recordId,
              consultationId,
              sourceId: Number(upTreatId),
              posting: financePosting,
            });
            if (existing) financePosting = null;
          }
          let treatmentPackage = null;
          if (mergedTreatment.package_id) {
            treatmentPackage = await assertPackagePaymentWithinBalance(client, {
              packageId: mergedTreatment.package_id,
              recordId,
              consultationId,
              clinicId: effectiveClinicId,
              treatmentMode: mergedTreatment.treatment_mode,
              amount: mergedTreatment.cost,
              excludeTreatmentId: Number(upTreatId),
            });
          }
          const upTFields = Object.keys(safeUpTreat);
          const upTValues = Object.values(safeUpTreat);
          if (upTFields.length > 0) {
            const upTSet = upTFields.map((field, index) => `${field} = $${index + 2}`).join(', ');
            await client.query(`UPDATE treatments SET ${upTSet} WHERE id = $1`, [upTreatId, ...upTValues]);
          }
          if (financePosting) {
            const packageName = treatmentPackage?.name;
            await createTreatmentFinancePosting(client, {
              posting: financePosting,
              clinicId: effectiveClinicId,
              sessionUser: await getSessionUserOnce(),
              sourceType: 'treatment_session',
              sourceId: Number(upTreatId),
              packageId: mergedTreatment.package_id || null,
              recordId,
              consultationId,
              date: mergedTreatment.date,
              description: packageName
                ? `Paquete ${packageName} · sesión ${mergedTreatment.procedure_name}`
                : `Sesión individual · ${mergedTreatment.procedure_name}`,
            });
          }
          await client.query('COMMIT');
          return res.status(200).json({ success: true, id: Number(upTreatId) });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          if (error.code === '23505' && rawFinancePosting?.idempotency_key) {
            try {
              const current = await client.query('SELECT record_id, consultation_id FROM treatments WHERE id = $1', [upTreatId]);
              const existing = await findIdempotentTreatmentPosting(client, {
                clinicId: effectiveClinicId,
                idempotencyKey: rawFinancePosting.idempotency_key,
                sourceType: 'treatment_session',
                recordId: current.rows[0]?.record_id,
                consultationId: current.rows[0]?.consultation_id,
                sourceId: Number(upTreatId),
                posting: financePosting,
              });
              if (existing) return res.status(200).json({ success: true, id: Number(upTreatId) });
            } catch (idempotencyError) {
              return res.status(409).json({ error: idempotencyError.message });
            }
          }
          if (error.code === 'FINANCE_FORBIDDEN') return res.status(403).json({ error: error.message });
          if (['IDEMPOTENCY_CONFLICT', 'POSTED_SOURCE_LOCKED'].includes(error.code)) {
            return res.status(409).json({ error: error.message });
          }
          if (error.message.includes('consulta') || error.message.includes('package_id') || error.message.includes('abono') || error.message.includes('Finanzas')) {
            return res.status(400).json({ error: error.message });
          }
          throw error;
        }
      }

      case 'updateSchema':
        try {
          await pool.query('ALTER TABLE treatments ADD COLUMN IF NOT EXISTS ai_suggestion TEXT');
          return res.status(200).json({ message: 'Schema updated successfully' });
        } catch (err) {
          console.error('Schema update error:', err);
          return res.status(500).json({ error: err.message });
        }

      case 'deleteTreatment': {
        const { id: delTreatId } = req.query;
        try {
          await client.query('BEGIN');
          const treatment = await client.query(
            'SELECT id FROM treatments WHERE id = $1 AND clinic_id = $2 FOR UPDATE',
            [delTreatId, effectiveClinicId]
          );
          if (treatment.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sin permiso' });
          }
          const postedTreatment = await client.query(
            `SELECT 1 FROM financial_records
             WHERE clinic_id = $1 AND source_module = 'treatments'
               AND source_type = 'treatment_session' AND source_id = $2`,
            [effectiveClinicId, delTreatId]
          );
          if (postedTreatment.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar una sesión con un cobro registrado en Finanzas.' });
          }
          await client.query('DELETE FROM treatments WHERE id = $1', [delTreatId]);
          await client.query('COMMIT');
          return res.status(200).json({ success: true });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }

      // --- PAQUETES DE TRATAMIENTO ---

      case 'createPackage': {
        const {
          record_id: pkgRecordId, consultation_id: rawPkgConsultId, treatment_mode: pkgMode,
          name: pkgName, total_cost: rawPkgCost, estimated_sessions: rawPkgSessions,
          initial_payment: rawPkgInitial, finance_posting: rawFinancePosting,
        } = body;
        const pkgConsultId = Number(rawPkgConsultId);
        const pkgSessions = Number(rawPkgSessions);
        if (!pkgRecordId || !pkgName?.trim() || !TREATMENT_MODES.has(pkgMode) || !Number.isSafeInteger(pkgConsultId) || pkgConsultId <= 0) {
          return res.status(400).json({ error: 'Expediente, consulta, nombre y modo de tratamiento son requeridos' });
        }
        if (!Number.isSafeInteger(pkgSessions) || pkgSessions < 1 || pkgSessions > 100) {
          return res.status(400).json({ error: 'Las sesiones estimadas deben estar entre 1 y 100' });
        }
        let pkgCost;
        let pkgInitial;
        let financePosting;
        try {
          pkgCost = normalizeMoney(rawPkgCost || 0, 'Costo total');
          pkgInitial = normalizeMoney(rawPkgInitial || 0, 'Abono inicial');
          if (pkgInitial > pkgCost) throw new Error('El abono inicial no puede superar el costo total');
          financePosting = normalizeFinancePosting(rawFinancePosting, pkgInitial);
        } catch (validationError) {
          return res.status(400).json({ error: validationError.message });
        }
        try {
          await client.query('BEGIN');
          await assertConsultationBelongsToRecord(client, pkgConsultId, pkgRecordId, effectiveClinicId);
          if (financePosting) {
            assertTreatmentFinancePermission(await getSessionUserOnce());
            const existing = await findIdempotentTreatmentPosting(client, {
              clinicId: effectiveClinicId,
              idempotencyKey: financePosting.idempotencyKey,
              sourceType: 'treatment_package_initial',
              recordId: pkgRecordId,
              consultationId: pkgConsultId,
              posting: financePosting,
            });
            if (existing) {
              const existingPackage = await client.query('SELECT * FROM treatment_packages WHERE id = $1', [existing.source_id]);
              await client.query('COMMIT');
              return res.status(200).json(existingPackage.rows[0]);
            }
          }
          const newPkg = await client.query(
            `INSERT INTO treatment_packages (record_id, clinic_id, consultation_id, treatment_mode, name, total_cost, estimated_sessions, initial_payment)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [pkgRecordId, effectiveClinicId, pkgConsultId, pkgMode, pkgName.trim(), pkgCost, pkgSessions, pkgInitial]
          );
          const treatmentPackage = newPkg.rows[0];
          if (financePosting) {
            await createTreatmentFinancePosting(client, {
              posting: financePosting,
              clinicId: effectiveClinicId,
              sessionUser: await getSessionUserOnce(),
              sourceType: 'treatment_package_initial',
              sourceId: treatmentPackage.id,
              packageId: treatmentPackage.id,
              recordId: pkgRecordId,
              consultationId: pkgConsultId,
              date: treatmentPackage.created_at,
              description: `Paquete ${treatmentPackage.name} · abono inicial`,
            });
          }
          await logAudit(client, { recordId: pkgRecordId, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'treatment_package', summary: `Creó paquete: ${pkgName.trim()}` });
          await client.query('COMMIT');
          return res.status(201).json(treatmentPackage);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          if (error.code === '23505' && financePosting) {
            try {
              const existing = await findIdempotentTreatmentPosting(client, {
                clinicId: effectiveClinicId,
                idempotencyKey: financePosting.idempotencyKey,
                sourceType: 'treatment_package_initial',
                recordId: pkgRecordId,
                consultationId: pkgConsultId,
                posting: financePosting,
              });
              if (existing) {
                const existingPackage = await client.query('SELECT * FROM treatment_packages WHERE id = $1', [existing.source_id]);
                return res.status(200).json(existingPackage.rows[0]);
              }
            } catch (idempotencyError) {
              return res.status(409).json({ error: idempotencyError.message });
            }
          }
          if (error.code === 'FINANCE_FORBIDDEN') return res.status(403).json({ error: error.message });
          if (error.code === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ error: error.message });
          if (error.message.includes('consulta') || error.message.includes('Expediente') || error.message.includes('Finanzas')) {
            return res.status(400).json({ error: error.message });
          }
          throw error;
        }
      }

      case 'listPackagesByRecord': {
        const { record_id: lpRecordId, consultation_id: rawLpConsultId, treatment_mode: lpMode } = req.query;
        const lpConsultId = Number(rawLpConsultId);
        if (!lpRecordId || !Number.isSafeInteger(lpConsultId) || lpConsultId <= 0 || !TREATMENT_MODES.has(lpMode)) {
          return res.status(400).json({ error: 'record_id, consultation_id y treatment_mode válidos son requeridos' });
        }
        const consultationCheck = await pool.query(
          'SELECT 1 FROM consultations WHERE id = $1 AND record_id = $2 AND clinic_id = $3',
          [lpConsultId, lpRecordId, effectiveClinicId]
        );
        if (consultationCheck.rowCount === 0) {
          return res.status(400).json({ error: 'La consulta no pertenece a este expediente' });
        }
        const pkgs = await pool.query(
          `SELECT tp.*,
             COALESCE(SUM(t.cost), 0)::float AS sessions_paid,
             COUNT(t.id)::int AS sessions_count
           FROM treatment_packages tp
           LEFT JOIN treatments t ON t.package_id = tp.id
             AND t.record_id = tp.record_id
             AND t.consultation_id = tp.consultation_id
           WHERE tp.record_id = $1
             AND tp.consultation_id = $2
             AND tp.treatment_mode = $3
           GROUP BY tp.id
           ORDER BY tp.created_at DESC`,
          [lpRecordId, lpConsultId, lpMode]
        );
        return res.status(200).json(pkgs.rows);
      }

      case 'deletePackage': {
        const { id: delPkgId } = req.query;
        try {
          await client.query('BEGIN');
          const treatmentPackage = await client.query(
            'SELECT id FROM treatment_packages WHERE id = $1 AND clinic_id = $2 FOR UPDATE',
            [delPkgId, effectiveClinicId]
          );
          if (treatmentPackage.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Sin permiso' });
          }
          const postedPackage = await client.query(
            `SELECT 1 FROM financial_records
             WHERE clinic_id = $1 AND source_module = 'treatments' AND source_package_id = $2`,
            [effectiveClinicId, delPkgId]
          );
          if (postedPackage.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede eliminar un paquete con cobros registrados en Finanzas.' });
          }
          await client.query('DELETE FROM treatment_packages WHERE id = $1', [delPkgId]);
          await client.query('COMMIT');
          return res.status(200).json({ success: true });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }

      // --- INYECTABLES ---

      case 'getInjectablesByRecord': {
        const { record_id: injRecordId } = req.query;
        if (!injRecordId) return res.status(400).json({ error: 'record_id required' });
        const injByRecord = await pool.query(
          'SELECT * FROM injectables WHERE record_id = $1 ORDER BY date DESC',
          [injRecordId]
        );
        return res.status(200).json(injByRecord.rows);
      }

      case 'getInjectablesByTreatment': {
        const { treatment_id: injTreatId } = req.query;
        if (!injTreatId) return res.status(400).json({ error: 'treatment_id required' });
        const injList = await pool.query(
          'SELECT * FROM injectables WHERE treatment_id = $1 ORDER BY date DESC',
          [injTreatId]
        );
        return res.status(200).json(injList.rows);
      }

      case 'addInjectable': {
        const { record_id: injRecId, treatment_id: injTid, ...injData } = body;
        if (!injRecId) return res.status(400).json({ error: 'record_id required' });

        // Sanitize fields
        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
        ];
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        const numericFields = ['volume_used', 'units_used', 'dilution_volume'];
        const cleanData = {};
        for (const key of allowedFields) {
          if (injData[key] !== undefined) {
            let val = injData[key];
            // Convert empty strings to null for date and numeric fields
            if (typeof val === 'string' && val.trim() === '' && (dateFields.includes(key) || numericFields.includes(key))) {
              val = null;
            }
            if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            // Skip null/empty optional fields to avoid type errors
            if (val === null && key !== 'date') continue;
            cleanData[key] = val;
          }
        }

        const fields = ['record_id', 'clinic_id', ...Object.keys(cleanData)];
        const values = [injRecId, effectiveClinicId, ...Object.values(cleanData)];

        // Include treatment_id only if provided (column may not exist in older schemas)
        if (injTid) {
          fields.push('treatment_id');
          values.push(injTid);
        }

        const params = fields.map((_, i) => `$${i + 1}`).join(', ');
        const newInj = await pool.query(
          `INSERT INTO injectables (${fields.join(', ')}) VALUES (${params}) RETURNING *`,
          values
        );
        await logAudit(pool, { recordId: injRecId, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'injectable', summary: `Registró inyectable: ${cleanData.product_name || ''} (${cleanData.product_type || ''})` });
        return res.status(201).json(newInj.rows[0]);
      }

      case 'updateInjectable': {
        const { id: updInjId, ...updInjData } = body;
        if (!updInjId) return res.status(400).json({ error: 'id required' });

        const allowedFields = [
          'date', 'product_type', 'product_name', 'brand', 'lot_number',
          'expiration_date', 'volume_used', 'units_used', 'areas_treated',
          'technique', 'injection_plane', 'needle_type', 'mapping_data', 'notes',
          'dilution_volume', 'follow_up_date', 'relleno_subtype', 'consultation_id'
        ];
        const cleanData = {};
        const dateFields = ['date', 'expiration_date', 'follow_up_date'];
        for (const key of allowedFields) {
          if (updInjData[key] !== undefined) {
            let val = updInjData[key];
            // Convertir string vacío a null en campos de tipo date
            if (dateFields.includes(key) && (val === '' || val === null)) {
              val = null;
            } else if (['areas_treated', 'mapping_data'].includes(key) && typeof val === 'object') {
              val = JSON.stringify(val);
            }
            cleanData[key] = val;
          }
        }

        const uFields = Object.keys(cleanData);
        const uValues = Object.values(cleanData);
        if (uFields.length === 0) return res.status(400).json({ error: 'No fields to update' });

        const uSet = uFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        await pool.query(`UPDATE injectables SET ${uSet} WHERE id = $1`, [updInjId, ...uValues]);
        return res.status(200).json({ success: true });
      }

      case 'deleteInjectable': {
        const { id: delInjId } = req.query;
        if (!delInjId) return res.status(400).json({ error: 'id required' });
        if (!(await ownedByClinic(pool, 'injectables', delInjId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        await pool.query('DELETE FROM injectables WHERE id = $1', [delInjId]);
        return res.status(200).json({ success: true });
      }

      // ── Catálogo global de inyectables (seeds gestionados por master admin) ──

      case 'listInjectableCatalog': {
        const cat = await pool.query(
          'SELECT id, categoria, elemento, descripcion FROM injectable_catalog WHERE activo = 1 ORDER BY categoria, elemento'
        );
        return res.status(200).json(cat.rows);
      }

      case 'saveInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        // El catálogo es global y sin tenant: el rol de aplicación solo lo lee, y estas
        // escrituras (ya restringidas a master_admin) pasan por el pool administrador.
        const adminPool = getPool();
        if (!adminPool) return res.status(503).json({ error: 'Base de datos no disponible' });
        const { id: seedId, categoria: seedCat, elemento: seedEl, descripcion: seedDesc } = body;
        if (!seedCat || !seedEl) return res.status(400).json({ error: 'categoria y elemento requeridos' });
        if (seedId) {
          await adminPool.query(
            'UPDATE injectable_catalog SET categoria=$2, elemento=$3, descripcion=$4 WHERE id=$1',
            [seedId, seedCat.trim(), seedEl.trim(), seedDesc || null]
          );
          return res.status(200).json({ success: true });
        }
        const newSeed = await adminPool.query(
          'INSERT INTO injectable_catalog(categoria, elemento, descripcion) VALUES($1,$2,$3) RETURNING id',
          [seedCat.trim(), seedEl.trim(), seedDesc || null]
        );
        return res.status(201).json(newSeed.rows[0]);
      }

      case 'deleteInjectableSeed': {
        const sess = await getSessionUserOnce();
        if (!sess || sess.role !== 'master_admin') return res.status(403).json({ error: 'Forbidden' });
        const adminPool = getPool();
        if (!adminPool) return res.status(503).json({ error: 'Base de datos no disponible' });
        const { id: delSeedId } = req.query;
        if (!delSeedId) return res.status(400).json({ error: 'id required' });
        await adminPool.query('UPDATE injectable_catalog SET activo=0 WHERE id=$1', [delSeedId]);
        return res.status(200).json({ success: true });
      }

      case 'listPrescriptions':
        const { record_id: presc_record_id } = req.query;
        const prescriptionsList = await pool.query('SELECT * FROM prescriptions WHERE record_id = $1 ORDER BY date DESC, id DESC', [presc_record_id]);
        const mappedPrescriptions = prescriptionsList.rows.map(p => ({
          ...p,
          fecha: p.date,
          diagnostico: p.diagnosis,
          mode: p.prescription_mode || 'routine',
          validity_type: p.validity_type || null,
          valid_until: p.valid_until || null,
          regulatory_snapshot: p.regulatory_snapshot || {},
        }));
        return res.status(200).json(mappedPrescriptions);

      case 'getPrescription':
        const { id: getPrescId } = req.query;
        const presc = await pool.query('SELECT * FROM prescriptions WHERE id = $1', [getPrescId]);
        if (presc.rows.length === 0) return res.status(404).json({ error: 'Prescription not found' });
        const pData = presc.rows[0];
        return res.status(200).json({
          ...pData,
          fecha: pData.date,
          diagnostico: pData.diagnosis,
          items: pData.items || [],
          mode: pData.prescription_mode || 'routine',
          validity_type: pData.validity_type || null,
          valid_until: pData.valid_until || null,
          regulatory_snapshot: pData.regulatory_snapshot || {},
        });

      case 'createPrescription': {
        const { ficha_id, fecha, diagnostico, items, consultation_id: prescConsId,
                mode = 'routine', validity_type = null, valid_until = null,
                regulatory_snapshot = {} } = body;
        const safeMode = mode === 'prescription' ? 'prescription' : 'routine';
        const prescFields = ['record_id', 'clinic_id', 'date', 'diagnosis', 'items', 'prescription_mode', 'validity_type', 'valid_until', 'regulatory_snapshot'];
        const prescValues = [ficha_id, effectiveClinicId, fecha, diagnostico, JSON.stringify(items), safeMode, validity_type, valid_until, JSON.stringify(regulatory_snapshot || {})];
        if (prescConsId) { prescFields.push('consultation_id'); prescValues.push(prescConsId); }
        const prescParams = prescFields.map((_, i) => `$${i + 1}`).join(', ');
        const newPresc = await pool.query(
          `INSERT INTO prescriptions (${prescFields.join(', ')}) VALUES (${prescParams}) RETURNING id`,
          prescValues
        );
        await logAudit(pool, { recordId: ficha_id, sessionUser: await getSessionUserOnce(), actionType: 'create', module: 'prescription', summary: `Creó receta médica` });
        return res.status(200).json({ id: newPresc.rows[0].id, message: 'Receta created' });
      }

      case 'updatePrescription':
        const { id: updPrescId, fecha: updFecha, diagnostico: updDiag, items: updItems,
                mode: updMode = 'routine', validity_type: updValidityType = null,
                valid_until: updValidUntil = null, regulatory_snapshot: updSnapshot = {} } = body;
        await pool.query(
          'UPDATE prescriptions SET date = $1, diagnosis = $2, items = $3, prescription_mode = $4, validity_type = $5, valid_until = $6, regulatory_snapshot = $7 WHERE id = $8',
          [updFecha, updDiag, JSON.stringify(updItems), updMode === 'prescription' ? 'prescription' : 'routine', updValidityType, updValidUntil, JSON.stringify(updSnapshot || {}), updPrescId]
        );
        return res.status(200).json({ message: 'Receta updated' });

      case 'deletePrescription':
        const { id: delPrescId } = req.query;
        await pool.query('DELETE FROM prescriptions WHERE id = $1', [delPrescId]);
        return res.status(200).json({ message: 'Receta deleted' });

      case 'getTemplates':
        const templates = await pool.query('SELECT * FROM prescription_templates ORDER BY name ASC');
        const mappedTemplates = templates.rows.map(t => ({
          ...t,
          nombre: t.name
        }));
        return res.status(200).json(mappedTemplates);

      case 'saveTemplate':
        const { nombre, items: tItems } = body;
        const newTempl = await pool.query(
          'INSERT INTO prescription_templates (name, items_json) VALUES ($1, $2) RETURNING id',
          [nombre, JSON.stringify(tItems)]
        );
        return res.status(200).json({ id: newTempl.rows[0].id, message: 'Template saved' });

      case 'deleteTemplate':
        const { id: delTemplId } = req.query;
        await pool.query('DELETE FROM prescription_templates WHERE id = $1', [delTemplId]);
        return res.status(200).json({ message: 'Template deleted' });

      // --- CONSENTIMIENTOS ---

      case 'migrateConsents':
        // Add signing columns if they don't exist
        try {
          await pool.query(`
            ALTER TABLE consent_forms 
            ADD COLUMN IF NOT EXISTS signing_token VARCHAR(100),
            ADD COLUMN IF NOT EXISTS signing_status VARCHAR(20) DEFAULT 'pending';
            CREATE INDEX IF NOT EXISTS idx_consent_forms_signing_token ON consent_forms(signing_token);
          `);
          return res.status(200).json({ message: 'Consent forms table migrated' });
        } catch (err) {
          console.error('Migration error:', err);
          return res.status(500).json({ error: 'Migration failed', details: err.message });
        }

      case 'initConsents':
        await initClinicalDatabase();
        dbInitialized = true;
        return res.status(200).json({ message: 'Clinical schema initialized idempotently' });

      case 'initProfessionalSignatures':
        // La tabla se crea en initClinicalDatabase() — solo confirmar existencia
        return res.status(200).json({ message: 'Professional signatures table initialized' });

      case 'saveProfessionalSignature': {
        const { name, signature, cedula } = body;
        const existing = await pool.query('SELECT id FROM professional_signatures WHERE professional_name = $1', [name]);
        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE professional_signatures SET signature_data = $1, cedula = $2, updated_at = NOW() WHERE professional_name = $3',
            [signature, cedula || null, name]
          );
        } else {
          await pool.query(
            'INSERT INTO professional_signatures (professional_name, signature_data, cedula) VALUES ($1, $2, $3)',
            [name, signature, cedula || null]
          );
        }
        return res.status(200).json({ success: true });
      }

      case 'getProfessionalSignature': {
        const { name } = req.query;
        const result = await pool.query(
          'SELECT signature_data, cedula FROM professional_signatures WHERE professional_name = $1',
          [name]
        );
        return res.status(200).json({
          signature: result.rows[0]?.signature_data || null,
          cedula: result.rows[0]?.cedula || null
        });
      }

      case 'listProfessionalSignatures': {
        const sigList = await pool.query(
          'SELECT id, professional_name, cedula, created_at FROM professional_signatures ORDER BY professional_name ASC'
        );
        return res.status(200).json(sigList.rows);
      }

      case 'generateSigningToken': {
        const { id: signId } = body;
        const consentId = Number(signId);
        if (!Number.isSafeInteger(consentId) || consentId <= 0 || consentId > 2147483647)
          return res.status(400).json({ error: 'Consent ID required' });
        if (!process.env.ADMIN_SETUP_SECRET)
          return res.status(503).json({ error: 'El servicio de verificación no está disponible.' });

        await client.query('SELECT pg_advisory_lock(68420, $1::int)', [consentId]);
        try {
          const signingRecord = await pool.query(
            `SELECT cf.*, p.first_name AS patient_first_name, p.last_name AS patient_last_name,
               p.identification_type, p.identification_number, p.rut AS legacy_rut,
               p.birth_date, p.email AS patient_email
             FROM consent_forms cf
             JOIN patients p ON p.id = cf.patient_id
             JOIN clinical_records cr ON cr.id = cf.record_id AND cr.patient_id = cf.patient_id
             WHERE cf.id = $1 LIMIT 1`,
            [consentId]
          );
          if (!signingRecord.rows.length) return res.status(404).json({ error: 'Consent not found' });
          const record = signingRecord.rows[0];
          if (record.status === 'annulled') return res.status(409).json({ error: 'El consentimiento está anulado. Cree o reactive un borrador antes de solicitar la firma.' });
          if (record.signing_status === 'signed' || ['signed', 'finalized'].includes(record.status) ||
              record.signature_data || record.signed_at || record.signing_signed_at ||
              record.signatures?.patient_sig_data || record.signatures?.patient_signed_at)
            return res.status(409).json({ error: 'El consentimiento ya está firmado. Use la acción explícita para solicitar una nueva firma.' });
          if (!hasProfessionalSignature(record.signatures))
            return res.status(409).json({ error: 'Antes de solicitar la firma del paciente, cargue una firma profesional guardada o firme como profesional y guarde los cambios.' });
          if (!record.patient_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.patient_email))
            return res.status(400).json({ error: 'El paciente necesita un correo válido registrado para verificar la firma remota.' });
          const senderUserId = await resolveConsentSenderUserId(req, su, effectiveClinicId);
          const senderOAuth = senderUserId ? await getUserGmailClient(senderUserId) : null;
          const senderName = await getConsentSenderName(effectiveClinicId, senderUserId);

          const token = crypto.randomBytes(32).toString('hex');
          const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
          const snapshot = createConsentSnapshot(record, {
            first_name: record.patient_first_name,
            last_name: record.patient_last_name,
            identification_type: record.identification_type,
            identification_number: record.identification_number,
            rut: record.legacy_rut,
            birth_date: record.birth_date,
          });
          const snapshotHash = hashConsentEvidence(snapshot);
          let sender;
          try {
            sender = await sendConsentEmail({
              oauth: senderOAuth,
              fromName: senderName,
              to: record.patient_email,
              subject: 'Código para verificar tu consentimiento informado',
              text: `Tu código de verificación es ${code}. Vence junto con el enlace de firma en 30 minutos. Si no solicitaste este código, ignora este mensaje.`,
              html: `<p>Tu código para verificar el consentimiento informado es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>El código y el enlace vencen en 30 minutos. Si no solicitaste este código, ignora este mensaje.</p>`,
            });
          } catch {
            console.error('No se pudo entregar el código de verificación de consentimiento.');
            return res.status(503).json({ error: 'No se pudo enviar el código al correo registrado. No se generó el enlace.' });
          }

          const updated = await pool.query(
            `UPDATE consent_forms SET signing_token = $1, signing_sender_user_id = $2, signing_status = 'pending',
              signing_expires_at = NOW() + INTERVAL '30 minutes', signing_email = $3,
              signing_otp_hash = $4, signing_otp_attempts = 0, signing_verified_at = NULL,
               signing_session_hash = NULL, signing_session_expires_at = NULL,
               signing_snapshot = $5::jsonb, signing_snapshot_hash = $6, signing_hash = NULL,
               signing_signed_at = NULL, signing_copy_sent_at = NULL,
               updated_at = NOW()
             WHERE id = $7 AND COALESCE(signing_status, 'pending') <> 'signed'
               AND status NOT IN ('signed', 'finalized', 'annulled') AND annulled_at IS NULL
               AND signature_data IS NULL AND signed_at IS NULL AND signing_signed_at IS NULL
               AND NULLIF(signatures->>'patient_sig_data', '') IS NULL
               AND NULLIF(signatures->>'patient_signed_at', '') IS NULL
             RETURNING id`,
            [token, sender?.senderType === 'oauth' ? senderUserId : null, record.patient_email, hashSigningCode(token, code, process.env.ADMIN_SETUP_SECRET), JSON.stringify(snapshot), snapshotHash, consentId]
          );
          if (!updated.rows.length) return res.status(409).json({ error: 'El consentimiento ya fue firmado o ya no se puede modificar.' });
          res.setHeader('Cache-Control', 'no-store, private');
          return res.status(200).json({ token, url: `/consent-signing/${token}`, ...sender });
        } finally {
          await client.query('SELECT pg_advisory_unlock(68420, $1::int)', [consentId]);
        }
      }

      case 'getSigningSession': {
        const { token } = req.query;
        if (typeof token !== 'string' || !SIGNING_TOKEN_PATTERN.test(token)) return res.status(404).json({ error: 'Session not found or expired' });
        const ownerPool = getPool();
        const session = await ownerPool.query(
          `SELECT signing_status, signing_expires_at, signing_verified_at,
             signing_email, signing_snapshot, signing_snapshot_hash,
             signing_session_hash, signing_session_expires_at
           FROM consent_forms WHERE signing_token = $1 AND signing_status = 'pending'
             AND signing_expires_at > NOW()`,
          [token]
        );
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found or expired' });
        const data = session.rows[0];
        if (!data.signing_verified_at) {
          return res.status(200).json({ requiresVerification: true, emailHint: maskEmail(data.signing_email) });
        }
        if (!data.signing_session_expires_at || new Date(data.signing_session_expires_at).getTime() <= Date.now() ||
            !matchesSigningSession(req, data.signing_session_hash))
          return res.status(401).json({ error: 'La sesión de firma venció o no pertenece a este navegador. Solicite un nuevo enlace a la clínica.' });
        return res.status(200).json({
          ...data.signing_snapshot,
          signing_status: 'pending',
          signing_snapshot_hash: data.signing_snapshot_hash,
        });
      }

      case 'verifySigningCode': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
        const { token, code } = body;
        if (typeof token !== 'string' || !SIGNING_TOKEN_PATTERN.test(token) || !/^\d{6}$/.test(String(code || '')))
          return res.status(400).json({ error: 'Código o enlace inválido' });
        if (!process.env.ADMIN_SETUP_SECRET) return res.status(503).json({ error: 'Servicio de verificación no disponible' });
        const ownerPool = getPool();
        const result = await ownerPool.query(
          `SELECT signing_otp_hash, signing_otp_attempts, signing_verified_at,
             signing_session_hash, signing_session_expires_at
           FROM consent_forms WHERE signing_token = $1 AND signing_status = 'pending'
             AND signing_expires_at > NOW()`,
          [token]
        );
        res.setHeader('Cache-Control', 'no-store, private');
        if (!result.rows.length) return res.status(404).json({ error: 'Código o enlace inválido o vencido' });
        const row = result.rows[0];
        if (row.signing_verified_at) {
          if (row.signing_session_expires_at && new Date(row.signing_session_expires_at).getTime() > Date.now() &&
              matchesSigningSession(req, row.signing_session_hash))
            return res.status(200).json({ success: true });
          return res.status(409).json({ error: 'La verificación ya fue consumida. Solicite un nuevo enlace a la clínica.' });
        }
        if (Number(row.signing_otp_attempts) >= 5) return res.status(429).json({ error: 'Se alcanzó el máximo de intentos. Solicite un nuevo enlace a la clínica.' });
        const expectedHash = Buffer.from(String(row.signing_otp_hash || ''), 'hex');
        const actualHash = Buffer.from(hashSigningCode(token, code, process.env.ADMIN_SETUP_SECRET), 'hex');
        if (expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(expectedHash, actualHash)) {
          await ownerPool.query(
            `UPDATE consent_forms SET signing_otp_attempts = signing_otp_attempts + 1
             WHERE signing_token = $1 AND signing_status = 'pending' AND signing_expires_at > NOW()
               AND signing_verified_at IS NULL AND signing_otp_attempts < 5`,
            [token]
          );
          return res.status(401).json({ error: 'Código o enlace inválido' });
        }
        const browserSession = crypto.randomBytes(32).toString('hex');
        const verified = await ownerPool.query(
          `UPDATE consent_forms SET signing_verified_at = NOW(), signing_otp_hash = NULL,
             signing_session_hash = $2, signing_session_expires_at = NOW() + INTERVAL '15 minutes'
           WHERE signing_token = $1 AND signing_status = 'pending' AND signing_expires_at > NOW()
             AND signing_verified_at IS NULL AND signing_otp_attempts < 5
             AND signing_otp_hash = $3 RETURNING id`,
          [token, hashConsentSession(browserSession, process.env.ADMIN_SETUP_SECRET), row.signing_otp_hash]
        );
        if (!verified.rows.length) return res.status(409).json({ error: 'Código o enlace inválido o vencido' });
        setSigningSessionCookie(res, browserSession, 900);
        return res.status(200).json({ success: true });
      }

      case 'submitSignature': {
        const { token, signature, declarations, authorizations } = body;
        if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
        if (typeof token !== 'string' || !SIGNING_TOKEN_PATTERN.test(token) || !isValidSignatureDataUrl(signature))
          return res.status(400).json({ error: 'Enlace o firma inválidos. La firma debe ser una imagen PNG válida de hasta 500 KB.' });
        const declarationKeys = ['understanding', 'questions', 'results', 'authorization', 'revocation', 'alternatives'];
        const authorizationKeys = ['image_use', 'photo_video', 'privacy_policy'];
        if (!declarations || declarationKeys.some(key => typeof declarations[key] !== 'boolean') ||
          declarations.understanding !== true || declarations.authorization !== true ||
          !authorizations || authorizationKeys.some(key => typeof authorizations[key] !== 'boolean') ||
          authorizations.privacy_policy !== true)
          return res.status(400).json({ error: 'Debe aceptar la información del tratamiento, la autorización y la política de privacidad.' });
        const ownerPool = getPool();
        const current = await ownerPool.query(
           `SELECT signatures, signing_snapshot, signing_snapshot_hash, signing_email, signing_sender_user_id,
             signing_session_hash, signing_session_expires_at
           FROM consent_forms WHERE signing_token = $1 AND signing_status = 'pending'
             AND signing_expires_at > NOW() AND signing_verified_at IS NOT NULL
             AND signing_otp_attempts < 5`,
          [token]
        );
        res.setHeader('Cache-Control', 'no-store, private');
        if (!current.rows.length) return res.status(409).json({ error: 'Enlace vencido, no verificado o ya utilizado. Solicite uno nuevo a la clínica.' });
        const session = current.rows[0];
        if (!session.signing_session_expires_at || new Date(session.signing_session_expires_at).getTime() <= Date.now() ||
            !matchesSigningSession(req, session.signing_session_hash))
          return res.status(401).json({ error: 'La sesión de firma venció o no pertenece a este navegador. Solicite un nuevo enlace a la clínica.' });
        const currentSigs = session.signatures || {};
        if (!hasProfessionalSignature(currentSigs))
          return res.status(409).json({ error: 'Este consentimiento no tiene firma profesional registrada. Contacte a la clínica para corregirlo.' });
        const signedAt = new Date().toISOString();
        const newSigs = {
          ...currentSigs,
          patient_sig_data: signature,
          patient_signed_at: signedAt,
        };
        const signingHash = hashConsentEvidence({
          snapshot: session.signing_snapshot,
          snapshotHash: session.signing_snapshot_hash,
          signature,
          declarations,
          authorizations,
          signedAt,
        });
        const signed = await ownerPool.query(
          `UPDATE consent_forms SET signatures = $1::jsonb, declarations = $2::jsonb,
             authorizations = $3::jsonb, signing_status = 'signed', status = 'finalized',
             signing_signed_at = $4, signing_hash = $5, signing_token = NULL,
             signing_otp_hash = NULL, signing_session_hash = NULL,
             signing_session_expires_at = NULL, updated_at = NOW()
           WHERE signing_token = $6 AND signing_status = 'pending' AND signing_verified_at IS NOT NULL
             AND signing_expires_at > NOW() AND signing_otp_attempts < 5
             AND signing_session_hash = $7 AND signing_session_expires_at > NOW()
           RETURNING id, patient_id, record_id, clinic_id, signing_email, signing_sender_user_id, signing_snapshot, signing_hash`,
          [JSON.stringify(newSigs), JSON.stringify(declarations), JSON.stringify(authorizations), signedAt, signingHash, token, session.signing_session_hash]
        );
        if (!signed.rows.length) return res.status(409).json({ error: 'Enlace vencido o ya utilizado. Solicite uno nuevo a la clínica.' });
        setSigningSessionCookie(res, '', 0);
        const signedRecord = signed.rows[0];
        await logAudit(ownerPool, {
          patientId: signedRecord.patient_id,
          recordId: signedRecord.record_id,
          clinicId: signedRecord.clinic_id,
          actionType: 'sign_remote',
          module: 'consent',
          summary: 'Consentimiento firmado por el paciente mediante enlace OTP',
        });
        let copyEmailed = false;
        let copySender = null;
        try {
          const email = buildSignedConsentEmail(signedRecord.signing_snapshot, newSigs, declarations, authorizations, signedAt, signingHash);
          const copyOAuth = await getUserGmailClient(signedRecord.signing_sender_user_id);
          copySender = await sendConsentEmail({
            oauth: copyOAuth,
            fromName: await getConsentSenderName(signedRecord.clinic_id, signedRecord.signing_sender_user_id),
            to: signedRecord.signing_email,
            subject: 'Copia de tu consentimiento informado firmado',
            text: email.text,
            html: email.html,
            signatureDataUrl: email.signature,
            professionalSignatureDataUrl: signedRecord.signing_snapshot.professional?.signature_data,
          });
          copyEmailed = Boolean(copySender.senderEmail);
        } catch {
          console.error('No se pudo enviar la copia del consentimiento firmado.');
        }
        if (copyEmailed) {
          try {
            await ownerPool.query('UPDATE consent_forms SET signing_copy_sent_at = NOW() WHERE id = $1', [signedRecord.id]);
          } catch {
            console.error('No se pudo registrar el envío de la copia del consentimiento firmado.');
          }
        }
        return res.status(200).json({ success: true, copyEmailed, copySenderEmail: copySender?.senderEmail || null, copySenderType: copySender?.senderType || null, emailHint: maskEmail(signedRecord.signing_email), signedAt, signingHash });
      }

      case 'listConsents': {
        const { patient_id: pid, record_id: rid } = req.query;
        let query = `SELECT ${CONSENT_SAFE_COLUMNS} FROM consent_forms WHERE `;
        let params = [];
        if (rid) {
          query += 'record_id = $1';
          params.push(rid);
        } else if (pid) {
          query += 'patient_id = $1';
          params.push(pid);
        } else {
          return res.status(400).json({ error: 'Missing patient_id or record_id' });
        }
        query += ' ORDER BY created_at DESC';
        const consents = await pool.query(query, params);
        return res.status(200).json(consents.rows);
      }

      case 'listAuditLog': {
        const { patient_id: auditPid, record_id: auditRid, limit: auditLimit } = req.query;
        if (!auditPid && !auditRid) return res.status(400).json({ error: 'patient_id o record_id requerido' });
        const ownAudit = su?.role !== 'master_admin' && su?.access_scope === 'own';
        const q = auditPid
          ? `SELECT l.* FROM patient_audit_log l
             WHERE l.patient_id = $1
               AND ($3::boolean = false OR l.clinic_user_id = $4 OR l.record_id IN (
                 SELECT id FROM clinical_records WHERE patient_id = $1 AND created_by_user_id = $4
               )) ORDER BY l.created_at DESC LIMIT $2`
          : `SELECT l.* FROM patient_audit_log l
             WHERE l.record_id = $1
               AND ($3::boolean = false OR l.clinic_user_id = $4)
             ORDER BY l.created_at DESC LIMIT $2`;
        const logs = await pool.query(q, [auditPid || auditRid, parseInt(auditLimit || '50'), ownAudit, su?.user_id]);
        return res.status(200).json(logs.rows);
      }

      case 'getConsent':
        const { id: cid } = req.query;
        const consent = await pool.query(`SELECT ${CONSENT_SAFE_COLUMNS} FROM consent_forms WHERE id = $1`, [cid]);
        if (consent.rows.length === 0) return res.status(404).json({ error: 'Consent not found' });
        return res.status(200).json(consent.rows[0]);

      case 'saveConsent': {
        const { 
          id: saveCid, 
          record_id: saveRid, 
          patient_id: savePid,
          consultation_id: consId,
          status,
          created_by,
          procedure_type,
          zone,
          sessions,
          objectives,
          description,
          risks,
          benefits,
          alternatives,
          pre_care,
          post_care,
          contraindications,
          critical_antecedents,
          authorizations,
          declarations,
          signatures,
          attachments
        } = body;
        if (status === 'annulled') return res.status(400).json({ error: 'Use la acción de anulación para registrar motivo y responsable.' });
        const safeStatus = 'draft';
        if (signatures?.patient_sig_data || signatures?.patient_signed_at)
          return res.status(400).json({ error: 'La firma digital del paciente solo se registra mediante firma remota verificada. Para firma presencial use el formato en papel.' });
        const safeSignatures = { ...(signatures || {}) };
        delete safeSignatures.patient_sig_data;
        delete safeSignatures.patient_signed_at;
        delete safeSignatures.signature_method;
        delete safeSignatures.witness_user_id;
        delete safeSignatures.witness_name;

        const consentPatientId = Number(savePid);
        const consentRecordId = Number(saveRid);
        if (!Number.isSafeInteger(consentPatientId) || consentPatientId <= 0 ||
            !Number.isSafeInteger(consentRecordId) || consentRecordId <= 0)
          return res.status(400).json({ error: 'Paciente y expediente son obligatorios para el consentimiento.' });
        const recordOwner = await pool.query(
          `SELECT p.clinic_id FROM clinical_records cr JOIN patients p ON p.id = cr.patient_id
           WHERE cr.id = $1 AND cr.patient_id = $2 LIMIT 1`,
          [consentRecordId, consentPatientId]
        );
        if (!recordOwner.rows.length) return res.status(400).json({ error: 'El paciente no corresponde al expediente seleccionado.' });
        if (effectiveClinicId && String(recordOwner.rows[0].clinic_id) !== String(effectiveClinicId))
          return res.status(403).json({ error: 'El paciente no pertenece a la clínica activa.' });
        if (saveCid) {
          if (!Number.isSafeInteger(Number(saveCid)) || Number(saveCid) <= 0)
            return res.status(400).json({ error: 'ID de consentimiento inválido.' });
          const existingConsent = await pool.query('SELECT patient_id, record_id, consultation_id FROM consent_forms WHERE id = $1 LIMIT 1', [saveCid]);
          if (!existingConsent.rows.length) return res.status(404).json({ error: 'Consentimiento no encontrado.' });
          if (Number(existingConsent.rows[0].patient_id) !== consentPatientId || Number(existingConsent.rows[0].record_id) !== consentRecordId)
            return res.status(403).json({ error: 'No se puede reasignar un consentimiento a otro paciente o expediente.' });
          const targetConsultationId = consId ?? existingConsent.rows[0].consultation_id;
          if (targetConsultationId != null) {
            const consultation = await pool.query('SELECT id FROM consultations WHERE id = $1 AND record_id = $2 LIMIT 1', [targetConsultationId, consentRecordId]);
            if (!consultation.rows.length) return res.status(400).json({ error: 'La consulta no corresponde al expediente seleccionado.' });
          }
          // Update
          const updateQuery = `
            UPDATE consent_forms SET
              status = COALESCE($1, status),
              consultation_id = COALESCE($2, consultation_id),
              updated_at = NOW(),
              procedure_type = COALESCE($3, procedure_type),
              zone = COALESCE($4, zone),
              sessions = COALESCE($5, sessions),
              objectives = COALESCE($6, objectives),
              description = COALESCE($7, description),
              risks = COALESCE($8, risks),
              benefits = COALESCE($9, benefits),
              alternatives = COALESCE($10, alternatives),
              pre_care = COALESCE($11, pre_care),
              post_care = COALESCE($12, post_care),
              contraindications = COALESCE($13, contraindications),
              critical_antecedents = COALESCE($14, critical_antecedents),
              authorizations = COALESCE($15, authorizations),
              declarations = COALESCE($16, declarations),
              signatures = COALESCE($17, signatures),
              attachments = COALESCE($18, attachments),
              signing_token = NULL,
              signing_sender_user_id = NULL,
              signing_expires_at = NULL,
              signing_email = NULL,
              signing_otp_hash = NULL,
              signing_otp_attempts = 0,
              signing_verified_at = NULL,
              signing_session_hash = NULL,
              signing_session_expires_at = NULL,
              signing_snapshot = NULL,
              signing_snapshot_hash = NULL,
              signing_hash = NULL,
              signing_signed_at = NULL,
              signing_copy_sent_at = NULL
            WHERE id = $19 AND COALESCE(signing_status, 'pending') <> 'signed'
              AND annulled_at IS NULL
              AND status NOT IN ('signed', 'finalized', 'annulled')
              AND signature_data IS NULL AND signed_at IS NULL AND signing_signed_at IS NULL
              AND NULLIF(signatures->>'patient_sig_data', '') IS NULL
              AND NULLIF(signatures->>'patient_signed_at', '') IS NULL
            RETURNING ${CONSENT_SAFE_COLUMNS}
          `;
          const updated = await pool.query(updateQuery, [
            safeStatus, consId, procedure_type, zone, sessions,
            JSON.stringify(objectives), description, JSON.stringify(risks), JSON.stringify(benefits), JSON.stringify(alternatives),
            JSON.stringify(pre_care), JSON.stringify(post_care), JSON.stringify(contraindications),
            JSON.stringify(critical_antecedents), JSON.stringify(authorizations), JSON.stringify(declarations),
            JSON.stringify(safeSignatures), JSON.stringify(attachments),
            saveCid
          ]);
          if (!updated.rows.length) return res.status(409).json({ error: 'Un consentimiento firmado no se puede editar. Cree un nuevo consentimiento.' });
          await logAudit(pool, {
            patientId: updated.rows[0].patient_id,
            recordId: updated.rows[0].record_id,
            clinicId: effectiveClinicId,
            sessionUser: su,
            actionType: 'update',
            module: 'consent',
            summary: 'Actualizó un consentimiento informado no firmado',
          });
          return res.status(200).json(updated.rows[0]);
        } else {
          if (consId != null) {
            const consultation = await pool.query('SELECT id FROM consultations WHERE id = $1 AND record_id = $2 LIMIT 1', [consId, consentRecordId]);
            if (!consultation.rows.length) return res.status(400).json({ error: 'La consulta no corresponde al expediente seleccionado.' });
          }
          // Create
          const insertQuery = `
            INSERT INTO consent_forms (
              record_id, patient_id, clinic_id, consultation_id, status, created_by,
              procedure_type, zone, sessions,
              objectives, description, risks, benefits, alternatives,
              pre_care, post_care, contraindications,
              critical_antecedents, authorizations, declarations,
              signatures, attachments
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9,
              $10, $11, $12, $13, $14,
              $15, $16, $17,
              $18, $19, $20,
              $21, $22
            ) RETURNING ${CONSENT_SAFE_COLUMNS}
          `;
          const created = await pool.query(insertQuery, [
            saveRid, savePid, effectiveClinicId, consId, safeStatus, created_by,
            procedure_type, zone, sessions,
            JSON.stringify(objectives || []), description || '', JSON.stringify(risks || []), JSON.stringify(benefits || []), JSON.stringify(alternatives || []),
            JSON.stringify(pre_care || []), JSON.stringify(post_care || []), JSON.stringify(contraindications || []),
            JSON.stringify(critical_antecedents || {}), JSON.stringify(authorizations || {}), JSON.stringify(declarations || {}),
            JSON.stringify(safeSignatures), JSON.stringify(attachments || [])
          ]);
          await logAudit(pool, {
            patientId: created.rows[0].patient_id,
            recordId: created.rows[0].record_id,
            clinicId: effectiveClinicId,
            sessionUser: su,
            actionType: 'create',
            module: 'consent',
            summary: 'Creó un consentimiento informado',
          });
          return res.status(200).json(created.rows[0]);
        }
      }

      case 'annulConsent': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
        const consentId = Number(body.id);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const createReplacement = body.createReplacement === true;
        if (!Number.isSafeInteger(consentId) || consentId <= 0 || consentId > 2147483647)
          return res.status(400).json({ error: 'ID de consentimiento inválido.' });
        if (reason.length < 8 || reason.length > 500)
          return res.status(400).json({ error: 'Explique el motivo de anulación (8 a 500 caracteres).' });
        if (!(await ownedByClinic(pool, 'consent_forms', consentId, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso para anular este consentimiento.' });

        await client.query('BEGIN');
        try {
          const sourceResult = await pool.query('SELECT * FROM consent_forms WHERE id = $1 FOR UPDATE', [consentId]);
          if (!sourceResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Consentimiento no encontrado.' });
          }
          const source = sourceResult.rows[0];
          if (source.annulled_at || source.status === 'annulled') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Este consentimiento ya está anulado.' });
          }
          if (createReplacement) {
            const activeReplacement = await pool.query(
              "SELECT id FROM consent_forms WHERE replaces_consent_id = $1 AND status <> 'annulled' LIMIT 1",
              [consentId]
            );
            if (activeReplacement.rows.length) {
              await client.query('ROLLBACK');
              return res.status(409).json({ error: 'Ya existe un reemplazo activo para este consentimiento.' });
            }
          }

          const sessionUser = await getSessionUserOnce();
          const hasSignedEvidence = source.signing_status === 'signed' || ['signed', 'finalized'].includes(source.status) ||
            source.signature_data || source.signed_at || source.signing_signed_at ||
            source.signatures?.patient_sig_data || source.signatures?.patient_signed_at;
          if (!hasSignedEvidence) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Solo puede anular consentimientos firmados. Los borradores pueden editarse o eliminarse.' });
          }
          const annulledResult = await pool.query(
            `UPDATE consent_forms SET status = 'annulled', annulled_at = NOW(),
               annulled_by_user_id = $1, annulled_by_name = $2, annulment_reason = $3,
               signing_status = 'signed', signing_token = NULL, signing_expires_at = NULL,
               signing_otp_hash = NULL, signing_verified_at = NULL, signing_session_hash = NULL,
               signing_session_expires_at = NULL,
               updated_at = NOW()
             WHERE id = $4 AND annulled_at IS NULL
             RETURNING ${CONSENT_SAFE_COLUMNS}`,
            [sessionUser?.user_id ?? null, sessionUser?.full_name || sessionUser?.username || 'Sistema', reason, consentId]
          );
          if (!annulledResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El consentimiento cambió mientras se procesaba. Actualice la pantalla e intente de nuevo.' });
          }

          let replacement = null;
          if (createReplacement) {
            const patientResult = await pool.query(
              'SELECT first_name, last_name FROM patients WHERE id = $1 AND clinic_id = $2',
              [source.patient_id, effectiveClinicId]
            );
            if (!patientResult.rows.length) throw new Error('No se pudo validar el paciente del reemplazo');
            const patientName = `${patientResult.rows[0].first_name} ${patientResult.rows[0].last_name}`.trim();
            const replacementSignatures = {
              patient_name: patientName,
              professional_name: source.signatures?.professional_name || '',
              sig_scale: source.signatures?.sig_scale || 'md',
            };
            const inserted = await pool.query(
              `INSERT INTO consent_forms (
                 record_id, patient_id, clinic_id, consultation_id, status, created_by,
                 procedure_type, zone, sessions, objectives, description, risks, benefits, alternatives,
                 pre_care, post_care, contraindications, critical_antecedents, authorizations,
                 declarations, signatures, attachments, replaces_consent_id
               ) VALUES (
                 $1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb,
                 $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, '[]'::jsonb, $21
               ) RETURNING ${CONSENT_SAFE_COLUMNS}`,
              [
                source.record_id, source.patient_id, source.clinic_id || effectiveClinicId, source.consultation_id,
                sessionUser?.username || 'Sistema', source.procedure_type, source.zone, source.sessions,
                JSON.stringify(source.objectives || []), source.description || '', JSON.stringify(source.risks || []),
                JSON.stringify(source.benefits || []), JSON.stringify(source.alternatives || []),
                JSON.stringify(source.pre_care || []), JSON.stringify(source.post_care || []),
                JSON.stringify(source.contraindications || []), JSON.stringify(source.critical_antecedents || {}),
                JSON.stringify({ image_use: false, photo_video: false, privacy_policy: false }),
                JSON.stringify({ understanding: false, questions: false, results: false, authorization: false, revocation: false, alternatives: false }),
                JSON.stringify(replacementSignatures), consentId,
              ]
            );
            replacement = inserted.rows[0];
            await logAudit(pool, {
              patientId: source.patient_id,
              recordId: source.record_id,
              clinicId: source.clinic_id || effectiveClinicId,
              sessionUser,
              actionType: 'create',
              module: 'consent',
              summary: `Creó el reemplazo del consentimiento anulado ${consentId}`,
            });
          }

          await logAudit(pool, {
            patientId: source.patient_id,
            recordId: source.record_id,
            clinicId: source.clinic_id || effectiveClinicId,
            sessionUser,
            actionType: 'annul',
            module: 'consent',
            summary: `Anuló el consentimiento ${consentId}`,
          });
          await client.query('COMMIT');
          return res.status(200).json({
            success: true,
            consent: annulledResult.rows[0],
            replacement,
            message: replacement ? 'Consentimiento anulado. Se creó un borrador de reemplazo; ambas versiones quedaron vinculadas.' : 'Consentimiento anulado. La evidencia original se conservó íntegra.',
          });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }

      case 'deleteConsent': {
        const { id: delCid } = req.query;
        if (!(await ownedByClinic(pool, 'consent_forms', delCid, effectiveClinicId)))
          return res.status(403).json({ error: 'Sin permiso' });
        const deleted = await pool.query(
          `DELETE FROM consent_forms WHERE id = $1 AND COALESCE(signing_status, 'pending') <> 'signed'
            AND annulled_at IS NULL AND status NOT IN ('signed', 'finalized', 'annulled')
            AND signature_data IS NULL AND signed_at IS NULL AND signing_signed_at IS NULL
            AND NULLIF(signatures->>'patient_sig_data', '') IS NULL
            AND NULLIF(signatures->>'patient_signed_at', '') IS NULL
           RETURNING id`,
          [delCid]
        );
        if (!deleted.rows.length) return res.status(409).json({ error: 'Un consentimiento firmado no se puede eliminar desde el panel.' });
        return res.status(200).json({ message: 'Consent deleted' });
      }

      // ==========================================
      // FINANCE MODULE ACTIONS
      // ==========================================

      case 'financeCreate': {
        const su = await getSessionUserOnce();
        const { date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!entity || !type) return res.status(400).json({ error: 'Entidad y tipo son requeridos' });
        const clinicId   = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        const regBy      = su?.username ?? 'manual';
        const sub  = parseFloat(subtotal || 0);
        const taxV = parseFloat(tax  || 0);
        const tot  = parseFloat(total || 0) || (sub + taxV);
        try {
          const r = await pool.query(
            `INSERT INTO financial_records (date, invoice_number, entity, description, type, subtotal, tax, total, registered_by, clinic_id, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [date || new Date().toISOString().split('T')[0], invoice_number || null, entity, description || null, type, sub, taxV, tot, regBy, clinicId, su?.user_id ?? null]
          );
          return res.status(201).json(r.rows[0]);
        } catch (err) {
          console.error('Error creating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUsers': {
        // Devuelve los usuarios de la clínica con su estado de visibilidad de finanzas
        const su = await getSessionUserOnce();
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        if (!clinicId && su?.role !== 'master_admin') return res.status(403).json({ error: 'Sin contexto de clínica' });
        try {
          // Usuarios de la clínica (excluyendo master_admin)
          let usersQuery = `SELECT id, username, full_name, role FROM clinic_users WHERE role != 'master_admin' AND is_active = true`;
          const usersParams = [];
          if (clinicId) { usersQuery += ` AND clinic_id = $1`; usersParams.push(clinicId); }
          // ponytail: @vercel/postgres no está disponible aquí — usamos pool (neon-clinical-db)
          // La tabla clinic_users vive en la misma BD (misma NEON_DATABASE_URL)
          const usersRes = await pool.query(usersQuery, usersParams);

          // Overrides de visibilidad de finanzas por usuario
          const userIds  = usersRes.rows.map(u => u.id);
          let overrides = {};
          if (userIds.length) {
            try {
              const ovr = await pool.query(
                `SELECT clinic_user_id, enabled FROM user_module_overrides WHERE feature = 'finanzas_visible' AND clinic_user_id = ANY($1)`,
                [userIds]
              );
              ovr.rows.forEach(r => { overrides[r.clinic_user_id] = r.enabled; });
            } catch (ovrErr) {
              // ponytail: si la tabla aun no existe, ignorar — todos visibles por defecto
              if (ovrErr.code !== '42P01') throw ovrErr;
            }
          }

          const users = usersRes.rows.map(u => ({
            id:         u.id,
            username:   u.username,
            full_name:  u.full_name || u.username,
            role:       u.role,
            // Si no hay override → visible (true). Si hay override con enabled=false → no visible
            finance_visible: overrides[u.id] !== false,
          }));
          return res.status(200).json(users);
        } catch (err) {
          console.error('Error fetching finance users:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsGet': {
        const { record_id } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!(await canAccessFinanceRecord(pool, su, record_id))) return res.status(403).json({ error: 'Sin acceso' });
        try {
          const items = await pool.query(
            'SELECT * FROM financial_items WHERE record_id = $1 ORDER BY sort_order, id ASC',
            [record_id]
          );
          return res.status(200).json(items.rows);
        } catch (err) {
          if (err.code === '42P01') return res.status(200).json([]); // tabla no existe aún
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeItemsSave': {
        // Guarda/reemplaza los items de una factura y recalcula totales del record
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        const { record_id, items } = body;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un array' });

        const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
        if (!(await canAccessFinanceRecord(pool, su, record_id))) return res.status(403).json({ error: 'Sin acceso' });

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Propagar tenant context al cliente interno para compatibilidad con RLS
          await client.query("SELECT set_config('app.current_tenant', $1, false)", [clinicId ? String(clinicId) : '']);
          // Borrar items anteriores
          await client.query('DELETE FROM financial_items WHERE record_id = $1', [record_id]);

          let totalSubtotal = 0, totalTax = 0, totalTotal = 0;

          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const qty      = parseFloat(it.quantity  || 1);
            const uprice   = parseFloat(it.unit_price || 0);
            const ivaRate  = parseFloat(it.iva_rate   || 0);
            const subtotal = parseFloat((qty * uprice).toFixed(2));
            const tax      = parseFloat((subtotal * ivaRate / 100).toFixed(2));
            const total    = parseFloat((subtotal + tax).toFixed(2));
            totalSubtotal += subtotal;
            totalTax      += tax;
            totalTotal    += total;
            await client.query(
              `INSERT INTO financial_items (record_id, clinic_id, description, quantity, unit_price, iva_rate, subtotal, tax, total, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [record_id, clinicId ?? null, it.description, qty, uprice, ivaRate,
               subtotal, tax, total, i]
            );
          }

          // Si hay items, actualizar totales del record padre
          if (items.length > 0) {
            await client.query(
              `UPDATE financial_records SET subtotal=$1, tax=$2, total=$3 WHERE id=$4`,
              [totalSubtotal.toFixed(2), totalTax.toFixed(2), totalTotal.toFixed(2), record_id]
            );
          }

          await client.query('COMMIT');
          return res.status(200).json({ success: true, subtotal: totalSubtotal, tax: totalTax, total: totalTotal });
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('Error saving finance items:', err);
          return res.status(500).json({ error: err.message });
        } finally {
          client.release();
        }
      }

      case 'financeList': {
        const su = await getSessionUserOnce();
        const { startDate, endDate, registered_by } = req.query;
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;

        let query = `SELECT * FROM financial_records WHERE 1=1`;
        const params = [];
        let paramCount = 1;

        // Filtro por clínica (multi-tenant)
        if (clinicId) {
          query += ` AND (clinic_id = $${paramCount} OR clinic_id IS NULL)`;
          params.push(clinicId);
          paramCount++;
        }

        // Respetar finance_scope: 'own' restringe al usuario actual + grupo; 'all' permite ver toda la clínica
        if (su?.finance_scope === 'own') {
          query += ` AND (
            created_by_user_id = $${paramCount}
            OR created_by_user_id IN (
              SELECT sgm2.clinic_user_id
              FROM sharing_group_members sgm1
              JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
              WHERE sgm1.clinic_user_id = $${paramCount}
            )
          )`;
          params.push(su.user_id);
          paramCount++;
        } else if (registered_by && registered_by !== 'all' && registered_by !== 'null' && registered_by !== 'undefined') {
          // Soporta lista separada por comas: "user1,user2,user3"
          const users = String(registered_by).split(',').map(u => u.trim()).filter(Boolean);
          if (users.length === 1) {
            query += ` AND registered_by = $${paramCount}`;
            params.push(users[0]);
            paramCount++;
          } else if (users.length > 1) {
            // ponytail: unnest con ANY es idiomático en PostgreSQL y previene SQL injection
            query += ` AND registered_by = ANY($${paramCount}::text[])`;
            params.push(users);
            paramCount++;
          }
        }

        if (startDate && startDate !== 'null' && startDate !== 'undefined') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null' && endDate !== 'undefined') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }

        query += ` ORDER BY date DESC, created_at DESC`;
        
        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          console.error('Error listing finance records:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeDelete': {
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden eliminar registros' });
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        if (!(await canAccessFinanceRecord(pool, su, id))) return res.status(403).json({ error: 'Sin acceso' });
        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query('DELETE FROM financial_records WHERE id = $1', [id]);
          } else {
            await pool.query('DELETE FROM financial_records WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)', [id, clinicId]);
          }
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeStats': {
        // Stats generales y por usuario
        const su = await getSessionUserOnce();
        const { startDate, endDate } = req.query;
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id ?? null;
        let query = `
          SELECT 
            type, 
            registered_by,
            SUM(total) as total_amount,
            COUNT(*) as count
          FROM financial_records
          WHERE status = 'confirmed'
        `;
        const params = [];
        let paramCount = 1;

        if (clinicId) {
          query += ` AND clinic_id = $${paramCount}`;
          params.push(clinicId);
          paramCount++;
        }
        if (su?.finance_scope === 'own') {
          query += ` AND (created_by_user_id = $${paramCount} OR created_by_user_id IN (
            SELECT sgm2.clinic_user_id FROM sharing_group_members sgm1
            JOIN sharing_group_members sgm2 ON sgm1.group_id = sgm2.group_id
            WHERE sgm1.clinic_user_id = $${paramCount}
          ))`;
          params.push(su.user_id);
          paramCount++;
        }

        if (startDate && startDate !== 'null') {
          query += ` AND date >= $${paramCount}`;
          params.push(startDate);
          paramCount++;
        }
        if (endDate && endDate !== 'null') {
          query += ` AND date <= $${paramCount}`;
          params.push(endDate);
          paramCount++;
        }
        
        query += ` GROUP BY type, registered_by`;

        try {
          const result = await pool.query(query, params);
          return res.status(200).json(result.rows);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'financeUpdate': {
        const su = await getSessionUserOnce();
        if (!su) return res.status(401).json({ error: 'No autenticado' });
        if (!['clinic_admin', 'master_admin'].includes(su.role))
          return res.status(403).json({ error: 'Solo administradores pueden editar registros' });
        const { id, date, invoice_number, entity, description, type, subtotal, tax, total } = body;
        if (!id) return res.status(400).json({ error: 'Missing ID' });
        if (!['ingreso', 'egreso'].includes(type))
          return res.status(400).json({ error: 'Tipo inválido. Use ingreso o egreso' });
        if (!(await canAccessFinanceRecord(pool, su, id))) return res.status(403).json({ error: 'Sin acceso' });

        try {
          const clinicId = su.effective_clinic_id ?? su.clinic_id ?? null;
          if (su.role === 'master_admin') {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id]
            );
          } else {
            await pool.query(
              `UPDATE financial_records SET date=$1, invoice_number=$2, entity=$3, description=$4, type=$5, subtotal=$6, tax=$7, total=$8 WHERE id=$9 AND (clinic_id=$10 OR clinic_id IS NULL)`,
              [date, invoice_number, entity, description, type, subtotal, tax, total, id, clinicId]
            );
          }
          return res.status(200).json({ success: true, message: 'Record updated' });
        } catch (err) {
          console.error('Error updating finance record:', err);
          return res.status(500).json({ error: err.message });
        }
      }

      // ==========================================
      // PHOTOS MODULE (Cloudflare R2)
      // ==========================================

      case 'uploadPhotoProxy': {
        // Cliente envía base64 → servidor sube a R2 y guarda metadata
        const { fileBase64, content_type, record_id, consultation_id, session_label, photo_type = 'general', face_zone } = body;
        if (!fileBase64 || !record_id || !content_type) return res.status(400).json({ error: 'fileBase64, record_id y content_type requeridos' });
        const allowed = ['image/jpeg','image/png','image/webp','image/heic'];
        if (!allowed.includes(content_type)) return res.status(400).json({ error: 'Tipo de archivo no permitido' });
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(pool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        const ext = content_type.split('/')[1] || 'jpg';
        const r2Key = `clinics/${clinicId}/records/${record_id}/photos/${crypto.randomUUID()}.${ext}`;
        try {
          const buffer = Buffer.from(fileBase64, 'base64');
          if (buffer.length === 0 || buffer.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'La imagen supera el límite permitido de 4 MB' });
          await putR2Object(r2Key, buffer, content_type);
          const result = await pool.query(
            `INSERT INTO clinical_photos (record_id, consultation_id, clinic_id, r2_key, photo_type, face_zone, session_label, taken_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id, r2_key, photo_type, created_at`,
            [record_id, consultation_id||null, clinicId, r2Key, photo_type, face_zone||null, session_label||null]
          );
          return res.status(201).json(result.rows[0]);
        } catch (err) {
          console.error('uploadPhotoProxy error:', err);
          if (err.message?.includes('no configuradas')) return res.status(503).json({ error: 'Almacenamiento no configurado — Configure R2_ACCESS_KEY_ID en Vercel' });
          return res.status(500).json({ error: err.message });
        }
      }

      case 'getPhotoUploadUrl': {
        // Returns a presigned PUT URL — the client uploads directly to R2, never via server
        const { record_id, content_type, content_length } = body;
        if (!record_id || !content_type || !content_length) return res.status(400).json({ error: 'record_id, content_type y content_length requeridos' });
        if (!Number.isInteger(content_length) || content_length < 1 || content_length > MAX_PHOTO_BYTES) return res.status(413).json({ error: 'La imagen supera el límite permitido de 4 MB' });
        const allowed = ['image/jpeg','image/png','image/webp','image/heic'];
        if (!allowed.includes(content_type)) return res.status(400).json({ error: 'Tipo de archivo no permitido' });

        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(appPool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        const r2Key = `clinics/${clinicId}/records/${record_id}/photos/${crypto.randomUUID()}.${content_type.split('/')[1]}`;
        try {
          const presignedUrl = await generateUploadUrl(r2Key, content_type, content_length);
          return res.status(200).json({ presignedUrl, r2Key });
        } catch (err) {
          console.error('R2 upload URL error:', err);
          return res.status(503).json({ error: 'Almacenamiento no configurado — Configure R2_ACCESS_KEY_ID en Vercel' });
        }
      }

      case 'confirmPhotoUpload': {
        const { record_id, r2_key, photo_type = 'general', face_zone, body_zone, session_label, notes, consultation_id, taken_at } = body;
        if (!record_id || !r2_key) return res.status(400).json({ error: 'record_id y r2_key requeridos' });
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!PHOTO_TYPES.has(photo_type)) return res.status(400).json({ error: 'Tipo de foto inválido' });
        if (!(await recordBelongsToClinic(pool, record_id, clinicId)) || !isOwnedPhotoKey(r2_key, clinicId, record_id)) {
          return res.status(400).json({ error: 'Clave de almacenamiento inválida' });
        }
        try {
          const result = await pool.query(
            `INSERT INTO clinical_photos (record_id, consultation_id, clinic_id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, r2_key, photo_type, created_at`,
            [record_id, consultation_id||null, clinicId, r2_key, photo_type, face_zone||null, body_zone||null, session_label||null, notes||null, taken_at||null]
          );
          return res.status(201).json(result.rows[0]);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'listPhotos': {
        const { record_id, limit: lim, offset: off } = req.query;
        if (!record_id) return res.status(400).json({ error: 'record_id requerido' });
        const pageSize = Math.min(parseInt(lim) || 24, 50);
        const offset   = Math.max(parseInt(off) || 0, 0);
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!(await recordBelongsToClinic(pool, record_id, clinicId))) return res.status(404).json({ error: 'Expediente no encontrado' });
        try {
          const countRes = await pool.query(
            `SELECT COUNT(*) FROM clinical_photos WHERE record_id = $1 AND clinic_id = $2`, [record_id, clinicId]
          );
          const total = parseInt(countRes.rows[0].count);
          const result = await pool.query(
            `SELECT id, r2_key, photo_type, face_zone, body_zone, session_label, notes, taken_at, created_at
             FROM clinical_photos WHERE record_id = $1 AND clinic_id = $2 ORDER BY taken_at DESC LIMIT $3 OFFSET $4`,
            [record_id, clinicId, pageSize, offset]
          );
          const photos = await Promise.all(result.rows.map(async (p) => {
            try { return { ...p, r2_url: await generateReadUrl(p.r2_key) }; }
            catch { return { ...p, r2_url: null }; }
          }));
          return res.status(200).json({ photos, total, hasMore: offset + pageSize < total });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'updatePhoto': {
        const { id, photo_type, face_zone, body_zone, session_label, notes } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        const clinicIdUp = su?.effective_clinic_id ?? su?.clinic_id;
        try {
          const upRes = await pool.query(
            `UPDATE clinical_photos SET photo_type=$1, face_zone=$2, body_zone=$3, session_label=$4, notes=$5
             WHERE id=$6 AND clinic_id=$7`,
            [photo_type||null, face_zone||null, body_zone||null, session_label||null, notes||null, id, clinicIdUp]
          );
          if (upRes.rowCount === 0) return res.status(404).json({ error: 'Foto no encontrada' });
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'deletePhoto': {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        const clinicIdDel = su?.effective_clinic_id ?? su?.clinic_id;
        try {
          const r = await pool.query(
            'SELECT r2_key FROM clinical_photos WHERE id = $1 AND clinic_id = $2',
            [id, clinicIdDel]
          );
          if (!r.rows.length) return res.status(404).json({ error: 'Foto no encontrada' });
          if (r.rows[0].r2_key) await deleteR2Object(r.rows[0].r2_key);
          await pool.query('DELETE FROM clinical_photos WHERE id = $1', [id]);
          return res.status(200).json({ success: true });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case 'sendFinanceCsv': {
        const su = await getSessionUserOnce();
        const clinicId = su?.effective_clinic_id ?? su?.clinic_id;
        if (!clinicId) return res.status(400).json({ error: 'Clínica no identificada' });
        const { startDate, endDate } = body;
        if (!startDate || !endDate) return res.status(400).json({ error: 'startDate y endDate requeridos' });
        try {
          const result = await sendFinanceCsvToAdmin({ pool, clinicId, userId: su.user_id, financeScope: su.finance_scope, startDate, endDate, periodLabel: 'manual' });
          return res.status(200).json({ success: true, ...result });
        } catch (err) {
          return res.status(400).json({ success: false, error: err.message });
        }
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
    } finally {
      if (lifecycleLocked) {
        try { await unlockClinicWriters(client, [lifecycleClinicId]); }
        catch (error) {
          console.error('[records:lifecycle] unlock failed', error.code || error.name);
          client.release(error);
          clientDiscarded = true;
        }
      }
      // Limpiar tenant antes de devolver la conexión al pool
      if (!clientDiscarded) {
        try { await client.query('SET statement_timeout = 0'); } catch {}
        try { await client.query("SELECT set_config('app.current_tenant', '', false)"); } catch {}
        client.release();
      }
    }
  } catch (error) {
    console.error('Clinical Records API Error:', error);
    return res.status(error.status || 500).json({ error: error.message });
  }
}
