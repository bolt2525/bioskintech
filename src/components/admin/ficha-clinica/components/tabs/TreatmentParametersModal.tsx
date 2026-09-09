/**
 * Modal para registrar los parámetros de un equipo/aparatología dentro de una sesión de tratamiento.
 * Sugiere campos según el tipo de aparatología detectado en el nombre del equipo/procedimiento,
 * pero también soporta tratamientos manuales sin aparatología y campos libres.
 * El resultado se formatea como texto legible y se inserta en el campo "Notas" del tratamiento.
 */
import { useEffect, useState } from 'react';
import { X, Sparkles, Plus, Trash2 } from 'lucide-react';

type FieldType = 'text' | 'number';

interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  unit?: string;
  placeholder?: string;
}

interface CategoryTemplate {
  label: string;
  fields: TemplateField[];
}

const TEMPLATES: Record<string, CategoryTemplate> = {
  laser: {
    label: 'Láser / IPL',
    fields: [
      { key: 'wavelength', label: 'Longitud de onda', type: 'text', unit: 'nm' },
      { key: 'fluence', label: 'Energía / Fluencia', type: 'text', unit: 'J/cm²' },
      { key: 'spot_size', label: 'Spot size', type: 'text', unit: 'mm' },
      { key: 'frequency', label: 'Frecuencia', type: 'text', unit: 'Hz' },
      { key: 'pulses', label: 'N° de pulsos', type: 'number' },
      { key: 'passes', label: 'N° de pases', type: 'number' },
      { key: 'pulse_mode', label: 'Modo de pulso', type: 'text', placeholder: 'single / burst' },
      { key: 'cooling', label: 'Enfriamiento', type: 'text' },
    ],
  },
  radiofrecuencia: {
    label: 'Radiofrecuencia',
    fields: [
      { key: 'power', label: 'Potencia', type: 'text', unit: 'W' },
      { key: 'target_temp', label: 'Temperatura objetivo', type: 'text', unit: '°C' },
      { key: 'mode', label: 'Modo', type: 'text', placeholder: 'mono / bipolar / fraccionada' },
      { key: 'time_per_area', label: 'Tiempo por área', type: 'text', unit: 'seg' },
      { key: 'passes', label: 'N° de pases', type: 'number' },
    ],
  },
  hifu: {
    label: 'HIFU / Ultrasonido focalizado',
    fields: [
      { key: 'transducer', label: 'Transductor / Profundidad', type: 'text', unit: 'mm' },
      { key: 'energy_per_line', label: 'Energía por línea', type: 'text', unit: 'J' },
      { key: 'lines', label: 'N° de líneas', type: 'number' },
      { key: 'shots', label: 'N° de disparos', type: 'number' },
    ],
  },
  peeling: {
    label: 'Peeling químico',
    fields: [
      { key: 'agent', label: 'Ácido / Agente', type: 'text' },
      { key: 'concentration', label: 'Concentración', type: 'text', unit: '%' },
      { key: 'layers', label: 'N° de capas', type: 'number' },
      { key: 'exposure_time', label: 'Tiempo de exposición', type: 'text', unit: 'min' },
      { key: 'neutralization', label: 'Neutralización', type: 'text' },
    ],
  },
  corporal: {
    label: 'Equipo corporal (criolipólisis, cavitación, etc.)',
    fields: [
      { key: 'applicator', label: 'Aplicador / Zona', type: 'text' },
      { key: 'temperature', label: 'Temperatura', type: 'text', unit: '°C' },
      { key: 'duration_cycle', label: 'Duración del ciclo', type: 'text', unit: 'min' },
      { key: 'cycles', label: 'N° de ciclos', type: 'number' },
      { key: 'intensity', label: 'Intensidad', type: 'text' },
    ],
  },
  manual: {
    label: 'Manual / sin aparatología',
    fields: [
      { key: 'product_used', label: 'Producto utilizado', type: 'text' },
      { key: 'technique', label: 'Técnica aplicada', type: 'text' },
      { key: 'exposure_time', label: 'Tiempo de aplicación', type: 'text', unit: 'min' },
      { key: 'intensity', label: 'Intensidad / Presión', type: 'text' },
    ],
  },
};

