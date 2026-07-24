/**
 * @file api/ai-consultation.js
 * @description MÃ³dulo de Consultas IA â€” permite al mÃ©dico realizar consultas
 * contextuales sobre pacientes usando datos de la ficha clÃ­nica y Gemini AI.
 *
 * Acciones disponibles (query param `action`):
 *  - init            â†’ crea tabla ai_consultations si no existe
 *  - getContextIndex â†’ lista ligera de items disponibles por tab para un paciente
 *  - query           â†’ ejecuta consulta IA con contexto seleccionado
 *  - list            â†’ lista historial de consultas guardadas
 *  - delete          â†’ elimina una consulta
 */

import { getPool } from '../lib/neon-clinical-db.js';
import { authenticateRequest } from '../lib/admin-auth.js';

export default async function handler(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth.valid) return res.status(401).json({ error: 'No autorizado' });

  // effective_clinic_id: cuando master admin usa X-Target-Clinic-Id
  const effectiveClinicId = auth.effective_clinic_id ?? auth.clinic_id;

  const { action } = req.query;
  const pool = getPool();

  try {
    switch (action) {

      // â”€â”€ Inicializar tabla â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'init': {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ai_consultations (
            id SERIAL PRIMARY KEY,
            clinic_id INTEGER,
            user_id TEXT,
            patient_id INTEGER,
            patient_name TEXT,
            consultation_type TEXT DEFAULT 'patient',
            question TEXT,
            context_summary TEXT,
            response TEXT,
            tabs_used TEXT[],
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);
        return res.status(200).json({ ok: true });
      }

      // â”€â”€ Ãndice de contexto disponible para un paciente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'getContextIndex': {
        const { patient_id } = req.query;
        if (!patient_id) return res.status(400).json({ error: 'patient_id requerido' });

        const [history, exams, diagnoses, treatments, prescriptions] = await Promise.all([
          pool.query(
            `SELECT id, created_at, chief_complaint FROM medical_history
             WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 5`,
            [patient_id]
          ).catch(() => ({ rows: [] })),
          pool.query(
            `SELECT id, created_at, skin_type, phototype FROM physical_exams
             WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [patient_id]
          ).catch(() => ({ rows: [] })),
          pool.query(
            `SELECT d.id, d.date, d.diagnosis_text, d.type
             FROM diagnoses d
             JOIN clinical_records cr ON d.record_id = cr.id
             WHERE cr.patient_id = $1 ORDER BY d.date DESC LIMIT 20`,
            [patient_id]
          ).catch(() => ({ rows: [] })),
          pool.query(
            `SELECT t.id, t.date, t.procedure_name, t.area_treated
             FROM treatments t
             JOIN clinical_records cr ON t.record_id = cr.id
             WHERE cr.patient_id = $1 ORDER BY t.date DESC LIMIT 20`,
            [patient_id]
          ).catch(() => ({ rows: [] })),
          pool.query(
            `SELECT p.id, p.date, p.medications
             FROM prescriptions p
             JOIN clinical_records cr ON p.record_id = cr.id
             WHERE cr.patient_id = $1 ORDER BY p.date DESC LIMIT 10`,
            [patient_id]
          ).catch(() => ({ rows: [] })),
        ]);

        return res.status(200).json({
          antecedentes: history.rows,
          examenes: exams.rows,
          diagnosticos: diagnoses.rows,
          tratamientos: treatments.rows,
          recetas: prescriptions.rows,
        });
      }

      // â”€â”€ Consulta IA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'query': {
        const body = req.method === 'POST'
          ? await parseBody(req)
          : JSON.parse(req.query.data || '{}');

        const { patient_id, patient_name, question, selections, save = false } = body;
        if (!question) return res.status(400).json({ error: 'question requerido' });

        const apiKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY no configurada' });

        // Construir contexto a partir de selecciones
        let contextBlocks = [];
        const tabsUsed = [];

        if (patient_id && selections) {
          const sel = selections; // { antecedentes, examenes, diagnosticos, tratamientos, recetas }

          if (sel.antecedentes?.enabled && sel.antecedentes?.ids?.length > 0) {
            tabsUsed.push('antecedentes');
            const rows = await pool.query(
              `SELECT chief_complaint, current_medications, allergies, personal_history, family_history,
                      surgical_history, obstetric_history
               FROM medical_history WHERE patient_id = $1 AND id = ANY($2)`,
              [patient_id, sel.antecedentes.ids]
            ).catch(() => ({ rows: [] }));
            if (rows.rows.length > 0) {
              const h = rows.rows[0];
              contextBlocks.push(`## ANTECEDENTES MÃ‰DICOS
Motivo de consulta: ${h.chief_complaint || 'N/A'}
Medicamentos actuales: ${h.current_medications || 'Ninguno'}
Alergias: ${h.allergies || 'Sin alergias conocidas'}
Antecedentes personales: ${h.personal_history || 'N/A'}
Antecedentes familiares: ${h.family_history || 'N/A'}
CirugÃ­as previas: ${h.surgical_history || 'N/A'}`);
            }
          }

          if (sel.examenes?.enabled && sel.examenes?.ids?.length > 0) {
            tabsUsed.push('examen_fisico');
            const rows = await pool.query(
              `SELECT skin_type, phototype, glogau_scale, lesions_description, face_map_data, body_map_data
               FROM physical_exams WHERE id = ANY($1)`,
              [sel.examenes.ids]
            ).catch(() => ({ rows: [] }));
            if (rows.rows.length > 0) {
              const exBlocks = rows.rows.map(e => {
                let faceStr = '';
                try {
                  const face = typeof e.face_map_data === 'string' ? JSON.parse(e.face_map_data || '[]') : (e.face_map_data || []);
                  if (Array.isArray(face) && face.length > 0)
                    faceStr = '\nLesiones faciales: ' + face.map(f => `${f.category} (${f.distribution || 'General'}) - ${f.severity || 'N/A'}`).join('; ');
                } catch (_) {}
                return `- Tipo piel: ${e.skin_type || 'N/A'} | Fototipo: ${e.phototype || 'N/A'} | Glogau: ${e.glogau_scale || 'N/A'}
  DescripciÃ³n: ${e.lesions_description || 'Sin descripciÃ³n'}${faceStr}`;
              }).join('\n');
              contextBlocks.push(`## EXAMEN FÃSICO\n${exBlocks}`);
            }
          }

          if (sel.diagnosticos?.enabled && sel.diagnosticos?.ids?.length > 0) {
            tabsUsed.push('diagnosticos');
            const rows = await pool.query(
              `SELECT date, diagnosis_text, cie10_code, type, severity, notes
               FROM diagnoses WHERE id = ANY($1) ORDER BY date DESC`,
              [sel.diagnosticos.ids]
            ).catch(() => ({ rows: [] }));
            if (rows.rows.length > 0) {
              const diagText = rows.rows.map(d =>
                `- [${d.date ? new Date(d.date).toLocaleDateString('es-EC') : 'N/A'}] ${d.diagnosis_text} (${d.type}, ${d.severity}) ${d.cie10_code ? 'â€” CIE10: ' + d.cie10_code : ''}`
              ).join('\n');
              contextBlocks.push(`## DIAGNÃ“STICOS\n${diagText}`);
            }
          }

          if (sel.tratamientos?.enabled && sel.tratamientos?.ids?.length > 0) {
            tabsUsed.push('tratamientos');
            const rows = await pool.query(
              `SELECT date, procedure_name, equipment_used, area_treated, duration_minutes, notes
               FROM treatments WHERE id = ANY($1) ORDER BY date DESC`,
              [sel.tratamientos.ids]
            ).catch(() => ({ rows: [] }));
            if (rows.rows.length > 0) {
              const treatText = rows.rows.map(t =>
                `- [${t.date ? new Date(t.date).toLocaleDateString('es-EC') : 'N/A'}] ${t.procedure_name} | Zona: ${t.area_treated || 'N/A'} | Equipo: ${t.equipment_used || 'N/A'}\n  Notas: ${t.notes || 'Sin notas'}`
              ).join('\n');
              contextBlocks.push(`## TRATAMIENTOS REALIZADOS\n${treatText}`);
            }
          }

          if (sel.recetas?.enabled && sel.recetas?.ids?.length > 0) {
            tabsUsed.push('recetas');
            const rows = await pool.query(
              `SELECT date, medications, instructions
               FROM prescriptions WHERE id = ANY($1) ORDER BY date DESC`,
              [sel.recetas.ids]
            ).catch(() => ({ rows: [] }));
            if (rows.rows.length > 0) {
              const recetaText = rows.rows.map(r =>
                `- [${r.date ? new Date(r.date).toLocaleDateString('es-EC') : 'N/A'}] ${r.medications || 'N/A'}\n  Instrucciones: ${r.instructions || 'N/A'}`
              ).join('\n');
              contextBlocks.push(`## RECETAS\n${recetaText}`);
            }
          }
        }

        const contextSummary = contextBlocks.length > 0
          ? contextBlocks.join('\n\n')
          : 'Consulta abierta sin contexto de paciente especÃ­fico.';

        const patientHeader = patient_name
          ? `Paciente: ${patient_name}`
          : 'Consulta abierta';

        const systemPrompt = `Eres un asistente mÃ©dico especializado en medicina estÃ©tica y dermatologÃ­a. Respondes de forma clara, profesional y basada en evidencia.

IMPORTANTE: Tus respuestas son de apoyo al criterio mÃ©dico. Siempre indica que el diagnÃ³stico y tratamiento final es responsabilidad del profesional mÃ©dico.

${patientHeader}

${contextSummary}

---
Pregunta del mÃ©dico: ${question}

Responde de forma clara y estructurada. Si el contexto clÃ­nico es suficiente, proporciona una respuesta detallada. Si falta informaciÃ³n importante, indÃ­calo. Usa formato con secciones cuando sea apropiado.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1500 },
          }),
        });

        if (!geminiRes.ok) {
          const errData = await geminiRes.json();
          throw new Error(errData.error?.message || 'Error en Gemini API');
        }

        const geminiData = await geminiRes.json();
        const response = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta';

        // Guardar si se solicitÃ³
        if (save) {
          await ensureTable(pool);
          await pool.query(
            `INSERT INTO ai_consultations
             (clinic_id, user_id, patient_id, patient_name, consultation_type, question, context_summary, response, tabs_used)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              effectiveClinicId || null,
              auth.username || 'unknown',
              patient_id || null,
              patient_name || null,
              patient_id ? 'patient' : 'open',
              question,
              contextSummary,
              response,
              tabsUsed,
            ]
          ).catch(err => console.warn('Could not save consultation:', err.message));
        }

        return res.status(200).json({ response, contextSummary, tabsUsed });
      }

      // â”€â”€ Historial de consultas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'list': {
        const { patient_id, limit = 20 } = req.query;
        await ensureTable(pool);
        let q = `SELECT id, patient_id, patient_name, consultation_type, question,
                        LEFT(response, 200) AS response_preview, tabs_used, created_at
                 FROM ai_consultations
                 WHERE clinic_id = $1`;
        const params = [effectiveClinicId || null];
        if (patient_id) {
          q += ` AND patient_id = $2`;
          params.push(patient_id);
        }
        q += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const result = await pool.query(q, params);
        return res.status(200).json(result.rows);
      }

      // â”€â”€ Eliminar consulta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'delete': {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id requerido' });
        await pool.query('DELETE FROM ai_consultations WHERE id = $1', [id]);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `AcciÃ³n desconocida: ${action}` });
    }
  } catch (err) {
    console.error('[ai-consultation] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/** Crea la tabla si no existe (idempotente) */
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_consultations (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER,
      user_id TEXT,
      patient_id INTEGER,
      patient_name TEXT,
      consultation_type TEXT DEFAULT 'patient',
      question TEXT,
      context_summary TEXT,
      response TEXT,
      tabs_used TEXT[],
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
}

/** Parsea el body de POST (necesario para serverless sin body-parser) */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) return resolve(req.body);
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
