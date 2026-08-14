import { useState, useEffect, useRef, useCallback } from 'react';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import {
  Droplets, Plus, Save, Trash2, Printer, Copy,
  ChevronDown, ChevronUp, Box, Calendar,
  FlaskConical, Crosshair, X, Check, Info, Images, Minus, Eye, EyeOff, Pencil, AlertCircle, Undo2,
  PenLine, Pentagon, Circle, Square, Pipette, History
} from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import { Tooltip } from '../../../../ui/Tooltip';
import injectablesCatalog from '../../data/injectables.json';
import Clinical3DViewer, { Marker3D, EditablePoint, FreehandLine, SurfaceShape, DrawingTool } from '../Clinical3DViewer';
import type { ReferenceLine, LineType, ProjectedPosition } from '../Clinical3DViewer';
import InjectableCaptureModal, { CaptureImage } from '../InjectableCaptureModal';
import ReferenceLinePanel from '../ReferenceLinePanel';
import type { LinePreset } from '../ReferenceLinePanel';
import trazadoSuperior from '../../data/trazado-referencia-superior.json';
import { useClinicSettings } from '../../../../../hooks/useClinicSettings';
import { useAuth } from '../../../../../context/AuthContext';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';

// ==========================================
// TYPES
// ==========================================

type RellenoSubType = 'relleno_ha' | 'hidratacion' | 'bioestimulador';

const RELLENO_SUBTYPE_LABELS: Record<RellenoSubType, string> = {
  relleno_ha: 'Relleno HA',
  hidratacion: 'Hidratación',
  bioestimulador: 'Bioestimuladores',
};

const RELLENO_SUBTYPE_COLORS: Record<RellenoSubType, { active: string; hover: string; badge: string; header: string; border: string; text: string }> = {
  relleno_ha:    { active: 'bg-white text-purple-600 shadow-md ring-1 ring-purple-300/40',  hover: 'text-gray-500 hover:text-gray-700 hover:bg-white/50', badge: 'bg-purple-100 text-purple-600',  header: 'from-purple-50  to-purple-50/30  border-purple-100',  border: 'border-purple-100', text: 'text-purple-700' },
  hidratacion:   { active: 'bg-white text-sky-600 shadow-md ring-1 ring-sky-300/40',       hover: 'text-gray-500 hover:text-gray-700 hover:bg-white/50', badge: 'bg-sky-100 text-sky-600',       header: 'from-sky-50     to-sky-50/30     border-sky-100',     border: 'border-sky-100',    text: 'text-sky-700'    },
  bioestimulador:{ active: 'bg-white text-emerald-600 shadow-md ring-1 ring-emerald-300/40',hover: 'text-gray-500 hover:text-gray-700 hover:bg-white/50', badge: 'bg-emerald-100 text-emerald-600',header: 'from-emerald-50 to-emerald-50/30 border-emerald-100', border: 'border-emerald-100', text: 'text-emerald-700'},
};

interface Injectable {
  id?: number;
  record_id?: number;
  treatment_id?: number;
  date: string;
  product_type: 'toxina' | 'relleno';
  relleno_subtype?: string;
  product_name: string;
  brand: string;
  lot_number: string;
  expiration_date: string;
  volume_used: number | string;
  units_used: number | string;
  areas_treated: any;
  technique: string;
  injection_plane: string;
  needle_type: string;
  mapping_data: any;
  notes: string;
  dilution_volume: number | string;
  follow_up_date: string;
}

/** Jeringa / vial de relleno HA dentro de una sesión */
interface HaVial {
  id: string;
  product_name: string;
  brand: string;
  lot_number: string;
  expiration_date: string;
  volume_ml: number;  // total del vial
  color: string;
}

interface InjectionPoint extends Marker3D {
  tercio: 'superior' | 'medio' | 'inferior' | '';
  units: number;
  label: string;
  editablePointId?: string;
  injection_plane?: string;
  technique_at_point?: string;
  needle_at_point?: string;    // cánula/aguja usada en este punto
  notes_at_point?: string;     // observación específica del punto
  vial_id?: string;            // ID del vial HA activo al momento de marcar
}

interface InjectablesTabProps {
  recordId: number;
  injectables: Injectable[];
  patientName?: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

// ==========================================
// HELPERS — catalog lookups
// ==========================================

const getCatalogItems = (category: string): string[] => {
  return injectablesCatalog
    .filter((item: any) => item.categoria === category && item.activo === 1)
    .map((item: any) => item.elemento);
};

const toxinaBrands = getCatalogItems('marca_toxina');
const rellenoBrands = getCatalogItems('marca_relleno');
const rellenoHaBrands = getCatalogItems('marca_relleno_ha');
const hidratacionBrands = getCatalogItems('marca_hidratacion');
const bioestimuladorBrands = getCatalogItems('marca_bioestimulador');
const techniques = getCatalogItems('tecnica_inyectable');
const needles = getCatalogItems('aguja_inyectable');
const zonasSuperior = getCatalogItems('tercio_superior');
const zonasMedia = getCatalogItems('tercio_medio');
const zonasInferior = getCatalogItems('tercio_inferior');

const TERCIO_ZONES: Record<string, string[]> = {
  superior: zonasSuperior,
  medio: zonasMedia,
  inferior: zonasInferior,
};

// Todas las zonas unificadas para HA (lista plana, buscable)
const ALL_HA_ZONES = [
  ...zonasSuperior.map(z => ({ z, area: 'superior' as const })),
  ...zonasMedia.map(z => ({ z, area: 'medio' as const })),
  ...zonasInferior.map(z => ({ z, area: 'inferior' as const })),
];

const HA_PLANES = ['Dérmico superficial', 'Dérmico medio', 'Dérmico profundo', 'Subcutáneo', 'Supraperióstico'];

/** Paleta fija de colores para diferenciar viales en el visor 3D */
const VIAL_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444'];
const getVialColor = (index: number) => VIAL_COLORS[index % VIAL_COLORS.length];

const TERCIO_COLORS: Record<string, { bg: string; border: string; text: string; badge: string; header: string }> = {
  superior: { bg: 'bg-[#deb887]/10', border: 'border-[#deb887]/40', text: 'text-[#b8944d]', badge: 'bg-[#deb887]/20 text-[#b8944d]', header: 'bg-[#deb887]/15 border-[#deb887]/30' },
  medio: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800', header: 'bg-amber-100 border-amber-300' },
  inferior: { bg: 'bg-stone-50', border: 'border-stone-200', text: 'text-stone-600', badge: 'bg-stone-100 text-stone-700', header: 'bg-stone-100 border-stone-300' },
};

const TERCIO_LABELS: Record<string, string> = {
  superior: 'Tercio Superior',
  medio: 'Tercio Medio',
  inferior: 'Tercio Inferior',
};

/** Normalize ISO datetime or date string to YYYY-MM-DD for input[type="date"] */
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

const EMPTY_INJECTABLE: Injectable = {
  date: getLocalDate(),
  product_type: 'toxina',
  product_name: '',
  brand: '',
  lot_number: '',
  expiration_date: '',
  volume_used: '',
  units_used: '',
  areas_treated: [],
  technique: '',
  injection_plane: '',
  needle_type: '',
  mapping_data: null,
  notes: '',
  dilution_volume: '',
  follow_up_date: '',
};

// ==========================================
// COMPONENT
// ==========================================

export default function InjectablesTab({ recordId, injectables: initialInjectables, patientName, consultationId, consultations = [], onSave }: InjectablesTabProps) {
  const { settings: clinic } = useClinicSettings();
  const { user } = useAuth();
  // Nombre de la clínica: settings > auth token > placeholder
  const clinicDisplayName = clinic.general.name || user?.clinic_name || 'Clínica';
  // Sub-tab activo: controla qué tipo de inyectable se muestra en sidebar + formulario
  const [activeType, setActiveType] = useState<'toxina' | 'relleno'>('toxina');
  const [injectables, setInjectables] = useState<Injectable[]>([]);
  const [current, setCurrent] = useState<Injectable>({ ...EMPTY_INJECTABLE });
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const [markers3D, setMarkers3D] = useState<Marker3D[]>([]);
  const [injectionPoints, setInjectionPoints] = useState<InjectionPoint[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);

  // Capture panel states
  const [captureModalOpen, setCaptureModalOpen] = useState(false);
  /** Alerta para capturas/impresión: 'capture-save-first' | 'print-no-captures' | null */
  const [captureAlert, setCaptureAlert] = useState<'capture-save-first' | 'print-no-captures' | null>(null);
  const [capturedImages, setCapturedImages] = useState<CaptureImage[]>([]);

  // Dialog states
  const [pendingFreePoint, setPendingFreePoint] = useState<Marker3D | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);

  // ── Límites de tercios (cargados desde JSON de referencia) ────────────
  // Se inicializa directamente desde el JSON estático para que la auto-detección
  // funcione sin necesidad de que el usuario haga clic en "Cargar Trazado".
  const [tercioBoundaries, setTercioBoundaries] = useState<{
    topY: number; bottomY: number; tercioMedioBottomY: number; tercioInferiorBottomY: number;
  } | null>(() => {
    const h = (trazadoSuperior as any).hairline;
    if (!h) return null;
    return {
      topY:                  h.topY                  ?? 1.9,
      bottomY:               h.bottomY               ?? 0.6,
      tercioMedioBottomY:    h.tercioMedioBottomY    ?? 0.1,
      tercioInferiorBottomY: h.tercioInferiorBottomY ?? -1,
    };
  });

  // ── Líneas de referencia ────────────────────────────────────────────────
  /** Panel de gestión de líneas: oculto por defecto, se abre bajo demanda */
  const [showLinePanel, setShowLinePanel] = useState(false);
  const [referenceLines, setReferenceLines] = useState<ReferenceLine[]>([]);
  const [activeLineType, setActiveLineType] = useState<LineType | null>(null);
  const [pendingLineMeta, setPendingLineMeta] = useState<{ label: string; color: string; preset?: LinePreset } | null>(null);
  // Para two-points: guarda el primer punto mientras se espera el segundo
  const [firstLineAnchor, setFirstLineAnchor] = useState<{ x: number; y: number; z: number } | null>(null);
  // Paso del diálogo two-points: 0=inactivo 1=esperando 1er punto 2=esperando 2do punto
  const [twoPointStep, setTwoPointStep] = useState<0 | 1 | 2>(0);

  // ── Puntos editables (trazado de referencia) ──────────────────────────
  const [editablePoints, setEditablePoints] = useState<EditablePoint[]>([]);
  const [showEditablePoints, setShowEditablePoints] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [showBoundaryLines, setShowBoundaryLines] = useState(true);
  const [showVisibilityDropdown, setShowVisibilityDropdown] = useState(false);
  const [refJsonLoaded, setRefJsonLoaded] = useState(false);
  const [pointMode, setPointMode] = useState<'none' | 'add' | 'delete'>('none');
  // Modal de unidades para puntos del trazado
  const [unitsModal, setUnitsModal] = useState<{
    open: boolean;
    pointId: string;
    pointName: string;
    existingUnits: number;
    isNewPoint?: boolean;
  } | null>(null);
  const [unitsModalInput, setUnitsModalInput] = useState('');
  // Multi-step states for trazado point modal
  const [unitsModalStep, setUnitsModalStep] = useState<1 | 2 | 3 | 4>(1);
  const [unitsModalTercio, setUnitsModalTercio] = useState<'superior' | 'medio' | 'inferior' | ''>('');
  const [unitsModalZone, setUnitsModalZone] = useState('');
  const [unitsModalZoneFilter, setUnitsModalZoneFilter] = useState('');
  const [unitsModalPlane, setUnitsModalPlane] = useState('');
  const [unitsModalTecnica, setUnitsModalTecnica] = useState(''); // HA: técnica puntual
  const [, setDialogPlane] = useState('');
  // Undo stack: snapshots of {injectionPoints, markers3D, editablePoints} before each mutation
  const [undoStack, setUndoStack] = useState<Array<{
    injectionPoints: InjectionPoint[];
    markers3D: Marker3D[];
    editablePoints: EditablePoint[];
  }>>([]);
  // Clear-points confirmation state
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // Unit numbers overlay
  const [showUnitNumbers, setShowUnitNumbers] = useState(true);
  const showUnitNumbersRef = useRef(true);
  const unitOverlayRef = useRef<HTMLDivElement>(null);
  // Timer ref to push undo only once per drag gesture on point-move
  const moveUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while the form holds an unsaved duplicate (shows pending card in sidebar)
  const [isPendingDuplicate, setIsPendingDuplicate] = useState(false);

  /** Punto editable sobre el que está el cursor (sin herramienta activa) */
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
  /** Dropdown de formas agrupadas en la toolbar */
  const [showShapesDropdown, setShowShapesDropdown] = useState(false);
  const [showHaShapesDropdown, setShowHaShapesDropdown] = useState(false);
  /** Selección masiva de puntos para aplicar técnica/cánula/plano */
  const [bulkApplyMode, setBulkApplyMode] = useState(false);
  const [bulkApplySourceIdx, setBulkApplySourceIdx] = useState<number | null>(null);
  const [bulkApplySelected, setBulkApplySelected] = useState<Set<string>>(new Set());

  // ── Herramientas de dibujo libre (HA) ────────────────────────────────────
  const [freehandLines, setFreehandLines] = useState<FreehandLine[]>([]);
  const [surfaceShapes, setSurfaceShapes] = useState<SurfaceShape[]>([]);
  const [activeTool, setActiveTool] = useState<DrawingTool>('none');
  const [brushColor, setBrushColor] = useState('#8b5cf6');
  const [brushThickness, setBrushThickness] = useState(1.0);
  // Elemento seleccionado en el visor 3D para editar propiedades
  const [selectedElement, setSelectedElement] = useState<{
    id: string;
    type: 'reference-line' | 'freehand' | 'shape';
  } | null>(null);

  // ── Multi-vial (HA) ────────────────────────────────────────────────────
  const [haVials, setHaVials] = useState<HaVial[]>([]);
  const [activeVialId, setActiveVialId] = useState<string | null>(null);
  // ── Sidebar edición inline de puntos ──────────────────────────────────
  const [expandedPointId, setExpandedPointId] = useState<string | null>(null);
  // ── Modal configuración de formas HA ──────────────────────────────────
  const [haShapeConfig, setHaShapeConfig] = useState({ fanLines: 5, fanAngle: 25, gridCells: 4, fernBranches: 5 });
  const [haShapeConfigOpen, setHaShapeConfigOpen] = useState(false);
  const [haShapeConfigTool, setHaShapeConfigTool] = useState<'ha-fan' | 'ha-grid' | 'ha-fern'>('ha-fan');
  /** Tab al que el usuario intenta cambiar; null = ningún switch pendiente */
  const [pendingTabSwitch, setPendingTabSwitch] = useState<'toxina' | 'relleno' | null>(null);
  /** Sub-tipo activo dentro del tab Relleno */
  const [rellenoSubType, setRellenoSubType] = useState<RellenoSubType>('relleno_ha');
  /** Sub-tipo al que el usuario intenta cambiar (con trabajo sin guardar) */
  const [pendingSubTypeSwitch, setPendingSubTypeSwitch] = useState<RellenoSubType | null>(null);
  /** Catálogo extra cargado desde la DB (master admin seeds) */
  const [dbCatalog, setDbCatalog] = useState<{ categoria: string; elemento: string }[]>([]);
  /** Quick Save HA: true mientras se está seleccionando/creando la jeringa */
  const [unitsModalVialStep, setUnitsModalVialStep] = useState(false);
  /** Quick Save HA: mini-form inline para registrar una nueva jeringa */
  const [inlineVialForm, setInlineVialForm] = useState<{ open: boolean; name: string; vol: string }>({ open: false, name: '', vol: '' });
  /** Paso actual del dibujo de malla (0=inactivo, 1=ancho, 2=largo) */
  const [gridDrawStep, setGridDrawStep] = useState(0);
  /** Punto snap activo del imán (null = sin snap) */
  const [snapPoint, setSnapPoint] = useState<{ x: number; y: number; z: number } | null>(null);

  // Keep ref in sync with state to avoid closure issues in the RAF callback
  useEffect(() => { showUnitNumbersRef.current = showUnitNumbers; }, [showUnitNumbers]);

