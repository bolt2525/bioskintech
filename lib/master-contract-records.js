const MODULE_IDS = new Set([
  'clinical-records',
  'inventory',
  'finance',
  'system-status',
  'appointments',
  'database',
  'clinical-3d',
  'dermoatlas',
]);

const OPTIONS = [
  'support',
  'refund',
  'incidentNotice',
  'aiInstructions',
  'activation',
];
const PAYMENT_METHODS = new Set(['Tarjeta', 'Transferencia', 'Efectivo', 'Otro']);

function readText(value, maxLength, required = false) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function validDate(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function readAmount(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && (allowZero ? cents >= 0 : cents > 0) ? cents : null;
}

export function validateMasterContractRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Datos de contrato no válidos.' };

  const clientInput = input.client;
  const optionsInput = input.options;
  const pricesInput = input.prices;
  if (!clientInput || typeof clientInput !== 'object' || Array.isArray(clientInput) ||
    !optionsInput || typeof optionsInput !== 'object' || Array.isArray(optionsInput) ||
    !pricesInput || typeof pricesInput !== 'object' || Array.isArray(pricesInput)) {
    return { error: 'Faltan datos del contrato.' };
  }

  const partyType = clientInput.partyType;
  if (partyType !== 'natural' && partyType !== 'juridica') return { error: 'Tipo de contratante no válido.' };

  const client = {
    partyType,
    contractReference: readText(clientInput.contractReference, 120, true),
    name: readText(clientInput.name, 200, true),
    taxId: readText(clientInput.taxId, 13, true),
    address: readText(clientInput.address, 500, true),
    representative: readText(clientInput.representative, 200),
    representativeId: readText(clientInput.representativeId, 13),
    representativeRole: readText(clientInput.representativeRole, 120),
    email: readText(clientInput.email, 254, true),
    phone: readText(clientInput.phone, 40),
    clinicName: readText(clientInput.clinicName, 200, true),
    startDate: clientInput.startDate,
    paymentMethod: readText(clientInput.paymentMethod, 80, true),
    otherPaymentMethod: readText(clientInput.otherPaymentMethod, 120),
    cardCommission: readText(clientInput.cardCommission, 30),
  };

  if (Object.values(client).some(value => value === null) ||
    !/^[\p{L}\p{N} ._/#-]+$/u.test(client.contractReference) ||
    !/^(?:\d{10}|\d{13})$/.test(client.taxId) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email) ||
    !validDate(client.startDate) ||
    !PAYMENT_METHODS.has(client.paymentMethod) ||
    (partyType === 'juridica' &&
      (!client.representative || !client.representativeId || !client.representativeRole ||
        !/^(?:\d{10}|\d{13})$/.test(client.representativeId))) ||
    (client.paymentMethod === 'Otro' && !client.otherPaymentMethod)) {
    return { error: 'Revise los datos obligatorios del titular, firmante, contacto y vigencia.' };
  }

  if (optionsInput.jurisdiction !== 'Cuenca' && optionsInput.jurisdiction !== 'Quito') {
    return { error: 'Jurisdicción no válida.' };
  }
  const options = { jurisdiction: optionsInput.jurisdiction };
  for (const option of OPTIONS) {
    if (typeof optionsInput[option] !== 'boolean') return { error: 'Condiciones particulares no válidas.' };
    options[option] = optionsInput[option];
  }
  for (const [enabled, field] of [
    ['support', 'supportTerms'],
    ['refund', 'refundTerms'],
    ['aiInstructions', 'aiInstructionTerms'],
    ['activation', 'activationTerms'],
  ]) {
    const text = readText(optionsInput[field], 4000, options[enabled]);
    if (text === null) return { error: 'Las condiciones particulares marcadas requieren un texto válido.' };
    options[field] = text;
  }

  const platformCents = readAmount(pricesInput.platform);
  const chatbotCents = readAmount(pricesInput.chatbot);
  if (platformCents === null || chatbotCents === null || typeof input.chatbot !== 'boolean') {
    return { error: 'Precios no válidos.' };
  }

  const commissionCents = client.paymentMethod === 'Tarjeta'
    ? client.cardCommission ? readAmount(client.cardCommission, { allowZero: true }) : null
    : 0;
  if (commissionCents === null) return { error: 'Recargo de tarjeta no válido.' };

  if (!Array.isArray(input.selectedModules) || input.selectedModules.length === 0 ||
    input.selectedModules.length > MODULE_IDS.size ||
    new Set(input.selectedModules).size !== input.selectedModules.length ||
    input.selectedModules.some(module => typeof module !== 'string' || !MODULE_IDS.has(module))) {
    return { error: 'Seleccione módulos válidos para el contrato.' };
  }

  if (typeof input.legalVersion !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}-r\d+$/.test(input.legalVersion)) {
    return { error: 'Versión legal no válida.' };
  }

  const totalCents = platformCents + (input.chatbot ? chatbotCents : 0) + commissionCents;
  if (!Number.isSafeInteger(totalCents)) return { error: 'El total del contrato no es válido.' };
  const annualTotal = (totalCents / 100).toFixed(2);
  const contractData = {
    client,
    chatbot: input.chatbot,
    options,
    prices: {
      platform: (platformCents / 100).toFixed(2),
      chatbot: (chatbotCents / 100).toFixed(2),
    },
    selectedModules: input.selectedModules,
    legalVersion: input.legalVersion,
    annualTotal,
  };

  return {
    record: {
      contractReference: client.contractReference,
      clientName: client.name,
      taxId: client.taxId,
      clinicName: client.clinicName,
      contactEmail: client.email,
      legalVersion: input.legalVersion,
      annualTotal,
      contractData,
    },
  };
}
