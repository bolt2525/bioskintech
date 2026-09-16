// Generación de CSV de finanzas — columnas iguales al export del cliente en AdminFinance.tsx
const FORMULA_INJECTION_PREFIX = /^[=+\-@]/;

/** Escapa una celda de CSV y neutraliza inyección de fórmulas al abrir en Excel/Sheets. */
export function escapeCsvCell(value) {
  let str = String(value ?? '');
  if (FORMULA_INJECTION_PREFIX.test(str)) str = `'${str}`;
  if (/[",\n]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** Construye el CSV (con BOM UTF-8) de una lista de financial_records. */
export function buildFinanceCsv(records) {
  const headers = ['Fecha', 'N° Factura', 'Entidad', 'Descripción', 'Tipo', 'Subtotal', 'IVA', 'Total', 'Registrado por'];
  const rows = (records || []).map(r => [
    String(r.date || '').split('T')[0],
    r.invoice_number || '',
    r.entity || '',
    r.description || '',
    r.type || '',
    Number(r.subtotal || 0).toFixed(2),
    Number(r.tax || 0).toFixed(2),
    Number(r.total || 0).toFixed(2),
    r.registered_by || '',
  ]);
  const csv = [headers, ...rows].map(row => row.map(escapeCsvCell).join(',')).join('\n');
  return `\uFEFF${csv}`;
}
