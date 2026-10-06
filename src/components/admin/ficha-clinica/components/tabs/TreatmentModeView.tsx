import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Calendar, DollarSign, Clock, Save, Trash2, Copy, Check, AlertCircle, FileText, Pencil, Layers, History, Eye, X, ChevronDown, ChevronRight, Sparkles, Wrench, Package, Wallet, ClipboardList } from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import TreatmentParametersModal, { type TreatmentParameters, formatParametersAsText, upsertNotesBlock, removeNotesBlock } from './TreatmentParametersModal';
import TreatmentPackageModal from './TreatmentPackageModal';
import ClinicalDataModal from './ClinicalDataModal';
import Clinical3DViewer from '../Clinical3DViewer';
import type { Marker3D } from '../Clinical3DViewer';
import { useAuth } from '../../../../../context/AuthContext';
import treatmentOptions from '../../data/treatment_options.json';
import { Tooltip } from '../../../../ui/Tooltip';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';
import { Dialog } from '../../../../ui/Dialog';
import { useTreatmentGrouping } from '../../hooks/useTreatmentGrouping';
import {
  type Treatment, type TreatmentMode, type TreatmentPackage,
  type PostCareData, type AnthropometricsData, type ScalpAssessmentData,
  getPackageDebt, getPackagePaidTotal, getAreaMarkers, RESERVED_PARAM_KEYS,
} from '../../types/treatment';

