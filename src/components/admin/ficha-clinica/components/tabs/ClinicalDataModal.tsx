/**
 * Modal único de "Datos clínicos adicionales" por modo de Tratamientos, reutilizando el mismo
 * patrón visual de TreatmentParametersModal/TreatmentPackageModal. Todo se guarda dentro de
 * `treatment.parameters[RESERVED_PARAM_KEYS[mode]]` (JSONB) — no requiere cambios de esquema.
 */
import { useEffect, useState } from 'react';
import { X, ClipboardList, Ruler, ScanSearch, CheckCircle2 } from 'lucide-react';
import { Dialog } from '../../../../ui/Dialog';
import { Tooltip } from '../../../../ui/Tooltip';
import type {
  TreatmentMode, PostCareData, AnthropometricsData, ScalpAssessmentData, SeverityScale, HairLossScale,
} from '../../types/treatment';
import { NORWOOD_STAGES, LUDWIG_STAGES, NORWOOD_DESCRIPTIONS, LUDWIG_DESCRIPTIONS, getScalpCoverage } from '../../../../../data/scalpPatterns';
export { NORWOOD_STAGES, LUDWIG_STAGES } from '../../../../../data/scalpPatterns';

const SEVERITY_META: Record<SeverityScale, { label: string; description: string; detail: string }> = {
  0: { label: 'Sin reacción', description: 'Piel sin cambios visibles', detail: 'No se aprecia respuesta inmediata relevante. Registra igualmente las indicaciones entregadas y cualquier sensación referida.' },
  1: { label: 'Leve', description: 'Respuesta localizada discreta', detail: 'Cambio tenue y localizado. Documenta la zona y controla su evolución según el procedimiento realizado.' },
  2: { label: 'Moderado', description: 'Respuesta visible y delimitada', detail: 'Cambio claramente visible y delimitado. Conviene describir extensión, síntomas asociados y cuidados indicados.' },
  3: { label: 'Intenso', description: 'Respuesta marcada; vigilar evolución', detail: 'Respuesta marcada que requiere documentación detallada, seguimiento y criterio clínico antes de dar por finalizado el control.' },
};
const POST_CARE_INDICATIONS = [
  'Protección solar FPS50+',
  'Evitar maquillaje 24h',
  'No exponer a calor/sauna',
  'Hidratación reforzada',
  'Evitar ejercicio intenso 48h',
  'No manipular/exfoliar la zona',
];
const ANTHRO_FIELDS: Array<{ key: keyof AnthropometricsData['before']; label: string; unit: string }> = [
  { key: 'waist', label: 'Cintura', unit: 'cm' },
  { key: 'hip', label: 'Cadera', unit: 'cm' },
  { key: 'thigh', label: 'Muslo', unit: 'cm' },
  { key: 'arm', label: 'Brazo', unit: 'cm' },
  { key: 'abdomen', label: 'Abdomen', unit: 'cm' },
  { key: 'weight', label: 'Peso', unit: 'kg' },
];
const ALOPECIA_TYPES = ['Androgenética', 'Areata', 'Telógena', 'Cicatricial', 'Otra'];

function SeverityIllustration({ level, kind }: { level: SeverityScale; kind: 'erythema' | 'edema' }) {
  const color = level === 0 ? '#d1fae5' : level === 1 ? '#fde68a' : level === 2 ? '#fdba74' : '#fda4af';
  return (
    <svg viewBox="0 0 64 48" className="h-11 w-full" aria-hidden="true">
      <path d="M18 34c-3-5-4-12-1-18 3-7 9-10 15-10s12 3 15 10c3 6 2 13-1 18-3 5-8 8-14 8s-11-3-14-8Z" fill="#fff7ed" stroke="#c4a275" strokeWidth="1.5" />
      {kind === 'erythema' ? (
        <>
          <ellipse cx="24" cy="25" rx={4 + level * 1.5} ry={2 + level} fill={color} opacity={level === 0 ? 0.35 : 0.75} />
          <ellipse cx="40" cy="25" rx={4 + level * 1.5} ry={2 + level} fill={color} opacity={level === 0 ? 0.35 : 0.75} />
        </>
      ) : (
        <path d={`M22 29 Q32 ${29 + level * 2} 42 29`} fill="none" stroke={color} strokeWidth={2 + level} strokeLinecap="round" opacity={level === 0 ? 0.35 : 0.85} />
      )}
      <circle cx="25" cy="19" r="1.5" fill="#6b7280" />
      <circle cx="39" cy="19" r="1.5" fill="#6b7280" />
    </svg>
  );
}

