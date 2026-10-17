const toDateOnly = value => {
  if (!value) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value);
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})(?:T.*)?$/);
  if (isoDate) return isoDate[1];
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : text;
};

const isCanonicalDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const isIsoTimestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
  && Number.isFinite(Date.parse(value));

export function validateTreatmentFinanceInput(input) {
  if (Object.hasOwn(input, 'procedure_name')
      && (typeof input.procedure_name !== 'string' || !input.procedure_name.trim() || input.procedure_name.length > 150)) {
    return 'Procedimiento inválido';
  }
  if (Object.hasOwn(input, 'date') && !isCanonicalDate(input.date)) return 'Fecha inválida';
  if (Object.hasOwn(input, 'consultation_id')
      && (!Number.isSafeInteger(input.consultation_id) || input.consultation_id <= 0)) {
    return 'consultation_id válido es requerido';
  }
  if (Object.hasOwn(input, 'package_id')
      && input.package_id !== null
      && (!Number.isSafeInteger(input.package_id) || input.package_id <= 0)) {
    return 'package_id inválido';
  }
  return null;
}

export function hasProtectedTreatmentFinanceChanges(current, next) {
  if (typeof next.procedure_name !== 'string'
      || ![next.consultation_id, next.package_id].every(value => value === null || Number.isSafeInteger(value))
      || !(next.date instanceof Date || isCanonicalDate(next.date) || isIsoTimestamp(next.date))) {
    return true;
  }
  return Number(next.cost) !== Number(current.cost)
    || Number(next.consultation_id) !== Number(current.consultation_id)
    || Number(next.package_id || 0) !== Number(current.package_id || 0)
    || toDateOnly(next.date) !== toDateOnly(current.date)
    || String(next.procedure_name || '') !== String(current.procedure_name || '');
}