const KEYWORDS: Record<string, RegExp> = {
  laser: /l[aá]ser|ipl|nd:?yag|q-?switch|pico(sure|way)?|diodo|alejandrita|co2|erbium|thulium|ruby|revlite|spectravrm|vbeam|gentlelase|gentlemax|lightsheer|soprano|bbl|excel v|4d/i,
  radiofrecuencia: /radiofrecuencia|\brf\b|thermage|exilis|morpheus|venus (freeze|legacy)|accent|endymed|pollogen/i,
  hifu: /hifu|ultherapy|ultrasonido focalizado|doublo|ultraformer|utims|sygmalift|ultracel/i,
  peeling: /peeling|[aá]cido|tca\b|jessner|fenol/i,
  corporal: /criolip[oó]lisis|cavitaci[oó]n|carboxiterapia|presoterapia|drenaje|electroestimulaci[oó]n|coolsculpting|sculpsure|trusculpt|velashape|bodytite|facetite|cellfina|ondas de choque/i,
};

/** Detecta la categoría de parámetros a partir del equipo y/o procedimiento; si no hay aparatología reconocible, cae a 'manual' */
function detectCategory(equipmentUsed: string, procedureName: string): string {
  const haystack = `${equipmentUsed} ${procedureName}`.trim();
  if (!haystack) return 'manual';
  for (const [category, regex] of Object.entries(KEYWORDS)) {
    if (regex.test(haystack)) return category;
  }
  return 'manual';
}

type ParamValue = string | number;
export type TreatmentParameters = Record<string, ParamValue>;

// Etiquetas y unidades planas para formatear los parámetros como texto legible en "Notas"
const FIELD_LABELS: Record<string, string> = {};
const FIELD_UNITS: Record<string, string> = {};
for (const t of Object.values(TEMPLATES)) {
  for (const f of t.fields) {
    FIELD_LABELS[f.key] = f.label;
    if (f.unit) FIELD_UNITS[f.key] = f.unit;
  }
}

const NOTES_MARKER = '🔧';

/** Convierte los parámetros de un equipo en un bloque de texto legible para "Notas" */
export function formatParametersAsText(equipmentName: string, params: TreatmentParameters): string {
  const lines = Object.entries(params).map(([key, val]) => {
    const label = FIELD_LABELS[key] || key;
    const unit = FIELD_UNITS[key];
    return `  • ${label}: ${val}${unit ? ' ' + unit : ''}`;
  });
  return [`${NOTES_MARKER} ${equipmentName}`, ...lines].join('\n');
}

function splitNotesBlocks(notes: string): string[] {
  return notes.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
}

/** Inserta o reemplaza (por nombre de equipo) el bloque de parámetros dentro del texto de notas. Pasa block='' para eliminarlo. */
export function upsertNotesBlock(notes: string, equipmentName: string, block: string): string {
  const blocks = splitNotesBlocks(notes || '');
  const marker = `${NOTES_MARKER} ${equipmentName}`;
  const idx = blocks.findIndex(b => b.startsWith(marker));
  if (block) {
    if (idx >= 0) blocks[idx] = block; else blocks.push(block);
  } else if (idx >= 0) {
    blocks.splice(idx, 1);
  }
  return blocks.join('\n\n');
}

export function removeNotesBlock(notes: string, equipmentName: string): string {
  return upsertNotesBlock(notes, equipmentName, '');
}

interface TreatmentParametersModalProps {
  isOpen: boolean;
  onClose: () => void;
  equipmentName: string;
  procedureName: string;
  initialParams: TreatmentParameters | null | undefined;
  onSave: (params: TreatmentParameters) => void;
}