/** Zonas sugeridas por modo (chips clickeables para etiquetar cada marcación anatómica) */
const ZONE_CHIPS_BY_MODE: Record<TreatmentMode, string[]> = {
  facial: treatmentOptions.procedures.facial,
  corporal: treatmentOptions.procedures.corporal,
  capilar: (treatmentOptions.procedures as Record<string, string[]>).capilar || [],
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
  return `${d.scale === 'norwood' ? 'Norwood' : 'Ludwig'} ${d.stage ?? ''} · ${d.density ?? 'sin densidad'}`;
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
        <div className="rounded-xl border border-dashed border-gold-300 bg-gold-50/50 p-4 text-center">
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
            {scalp.scale ? `${scalp.scale === 'norwood' ? 'Norwood' : 'Ludwig'} ${scalp.stage || ''}` : 'Sin clasificar'}
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
    <aside className="admin-surface h-fit p-4 xl:sticky xl:top-4">
      <div className="mb-4">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gold-50 text-gold-ink">
          <ClipboardList className="h-5 w-5" aria-hidden="true" />
        </span>
        <h3 className="font-semibold text-gray-900">{titles[mode][0]}</h3>
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

// Sugerencias de equipos: nombres de marcas/modelos ya catalogados por tipo de aparatología
const EQUIPMENT_SUGGESTIONS: string[] = [
  ...Object.entries(treatmentOptions.procedures)
    .filter(([key]) => /^(equipos_|tips_|handpieces|aplicadores_|transductores_)/.test(key))
    .flatMap(([, arr]) => arr as string[]),
  ...treatmentOptions.equipment,
];

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
export default function TreatmentModeView({ mode, modelUrl, recordId, treatments, consultationId, consultations = [], onSave }: TreatmentModeViewProps) {
  const { hasFeature } = useAuth();
  const [currentTreatment, setCurrentTreatment] = useState<Treatment>(makeEmptyTreatment(mode));
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [groupByProcedure, setGroupByProcedure] = useState(true);
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const [notesModalOpen, setNotesModalOpen] = useState(false);
  const [paramsModalOpen, setParamsModalOpen] = useState(false);
  const [clinicalDataModalOpen, setClinicalDataModalOpen] = useState(false);
  const [editingEquipmentName, setEditingEquipmentName] = useState('');
  // Zona activa seleccionada en los chips, aplicada a la próxima marcación que se coloque en el visor 3D
  const [activeZoneChip, setActiveZoneChip] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  // ponytail: string state to allow empty field and comma-as-decimal-separator
  const [costInput, setCostInput] = useState('');
  const messageRef = useRef<HTMLDivElement>(null);

  // ── Paquetes ─────────────────────────────────────────────────────────────
  const [packages, setPackages] = useState<TreatmentPackage[]>([]);
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [expandedPackages, setExpandedPackages] = useState<Set<number>>(new Set());

  const loadPackages = useCallback(async () => {
    try {
      const response = await recordsFetch(`/api/records?action=listPackagesByRecord&record_id=${recordId}&treatment_mode=${mode}`);
      if (response.ok) setPackages(await response.json());
    } catch (error) {
      console.error('Error loading treatment packages:', error);
    }
  }, [recordId, mode]);

  useEffect(() => { loadPackages(); }, [loadPackages]);

  // Solo los tratamientos de este modo (el historial previo a la migración ya quedó asignado a 'facial')
  const modeTreatments = useMemo(
    () => treatments.filter(t => (t.treatment_mode || 'facial') === mode),
    [treatments, mode]
  );

  // Sort treatments by date descending for the history list
  const sortedTreatments = [...modeTreatments]
    .filter(t => Number(t.consultation_id) === Number(consultationId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const otherTreatCount = modeTreatments.filter(t => Number(t.consultation_id) !== Number(consultationId)).length;

  const independentSessions = sortedTreatments.filter(t => !t.package_id);
  const { groups: procedureGroups, expandedGroups, toggleGroup, expandGroup } = useTreatmentGrouping(
    independentSessions,
    t => t.procedure_name
  );

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNew = () => {
    setCurrentTreatment(makeEmptyTreatment(mode));
    setCostInput('');
    setDateLocked(false);
    setMessage(null);
    setActiveZoneChip(null);
  };

  const handleSelect = (treatment: Treatment) => {
    setCurrentTreatment({ ...treatment, date: toDateOnly(treatment.date) });
    setCostInput(treatment.cost > 0 ? String(treatment.cost) : '');
    setDateLocked(true);
    setMessage(null);
    setActiveZoneChip(null);
  };

  const togglePackageExpand = (id: number) => setExpandedPackages(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const action = currentTreatment.id ? 'updateTreatment' : 'addTreatment';
      const body = {
        record_id: recordId,
        ...currentTreatment,
        ...(consultationId ? { consultation_id: consultationId } : {})
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
      setMessage({ type: 'success', text: 'Tratamiento guardado correctamente' });
    } catch (error) {
      console.error('Error saving treatment:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al guardar el tratamiento' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentTreatment.id || !confirm('¿Eliminar este tratamiento?')) return;
    setDeleting(true);
    try {
      const response = await recordsFetch(`/api/records?action=deleteTreatment&id=${currentTreatment.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        onSave();
        if (currentTreatment.package_id) loadPackages();
        handleNew();
        setMessage({ type: 'success', text: 'Tratamiento eliminado correctamente' });
      } else {
        throw new Error('Error al eliminar');
      }
    } catch (error) {
      console.error('Error deleting:', error);
      setMessage({ type: 'error', text: 'Error al eliminar el tratamiento' });
    } finally {
      setDeleting(false);
    }
  };

  /** Duplica el tratamiento actual: lo guarda de inmediato como una nueva sesión (nuevo id) y la selecciona/resalta en el historial */
  const handleDuplicate = async () => {
    if (!currentTreatment.id) return;
    const rest = { ...currentTreatment };
    delete rest.id;
    setDuplicating(true);
    setMessage(null);
    try {
      const body = {
        record_id: recordId,
        ...rest,
        date: getLocalDate(),
        ...(consultationId ? { consultation_id: consultationId } : {}),
      };
      const response = await recordsFetch('/api/records?action=addTreatment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(resBody?.error || `Error al duplicar (HTTP ${response.status})`);
      }

      onSave();
      if (rest.package_id) loadPackages();
      const newTreatment: Treatment = { ...resBody, date: toDateOnly(resBody.date) };
      setCurrentTreatment(newTreatment);
      setCostInput(newTreatment.cost > 0 ? String(newTreatment.cost) : '');
      setDateLocked(false);
      if (groupByProcedure && !newTreatment.package_id) {
        expandGroup((newTreatment.procedure_name || 'Sin procedimiento').trim().toLowerCase());
      }
      setHighlightedId(newTreatment.id ?? null);
      setTimeout(() => setHighlightedId(null), 2500);
      setMessage({ type: 'success', text: 'Tratamiento duplicado y guardado como nueva sesión. Ajusta la fecha u otros datos y guarda los cambios.' });
    } catch (error) {
      console.error('Error duplicating treatment:', error);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al duplicar el tratamiento' });
    } finally {
      setDuplicating(false);
    }
  };

  const equipmentNames = parseEquipmentNames(currentTreatment.equipment_used);

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
      area_marker: [...getAreaMarkers(prev), { ...marker, zone: activeZoneChip || marker.zone }],
    }));
  };

  const handleRemoveMarker = (markerId: string | undefined) => {
    setCurrentTreatment(prev => ({ ...prev, area_marker: getAreaMarkers(prev).filter(m => m.id !== markerId) }));
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
      className="grid grid-cols-1 gap-5 xl:grid-cols-[15rem_minmax(0,1fr)_19rem]"
    >
      {/* Sidebar List */}
      <div className="admin-surface flex max-h-[36rem] w-full flex-col gap-4 border-b border-gray-100 p-4 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-12rem)]">
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
      <div className="relative flex min-w-0 flex-col gap-5 overflow-visible">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm sticky top-0 z-10">
          <div className="flex gap-2 items-center">
            <Tooltip content="Nuevo Tratamiento">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleNew}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Plus className="w-5 h-5" />
              </motion.button>
            </Tooltip>

            <Tooltip content="Guardar">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSave}
                disabled={saving}
                className="p-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] shadow-lg shadow-[#deb887]/20 disabled:opacity-70"
              >
                {saving ? <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> : <Save className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Duplicar como nueva sesión">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate}
                disabled={!currentTreatment.id || duplicating}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 disabled:opacity-50"
              >
                {duplicating ? <div className="animate-spin w-5 h-5 border-2 border-gray-300 border-t-gray-500 rounded-full" /> : <Copy className="w-5 h-5" />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete}
                disabled={!currentTreatment.id || deleting}
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

        {/* Form Fields */}
        <div className="bg-white p-6 rounded-xl border border-gray-100 shadow-sm space-y-6 overflow-y-auto custom-scrollbar">
          {/* Visor 3D de marcación anatómica (múltiples zonas por sesión) */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Marcación Anatómica (referencial)</label>
            <p className="text-xs text-gray-400">Selecciona una zona y luego haz clic en el modelo para marcarla. Puedes agregar varias.</p>
            <div className="flex flex-wrap gap-1.5">
              {(ZONE_CHIPS_BY_MODE[mode] || []).map(zone => (
                <button
                  key={zone}
                  type="button"
                  onClick={() => setActiveZoneChip(prev => prev === zone ? null : zone)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${activeZoneChip === zone ? 'bg-[#deb887] text-white border-[#deb887]' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {zone}
                </button>
              ))}
            </div>
            <div className="relative overflow-hidden rounded-2xl border border-gray-100 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.8)]" style={{ height: '360px' }}>
              <Clinical3DViewer
                markers={getAreaMarkers(currentTreatment)}
                selectedPathology="lesion"
                modelUrl={modelUrl}
                cameraPreset={mode === 'capilar' ? 'scalp' : mode === 'corporal' ? 'body' : 'face'}
                skipConfirmation={true}
                onMarkerPlaced={handleMarkerPlaced}
                height="360px"
                pointMarkerScale={0.6}
              />
              {getAreaMarkers(currentTreatment).length > 0 && (
                <button
                  type="button"
                  onClick={() => setCurrentTreatment(prev => ({ ...prev, area_marker: null }))}
                  className="absolute top-2 right-2 z-10 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-900/65 text-white hover:bg-gray-900/90 transition-colors border border-white/15 backdrop-blur-sm"
                >
                  <X size={12} /> Quitar todas
                </button>
              )}
            </div>
            {getAreaMarkers(currentTreatment).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {getAreaMarkers(currentTreatment).map(m => (
                  <span key={m.id} className="flex items-center gap-1 text-[11px] bg-[#deb887]/10 text-[#b8944d] rounded-full px-2 py-0.5">
                    {m.zone || 'Sin zona'}
                    <button type="button" onClick={() => handleRemoveMarker(m.id)} className="hover:text-red-600"><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Fecha</label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
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
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Procedimiento<FieldHelp text={HELP.treatment.procedure_name} /></label>
              <input
                type="text"
                required
                list="procedures-list"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.procedure_name}
                onChange={e => setCurrentTreatment({ ...currentTreatment, procedure_name: e.target.value })}
                placeholder="Ej: Limpieza Facial Profunda"
              />
              <datalist id="procedures-list">
                {Object.values(treatmentOptions.procedures).flat().map((p: string, i: number) => (
                  <option key={i} value={p} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">
                Paquete <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <select
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
                <p className="text-[11px] text-amber-600 flex items-center gap-1 bg-amber-50 px-2.5 py-1 rounded-lg border border-amber-100">
                  <Wallet size={11} /> El campo "Costo" de esta sesión se registrará como abono al paquete.
                </p>
              )}
            </div>
            <div className="space-y-2">
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
                  placeholder="Ej: Nd:YAG 1064nm, Hydrafacial..."
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
                {EQUIPMENT_SUGGESTIONS.map((e: string, i: number) => (
                  <option key={i} value={e} />
                ))}
              </datalist>
              <p className="text-[11px] text-gray-400">Puedes escribir varios equipos separados por coma. El botón "Añadir" es opcional y solo registra parámetros detallados en "Notas".</p>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Zona Tratada<FieldHelp text={HELP.treatment.area_treated} /></label>
              <input
                type="text"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={currentTreatment.area_treated}
                onChange={e => setCurrentTreatment({ ...currentTreatment, area_treated: e.target.value })}
                placeholder="Ej: Rostro completo"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">Duración (min)<FieldHelp text={HELP.treatment.duration_minutes} /></label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
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
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Notas / Parámetros<FieldHelp text={HELP.treatment.notes} /></label>
            <textarea
              rows={5}
              className="w-full p-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={currentTreatment.notes}
              onChange={e => setCurrentTreatment({ ...currentTreatment, notes: e.target.value })}
              placeholder="Detalles de la sesión, parámetros del equipo..."
            />
          </div>

        </div>
      </div>

      <ClinicalSummaryPanel
        mode={mode}
        data={currentTreatment.parameters?.[RESERVED_PARAM_KEYS[mode]] as PostCareData | AnthropometricsData | ScalpAssessmentData | undefined}
        onEdit={() => setClinicalDataModalOpen(true)}
      />
    </motion.div>
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
        mode={mode}
        onClose={() => setPackageModalOpen(false)}
        onCreated={(pkg) => {
          setPackages(prev => [pkg, ...prev]);
          setCurrentTreatment(prev => ({ ...prev, package_id: pkg.id ?? null }));
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
    </>
  );
}