function BodyMeasureIllustration({ measure }: { measure: keyof AnthropometricsData['before'] }) {
  const zoneY = { arm: 25, waist: 34, abdomen: 39, hip: 45, thigh: 55, weight: 35 }[measure] ?? 35;
  return (
    <svg viewBox="0 0 48 72" className="h-14 w-10 shrink-0" aria-hidden="true">
      <circle cx="24" cy="8" r="5" fill="#f6e2d2" stroke="#9ca3af" />
      <path d="M18 15 Q24 12 30 15 L34 42 29 65H24L22 44 20 65H15L14 42Z" fill="#f8fafc" stroke="#9ca3af" strokeWidth="1.2" />
      <path d="M18 18 10 38M30 18l8 20" stroke="#9ca3af" strokeWidth="4" strokeLinecap="round" />
      <ellipse cx="24" cy={zoneY} rx={measure === 'arm' ? 15 : 10} ry="4" fill="#deb887" opacity="0.75" />
    </svg>
  );
}

/** Ilustración esquemática (SVG generado, no una foto clínica) de la silueta craneal con el patrón
 *  de pérdida capilar aproximado para la escala/etapa seleccionada — solo referencial. */
function ScalpStageIllustration({ scale, stageIndex }: { scale: HairLossScale; stageIndex: number }) {
  const stage = (scale === 'norwood' ? NORWOOD_STAGES : LUDWIG_STAGES)[stageIndex];
  const samples = [];
  for (let row = 0; row < 28; row += 1) {
    for (let column = 0; column < 24; column += 1) {
      const x = (column / 23 - 0.5) * 2.3;
      const z = 1.5 - row / 27 * 2.9;
      const radius = (x / 1.15) ** 2 + ((z - 0.05) / 1.5) ** 2;
      if (radius > 1) continue;
      const y = Math.min(2.5, 0.8 + 1.7 * Math.sqrt(1 - radius) + 0.7 * Math.max(0, (z - 0.2) / 1.3));
      const opacity = getScalpCoverage({ x, y, z }, { scale, stage });
      samples.push(<rect key={`${row}-${column}`} x={12 + column * 2} y={9 + row * 2} width="2.1" height="2.1" fill="#3b271c" opacity={opacity} />);
    }
  }
  return (
    <svg viewBox="0 0 72 72" className="h-16 w-16 shrink-0" aria-hidden="true">
      <ellipse cx="36" cy="36" rx="25" ry="29" fill="#fde9d7" stroke="#b8944d" strokeWidth="1.5" />
      {samples}
      <path d="M32 5h8l-4-3Z" fill="#b8944d" />
    </svg>
  );
}

interface ClinicalDataModalProps {
  isOpen: boolean;
  mode: TreatmentMode;
  initialData: PostCareData | AnthropometricsData | ScalpAssessmentData | null | undefined;
  onClose: () => void;
  onSave: (data: PostCareData | AnthropometricsData | ScalpAssessmentData) => void;
}

const emptyPostCare = (): PostCareData => ({ erythema: null, edema: null, indications: [], notes: '' });
const emptyAnthro = (): AnthropometricsData => ({ before: {}, after: {}, custom: [] });
const emptyScalp = (): ScalpAssessmentData => ({ scale: null, stage: null, density: null, alopecia_type: null, itching_flaking: false, notes: '' });

