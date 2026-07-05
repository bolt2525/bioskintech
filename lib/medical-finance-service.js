
import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEYS = [
  process.env.GOOGLE_GEMINI_API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_API_KEY
].filter(Boolean);

export async function parseMedicalNote(noteText) {
  if (API_KEYS.length === 0) {
    throw new Error("No Gemini API keys configured");
  }
  
  // Try multiple models in order of preference/speed, mirroring the working configuration in finance-ai-service.js
  const models = [
    "gemini-2.5-flash", 
    "gemini-2.0-flash-lite", 
    "gemini-2.0-flash", 
    "gemini-flash-latest"
  ];
  
  let lastError = null;

  for (const modelName of models) {
    try {
      console.log(`🤖 Intentando análisis con modelo: ${modelName}`);
      // Use the first available key for now (simple logic)
      const genAI = new GoogleGenerativeAI(API_KEYS[0]);
      const model = genAI.getGenerativeModel({ model: modelName });

      const prompt = `
        Analiza el siguiente texto que puede contener UNO o MÚLTIPLES registros financieros (procedimientos médicos, ventas, gastos o ingresos varios).
        Tu tarea es extraer la información financiera de CADA registro y estructurarla en una lista JSON.

        Texto: "${noteText}"

        Reglas de extracción para CADA registro:
        1. Identifica el nombre del paciente o de la compra/gasto. Convierte a MAYÚSCULAS.
        2. Identifica el TIPO (Ingreso vs Gasto):
           - Si dice "Compra", "Gasto", "Pago de comida", "Taxi", "Uber" -> Es un GASTO.
           - Si es tratamiento, consulta, cirugía -> Es un INGRESO.
        3. Montos:
           - Si es INGRESO: Pon el valor en 'total_payment'. 'expenses' será 0.
           - Si es GASTO: Pon el valor en 'expenses'. 'total_payment' será 0.
        4. Identifica si hay un "ABONO" o pago parcial. Campo: abono.
        5. Identifica método de pago.
        6. Si se mencionan Clínicas/Lugares (ej: MDS, CONSULTORIO, CLINICA), extraelo en el campo 'clinic'.
           - Si es INGRESO y no dice nada, default: "HSJD".
           - Si es GASTO y no dice nada, default: "" (vacio).
        7. Extrae cualquier detalle relevante en el campo 'details' (ej: "factura en efectivo", "paga a mi por transferencia").
        7. Honorarios médicos o validación de nombres:
           - Si se mencionan nombres de doctores o asistentes asociados a pagos...
        
        Formato de respuesta JSON esperado (SOLO JSON, sin markdown):
        {
          "registros": [
            {
              "patient_name": "NOMBRE PACIENTE O CONCEPTO GASTO (MAYUSCULAS)",
              "intervention_date": "YYYY-MM-DD",
              "intervention_type": "string",
              "total_payment": number, // Solo para ingresos
              "expenses": number,      // Solo para gastos operativos (comida, insumos)
              "abono": number,
              "payment_method": "string",
              "clinic": "string",
              "doctor_fees": { ... },
              "details": "string (detalles extra, observaciones puntuales)"
            }
          ]
        }
      `;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();
      
      // Limpiar markdown json si existe
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      
      const parsed = JSON.parse(text);
      const records = parsed.registros || [parsed]; // Support both array wrapper and single object fallback

      // Process each record to ensure doctor_fees is an array
      const processedRecords = records.map(record => {
        // Default doctor_fees to empty array if undefined
        if (!record.doctor_fees) {
          record.doctor_fees = [];
        }

        // Transform doctor_fees object to array for frontend compatibility if it's an object
        if (typeof record.doctor_fees === 'object' && !Array.isArray(record.doctor_fees)) {
          const feesArray = [];
          const feeMap = {
            'juan_pablo': 'Dr. Juan Pablo',
            'mary': 'Dra. Mary',
            'anesthesiologist': 'Anestesiólogo',
            'assistant': 'Asistente',
            'other': 'Otro',
            // Add flexibility for dynamic keys from updated prompt
            'dr_ivan': 'Dr. Iván',
            'marietha': 'Dra. Marietha',
            'diana': 'Dra. Diana'
          };

          for (const [key, amount] of Object.entries(record.doctor_fees)) {
            // Include dynamic keys even if not in map, capitalizing them
            const displayName = feeMap[key.toLowerCase()] || key.charAt(0).toUpperCase() + key.slice(1);
            
            if (amount > 0) {
              feesArray.push({
                name: displayName,
                amount: Number(amount)
              });
            }
          }
          record.doctor_fees = feesArray;
        }
        return record;
      });

      return processedRecords;

    } catch (error) {
      console.warn(`⚠️ Modelo ${modelName} falló:`, error.message);
      lastError = error;
      // Continue to next model
    }
  }

  console.error("Todos los modelos de IA fallaron:", lastError);
  throw new Error("Falló el procesamiento de la nota con todos los modelos de IA disponibles.");
}