  // Fetch extra catalog items managed by master admin (non-blocking)
  useEffect(() => {
    recordsFetch('/api/records?action=listInjectableCatalog')
      .then(r => r.ok ? r.json() : [])
      .then(data => setDbCatalog(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Projected positions callback — uses direct DOM manipulation for 60fps perf
  const handleProjectedPositions = useCallback((positions: ProjectedPosition[]) => {
    const overlay = unitOverlayRef.current;
    if (!overlay) return;
    positions.forEach(({ id, x, y }) => {
      if (id === '__zoom__') {
        // x = camera distance; derive a clamped font size so numbers scale with zoom
        const REF_DIST = 12;   // default camera distance
        const BASE_PX = 9;     // font size at reference distance
        const MIN_PX = 7;      // minimum (very zoomed out)
        const MAX_PX = 15;     // maximum (very zoomed in)
        const raw = BASE_PX * REF_DIST / Math.max(x, 0.1);
        const clamped = Math.max(MIN_PX, Math.min(MAX_PX, raw));
        overlay.style.setProperty('--unit-font-size', `${clamped.toFixed(1)}px`);
        return;
      }
      const el = overlay.querySelector(`[data-pid="${id}"]`) as HTMLElement | null;
      if (el) el.style.transform = `translate(${Math.round(x + 5)}px, ${Math.round(y - 12)}px)`;
    });
  }, []);

  // Sync from parent props
  useEffect(() => {
    const sorted = [...initialInjectables].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    setInjectables(sorted);
  }, [initialInjectables]);

  // Load mapping data when selecting an existing injectable
  useEffect(() => {
    if (current.mapping_data) {
      try {
        const parsed = typeof current.mapping_data === 'string'
          ? JSON.parse(current.mapping_data)
          : current.mapping_data;

        // Formato nuevo: { injectionPoints: [...], referenceLines: [...] }
        // Formato legacy: [...InjectionPoint[]]
        let rawPoints: any[] = [];
        let rawLines: any[] = [];

        if (Array.isArray(parsed)) {
          // Legacy: solo array de injection points
          rawPoints = parsed;
        } else if (parsed && typeof parsed === 'object') {
          rawPoints = Array.isArray(parsed.injectionPoints) ? parsed.injectionPoints : [];
          rawLines = Array.isArray(parsed.referenceLines) ? parsed.referenceLines : [];
        }

        const points: InjectionPoint[] = rawPoints.map((item: any) => ({
          ...item,
          tercio: item.tercio || '',
          units: item.units || 0,
          label: item.label || item.zone || '',
        }));
        setInjectionPoints(points);
        // Solo cargar como markers3D los puntos "libres" (sin editablePointId).
        // Los puntos de trazado (con editablePointId) ya se renderizan en editablePoints
        // y NO deben aparecer como markers3D (son 3x más grandes y arruinan la visual).
        const libreMarkers = rawPoints.filter((p: any) => !p.editablePointId);
        setMarkers3D(libreMarkers);
        setReferenceLines(rawLines);
        // Restaurar puntos editables si existen en mapping_data
        const rawEditablePoints = Array.isArray((parsed as any)?.editablePoints) ? (parsed as any).editablePoints : [];
        setEditablePoints(rawEditablePoints);
        setRefJsonLoaded(rawEditablePoints.length > 0);
        // Restaurar freehand lines y shapes
        const rawFreehand: FreehandLine[] = Array.isArray(parsed.freehandLines) ? parsed.freehandLines : [];
        const rawShapes: SurfaceShape[] = Array.isArray(parsed.surfaceShapes) ? parsed.surfaceShapes : [];
        const rawHaVials: HaVial[] = Array.isArray(parsed.haVials) ? parsed.haVials : [];
        setFreehandLines(rawFreehand);
        setSurfaceShapes(rawShapes);
        setHaVials(rawHaVials);
        setActiveVialId(rawHaVials.length > 0 ? rawHaVials[0].id : null);
        if (points.length > 0 || rawLines.length > 0 || rawEditablePoints.length > 0 || rawFreehand.length > 0 || rawShapes.length > 0) setShow3D(true);
      } catch {
        setInjectionPoints([]);
        setMarkers3D([]);
        setReferenceLines([]);
        setEditablePoints([]);
        setRefJsonLoaded(false);
        setFreehandLines([]);
        setSurfaceShapes([]);
      }
    } else {
      setInjectionPoints([]);
      setMarkers3D([]);
      setReferenceLines([]);
      setEditablePoints([]);
      setRefJsonLoaded(false);
      setFreehandLines([]);
      setSurfaceShapes([]);
      setHaVials([]);
      setActiveVialId(null);
    }
  }, [current.id]);

  // Auto-dismiss messages
  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const t = setTimeout(() => setMessage(null), 4000);
      return () => clearTimeout(t);
    }
  }, [message]);

  // Computed values
  const totalVial = Number(current.product_type === 'toxina' ? current.units_used : current.volume_used) || 0;
  const totalUsed = injectionPoints.reduce((sum, p) => sum + p.units, 0);
  const remaining = totalVial - totalUsed;
  const unitLabel = current.product_type === 'toxina' ? 'UI' : 'ml';

  // Validation: require product name + units before 3D marking
  const hasUnits = current.product_type === 'toxina'
    ? Number(current.units_used) > 0
    : Number(current.volume_used) > 0;
  const canMark = current.product_name.trim() !== '' && hasUnits;

  // Group points by tercio
  const pointsByTercio = injectionPoints.reduce((acc, p) => {
    const key = p.tercio || 'sin_tercio';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {} as Record<string, InjectionPoint[]>);

  // Puntos incompletos: tienen volumen pero sin zona clasificada
  const incompletePointIds = injectionPoints
    .filter(p => !p.label && p.editablePointId)
    .map(p => p.editablePointId!);

  // Puntos seleccionados en modo selección masiva (para iluminar en el visor)
  const highlightedPointIds = bulkApplyMode ? Array.from(bulkApplySelected) : [];

  // ==========================================
  // HANDLERS
  // ==========================================

  // ── HANDLERS: Multi-vial (HA) ────────────────────────────────────────────

  const handleAddVial = () => {
    const idx = haVials.length;
    const newVial: HaVial = {
      id: `vial-${Date.now()}`,
      product_name: current.product_name || '',
      brand: current.brand || '',
      lot_number: current.lot_number || '',
      expiration_date: current.expiration_date || '',
      volume_ml: Number(current.volume_used) || 0,
      color: getVialColor(idx),
    };
    setHaVials(prev => [...prev, newVial]);
    setActiveVialId(newVial.id);
  };

  const handleRemoveVial = (id: string) => {
    setHaVials(prev => prev.filter(v => v.id !== id));
    setActiveVialId(prev => (prev === id ? (haVials.find(v => v.id !== id)?.id ?? null) : prev));
  };

  const activeVial = haVials.find(v => v.id === activeVialId) ?? null;

  /** ml total usados de un vial específico */
  const usedMlByVial = (vialId: string) =>
    injectionPoints.filter(p => p.vial_id === vialId).reduce((s, p) => s + p.units, 0);

  // ── HANDLERS: Sidebar edición inline por punto ────────────────────────────

  const handlePointFieldChange = (idx: number, field: keyof InjectionPoint, value: any) => {
    setInjectionPoints(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const handleBulkApply = (sourceIdx: number) => {
    const src = injectionPoints[sourceIdx];
    setInjectionPoints(prev => prev.map((p, i) => i === sourceIdx ? p : {
      ...p,
      technique_at_point: src.technique_at_point ?? p.technique_at_point,
      needle_at_point: src.needle_at_point ?? p.needle_at_point,
      injection_plane: src.injection_plane ?? p.injection_plane,
    }));
  };

  const handleEnterBulkApplyMode = (sourceIdx: number) => {
    setBulkApplySourceIdx(sourceIdx);
    setBulkApplySelected(new Set());
    setBulkApplyMode(true);
    setExpandedPointId(null);
  };

  const handleToggleBulkPoint = (epId: string) => {
    setBulkApplySelected(prev => {
      const next = new Set(prev);
      if (next.has(epId)) next.delete(epId); else next.add(epId);
      return next;
    });
  };

  /** Selecciona/deselecciona todos los puntos del tercio (o del vial) que tengan editablePointId */
  const handleToggleBulkGroup = (epIds: string[]) => {
    const allSelected = epIds.every(id => bulkApplySelected.has(id));
    setBulkApplySelected(prev => {
      const next = new Set(prev);
      if (allSelected) epIds.forEach(id => next.delete(id));
      else epIds.forEach(id => next.add(id));
      return next;
    });
  };

  const handleApplyBulkSelected = () => {
    if (bulkApplySourceIdx === null || bulkApplySelected.size === 0) return;
    const src = injectionPoints[bulkApplySourceIdx];
    setInjectionPoints(prev => prev.map(p => {
      if (!p.editablePointId || !bulkApplySelected.has(p.editablePointId)) return p;
      return {
        ...p,
        ...(src.technique_at_point !== undefined ? { technique_at_point: src.technique_at_point } : {}),
        ...(src.needle_at_point !== undefined ? { needle_at_point: src.needle_at_point } : {}),
        ...(src.injection_plane !== undefined ? { injection_plane: src.injection_plane } : {}),
      };
    }));
    setBulkApplyMode(false);
    setBulkApplySourceIdx(null);
    setBulkApplySelected(new Set());
  };

  const handleCancelBulkApply = () => {
    setBulkApplyMode(false);
    setBulkApplySourceIdx(null);
    setBulkApplySelected(new Set());
  };

  // ── HANDLERS: Dibujo libre y formas ─────────────────────────────────────

  const handleFreehandComplete = useCallback((line: FreehandLine) => {
    setFreehandLines(prev => [...prev, line]);
  }, []);

  /** Actualiza los puntos de una línea existente (después de resize/move de handles) */
  const handleFreehandLineUpdated = useCallback((id: string, points: { x: number; y: number; z: number }[]) => {
    setFreehandLines(prev => prev.map(l => l.id === id ? { ...l, points } : l));
  }, []);

  const handleShapeComplete = useCallback((shape: SurfaceShape) => {
    setSurfaceShapes(prev => [...prev, shape]);
  }, []);

  const handleElementSelected = useCallback((id: string | null, type: string | null) => {
    if (!id) { setSelectedElement(null); return; }
    setSelectedElement({ id, type: type as 'reference-line' | 'freehand' | 'shape' });
  }, []);

  const handleSelectedColor = (color: string) => {
    if (!selectedElement) return;
    if (selectedElement.type === 'reference-line')
      setReferenceLines(prev => prev.map(l => l.id === selectedElement.id ? { ...l, color } : l));
    else if (selectedElement.type === 'freehand')
      setFreehandLines(prev => prev.map(l => l.id === selectedElement.id ? { ...l, color } : l));
    else
      setSurfaceShapes(prev => prev.map(s => s.id === selectedElement.id ? { ...s, color } : s));
  };

  const handleSelectedThickness = (thickness: number) => {
    if (!selectedElement) return;
    if (selectedElement.type === 'reference-line')
      setReferenceLines(prev => prev.map(l => l.id === selectedElement.id ? { ...l, thickness } : l));
    else if (selectedElement.type === 'freehand')
      setFreehandLines(prev => prev.map(l => l.id === selectedElement.id ? { ...l, thickness } : l));
    else
      setSurfaceShapes(prev => prev.map(s => s.id === selectedElement.id ? { ...s, thickness } : s));
  };

  const handleDeleteSelected = () => {
    if (!selectedElement) return;
    if (selectedElement.type === 'reference-line')
      setReferenceLines(prev => prev.filter(l => l.id !== selectedElement.id));
    else if (selectedElement.type === 'freehand')
      setFreehandLines(prev => prev.filter(l => l.id !== selectedElement.id));
    else
      setSurfaceShapes(prev => prev.filter(s => s.id !== selectedElement.id));
    setSelectedElement(null);
  };

  /** Eliminar todas las líneas de un mismo grupo (abanico, malla, helecho) */
  const handleDeleteGroup = (groupId: string) => {
    setFreehandLines(prev => prev.filter(l => l.groupId !== groupId));
    setSelectedElement(null);
  };

  // Propiedad del elemento actualmente seleccionado (para el panel flotante)
  const selectedElementData = selectedElement
    ? selectedElement.type === 'reference-line'
      ? referenceLines.find(l => l.id === selectedElement.id)
      : selectedElement.type === 'freehand'
        ? freehandLines.find(l => l.id === selectedElement.id)
        : surfaceShapes.find(s => s.id === selectedElement.id)
    : null;

  const handleSave = async () => {
    if (!current.product_name.trim()) {
      setMessage({ type: 'error', text: 'El nombre del producto es obligatorio' });
      return;
    }
    setSaving(true);
    try {
      const action = current.id ? 'updateInjectable' : 'addInjectable';
      const derivedAreas = [...new Set(injectionPoints.map(p => p.label).filter(Boolean))];

      // Nuevo formato de mapping_data: incluye referenceLines, editablePoints, freehandLines y surfaceShapes
      const hasData = injectionPoints.length > 0 || referenceLines.length > 0 || editablePoints.length > 0
        || freehandLines.length > 0 || surfaceShapes.length > 0 || haVials.length > 0;
      const mappingData = hasData
        ? { injectionPoints, referenceLines, editablePoints, freehandLines, surfaceShapes, haVials }
        : null;

      const payload = {
        ...current,
        record_id: recordId,
        treatment_id: current.treatment_id || null,
        mapping_data: mappingData,
        areas_treated: derivedAreas.length > 0 ? derivedAreas : null,
        ...(consultationId ? { consultation_id: consultationId } : {}),
      };

      const res = await recordsFetch(`/api/records?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setMessage({ type: 'success', text: current.id ? 'Inyectable actualizado' : 'Inyectable registrado correctamente' });
        onSave();
        if (!current.id) handleNew();
      } else {
        throw new Error('Error al guardar');
      }
    } catch (error) {
      console.error('Error saving injectable:', error);
      setMessage({ type: 'error', text: 'Error al guardar el inyectable' });
    } finally {
      setSaving(false);
    }
  };

  /**
   * Abre el modal de capturas. Si hay trabajo no guardado → pide guardar primero.
   * Las capturas siempre reflejan el registro que está cargado/seleccionado.
   */
  const handleOpenCaptures = () => {
    // Si hay marcaciones o trazados SIN guardar (registro nuevo sin ID)
    const hasUnsaved = !current.id && hasUnsavedWork();
    if (hasUnsaved) {
      setCaptureAlert('capture-save-first');
    } else {
      setCaptureModalOpen(true);
    }
  };

  /**
   * Abre la impresión. Si no hay capturas → avisa y deja elegir.
   */
  const handleOpenPrint = () => {
    if (!current.product_name) {
      setMessage({ type: 'error', text: 'Seleccione o registre un inyectable primero' });
      return;
    }
    if (capturedImages.length === 0) {
      setCaptureAlert('print-no-captures');
    } else {
      handlePrint();
    }
  };

  const handleDelete = async () => {
    if (!current.id || !confirm('¿Eliminar este registro de inyectable?')) return;
    try {
      const res = await recordsFetch(`/api/records?action=deleteInjectable&id=${current.id}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Inyectable eliminado' });
        onSave();
        handleNew();
      }
    } catch (error) {
      console.error('Error deleting injectable:', error);
      setMessage({ type: 'error', text: 'Error al eliminar' });
    }
  };

  const handleNew = (subtypeOverride?: RellenoSubType) => {
    const subtype = subtypeOverride ?? rellenoSubType;
    setCurrent({
      ...EMPTY_INJECTABLE,
      date: getLocalDate(),
      product_type: activeType,
      ...(activeType === 'relleno' ? { relleno_subtype: subtype } : {}),
    });
    setDateLocked(false);
    setMarkers3D([]);
    setInjectionPoints([]);
    setReferenceLines([]);
    setActiveLineType(null);
    setPendingLineMeta(null);
    setFirstLineAnchor(null);
    setTwoPointStep(0);
    setEditablePoints([]);
    setRefJsonLoaded(false);
    setPointMode('none');
    setUnitsModal(null);
    setUnitsModalInput('');
    setUnitsModalStep(1);
    setUnitsModalTercio('');
    setUnitsModalZone('');
    setUnitsModalZoneFilter('');
    setUnitsModalPlane('');
    setUnitsModalTecnica('');
    setDialogPlane('');
    setUndoStack([]);
    setShowClearConfirm(false);
    setIsPendingDuplicate(false);
    setFreehandLines([]);
    setSurfaceShapes([]);
    setActiveTool('none');
    setSelectedElement(null);
    setHaVials([]);
    setActiveVialId(null);
    setExpandedPointId(null);
    setBulkApplyMode(false);
    setBulkApplySourceIdx(null);
    setBulkApplySelected(new Set());
  };

  // ── pushUndo: snapshot before any point mutation ───────────────────────
  const pushUndo = useCallback((pts: InjectionPoint[], m3d: Marker3D[], eps: EditablePoint[]) => {
    setUndoStack(prev => [
      ...prev.slice(-19),
      { injectionPoints: pts, markers3D: m3d, editablePoints: eps },
    ]);
  }, []);

  // ── handleUndo: restore last snapshot ─────────────────────────────────
  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setInjectionPoints(last.injectionPoints);
      setMarkers3D(last.markers3D);
      setEditablePoints(last.editablePoints);
      setShowClearConfirm(false);
      return prev.slice(0, -1);
    });
  }, []);

  // Ctrl+Z / Cmd+Z → deshacer última acción sobre puntos
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if (e.key === 'Escape') {
        setActiveTool('none');
        setPointMode('none');
        setActiveLineType(null);
        setShowShapesDropdown(false);
        setShowHaShapesDropdown(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo]);

  // ── handleDuplicate: copia el registro actual sin ID (nuevo) ───────────
  const handleDuplicate = () => {
    if (!current.id) return;
    const hasData = injectionPoints.length > 0 || referenceLines.length > 0 || editablePoints.length > 0;
    const currentMappingData = hasData
      ? { injectionPoints, referenceLines, editablePoints }
      : current.mapping_data;
    setCurrent({
      ...current,
      id: undefined,
      record_id: undefined,
      date: getLocalDate(),
      mapping_data: currentMappingData,
    });
    setDateLocked(false);
    setUndoStack([]);
    setShowClearConfirm(false);
    setIsPendingDuplicate(true);
  };

  // ── HANDLERS: Líneas de referencia ──────────────────────────────────────

  const handleSelectPreset = (preset: LinePreset) => {
    setActiveLineType(preset.type);
    setPendingLineMeta({ label: preset.label, color: preset.color, preset });
    setFirstLineAnchor(null);
    setTwoPointStep(preset.type === 'two-points' ? 1 : 0);
  };

  const handleStartManualLine = (type: LineType) => {
    setActiveLineType(type);
    setPendingLineMeta({ label: pendingLineMeta?.label || type, color: '#ffffff' });
    setFirstLineAnchor(null);
    setTwoPointStep(type === 'two-points' ? 1 : 0);
  };

  const handleCancelLine = () => {
    setActiveLineType(null);
    setPendingLineMeta(null);
    setFirstLineAnchor(null);
    setTwoPointStep(0);
  };

  /** Callback del motor 3D cuando el usuario hace clic en modo línea */
  const handleLinePointAnchored = (point: { x: number; y: number; z: number }, step: 'first' | 'second') => {
    if (!activeLineType || !pendingLineMeta) return;

    if (activeLineType === 'vertical' || activeLineType === 'horizontal') {
      // Un solo clic → crear línea inmediatamente
      const newLine: ReferenceLine = {
        id: Date.now().toString(),
        type: activeLineType,
        label: pendingLineMeta.label,
        color: pendingLineMeta.color,
        anchor: point,
        offset: 0,
        visible: true,
      };
      setReferenceLines(prev => [...prev, newLine]);
      setActiveLineType(null);
      setPendingLineMeta(null);
      setTwoPointStep(0);

    } else if (activeLineType === 'two-points') {
      if (step === 'first') {
        setFirstLineAnchor(point);
        setTwoPointStep(2);
      } else {
        // Tenemos los dos puntos
        const newLine: ReferenceLine = {
          id: Date.now().toString(),
          type: 'two-points',
          label: pendingLineMeta.label,
          color: pendingLineMeta.color,
          anchor: firstLineAnchor || point,
          offset: 0,
          anchors: [firstLineAnchor || point, point],
          visible: true,
        };
        setReferenceLines(prev => [...prev, newLine]);
        setActiveLineType(null);
        setPendingLineMeta(null);
        setFirstLineAnchor(null);
        setTwoPointStep(0);
      }
    }
  };

