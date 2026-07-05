export const taxRules = {
  general: "Deducibles del SRI para el RIMPE/Régimen General. Regla de Oro: Indispensable para generar ingresos.",
  users: {
    Rafael: {
      profession: "Ingeniero Biomédico / Técnico",
      deductible_keywords: [
        "herramienta", "repuesto", "electrónica", "cable", "batería",
        "mantenimiento", "gasolina", "peaje", "parqueadero", "internet",
        "plan celular", "uniforme", "botas", "casco", "lente seguridad",
        "multímetro", "osciloscopio", "software", "licencia", "nube",
        "curso online", "capacitación", "suscripción", "hosting", "dominio"
      ],
      personal_keywords: [
        "cine", "ropa", "zapatos", "supermercado", "juguete", "gym",
        "restaurante", "bar", "hotel", "viaje turismo", "netflix", "spotify"
      ],
      warnings: {
        "alimentacion": "⚠️ Deducible solo si es 'Reunión de Negocios' con clientes. (Máx 3% ingresos). Adjuntar detalle en nota.",
        "vehiculo": "✅ Deducible (gasolina/mtto) al 100% solo si el vehículo está a TU NOMBRE y es herramienta de trabajo.",
        "salud": "❌ Gasto Personal (Rebaja IR). No genera crédito tributario.",
        "viaje": "✈️ Deducible solo si es visita técnica o proyecto fuera de la ciudad."
      }
    },
    Daniela: {
      profession: "Médico Estético",
      deductible_keywords: [
        "insumo médico", "farmacia", "bata", "uniforme", "guantes",
        "jeringa", "toxina", "ácido hialurónico", "gasa", "alcohol",
        "congreso", "curso", "publicidad", "marketing", "consultorio", "alquiler",
        "suscripción médica", "software médico", "gremio", "permiso", "bomberos",
        "lavandería", "limpieza", "desechos"
      ],
      personal_keywords: [
        "ropa", "cartera", "joya", "maquillaje personal", "peluquería",
        "supermercado", "colegio", "restaurante", "cine", "vacaciones"
      ],
      warnings: {
        "alimentacion": "❌ Generalmente Gasto Personal. Deducible solo como 'Representación' (reunión proveedores/conferencistas).",
        "vehiculo": "⚠️ Deducible proporcionalmente a visitas domiciliarias o congresos. Rutina Casa-Consultorio NO es deducible.",
        "belleza": "❌ Peluquería/Uñas: Gasto Personal. Insumos para pacientes: Deducible.",
        "congreso": "✅ Deducible 100% (Inscripción + Viáticos) si es de especialidad médica."
      }
    }
  }
};

export const deductibilityLogic = (description: string, user: string) => {
  if (!user || user === 'Global') return { status: 'neutral', text: '' };
  
  // Normalizar nombre de usuario para match con reglas
  const userKey = user.includes('Rafael') ? 'Rafael' : (user.includes('Daniela') ? 'Daniela' : null);
  
  // Type assertion or check to ensure userKey is valid key of taxRules.users
  // Since taxRules is inferred, we cast to any or just check existence safely
  if (!userKey || !(taxRules.users as any)[userKey]) return { status: 'neutral', text: '' };

  const rules = (taxRules.users as any)[userKey];
  const lowerDesc = description.toLowerCase();
  
  // 1. Check Deductible Keywords
  const isDeductible = rules.deductible_keywords.some(k => lowerDesc.includes(k));
  if (isDeductible) return { 
    status: 'deductible', 
    text: '✅ Deducible Negocio', 
    color: 'text-green-700 bg-green-50'
  };

  // 2. Check Personal Keywords
  const isPersonal = rules.personal_keywords.some(k => lowerDesc.includes(k));
  if (isPersonal) return { 
    status: 'personal', 
    text: '👤 Gasto Personal', 
    color: 'text-blue-700 bg-blue-50'
  };

  // 3. Logic based on categories/warnings
  if (lowerDesc.includes('comida') || lowerDesc.includes('restaurante') || lowerDesc.includes('almuerzo')) 
    return { status: 'warning', text: rules.warnings.alimentacion, color: 'text-orange-700 bg-orange-50' };
    
  if (lowerDesc.includes('gasolina') || lowerDesc.includes('llanta') || lowerDesc.includes('taller') || lowerDesc.includes('mantenimiento')) 
    return { status: 'warning', text: rules.warnings.vehiculo, color: 'text-orange-700 bg-orange-50' };

  if (lowerDesc.includes('viaje') || lowerDesc.includes('boleto') || lowerDesc.includes('hotel')) 
    return { status: 'warning', text: '⚠️ ¿Es viaje de negocios? Requiere sustento.', color: 'text-amber-700 bg-amber-50' };

  // Default fallback
  return { status: 'neutral', text: '❓ Clasificar Manualmente', color: 'text-gray-500 bg-gray-50' };
};
