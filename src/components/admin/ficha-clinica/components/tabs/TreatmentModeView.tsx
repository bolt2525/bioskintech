import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Calendar, DollarSign, Clock, Save, Trash2, Copy, Check, AlertCircle, FileText, Pencil, Layers, History, Eye, X, ChevronDown, ChevronLeft, ChevronRight, Sparkles, Wrench, Package, Wallet, ClipboardList, MapPin, CircleDashed, Undo2, CheckCircle2, ScanSearch } from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import TreatmentParametersModal, { type TreatmentParameters, formatParametersAsText, upsertNotesBlock, removeNotesBlock } from './TreatmentParametersModal';
import TreatmentPackageModal from './TreatmentPackageModal';
import TreatmentFinanceOptions from './TreatmentFinanceOptions';
import ClinicalDataModal from './ClinicalDataModal';
import TreatmentFollowUpPanel from './TreatmentFollowUpPanel';
import Clinical3DViewer from '../Clinical3DViewer';
import type { Marker3D, MarkerType, ScalpHairVisualization } from '../Clinical3DViewer';
import { useAuth } from '../../../../../context/AuthContext';
import treatmentOptions from '../../data/treatment_options.json';
import { SCALP_SCALE_LABELS, getScalpDescriptions, getScalpStageLabel, getScalpStages } from '../../../../../data/scalpPatterns';
import {
  FOLLOW_UP_KEY, getFollowUpLabel, getScalpVisualization, getTreatmentFollowUp, prepareNextTreatment, describeTreatmentAssessment,
} from '../../types/treatmentFollowUp';
import { Tooltip } from '../../../../ui/Tooltip';
import { ConfirmationDialog } from '../../../../ui/ConfirmationDialog';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';
import { Dialog } from '../../../../ui/Dialog';
import { useTreatmentGrouping } from '../../hooks/useTreatmentGrouping';
import {
  type Treatment, type TreatmentMode, type TreatmentPackage,
  createFinancePostingOptions, type FinancePostingOptions,
  type PostCareData, type AnthropometricsData, type ScalpAssessmentData,
  getPackageDebt, getPackagePaidTotal, getAreaMarkers, RESERVED_PARAM_KEYS, TREATMENT_MODE_LABELS,
} from '../../types/treatment';

/** Zonas sugeridas por modo (chips clickeables para etiquetar cada marcación anatómica) */
const ZONE_CHIPS_BY_MODE: Record<TreatmentMode, string[]> = {
  facial: treatmentOptions.procedures.facial,
  corporal: treatmentOptions.procedures.corporal,
  capilar: (treatmentOptions.procedures as Record<string, string[]>).capilar || [],
};
const ZONE_GROUPS_BY_MODE: Record<TreatmentMode, { label: string; zones: string[] }[]> = {
  facial: [
    { label: 'Tercio superior', zones: ['Frente', 'Entrecejo', 'Párpados superiores', 'Párpados inferiores'] },
    { label: 'Tercio medio', zones: ['Mejillas', 'Pómulos', 'Nariz', 'Surco nasogeniano'] },
    { label: 'Tercio inferior', zones: ['Labio superior', 'Labio inferior', 'Comisuras', 'Mentón', 'Mandíbula'] },
    { label: 'Zonas adyacentes', zones: ['Cuello', 'Escote'] },
  ],
  corporal: [
    { label: 'Tronco', zones: ['Tórax', 'Abdomen', 'Espalda', 'Cintura', 'Caderas'] },
    { label: 'Extremidades superiores', zones: ['Brazos', 'Antebrazos', 'Axilas'] },
    { label: 'Extremidades inferiores', zones: ['Glúteos', 'Muslos', 'Rodillas', 'Piernas', 'Pantorrillas', 'Tobillos'] },
  ],
  capilar: [
    { label: 'Frontal y temporal', zones: ['Entradas', 'Línea de implantación frontal', 'Temporal derecho', 'Temporal izquierdo'] },
    { label: 'Superior', zones: ['Coronilla', 'Vértex', 'Difuso (toda la cabeza)'] },
    { label: 'Posterior', zones: ['Occipital'] },
  ],
};

const PROCEDURES = treatmentOptions.procedures as Record<string, string[]>;
const PROCEDURE_SUGGESTIONS_BY_MODE: Record<TreatmentMode, string[]> = {
  facial: PROCEDURES['Medicina Estética'] || [],
  corporal: PROCEDURES.tratamientos_corporales || [],
  capilar: PROCEDURES.tratamientos_capilares || [],
};
const EQUIPMENT_SUGGESTIONS_BY_MODE: Record<TreatmentMode, string[]> = {
  facial: [
    ...(PROCEDURES.equipos_laser || []),
    ...(PROCEDURES.equipos_radiofrecuencia || []),
    ...(PROCEDURES.equipos_ultrasonido || []),
    ...(PROCEDURES.equipos_inyeccion || []),
  ],
  corporal: [
    ...(PROCEDURES.equipos_corporales || []),
    ...(PROCEDURES.aplicadores_rf || []),
    ...(PROCEDURES.transductores_hifu || []),
  ],
  capilar: PROCEDURES.equipos_capilares || [],
};
const FORM_COPY: Record<TreatmentMode, { procedure: string; equipment: string; area: string }> = {
  facial: { procedure: 'Ej: Láser fraccionado facial', equipment: 'Ej: Fotona 4D, Morpheus8...', area: 'Ej: Tercio medio facial' },
  corporal: { procedure: 'Ej: Criolipólisis', equipment: 'Ej: CoolSculpting, VelaShape...', area: 'Ej: Abdomen inferior y flancos' },
  capilar: { procedure: 'Ej: PRP capilar', equipment: 'Ej: Kit PRP, Dermapen capilar...', area: 'Ej: Coronilla y línea frontal' },
};

/** Resumen corto (badge) de los datos clínicos del modo, para mostrar en las tarjetas del historial */
function getClinicalDataBadge(t: Treatment, mode: TreatmentMode): string | null {
  const data = t.parameters?.[RESERVED_PARAM_KEYS[mode]] as PostCareData | AnthropometricsData | ScalpAssessmentData | undefined;
  if (!data) return null;
  if (mode === 'facial') {
    const d = data as PostCareData;
    if (d.erythema == null && d.edema == null) return null;
    return `Eritema ${d.erythema ?? '-'} · Edema ${d.edema ?? '-'}`;
  }
  if (mode === 'corporal') {
    const d = data as AnthropometricsData;
    const waistBefore = parseFloat(d.before?.waist || '');
    const waistAfter = parseFloat(d.after?.waist || '');
    if (!isNaN(waistBefore) && !isNaN(waistAfter)) {
      const delta = waistAfter - waistBefore;
      return `Cintura: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}cm`;
    }
    return Object.values(d.before || {}).some(Boolean) ? 'Antropometría registrada' : null;
  }
  const d = data as ScalpAssessmentData;
  if (!d.scale) return null;
  return describeTreatmentAssessment(t, mode);
}

