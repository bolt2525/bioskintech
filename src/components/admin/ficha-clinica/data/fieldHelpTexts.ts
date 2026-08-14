/**
 * Textos de ayuda clínica para los íconos de campo en fichas clínicas.
 * Redactados en español clínico. Ajustables por revisión del equipo médico.
 */

export const HELP = {
  // ── Examen Físico ──────────────────────────────────────────────────────────
  physical: {
    skin_type: 'Clasificación del tipo de piel: normal (equilibrada), seca (falta de sebo), grasa (exceso de sebo), mixta (zona T grasa, mejillas secas) o sensible (reactiva a estímulos).',
    phototype: 'Fototipo de Fitzpatrick (I–VI): indica la respuesta de la piel a la radiación UV, riesgo de quemaduras, bronceado y carcinogénesis. I = muy clara, VI = muy oscura.',
    glogau_scale: 'Escala de envejecimiento de Glogau (I–IV): clasifica el daño actínico y las arrugas. I = sin arrugas (20–30 años), IV = arrugas severas con piel engrosada.',
    hydration: 'Nivel de hidratación cutánea percibida. Deshidratada: tirantez y finas líneas. Bien hidratada: piel suave y elástica.',
    elasticity: 'Capacidad de la piel para volver a su posición al pellizcar o estirar. Disminuye con la edad y el daño solar.',
    photoprotection: 'Hábito de uso de protector solar: nunca, ocasional (fines de semana) o diario. Factor determinante en el envejecimiento cutáneo.',
    texture: 'Textura superficial al tacto: fina (lisa), normal o gruesa/irregular (queratosis, engrosamiento).',
    pores: 'Tamaño visible de los poros faciales. Poros dilatados suelen asociarse a piel grasa y predisposición a comedones.',
    pigmentation: 'Alteraciones en el pigmento: melasma, lentigos solares, hiperpigmentación post-inflamatoria (HPI), efalides (pecas).',
    sensitivity: 'Reactividad cutánea ante estímulos leves (calor, cosméticos, fricción): enrojecimiento, picor, ardor o escozor.',
    lesions_description: 'Descripción libre de lesiones elementales observadas: máculas, pápulas, nódulos, vesículas, escamas, comedones, cicatrices, etc.',
    face_map: 'Marcaciones en el mapa facial 2D o 3D. Selecciona el tercio (superior/medio/inferior) y la categoría de lesión para registrar la ubicación.',
    body_map: 'Marcaciones en el mapa corporal. Indica zona anatómica y categoría de lesión para documentar hallazgos en tronco, extremidades, etc.',
  },

  // ── Diagnóstico ────────────────────────────────────────────────────────────
  diagnosis: {
    diagnosis_text: 'Diagnóstico clínico redactado en lenguaje médico. Puede ser presuntivo (basado en inspección y anamnesis) o confirmado (respaldado por estudios o biopsia).',
    cie10_code: 'Código de la Clasificación Internacional de Enfermedades 10ª revisión. Ejemplo: L70.0 = Acné vulgaris, L57.0 = Queratosis actínica.',
    type: 'Presuntivo: diagnóstico de trabajo, pendiente confirmación. Confirmado: certeza diagnóstica con evidencia clínica o paraclínica suficiente.',
    severity: 'Grado de afectación: leve (cosmético, sin impacto funcional), moderado (requiere tratamiento activo), severo (sistémico, incapacitante o de alto riesgo).',
    notes: 'Observaciones adicionales: diagnósticos diferenciales descartados, correlaciones con antecedentes, hallazgos paraclínicos relevantes o notas de evolución.',
  },

  // ── Tratamientos ───────────────────────────────────────────────────────────
  treatment: {
    procedure_name: 'Nombre del procedimiento estético-médico realizado. Ejemplo: peeling químico, radiofrecuencia fraccionada, microagujas RF, IPL.',
    equipment_used: 'Equipo o dispositivo médico utilizado, incluyendo marca y referencia del modelo. Importante para trazabilidad y parámetros reproducibles.',
    parameters: 'Parámetros técnicos del procedimiento (energía en J/cm², potencia en W, frecuencia en Hz, número de passes, tiempo de exposición). Varían según equipo.',
    area_treated: 'Zona anatómica tratada. Ejemplo: rostro completo, frente, surcos nasogenianos, escote, manos, abdomen.',
    duration_minutes: 'Tiempo efectivo del procedimiento en minutos, excluyendo preparación del paciente, anestesia tópica y tiempo de recuperación.',
    cost: 'Costo del procedimiento en moneda local para efectos de facturación interna y estadísticas financieras de la clínica.',
    notes: 'Observaciones de la sesión: tolerancia del paciente, reacciones inmediatas (eritema, edema, dolor escala), ajustes realizados, incidencias.',
  },

  // ── Recetas ────────────────────────────────────────────────────────────────
  prescription: {
    diagnostico: 'Diagnóstico o indicación clínica que justifica la prescripción. Se transfiere al documento de receta médica.',
    medicamento: 'Nombre DCI (Denominación Común Internacional) del principio activo. Ejemplo: tretinoína, ácido azelaico, clindamicina, hidroquinona.',
    nombre_comercial: 'Marca comercial disponible en el mercado local. Facilita la adquisición por parte del paciente.',
    indicaciones: 'Posología completa: dosis, frecuencia, vía de administración y duración del tratamiento. Ejemplo: "Aplicar 1 vez/noche en zona afectada durante 3 meses".',
    rutina: 'Momento de aplicación dentro de la rutina de cuidado. Mañana (bajo protector solar), noche (mayor penetración), o ambos turnos.',
    notes: 'Instrucciones generales para el paciente, advertencias sobre reacciones iniciales esperadas (purga de tretinoína) o interacciones con otros productos.',
  },

  // ── Inyectables — Toxina Botulínica ────────────────────────────────────────
  toxina: {
    product_name: 'Nombre comercial de la toxina botulínica tipo A. Ejemplo: Botox® (onabotulinumtoxinA), Dysport® (abobotulinumtoxinA), Xeomin® (incobotulinumtoxinA).',
    brand: 'Laboratorio fabricante de la toxina. Relevante para la equivalencia de unidades entre marcas (1 U Botox ≈ 2.5-3 U Dysport).',
    units_used: 'Unidades totales de toxina aplicadas en la sesión. Dosis habitual: frente 10–20 U, entrecejo 20–30 U, patas de gallo 10–15 U por lado.',
    dilution_volume: 'Volumen en mL de solución fisiológica (NaCl 0.9%) utilizado para reconstituir el vial. Afecta la difusión: menor volumen = mayor concentración.',
    areas_treated: 'Músculos o zonas de aplicación: frontal, corrugador, procerus, orbicular ocular, mentalis, platisma, masetero, etc.',
    injection_plane: 'Plano de la inyección: intramuscular (efecto motor, standard), subdérmico (wrinkle relaxer) o subcutáneo (menor difusión).',
    technique: 'Técnica de aplicación utilizada. Ejemplo: inyección puntual, técnica de microgotas, protocolo baby botox.',
    needle_type: 'Calibre y tipo de aguja. Estándar: 30G×½" o 32G. Agujas más finas reducen dolor y equimosis.',
    follow_up_date: 'Fecha para control post-aplicación. Habitualmente a las 2 semanas para evaluar resultado y aplicar retoques si es necesario.',
  },

  // ── Inyectables — Rellenos ─────────────────────────────────────────────────
  relleno: {
    product_name: 'Nombre del producto de relleno. Ejemplo: ácido hialurónico (Juvéderm, Restylane), hidroxiapatita cálcica (Radiesse), PLLA (Sculptra).',
    volume_used: 'Volumen total de relleno aplicado en la sesión en mL. El relleno labial suele requerir 0.5–1 mL por labio.',
    areas_treated: 'Zonas de relleno: labios, surcos nasogenianos, pómulos, mentón, ojeras, ángulo mandibular, manos.',
    technique: 'Técnica de infiltración: retrógrada (lineal), anterógrada, abanico (fanning), reticulado (cross-hatching), depósito puntual (bolus).',
    needle_type: 'Instrumento utilizado: aguja (mayor precisión, mayor riesgo vascular) o microcánula (menor trauma, menor riesgo vascular).',
    injection_plane: 'Plano de inyección: subdérmico profundo (relleno volumétrico), supraperióstico (proyección ósea), intradérmico superficial (líneas finas).',
    follow_up_date: 'Fecha para control. Algunos rellenos requieren moldeado a las 2 semanas o sesiones adicionales de PLLA a los 4–6 semanas.',
  },

  // ── Consentimientos ────────────────────────────────────────────────────────
  consent: {
    procedure_type: 'Tipo de procedimiento estético al que aplica el consentimiento informado. Debe coincidir con el procedimiento documentado en el tratamiento.',
    zone: 'Zona anatómica específica del procedimiento. Ejemplo: tercio superior facial, labios, abdomen.',
    sessions: 'Número de sesiones contempladas en el plan de tratamiento informado. El paciente consiente el ciclo completo.',
    objectives: 'Objetivos estéticos o terapéuticos acordados y comunicados al paciente: reducción de arrugas, aumento de volumen, mejoría de textura, etc.',
    risks: 'Riesgos y posibles efectos adversos del procedimiento: edema, equimosis, asimetría, granuloma, necrosis, efecto Tyndall (rellenos), ptosis (toxina).',
    alternatives: 'Alternativas terapéuticas presentadas al paciente antes de decidir el procedimiento. Incluye opciones no invasivas y no tratamiento.',
    pre_care: 'Instrucciones de preparación previa: evitar anticoagulantes (aspirina, ibuprofeno), alcohol, vitamina E, depilación, sol intenso.',
    post_care: 'Cuidados post-procedimiento: aplicación de frío, evitar calor, masajes, sol, actividad física intensa y ciertos medicamentos durante el período indicado.',
    contraindications: 'Contraindicaciones absolutas y relativas evaluadas antes del procedimiento: embarazo, lactancia, enfermedades autoinmunes, anticoagulación, infección activa.',
  },
} as const;