export default function TreatmentParametersModal({
  isOpen, onClose, equipmentName, procedureName, initialParams, onSave,
}: TreatmentParametersModalProps) {
  const [category, setCategory] = useState('manual');
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [customFields, setCustomFields] = useState<Array<{ key: string; value: string }>>([]);

  useEffect(() => {
    if (!isOpen) return;
    const detected = detectCategory(equipmentName, procedureName);
    setCategory(detected);
    const templateKeys = new Set(Object.values(TEMPLATES).flatMap(t => t.fields.map(f => f.key)));
    const initial = initialParams || {};
    const tv: Record<string, string> = {};
    const custom: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(initial)) {
      if (templateKeys.has(k)) tv[k] = String(v);
      else custom.push({ key: k, value: String(v) });
    }
    setTemplateValues(tv);
    setCustomFields(custom);
  }, [isOpen, equipmentName, procedureName, initialParams]);

  if (!isOpen) return null;

  const template = TEMPLATES[category];

  const handleSave = () => {
    const result: TreatmentParameters = {};
    for (const field of template.fields) {
      const raw = templateValues[field.key];
      if (raw === undefined || raw.trim() === '') continue;
      result[field.key] = field.type === 'number' ? (Number(raw) || 0) : raw;
    }
    for (const { key, value: v } of customFields) {
      if (key.trim() === '' || v.trim() === '') continue;
      result[key.trim()] = v;
    }
    onSave(result);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-100 shrink-0">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[#b8944d]" /> Parámetros — <span className="text-[#b8944d]">{equipmentName}</span>
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5 text-gray-500" /></button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Tipo de tratamiento</label>
            <select
              className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white"
              value={category}
              onChange={e => setCategory(e.target.value)}
            >
              {Object.entries(TEMPLATES).map(([key, t]) => (
                <option key={key} value={key}>{t.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400">
              Sugerido automáticamente desde el equipo/procedimiento. Si el tratamiento no usa aparatología, deja "Manual / sin aparatología".
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {template.fields.map(field => (
              <div key={field.key} className="space-y-1.5">
                <label className="block text-xs font-medium text-gray-600">
                  {field.label}{field.unit ? <span className="text-gray-400"> ({field.unit})</span> : null}
                </label>
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  className="w-full p-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white text-sm"
                  placeholder={field.placeholder}
                  value={templateValues[field.key] || ''}
                  onChange={e => setTemplateValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-gray-100">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">Campos adicionales</label>
              <button
                type="button"
                onClick={() => setCustomFields(prev => [...prev, { key: '', value: '' }])}
                className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 border border-gray-200"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {customFields.map((f, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="Nombre del campo"
                  className="flex-1 p-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#deb887]"
                  value={f.key}
                  onChange={e => setCustomFields(prev => prev.map((p, idx) => idx === i ? { ...p, key: e.target.value } : p))}
                />
                <input
                  type="text"
                  placeholder="Valor"
                  className="flex-1 p-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#deb887]"
                  value={f.value}
                  onChange={e => setCustomFields(prev => prev.map((p, idx) => idx === i ? { ...p, value: e.target.value } : p))}
                />
                <button
                  type="button"
                  onClick={() => setCustomFields(prev => prev.filter((_, idx) => idx !== i))}
                  className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            {customFields.length === 0 && (
              <p className="text-xs text-gray-400">Agrega cualquier dato que no esté en la plantilla (ej: número de lote, marca, dilución).</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-gray-100 shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 text-sm font-medium">
            Cancelar
          </button>
          <button onClick={handleSave} className="px-4 py-2 rounded-lg bg-[#deb887] text-white hover:bg-[#c5a075] text-sm font-medium shadow-lg shadow-[#deb887]/20">
            Guardar parámetros
          </button>
        </div>
      </div>
    </div>
  );
}
