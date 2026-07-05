/**
 * @file lib/modules/fichas-clinicas/index.js
 * @description Módulo de Fichas Clínicas — capa de servicio del backend.
 *
 * ─── Sub-módulos ─────────────────────────────────────────────────────────────
 *
 *  PACIENTES
 *   listPatients, createPatient, updatePatient, deletePatient, getPatient
 *
 *  EXPEDIENTE
 *   listRecords, createRecord, deleteRecord, getRecordData
 *
 *  ANTECEDENTES / HISTORIA MÉDICA
 *   saveHistory
 *
 *  CONSULTA
 *   saveConsultation, deleteConsultationHistory
 *
 *  EXAMEN FÍSICO
 *   savePhysicalExam, deletePhysicalExam
 *
 *  DIAGNÓSTICO
 *   saveDiagnosis, deleteDiagnosis, getDiagnosisContext, generateDiagnosisAI
 *
 *  TRATAMIENTOS
 *   addTreatment, updateTreatment, deleteTreatment, generateTreatmentAI
 *
 *  INYECTABLES (toxina botulínica, rellenos, etc.)
 *   getInjectablesByRecord, getInjectablesByTreatment,
 *   addInjectable, updateInjectable, deleteInjectable
 *
 *  RECETAS / PRESCRIPCIONES
 *   listPrescriptions, getPrescription, createPrescription,
 *   updatePrescription, deletePrescription
 *   getTemplates, saveTemplate, deleteTemplate
 *
 *  CONSENTIMIENTOS INFORMADOS
 *   listConsents, getConsent, saveConsent, deleteConsent
 *   generateSigningToken, getSigningSession, submitSignature
 *   getProfessionalSignature, saveProfessionalSignature
 *
 * ─── Cómo se consume ─────────────────────────────────────────────────────────
 * Toda la lógica de queries está centralizada en `api/records.js`.
 * Este módulo actúa como documentación del dominio y punto de entrada
 * para futuras refactorizaciones.
 *
 * ─── Base de datos ───────────────────────────────────────────────────────────
 * Tablas en Neon PostgreSQL:
 *   patients, clinical_records, medical_history, consultation_info,
 *   consultation_history, physical_exams, diagnoses, treatments,
 *   prescriptions, prescription_templates, consent_forms, injectables
 *
 * @see api/records.js        — Handler HTTP con toda la lógica de queries
 * @see lib/neon-clinical-db.js — Pool de conexión y migrations
 * @see lib/db/index.js        — Capa de DB unificada
 */

// Este archivo sirve como documentación del módulo.
// Re-exporta las funciones de DB del módulo de fichas clínicas.
export { getPool, initClinicalDatabase } from '../../neon-clinical-db.js';
