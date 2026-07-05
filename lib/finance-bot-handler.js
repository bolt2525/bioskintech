
import axios from 'axios';
import { analyzeInvoiceImage } from './finance-ai-service.js';
import { sql } from '@vercel/postgres'; // Usar la misma que neon-chatbot-db-vercel
import { getPool } from './neon-clinical-db.js';

// Números autorizados (formato 593...)
// 0997061321 (Rafael) -> 593997061321
// 0998653732 (Daniela) -> 593998653732
const AUTHORIZED_USERS = {
  '593997061321': 'Rafael', // Rafael
  '593998653732': 'Daniela', // Daniela
  '593969890689': 'Admin', // Backup por si acaso
  '593988148890': 'Bot Admin' // Número del propio bot (para pruebas/admin)
};

const STATE_PREFIX = 'finance_flow_';

// Diccionario de campos para modificación
const FIELD_MAPPING = {
  'fecha': 'date',
  'numero': 'invoice_number',
  'factura': 'invoice_number',
  'cliente': 'entity',
  'proveedor': 'entity',
  'entidad': 'entity',
  'subtotal': 'subtotal',
  'iva': 'tax',
  'impuesto': 'tax',
  'total': 'total',
  'detalle': 'description',
  'descripcion': 'description',
  'tipo': 'type',
  'registrado': 'registered_by'
};

async function getFinanceState(phone) {
  try {
    const result = await sql`
      SELECT state FROM chatbot_app_states 
      WHERE state_type = ${STATE_PREFIX + phone} 
      ORDER BY id DESC LIMIT 1
    `;
    return result.rows[0]?.state || null;
  } catch (e) {
    console.error('Error fetching finance state:', e);
    return null;
  }
}

async function saveFinanceState(phone, state) {
  try {
    // Upsert logic simplificada: borrar anterior y crear nuevo
    await sql`DELETE FROM chatbot_app_states WHERE state_type = ${STATE_PREFIX + phone}`;
    await sql`
      INSERT INTO chatbot_app_states (state_type, state, timestamp)
      VALUES (${STATE_PREFIX + phone}, ${state}, NOW())
    `;
  } catch (e) {
    console.error('Error saving finance state:', e);
  }
}

async function clearFinanceState(phone) {
  try {
    await sql`DELETE FROM chatbot_app_states WHERE state_type = ${STATE_PREFIX + phone}`;
  } catch (e) {
    console.error('Error clearing finance state:', e);
  }
}

async function saveRecordToDB(data) {
  const pool = getPool();
  if (!pool) throw new Error('Database connection failed');

  const client = await pool.connect();
  try {
    // Asegurar que registered_by es válido
    const validOwners = ['Rafael', 'Daniela'];
    const owner = validOwners.includes(data.registered_by) ? data.registered_by : 'Rafael';

    await client.query(`
      INSERT INTO financial_records 
      (invoice_number, date, entity, subtotal, tax, total, description, type, registered_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed')
    `, [
      data.invoice_number, 
      data.date, 
      data.entity, 
      data.subtotal || 0, 
      data.tax || 0, 
      data.total || 0, 
      data.description, 
      data.type, 
      owner
    ]);
  } finally {
    client.release();
  }
}

function formatCurrency(val) {
  return parseFloat(val || 0).toFixed(2);
}

function generateSummary(data) {
  return `📊 *Resumen de ${data.type === 'ingreso' ? 'VENTA' : 'COMPRA'}*
  
📄 *N° Factura:* ${data.invoice_number || 'S/N'}
📅 *Fecha:* ${data.date || 'Desconocida'}
👤 *${data.type === 'ingreso' ? 'Cliente' : 'Proveedor'}:* ${data.entity || 'Desconocido'}
📝 *Detalle:* ${data.description || 'Sin detalle'}

💵 *Subtotal:* $${formatCurrency(data.subtotal)}
💰 *IVA (15%):* $${formatCurrency(data.tax)}
💳 *TOTAL:* $${formatCurrency(data.total)}

👤 *Registra:* ${data.registered_by}

-----------------------------
*Opciones:*
1️⃣ *Confirmar* (Guardar)
2️⃣ *Modificar* (Ej: "Modificar total")
3️⃣ *Cancelar*`;
}