  const handleToggleLineVisibility = (id: string) => {
    setReferenceLines(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
  };

  const handleLineOffsetChange = (id: string, offset: number) => {
    setReferenceLines(prev => prev.map(l => l.id === id ? { ...l, offset } : l));
  };

  const handleRemoveLine = (id: string) => {
    setReferenceLines(prev => prev.filter(l => l.id !== id));
  };

  const handleLineLabelChange = (label: string) => {
    setPendingLineMeta(prev => prev ? { ...prev, label } : { label, color: '#ffffff' });
  };

  /** Detecta automáticamente el tercio facial según la posición Y del punto en el modelo 3D.
   *  En Three.js Y crece hacia arriba: superior (arriba) > medio > inferior (abajo). */
  const detectTercioFromY = (y: number): 'superior' | 'medio' | 'inferior' => {
    if (!tercioBoundaries) return 'superior';
    const { bottomY, tercioMedioBottomY } = tercioBoundaries;
    // bottomY = límite sup/med (hairlineBottomY), tercioMedioBottomY = límite med/inf
    if (y >= bottomY) return 'superior';
    if (y >= tercioMedioBottomY) return 'medio';
    return 'inferior';
  };

  // ── HANDLERS: Puntos editables del trazado ────────────────────────────

  /** Cargar el trazado de referencia superior desde el JSON estático */
  const handleLoadReferenceJson = () => {
    if (refJsonLoaded) {
      // Si ya está cargado, preguntar si recargar
      if (!confirm('¿Recargar el trazado de referencia? Se perderán las posiciones personalizadas.')) return;
    }
    const json = trazadoSuperior as any;
    // El JSON usa "referenceLines" y "editablePoints" como claves raíz
    console.log('[Trazado] JSON keys:', Object.keys(json));
    console.log('[Trazado] referenceLines count:', json.referenceLines?.length ?? 0);
    console.log('[Trazado] editablePoints count:', json.editablePoints?.length ?? 0);

    // El JSON fue generado desde Clinical3D (targetSize=5).
    // Clinical3DViewer ahora usa el mismo targetSize=5, por lo que las
    // coordenadas son compatibles directamente sin ninguna transformación.
    const COORD_SCALE = 1.0;

    // Límites del hairline directamente en espacio 5 unidades
    const hairlineTopY          = json.hairline?.topY              ?? 1.9;
    const hairlineBottomY       = json.hairline?.bottomY           ?? 0.6;
    const tercioMedioBottomY    = json.hairline?.tercioMedioBottomY    ?? -5.5;
    const tercioInferiorBottomY = json.hairline?.tercioInferiorBottomY ?? -9.0;

    // Guardar límites en estado para auto-detección de tercio
    setTercioBoundaries({
      topY: hairlineTopY,
      bottomY: hairlineBottomY,
      tercioMedioBottomY,
      tercioInferiorBottomY,
    });

    const lines: ReferenceLine[] = (json.referenceLines || []).map((l: any) => {
      let anchor: { x: number; y: number; z: number };
      let lineType: LineType;
      let anchors: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }] | undefined;
      let yMin: number | undefined;
      let yMax: number | undefined;

      if (l.type === 'vertical') {
        const xScaled = (l.offset ?? 0) * COORD_SCALE;
        anchor = { x: xScaled, y: 0, z: 0 };
        lineType = 'vertical';
        // Limitar el sweep al tercio superior (hairline)
        yMin = hairlineBottomY;
        yMax = hairlineTopY;
      } else if (l.type === 'horizontal') {
        const yScaled = (l.offset ?? 0) * COORD_SCALE;
        anchor = { x: 0, y: yScaled, z: 0 };
        lineType = 'horizontal';
      } else {
        // two-points: los anchors vienen en l.anchors o l.points
        // Escalar también los anchors de superficie
        const pts = l.anchors || l.points || [];
        const sc = (v: number) => (v ?? 0) * COORD_SCALE;
        anchor = pts[0] ? { x: sc(pts[0].x), y: sc(pts[0].y), z: sc(pts[0].z) } : { x: 0, y: 0, z: 0 };
        anchors = pts.length >= 2
          ? [
              { x: sc(pts[0].x), y: sc(pts[0].y), z: sc(pts[0].z) },
              { x: sc(pts[1].x), y: sc(pts[1].y), z: sc(pts[1].z) },
            ]
          : undefined;
        lineType = 'two-points';
      }

      return {
        id: l.id || `ref-line-${Date.now()}-${Math.random()}`,
        type: lineType,
        label: l.label || l.id || 'Línea',
        color: l.color || '#00eeff',
        dashed: l.dashed === true,
        anchor,
        offset: 0,
        anchors,
        visible: true,
        yMin,
        yMax,
      } as ReferenceLine;
    });

    const sc = (v: number) => (v ?? 0) * COORD_SCALE;
    const points: EditablePoint[] = (json.editablePoints || []).map((p: any) => ({
      id: p.id,
      type: p.type || 'intersection',
      x: sc(p.x),
      y: sc(p.y),
      z: sc(p.z),
      lineIds: p.lineIds || [],
      name: p.name || p.id || 'Punto',
    }));

