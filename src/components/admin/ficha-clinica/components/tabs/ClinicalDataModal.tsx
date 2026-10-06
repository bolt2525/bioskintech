/**
 * Modal único de "Datos clínicos adicionales" por modo de Tratamientos, reutilizando el mismo
 * patrón visual de TreatmentParametersModal/TreatmentPackageModal. Todo se guarda dentro de
 * `treatment.parameters[RESERVED_PARAM_KEYS[mode]]` (JSONB) — no requiere cambios de esquema.
 */
import { Fragment, useEffect, useState } from 'react';
import { X, ClipboardList, Ruler, Scissors } from 'lucide-react';
import { Dialog } from '../../../../ui/Dialog';
import type {
  TreatmentMode, PostCareData, AnthropometricsData, ScalpAssessmentData, SeverityScale, HairLossScale,
} from '../../types/treatment';

const SEVERITY_LABELS: Record<SeverityScale, string> = { 0: 'Ninguno', 1: 'Leve', 2: 'Moderado', 3: 'Severo' };
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
export const NORWOOD_STAGES = ['I', 'II', 'III', 'III Vertex', 'IV', 'V', 'VI', 'VII'];
export const LUDWIG_STAGES = ['I', 'II', 'III'];

/** Ilustración esquemática (SVG generado, no una foto clínica) de la silueta craneal con el patrón
 *  de pérdida capilar aproximado para la escala/etapa seleccionada — solo referencial. */
function ScalpStageIllustration({ scale, stageIndex }: { scale: HairLossScale; stageIndex: number }) {
  const total = scale === 'norwood' ? NORWOOD_STAGES.length : LUDWIG_STAGES.length;
  const progress = stageIndex / Math.max(1, total - 1); // 0 (sin pérdida) .. 1 (máxima pérdida)
  // Norwood: la línea de implantación retrocede desde la frente; Ludwig: la corona se aclara de forma difusa
  const hairlineY = scale === 'norwood' ? 14 + progress * 16 : 14;
  const crownOpacity = scale === 'ludwig' ? Math.max(0.08, 0.6 - progress * 0.55) : 0.6;
  return (
    <svg viewBox="0 0 60 60" className="w-10 h-10 shrink-0">
      <circle cx="30" cy="34" r="22" fill="#fde9d7" stroke="#b8944d" strokeWidth="1.5" />
      {scale === 'norwood' ? (
        <path d={`M8,${hairlineY} Q30,${hairlineY - 10 + progress * 6} 52,${hairlineY}`} fill="none" stroke="#5b3a1e" strokeWidth="5" strokeLinecap="round" />
      ) : (
        <ellipse cx="30" cy="20" rx="16" ry="9" fill="#5b3a1e" opacity={crownOpacity} />
      )}
      {scale === 'norwood' && progress > 0.3 && (
        <ellipse cx="30" cy="18" rx={6 + progress * 10} ry={4 + progress * 6} fill="#fde9d7" />
      )}
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
            {mode === 'corporal' ? <Ruler className="w-5 h-5 text-[#b8944d]" /> : mode === 'capilar' ? <Scissors className="w-5 h-5 text-[#b8944d]" /> : <ClipboardList className="w-5 h-5 text-[#b8944d]" />}
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
                  <div className="flex gap-2 flex-wrap">
                    {([0, 1, 2, 3] as SeverityScale[]).map(level => (
                      <button key={level} type="button" onClick={() => setPostCare(prev => ({ ...prev, [field]: level }))}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${postCare[field] === level ? 'bg-[#deb887] text-white border-[#deb887]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                        {SEVERITY_LABELS[level]}
                      </button>
                    ))}
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
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${active ? 'bg-[#deb887]/20 border-[#deb887] text-[#b8944d]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                        {ind}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {mode === 'corporal' && (
            <>
              <div className="grid grid-cols-3 gap-x-3 gap-y-2 items-center text-xs font-medium text-gray-500">
                <span />
                <span className="text-center">Antes</span>
                <span className="text-center">Después</span>
                {ANTHRO_FIELDS.map(f => (
                  <Fragment key={f.key}>
                    <label className="text-gray-700 font-medium">{f.label} <span className="text-gray-400">({f.unit})</span></label>
                    <input type="text" inputMode="decimal" className="w-full p-2 border border-gray-200 rounded-lg text-sm text-center outline-none focus:ring-2 focus:ring-[#deb887]"
                      value={anthro.before[f.key] || ''} onChange={e => setAnthro(prev => ({ ...prev, before: { ...prev.before, [f.key]: e.target.value } }))} />
                    <input type="text" inputMode="decimal" className="w-full p-2 border border-gray-200 rounded-lg text-sm text-center outline-none focus:ring-2 focus:ring-[#deb887]"
                      value={anthro.after[f.key] || ''} onChange={e => setAnthro(prev => ({ ...prev, after: { ...prev.after, [f.key]: e.target.value } }))} />
                  </Fragment>
                ))}
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
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${scalp.scale === s ? 'bg-[#deb887] text-white border-[#deb887]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      {s === 'norwood' ? 'Norwood (masculino)' : 'Ludwig (femenino)'}
                    </button>
                  ))}
                </div>
              </div>

              {scalp.scale && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Etapa (tarjetas ilustrativas, haz clic para seleccionar)</label>
                  <div className="grid grid-cols-4 gap-2">
                    {stages.map((label, idx) => (
                      <button key={label} type="button" onClick={() => setScalp(prev => ({ ...prev, stage: label }))}
                        className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${scalp.stage === label ? 'bg-[#deb887]/20 border-[#deb887]' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <ScalpStageIllustration scale={scalp.scale as HairLossScale} stageIndex={idx} />
                        <span className="text-[10px] font-medium text-gray-600">Etapa {label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Densidad percibida</label>
                <div className="flex gap-2">
                  {(['Alta', 'Media', 'Baja'] as const).map(d => (
                    <button key={d} type="button" onClick={() => setScalp(prev => ({ ...prev, density: d }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${scalp.density === d ? 'bg-[#deb887] text-white border-[#deb887]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Tipo de alopecia</label>
                <div className="flex gap-2 flex-wrap">
                  {ALOPECIA_TYPES.map(t => (
                    <button key={t} type="button" onClick={() => setScalp(prev => ({ ...prev, alopecia_type: t }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${scalp.alopecia_type === t ? 'bg-[#deb887]/20 border-[#deb887] text-[#b8944d]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                      {t}
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