export default function ClinicalDataModal({ isOpen, mode, initialData, onClose, onSave }: ClinicalDataModalProps) {
  const [postCare, setPostCare] = useState<PostCareData>(emptyPostCare());
  const [anthro, setAnthro] = useState<AnthropometricsData>(emptyAnthro());
  const [scalp, setScalp] = useState<ScalpAssessmentData>(emptyScalp());

  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'facial') setPostCare({ ...emptyPostCare(), ...(initialData as PostCareData) });
    else if (mode === 'corporal') setAnthro({ ...emptyAnthro(), ...(initialData as AnthropometricsData) });
    else setScalp({ ...emptyScalp(), ...(initialData as ScalpAssessmentData) });
  }, [isOpen, mode, initialData]);

  if (!isOpen) return null;

  const handleSave = () => {
    if (mode === 'facial') onSave(postCare);
    else if (mode === 'corporal') onSave(anthro);
    else onSave(scalp);
    onClose();
  };

  const stages = scalp.scale === 'ludwig' ? LUDWIG_STAGES : NORWOOD_STAGES;

  return (
    <Dialog open={isOpen} onClose={onClose} labelledBy="clinical-data-title">
      <div className="flex max-h-[85dvh] w-[min(42rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-gray-100 shrink-0">
          <h3 id="clinical-data-title" className="font-semibold text-gray-800 flex items-center gap-2">
            {mode === 'corporal' ? <Ruler className="w-5 h-5 text-[#b8944d]" /> : mode === 'capilar' ? <ScanSearch className="w-5 h-5 text-[#b8944d]" /> : <ClipboardList className="w-5 h-5 text-[#b8944d]" />}
            Datos clínicos{mode === 'facial' ? ' — Cuidados post-tratamiento' : mode === 'corporal' ? ' — Antropometría' : ' — Evaluación tricológica'}
          </h3>
          <button onClick={onClose} className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-gray-100" aria-label="Cerrar">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          {mode === 'facial' && (
            <>
              {(['erythema', 'edema'] as const).map(field => (
                <div key={field} className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">{field === 'erythema' ? 'Eritema' : 'Edema'}</label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {([0, 1, 2, 3] as SeverityScale[]).map(level => {
                      const selected = postCare[field] === level;
                      return (
                        <Tooltip key={level} content={SEVERITY_META[level].detail} position="top" className="w-full">
                          <button type="button" onClick={() => setPostCare(prev => ({ ...prev, [field]: level }))}
                            aria-pressed={selected}
                            className={`admin-focus-ring relative w-full rounded-xl p-2 text-left transition-[border-color,background-color,box-shadow,transform] ${selected ? 'border-2 border-gold-dark bg-gold/10 shadow-md ring-2 ring-gold/30' : 'border border-gray-200 hover:-translate-y-0.5 hover:border-gold hover:bg-gold/10 hover:shadow-sm'}`}>
                            {selected ? <CheckCircle2 className="absolute right-2 top-2 h-4 w-4 text-gold-ink" aria-hidden="true" /> : null}
                            <SeverityIllustration level={level} kind={field} />
                            <span className="block text-xs font-semibold text-gray-800">{SEVERITY_META[level].label}</span>
                            <span className="mt-0.5 block text-[9px] leading-3 text-gray-500">{SEVERITY_META[level].description}</span>
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Indicaciones entregadas</label>
                <div className="flex gap-2 flex-wrap">
                  {POST_CARE_INDICATIONS.map(ind => {
                    const active = postCare.indications.includes(ind);
                    return (
                      <button key={ind} type="button"
                        onClick={() => setPostCare(prev => ({ ...prev, indications: active ? prev.indications.filter(i => i !== ind) : [...prev.indications, ind] }))}
                        aria-pressed={active}
                        className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${active ? 'border-2 border-gray-900 bg-gray-900 text-white shadow-sm ring-2 ring-gray-300' : 'border border-gray-200 text-gray-600 hover:border-gold hover:bg-gold/10'}`}>
                        {active ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}{ind}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {mode === 'corporal' && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ANTHRO_FIELDS.map(f => {
                  const before = Number.parseFloat(anthro.before[f.key] || '');
                  const after = Number.parseFloat(anthro.after[f.key] || '');
                  const hasDelta = Number.isFinite(before) && Number.isFinite(after);
                  const delta = hasDelta ? after - before : 0;
                  return (
                    <div key={f.key} className="flex gap-3 rounded-xl border border-gray-200 bg-gray-50/60 p-3">
                      <BodyMeasureIllustration measure={f.key} />
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <label className="text-xs font-semibold text-gray-700">{f.label} <span className="font-normal text-gray-400">({f.unit})</span></label>
                          {hasDelta ? <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${delta <= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{delta > 0 ? '+' : ''}{delta.toFixed(1)} {f.unit}</span> : null}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input aria-label={`${f.label} antes`} placeholder="Antes" type="text" inputMode="decimal" className="w-full rounded-lg border border-gray-200 bg-white p-2 text-center text-sm outline-none focus:ring-2 focus:ring-gold"
                            value={anthro.before[f.key] || ''} onChange={e => setAnthro(prev => ({ ...prev, before: { ...prev.before, [f.key]: e.target.value } }))} />
                          <input aria-label={`${f.label} después`} placeholder="Después" type="text" inputMode="decimal" className="w-full rounded-lg border border-gray-200 bg-white p-2 text-center text-sm outline-none focus:ring-2 focus:ring-gold"
                            value={anthro.after[f.key] || ''} onChange={e => setAnthro(prev => ({ ...prev, after: { ...prev.after, [f.key]: e.target.value } }))} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-2 pt-2 border-t border-gray-100">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">Medidas personalizadas</label>
                  <button type="button" onClick={() => setAnthro(prev => ({ ...prev, custom: [...prev.custom, { label: '', before: '', after: '' }] }))}
                    className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">+ Agregar</button>
                </div>
                {anthro.custom.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_5rem_auto] gap-2">
                    <input type="text" placeholder="Nombre de la medida" className="p-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#deb887]"
                      value={row.label} onChange={e => setAnthro(prev => ({ ...prev, custom: prev.custom.map((r, idx) => idx === i ? { ...r, label: e.target.value } : r) }))} />
                    <input type="text" placeholder="Antes" className="p-2 border border-gray-200 rounded-lg text-sm text-center outline-none focus:ring-2 focus:ring-[#deb887]"
                      value={row.before} onChange={e => setAnthro(prev => ({ ...prev, custom: prev.custom.map((r, idx) => idx === i ? { ...r, before: e.target.value } : r) }))} />
                    <input type="text" placeholder="Después" className="p-2 border border-gray-200 rounded-lg text-sm text-center outline-none focus:ring-2 focus:ring-[#deb887]"
                      value={row.after} onChange={e => setAnthro(prev => ({ ...prev, custom: prev.custom.map((r, idx) => idx === i ? { ...r, after: e.target.value } : r) }))} />
                    <button type="button" onClick={() => setAnthro(prev => ({ ...prev, custom: prev.custom.filter((_, idx) => idx !== i) }))} className="text-red-500 text-xs px-2">✕</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {mode === 'capilar' && (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Escala de evaluación</label>
                <div className="flex gap-2">
                  {(['norwood', 'ludwig'] as HairLossScale[]).map(s => (
                    <button key={s} type="button" onClick={() => setScalp(prev => ({ ...prev, scale: s, stage: null }))}
                      aria-pressed={scalp.scale === s}
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-[color,background-color,border-color,box-shadow] ${scalp.scale === s ? 'border-2 border-gray-900 bg-gray-900 text-white shadow-sm ring-2 ring-gray-300' : 'border border-gray-200 text-gray-600 hover:border-gold hover:bg-gold/10'}`}>
                      {scalp.scale === s ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}{s === 'norwood' ? 'Norwood (masculino)' : 'Ludwig (femenino)'}
                    </button>
                  ))}
                </div>
              </div>

              {scalp.scale && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Etapa (tarjetas ilustrativas, haz clic para seleccionar)</label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {stages.map((label, idx) => {
                      const description = (scalp.scale === 'norwood' ? NORWOOD_DESCRIPTIONS : LUDWIG_DESCRIPTIONS)[idx];
                      const selected = scalp.stage === label;
                      return (
                        <Tooltip key={label} content={`Etapa ${label}: ${description}. Ilustración orientativa; complementa la selección con densidad, tipo de alopecia, síntomas y notas clínicas.`} position="top" className="w-full">
                          <button type="button" onClick={() => setScalp(prev => ({ ...prev, stage: label }))}
                            aria-pressed={selected}
                            className={`admin-focus-ring relative flex min-h-36 w-full flex-col items-center gap-1 rounded-xl p-2 text-center transition-[border-color,background-color,box-shadow,transform] ${selected ? 'border-2 border-gold-dark bg-gold/10 shadow-md ring-2 ring-gold/30' : 'border border-gray-200 hover:-translate-y-0.5 hover:border-gold hover:bg-gold/10 hover:shadow-sm'}`}>
                            {selected ? <CheckCircle2 className="absolute right-2 top-2 h-4 w-4 text-gold-ink" aria-hidden="true" /> : null}
                            <ScalpStageIllustration scale={scalp.scale as HairLossScale} stageIndex={idx} />
                            <span className="text-xs font-semibold text-gray-700">Etapa {label}</span>
                            <span className="text-[9px] leading-3 text-gray-500">{description}</span>
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Densidad percibida</label>
                <div className="flex gap-2">
                  {(['Alta', 'Media', 'Baja'] as const).map(d => (
                    <button key={d} type="button" onClick={() => setScalp(prev => ({ ...prev, density: d }))}
                      aria-pressed={scalp.density === d}
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${scalp.density === d ? 'border-2 border-gray-900 bg-gray-900 text-white shadow-sm ring-2 ring-gray-300' : 'border border-gray-200 text-gray-600 hover:border-gold hover:bg-gold/10'}`}>
                      {scalp.density === d ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}{d}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Tipo de alopecia</label>
                <div className="flex gap-2 flex-wrap">
                  {ALOPECIA_TYPES.map(t => (
                    <button key={t} type="button" onClick={() => setScalp(prev => ({ ...prev, alopecia_type: t }))}
                      aria-pressed={scalp.alopecia_type === t}
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${scalp.alopecia_type === t ? 'border-2 border-gray-900 bg-gray-900 text-white shadow-sm ring-2 ring-gray-300' : 'border border-gray-200 text-gray-600 hover:border-gold hover:bg-gold/10'}`}>
                      {scalp.alopecia_type === t ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}{t}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={scalp.itching_flaking} onChange={e => setScalp(prev => ({ ...prev, itching_flaking: e.target.checked }))} className="rounded border-gray-300 text-[#deb887] focus:ring-[#deb887]" />
                Presenta prurito / descamación
              </label>
            </>
          )}

          <div className="space-y-1.5 pt-2 border-t border-gray-100">
            <label className="block text-sm font-medium text-gray-700">Notas adicionales</label>
            <textarea rows={2} className="w-full p-2.5 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#deb887]"
              value={mode === 'facial' ? postCare.notes : mode === 'capilar' ? scalp.notes : ''}
              onChange={e => mode === 'facial' ? setPostCare(prev => ({ ...prev, notes: e.target.value })) : mode === 'capilar' ? setScalp(prev => ({ ...prev, notes: e.target.value })) : undefined}
              disabled={mode === 'corporal'}
            />
          </div>
        </div>

        <div className="flex gap-3 p-4 border-t border-gray-100 shrink-0">
          <button type="button" onClick={onClose} className="flex-1 p-2.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">Cancelar</button>
          <button type="button" onClick={handleSave} className="flex-1 p-2.5 rounded-lg bg-[#deb887] text-white hover:bg-[#c5a075] font-medium">Guardar datos clínicos</button>
        </div>
      </div>
    </Dialog>
  );
}