    setReferenceLines(prev => {
      // Las líneas del JSON tienen IDs que empiezan con 'line-'
      // Las líneas dibujadas manualmente tienen IDs como timestamps puros (sin prefijo)
      const manual = prev.filter(l => !l.id.startsWith('line-'));
      return [...manual, ...lines];
    });
    setEditablePoints(points);
    setRefJsonLoaded(true);
    setShow3D(true);
  };

  /** Clic sobre un punto editable → abrir modal de unidades */
  const handleEditablePointClicked = (id: string) => {
    const pt = editablePoints.find(p => p.id === id);
    if (!pt) return;
    const existing = injectionPoints.find(ip => ip.editablePointId === id);
    const autoTercio = tercioBoundaries ? detectTercioFromY(pt.y) : (existing?.tercio || '');
    setSelectedPointId(id);
    // Si ya tiene volumen pero no zona → abrir en paso 2 (zona/tercio)
    const hasVolume = existing && existing.units > 0;
    const hasZone = existing && !!existing.label;
    const startStep: 1 | 2 | 3 = (hasVolume && !hasZone) ? 2 : 1;
    setUnitsModal({
      open: true,
      pointId: id,
      pointName: pt.name || id,
      existingUnits: existing?.units ?? 0,
      isNewPoint: false,
    });
    setUnitsModalInput(String(existing?.units ?? ''));
    setUnitsModalTercio((existing?.tercio || autoTercio) as 'superior' | 'medio' | 'inferior' | '');
    setUnitsModalZone(existing?.label || '');
    setUnitsModalPlane(existing?.injection_plane || '');
    setUnitsModalZoneFilter('');
    setUnitsModalStep(startStep as 1 | 2 | 3 | 4);
  };

  /** Punto editable movido en el visor 3D → actualizar posición */
  const handleEditablePointMoved = (id: string, pos: { x: number; y: number; z: number }) => {
    // Push undo only once per drag gesture (debounced: resets 800ms after last move event)
    if (!moveUndoTimerRef.current) {
      pushUndo(injectionPoints, markers3D, editablePoints);
    }
    if (moveUndoTimerRef.current) clearTimeout(moveUndoTimerRef.current);
    moveUndoTimerRef.current = setTimeout(() => { moveUndoTimerRef.current = null; }, 800);
    setEditablePoints(prev => prev.map(p => p.id === id ? { ...p, ...pos } : p));
  };

  /** Punto editable eliminado en el visor 3D */
  const handleEditablePointDeleted = (id: string) => {
    pushUndo(injectionPoints, markers3D, editablePoints);
    setEditablePoints(prev => prev.filter(p => p.id !== id));
    setInjectionPoints(prev => prev.filter(ip => ip.editablePointId !== id));
    setMarkers3D(prev => prev.filter((_, i) => {
      const ip = injectionPoints[i];
      return !ip || ip.editablePointId !== id;
    }));
  };

  const handleUnitsModalConfirm = () => {
    if (!unitsModal) return;
    const units = Number(unitsModalInput) || 0;

    if (unitsModal.isNewPoint && pendingFreePoint) {
      // ── Punto libre nuevo (free-click o add-mode) ──────────────────────
      pushUndo(injectionPoints, markers3D, editablePoints);
      const effectiveTercio = (unitsModalTercio || 'superior') as 'superior' | 'medio' | 'inferior';
      // Zona vacía en primer guardado; se completa en segundo paso (clic sobre el punto)
      const effectiveLabel = unitsModalZone || '';

      // Siempre crear EditablePoint para que sea editable y aparezca en el panel
      const newEp: EditablePoint = {
        id: `free-${Date.now()}`,
        type: 'free',
        x: pendingFreePoint.position.x,
        y: pendingFreePoint.position.y,
        z: pendingFreePoint.position.z,
        lineIds: [],
        name: effectiveLabel || `punto ${injectionPoints.length + 1}`,
      };
      setEditablePoints(prev => [...prev, newEp]);

      const newPoint: InjectionPoint = {
        ...pendingFreePoint,
        zone: effectiveLabel,
        tercio: effectiveTercio,
        units,
        label: effectiveLabel,
        editablePointId: newEp.id,
        // Vial activo para relleno HA
        ...(activeVialId ? { vial_id: activeVialId } : {}),
        // Plano y técnica si los seleccionó el usuario
        ...(unitsModalPlane ? { injection_plane: unitsModalPlane } : {}),
        ...(unitsModalTecnica ? { technique_at_point: unitsModalTecnica } : {}),
      };
      setInjectionPoints(prev => [...prev, newPoint]);
      setPendingFreePoint(null);
    } else {
      // ── Punto existente (trazado o libre ya guardado) ─────────────────
      const pt = editablePoints.find(p => p.id === unitsModal.pointId);
      if (!pt) { setUnitsModal(null); return; }
      pushUndo(injectionPoints, markers3D, editablePoints);
      const existingIdx = injectionPoints.findIndex(ip => ip.editablePointId === unitsModal.pointId);
      const existing = existingIdx >= 0 ? injectionPoints[existingIdx] : null;
      const effectiveTercio = unitsModalTercio || existing?.tercio || 'superior';
      const effectiveLabel = unitsModalZone || existing?.label || '';

      // Preservar todos los campos del punto existente (evita perder vial_id, needle, etc.)
      const newPoint: InjectionPoint = {
        ...(existing || {}),
        position: { x: pt.x, y: pt.y, z: pt.z },
        zone: effectiveLabel,
        tercio: effectiveTercio as 'superior' | 'medio' | 'inferior',
        units,
        label: effectiveLabel,
        editablePointId: unitsModal.pointId,
        ...(unitsModalPlane ? { injection_plane: unitsModalPlane } : {}),
        ...(unitsModalTecnica ? { technique_at_point: unitsModalTecnica } : {}),
      };

      if (existingIdx >= 0) {
        setInjectionPoints(prev => prev.map((ip, i) => i === existingIdx ? newPoint : ip));
      } else {
        setInjectionPoints(prev => [...prev, newPoint]);
      }
    }

    setUnitsModal(null);
    setUnitsModalInput('');
    setUnitsModalStep(1);
    setUnitsModalTercio('');
    setUnitsModalZone('');
    setUnitsModalZoneFilter('');
    setUnitsModalPlane('');
    setUnitsModalTecnica('');
    setSelectedPointId(null);
  };

  const handleSelect = (inj: Injectable) => {
    setCurrent({
      ...inj,
      date: toDateOnly(inj.date),
      expiration_date: toDateOnly(inj.expiration_date),
      follow_up_date: toDateOnly(inj.follow_up_date),
    });
    setDateLocked(true);
    setUndoStack([]);
    setShowClearConfirm(false);
    setIsPendingDuplicate(false);
    // Sync subtype when loading a relleno record (without triggering a reset)
    if (inj.product_type === 'relleno') {
      setRellenoSubType((inj.relleno_subtype as RellenoSubType) || 'relleno_ha');
    }
  };

  // 3D click → abrir modal en paso de UI (unidades)
  const handleMarkerPlaced = (marker: Marker3D) => {
    const isAddMode = (marker as any).isAddPointMode;
    if (!isAddMode && !canMark) {
      // Para relleno HA con multi-vial: también permitir si hay un vial activo
      if (!(activeType === 'relleno' && activeVial)) {
        setMessage({ type: 'error', text: `Complete el nombre del producto y las ${unitLabel} antes de marcar puntos` });
        return;
      }
    }

    const autoTercio = tercioBoundaries ? detectTercioFromY(marker.position.y) : '';

    setPendingFreePoint(marker);
    setUnitsModal({
      open: true,
      pointId: 'pending-free',
      pointName: 'Nuevo punto',
      existingUnits: 0,
      isNewPoint: true,
    });
    setUnitsModalInput('');
    setUnitsModalTercio(autoTercio as 'superior' | 'medio' | 'inferior' | '');
    setUnitsModalZone(''); // sin zona hasta segundo paso
    setUnitsModalZoneFilter('');
    setUnitsModalPlane('');
    setUnitsModalTecnica('');
    setUnitsModalVialStep(false);
    setUnitsModalStep(1);
    setInlineVialForm({ open: false, name: '', vol: '' });
  };

  const handleRemovePoint = (index: number) => {
    const point = injectionPoints[index];
    pushUndo(injectionPoints, markers3D, editablePoints);
    setInjectionPoints(prev => prev.filter((_, i) => i !== index));
    if (point?.editablePointId) {
      // Elimina el punto editable del visor 3D (es el que renderiza la esfera)
      setEditablePoints(prev => prev.filter(ep => ep.id !== point.editablePointId));
    } else {
      setMarkers3D(prev => prev.filter((_, i) => i !== index));
    }
  };

  // ==========================================
  // PRINT
  // ==========================================

  const handlePrint = () => {
    if (!current.product_name) {
      setMessage({ type: 'error', text: 'Seleccione o registre un inyectable primero' });
      return;
    }

    // Build tercio breakdown for print
    const tercioCSS: Record<string, { bg: string; border: string; text: string }> = {
      superior: { bg: '#e0f7fa', border: '#00bcd4', text: '#006064' },
      medio: { bg: '#ede7f6', border: '#7c4dff', text: '#4527a0' },
      inferior: { bg: '#fff8e1', border: '#ffc107', text: '#e65100' },
    };
    const tercioNames: Record<string, string> = { superior: 'Tercio Superior', medio: 'Tercio Medio', inferior: 'Tercio Inferior' };
    let tercioBreakdownHtml = '';
    for (const t of ['superior', 'medio', 'inferior'] as const) {
      const pts = pointsByTercio[t];
      if (!pts || pts.length === 0) continue;
      const totalT = pts.reduce((s, p) => s + p.units, 0);
      const css = tercioCSS[t];
      tercioBreakdownHtml += `<div style="margin-bottom:12px;"><div style="background:${css.bg};border:1px solid ${css.border};border-radius:6px;padding:8px 12px;margin-bottom:4px;"><strong style="color:${css.text};font-size:12px;">${tercioNames[t]}</strong><span style="float:right;font-size:11px;color:${css.text};">${pts.length} punto(s) · ${totalT} ${unitLabel}</span></div><table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#faf6f0;"><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:left;border-bottom:1px solid #e8dcc8;">#</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:left;border-bottom:1px solid #e8dcc8;">Zona Anatómica</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:left;border-bottom:1px solid #e8dcc8;">Plano</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:right;border-bottom:1px solid #e8dcc8;">${unitLabel} Aplicadas</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:right;border-bottom:1px solid #e8dcc8;">% Dosis</th></tr></thead><tbody>${pts.map((p, i) => `<tr><td style="font-size:11px;padding:4px 8px;border-bottom:1px solid #f0f0f0;">${i + 1}</td><td style="font-size:11px;padding:4px 8px;border-bottom:1px solid #f0f0f0;">${p.label || '—'}</td><td style="font-size:11px;padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#7c3aed;">${p.injection_plane || '—'}</td><td style="font-size:11px;padding:4px 8px;text-align:right;border-bottom:1px solid #f0f0f0;">${p.units}</td><td style="font-size:11px;padding:4px 8px;text-align:right;border-bottom:1px solid #f0f0f0;">${totalUsed > 0 ? Math.round((p.units / totalUsed) * 100) : 0}%</td></tr>`).join('')}</tbody></table></div>`;
    }
    // Legend for percentage
    if (tercioBreakdownHtml) {
      tercioBreakdownHtml += `<div style="margin-top:4px;padding:6px 10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:10px;color:#6b7280;line-height:1.6;">
        <strong style="color:#4b5563;">Leyenda:</strong>
        <strong>% Dosis</strong> = porcentaje de unidades aplicadas en cada punto respecto al total de ${unitLabel} utilizadas (${totalUsed} ${unitLabel}).
        <strong>Zona Anatómica</strong> = área facial específica donde se realizó la inyección, clasificada por tercio facial.
      </div>`;
    }

    // Zone summary
    const zoneMap = new Map<string, { units: number; count: number }>();
    injectionPoints.forEach(p => {
      const existing = zoneMap.get(p.label) || { units: 0, count: 0 };
      zoneMap.set(p.label, { units: existing.units + p.units, count: existing.count + 1 });
    });
    let zoneSummaryHtml = '';
    if (zoneMap.size > 0) {
      zoneSummaryHtml = `<div style="margin-top:12px;"><div style="font-size:12px;font-weight:700;color:#b8944d;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;border-bottom:1px solid #f0e6d6;padding-bottom:4px;">Resumen por Zona</div><table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#faf6f0;"><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:left;border-bottom:1px solid #e8dcc8;">Zona</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:right;border-bottom:1px solid #e8dcc8;">Puntos</th><th style="font-size:10px;text-transform:uppercase;color:#b8944d;padding:4px 8px;text-align:right;border-bottom:1px solid #e8dcc8;">Total ${unitLabel}</th></tr></thead><tbody>${Array.from(zoneMap.entries()).map(([zone, data]) => `<tr><td style="font-size:11px;padding:4px 8px;border-bottom:1px solid #f0f0f0;">${zone}</td><td style="font-size:11px;padding:4px 8px;text-align:right;border-bottom:1px solid #f0f0f0;">${data.count}</td><td style="font-size:11px;padding:4px 8px;text-align:right;border-bottom:1px solid #f0f0f0;">${data.units}</td></tr>`).join('')}</tbody></table></div>`;
    }

    setMessage({ type: 'success', text: 'Abriendo vista de impresión...' });
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Ficha de Inyectable — BioSkinTech</title>
  <style>
    @page { margin: 1.5cm; size: A4; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #333; line-height: 1.5; padding: 30px; max-width: 800px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #deb887; padding-bottom: 16px; margin-bottom: 24px; }
    .header-left h1 { font-size: 22px; color: #deb887; font-weight: 700; letter-spacing: 1px; }
    .header-left p { font-size: 11px; color: #999; margin-top: 2px; }
    .header-right { text-align: right; font-size: 12px; color: #666; }
    .patient-bar { background: #faf6f0; border: 1px solid #e8dcc8; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; display: flex; justify-content: space-between; }
    .patient-bar span { font-size: 13px; }
    .patient-bar strong { color: #b8944d; }
    .section { margin-bottom: 18px; }
    .section-title { font-size: 13px; font-weight: 700; color: #deb887; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; border-bottom: 1px solid #f0e6d6; padding-bottom: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px 16px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
    .field { margin-bottom: 6px; }
    .field .label { font-size: 10px; text-transform: uppercase; color: #999; letter-spacing: 0.3px; }
    .field .value { font-size: 13px; font-weight: 500; color: #333; padding: 4px 0; }
    .type-badge { display: inline-block; padding: 3px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .type-toxina { background: #e0f2fe; color: #0369a1; }
    .type-relleno { background: #f3e8ff; color: #7c3aed; }
    .zones-container { display: flex; flex-wrap: wrap; gap: 4px; }
    .zone-tag { display: inline-block; padding: 2px 8px; background: #fef3c7; color: #92400e; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .empty { color: #ccc; font-style: italic; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    table th { background: #faf6f0; font-size: 11px; text-transform: uppercase; color: #b8944d; padding: 6px 8px; text-align: left; border-bottom: 2px solid #e8dcc8; }
    table td { font-size: 12px; padding: 5px 8px; border-bottom: 1px solid #f0f0f0; }
    .notes-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; font-size: 12px; white-space: pre-wrap; min-height: 30px; }
    .summary-bar { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .summary-card { background: #faf6f0; border: 1px solid #e8dcc8; border-radius: 8px; padding: 10px 14px; text-align: center; }
    .summary-card .sc-label { font-size: 10px; text-transform: uppercase; color: #999; letter-spacing: 0.3px; }
    .summary-card .sc-value { font-size: 18px; font-weight: 700; color: #333; margin-top: 2px; }
    .summary-card.danger .sc-value { color: #dc2626; }
    .mapping-img { max-width: 320px; margin: 8px auto; display: block; border-radius: 8px; border: 1px solid #e5e7eb; }
    .signature { margin-top: 50px; display: flex; justify-content: space-between; }
    .signature-block { text-align: center; width: 40%; }
    .signature-line { border-top: 1px solid #333; margin-top: 50px; padding-top: 6px; font-size: 11px; color: #666; }
    .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #bbb; border-top: 1px solid #eee; padding-top: 10px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${clinic.general.logo_url ? `<img src="${clinic.general.logo_url}" alt="Logo" style="height:48px;width:auto;object-fit:contain;margin-bottom:6px;" onerror="this.style.display='none'">` : ''}
      <h1>${clinicDisplayName}</h1>
      <p>${clinic.general.establishment_type || clinic.general.tagline || 'Centro de Medicina Estética'}</p>
      ${clinic.general.address ? `<p style="font-size:10px;color:#aaa;">${clinic.general.address}${clinic.general.city ? ', ' + clinic.general.city : ''}</p>` : ''}
    </div>
    <div class="header-right">
      <div>Ficha de Procedimiento Inyectable</div>
      <div style="font-size:11px; color:#999;">Fecha de impresión: ${new Date().toLocaleDateString('es-EC')}</div>
    </div>
  </div>

  <div class="patient-bar">
    <span><strong>Paciente:</strong> ${patientName || '—'}</span>
    <span><strong>Fecha del procedimiento:</strong> ${current.date ? new Date(current.date + 'T12:00:00').toLocaleDateString('es-EC') : '—'}</span>
  </div>

  <div class="section">
    <div class="section-title">Información del Producto</div>
    <div class="grid">
      <div class="field">
        <div class="label">Tipo</div>
        <div class="value"><span class="type-badge ${current.product_type === 'toxina' ? 'type-toxina' : 'type-relleno'}">${current.product_type === 'toxina' ? 'Toxina Botulínica' : (rellenoSubType === 'hidratacion' ? 'Hidratación' : rellenoSubType === 'bioestimulador' ? 'Bioestimuladores' : 'Relleno (Ácido Hialurónico)')}</span></div>
      </div>
      <div class="field">
        <div class="label">Producto</div>
        <div class="value">${current.product_name || '—'}</div>
      </div>
      <div class="field">
        <div class="label">Marca</div>
        <div class="value">${current.brand || '—'}</div>
      </div>
    </div>
    <div class="grid">
      <div class="field">
        <div class="label">Lote</div>
        <div class="value">${current.lot_number || '—'}</div>
      </div>
      <div class="field">
        <div class="label">Vencimiento</div>
        <div class="value">${current.expiration_date ? new Date(current.expiration_date + 'T12:00:00').toLocaleDateString('es-EC') : '—'}</div>
      </div>
      <div class="field">
        <div class="label">${current.product_type === 'toxina' ? 'Unidades (UI)' : 'Volumen (ml)'}</div>
        <div class="value">${current.product_type === 'toxina' ? (current.units_used || '—') : (current.volume_used || '—')}</div>
      </div>
    </div>
    ${current.product_type === 'toxina' && current.dilution_volume ? `<div class="grid-2" style="margin-top:8px;">
      <div class="field">
        <div class="label">Dilución — Suero Fisiológico 0.9%</div>
        <div class="value">${current.dilution_volume} ml</div>
      </div>
      <div class="field">
        <div class="label">Concentración Resultante</div>
        <div class="value">${(Number(current.units_used) / Number(current.dilution_volume)).toFixed(2)} UI/ml</div>
      </div>
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">Técnica de Aplicación</div>
    <div class="grid-2">
      <div class="field">
        <div class="label">Técnica</div>
        <div class="value">${current.technique || '—'}</div>
      </div>
      <div class="field">
        <div class="label">Aguja / Cánula</div>
        <div class="value">${current.needle_type || '—'}</div>
      </div>
    </div>
  </div>

  ${injectionPoints.length > 0 ? `
  <div class="section">
    <div class="section-title">Distribución del Vial</div>
    <p style="font-size:11px;color:#6b7280;margin-bottom:8px;">Resumen de la distribución del producto inyectado. <strong>Total Vial</strong>: cantidad disponible. <strong>Utilizadas</strong>: suma de unidades aplicadas. <strong>Restantes</strong>: sobrante en el vial. <strong>Puntos</strong>: sitios de inyección.</p>
    <div class="summary-bar">
      <div class="summary-card"><div class="sc-label">Total Vial</div><div class="sc-value">${totalVial} ${unitLabel}</div></div>
      <div class="summary-card"><div class="sc-label">Utilizadas</div><div class="sc-value">${totalUsed} ${unitLabel}</div></div>
      <div class="summary-card ${remaining < 0 ? 'danger' : ''}"><div class="sc-label">Restantes</div><div class="sc-value">${remaining} ${unitLabel}</div></div>
      <div class="summary-card"><div class="sc-label">Puntos</div><div class="sc-value">${injectionPoints.length}</div></div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Desglose por Tercio Facial</div>
    <p style="font-size:11px;color:#6b7280;margin-bottom:8px;">Distribución detallada de los puntos de inyección clasificados por tercio facial (superior, medio e inferior). La columna <strong>% Dosis</strong> indica el porcentaje que representa cada punto respecto al total de ${unitLabel} aplicadas.</p>
    ${tercioBreakdownHtml}
    ${zoneSummaryHtml}
  </div>` : ''}

  ${capturedImages.length > 0 ? `
  <div class="section">
    <div class="section-title">Mapeo Facial 3D — Vistas Capturadas (${capturedImages.length})</div>
    <p style="font-size:11px;color:#6b7280;margin-bottom:12px;">Representaciones visuales del mapeo 3D desde distintos ángulos. Cada imagen corresponde a una captura manual realizada durante el registro del procedimiento.</p>
    <div style="display:grid;grid-template-columns:repeat(${Math.min(capturedImages.length, 2)},1fr);gap:16px;">
      ${capturedImages.map((cap, idx) => `
        <div style="border:1px solid #e8dcc8;border-radius:8px;overflow:hidden;background:#faf6f0;">
          <img src="${cap.dataUrl}" alt="${cap.label || `Vista ${idx + 1}`}" style="width:100%;display:block;" />
          <div style="padding:6px 10px;font-size:11px;color:#b8944d;font-weight:600;text-align:center;border-top:1px solid #e8dcc8;">
            ${cap.label ? cap.label : `Vista ${idx + 1}`}
          </div>
        </div>
      `).join('')}
    </div>
  </div>` : ''}

  ${current.follow_up_date ? `<div class="section">
    <div class="section-title">Cita de Control</div>
    <div class="grid-2">
      <div class="field">
        <div class="label">Fecha programada de revisión</div>
        <div class="value" style="font-weight:600;color:#333;">${new Date(current.follow_up_date + 'T12:00:00').toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
      </div>
    </div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">Observaciones Clínicas</div>
    <div class="notes-box">${current.notes || 'Sin observaciones'}</div>
  </div>

  <div class="signature">
    <div class="signature-block">
      <div class="signature-line">
        ${[user?.gentilicio, user?.full_name].filter(Boolean).join(' ') || user?.username || 'Profesional'}
        ${user?.especialidad ? `<br><small style="font-size:10px;font-weight:normal;color:#555;">${user.especialidad}</small>` : ''}
        ${user?.matricula_senescyt ? `<br><small style="font-size:10px;font-weight:normal;">Matr. SENESCYT: ${user.matricula_senescyt}</small>` : ''}
        ${user?.cedula_profesional ? `<br><small style="font-size:10px;font-weight:normal;">Cédula/RUC: ${user.cedula_profesional}</small>` : ''}
      </div>
    </div>
    <div class="signature-block">
      <div class="signature-line">Firma del Paciente</div>
    </div>
  </div>

  <div class="footer">
    ${clinicDisplayName} — ${clinic.general.establishment_type || clinic.general.tagline || 'Centro de Medicina Estética'} · Documento generado el ${new Date().toLocaleString('es-EC')}
  </div>
  <script>window.onload = () => window.print()</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // Filtrar injectables por tipo activo, sub-tipo y consulta activa
  const filteredInjectables = injectables.filter(i => {
    if (i.consultation_id !== consultationId) return false;
    if (i.product_type !== activeType) return false;
    if (activeType === 'relleno') return (i.relleno_subtype || 'relleno_ha') === rellenoSubType;
    return true;
  });
  const otherInjCount = injectables.filter(i => i.consultation_id !== consultationId).length;

  // Resetear COMPLETAMENTE al cambiar de sub-tab (aislamiento botox vs HA)
  useEffect(() => {
    setRellenoSubType('relleno_ha');
    setCurrent({ ...EMPTY_INJECTABLE, date: getLocalDate(), product_type: activeType });
    setInjectionPoints([]);
    setMarkers3D([]);
    setReferenceLines([]);
    setEditablePoints([]);
    setUndoStack([]);
    setIsPendingDuplicate(false);
    // Limpiar también los estados que faltaban antes (causaban el leak de trazados)
    setFreehandLines([]);
    setSurfaceShapes([]);
    setHaVials([]);
    setActiveVialId(null);
    setShow3D(false);
    setSelectedElement(null);
    setExpandedPointId(null);
    setActiveTool('none');
    setRefJsonLoaded(false);
    setShowClearConfirm(false);
    setBulkApplyMode(false);
    setBulkApplySourceIdx(null);
    setBulkApplySelected(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType]);

  const getDbItems = (cat: string) => dbCatalog.filter(d => d.categoria === cat).map(d => d.elemento);

  const brands = activeType === 'toxina'
    ? [...new Set([...toxinaBrands, ...getDbItems('marca_toxina')])]
    : rellenoSubType === 'hidratacion'
      ? [...new Set([...hidratacionBrands, ...getDbItems('marca_hidratacion')])]
      : rellenoSubType === 'bioestimulador'
        ? [...new Set([...bioestimuladorBrands, ...getDbItems('marca_bioestimulador')])]
        : [...new Set([...rellenoHaBrands, ...getDbItems('marca_relleno_ha')])];

  /** Detecta si hay trabajo en progreso sin guardar en el tab actual */
  const hasUnsavedWork = () =>
    current.product_name.trim() !== '' ||
    injectionPoints.length > 0 ||
    freehandLines.length > 0 ||
    surfaceShapes.length > 0;

  /** Cambia de sub-tab; si hay trabajo sin guardar muestra el modal de confirmación */
  const requestTabSwitch = (target: 'toxina' | 'relleno') => {
    if (target === activeType) return;
    if (hasUnsavedWork()) {
      setPendingTabSwitch(target);
    } else {
      setActiveType(target);
    }
  };

  const confirmTabSwitch = async (saveFirst: boolean) => {
    const target = pendingTabSwitch!;
    setPendingTabSwitch(null);
    if (saveFirst && current.product_name.trim()) {
      await handleSave();
    }
    setActiveType(target);
  };

  /** Cambia de sub-tipo dentro de Relleno; guarda si hay trabajo sin guardar */
  const requestSubTypeSwitch = (target: RellenoSubType) => {
    if (target === rellenoSubType) return;
    if (hasUnsavedWork()) {
      setPendingSubTypeSwitch(target);
    } else {
      setRellenoSubType(target);
      handleNew(target);
    }
  };

  const confirmSubTypeSwitch = async (saveFirst: boolean) => {
    const target = pendingSubTypeSwitch!;
    setPendingSubTypeSwitch(null);
    if (saveFirst && current.product_name.trim()) await handleSave();
    setRellenoSubType(target);
    handleNew(target);
  };

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <>
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col gap-0"
    >
      {/* ── Sub-tab Selector: Toxina / Relleno ── */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit shadow-inner">
        <button
          onClick={() => requestTabSwitch('toxina')}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 ${
            activeType === 'toxina'
              ? 'bg-white text-[#b8944d] shadow-md ring-1 ring-[#deb887]/40'
              : 'text-gray-500 hover:text-gray-700 hover:bg-white/50'
          }`}
        >
          <FlaskConical className="w-4 h-4" />
          Toxina Botulínica
          <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
            activeType === 'toxina' ? 'bg-[#deb887]/20 text-[#b8944d]' : 'bg-gray-200 text-gray-500'
          }`}>
            {injectables.filter(i => i.product_type === 'toxina').length}
          </span>
        </button>
        <button
          onClick={() => requestTabSwitch('relleno')}
          className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 ${
            activeType === 'relleno'
              ? 'bg-white text-purple-600 shadow-md ring-1 ring-purple-300/40'
              : 'text-gray-500 hover:text-gray-700 hover:bg-white/50'
          }`}
        >
          <Droplets className="w-4 h-4" />
          Rellenos & Bioestimuladores
          <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
            activeType === 'relleno' ? 'bg-purple-100 text-purple-600' : 'bg-gray-200 text-gray-500'
          }`}>
            {injectables.filter(i => i.product_type === 'relleno').length}
          </span>
        </button>
      </div>

      {/* ── Sub-tipo selector (solo cuando activo = relleno) ── */}
      {activeType === 'relleno' && (
        <div className="flex gap-1 mb-4 bg-purple-50/60 p-1 rounded-xl w-fit shadow-inner border border-purple-100">
          {(['relleno_ha', 'hidratacion', 'bioestimulador'] as RellenoSubType[]).map(st => {
            const isActive = rellenoSubType === st;
            const colors = RELLENO_SUBTYPE_COLORS[st];
            const count = injectables.filter(i => i.product_type === 'relleno' && (i.relleno_subtype || 'relleno_ha') === st).length;
            return (
              <button
                key={st}
                onClick={() => requestSubTypeSwitch(st)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition-all duration-200 ${
                  isActive ? colors.active : colors.hover
                }`}
              >
                {st === 'relleno_ha' && <Droplets className="w-3.5 h-3.5" />}
                {st === 'hidratacion' && <Pipette className="w-3.5 h-3.5" />}
                {st === 'bioestimulador' && <FlaskConical className="w-3.5 h-3.5" />}
                {RELLENO_SUBTYPE_LABELS[st]}
                <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isActive ? colors.badge : 'bg-gray-200 text-gray-500'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Layout principal: sidebar + formulario ── */}
      <div className="flex flex-col md:flex-row h-auto md:min-h-[620px] gap-6">
      {/* ========== SIDEBAR — Historial de Inyectables ========== */}
      <div className="w-full md:w-72 border-r-0 md:border-r border-b md:border-b-0 border-gray-100 pr-0 md:pr-6 pb-4 md:pb-0 flex flex-col gap-4 shrink-0">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 rounded-full" style={{ background: activeType === 'toxina' ? '#deb887' : '#a855f7' }} />
          {activeType === 'toxina' ? 'Historial Toxina' : `Historial · ${RELLENO_SUBTYPE_LABELS[rellenoSubType]}`}
          <span className="ml-auto flex items-center gap-1">
            <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{filteredInjectables.length}</span>
            {otherInjCount > 0 && (
              <button onClick={() => setCrossHistOpen(true)} title={`Ver ${otherInjCount} inyectable(s) de otras consultas`} className="p-1 hover:bg-[#deb887]/10 rounded-lg relative">
                <History className="w-3.5 h-3.5 text-[#b8944d]" />
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#b8944d] text-white text-[8px] rounded-full flex items-center justify-center font-bold">{otherInjCount > 9 ? '9+' : otherInjCount}</span>
              </button>
            )}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {/* Pending duplicate card — shown at top while unsaved */}
          {isPendingDuplicate && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className="p-4 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 shadow-sm"
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600">
                  <Copy className="w-3.5 h-3.5" />
                  <span>Duplicado — hoy</span>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wide bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full">
                  Sin guardar
                </span>
              </div>
              <div className="font-semibold text-sm leading-tight truncate text-gray-800 mb-1">
                {current.product_name || <span className="italic font-normal text-gray-400">Sin nombre</span>}
              </div>
              <div className="text-xs text-amber-600/70">
                {current.product_type === 'toxina' ? 'Toxina' : 'Relleno'} · Editando ahora
              </div>
            </motion.div>
          )}
          {filteredInjectables.length === 0 && !isPendingDuplicate ? (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              Sin registros de {activeType === 'toxina' ? 'toxina' : RELLENO_SUBTYPE_LABELS[rellenoSubType]}
            </div>
          ) : (
            filteredInjectables.map((inj, index) => {
              const isActive = !isPendingDuplicate && current.id === inj.id;
              const isToxina = inj.product_type === 'toxina';
              const dateStr = inj.date ? new Date(toDateOnly(inj.date) + 'T12:00:00').toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
              const areas = Array.isArray(inj.areas_treated) ? inj.areas_treated : [];
              return (
                <motion.div
                  key={inj.id || index}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleSelect(inj)}
                  className={`p-4 rounded-xl cursor-pointer border transition-all shadow-sm ${
                    isActive
                      ? 'bg-[#deb887] text-white border-[#deb887] shadow-md'
                      : 'bg-white border-gray-100 hover:bg-gray-50 hover:border-[#deb887]/30'
                  }`}
                >
                  <div className={`flex items-center gap-1.5 text-xs font-semibold mb-1.5 ${isActive ? 'text-white/80' : 'text-[#deb887]'}`}>
                    <Calendar className="w-3.5 h-3.5" />
                    <span>{dateStr}</span>
                  </div>
                  <div className={`font-semibold text-sm leading-tight truncate mb-1 ${isActive ? 'text-white' : 'text-gray-800'}`}>
                    {inj.product_name || <span className={`italic font-normal ${isActive ? 'text-white/60' : 'text-gray-400'}`}>Sin nombre</span>}
                  </div>
                  <div className={`flex items-center justify-between text-xs ${isActive ? 'text-white/70' : 'text-gray-400'}`}>
                    <span>{isToxina ? 'Toxina' : 'Relleno'}{areas.length > 0 ? ` · ${areas.slice(0, 2).join(', ')}` : ''}</span>
                    <div className="flex items-center gap-1">
                      {isActive && (
                        <button
                          onClick={e => { e.stopPropagation(); handleDuplicate(); }}
                          title="Duplicar este registro"
                          className="p-0.5 rounded hover:bg-white/20 transition-colors"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      )}
                      <Droplets className="w-3.5 h-3.5 opacity-60" />
                    </div>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>

        {/* Bottom action in sidebar */}
        <div className="flex flex-col gap-2">
          <Tooltip content={`Nuevo registro de ${activeType === 'toxina' ? 'Toxina' : RELLENO_SUBTYPE_LABELS[rellenoSubType]}`}>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={handleNew}
              className={`flex items-center justify-center gap-2 w-full px-3 py-2.5 text-sm font-medium rounded-xl border transition-all ${
                activeType === 'toxina'
                  ? 'text-[#b8944d] bg-[#deb887]/10 hover:bg-[#deb887]/20 border-[#deb887]/30'
                  : 'text-purple-700 bg-purple-50 hover:bg-purple-100 border-purple-200'
              }`}
            >
              <Plus className="w-4 h-4" />
              {activeType === 'toxina' ? 'Nueva Toxina' : RELLENO_SUBTYPE_LABELS[rellenoSubType]}
            </motion.button>
          </Tooltip>
          {current.id && (
            <Tooltip content="Duplicar el registro seleccionado para editarlo">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={handleDuplicate}
                className="flex items-center justify-center gap-2 w-full px-3 py-2.5 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-xl border border-amber-200 transition-all"
              >
                <Copy className="w-4 h-4" />
                Duplicar seleccionado
              </motion.button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* ========== MAIN CONTENT ========== */}
      <div className="flex-1 flex flex-col gap-4 relative overflow-y-auto md:overflow-y-auto custom-scrollbar pr-1">
        <AnimatePresence>
          {message && (
            <motion.div
              ref={messageRef}
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

        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm sticky top-0 z-10">
          <div className="flex gap-2 items-center">
            <Tooltip content="Nuevo Inyectable">
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

            <Tooltip content="Eliminar">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete}
                disabled={!current.id}
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 disabled:opacity-30"
              >
                <Trash2 className="w-5 h-5" />
              </motion.button>
            </Tooltip>

            <Tooltip content="Duplicar registro seleccionado para editar">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate}
                disabled={!current.id}
                className="p-2 hover:bg-amber-50 rounded-lg text-amber-600 border border-amber-100 disabled:opacity-30"
              >
                <Copy className="w-5 h-5" />
              </motion.button>
            </Tooltip>

            <Tooltip content="Deshacer última acción (Ctrl+Z)">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                className="p-2 hover:bg-blue-50 rounded-lg text-blue-500 border border-blue-100 disabled:opacity-30"
              >
                <Undo2 className="w-5 h-5" />
              </motion.button>
            </Tooltip>
          </div>

          <div className="flex items-center gap-2">
            <Tooltip content="Gestionar capturas del mapeo 3D">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleOpenCaptures}
                className="relative p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Images className="w-5 h-5" />
                {capturedImages.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-[#deb887] text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                    {capturedImages.length}
                  </span>
                )}
              </motion.button>
            </Tooltip>

            <Tooltip content="Imprimir ficha">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleOpenPrint}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Printer className="w-5 h-5" />
              </motion.button>
            </Tooltip>
          </div>
        </div>

        {/* ── Multi-vial manager (solo para Relleno HA) ── */}
        {activeType === 'relleno' && (
          <div className="bg-white rounded-2xl border border-purple-100 shadow-sm p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-purple-700 uppercase tracking-wide flex items-center gap-1.5">
                <Droplets className="w-3.5 h-3.5" />
                Jeringas / Viales
              </span>
              <button
                onClick={handleAddVial}
                disabled={!current.product_name.trim() || !Number(current.volume_used)}
                className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Añadir vial con el producto y volumen del formulario"
              >
                <Plus className="w-3 h-3" />
                Añadir vial
              </button>
            </div>
            {haVials.length === 0 ? (
              <p className="text-[11px] text-gray-400 italic">Llena el producto y volumen, luego añade el vial. Puedes añadir varios para una sesión multi-jeringa.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {haVials.map((v, idx) => {
                  const used = usedMlByVial(v.id);
                  const remaining = v.volume_ml - used;
                  const isActive = v.id === activeVialId;
                  return (
                    <div
                      key={v.id}
                      onClick={() => setActiveVialId(v.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 cursor-pointer transition-all ${
                        isActive
                          ? 'border-purple-400 bg-purple-50 shadow-sm'
                          : 'border-gray-200 bg-white hover:border-purple-200'
                      }`}
                    >
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: v.color }} />
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-gray-800 truncate max-w-[100px]">{v.product_name || `Vial ${idx + 1}`}</p>
                        <p className="text-[10px] text-gray-400">{remaining.toFixed(1)} / {v.volume_ml} ml</p>
                      </div>
                      {isActive && <span className="text-[9px] bg-purple-200 text-purple-700 rounded px-1 font-bold">ACTIVO</span>}
                      <button
                        onClick={e => { e.stopPropagation(); handleRemoveVial(v.id); }}
                        className="text-red-300 hover:text-red-500 ml-1"
                      ><X className="w-3 h-3" /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Main Form */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Type Header - indica el tipo activo del sub-tab */}
        <div className={`p-4 border-b flex items-center gap-3 bg-gradient-to-r ${
          activeType === 'toxina'
            ? 'from-amber-50 to-amber-50/30 border-amber-100'
            : RELLENO_SUBTYPE_COLORS[rellenoSubType].header
        }`}>
          {activeType === 'toxina'
            ? <FlaskConical className="w-5 h-5 text-[#b8944d]" />
            : rellenoSubType === 'hidratacion'
              ? <Pipette className="w-5 h-5 text-sky-600" />
              : rellenoSubType === 'bioestimulador'
                ? <FlaskConical className="w-5 h-5 text-emerald-600" />
                : <Droplets className="w-5 h-5 text-purple-600" />
          }
          <span className={`text-sm font-semibold ${activeType === 'toxina' ? 'text-[#b8944d]' : RELLENO_SUBTYPE_COLORS[rellenoSubType].text}`}>
            {activeType === 'toxina' ? 'Toxina Botulínica' : RELLENO_SUBTYPE_LABELS[rellenoSubType]}
          </span>
          {current.id && (
            <span className="ml-auto text-xs text-gray-400">ID: {current.id}</span>
          )}
        </div>

        <div className="p-5 space-y-5">
          {/* Row 1: Date + Brand + Product Name */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
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
                    value={current.date}
                    onChange={e => setCurrent({ ...current, date: e.target.value })}
                  />
                </div>
                {current.id && dateLocked && (
                  <Tooltip content="Actualizar fecha">
                    <button
                      type="button"
                      onClick={() => setDateLocked(false)}
                      className="p-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors shrink-0"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Marca / Producto{current.product_type === 'toxina' && <FieldHelp text={HELP.toxina.brand} />}</label>
              <input
                type="text"
                list="inj-tab-brands"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.brand}
                onChange={e => setCurrent({ ...current, brand: e.target.value })}
                placeholder={current.product_type === 'toxina' ? 'Ej: BOTOX® 100UI' : 'Ej: Juvederm Ultra'}
              />
              <datalist id="inj-tab-brands">
                {brands.map((b, i) => <option key={i} value={b} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Nombre del Producto <span className="text-red-400">*</span><FieldHelp text={current.product_type === 'toxina' ? HELP.toxina.product_name : HELP.relleno.product_name} /></label>
              <input
                type="text"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.product_name}
                onChange={e => setCurrent({ ...current, product_name: e.target.value })}
                placeholder="Nombre comercial"
              />
            </div>
          </div>

          {/* Row 2: Lot + Expiration + Units/Volume */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Lote</label>
              <input
                type="text"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.lot_number}
                onChange={e => setCurrent({ ...current, lot_number: e.target.value })}
                placeholder="Nro. de lote"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Vencimiento</label>
              <input
                type="date"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.expiration_date}
                onChange={e => setCurrent({ ...current, expiration_date: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">{current.product_type === 'toxina' ? 'Unidades (UI)' : 'Volumen (ml)'}<FieldHelp text={current.product_type === 'toxina' ? HELP.toxina.units_used : HELP.relleno.volume_used} /></label>
              {current.product_type === 'toxina' ? (
                <input
                  type="number"
                  step="0.5"
                  className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                  value={current.units_used}
                  onChange={e => setCurrent({ ...current, units_used: e.target.value })}
                  placeholder="Ej: 20"
                />
              ) : (
                <input
                  type="number"
                  step="0.1"
                  className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                  value={current.volume_used}
                  onChange={e => setCurrent({ ...current, volume_used: e.target.value })}
                  placeholder="Ej: 1.0"
                />
              )}
            </div>
          </div>

          {/* Row 3: Technique + Needle — solo para Toxina */}
          {current.product_type === 'toxina' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Técnica<FieldHelp text={HELP.toxina.technique} /></label>
              <input
                type="text"
                list="inj-tab-techniques"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.technique}
                onChange={e => setCurrent({ ...current, technique: e.target.value })}
                placeholder="Técnica de inyección"
              />
              <datalist id="inj-tab-techniques">
                {techniques.map((t, i) => <option key={i} value={t} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Aguja / Cánula<FieldHelp text={HELP.toxina.needle_type} /></label>
              <input
                type="text"
                list="inj-tab-needles"
                className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none transition-all bg-gray-50/50 focus:bg-white"
                value={current.needle_type}
                onChange={e => setCurrent({ ...current, needle_type: e.target.value })}
                placeholder="Tipo de aguja"
              />
              <datalist id="inj-tab-needles">
                {needles.map((n, i) => <option key={i} value={n} />)}
              </datalist>
            </div>
          </div>
          )} {/* fin condicional toxina Row 3 */}

          {/* Row 4: Dilución (toxina only) + Fecha de control */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {current.product_type === 'toxina' && (
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Dilución (ml SS 0.9%)
                  <span className="ml-1 text-[10px] font-normal text-gray-400 normal-case">— concentración resultante</span>
                  <FieldHelp text={HELP.toxina.dilution_volume} />
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all"
                    value={current.dilution_volume}
                    onChange={e => setCurrent({ ...current, dilution_volume: e.target.value })}
                    placeholder="Ej: 2.5"
                  />
                  {Number(current.dilution_volume) > 0 && Number(current.units_used) > 0 && (
                    <span className="text-xs text-[#b8944d] font-semibold shrink-0 bg-[#deb887]/10 px-2.5 py-1.5 rounded-lg border border-[#deb887]/30">
                      {(Number(current.units_used) / Number(current.dilution_volume)).toFixed(1)} UI/ml
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <Calendar className="w-3.5 h-3.5 text-gray-400" />
                Fecha de Control
                <FieldHelp text={current.product_type === 'toxina' ? HELP.toxina.follow_up_date : HELP.relleno.follow_up_date} />
              </label>
              <input
                type="date"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#deb887] outline-none bg-gray-50/50 focus:bg-white transition-all"
                value={current.follow_up_date}
                onChange={e => setCurrent({ ...current, follow_up_date: e.target.value })}
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700">Observaciones Clínicas</label>
            <textarea
              rows={3}
              className="w-full p-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#deb887] outline-none resize-none transition-all bg-gray-50/50 focus:bg-white"
              value={current.notes}
              onChange={e => setCurrent({ ...current, notes: e.target.value })}
              placeholder="Notas clínicas, reacciones adversas, seguimiento..."
            />
          </div>
        </div>
      </div>

      {/* Vial Summary Bar */}
      {injectionPoints.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Distribución del Vial</p>
            <div className="group relative">
              <Info className="w-3.5 h-3.5 text-gray-300 hover:text-[#deb887] cursor-help transition-colors" />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-64 p-2.5 bg-gray-800 text-white text-[11px] rounded-lg shadow-xl z-50 leading-relaxed">
                <p className="font-semibold mb-1">¿Qué significa cada valor?</p>
                <p><strong>Total Vial:</strong> Cantidad total de producto disponible en el vial.</p>
                <p><strong>Utilizadas:</strong> Suma de unidades aplicadas en todos los puntos marcados.</p>
                <p><strong>Restantes:</strong> Producto sobrante en el vial (Total − Utilizadas).</p>
                <p><strong>Puntos:</strong> Cantidad de sitios de inyección registrados en el mapeo 3D.</p>
                <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-800" />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-white rounded-xl p-3 text-center border border-gray-100 shadow-sm" title="Cantidad total de producto en el vial">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Total Vial</p>
              <p className="text-lg font-bold text-gray-800">{totalVial} <span className="text-xs font-normal text-gray-400">{unitLabel}</span></p>
            </div>
            <div className="bg-white rounded-xl p-3 text-center border border-gray-100 shadow-sm" title="Suma de unidades aplicadas en todos los puntos">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Utilizadas</p>
              <p className="text-lg font-bold text-[#b8944d]">{totalUsed} <span className="text-xs font-normal text-gray-400">{unitLabel}</span></p>
            </div>
            <div className={`rounded-xl p-3 text-center border shadow-sm ${remaining < 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`} title="Producto restante en el vial (Total − Utilizadas)">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Restantes</p>
              <p className={`text-lg font-bold ${remaining < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{remaining} <span className="text-xs font-normal text-gray-400">{unitLabel}</span></p>
            </div>
            <div className="bg-white rounded-xl p-3 text-center border border-gray-100 shadow-sm" title="Cantidad de sitios de inyección marcados">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Puntos</p>
              <p className="text-lg font-bold text-gray-800">{injectionPoints.length}</p>
            </div>
          </div>
        </div>
      )}

      {/* 3D Mapping Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => {
            if (!canMark && !show3D) {
              setMessage({ type: 'error', text: `Complete el nombre del producto y las ${unitLabel} antes de abrir el mapeo 3D` });
              return;
            }
            setShow3D(!show3D);
          }}
          className="w-full flex items-center justify-between p-4 hover:bg-gray-50/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg transition-colors ${show3D ? 'bg-[#deb887]/15' : 'bg-gray-100'}`}>
              <Box className={`w-4 h-4 transition-colors ${show3D ? 'text-[#b8944d]' : 'text-gray-500'}`} />
            </div>
            <div className="text-left">
              <span className="text-sm font-semibold text-gray-800">Mapeo Facial 3D</span>
              <p className="text-xs text-gray-500">Líneas de referencia + marcación de puntos de inyección</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {referenceLines.length > 0 && (
              <span className="bg-[#deb887]/15 text-[#b8944d] text-xs font-bold px-2 py-0.5 rounded-full">
                {referenceLines.length} línea{referenceLines.length !== 1 ? 's' : ''}
              </span>
            )}
            {injectionPoints.length > 0 && (
              <span className="bg-[#deb887]/20 text-[#b8944d] text-xs font-bold px-2 py-0.5 rounded-full">
                {injectionPoints.length} punto{injectionPoints.length !== 1 ? 's' : ''}
              </span>
            )}
            {show3D ? (
              <ChevronUp className="w-4 h-4 text-gray-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            )}
          </div>
        </button>

        <AnimatePresence>
          {show3D && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="border-t border-gray-100"
            >
              {/* ── SIN tabs — la vista es siempre de marcación ── */}

              <div ref={viewerRef} className="p-4">
                {/* ── Toolbar secundaria: Herramientas de Dibujo HA ─────────────── */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5 p-2 bg-slate-900/70 rounded-xl border border-slate-700">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mr-1">Herramienta:</span>

                  {/* Punto de inyección */}
                  <Tooltip content="Punto de inyección (clic en modelo)">
                    <button
                      onClick={() => { setActiveTool('none'); setPointMode(prev => prev === 'add' ? 'none' : 'add'); setShowShapesDropdown(false); setShowHaShapesDropdown(false); }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                        pointMode === 'add' && activeTool === 'none'
                          ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                          : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                      }`}
                    >
                      <Pipette className="w-3 h-3" />
                      Punto
                    </button>
                  </Tooltip>

                  {/* Pincel libre */}
                  <Tooltip content="Pincel: mantener y arrastrar para trazar una línea sobre la piel">
                    <button
                      onClick={() => { setActiveTool(activeTool === 'freehand-brush' ? 'none' : 'freehand-brush'); setPointMode('none'); setShowShapesDropdown(false); setShowHaShapesDropdown(false); }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                        activeTool === 'freehand-brush'
                          ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                          : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                      }`}
                    >
                      <PenLine className="w-3 h-3" />
                      Pincel
                    </button>
                  </Tooltip>

                  {/* Polilínea */}
                  <Tooltip content="Polilínea: clic por vértice, doble-clic para finalizar">
                    <button
                      onClick={() => { setActiveTool(activeTool === 'freehand-poly' ? 'none' : 'freehand-poly'); setPointMode('none'); setShowShapesDropdown(false); setShowHaShapesDropdown(false); }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                        activeTool === 'freehand-poly'
                          ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                          : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                      }`}
                    >
                      <Pentagon className="w-3 h-3" />
                      Polilínea
                    </button>
                  </Tooltip>

                  {/* Grupo: Formas (Círculo + Rectángulo) */}
                  <div className="relative">
                    <button
                      onClick={() => { setShowShapesDropdown(v => !v); setShowHaShapesDropdown(false); }}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                        activeTool === 'shape-circle' || activeTool === 'shape-rect'
                          ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                          : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                      }`}
                    >
                      <Circle className="w-3 h-3" />
                      Formas
                      <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                    </button>
                    {showShapesDropdown && (
                      <div className="absolute left-0 top-full mt-1 z-50 w-36 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl overflow-hidden">
                        <button
                          onClick={() => { setActiveTool(activeTool === 'shape-circle' ? 'none' : 'shape-circle'); setPointMode('none'); setShowShapesDropdown(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold hover:bg-slate-700 transition-colors ${activeTool === 'shape-circle' ? 'text-violet-300' : 'text-slate-300'}`}
                        >
                          <Circle className="w-3 h-3" /> Círculo
                        </button>
                        <button
                          onClick={() => { setActiveTool(activeTool === 'shape-rect' ? 'none' : 'shape-rect'); setPointMode('none'); setShowShapesDropdown(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold hover:bg-slate-700 transition-colors border-t border-slate-700 ${activeTool === 'shape-rect' ? 'text-violet-300' : 'text-slate-300'}`}
                        >
                          <Square className="w-3 h-3" /> Rectángulo
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Herramientas HA (solo para relleno) */}
                  {activeType === 'relleno' && (
                    <>
                      <div className="w-px h-5 bg-slate-600 mx-0.5" />
                      <Tooltip content="Línea recta: arrastrar de A a B sobre la piel">
                        <button
                          onClick={() => { setActiveTool(activeTool === 'straight-line' ? 'none' : 'straight-line'); setPointMode('none'); setShowHaShapesDropdown(false); }}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                            activeTool === 'straight-line' ? 'bg-violet-500/25 text-violet-300 border-violet-500/50' : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                          }`}
                        >
                          <Minus className="w-3 h-3" />
                          Recta
                        </button>
                      </Tooltip>
                      {/* Grupo Patrones HA */}
                      <div className="relative">
                        <button
                          onClick={() => { setShowHaShapesDropdown(v => !v); setShowShapesDropdown(false); }}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-all ${
                            activeTool === 'ha-fan' || activeTool === 'ha-grid' || activeTool === 'ha-fern'
                              ? 'bg-violet-500/25 text-violet-300 border-violet-500/50'
                              : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                          }`}
                        >
                          <span className="text-xs">扇</span>
                          Patrones
                          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                        </button>
                        {showHaShapesDropdown && (
                          <div className="absolute left-0 top-full mt-1 z-50 w-36 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl overflow-hidden">
                            <button onClick={() => { setHaShapeConfigTool('ha-fan'); setHaShapeConfigOpen(true); setPointMode('none'); setShowHaShapesDropdown(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold hover:bg-slate-700 transition-colors ${activeTool === 'ha-fan' ? 'text-violet-300' : 'text-slate-300'}`}>
                              <span className="text-xs">扇</span> Abanico
                            </button>
                            <button onClick={() => { setHaShapeConfigTool('ha-grid'); setHaShapeConfigOpen(true); setPointMode('none'); setShowHaShapesDropdown(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold hover:bg-slate-700 transition-colors border-t border-slate-700 ${activeTool === 'ha-grid' ? 'text-violet-300' : 'text-slate-300'}`}>
                              <span className="text-xs">⊞</span> Malla
                            </button>
                            <button onClick={() => { setHaShapeConfigTool('ha-fern'); setHaShapeConfigOpen(true); setPointMode('none'); setShowHaShapesDropdown(false); }}
                              className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] font-semibold hover:bg-slate-700 transition-colors border-t border-slate-700 ${activeTool === 'ha-fern' ? 'text-violet-300' : 'text-slate-300'}`}>
                              <span className="text-xs">☘</span> Helecho
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  <div className="w-px h-5 bg-slate-700 mx-1" />

                  {/* Color del pincel */}
                  <Tooltip content="Color para nuevas líneas y formas">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <span className="text-[10px] text-slate-400">Color</span>
                      <div className="relative">
                        <div className="w-5 h-5 rounded border border-slate-500 cursor-pointer" style={{ backgroundColor: brushColor }} />
                        <input type="color" className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" value={brushColor} onChange={e => setBrushColor(e.target.value)} />
                      </div>
                    </label>
                  </Tooltip>

                  {/* Grosor del pincel */}
                  <Tooltip content="Grosor de las líneas y formas">
                    <label className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-400">Grosor</span>
                      <input type="range" min={0.5} max={3} step={0.1} value={brushThickness} onChange={e => setBrushThickness(Number(e.target.value))} className="w-16 accent-violet-400" />
                      <span className="text-[10px] text-slate-500 w-5">{brushThickness.toFixed(1)}x</span>
                    </label>
                  </Tooltip>

                  {/* Botón deseleccionar / estado activo */}
                  {(activeTool !== 'none' || pointMode === 'add') ? (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[10px] text-violet-400 font-semibold animate-pulse">
                        {activeTool === 'freehand-brush' && '● Pincel'}
                        {activeTool === 'freehand-poly' && '● Polilínea'}
                        {activeTool === 'straight-line' && '● Recta'}
                        {activeTool === 'shape-circle' && '● Círculo'}
                        {activeTool === 'shape-rect' && '● Rect.'}
                        {activeTool === 'ha-fan' && '● Abanico'}
                        {activeTool === 'ha-grid' && '● Malla'}
                        {activeTool === 'ha-fern' && '● Helecho'}
                        {activeTool === 'none' && pointMode === 'add' && '● Añadir punto'}
                      </span>
                      <button
                        onClick={() => { setActiveTool('none'); setPointMode('none'); }}
                        className="flex items-center gap-1 text-[10px] text-white bg-slate-600 hover:bg-slate-500 border border-slate-500 px-2 py-1 rounded-lg transition-colors font-semibold"
                        title="Deseleccionar herramienta (Escape)"
                      >
                        <X className="w-2.5 h-2.5" /> Quitar
                      </button>
                    </div>
                  ) : (
                    (freehandLines.length > 0 || surfaceShapes.length > 0) && (
                      <span className="ml-auto text-[10px] text-violet-400">
                        {freehandLines.length > 0 && `${freehandLines.length} línea(s)`}
                        {freehandLines.length > 0 && surfaceShapes.length > 0 && ' · '}
                        {surfaceShapes.length > 0 && `${surfaceShapes.length} forma(s)`}
                      </span>
                    )
                  )}
                </div>

                {/* Toolbar: Trazado de Referencia Superior (solo para toxina) */}
                <div className="mb-3 flex flex-wrap items-center gap-2 p-3 bg-slate-800/60 rounded-xl border border-slate-700">
                  {/* Botón Cargar Trazado: solo para toxina */}
                  {activeType === 'toxina' && (
                  <button
                    onClick={handleLoadReferenceJson}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      refJsonLoaded
                        ? 'bg-[#deb887]/20 text-[#deb887] border border-[#deb887]/40 hover:bg-[#deb887]/30'
                        : 'bg-[#deb887] text-white hover:bg-[#c5a075] shadow-md'
                    }`}
                    title="Cargar puntos y líneas del trazado de referencia superior"
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                    {refJsonLoaded ? 'Trazado cargado ✓' : 'Cargar Trazado Superior'}
                  </button>
                  )}

                  {refJsonLoaded && (
                    <>
                      {/* Toggle visibilidad de puntos */}
                      <button
                        onClick={() => setShowEditablePoints(v => !v)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                          showEditablePoints
                            ? 'bg-yellow-400/20 text-yellow-300 border-yellow-500/40 hover:bg-yellow-400/30'
                            : 'bg-gray-600/40 text-gray-400 border-gray-600 hover:bg-gray-600/60'
                        }`}
                        title={showEditablePoints ? 'Ocultar puntos del trazado' : 'Mostrar puntos del trazado'}
                      >
                        <span className="w-2 h-2 rounded-full bg-current inline-block" />
                        {showEditablePoints ? 'Puntos visibles' : 'Puntos ocultos'}
                        <span className="text-[10px] opacity-70">({editablePoints.length})</span>
                      </button>

                      {/* Modo de interacción — Mover y Eliminar (solo con trazado cargado) */}
                      <div className="w-px h-5 bg-slate-600" />
                      <span className="text-xs text-slate-400 font-medium">Modo:</span>
                      {(['none', 'delete'] as const).map(mode => (
                        <button
                          key={mode}
                          onClick={() => setPointMode(prev => prev === mode ? 'none' : mode)}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            pointMode === mode
                              ? mode === 'delete'
                                ? 'bg-red-500/30 text-red-300 border-red-500/50'
                                : 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                              : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                          }`}
                          title={mode === 'none' ? 'Mover puntos (drag)' : 'Eliminar punto al clic'}
                        >
                          {mode === 'none' ? '↔ Mover' : '✕ Eliminar'}
                        </button>
                      ))}
                    </>
                  )}

                  {/* Botón + Añadir: siempre disponible para marcar puntos de inyección libres */}
                  <button
                    onClick={() => { setActiveTool('none'); setPointMode(prev => prev === 'add' ? 'none' : 'add'); }}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      pointMode === 'add'
                        ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                        : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                    }`}
                    title="Añadir punto de inyección en el rostro 3D"
                  >
                    + Añadir
                  </button>

                  {/* Dropdown visibilidad */}
                  <div className="ml-auto flex items-center gap-2">
                    {(referenceLines.length > 0 || editablePoints.length > 0 || injectionPoints.some(ip => ip.units > 0)) && (
                      <div className="relative">
                        <button
                          onClick={() => setShowVisibilityDropdown(v => !v)}
                          onBlur={() => setTimeout(() => setShowVisibilityDropdown(false), 150)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all bg-slate-700/50 text-slate-300 border-slate-600 hover:bg-slate-600"
                          title="Visibilidad del trazado"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Visibilidad
                          <ChevronDown className="w-3 h-3 opacity-60" />
                        </button>
                        {showVisibilityDropdown && (
                          <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-slate-800 border border-slate-600 rounded-xl shadow-2xl overflow-hidden">
                            <button onMouseDown={() => { setShowLines(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors">
                              <span>Líneas de ref.</span>
                              {showLines ? <Eye className="w-3.5 h-3.5 text-[#deb887]" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            <button onMouseDown={() => { setShowBoundaryLines(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700">
                              <span>Líneas de tercios</span>
                              {showBoundaryLines ? <Eye className="w-3.5 h-3.5 text-slate-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            <button onMouseDown={() => { setShowEditablePoints(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700">
                              <span>Puntos del trazado</span>
                              {showEditablePoints ? <Eye className="w-3.5 h-3.5 text-yellow-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            {injectionPoints.some(ip => ip.units > 0) && (
                              <button onMouseDown={() => { setShowUnitNumbers(v => !v); }}
                                className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700">
                                <span>Números de UI</span>
                                {showUnitNumbers ? <Eye className="w-3.5 h-3.5 text-emerald-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                              </button>
                            )}
                            <button
                              onMouseDown={() => { const newVal = !(showLines && showEditablePoints); setShowLines(newVal); setShowEditablePoints(newVal); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700">
                              <span className="font-semibold">{showLines && showEditablePoints ? 'Ocultar todo' : 'Mostrar todo'}</span>
                              {showLines && showEditablePoints ? <EyeOff className="w-3.5 h-3.5 text-slate-400" /> : <Eye className="w-3.5 h-3.5 text-emerald-400" />}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {referenceLines.length > 0 && (
                      <span className="text-[10px] text-slate-400">{referenceLines.length} línea(s)</span>
                    )}
                  </div>
                </div>

                {/* Two-column layout: 3D viewer left, panel right */}
                <div className="flex flex-col lg:flex-row gap-4">
                  {/* Left: 3D Viewer (full width; drawer de líneas se superpone) */}
                  <div className="flex-1 min-w-0">
                    <div className="relative">
                      <Clinical3DViewer
                        markers={markers3D}
                        selectedPathology={current.product_type === 'toxina' ? 'botox' : 'filler'}
                        onMarkerPlaced={handleMarkerPlaced}
                        skipConfirmation={true}
                        readOnly={false}
                        referenceLines={showLines ? referenceLines : []}
                        lineDrawingMode={null}
                        onLinePointAnchored={handleLinePointAnchored}
                        height="420px"
                        editablePoints={editablePoints}
                        showEditablePoints={showEditablePoints}
                        pointMode={activeTool === 'none' ? pointMode : 'none'}
                        onEditablePointMoved={handleEditablePointMoved}
                        onEditablePointDeleted={handleEditablePointDeleted}
                        onEditablePointClicked={handleEditablePointClicked}
                        onProjectedPositions={handleProjectedPositions}
                        tercioBoundaries={showBoundaryLines ? tercioBoundaries : null}
                        selectedPointId={selectedPointId ?? hoveredPointId ?? undefined}
                        freehandLines={freehandLines}
                        surfaceShapes={surfaceShapes}
                        activeTool={activeTool}
                        selectedElementId={selectedElement?.id ?? null}
                        pendingBrushColor={brushColor}
                        pendingBrushThickness={brushThickness}
                        onFreehandLineComplete={handleFreehandComplete}
                        onShapeComplete={handleShapeComplete}
                        onElementSelected={handleElementSelected}
                        onFreehandLineUpdated={handleFreehandLineUpdated}
                        onGridStepChange={setGridDrawStep}
                        onSnapPointChange={setSnapPoint}
                        haShapeConfig={haShapeConfig}
                        incompletePointIds={incompletePointIds}
                        highlightedPointIds={highlightedPointIds}
                        onEditablePointHovered={setHoveredPointId}
                        onBackgroundClick={() => { setActiveTool('none'); setPointMode('none'); }}
                      />

                      {/* Hint visual: snap activo (imán) */}
                      {snapPoint && pointMode === 'add' && (
                        <div className="absolute top-2 left-2 z-30 bg-cyan-700/90 backdrop-blur-sm text-white text-[10px] font-semibold px-2.5 py-1 rounded-lg shadow pointer-events-none flex items-center gap-1.5">
                          <span className="text-yellow-300">◎</span> Snap activo — el punto se colocará sobre la línea
                        </div>
                      )}

                      {/* ── Hint visual del Grid 3-step ── */}
                      {activeTool === 'ha-grid' && gridDrawStep >= 0 && (
                        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 bg-slate-800/90 backdrop-blur-sm text-white text-[11px] font-semibold px-4 py-2 rounded-xl shadow-lg border border-slate-600 pointer-events-none">
                          {gridDrawStep === 0 && '① Haz clic para fijar la primera esquina del mallado'}
                          {gridDrawStep === 1 && '② Mueve el mouse para definir el ancho — clic para confirmar'}
                          {gridDrawStep === 2 && '③ Mueve el mouse para definir el largo — clic para finalizar'}
                        </div>
                      )}

                      {/* ── Panel flotante de propiedades del elemento seleccionado ── */}
                      {selectedElement && selectedElementData && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: -4 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="absolute top-2 right-2 z-30 bg-slate-800/95 backdrop-blur-sm border border-slate-600 rounded-xl p-3 shadow-2xl w-52"
                        >
                          <div className="flex items-center justify-between mb-2.5">
                            <span className="text-[11px] font-semibold text-slate-200 uppercase tracking-wide">
                              {selectedElement.type === 'reference-line' ? 'Línea de ref.' : selectedElement.type === 'freehand' ? 'Línea libre' : 'Forma'}
                            </span>
                            <button
                              onClick={() => setSelectedElement(null)}
                              className="text-slate-400 hover:text-white"
                            ><X className="w-3.5 h-3.5" /></button>
                          </div>
                          {/* Color */}
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-slate-400">Color</span>
                            <div className="relative">
                              <div
                                className="w-6 h-6 rounded border border-slate-500 cursor-pointer"
                                style={{ backgroundColor: (selectedElementData as any).color || '#ffffff' }}
                              />
                              <input
                                type="color"
                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                value={(selectedElementData as any).color || '#ffffff'}
                                onChange={e => handleSelectedColor(e.target.value)}
                              />
                            </div>
                          </div>
                          {/* Grosor */}
                          <div className="mb-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[10px] text-slate-400">Grosor</span>
                              <span className="text-[10px] text-slate-500">{((selectedElementData as any).thickness || 1).toFixed(1)}x</span>
                            </div>
                            <input
                              type="range"
                              min={0.5}
                              max={3}
                              step={0.1}
                              value={(selectedElementData as any).thickness || 1}
                              onChange={e => handleSelectedThickness(Number(e.target.value))}
                              className="w-full accent-violet-400"
                            />
                          </div>
                          {/* Offset solo para reference-lines */}
                          {selectedElement.type === 'reference-line' && (
                            <div className="mb-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] text-slate-400">Offset</span>
                                <span className="text-[10px] text-slate-500">{((selectedElementData as any).offset || 0).toFixed(2)}</span>
                              </div>
                              <input
                                type="range"
                                min={-3}
                                max={3}
                                step={0.05}
                                value={(selectedElementData as any).offset || 0}
                                onChange={e => handleLineOffsetChange(selectedElement.id, Number(e.target.value))}
                                className="w-full accent-yellow-400"
                              />
                            </div>
                          )}
                          {/* Nota: reference-lines no se pueden hacer continuas */}
                          {selectedElement.type === 'reference-line' && (selectedElementData as any).dashed && (
                            <p className="text-[9px] text-slate-500 italic mb-2">Tipo: entrecortada (fija)</p>
                          )}
                          {/* Info de handles para líneas freehand */}
                          {selectedElement.type === 'freehand' && !(selectedElementData as FreehandLine)?.groupId && (
                            <p className="text-[9px] text-slate-400 italic mb-2">
                              🟢 Arrastrar inicio · 🔵 Arrastrar fin · 🟡 Mover línea
                            </p>
                          )}
                          {/* Opciones de eliminación según tipo */}
                          {selectedElement.type === 'freehand' && (selectedElementData as FreehandLine)?.groupId ? (
                            <div className="space-y-1">
                              <button
                                onClick={() => handleDeleteGroup((selectedElementData as FreehandLine).groupId!)}
                                className="w-full text-[11px] text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded-lg py-1 transition-colors font-semibold"
                              >
                                Eliminar forma completa ({freehandLines.filter(l => l.groupId === (selectedElementData as FreehandLine).groupId).length} líneas)
                              </button>
                              <button
                                onClick={handleDeleteSelected}
                                className="w-full text-[10px] text-red-400/60 hover:text-red-300/70 border border-red-500/20 rounded-lg py-0.5 transition-colors"
                              >
                                Solo esta línea
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={handleDeleteSelected}
                              className="w-full text-[11px] text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded-lg py-1 transition-colors"
                            >
                              Eliminar elemento
                            </button>
                          )}
                        </motion.div>
                      )}

                      {/* Unit numbers overlay */}
                      <div
                        ref={unitOverlayRef}
                        className="absolute inset-0 pointer-events-none overflow-hidden"
                        style={{ display: showUnitNumbers ? 'block' : 'none' }}
                      >
                        {injectionPoints.filter(ip => ip.units > 0).map(ip => {
                          const pid = ip.editablePointId || ip.id;
                          if (!pid) return null;
                          return (
                            <span
                              key={pid}
                              data-pid={pid}
                              className="absolute top-0 left-0 font-bold text-white leading-none bg-black/50 rounded-full px-[3px] py-[1.5px] pointer-events-none"
                              style={{ transform: 'translate(0px,0px)', fontSize: 'var(--unit-font-size, 9px)' }}
                            >
                              {ip.units}
                            </span>
                          );
                        })}
                      </div>

                </div>{/* /relative */}

                {/* Bottom bar — controles de puntos + deshacer */}
                {(injectionPoints.length > 0 || undoStack.length > 0 || freehandLines.length > 0 || surfaceShapes.length > 0) && (
                  <div className="mt-3 flex items-center justify-between gap-2 px-1">
                    {/* Estado de puntos y trazados */}
                    <span className="text-xs text-gray-500 shrink-0">
                      {injectionPoints.length > 0 && `${injectionPoints.length} punto(s)`}
                      {injectionPoints.length > 0 && (freehandLines.length > 0 || surfaceShapes.length > 0) && ' · '}
                      {freehandLines.length > 0 && `${freehandLines.length} línea(s)`}
                      {freehandLines.length > 0 && surfaceShapes.length > 0 && ' · '}
                      {surfaceShapes.length > 0 && `${surfaceShapes.length} forma(s)`}
                      {injectionPoints.length === 0 && freehandLines.length === 0 && surfaceShapes.length === 0 && (
                        <span className="italic text-gray-400">Trazado limpiado</span>
                      )}
                    </span>

                    <div className="flex items-center gap-2">
                      {undoStack.length > 0 && (
                        <button
                          onClick={handleUndo}
                          title="Deshacer (Ctrl+Z)"
                          className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 font-medium transition-colors"
                        >
                          <Undo2 className="w-3.5 h-3.5" />
                          Deshacer
                        </button>
                      )}

                      {/* Limpiar trazado libre HA */}
                      {(freehandLines.length > 0 || surfaceShapes.length > 0) && (
                        <button
                          onClick={() => { setFreehandLines([]); setSurfaceShapes([]); setSelectedElement(null); }}
                          className="text-xs text-violet-400 hover:text-violet-600 transition-colors"
                          title="Limpiar líneas y formas trazadas"
                        >
                          Limpiar trazado
                        </button>
                      )}

                      {/* Botón limpiar puntos de inyección */}
                      {injectionPoints.length > 0 && (
                        !showClearConfirm ? (
                          <button
                            onClick={() => setShowClearConfirm(true)}
                            className="text-xs text-red-400 hover:text-red-600 transition-colors"
                          >
                            Limpiar puntos
                          </button>
                        ) : (
                          <AnimatePresence>
                            <motion.div
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.95 }}
                              className="flex items-center gap-1.5 bg-red-50 border border-red-100 px-2 py-1 rounded-lg"
                            >
                              <span className="text-xs text-red-600 font-medium">¿Eliminar todos los puntos?</span>
                              <button
                                onClick={() => {
                                  pushUndo(injectionPoints, markers3D, editablePoints);
                                  setMarkers3D([]);
                                  setInjectionPoints([]);
                                  setEditablePoints([]);
                                  setShowClearConfirm(false);
                                }}
                                className="text-xs font-semibold text-white bg-red-500 hover:bg-red-600 px-2 py-0.5 rounded transition-colors"
                              >
                                Sí
                              </button>
                              <button
                                onClick={() => setShowClearConfirm(false)}
                                className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                              >
                                No
                              </button>
                            </motion.div>
                          </AnimatePresence>
                        )
                      )}
                    </div>
                  </div>
                )}
              </div>{/* /flex-1 */}

                  {/* Right Panel: Desglose de Puntos de Inyección */}
                  <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 flex flex-col min-h-0">
                      {injectionPoints.length > 0 ? (
                      <>
                        <div className="flex items-center gap-1.5 mb-2 flex-shrink-0">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Desglose de Puntos</p>
                          <span className="ml-auto text-[10px] text-gray-400">{injectionPoints.length} punto(s) · {totalUsed} {unitLabel}</span>
                        </div>

                        {/* ── Banner modo selección masiva ── */}
                        {bulkApplyMode && bulkApplySourceIdx !== null && (() => {
                          const src = injectionPoints[bulkApplySourceIdx];
                          return (
                            <div className="flex-shrink-0 mb-2 p-2.5 bg-orange-50 border border-orange-200 rounded-xl shadow-sm">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-bold text-orange-700 uppercase tracking-wide">Selección masiva</span>
                                <button onClick={handleCancelBulkApply} className="text-orange-400 hover:text-orange-600 transition-colors">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <p className="text-[10px] text-orange-600 mb-2 leading-relaxed">
                                {[src?.technique_at_point, src?.needle_at_point, src?.injection_plane].filter(Boolean).join(' · ') || 'Sin valores definidos'}
                              </p>
                              <button
                                onClick={handleApplyBulkSelected}
                                disabled={bulkApplySelected.size === 0}
                                className="w-full py-1.5 rounded-lg bg-orange-500 text-white text-[11px] font-bold hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                {bulkApplySelected.size === 0 ? 'Selecciona puntos ↓' : `Aplicar a ${bulkApplySelected.size} punto(s)`}
                              </button>
                            </div>
                          );
                        })()}

                        <div className="overflow-y-scroll h-[400px] pr-1.5 space-y-2 scrollbar-gold">

                        {/* ── Agrupación por vial (relleno HA) ── */}
                        {current.product_type === 'relleno' && haVials.length > 0
                          ? haVials.map(vial => {
                              const vialPts = injectionPoints.filter(p => p.vial_id === vial.id);
                              const vialUsed = vialPts.reduce((s, p) => s + p.units, 0);
                              const vialEpIds = vialPts.map(p => p.editablePointId).filter(Boolean) as string[];
                              const allVialSelected = vialEpIds.length > 0 && vialEpIds.every(id => bulkApplySelected.has(id));
                              return (
                                <div key={vial.id} className="rounded-xl border border-gray-200 overflow-hidden">
                                  <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
                                    {bulkApplyMode && vialEpIds.length > 0 && (
                                      <button
                                        onClick={() => handleToggleBulkGroup(vialEpIds)}
                                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${allVialSelected ? 'bg-orange-500 border-orange-500' : 'border-gray-300 hover:border-orange-400'}`}
                                      >
                                        {allVialSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                      </button>
                                    )}
                                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: vial.color }} />
                                    <span className="text-xs font-bold text-gray-700 truncate">{vial.product_name || 'Vial'}</span>
                                    <div className="ml-auto flex items-center gap-1.5">
                                      <span className="text-[10px] font-semibold text-gray-500">{vialUsed.toFixed(1)} / {vial.volume_ml} ml</span>
                                    </div>
                                  </div>
                                  {vialPts.length > 0 ? (
                                    <div className="divide-y divide-gray-50">
                                      {vialPts.map(p => {
                                        const globalIdx = injectionPoints.indexOf(p);
                                        const epId = p.editablePointId;
                                        const isSelected = !!epId && epId === selectedPointId;
                                        const isBulkSelected = !!epId && bulkApplySelected.has(epId);
                                        const isExpanded = !bulkApplyMode && expandedPointId === (epId || String(globalIdx));
                                        const expandKey = epId || String(globalIdx);
                                        return (
                                          <div key={globalIdx} className="border-b border-gray-50 last:border-0">
                                            <div
                                              className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                                                bulkApplyMode
                                                  ? (isBulkSelected ? 'bg-orange-50' : 'hover:bg-orange-50/50')
                                                  : (isSelected ? 'bg-violet-50' : 'hover:bg-gray-50')
                                              }`}
                                              onClick={() => {
                                                if (bulkApplyMode) {
                                                  if (epId) handleToggleBulkPoint(epId);
                                                } else {
                                                  if (epId) setSelectedPointId(isSelected ? null : epId);
                                                  setExpandedPointId(isExpanded ? null : expandKey);
                                                }
                                              }}
                                            >
                                              {bulkApplyMode && epId && (
                                                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isBulkSelected ? 'bg-orange-500 border-orange-500' : 'border-gray-300'}`}>
                                                  {isBulkSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                                </div>
                                              )}
                                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                                <span className={`font-mono w-4 flex-shrink-0 ${isSelected ? 'text-violet-600 font-bold' : 'text-gray-400'}`}>{globalIdx + 1}</span>
                                                <span className={`font-medium truncate ${isBulkSelected ? 'text-orange-700' : isSelected ? 'text-violet-700' : 'text-gray-700'}`}>{p.label || '—'}</span>
                                              </div>
                                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                                <span className="font-semibold text-gray-800">{p.units} ml</span>
                                                {!bulkApplyMode && <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />}
                                                {!bulkApplyMode && epId && (
                                                  <button onClick={e => { e.stopPropagation(); handleEditablePointClicked(epId); }} className="p-0.5 text-violet-400 hover:text-violet-600 rounded" title="Editar zona/plano">
                                                    <Pencil className="w-3 h-3" />
                                                  </button>
                                                )}
                                                {!bulkApplyMode && (
                                                  <button onClick={e => { e.stopPropagation(); handleRemovePoint(globalIdx); }} className="p-0.5 text-red-300 hover:text-red-500 rounded">
                                                    <X className="w-3 h-3" />
                                                  </button>
                                                )}
                                              </div>
                                            </div>
                                            {/* Inline editor */}
                                            {isExpanded && !bulkApplyMode && (
                                              <div className="px-3 pb-3 pt-1 bg-violet-50/50 space-y-2 border-t border-violet-100">
                                                <div className="grid grid-cols-2 gap-1.5">
                                                  <div>
                                                    <p className="text-[9px] text-gray-400 mb-0.5">Técnica</p>
                                                    <select
                                                      className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white focus:ring-1 focus:ring-violet-300 outline-none"
                                                      value={p.technique_at_point || ''}
                                                      onChange={e => handlePointFieldChange(globalIdx, 'technique_at_point', e.target.value)}
                                                    >
                                                      <option value="">Por definir</option>
                                                      {techniques.map(t => <option key={t} value={t}>{t}</option>)}
                                                    </select>
                                                  </div>
                                                  <div>
                                                    <p className="text-[9px] text-gray-400 mb-0.5">Cánula/Aguja</p>
                                                    <select
                                                      className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white focus:ring-1 focus:ring-violet-300 outline-none"
                                                      value={p.needle_at_point || ''}
                                                      onChange={e => handlePointFieldChange(globalIdx, 'needle_at_point', e.target.value)}
                                                    >
                                                      <option value="">Por definir</option>
                                                      {needles.map(n => <option key={n} value={n}>{n}</option>)}
                                                    </select>
                                                  </div>
                                                </div>
                                                <div>
                                                  <p className="text-[9px] text-gray-400 mb-0.5">Plano</p>
                                                  <select
                                                    className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white focus:ring-1 focus:ring-violet-300 outline-none"
                                                    value={p.injection_plane || ''}
                                                    onChange={e => handlePointFieldChange(globalIdx, 'injection_plane', e.target.value)}
                                                  >
                                                    <option value="">Por definir</option>
                                                    {HA_PLANES.map(pl => <option key={pl} value={pl}>{pl}</option>)}
                                                  </select>
                                                </div>
                                                <div>
                                                  <p className="text-[9px] text-gray-400 mb-0.5">Nota</p>
                                                  <input
                                                    type="text"
                                                    className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white focus:ring-1 focus:ring-violet-300 outline-none"
                                                    placeholder="Observación..."
                                                    value={p.notes_at_point || ''}
                                                    onChange={e => handlePointFieldChange(globalIdx, 'notes_at_point', e.target.value)}
                                                  />
                                                </div>
                                                <div className="flex gap-1.5">
                                                  <button onClick={() => handleBulkApply(globalIdx)} className="flex-1 text-[10px] py-1 rounded-lg bg-violet-100 text-violet-700 hover:bg-violet-200 font-semibold transition-colors">
                                                    Todos →
                                                  </button>
                                                  <button onClick={() => handleEnterBulkApplyMode(globalIdx)} className="flex-1 text-[10px] py-1 rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200 font-semibold transition-colors">
                                                    Selección →
                                                  </button>
                                                </div>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-gray-400 italic px-3 py-2">Sin puntos en este vial</p>
                                  )}
                                </div>
                              );
                            })
                          : /* ── Agrupación por tercio (toxina + relleno sin viales) ── */
                          (['superior', 'medio', 'inferior'] as const).map(tercio => {
                          const pts = pointsByTercio[tercio];
                          if (!pts || pts.length === 0) return null;
                          const colors = TERCIO_COLORS[tercio];
                          const tercioTotal = pts.reduce((s, p) => s + p.units, 0);
                          const tercioEpIds = pts.map(p => p.editablePointId).filter(Boolean) as string[];
                          const allTercioSelected = tercioEpIds.length > 0 && tercioEpIds.every(id => bulkApplySelected.has(id));
                          return (
                            <div key={tercio} className={`rounded-xl border overflow-hidden ${colors.border}`}>
                              <div className={`flex items-center gap-2 px-3 py-2 ${colors.header}`}>
                                {bulkApplyMode && tercioEpIds.length > 0 && (
                                  <button
                                    onClick={() => handleToggleBulkGroup(tercioEpIds)}
                                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${allTercioSelected ? 'bg-orange-500 border-orange-500' : 'border-gray-400 hover:border-orange-400'}`}
                                  >
                                    {allTercioSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                  </button>
                                )}
                                <span className={`text-xs font-bold ${colors.text}`}>{TERCIO_LABELS[tercio]}</span>
                                <span className={`ml-auto text-[10px] font-semibold ${colors.text}`}>
                                  {pts.length} pto(s) · {tercioTotal} {unitLabel}
                                </span>
                              </div>
                              <div className="divide-y divide-gray-100">
                                {pts.map((p, i) => {
                                  const globalIndex = injectionPoints.indexOf(p);
                                  const rowEpId = p.editablePointId;
                                  const isSelected = !!rowEpId && rowEpId === selectedPointId;
                                  const isBulkSelected = !!rowEpId && bulkApplySelected.has(rowEpId);
                                  const expandKey = rowEpId || String(globalIndex);
                                  const isExpanded = !bulkApplyMode && expandedPointId === expandKey;
                                  return (
                                    <div key={i} className="border-b border-gray-50 last:border-0">
                                      <div
                                        className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                                          bulkApplyMode
                                            ? (isBulkSelected ? 'bg-orange-50' : 'hover:bg-orange-50/50')
                                            : (isSelected ? 'bg-[#deb887]/10' : 'hover:bg-gray-50')
                                        }`}
                                        onClick={() => {
                                          if (bulkApplyMode) {
                                            if (rowEpId) handleToggleBulkPoint(rowEpId);
                                          } else {
                                            if (rowEpId) setSelectedPointId(isSelected ? null : rowEpId);
                                            setExpandedPointId(isExpanded ? null : expandKey);
                                          }
                                        }}
                                      >
                                        {bulkApplyMode && rowEpId && (
                                          <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isBulkSelected ? 'bg-orange-500 border-orange-500' : 'border-gray-300'}`}>
                                            {isBulkSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                          </div>
                                        )}
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                          <span className={`font-mono w-4 flex-shrink-0 ${isBulkSelected ? 'text-orange-600 font-bold' : isSelected ? 'text-[#b8944d] font-bold' : 'text-gray-400'}`}>{globalIndex + 1}</span>
                                          <div className="flex flex-col min-w-0">
                                            <span className={`font-medium truncate ${isBulkSelected ? 'text-orange-700' : isSelected ? 'text-[#b8944d]' : 'text-gray-700'}`}>{p.label || '—'}</span>
                                            {p.injection_plane && <span className="text-[10px] text-[#b8944d]/70 truncate">{p.injection_plane}</span>}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                          <span className="font-semibold text-gray-800">{p.units} {unitLabel}</span>
                                          {!bulkApplyMode && <span className="text-gray-400 w-9 text-right">{totalUsed > 0 ? Math.round((p.units / totalUsed) * 100) : 0}%</span>}
                                          {!bulkApplyMode && rowEpId && (
                                            <button onClick={e => { e.stopPropagation(); handleEditablePointClicked(rowEpId); }} className="p-0.5 text-[#deb887] hover:text-[#b8944d] rounded" title="Editar">
                                              <Pencil className="w-3 h-3" />
                                            </button>
                                          )}
                                          {!bulkApplyMode && (
                                            <button onClick={e => { e.stopPropagation(); handleRemovePoint(globalIndex); }} className="p-0.5 text-red-300 hover:text-red-500 rounded">
                                              <X className="w-3 h-3" />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                      {/* Inline editor */}
                                      {isExpanded && !bulkApplyMode && (
                                        <div className="px-3 pb-3 pt-1 bg-amber-50/50 space-y-2 border-t border-amber-100">
                                          <div className="grid grid-cols-2 gap-1.5">
                                            <div>
                                              <p className="text-[9px] text-gray-400 mb-0.5">Técnica</p>
                                              <select className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none" value={p.technique_at_point || ''} onChange={e => handlePointFieldChange(globalIndex, 'technique_at_point', e.target.value)}>
                                                <option value="">—</option>
                                                {techniques.map(t => <option key={t} value={t}>{t}</option>)}
                                              </select>
                                            </div>
                                            <div>
                                              <p className="text-[9px] text-gray-400 mb-0.5">Aguja</p>
                                              <select className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none" value={p.needle_at_point || ''} onChange={e => handlePointFieldChange(globalIndex, 'needle_at_point', e.target.value)}>
                                                <option value="">—</option>
                                                {needles.map(n => <option key={n} value={n}>{n}</option>)}
                                              </select>
                                            </div>
                                          </div>
                                          <div>
                                            <p className="text-[9px] text-gray-400 mb-0.5">Plano</p>
                                            <select className="w-full text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none" value={p.injection_plane || ''} onChange={e => handlePointFieldChange(globalIndex, 'injection_plane', e.target.value)}>
                                              <option value="">—</option>
                                              {HA_PLANES.map(pl => <option key={pl} value={pl}>{pl}</option>)}
                                            </select>
                                          </div>
                                          <div className="flex gap-1.5">
                                            <button onClick={() => handleBulkApply(globalIndex)} className="flex-1 text-[10px] py-1 rounded-lg bg-amber-100 text-amber-700 hover:bg-amber-200 font-semibold transition-colors">
                                              Todos →
                                            </button>
                                            <button onClick={() => handleEnterBulkApplyMode(globalIndex)} className="flex-1 text-[10px] py-1 rounded-lg bg-orange-100 text-orange-700 hover:bg-orange-200 font-semibold transition-colors">
                                              Selección →
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center">
                        <Crosshair className="w-8 h-8 text-gray-300 mb-2" />
                        <p className="text-sm text-gray-400 font-medium">Sin marcaciones</p>
                        <p className="text-xs text-gray-300 mt-1">Haz clic en el rostro 3D para registrar puntos</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </div>

      {/* ========== MODAL: CONFIRMAR CAMBIO DE TAB ========== */}
      <AnimatePresence>
        {pendingTabSwitch && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-xl ${pendingTabSwitch === 'toxina' ? 'bg-amber-100' : 'bg-purple-100'}`}>
                  {pendingTabSwitch === 'toxina' ? <FlaskConical className="w-5 h-5 text-amber-600" /> : <Droplets className="w-5 h-5 text-purple-600" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">¿Cambiar a {pendingTabSwitch === 'toxina' ? 'Toxina Botulínica' : 'Relleno (HA)'}?</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Tienes trabajo no guardado en este tab</p>
                </div>
              </div>
              <div className="space-y-2">
                {current.product_name.trim() && (
                  <button
                    onClick={() => confirmTabSwitch(true)}
                    className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-[#deb887] text-white font-semibold text-sm hover:bg-[#c5a075] transition-colors"
                  >
                    <Save className="w-4 h-4" />
                    Guardar y cambiar de tab
                  </button>
                )}
                <button
                  onClick={() => confirmTabSwitch(false)}
                  className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 text-red-600 font-semibold text-sm hover:bg-red-100 border border-red-200 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Descartar cambios y cambiar
                </button>
                <button
                  onClick={() => setPendingTabSwitch(null)}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== MODAL: CONFIRMAR CAMBIO DE SUB-TIPO (relleno) ========== */}
      <AnimatePresence>
        {pendingSubTypeSwitch && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-xl ${RELLENO_SUBTYPE_COLORS[pendingSubTypeSwitch].badge}`}>
                  {pendingSubTypeSwitch === 'hidratacion' ? <Pipette className="w-5 h-5" /> : pendingSubTypeSwitch === 'bioestimulador' ? <FlaskConical className="w-5 h-5" /> : <Droplets className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">¿Cambiar a {RELLENO_SUBTYPE_LABELS[pendingSubTypeSwitch]}?</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Tienes trabajo no guardado en este subtratamiento</p>
                </div>
              </div>
              <div className="space-y-2">
                {current.product_name.trim() && (
                  <button
                    onClick={() => confirmSubTypeSwitch(true)}
                    className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-[#deb887] text-white font-semibold text-sm hover:bg-[#c5a075] transition-colors"
                  >
                    <Save className="w-4 h-4" />
                    Guardar y cambiar
                  </button>
                )}
                <button
                  onClick={() => confirmSubTypeSwitch(false)}
                  className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 text-red-600 font-semibold text-sm hover:bg-red-100 border border-red-200 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Descartar y cambiar
                </button>
                <button
                  onClick={() => setPendingSubTypeSwitch(null)}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== MODAL: CONFIGURACIÓN DE FORMAS HA ========== */}
      <AnimatePresence>
        {haShapeConfigOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
            onClick={() => setHaShapeConfigOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-bold text-gray-800">
                    {haShapeConfigTool === 'ha-fan' ? 'Configurar Abanico' : haShapeConfigTool === 'ha-grid' ? 'Configurar Malla' : 'Configurar Helecho'}
                  </h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {haShapeConfigTool === 'ha-fan' ? 'Líneas radiales divergentes desde un punto de entrada' :
                     haShapeConfigTool === 'ha-grid' ? 'Cuadrícula de líneas perpendiculares sobre la piel' :
                     'Línea central con ramificaciones laterales alternadas'}
                  </p>
                </div>
                <button onClick={() => setHaShapeConfigOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Vista previa SVG */}
              <div className="flex justify-center mb-4">
                <svg viewBox="0 0 120 120" width="140" height="140" className="border border-gray-200 rounded-xl bg-slate-50">
                  {haShapeConfigTool === 'ha-fan' && Array.from({ length: haShapeConfig.fanLines }, (_, i) => {
                    const t = haShapeConfig.fanLines === 1 ? 0 : (i / (haShapeConfig.fanLines - 1) - 0.5) * 2;
                    const angleDeg = t * haShapeConfig.fanAngle;
                    const rad = (angleDeg - 90) * Math.PI / 180;
                    const x2 = 60 + Math.cos(rad) * 48;
                    const y2 = 100 + Math.sin(rad) * 48;
                    return <line key={i} x1="60" y1="100" x2={x2} y2={y2} stroke="#8b5cf6" strokeWidth="1.8" strokeLinecap="round" />;
                  })}
                  {haShapeConfigTool === 'ha-grid' && (<>
                    {Array.from({ length: haShapeConfig.gridCells + 1 }, (_, i) => {
                      const x = 15 + (i / haShapeConfig.gridCells) * 90;
                      return <line key={`v${i}`} x1={x} y1="15" x2={x} y2="105" stroke="#8b5cf6" strokeWidth="1.5" />;
                    })}
                    {Array.from({ length: haShapeConfig.gridCells + 1 }, (_, i) => {
                      const y = 15 + (i / haShapeConfig.gridCells) * 90;
                      return <line key={`h${i}`} x1="15" y1={y} x2="105" y2={y} stroke="#8b5cf6" strokeWidth="1.5" />;
                    })}
                  </>)}
                  {haShapeConfigTool === 'ha-fern' && (<>
                    <line x1="60" y1="105" x2="60" y2="15" stroke="#8b5cf6" strokeWidth="2" strokeLinecap="round" />
                    {Array.from({ length: haShapeConfig.fernBranches }, (_, i) => {
                      const t = (i + 1) / (haShapeConfig.fernBranches + 1);
                      const y = 105 - t * 90;
                      const sign = i % 2 === 0 ? 1 : -1;
                      const bLen = 25 * (1 - t * 0.5);
                      return <line key={i} x1="60" y1={y} x2={60 + sign * bLen} y2={y - 16} stroke="#8b5cf6" strokeWidth="1.3" strokeLinecap="round" />;
                    })}
                  </>)}
                </svg>
              </div>

              {/* Controles de configuración */}
              <div className="space-y-3">
                {haShapeConfigTool === 'ha-fan' && (<>
                  <div>
                    <div className="flex justify-between text-[11px] text-gray-600 mb-1">
                      <span>Número de líneas</span><span className="font-bold">{haShapeConfig.fanLines}</span>
                    </div>
                    <input type="range" min={3} max={12} step={1} value={haShapeConfig.fanLines}
                      onChange={e => setHaShapeConfig(c => ({ ...c, fanLines: Number(e.target.value) }))}
                      className="w-full accent-violet-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-gray-600 mb-1">
                      <span>Ángulo de apertura</span><span className="font-bold">{haShapeConfig.fanAngle}°</span>
                    </div>
                    <input type="range" min={10} max={60} step={5} value={haShapeConfig.fanAngle}
                      onChange={e => setHaShapeConfig(c => ({ ...c, fanAngle: Number(e.target.value) }))}
                      className="w-full accent-violet-500" />
                  </div>
                </>)}
                {haShapeConfigTool === 'ha-grid' && (
                  <div>
                    <div className="flex justify-between text-[11px] text-gray-600 mb-1">
                      <span>Celdas por lado</span><span className="font-bold">{haShapeConfig.gridCells}</span>
                    </div>
                    <input type="range" min={2} max={8} step={1} value={haShapeConfig.gridCells}
                      onChange={e => setHaShapeConfig(c => ({ ...c, gridCells: Number(e.target.value) }))}
                      className="w-full accent-violet-500" />
                    <p className="text-[10px] text-gray-400 mt-1">
                      Generará {haShapeConfig.gridCells + 1} × {haShapeConfig.gridCells + 1} = {(haShapeConfig.gridCells + 1) * 2} líneas en total
                    </p>
                  </div>
                )}
                {haShapeConfigTool === 'ha-fern' && (
                  <div>
                    <div className="flex justify-between text-[11px] text-gray-600 mb-1">
                      <span>Número de ramificaciones</span><span className="font-bold">{haShapeConfig.fernBranches}</span>
                    </div>
                    <input type="range" min={2} max={10} step={1} value={haShapeConfig.fernBranches}
                      onChange={e => setHaShapeConfig(c => ({ ...c, fernBranches: Number(e.target.value) }))}
                      className="w-full accent-violet-500" />
                  </div>
                )}
              </div>

              {/* Instrucción + Botones */}
              <p className="text-[10px] text-gray-400 mt-3 text-center">
                {haShapeConfigTool === 'ha-fan' ? 'Clic en la piel → arrastrar para definir longitud y dirección' :
                 haShapeConfigTool === 'ha-grid' ? 'Clic en esquina → arrastrar para definir la diagonal opuesta' :
                 'Clic inicio → arrastrar hasta el extremo del eje central'}
              </p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setHaShapeConfigOpen(false)}
                  className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 font-semibold hover:bg-gray-50">
                  Cancelar
                </button>
                <button
                  onClick={() => { setHaShapeConfigOpen(false); setActiveTool(haShapeConfigTool); setPointMode('none'); }}
                  className="flex-1 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold hover:bg-violet-700 flex items-center justify-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  Trazar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== MODAL: ALERTA DE CAPTURAS / IMPRESIÓN ========== */}
      <AnimatePresence>
        {captureAlert && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
            >
              {captureAlert === 'capture-save-first' ? (
                <>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-xl bg-amber-100">
                      <Images className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-800">Guardar antes de capturar</h3>
                      <p className="text-xs text-gray-500 mt-0.5">Hay marcaciones no guardadas. Guarda primero para tomar capturas del registro.</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <button
                      onClick={async () => {
                        setCaptureAlert(null);
                        await handleSave();
                        setCaptureModalOpen(true);
                      }}
                      className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-[#deb887] text-white font-semibold text-sm hover:bg-[#c5a075] transition-colors"
                    >
                      <Save className="w-4 h-4" />
                      Guardar y abrir capturas
                    </button>
                    <button
                      onClick={() => setCaptureAlert(null)}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-xl bg-blue-100">
                      <Printer className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-800">Sin capturas del mapeo 3D</h3>
                      <p className="text-xs text-gray-500 mt-0.5">El informe no incluirá imágenes del mapeo facial.</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <button
                      onClick={() => { setCaptureAlert(null); setCaptureModalOpen(true); }}
                      className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-[#deb887] text-white font-semibold text-sm hover:bg-[#c5a075] transition-colors"
                    >
                      <Images className="w-4 h-4" />
                      Ir a capturar ahora
                    </button>
                    <button
                      onClick={() => { setCaptureAlert(null); handlePrint(); }}
                      className="w-full flex items-center gap-2 px-4 py-3 rounded-xl bg-gray-100 text-gray-700 font-semibold text-sm hover:bg-gray-200 transition-colors"
                    >
                      <Printer className="w-4 h-4" />
                      Imprimir sin capturas
                    </button>
                    <button
                      onClick={() => setCaptureAlert(null)}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-gray-500 text-sm font-medium hover:bg-gray-50 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== CAPTURE MODAL ========== */}
      <InjectableCaptureModal
        isOpen={captureModalOpen}
        onClose={() => setCaptureModalOpen(false)}
        markers={markers3D}
        productType={current.product_type}
        referenceLines={referenceLines}
        editablePoints={editablePoints}
        freehandLines={freehandLines}
        surfaceShapes={surfaceShapes}
        initialCaptures={capturedImages}
        initialShowLines={showLines}
        initialShowEditablePoints={showEditablePoints}
        injectionPoints={injectionPoints.map(ip => ({ id: ip.id, editablePointId: ip.editablePointId, units: ip.units }))}
        initialShowUnitNumbers={showUnitNumbers}
        onConfirm={(newCaptures) => setCapturedImages(newCaptures)}
      />

      {/* ========== MODAL: UNIDADES PARA PUNTO DEL TRAZADO (multi-paso) ========== */}
      <AnimatePresence>
        {unitsModal?.open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-bold text-gray-800">
                    {current.product_type === 'relleno'
                      ? (unitsModalStep === 1 ? 'Volumen (ml)' : unitsModalStep === 2 ? 'Tercio facial' : 'Zona anatómica')
                      : (unitsModalStep === 1 ? 'Unidades (UI)' : unitsModalStep === 2 ? 'Tercio facial' : unitsModalStep === 3 ? 'Zona anatómica' : 'Plano de inyección')
                    }
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{unitsModal.pointName}</p>
                </div>
                <button
                  onClick={() => { setPendingFreePoint(null); setSelectedPointId(null); setUnitsModal(null); setUnitsModalInput(''); setUnitsModalStep(1); setUnitsModalTercio(''); setUnitsModalZone(''); setUnitsModalPlane(''); setUnitsModalZoneFilter(''); setUnitsModalTecnica(''); }}
                  className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Step progress bar — 4 pasos para toxina, 3 para relleno */}
              <div className="flex gap-1 mb-4">
                {(current.product_type === 'toxina' ? [1, 2, 3, 4] : [1, 2, 3]).map(s => (
                  <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${s <= unitsModalStep ? 'bg-[#deb887]' : 'bg-gray-200'}`} />
                ))}
              </div>

              {/* ═══════════════════════════════════════════════
                  QUICK SAVE — RELLENO HA (solo volumen)
              ═══════════════════════════════════════════════ */}
              {current.product_type === 'relleno' && (
                <div className="mb-4 space-y-3">
                  {/* Vial activo (informativo) */}
                  {activeVial && (
                    <div className="flex items-center gap-2 p-2 bg-gray-50 rounded-xl">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: activeVial.color }} />
                      <span className="text-xs font-semibold text-gray-700 truncate">{activeVial.product_name || 'Vial activo'}</span>
                      <span className="ml-auto text-[10px] text-gray-400">
                        {(activeVial.volume_ml - usedMlByVial(activeVial.id)).toFixed(1)} ml rest.
                      </span>
                    </div>
                  )}
                  {/* ml input */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1.5 uppercase tracking-wide">Volumen (ml)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      autoFocus
                      value={unitsModalInput}
                      onChange={e => setUnitsModalInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleUnitsModalConfirm(); }}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 text-center font-bold text-lg text-gray-800"
                      placeholder="0.0"
                    />
                    {unitsModal.isNewPoint && (
                      <p className="text-[10px] text-gray-400 text-center mt-1">
                        💡 Guarda el volumen y después haz clic sobre el punto para clasificar zona y plano
                      </p>
                    )}
                  </div>
                  {/* Detalle opcional (colapsable) — solo para edición de puntos ya existentes */}
                  {!unitsModal.isNewPoint && (
                    <details className="group">
                      <summary className="text-[11px] text-violet-600 cursor-pointer hover:text-violet-800 font-medium list-none flex items-center gap-1">
                        <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                        + Técnica / Cánula / Plano (opcional)
                      </summary>
                      <div className="mt-2 space-y-2 pt-2 border-t border-gray-100">
                        <div>
                          <p className="text-[10px] text-gray-400 mb-1">Técnica</p>
                          <select
                            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-violet-200 outline-none"
                            value={unitsModalTecnica}
                            onChange={e => setUnitsModalTecnica(e.target.value)}
                          >
                            <option value="">— Por definir —</option>
                            {techniques.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <p className="text-[10px] text-gray-400 mb-1">Plano</p>
                          <select
                            className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:ring-2 focus:ring-violet-200 outline-none"
                            value={unitsModalPlane}
                            onChange={e => setUnitsModalPlane(e.target.value)}
                          >
                            <option value="">— Por definir —</option>
                            {HA_PLANES.map(p => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* ═══════════════════════════════════════════════
                  FLUJO TOXINA — Quick Save paso 1 (solo UI)
              ═══════════════════════════════════════════════ */}
              {/* Step 1: Units — Quick Save */}
              {current.product_type === 'toxina' && unitsModalStep === 1 && (
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
                    Unidades aplicadas (UI)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={unitsModalInput}
                    onChange={e => setUnitsModalInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleUnitsModalConfirm(); }}
                    autoFocus
                    className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#deb887] focus:border-transparent text-center font-bold text-lg text-gray-800"
                    placeholder="0"
                  />
                  {unitsModal.isNewPoint && (
                    <p className="text-[10px] text-gray-400 text-center mt-1.5">
                      💡 Guarda rápido y haz clic sobre el punto para clasificar zona
                    </p>
                  )}
                  {!unitsModal.isNewPoint && unitsModal.existingUnits > 0 && (
                    <p className="text-[11px] text-gray-400 text-center mt-1">
                      Anterior: <strong>{unitsModal.existingUnits}</strong> UI
                    </p>
                  )}
                </div>
              )}

              {/* Step 2: Tercio (ambos tipos) */}
              {unitsModalStep === 2 && (
                <div className="mb-4 space-y-2">
                  {(['superior', 'medio', 'inferior'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setUnitsModalTercio(t)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left text-sm font-semibold transition-all ${
                        unitsModalTercio === t
                          ? `${TERCIO_COLORS[t].bg} ${TERCIO_COLORS[t].border} ${TERCIO_COLORS[t].text} shadow-md`
                          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <div className={`w-3 h-3 rounded-full ${t === 'superior' ? 'bg-[#deb887]' : t === 'medio' ? 'bg-[#c5a075]' : 'bg-amber-400'}`} />
                      {TERCIO_LABELS[t]}
                      {unitsModalTercio === t && <Check className="w-4 h-4 ml-auto" />}
                    </button>
                  ))}
                </div>
              )}

              {/* Step 4: Plano de inyección (solo toxina) */}
              {unitsModalStep === 4 && current.product_type === 'toxina' && (
                <div className="mb-4 space-y-2">
                  {(['Superficial', 'Medio', 'Profundo'] as const).map(plane => (
                    <button
                      key={plane}
                      onClick={() => setUnitsModalPlane(p => p === plane ? '' : plane)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left text-sm font-semibold transition-all ${
                        unitsModalPlane === plane
                          ? 'bg-[#deb887]/10 border-[#deb887] text-[#b8944d] shadow-md'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <div className={`w-3 h-3 rounded-full ${plane === 'Superficial' ? 'bg-sky-400' : plane === 'Medio' ? 'bg-[#deb887]' : 'bg-amber-700'}`} />
                      {plane}
                      {unitsModalPlane === plane && <Check className="w-4 h-4 ml-auto" />}
                    </button>
                  ))}
                  <p className="text-[10px] text-gray-400 text-center pt-1">Opcional — puede omitirse</p>
                </div>
              )}

              {/* Step 3: Zone (ambos tipos) */}
              {unitsModalStep === 3 && unitsModalTercio && (
                <div className="mb-4">
                  <p className={`text-[10px] font-bold uppercase tracking-wider mb-2 ${TERCIO_COLORS[unitsModalTercio].text}`}>
                    {TERCIO_LABELS[unitsModalTercio]}
                  </p>
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#deb887] focus:border-[#deb887] outline-none mb-2"
                    placeholder="Buscar o escribir zona..."
                    value={unitsModalZoneFilter}
                    onChange={e => setUnitsModalZoneFilter(e.target.value)}
                    autoFocus
                  />
                  <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                    {(TERCIO_ZONES[unitsModalTercio] || [])
                      .filter(z => !unitsModalZoneFilter || z.toLowerCase().includes(unitsModalZoneFilter.toLowerCase()))
                      .map(z => (
                        <button
                          key={z}
                          onClick={() => setUnitsModalZone(z)}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${
                            unitsModalZone === z
                              ? `${TERCIO_COLORS[unitsModalTercio].bg} ${TERCIO_COLORS[unitsModalTercio].border} ${TERCIO_COLORS[unitsModalTercio].text} shadow-sm`
                              : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                          }`}
                        >
                          {z}
                        </button>
                      ))}
                  </div>
                  {unitsModalZoneFilter.trim() && (
                    <button
                      onClick={() => setUnitsModalZone(unitsModalZoneFilter.trim())}
                      className="mt-1.5 w-full px-3 py-2 rounded-lg text-xs font-semibold bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100 transition-colors text-left"
                    >
                      {`Usar "${unitsModalZoneFilter.trim()}" →`}
                    </button>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-col gap-2">
                {/* Fila secundaria: Eliminar + Cancelar (solo paso 1) */}
                {unitsModalStep === 1 && (
                  <div className="flex gap-2">
                    {!unitsModal.isNewPoint && (
                      <button
                        onClick={() => {
                          handleEditablePointDeleted(unitsModal.pointId);
                          setSelectedPointId(null);
                          setUnitsModal(null);
                          setUnitsModalInput('');
                          setUnitsModalStep(1);
                          setUnitsModalTercio('');
                          setUnitsModalZone('');
                          setUnitsModalPlane('');
                          setUnitsModalTecnica('');
                        }}
                        className="px-3 py-2.5 rounded-xl border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50 transition-colors flex items-center gap-1"
                        title="Eliminar punto"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => { setPendingFreePoint(null); setSelectedPointId(null); setUnitsModal(null); setUnitsModalInput(''); setUnitsModalStep(1); setUnitsModalTercio(''); setUnitsModalZone(''); setUnitsModalPlane(''); setUnitsModalZoneFilter(''); setUnitsModalTecnica(''); }}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                )}

                {/* Fila principal: Volver + Guardar + Siguiente */}
                <div className="flex gap-2">
                  {/* Volver — pasos 2+ */}
                  {unitsModalStep > 1 && (
                    <button
                      onClick={() => setUnitsModalStep(prev => (prev - 1) as 1 | 2 | 3 | 4)}
                      className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors"
                    >
                      ←
                    </button>
                  )}

                  {/* Guardar — paso 1, paso 3 relleno, paso 4 toxina */}
                  {(unitsModalStep === 1 || (unitsModalStep === 3 && current.product_type !== 'toxina') || unitsModalStep === 4) && (
                    <button
                      onClick={handleUnitsModalConfirm}
                      disabled={!unitsModalInput || Number(unitsModalInput) <= 0}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-[#deb887] text-white text-sm font-semibold hover:bg-[#c5a075] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      <Check className="w-4 h-4" />
                      Guardar
                    </button>
                  )}

                  {/* Siguiente — paso 2 */}
                  {unitsModalStep === 2 && (
                    <button
                      onClick={() => { if (!unitsModalTercio) return; setUnitsModalStep(3); setUnitsModalZoneFilter(''); }}
                      disabled={!unitsModalTercio}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40 flex items-center justify-center gap-1"
                    >
                      Siguiente →
                    </button>
                  )}

                  {/* Siguiente → Plano — paso 3 solo toxina */}
                  {unitsModalStep === 3 && current.product_type === 'toxina' && (
                    <button
                      onClick={() => setUnitsModalStep(4)}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition-colors flex items-center justify-center gap-1"
                    >
                      Siguiente →
                    </button>
                  )}

                  {/* Paso 1: botón para ir a clasificar zona */}
                  {unitsModalStep === 1 && (
                    <button
                      onClick={() => { setUnitsModalStep(2); setUnitsModalZoneFilter(''); }}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors flex items-center justify-center gap-1 text-xs"
                    >
                      + Zona →
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div> {/* end layout principal flex row */}
    </motion.div>
    <CrossConsultHistoryModal
      isOpen={crossHistOpen}
      onClose={() => setCrossHistOpen(false)}
      tabLabel="Inyectables"
      consultations={consultations}
      items={injectables}
      currentConsultationId={consultationId}
      renderItem={inj => (
        <div>
          <p className="font-medium text-gray-800">{inj.product_name || inj.product_type}{inj.brand ? ` — ${inj.brand}` : ''}</p>
          <p className="text-gray-400 capitalize">{inj.product_type}{inj.date ? ` — ${new Date(inj.date).toLocaleDateString('es-EC')}` : ''}</p>
        </div>
      )}
      renderDetail={inj => (
        <>
          <div><span className="text-gray-400">Tipo:</span> <span className="capitalize font-medium">{inj.product_type}</span></div>
          {inj.product_name && <div><span className="text-gray-400">Producto:</span> {inj.product_name}</div>}
          {inj.brand && <div><span className="text-gray-400">Marca:</span> {inj.brand}</div>}
          {inj.units_used > 0 && <div><span className="text-gray-400">Unidades:</span> {inj.units_used} U</div>}
          {inj.volume_used > 0 && <div><span className="text-gray-400">Volumen:</span> {inj.volume_used} mL</div>}
          {inj.technique && <div><span className="text-gray-400">Técnica:</span> {inj.technique}</div>}
          {inj.notes && <div><span className="text-gray-400">Notas:</span> {inj.notes}</div>}
          {inj.date && <div><span className="text-gray-400">Fecha:</span> {new Date(inj.date).toLocaleDateString('es-EC')}</div>}
        </>
      )}
    />
    </>
  );
}