export async function handleFinanceMessage(phone, message, type, entryData) {
  console.log(`💰 [FinanceBot] Procesando mensaje de ${phone} (${AUTHORIZED_USERS[phone] || 'Desconocido'}) - Tipo: ${type}`);

  // 1. Verificación de usuario autorizado
  if (!AUTHORIZED_USERS[phone]) {
    return null; // No autorizado, dejar pasar al bot normal
  }

  const userState = await getFinanceState(phone);

  // 2. Manejo de IMAGEN o DOCUMENTO (Inicio de flujo)
  if (type === 'image' || type === 'document') {
    // Obtener ID (imagen o documento)
    let mediaId = null;
    let mimeType = 'image/jpeg';

    if (type === 'image') {
       mediaId = entryData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.image?.id;
       mimeType = entryData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.image?.mime_type || 'image/jpeg';
    } else if (type === 'document') {
       mediaId = entryData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.document?.id;
       mimeType = entryData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.document?.mime_type;
       
       // Validar que sea PDF
       if (mimeType !== 'application/pdf') {
         return { handled: true, response: "⚠️ Por ahora solo acepto documentos PDF o imágenes de facturas." };
       }
    }

    if (!mediaId) return null;

    try {
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      const mediaUrlResp = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const mediaUrl = mediaUrlResp.data.url;

      // 2. Descargar binario
      const imageResp = await axios.get(mediaUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer'
      });
      
      const mediaBuffer = Buffer.from(imageResp.data);

      // 3. Análisis IA
      const analysis = await analyzeInvoiceImage(mediaBuffer, mimeType);
      
      if (!analysis || !analysis.is_invoice) {
        return { handled: true, response: "❌ El documento no parece ser una factura válida o no es legible." };
      }

      // Asignar dueño por defecto
      analysis.registered_by = AUTHORIZED_USERS[phone];

      // NUEVO FLUJO: Preguntar tipo (Ingreso/Gasto) antes de confirmar
      await saveFinanceState(phone, {
        step: 'WAITING_FOR_TYPE',
        data: analysis
      });

      return {
        handled: true,
        response: `📄 *Factura Detectada*\n\nEmisor: ${analysis.entity || 'Desconocido'}\nTotal: $${formatCurrency(analysis.total)}\n\n¿Es un *Ingreso* (Venta) o un *Egreso* (Gasto)?`
      };

    } catch (err) {
      console.error('Error processing invoice image:', err);
      return { handled: true, response: "⚠️ Error procesando la imagen de la factura. Intenta nuevamente." };
    }
  }

  // 3. Manejo de TEXTO (Flujo de estado)
  if (type === 'text' && userState) {
    const text = message.trim();
    const cleanText = text.toLowerCase();

    // Cancelar
    if (cleanText === 'cancelar' || cleanText === '3') { // "3" por opción del menú
      await clearFinanceState(phone);
      return { handled: true, response: "🚫 Operación cancelada. Puedes enviar otra foto." };
    }

    // FLUJO: WAITING_FOR_TYPE (Ingreso vs Egreso)
    if (userState.step === 'WAITING_FOR_TYPE') {
      let selectedType = null;
      
      // Detección simple
      if (cleanText.includes('ingreso') || cleanText.includes('venta') || cleanText.includes('entrada')) {
         selectedType = 'ingreso';
      } else if (cleanText.includes('egreso') || cleanText.includes('gasto') || cleanText.includes('compra') || cleanText.includes('salida')) {
         selectedType = 'egreso';
      }

      if (selectedType) {
        userState.data.type = selectedType;
        userState.step = 'WAITING_CONFIRMATION';
        await saveFinanceState(phone, userState);
        
        return {
          handled: true,
          response: `✅ *Tipo Registrado: ${selectedType === 'ingreso' ? 'INGRESO' : 'EGRESO'}*\n\n${generateSummary(userState.data)}`
        };
      } else {
        return { handled: true, response: "⚠️ No te entendí. Por favor responde *Ingreso* o *Egreso*." };
      }
    }

    // FLUJO: WAITING_CONFIRMATION
    if (userState.step === 'WAITING_CONFIRMATION') {
      if (cleanText === 'confirmar' || cleanText === 'si' || cleanText === 'ok' || cleanText === '1') {
        try {
          await saveRecordToDB(userState.data);
          await clearFinanceState(phone);
          return { handled: true, response: "✅ *¡Registro Guardado Exitosamente!* 💾" };
        } catch (dbErr) {
          console.error("DB Save Error:", dbErr);
          return { handled: true, response: "❌ Error guardando en base de datos. Intenta 'Confirmar' de nuevo." };
        }
      }

      if (cleanText.includes('modificar') || cleanText === '2') {
        userState.step = 'WAITING_FIELD_SELECTION';
        await saveFinanceState(phone, userState);
        return { handled: true, response: "¿Qué campo deseas modificar? (Ej: fecha, total, cliente, tipo)" };
      }
      
      // Intentar detectar si escribió una corrección directa? No, mejor seguir flujo estricto
      return { handled: true, response: "Por favor responde *Confirmar*, *Modificar* o *Cancelar*." };
    }

    // FLUJO: WAITING_FIELD_SELECTION
    if (userState.step === 'WAITING_FIELD_SELECTION') {
      // Buscar campo en el texto
      const foundField = Object.keys(FIELD_MAPPING).find(k => cleanText.includes(k));
      
      if (foundField) {
        const fieldKey = FIELD_MAPPING[foundField];
        userState.step = 'WAITING_USE_VALUE';
        userState.editing_field = fieldKey;
        await saveFinanceState(phone, userState);
        return { handled: true, response: `Ingresa el nuevo valor para *${foundField.toUpperCase()}*:` };
      } else {
        return { handled: true, response: "⚠️ No reconocí ese campo. Intenta con: fecha, factura, cliente, total, iva." };
      }
    }

    // FLUJO: WAITING_USE_VALUE
    if (userState.step === 'WAITING_USE_VALUE') {
      let newValue = text;
      const field = userState.editing_field;

      // Normalización básica
      if (['subtotal', 'tax', 'total'].includes(field)) {
        newValue = parseFloat(text.replace(/,/g, '.').replace(/[^\d.]/g, '')) || 0;
      }
      
      // Normalización de TIPO (Ingreso/Egreso)
      if (field === 'type') {
         const lower = text.toLowerCase();
         if (lower.includes('ingreso') || lower.includes('venta') || lower.includes('entrada')) {
           newValue = 'ingreso';
         } else if (lower.includes('egreso') || lower.includes('gasto') || lower.includes('compra') || lower.includes('salida')) {
           newValue = 'egreso';
         } else {
           // Si no entendemos, rechazamos
           return { 
             handled: true, 
             response: "⚠️ Tipo no válido. Por favor escribe *Ingreso* o *Egreso*." 
           };
         }
      }

      userState.data[field] = newValue;
      
      // Recalcular total si se cambia subtotal/iva
      if (['subtotal', 'tax'].includes(field)) {
        userState.data.total = (parseFloat(userState.data.subtotal) || 0) + (parseFloat(userState.data.tax) || 0);
      }

      userState.step = 'WAITING_CONFIRMATION';
      delete userState.editing_field;
      
      await saveFinanceState(phone, userState);
      
      return { 
        handled: true, 
        response: `✅ *Campo Actualizado*\n\n${generateSummary(userState.data)}`
      };
    }
  }

  // Si no hay estado activo y es texto, ignorar (return null)
  return null;
}