function ClinicalSummaryPanel({
  mode,
  data,
  onEdit,
}: {
  mode: TreatmentMode;
  data: PostCareData | AnthropometricsData | ScalpAssessmentData | undefined;
  onEdit: () => void;
}) {
  const titles = {
    facial: ['Post-tratamiento', 'Evolución inmediata y cuidados'],
    corporal: ['Antropometría', 'Medidas antes y después'],
    capilar: ['Evaluación tricológica', 'Escala, densidad y hallazgos'],
  } as const;

  const renderContent = () => {
    if (!data) {
      return (
        <div className="rounded-xl border border-dashed border-gold/40 bg-gold/10 p-4 text-center">
          <ClipboardList className="mx-auto mb-2 h-6 w-6 text-gold-ink/60" aria-hidden="true" />
          <p className="text-xs leading-5 text-gray-500">Aún no hay datos clínicos registrados para esta sesión.</p>
        </div>
      );
    }
    if (mode === 'facial') {
      const postCare = data as PostCareData;
      return (
        <div className="grid grid-cols-2 gap-2">
          {[
            ['Eritema', postCare.erythema == null ? '—' : `${postCare.erythema}/3`],
            ['Edema', postCare.edema == null ? '—' : `${postCare.edema}/3`],
            ['Indicaciones', String(postCare.indications?.length || 0)],
            ['Notas', postCare.notes?.trim() ? 'Sí' : 'No'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-gray-100 bg-gray-50/80 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
              <p className="mt-1 text-sm font-semibold text-gray-800">{value}</p>
            </div>
          ))}
        </div>
      );
    }
    if (mode === 'corporal') {
      const anthropometrics = data as AnthropometricsData;
      const beforeCount = Object.values(anthropometrics.before || {}).filter(Boolean).length;
      const afterCount = Object.values(anthropometrics.after || {}).filter(Boolean).length;
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Medidas antes</p>
              <p className="mt-1 text-lg font-semibold text-gray-800">{beforeCount}</p>
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">Medidas después</p>
              <p className="mt-1 text-lg font-semibold text-emerald-800">{afterCount}</p>
            </div>
          </div>
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            {anthropometrics.custom?.length || 0} medida(s) personalizada(s)
          </p>
        </div>
      );
    }
    const scalp = data as ScalpAssessmentData;
    return (
      <div className="space-y-2">
        <div className="rounded-xl border border-violet-100 bg-violet-50/70 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-500">Clasificación</p>
          <p className="mt-1 font-semibold text-gray-800">
            {scalp.scale ? `${SCALP_SCALE_LABELS[scalp.scale] ?? 'Escala no reconocida'} ${getScalpStageLabel(scalp.stage || '')}` : 'Sin clasificar'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-3">
            <p className="text-gray-400">Densidad</p>
            <p className="mt-1 font-semibold text-gray-800">{scalp.density || '—'}</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-3">
            <p className="text-gray-400">Alopecia</p>
            <p className="mt-1 truncate font-semibold text-gray-800">{scalp.alopecia_type || '—'}</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <aside className="admin-surface order-3 h-fit p-4 xl:col-span-2 xl:sticky xl:top-4 2xl:order-3 2xl:col-span-1">
      <div className="mb-4">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold-ink">
          <ClipboardList className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="font-semibold text-gray-900">{titles[mode][0]}</h2>
        <p className="mt-1 text-xs text-gray-500">{titles[mode][1]}</p>
      </div>
      {renderContent()}
      <button
        type="button"
        onClick={onEdit}
        className="admin-focus-ring mt-4 w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-ink"
      >
        {data ? 'Editar datos clínicos' : 'Completar evaluación'}
      </button>
      <p className="mt-3 text-center text-[10px] leading-4 text-gray-400">Se guarda dentro de esta sesión y permanece vinculado al historial.</p>
    </aside>
  );
}

const ANTHROPOMETRIC_SUMMARY_FIELDS = [
  ['waist', 'Cintura', 'cm'],
  ['hip', 'Cadera', 'cm'],
  ['thigh', 'Muslo', 'cm'],
  ['arm', 'Brazo', 'cm'],
  ['abdomen', 'Abdomen', 'cm'],
  ['weight', 'Peso', 'kg'],
] as const;
const REACTION_LABELS = ['Sin reacción', 'Leve', 'Moderado', 'Intenso'] as const;

function SavedClinicalDataSummary({ treatment, mode }: { treatment: Treatment; mode: TreatmentMode }) {
  const data = treatment.parameters?.[RESERVED_PARAM_KEYS[mode]] as PostCareData | AnthropometricsData | ScalpAssessmentData | undefined;
  if (!data) return <p className="mt-2 text-sm text-gray-500">Sin datos clínicos adicionales.</p>;

  if (mode === 'facial') {
    const postCare = data as PostCareData;
    return (
      <div className="mt-3 space-y-3">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          {[
            ['Eritema', postCare.erythema == null ? 'Sin registrar' : `${REACTION_LABELS[postCare.erythema]} (${postCare.erythema}/3)`],
            ['Edema', postCare.edema == null ? 'Sin registrar' : `${REACTION_LABELS[postCare.edema]} (${postCare.edema}/3)`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-white p-3 ring-1 ring-gold/20">
              <dt className="text-gray-500">{label}</dt>
              <dd className="mt-1 font-semibold text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-xs font-semibold text-gray-700">Indicaciones entregadas</p>
          {postCare.indications?.length ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {postCare.indications.map(indication => <li key={indication} className="rounded-full bg-white px-2.5 py-1 text-xs text-gray-700 ring-1 ring-gold/20">{indication}</li>)}
            </ul>
          ) : <p className="mt-1 text-xs text-gray-500">Sin indicaciones registradas.</p>}
        </div>
        {postCare.notes?.trim() ? <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700">{postCare.notes}</p> : null}
      </div>
    );
  }

  if (mode === 'corporal') {
    const anthropometrics = data as AnthropometricsData;
    const rows = ANTHROPOMETRIC_SUMMARY_FIELDS.flatMap(([key, label, unit]) => {
      const before = anthropometrics.before?.[key];
      const after = anthropometrics.after?.[key];
      if (!before && !after) return [];
      const beforeNumber = Number.parseFloat(before || '');
      const afterNumber = Number.parseFloat(after || '');
      const delta = Number.isFinite(beforeNumber) && Number.isFinite(afterNumber) ? afterNumber - beforeNumber : null;
      return [{ label, unit, before, after, delta }];
    });
    const customRows = (anthropometrics.custom || [])
      .filter(row => row.label || row.before || row.after)
      .map(row => ({ label: row.label || 'Medida personalizada', unit: '', before: row.before, after: row.after, delta: null }));
    return rows.length || customRows.length ? (
      <div className="mt-3 overflow-hidden rounded-xl border border-gold/20 bg-white">
        <div className="grid grid-cols-[1fr_5rem_5rem_5rem] gap-2 bg-gold/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
          <span>Medida</span><span>Antes</span><span>Después</span><span>Cambio</span>
        </div>
        {[...rows, ...customRows].map(row => (
          <div key={`${row.label}-${row.unit}`} className="grid grid-cols-[1fr_5rem_5rem_5rem] gap-2 border-t border-gray-100 px-3 py-2.5 text-xs">
            <span className="font-semibold text-gray-800">{row.label}</span>
            <span>{row.before ? `${row.before}${row.unit ? ` ${row.unit}` : ''}` : '—'}</span>
            <span>{row.after ? `${row.after}${row.unit ? ` ${row.unit}` : ''}` : '—'}</span>
            <span className={row.delta != null && row.delta <= 0 ? 'font-semibold text-emerald-700' : 'text-gray-600'}>
              {row.delta == null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(1)} ${row.unit}`}
            </span>
          </div>
        ))}
      </div>
    ) : <p className="mt-2 text-sm text-gray-500">Sin medidas antropométricas registradas.</p>;
  }

  const scalp = data as ScalpAssessmentData;
  return (
    <div className="mt-3 space-y-3">
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        {[
          ['Escala y etapa', scalp.scale ? `${SCALP_SCALE_LABELS[scalp.scale]} · ${getScalpStageLabel(scalp.stage || '')}` : 'Sin clasificar'],
          ['Densidad', scalp.density || 'Sin registrar'],
          ['Tipo de alopecia', scalp.alopecia_type || 'Sin registrar'],
          ['Prurito / descamación', scalp.itching_flaking ? 'Sí' : 'No'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-white p-3 ring-1 ring-gold/20">
            <dt className="text-gray-500">{label}</dt>
            <dd className="mt-1 font-semibold text-gray-900">{value}</dd>
          </div>
        ))}
      </dl>
      {scalp.notes?.trim() ? <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700">{scalp.notes}</p> : null}
    </div>
  );
}

/** Divide el string "equipment_used" (separado por comas) en una lista de nombres limpios y sin duplicados */
const parseEquipmentNames = (equipmentUsed: string): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of (equipmentUsed || '').split(',')) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) { seen.add(key); names.push(name); }
  }
  return names;
};

/** Extrae solo YYYY-MM-DD de un ISO timestamp o string de PG para evitar desfase de zona horaria */
const toDateOnly = (d: string | null | undefined): string => {
  if (!d) return '';
  const s = String(d);
  if (s.includes('T')) return s.split('T')[0]; // "2026-05-15T00:00:00.000Z"
  if (s.includes(' ') && s.length > 10) return s.split(' ')[0]; // "2026-05-15 00:00:00"
  return s; // ya es "YYYY-MM-DD"
};
/** Retorna la fecha LOCAL actual en YYYY-MM-DD (no UTC) */
const getLocalDate = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const makeEmptyTreatment = (mode: TreatmentMode): Treatment => ({
  date: getLocalDate(),
  procedure_name: '',
  equipment_used: '',
  parameters: null,
  area_treated: '',
  area_marker: null,
  duration_minutes: 30,
  cost: 0,
  notes: '',
  treatment_mode: mode,
  package_id: null,
});

const parseTreatedZones = (value: string): string[] =>
  value.split(',').map(zone => zone.trim()).filter(Boolean);
const getTreatmentProcedure = (treatment: Treatment): string => treatment.procedure_name;

const toggleTreatedZone = (value: string, zone: string): string => {
  const zones = parseTreatedZones(value);
  const selected = zones.some(item => item.toLocaleLowerCase() === zone.toLocaleLowerCase());
  return (selected
    ? zones.filter(item => item.toLocaleLowerCase() !== zone.toLocaleLowerCase())
    : [...zones, zone]
  ).join(', ');
};

interface TreatmentModeViewProps {
  mode: TreatmentMode;
  /** Modelo .glb a usar en el visor 3D de marcaciones anatómicas de este modo */
  modelUrl?: string;
  recordId: number;
  treatments: Treatment[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

/**
 * Vista compartida por los 3 modos del tab de Tratamientos (Facial/Corporal/Capilar).
 * Contiene el formulario de registro, el visor 3D de marcación anatómica y el historial
 * con gestión de Paquetes vs Sesiones Independientes.
 */
export default function TreatmentModeView({ mode, modelUrl, recordId, treatments, patientName, consultationId, consultations = [], onSave }: TreatmentModeViewProps) {
  const { hasFeature } = useAuth();
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);
  const [currentTreatment, setCurrentTreatment] = useState<Treatment>(makeEmptyTreatment(mode));
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [groupByProcedure, setGroupByProcedure] = useState(true);
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [paramsModalOpen, setParamsModalOpen] = useState(false);
  const [clinicalDataModalOpen, setClinicalDataModalOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [editingEquipmentName, setEditingEquipmentName] = useState('');
  // Zona activa seleccionada en los chips, aplicada a la próxima marcación que se coloque en el visor 3D
  const [activeZoneChip, setActiveZoneChip] = useState<string | null>(null);
  const [markerType, setMarkerType] = useState<MarkerType>('Puntual');
  const [customZone, setCustomZone] = useState('');
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  // ponytail: string state to allow empty field and comma-as-decimal-separator
  const [costInput, setCostInput] = useState('');
  const [financePosting, setFinancePosting] = useState<FinancePostingOptions>(createFinancePostingOptions);
  const [confirmation, setConfirmation] = useState<'package-save' | 'delete' | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const treatedZones = useMemo(() => parseTreatedZones(currentTreatment.area_treated), [currentTreatment.area_treated]);
  const treatedZoneKeys = useMemo(
    () => new Set(treatedZones.map(zone => zone.toLocaleLowerCase())),
    [treatedZones]
  );
  // ── Paquetes ─────────────────────────────────────────────────────────────
  const [packages, setPackages] = useState<TreatmentPackage[]>([]);
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [expandedPackages, setExpandedPackages] = useState<Set<number>>(new Set());

  const loadPackages = useCallback(async () => {
    try {
      if (!consultationId) {
        setPackages([]);
        return;
      }
      const params = new URLSearchParams({
        action: 'listPackagesByRecord',
        record_id: String(recordId),
        consultation_id: String(consultationId),
        treatment_mode: mode,
      });
      const response = await recordsFetch(`/api/records?${params.toString()}`);
      if (response.ok) setPackages(await response.json());
    } catch (error) {
      console.error('Error loading treatment packages:', error);
    }
  }, [consultationId, mode, recordId]);

  useEffect(() => { loadPackages(); }, [loadPackages]);

  // Solo los tratamientos de este modo (el historial previo a la migración ya quedó asignado a 'facial')
  const modeTreatments = useMemo(
    () => treatments.filter(t => (t.treatment_mode || 'facial') === mode),
    [treatments, mode]
  );

  // Sort treatments by date descending for the history list
  const sortedTreatments = useMemo(() => [...modeTreatments]
    .filter(t => Number(t.consultation_id) === Number(consultationId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), [modeTreatments, consultationId]);
  const otherTreatCount = modeTreatments.filter(t => Number(t.consultation_id) !== Number(consultationId)).length;

  const independentSessions = useMemo(() => sortedTreatments.filter(t => !t.package_id), [sortedTreatments]);
  const { groups: procedureGroups, expandedGroups, toggleGroup } = useTreatmentGrouping(
    independentSessions,
    getTreatmentProcedure
  );

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNew = () => {
    setActiveStep(1);
    setCurrentTreatment(makeEmptyTreatment(mode));
    setCostInput('');
    setDateLocked(false);
    setMessage(null);
    setActiveZoneChip(null);
    setViewerOpen(false);
    setFinancePosting(createFinancePostingOptions());
  };

  const handleSelect = (treatment: Treatment) => {
    setActiveStep(1);
    setCurrentTreatment({ ...treatment, date: toDateOnly(treatment.date) });
    setCostInput(treatment.cost > 0 ? String(treatment.cost) : '');
    setDateLocked(true);
    setMessage(null);
    setActiveZoneChip(null);
    setViewerOpen(false);
    setFinancePosting(createFinancePostingOptions());
  };

  const togglePackageExpand = (id: number) => setExpandedPackages(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleSave = async (packageConfirmed = false) => {
    if (selectedPackage && !packageConfirmed) {
      setConfirmation('package-save');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const action = currentTreatment.id ? 'updateTreatment' : 'addTreatment';
      const shouldPostToFinance = financePosting.enabled && Number(currentTreatment.cost) > 0;
      const body = {
        record_id: recordId,
        ...currentTreatment,
        ...(consultationId ? { consultation_id: consultationId } : {}),
        finance_posting: {
          ...financePosting,
          enabled: shouldPostToFinance,
        },
      };

      const response = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const resBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(resBody?.error || `Error al guardar (HTTP ${response.status})`);
      }

      onSave();
      if (currentTreatment.package_id) loadPackages();
      const savedId = currentTreatment.id ?? resBody?.id ?? null;
      if (!currentTreatment.id) {
        handleNew();
      }
      if (savedId != null) {
        setHighlightedId(savedId);
        setTimeout(() => setHighlightedId(null), 2500);
      }
      setMessage({
        type: 'success',
        text: shouldPostToFinance
          ? 'Tratamiento guardado y cobro registrado en Finanzas'
          : 'Tratamiento guardado correctamente',
      });
    } catch (error) {
      console.error('Error saving treatment:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al guardar el tratamiento' });
    } finally {
      setSaving(false);
      setConfirmation(null);
    }
  };

  const handleDelete = async (confirmed = false) => {
    if (!currentTreatment.id) return;
    if (!confirmed) {
      setConfirmation('delete');
      return;
    }
    setDeleting(true);
    setMessage(null);
    try {
      const response = await recordsFetch(`/api/records?action=deleteTreatment&id=${currentTreatment.id}`, {
        method: 'DELETE'
      });
      const resBody = await response.json().catch(() => null);

      if (response.ok) {
        onSave();
        if (currentTreatment.package_id) loadPackages();
        handleNew();
        setMessage({ type: 'success', text: resBody?.message || 'Tratamiento eliminado correctamente' });
      } else {
        throw new Error(resBody?.error || `Error al eliminar (HTTP ${response.status})`);
      }
    } catch (error) {
      console.error('Error deleting:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al eliminar el tratamiento' });
    } finally {
      setDeleting(false);
      setConfirmation(null);
    }
  };

  const handlePrepareNext = () => {
    if (!currentTreatment.id) return;
    const next = prepareNextTreatment(currentTreatment, getLocalDate());
    setCurrentTreatment(next);
    setCostInput(next.cost > 0 ? String(next.cost) : '');
    setDateLocked(false);
    setActiveZoneChip(null);
    setFinancePosting(createFinancePostingOptions());
    setMessage({ type: 'success', text: 'Control preparado, aún sin guardar. Revisa fecha, costo y parámetros; registra los hallazgos nuevos antes de guardar.' });
  };

  const equipmentNames = parseEquipmentNames(currentTreatment.equipment_used);
  const scalpAssessment = currentTreatment.parameters?.[RESERVED_PARAM_KEYS.capilar] as ScalpAssessmentData | undefined;
  const anthropometrics = currentTreatment.parameters?.[RESERVED_PARAM_KEYS.corporal] as AnthropometricsData | undefined;
  const anthropometryCount = anthropometrics
    ? Object.values(anthropometrics.before || {}).filter(Boolean).length
      + Object.values(anthropometrics.after || {}).filter(Boolean).length
      + (anthropometrics.custom?.length || 0)
    : 0;
  const scalpHair = useMemo<ScalpHairVisualization | null>(() => (
    mode === 'capilar' ? getScalpVisualization(scalpAssessment) : null
  ), [mode, scalpAssessment]);
  const scalpStageDescription = useMemo(() => {
    if (!scalpHair) return null;
    const index = getScalpStages(scalpHair.scale).indexOf(scalpHair.stage);
    return index >= 0 ? getScalpDescriptions(scalpHair.scale)[index] : null;
  }, [scalpHair]);
  const markerGroups = useMemo(() => {
    const groups = new Map<string, { zone: string; count: number }>();
    getAreaMarkers(currentTreatment).forEach(marker => {
      const zone = marker.zone?.trim() || 'Sin zona';
      const key = zone.toLocaleLowerCase();
      const group = groups.get(key);
      groups.set(key, { zone: group?.zone || zone, count: (group?.count || 0) + 1 });
    });
    return [...groups.values()];
  }, [currentTreatment]);

  /** Guarda los datos clínicos adicionales del modo (cuidados post-tratamiento, antropometría o evaluación tricológica) bajo la clave reservada de `parameters` */
  const handleSaveClinicalData = (data: PostCareData | AnthropometricsData | ScalpAssessmentData) => {
    setCurrentTreatment(prev => ({
      ...prev,
      parameters: { ...(prev.parameters || {}), [RESERVED_PARAM_KEYS[mode]]: data },
    }));
  };

  /** Agrega una nueva marcación anatómica (soporta varias por sesión), etiquetada con la zona activa si hay una seleccionada */
  const handleMarkerPlaced = (marker: Marker3D) => {
    setCurrentTreatment(prev => ({
      ...prev,
      area_marker: [...getAreaMarkers(prev), {
        ...marker,
        type: markerType,
        radius: markerType === 'Zonal' ? 0.55 : marker.radius,
        zone: activeZoneChip || marker.zone,
      }],
    }));
  };

  const handleRemoveMarkerGroup = (zone: string) => {
    const zoneKey = zone.toLocaleLowerCase();
    setCurrentTreatment(prev => ({
      ...prev,
      area_marker: getAreaMarkers(prev).filter(marker => (marker.zone?.trim() || 'Sin zona').toLocaleLowerCase() !== zoneKey),
    }));
  };

  const handleUseCustomZone = () => {
    const zone = customZone.trim();
    if (!zone) return;
    setActiveZoneChip(zone);
    setCurrentTreatment(prev => ({
      ...prev,
      area_treated: parseTreatedZones(prev.area_treated).some(item => item.toLocaleLowerCase() === zone.toLocaleLowerCase())
        ? prev.area_treated
        : [...parseTreatedZones(prev.area_treated), zone].join(', '),
    }));
  };

  const handleToggleZone = (zone: string) => {
    const wasSelected = treatedZoneKeys.has(zone.toLocaleLowerCase());
    const remainingZones = wasSelected
      ? treatedZones.filter(item => item.toLocaleLowerCase() !== zone.toLocaleLowerCase())
      : [...treatedZones, zone];

    setActiveZoneChip(prev => wasSelected && prev === zone ? remainingZones.at(-1) ?? null : wasSelected ? prev : zone);
    setCurrentTreatment(prev => ({ ...prev, area_treated: toggleTreatedZone(prev.area_treated, zone) }));
  };

  /** Abre el modal de parámetros para el último equipo escrito en el campo (no bloquea el guardado normal del tratamiento) */
  const handleAddEquipment = () => {
    const name = equipmentNames[equipmentNames.length - 1];
    if (!name) return;
    setEditingEquipmentName(name);
    setParamsModalOpen(true);
  };

  /** Abre el modal para editar los parámetros de un equipo ya registrado */
  const handleEditEquipment = (name: string) => {
    setEditingEquipmentName(name);
    setParamsModalOpen(true);
  };

  /** Quita un equipo de la lista y su bloque correspondiente en "Notas" */
  const handleRemoveEquipment = (name: string) => {
    setCurrentTreatment(prev => {
      const remainingNames = parseEquipmentNames(prev.equipment_used).filter(n => n.toLowerCase() !== name.toLowerCase());
      const remainingParams = { ...(prev.parameters || {}) } as Record<string, TreatmentParameters>;
      delete remainingParams[name];
      return {
        ...prev,
        equipment_used: remainingNames.join(', '),
        parameters: Object.keys(remainingParams).length > 0 ? remainingParams : null,
        notes: removeNotesBlock(prev.notes, name),
      };
    });
  };

  /** Guarda los parámetros del equipo en edición: agrega/actualiza la lista y el resumen en "Notas" */
  const handleSaveEquipmentParams = (params: TreatmentParameters) => {
    const name = editingEquipmentName;
    setCurrentTreatment(prev => {
      const existingNames = parseEquipmentNames(prev.equipment_used);
      const nameExists = existingNames.some(n => n.toLowerCase() === name.toLowerCase());
      const newNames = nameExists ? existingNames : [...existingNames, name];
      const newParamsMap = { ...(prev.parameters || {}) } as Record<string, TreatmentParameters>;
      const hasParams = Object.keys(params).length > 0;
      if (hasParams) newParamsMap[name] = params; else delete newParamsMap[name];
      const newNotes = upsertNotesBlock(prev.notes, name, hasParams ? formatParametersAsText(name, params) : '');
      return {
        ...prev,
        equipment_used: newNames.join(', '),
        parameters: Object.keys(newParamsMap).length > 0 ? newParamsMap : null,
        notes: newNotes,
      };
    });
  };

  const selectedPackage = packages.find(p => p.id === currentTreatment.package_id);
  const isEmpty = independentSessions.length === 0 && packages.length === 0;
  const flowSteps = [
    { id: 1 as const, label: 'Sesión', description: 'Fecha, procedimiento y paquete' },
    {
      id: 2 as const,
      label: mode === 'facial' ? 'Zonas' : mode === 'corporal' ? 'Zonas y medidas' : 'Evaluación capilar',
      description: mode === 'facial' ? 'Ubicación opcional' : mode === 'corporal' ? 'Documentación corporal opcional' : 'Escala, etapa y mapa 3D',
    },
    { id: 3 as const, label: 'Aplicación', description: 'Equipo, tiempo y cobro' },
    { id: 4 as const, label: 'Evolución', description: 'Notas, seguimiento y guardado' },
  ];
  const activeFlowStep = flowSteps[activeStep - 1];
  const goToStep = (step: 1 | 2 | 3 | 4) => {
    if (step > 1 && !currentTreatment.procedure_name.trim()) {
      setMessage({ type: 'error', text: 'Completa el procedimiento para continuar con el registro.' });
      return;
    }
    setMessage(null);
    setActiveStep(step);
  };

  const renderSessionCard = (t: Treatment, index: number) => (
    <motion.div
      key={t.id || index}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => handleSelect(t)}
      className={`p-3 rounded-xl cursor-pointer border transition-all shadow-sm ${
        highlightedId === t.id ? 'ring-2 ring-[#b8944d] ring-offset-2 ring-offset-white animate-pulse' : ''
      } ${
        currentTreatment.id === t.id
          ? 'bg-[#deb887] text-white border-[#deb887] shadow-md'
          : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-[#deb887]/30'
      }`}
    >
      <div className="flex justify-between items-center text-xs">
        <span className="font-medium">{new Date(toDateOnly(t.date) + 'T12:00:00').toLocaleDateString('es-EC')}</span>
        <FileText className="w-3.5 h-3.5 opacity-60" />
      </div>
      <div className="text-xs font-semibold truncate mt-0.5">{t.procedure_name || 'Sin procedimiento'}</div>
      <div className="text-xs opacity-75 truncate">{t.equipment_used || 'Sin equipo'}</div>
      <div className="mt-1 text-[10px]">{getFollowUpLabel(t)}</div>
      {getClinicalDataBadge(t, mode) && (
        <div className={`text-[10px] mt-1 truncate rounded px-1.5 py-0.5 inline-block ${currentTreatment.id === t.id ? 'bg-white/20' : 'bg-[#deb887]/10 text-[#b8944d]'}`}>
          {getClinicalDataBadge(t, mode)}
        </div>
      )}
    </motion.div>
  );

  return (
    <>
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid grid-cols-1 gap-5 xl:grid-cols-[15rem_minmax(0,1fr)] 2xl:grid-cols-[15rem_minmax(0,1fr)_19rem]"
    >
      {/* Sidebar List */}
      <div className="admin-surface order-2 flex max-h-[32rem] w-full flex-col gap-4 border-b border-gray-100 p-4 xl:order-1 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-12rem)]">
        <div className="font-bold text-gray-800 flex items-center gap-2 flex-wrap">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial
          <Tooltip content="Crear Paquete">
            <button
              onClick={() => setPackageModalOpen(true)}
              className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-[#deb887]/10 hover:text-[#b8944d] hover:border-[#deb887]/40 transition-colors"
            >
              <Package className="w-4 h-4" />
            </button>
          </Tooltip>
          <button
            onClick={() => setGroupByProcedure(g => !g)}
            title={groupByProcedure ? 'Vista plana' : 'Agrupar por procedimiento'}
            className={`p-1.5 rounded-lg border transition-colors ${groupByProcedure ? 'bg-[#deb887]/20 border-[#deb887]/40 text-[#b8944d]' : 'border-gray-200 text-gray-400 hover:bg-gray-50'}`}
          >
            <Layers className="w-4 h-4" />
          </button>
          {otherTreatCount > 0 && (
            <button onClick={() => setCrossHistOpen(true)} title={`Ver ${otherTreatCount} tratamiento(s) de otras consultas`} className="p-1 hover:bg-[#deb887]/10 rounded-lg relative">
              <History className="w-3.5 h-3.5 text-[#b8944d]" />
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#b8944d] text-white text-[8px] rounded-full flex items-center justify-center font-bold">{otherTreatCount > 9 ? '9+' : otherTreatCount}</span>
            </button>
          )}
          <span className="ml-auto text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{sortedTreatments.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[260px] md:max-h-none pr-2 custom-scrollbar">
          {isEmpty ? (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay tratamientos previos
            </div>
          ) : (
            <>
              {/* ── Paquetes ─────────────────────────────────────────────── */}
              {packages.map(pkg => {
                const isCollapsed = !expandedPackages.has(pkg.id!);
                const debt = getPackageDebt(pkg);
                const paid = getPackagePaidTotal(pkg);
                const pkgSessions = sortedTreatments.filter(t => t.package_id === pkg.id);
                return (
                  <div key={pkg.id} className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => togglePackageExpand(pkg.id!)}
                      className="w-full flex flex-col gap-1 px-2.5 py-2 bg-amber-50 hover:bg-amber-100/70 rounded-lg border border-amber-200 transition-colors text-left"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-amber-700 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-amber-700 shrink-0" />}
                        <Package className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                        <span className="text-xs font-bold text-amber-800 truncate">{pkg.name}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-amber-700 pl-5">
                        <span>{pkg.sessions_count ?? pkgSessions.length} de {pkg.estimated_sessions} sesiones</span>
                        <span className={`font-semibold ${debt > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {debt > 0 ? `Debe $${debt.toFixed(2)}` : 'Pagado'}
                        </span>
                      </div>
                      <div className="pl-5 text-[10px] text-amber-600">Pagado: ${paid.toFixed(2)} / ${Number(pkg.total_cost).toFixed(2)}</div>
                    </button>
                    <AnimatePresence initial={false}>
                      {!isCollapsed && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden space-y-1.5 pl-2"
                        >
                          {pkgSessions.length === 0 ? (
                            <p className="text-[11px] text-gray-400 px-2 py-1">Sin sesiones registradas aún</p>
                          ) : pkgSessions.map((t, idx) => renderSessionCard(t, idx))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

              {/* ── Sesiones independientes ──────────────────────────────── */}
              {independentSessions.length === 0 ? null : groupByProcedure ? (
                procedureGroups.map(({ key, displayName, items: treats }) => {
                  const isCollapsed = !expandedGroups.has(key);
                  return (
                    <div key={key} className="space-y-1.5">
                      <button
                        type="button"
                        onClick={() => toggleGroup(key)}
                        className="w-full flex items-center justify-between px-2 py-1.5 bg-[#deb887]/10 hover:bg-[#deb887]/20 rounded-lg transition-colors"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isCollapsed
                            ? <ChevronRight className="w-3.5 h-3.5 text-[#b8944d] shrink-0" />
                            : <ChevronDown className="w-3.5 h-3.5 text-[#b8944d] shrink-0" />}
                          <span className="text-xs font-bold text-[#b8944d] truncate">{displayName}</span>
                        </div>
                        <span className="text-[10px] font-medium bg-[#deb887]/20 text-[#b8944d] px-1.5 py-0.5 rounded-full shrink-0 ml-1">
                          {treats.length} ses.
                        </span>
                      </button>
                      <AnimatePresence initial={false}>
                        {!isCollapsed && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="overflow-hidden space-y-1.5"
                          >
                            {treats.map((t, idx) => renderSessionCard(t, idx))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })
              ) : (
                independentSessions.map((t, index) => renderSessionCard(t, index))
              )}
            </>
          )}
        </div>
      </div>

      {/* Main Form */}
      <div className={`relative order-1 flex min-w-0 flex-col gap-5 overflow-visible xl:order-2 ${activeStep === 4 ? '' : '2xl:col-span-2'}`}>
        {/* Toolbar */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white p-3 shadow-sm sm:p-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-gold-ink">
              {currentTreatment.id ? 'Editando sesión' : 'Nueva sesión'}
            </p>
            <p className="truncate text-sm font-semibold text-gray-900">
              {currentTreatment.procedure_name || 'Completa los datos del tratamiento'}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {selectedPackage ? `Paquete: ${selectedPackage.name}` : 'Sesión independiente'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Tooltip content="Nuevo Tratamiento">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleNew}
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs font-semibold">Nueva</span>
              </motion.button>
            </Tooltip>

            {currentTreatment.id ? (
              <button
                type="button"
                onClick={() => setSummaryOpen(true)}
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg border border-gold/50 bg-gold/10 px-3 text-gold-ink hover:bg-gold/20"
              >
                <Eye className="h-4 w-4" aria-hidden="true" />
                <span className="text-xs font-semibold">Resumen</span>
              </button>
            ) : null}

            <Tooltip content={activeStep === 4 ? 'Guardar' : 'Continuar al siguiente paso'}>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => activeStep === 4 ? handleSave() : goToStep((activeStep + 1) as 2 | 3 | 4)}
                disabled={saving}
                className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg bg-gold-dark px-3 text-white shadow-sm hover:bg-gold-ink disabled:opacity-70"
              >
                {saving ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : activeStep === 4 ? <Save className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                <span className="text-xs font-semibold">{saving ? 'Guardando…' : activeStep === 4 ? 'Guardar sesión' : 'Continuar'}</span>
              </motion.button>
            </Tooltip>

            <Tooltip content="Preparar siguiente sesión sin copiar hallazgos ni guardar automáticamente">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePrepareNext}
                disabled={!currentTreatment.id || saving}
                aria-label="Preparar siguiente sesión"
                className="admin-focus-ring flex min-h-11 items-center gap-2 p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 disabled:opacity-50"
              >
                <Copy className="w-5 h-5" aria-hidden="true" />
                <span className="text-xs font-semibold">Siguiente sesión</span>
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => void handleDelete()}
                disabled={!currentTreatment.id || deleting}
                aria-label="Eliminar sesión"
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 disabled:opacity-50"
              >
                {deleting ? <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-500 rounded-full" /> : <Trash2 className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            {hasFeature('treatment_notes_view') && (
              <Tooltip content="Ver observaciones del expediente">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setNotesModalOpen(true)}
                  className="p-2 hover:bg-teal-50 rounded-lg text-teal-600 border border-teal-100"
                >
                  <Eye className="w-5 h-5" />
                </motion.button>
              </Tooltip>
            )}
          </div>
        </div>

        <AnimatePresence>
          {message && (
            <motion.div
              ref={messageRef}
              role={message.type === 'error' ? 'alert' : 'status'} aria-live={message.type === 'error' ? 'assertive' : 'polite'}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className={`p-4 rounded-xl flex items-center gap-3 shadow-sm ${
                message.type === 'success'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                  : 'bg-red-50 text-red-700 border border-red-100'
              }`}
            >
              <div className={`p-1.5 rounded-full ${message.type === 'success' ? 'bg-emerald-100' : 'bg-red-100'}`}>
                {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              </div>
              <span className="font-medium text-sm">{message.text}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <nav className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm" aria-label="Progreso del registro">
          <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {flowSteps.map(step => {
              const active = activeStep === step.id;
              const completed = activeStep > step.id;
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => goToStep(step.id)}
                    aria-current={active ? 'step' : undefined}
                    className={`admin-focus-ring flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] ${
                      active
                        ? 'border-gold-dark bg-gold/10 shadow-sm'
                        : completed
                          ? 'border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50'
                          : 'border-gray-100 bg-gray-50/60 hover:border-gold/50 hover:bg-white'
                    }`}
                  >
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                      active ? 'bg-gold-dark text-white' : completed ? 'bg-emerald-600 text-white' : 'bg-white text-gray-500 ring-1 ring-gray-200'
                    }`}>
                      {completed ? <Check className="h-4 w-4" aria-hidden="true" /> : step.id}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-gray-900">{step.label}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-gray-500">{step.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Form Fields */}
        <div className="space-y-6 overflow-y-auto rounded-xl border border-gray-100 bg-white p-4 shadow-sm custom-scrollbar sm:p-6">
          <div className="border-b border-gray-100 pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">Paso {activeStep} de 4</p>
            <h2 className="mt-1 text-lg font-semibold text-gray-900">{activeFlowStep.label}</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">{activeFlowStep.description}</p>
          </div>
          {/* Visor 3D de marcación anatómica (múltiples zonas por sesión) */}
          <div className={activeStep === 2 ? 'space-y-3' : 'hidden'}>
            {mode !== 'capilar' ? (
              <p className="text-sm font-medium text-gray-700">
                {mode === 'facial' ? 'Zonas tratadas' : 'Documentación corporal'}
              </p>
            ) : null}
            <p className="text-xs text-gray-400">
              {mode === 'facial'
                ? 'Selecciona las zonas que ayuden a ubicar el procedimiento. Puedes continuar sin elegir ninguna.'
                : mode === 'capilar'
                  ? 'Define escala y etapa para generar el modelo. Añade zonas o marcaciones solo cuando aporten información clínica.'
                  : 'Selecciona las zonas tratadas. Las medidas y el mapa 3D son opcionales y sirven para comparar la evolución o precisar la ubicación.'}
            </p>
            {mode === 'capilar' ? (
              <div className={`rounded-2xl border p-4 ${scalpHair ? 'border-emerald-200 bg-emerald-50/70' : 'border-amber-200 bg-amber-50/70'}`} role="status">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${scalpHair ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      <ScanSearch className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-gray-900">1. Define escala y etapa</h3>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${scalpHair ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                          {scalpHair ? 'Completada' : 'Pendiente'}
                        </span>
                      </div>
                      {scalpHair ? (
                        <>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium text-gray-700">
                            <span className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1">Escala: {SCALP_SCALE_LABELS[scalpHair.scale]}</span>
                            <span className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1">Etapa: {getScalpStageLabel(scalpHair.stage)}</span>
                            <span className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1">Densidad: {scalpAssessment?.density || 'Sin registrar'}</span>
                          </div>
                          {scalpStageDescription ? <p className="mt-2 text-xs leading-5 text-gray-600">{scalpStageDescription}.</p> : null}
                        </>
                      ) : (
                        <p className="mt-1 text-sm leading-6 text-gray-700">
                          Selecciona una escala y su etapa. Al aplicar la evaluación aparecerá automáticamente el modelo correspondiente.
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setClinicalDataModalOpen(true)}
                    className="admin-focus-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-gold/50 bg-white px-4 text-sm font-semibold text-gold-ink shadow-sm hover:bg-gold/10"
                  >
                    <ScanSearch className="h-4 w-4" aria-hidden="true" />
                    {scalpHair ? 'Editar escala y etapa' : 'Definir escala y etapa'}
                  </button>
                </div>
              </div>
            ) : mode === 'corporal' ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">Antropometría de la sesión</h3>
                    <p className="mt-1 text-sm leading-6 text-gray-600">
                      {anthropometryCount
                        ? `${anthropometryCount} medida(s) registrada(s). Puedes actualizarlas antes de continuar.`
                        : 'Registra medidas antes/después solo cuando aporten valor al seguimiento.'}
                    </p>
                  </div>
                  <button type="button" onClick={() => setClinicalDataModalOpen(true)}
                    className="admin-focus-ring min-h-11 shrink-0 rounded-xl border border-emerald-300 bg-white px-4 text-sm font-semibold text-emerald-800 hover:bg-emerald-50">
                    {anthropometryCount ? 'Editar antropometría' : 'Registrar antropometría'}
                  </button>
                </div>
              </div>
            ) : null}
            {mode !== 'capilar' || scalpHair ? <><div className="space-y-3">
              <div className="flex min-h-6 items-center justify-between gap-3">
                <p className="text-xs font-medium text-gray-600">
                  {treatedZones.length ? `${treatedZones.length} zona${treatedZones.length === 1 ? '' : 's'} seleccionada${treatedZones.length === 1 ? '' : 's'}` : 'Sin zonas seleccionadas'}
                </p>
                {treatedZones.length ? (
                  <button
                    type="button"
                    onClick={() => setCurrentTreatment(prev => ({ ...prev, area_treated: '' }))}
                    className="admin-focus-ring rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                  >
                    Limpiar selección
                  </button>
                ) : null}
              </div>
              {ZONE_GROUPS_BY_MODE[mode].map(group => (
                <fieldset key={group.label} className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                  <legend className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{group.label}</legend>
                  <div className="flex flex-wrap gap-2">
                    {group.zones.map(zone => (
                      <button
                        key={zone}
                        type="button"
                        onClick={() => handleToggleZone(zone)}
                        aria-pressed={treatedZoneKeys.has(zone.toLocaleLowerCase())}
                        className={`admin-focus-ring min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow] ${
                          treatedZoneKeys.has(zone.toLocaleLowerCase())
                            ? 'border-2 border-gray-900 bg-gray-900 text-white shadow-sm ring-2 ring-gray-300'
                            : 'border border-gray-200 bg-white text-gray-700 hover:border-gold hover:bg-gold/10'
                        }`}
                      >
                        {zone}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
              {treatedZones.filter(zone => !(ZONE_CHIPS_BY_MODE[mode] || []).includes(zone)).map(zone => (
                <button
                  key={zone}
                  type="button"
                  aria-pressed="true"
                  onClick={() => handleToggleZone(zone)}
                  className="admin-focus-ring rounded-full border-2 border-gray-900 bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm ring-2 ring-gray-300"
                >
                  {zone} ×
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-200 bg-white p-2.5 sm:flex-row">
              <div className="min-w-0 flex-1">
                <label htmlFor={`custom-zone-${mode}`} className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-500">Zona libre</label>
                <input
                  id={`custom-zone-${mode}`}
                  type="text"
                  value={customZone}
                  onChange={event => setCustomZone(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); handleUseCustomZone(); } }}
                  placeholder="Ej: Región retroauricular derecha"
                  className="admin-focus-ring w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-700 placeholder:text-gray-400"
                />
              </div>
              <button
                type="button"
                onClick={handleUseCustomZone}
                disabled={!customZone.trim()}
                className="admin-focus-ring inline-flex items-center justify-center gap-1 rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gold-ink disabled:cursor-not-allowed disabled:opacity-40 sm:self-end"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Usar zona
              </button>
            </div></> : null}
            {mode !== 'capilar' || scalpHair ? (
              <section className="rounded-2xl border border-gray-200 bg-gray-50/70">
                {mode === 'capilar' ? (
                  <div className="flex min-h-12 items-center justify-between gap-3 rounded-2xl px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">2. Revisa el modelo capilar</p>
                      <p className="mt-0.5 text-xs font-normal text-gray-500">Se genera con la evaluación; las marcaciones son opcionales</p>
                    </div>
                    <span className="rounded-full bg-gold/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gold-ink">
                      Modelo clínico
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setViewerOpen(open => !open)}
                    aria-expanded={viewerOpen}
                    aria-controls={`treatment-viewer-${mode}`}
                    className="admin-focus-ring flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-sm font-semibold text-gray-800"
                  >
                  <span>
                    Precisar ubicación en mapa 3D
                    <span className="ml-2 font-normal text-gray-500">(opcional)</span>
                  </span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${viewerOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                )}
                {activeStep === 2 && (mode === 'capilar' || viewerOpen) ? <div id={`treatment-viewer-${mode}`} className="space-y-3 border-t border-gray-200 p-3">
                  <p className="text-xs leading-5 text-gray-600">
                    {mode !== 'capilar'
                      ? `Úsalo solo si necesitas indicar un punto exacto o un área de cobertura. Las zonas ${mode === 'facial' ? 'faciales' : 'corporales'} seleccionadas arriba son suficientes para un registro general.`
                      : 'Si necesitas documentar una ubicación exacta, elige el tipo de marca y colócala sobre el modelo.'}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    {([
                      ['Puntual', MapPin, 'Punto preciso', 'Ideal para sitios de aplicación', 'Crea una marca pequeña y exacta. Úsala para inyecciones, punciones o referencias anatómicas localizadas.'],
                      ['Zonal', CircleDashed, 'Área de cobertura', 'Delimita regiones más amplias', 'Crea una región circular ajustable. Úsala para aparatología, láser o tratamientos de cobertura continua.'],
                    ] as const).map(([type, Icon, title, description, detail]) => (
                      <Tooltip key={type} content={detail} position="top" className="w-full">
                        <button
                          type="button"
                          onClick={() => setMarkerType(type)}
                          aria-pressed={markerType === type}
                          className={`admin-focus-ring relative flex w-full items-center gap-2 rounded-xl bg-white p-2.5 text-left transition-[border-color,background-color,box-shadow,transform] ${
                            markerType === type
                              ? 'border-2 border-gold-dark bg-gold/10 shadow-md ring-2 ring-gold/30'
                              : 'border border-gray-200 hover:-translate-y-0.5 hover:border-gold hover:bg-gold/10 hover:shadow-sm'
                          }`}
                        >
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${markerType === type ? 'bg-gold-dark text-white' : 'bg-gray-50 text-gray-500'}`}>
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <span className="pr-5">
                            <span className="block text-xs font-semibold text-gray-800">{title}</span>
                            <span className="block text-[9px] text-gray-500">{description}</span>
                          </span>
                          {markerType === type ? <CheckCircle2 className="absolute right-2 top-2 h-4 w-4 text-gold-ink" aria-hidden="true" /> : null}
                        </button>
                      </Tooltip>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCurrentTreatment(prev => ({ ...prev, area_marker: getAreaMarkers(prev).slice(0, -1) }))}
                      disabled={getAreaMarkers(currentTreatment).length === 0}
                      className="admin-focus-ring inline-flex min-h-12 items-center justify-center gap-1 rounded-xl border border-gray-200 bg-white px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Undo2 className="h-4 w-4" aria-hidden="true" /> Deshacer
                    </button>
                  </div>
                <div className="relative overflow-hidden rounded-2xl border border-gray-100 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.8)]" style={{ height: '360px' }}>
                  <Clinical3DViewer
                    markers={getAreaMarkers(currentTreatment)}
                    selectedPathology="lesion"
                    modelUrl={modelUrl}
                    cameraPreset={mode === 'capilar' ? 'scalp' : mode === 'facial' ? 'face' : 'body'}
                    scalpHair={scalpHair}
                    skipConfirmation={true}
                    onMarkerPlaced={handleMarkerPlaced}
                    height="360px"
                    pointMarkerScale={0.6}
                    showMarkerLabels={mode !== 'capilar'}
                  />
                  {mode === 'capilar' && scalpHair ? (
                    <div className="pointer-events-none absolute bottom-3 left-3 right-3 max-w-sm rounded-xl border border-white/70 bg-slate-950/85 p-3 text-white shadow-xl backdrop-blur-md sm:right-auto" role="note" aria-label="Evaluación capilar representada">
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gold-light">
                        <span>{SCALP_SCALE_LABELS[scalpHair.scale]}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getScalpStageLabel(scalpHair.stage)}</span>
                        {scalpAssessment?.density ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Densidad {scalpAssessment.density.toLocaleLowerCase()}</span>
                          </>
                        ) : null}
                      </div>
                      {scalpStageDescription ? <p className="mt-1 text-xs leading-5 text-white/90">{scalpStageDescription}.</p> : null}
                      <p className="mt-1 text-[10px] leading-4 text-white/65">
                        Referencia visual para comparar evolución; define el plan con diagnóstico, antecedentes y respuesta clínica.
                      </p>
                    </div>
                  ) : null}
                  {getAreaMarkers(currentTreatment).length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setCurrentTreatment(prev => ({ ...prev, area_marker: null }))}
                      className="absolute top-2 right-2 z-10 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-900/65 text-white hover:bg-gray-900/90 transition-colors border border-white/15 backdrop-blur-sm"
                    >
                      <X size={12} /> Quitar todas
                    </button>
                  ) : null}
                </div>
                {markerGroups.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5" aria-label="Resumen de marcaciones">
                    {markerGroups.map(group => (
                      <span key={group.zone} className="flex items-center gap-1.5 rounded-full bg-gold/10 px-2.5 py-1 text-[11px] text-gold-ink">
                        <span>{group.zone}</span>
                        <span className="rounded-full bg-white/80 px-1.5 font-semibold">{group.count}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveMarkerGroup(group.zone)}
                          aria-label={`Quitar ${group.count} marcación${group.count === 1 ? '' : 'es'} de ${group.zone}`}
                          className="admin-focus-ring rounded-full p-0.5 hover:bg-red-50 hover:text-red-600"
                        >
                          <X size={10} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                </div> : null}
              </section>
            ) : null}
          </div>

          {activeStep <= 3 ? <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className={activeStep === 1 ? 'space-y-2' : 'hidden'}>
              <label htmlFor="treatment-date" className="block text-sm font-medium text-gray-700">Fecha</label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    id="treatment-date"
                    type="date"
                    disabled={dateLocked}
                    className={`w-full pl-10 p-2.5 border rounded-lg outline-none transition-all ${
                      dateLocked
                        ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'border-gray-200 focus:ring-2 focus:ring-[#deb887] bg-gray-50/50 focus:bg-white'
                    }`}
                    value={currentTreatment.date}
                    onChange={e => setCurrentTreatment({ ...currentTreatment, date: e.target.value })}
                  />
                </div>
                {currentTreatment.id && dateLocked && (
                  <Tooltip content="Actualizar fecha">
                    <button
                      type="button"
                      onClick={() => setDateLocked(false)}
                      className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors shrink-0"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
            <div className={activeStep === 1 ? 'space-y-2' : 'hidden'}>
              <label className="block text-sm font-medium text-gray-700">Procedimiento<FieldHelp text={HELP.treatment.procedure_name} /></label>
              <input
                type="text"
                required
                list="procedures-list"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.procedure_name}
                onChange={e => setCurrentTreatment({ ...currentTreatment, procedure_name: e.target.value })}
                placeholder={FORM_COPY[mode].procedure}
              />
              <datalist id="procedures-list">
                {PROCEDURE_SUGGESTIONS_BY_MODE[mode].map((p: string, i: number) => (
                  <option key={i} value={p} />
                ))}
              </datalist>
            </div>
            <div className={activeStep === 1 ? 'space-y-2 md:col-span-2' : 'hidden'}>
              <label htmlFor="treatment-package" className="block text-sm font-medium text-gray-700">
                Paquete <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <select
                id="treatment-package"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.package_id ?? ''}
                onChange={e => setCurrentTreatment({ ...currentTreatment, package_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">— Sesión independiente —</option>
                {packages.map(pkg => (
                  <option key={pkg.id} value={pkg.id}>{pkg.name} (debe ${getPackageDebt(pkg).toFixed(2)})</option>
                ))}
              </select>
              {selectedPackage && (
                <p className="text-[11px] text-amber-700 flex items-start gap-1.5 bg-amber-50 px-2.5 py-2 rounded-lg border border-amber-200">
                  <Wallet size={13} className="mt-0.5 shrink-0" />
                  <span>
                    Esta sesión se guardará dentro de <strong>{selectedPackage.name}</strong>. El campo "Costo" se registrará como abono y se confirmará antes de guardar.
                  </span>
                </p>
              )}
            </div>
            <div className={activeStep === 3 ? 'space-y-2 md:col-span-2' : 'hidden'}>
              <label className="block text-sm font-medium text-gray-700">Equipo Utilizado<FieldHelp text={HELP.treatment.equipment_used} /></label>
              {equipmentNames.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {equipmentNames.map(name => {
                    const hasParams = !!currentTreatment.parameters?.[name] && Object.keys(currentTreatment.parameters[name] as object).length > 0;
                    return (
                      <span
                        key={name}
                        onClick={() => handleEditEquipment(name)}
                        title="Editar parámetros"
                        className={`group inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
                          hasParams
                            ? 'bg-[#deb887]/15 border-[#deb887]/40 text-[#b8944d] hover:bg-[#deb887]/25'
                            : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        {hasParams ? <Sparkles className="w-3 h-3" /> : <Wrench className="w-3 h-3 opacity-60" />}
                        {name}
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleRemoveEquipment(name); }}
                          className="p-0.5 rounded-full hover:bg-black/10 shrink-0"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  list="equipment-list"
                  className="flex-1 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                  value={currentTreatment.equipment_used}
                  onChange={e => setCurrentTreatment({ ...currentTreatment, equipment_used: e.target.value })}
                  placeholder={FORM_COPY[mode].equipment}
                />
                <Tooltip content="Registrar parámetros del último equipo escrito (opcional)">
                  <button
                    type="button"
                    onClick={handleAddEquipment}
                    disabled={equipmentNames.length === 0}
                    className="px-3 rounded-lg bg-[#deb887] text-white hover:bg-[#c5a075] disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1 text-sm font-medium"
                  >
                    <Plus className="w-4 h-4" /> Añadir
                  </button>
                </Tooltip>
              </div>
              <datalist id="equipment-list">
                {EQUIPMENT_SUGGESTIONS_BY_MODE[mode].map((e: string, i: number) => (
                  <option key={i} value={e} />
                ))}
              </datalist>
              <p className="text-[11px] text-gray-400">Puedes escribir varios equipos separados por coma. El botón "Añadir" es opcional y solo registra parámetros detallados en "Notas".</p>
            </div>
            <div className={activeStep === 2 ? 'space-y-2 md:col-span-2' : 'hidden'}>
              <label className="block text-sm font-medium text-gray-700">Zona Tratada<FieldHelp text={HELP.treatment.area_treated} /></label>
              <input
                type="text"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.area_treated}
                onChange={e => {
                  setActiveZoneChip(null);
                  setCurrentTreatment({ ...currentTreatment, area_treated: e.target.value });
                }}
                placeholder={FORM_COPY[mode].area}
              />
            </div>
            <div className={activeStep === 3 ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 md:col-span-2' : 'hidden'}>
              <div className="space-y-2">
                <label htmlFor="treatment-duration" className="block text-sm font-medium text-gray-700">Duración (min)<FieldHelp text={HELP.treatment.duration_minutes} /></label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    id="treatment-duration"
                    type="number"
                    className="w-full pl-10 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                    value={currentTreatment.duration_minutes}
                    onChange={e => setCurrentTreatment({ ...currentTreatment, duration_minutes: parseInt(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  {selectedPackage ? 'Abono de esta sesión' : 'Costo'}<FieldHelp text={HELP.treatment.cost} />
                </label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    inputMode="decimal"
                    className="w-full pl-10 p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                    placeholder="0.00"
                    value={costInput}
                    onChange={e => {
                      const raw = e.target.value.replace(',', '.');
                      setCostInput(raw);
                      const n = parseFloat(raw);
                      setCurrentTreatment(prev => ({ ...prev, cost: isNaN(n) ? 0 : n }));
                    }}
                  />
                </div>
              </div>
              <div className="sm:col-span-2">
                <TreatmentFinanceOptions
                  amount={Number(currentTreatment.cost) || 0}
                  patientName={patientName}
                  value={financePosting}
                  onChange={setFinancePosting}
                />
              </div>
            </div>
          </div> : null}

          {activeStep === 4 ? (
            <section className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4" aria-labelledby="treatment-review-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gold-ink">Revisión antes de guardar</p>
                  <h3 id="treatment-review-title" className="mt-1 font-semibold text-gray-900">
                    {currentTreatment.procedure_name || 'Procedimiento pendiente'}
                  </h3>
                </div>
                <button type="button" onClick={() => setActiveStep(1)}
                  className="admin-focus-ring min-h-10 rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                  Editar datos principales
                </button>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                {[
                  ['Fecha', currentTreatment.date],
                  ['Registro', selectedPackage?.name || 'Sesión independiente'],
                  ['Zonas', currentTreatment.area_treated || 'Sin zonas'],
                  ['Equipo', currentTreatment.equipment_used || 'Sin equipo'],
                  ['Duración', `${currentTreatment.duration_minutes || 0} min`],
                  [selectedPackage ? 'Abono' : 'Costo', `$${(Number(currentTreatment.cost) || 0).toFixed(2)}`],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0 rounded-xl bg-white p-3 ring-1 ring-gray-100">
                    <dt className="font-medium text-gray-400">{label}</dt>
                    <dd className="mt-1 truncate font-semibold text-gray-800" title={value}>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          <div className={activeStep === 4 ? 'space-y-2' : 'hidden'}>
            <label className="block text-sm font-medium text-gray-700">Observaciones de la sesión<FieldHelp text={HELP.treatment.notes} /></label>
            <textarea
              rows={5}
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentTreatment.notes}
              onChange={e => setCurrentTreatment({ ...currentTreatment, notes: e.target.value })}
              placeholder="Respuesta observada, tolerancia, incidencias e indicaciones entregadas…"
            />
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => goToStep(Math.max(1, activeStep - 1) as 1 | 2 | 3)}
              disabled={activeStep === 1}
              className="admin-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:invisible"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Anterior
            </button>
            {activeStep < 4 ? (
              <button type="button" onClick={() => goToStep((activeStep + 1) as 2 | 3 | 4)}
                className="admin-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gold-dark px-5 text-sm font-semibold text-white hover:bg-gold-ink">
                Continuar a {flowSteps[activeStep].label} <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : (
              <button type="button" onClick={() => void handleSave()} disabled={saving}
                className="admin-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gold-dark px-5 text-sm font-semibold text-white hover:bg-gold-ink disabled:opacity-60">
                {saving ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                {saving ? 'Guardando…' : 'Guardar sesión'}
              </button>
            )}
          </div>
        </div>

        {activeStep === 4 ? <div>
          <div className="mb-3 px-1">
            <h2 className="text-lg font-semibold text-gray-900">Comparación opcional</h2>
            <p className="mt-1 text-xs leading-5 text-gray-500">Crea una línea base o compara la evolución solo cuando sea clínicamente útil.</p>
          </div>
          <TreatmentFollowUpPanel
            key={`${mode}-${currentTreatment.id ?? 'new'}-${currentTreatment.package_id ?? currentTreatment.procedure_name}`}
            mode={mode}
            current={currentTreatment}
            history={modeTreatments}
            onChange={followUp => setCurrentTreatment(previous => ({
              ...previous, parameters: { ...previous.parameters, [FOLLOW_UP_KEY]: followUp },
            }))}
          />
        </div> : null}
      </div>

      {activeStep === 4 ? <ClinicalSummaryPanel
        mode={mode}
        data={currentTreatment.parameters?.[RESERVED_PARAM_KEYS[mode]] as PostCareData | AnthropometricsData | ScalpAssessmentData | undefined}
        onEdit={() => setClinicalDataModalOpen(true)}
      /> : null}
    </motion.div>
    <Dialog open={summaryOpen} onClose={() => setSummaryOpen(false)} labelledBy="treatment-summary-title">
      <div className="flex max-h-[88dvh] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-ink">Sesión guardada · {TREATMENT_MODE_LABELS[mode]}</p>
            <h2 id="treatment-summary-title" className="mt-1 truncate text-xl font-semibold text-gray-900">
              {currentTreatment.procedure_name || 'Tratamiento sin nombre'}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {currentTreatment.date ? new Date(`${toDateOnly(currentTreatment.date)}T12:00:00`).toLocaleDateString('es-EC') : 'Fecha no registrada'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSummaryOpen(false)}
            className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100"
            aria-label="Cerrar resumen"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-5">
          <section aria-labelledby="summary-session-title">
            <h3 id="summary-session-title" className="text-sm font-semibold text-gray-900">Datos de la sesión</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              {[
                ['Registro', selectedPackage?.name || 'Sesión independiente'],
                ['Zonas', currentTreatment.area_treated || 'Sin zonas registradas'],
                ['Equipo', currentTreatment.equipment_used || 'Sin equipo'],
                ['Duración', `${currentTreatment.duration_minutes || 0} min`],
                [selectedPackage ? 'Abono' : 'Costo', `$${(Number(currentTreatment.cost) || 0).toFixed(2)}`],
                ['Marcaciones 3D', String(getAreaMarkers(currentTreatment).length)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-xl border border-gray-100 bg-gray-50/70 p-3">
                  <dt className="font-medium text-gray-500">{label}</dt>
                  <dd className="mt-1 break-words font-semibold text-gray-900">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="summary-location-title">
            <h3 id="summary-location-title" className="text-sm font-semibold text-gray-900">Ubicación y marcaciones</h3>
            <p className="mt-2 text-sm leading-6 text-gray-700">
              <span className="font-medium">Zonas tratadas:</span> {currentTreatment.area_treated || 'Sin zonas registradas.'}
            </p>
            {getAreaMarkers(currentTreatment).length ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {getAreaMarkers(currentTreatment).map((marker, index) => (
                  <li key={marker.id || index} className="rounded-xl border border-gray-100 bg-gray-50/70 p-3 text-xs">
                    <span className="font-semibold text-gray-900">{marker.zone || 'Zona sin nombre'}</span>
                    <span className="ml-2 text-gray-500">· {marker.type === 'Zonal' ? 'Área de cobertura' : 'Punto preciso'}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-xs text-gray-500">Sin marcaciones sobre el modelo 3D.</p>}
          </section>

          <section className="rounded-xl border border-gold/30 bg-gold/10 p-4" aria-labelledby="summary-clinical-title">
            <h3 id="summary-clinical-title" className="text-sm font-semibold text-gray-900">Datos clínicos</h3>
            <SavedClinicalDataSummary treatment={currentTreatment} mode={mode} />
          </section>

          <section aria-labelledby="summary-notes-title">
            <h3 id="summary-notes-title" className="text-sm font-semibold text-gray-900">Observaciones</h3>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-gray-100 bg-gray-50/70 p-4 text-sm leading-6 text-gray-700">
              {currentTreatment.notes?.trim() || 'Sin observaciones registradas.'}
            </p>
          </section>

          {getTreatmentFollowUp(currentTreatment).purpose ? (
            <section className="rounded-xl border border-gray-100 p-4" aria-labelledby="summary-follow-up-title">
              <h3 id="summary-follow-up-title" className="text-sm font-semibold text-gray-900">Seguimiento</h3>
              <p className="mt-2 text-sm font-medium text-gray-700">{getFollowUpLabel(currentTreatment)}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-600">
                {getTreatmentFollowUp(currentTreatment).observations || 'Sin hallazgos de seguimiento registrados.'}
              </p>
            </section>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-gray-100 p-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setSummaryOpen(false)}
            className="admin-focus-ring min-h-11 rounded-xl border border-gray-200 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cerrar
          </button>
          <button
            type="button"
            onClick={() => { setSummaryOpen(false); setActiveStep(1); }}
            className="admin-focus-ring min-h-11 rounded-xl bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gold-ink"
          >
            Editar tratamiento
          </button>
        </div>
      </div>
    </Dialog>
    <CrossConsultHistoryModal
      isOpen={crossHistOpen}
      onClose={() => setCrossHistOpen(false)}
      tabLabel="Tratamientos"
      consultations={consultations}
      items={modeTreatments}
      currentConsultationId={consultationId}
      renderItem={t => (
        <div>
          <p className="font-medium text-gray-800">{t.procedure_name}</p>
          <p className="text-gray-400">{t.date ? new Date(toDateOnly(t.date) + 'T12:00:00').toLocaleDateString('es-EC') : ''}{t.equipment_used ? ` — ${t.equipment_used}` : ''}</p>
        </div>
      )}
      renderDetail={t => (
        <>
          <div><span className="text-gray-400">Procedimiento:</span> <span className="font-medium">{t.procedure_name}</span></div>
          {t.equipment_used && <div><span className="text-gray-400">Equipo:</span> {t.equipment_used}</div>}
          {t.area_treated && <div><span className="text-gray-400">Área:</span> {t.area_treated}</div>}
          {t.duration_minutes > 0 && <div><span className="text-gray-400">Duración:</span> {t.duration_minutes} min</div>}
          {t.cost > 0 && <div><span className="text-gray-400">Costo:</span> ${t.cost}</div>}
          {t.notes && <div><span className="text-gray-400">Notas:</span> {t.notes}</div>}
          <div><span className="text-gray-400">Seguimiento:</span> {getFollowUpLabel(t)}</div>
          <div>{describeTreatmentAssessment(t, mode)}</div>
          {t.date && <div><span className="text-gray-400">Fecha:</span> {new Date(toDateOnly(t.date) + 'T12:00:00').toLocaleDateString('es-EC')}</div>}
        </>
      )}
    />
    {notesModalOpen && (
      <Dialog open onClose={() => setNotesModalOpen(false)} labelledBy="record-observations-title">
        <div className="max-h-[80dvh] w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-lg bg-white shadow-xl">
          <div className="flex items-center justify-between p-4 border-b border-gray-100">
            <h3 id="record-observations-title" className="font-semibold text-gray-800 flex items-center gap-2"><Eye className="w-5 h-5 text-teal-600" /> Observaciones del expediente</h3>
            <button onClick={() => setNotesModalOpen(false)} className="admin-focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-gray-100" aria-label="Cerrar observaciones"><X className="w-5 h-5 text-gray-500" /></button>
          </div>
          <div className="overflow-y-auto max-h-[calc(80vh-60px)] p-4 space-y-4">
            {consultations.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">Sin consultas registradas</p>
            ) : (
              consultations
                .slice()
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map(consult => {
                  const ts = modeTreatments.filter(t => Number(t.consultation_id) === Number(consult.id) && t.notes?.trim());
                  return (
                    <div key={consult.id} className="border border-gray-100 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 px-4 py-2 flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-[#deb887]" />
                        <span className="text-sm font-medium text-gray-700">{new Date(toDateOnly(consult.created_at) + 'T12:00:00').toLocaleDateString('es-EC', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                      </div>
                      {ts.length === 0 ? (
                        <p className="text-gray-300 text-xs px-4 py-3">Sin observaciones en esta consulta</p>
                      ) : ts.map((t, i) => (
                        <div key={t.id ?? i} className="px-4 py-3 border-t border-gray-50">
                          <p className="text-xs font-semibold text-gray-600 mb-1">{t.procedure_name}</p>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap">{t.notes}</p>
                        </div>
                      ))}
                    </div>
                  );
                })
            )}
          </div>
        </div>
      </Dialog>
    )}
    <TreatmentParametersModal
      isOpen={paramsModalOpen}
      onClose={() => setParamsModalOpen(false)}
      equipmentName={editingEquipmentName}
      procedureName={currentTreatment.procedure_name}
      initialParams={currentTreatment.parameters?.[editingEquipmentName] as TreatmentParameters | undefined}
      onSave={handleSaveEquipmentParams}
    />
    {packageModalOpen && (
      <TreatmentPackageModal
        recordId={recordId}
        consultationId={consultationId}
        patientName={patientName}
        mode={mode}
        onClose={() => setPackageModalOpen(false)}
        onCreated={(pkg) => {
          setPackages(prev => [pkg, ...prev]);
          setCurrentTreatment(prev => ({ ...prev, package_id: pkg.id ?? null }));
          setMessage({
            type: 'success',
            text: Number(pkg.initial_payment) > 0
              ? 'Paquete creado; el abono se procesó según la opción seleccionada'
              : 'Paquete creado correctamente',
          });
          setPackageModalOpen(false);
        }}
      />
    )}
    <ClinicalDataModal
      isOpen={clinicalDataModalOpen}
      mode={mode}
      initialData={currentTreatment.parameters?.[RESERVED_PARAM_KEYS[mode]] as PostCareData | AnthropometricsData | ScalpAssessmentData | undefined}
      onClose={() => setClinicalDataModalOpen(false)}
      onSave={handleSaveClinicalData}
    />
    <ConfirmationDialog
      open={confirmation === 'package-save'}
      title={currentTreatment.id ? 'Actualizar sesión del paquete' : 'Guardar sesión en el paquete'}
      description={<>La sesión quedará vinculada a <strong>{selectedPackage?.name}</strong>.</>}
      detail={
        <div className="flex items-center justify-between gap-4">
          <span>Abono de esta sesión</span>
          <strong className="tabular-nums">${(Number(currentTreatment.cost) || 0).toFixed(2)}</strong>
        </div>
      }
      confirmLabel={currentTreatment.id ? 'Actualizar sesión' : 'Guardar en el paquete'}
      busy={saving}
      onClose={() => setConfirmation(null)}
      onConfirm={() => void handleSave(true)}
    />
    <ConfirmationDialog
      open={confirmation === 'delete'}
      variant="danger"
      title="Eliminar sesión de tratamiento"
      description={selectedPackage
        ? <>Se eliminará esta sesión del paquete <strong>{selectedPackage.name}</strong>.</>
        : 'Se eliminará esta sesión independiente.'}
      detail="Si existe un cobro asociado, también se eliminarán el registro y sus partidas en Finanzas."
      confirmLabel="Eliminar sesión"
      busy={deleting}
      onClose={() => setConfirmation(null)}
      onConfirm={() => void handleDelete(true)}
    />
    </>
  );
}
