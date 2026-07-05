import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Droplets, Plus, Save, Trash2, Printer, Copy,
  ChevronDown, ChevronUp, Box, Calendar,
  FlaskConical, Crosshair, X, Check, Info, Images, Minus, Eye, EyeOff, Pencil, AlertCircle, Undo2
} from 'lucide-react';
import { Tooltip } from '../../../../ui/Tooltip';
import injectablesCatalog from '../../data/injectables.json';
import Clinical3DViewer, { Marker3D, EditablePoint } from '../Clinical3DViewer';
import type { ReferenceLine, LineType, ProjectedPosition } from '../Clinical3DViewer';
import InjectableCaptureModal, { CaptureImage } from '../InjectableCaptureModal';
import ReferenceLinePanel from '../ReferenceLinePanel';
import type { LinePreset } from '../ReferenceLinePanel';
import trazadoSuperior from '../../data/trazado-referencia-superior.json';

// ==========================================
// TYPES
// ==========================================

interface Injectable {
  id?: number;
  record_id?: number;
  treatment_id?: number;
  date: string;
  product_type: 'toxina' | 'relleno';
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

interface InjectionPoint extends Marker3D {
  tercio: 'superior' | 'medio' | 'inferior' | '';
  units: number;
  label: string;
  editablePointId?: string;
  injection_plane?: string;
}

interface InjectablesTabProps {
  recordId: number;
  injectables: Injectable[];
  patientName?: string;
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

export default function InjectablesTab({ recordId, injectables: initialInjectables, patientName, onSave }: InjectablesTabProps) {
  const [injectables, setInjectables] = useState<Injectable[]>([]);
  const [current, setCurrent] = useState<Injectable>({ ...EMPTY_INJECTABLE });
  const [dateLocked, setDateLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [show3D, setShow3D] = useState(false);
  const [markers3D, setMarkers3D] = useState<Marker3D[]>([]);
  const [injectionPoints, setInjectionPoints] = useState<InjectionPoint[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  // Capture panel states
  const [captureModalOpen, setCaptureModalOpen] = useState(false);
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

  // Keep ref in sync with state to avoid closure issues in the RAF callback
  useEffect(() => { showUnitNumbersRef.current = showUnitNumbers; }, [showUnitNumbers]);

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
        if (points.length > 0 || rawLines.length > 0 || rawEditablePoints.length > 0) setShow3D(true);
      } catch {
        setInjectionPoints([]);
        setMarkers3D([]);
        setReferenceLines([]);
        setEditablePoints([]);
        setRefJsonLoaded(false);
      }
    } else {
      setInjectionPoints([]);
      setMarkers3D([]);
      setReferenceLines([]);
      setEditablePoints([]);
      setRefJsonLoaded(false);
    }
  }, [current.id]);

  // Auto-dismiss messages
  useEffect(() => {
    if (message) {
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

  // ==========================================
  // HANDLERS
  // ==========================================

  const handleSave = async () => {
    if (!current.product_name.trim()) {
      setMessage({ type: 'error', text: 'El nombre del producto es obligatorio' });
      return;
    }
    setSaving(true);
    try {
      const action = current.id ? 'updateInjectable' : 'addInjectable';
      const derivedAreas = [...new Set(injectionPoints.map(p => p.label).filter(Boolean))];

      // Nuevo formato de mapping_data: incluye referenceLines y editablePoints para persistencia
      const hasData = injectionPoints.length > 0 || referenceLines.length > 0 || editablePoints.length > 0;
      const mappingData = hasData
        ? { injectionPoints, referenceLines, editablePoints }
        : null;

      const payload = {
        ...current,
        record_id: recordId,
        treatment_id: current.treatment_id || null,
        mapping_data: mappingData,
        areas_treated: derivedAreas.length > 0 ? derivedAreas : null,
      };

      const res = await fetch(`/api/records?action=${action}`, {
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

  const handleDelete = async () => {
    if (!current.id || !confirm('¿Eliminar este registro de inyectable?')) return;
    try {
      const res = await fetch(`/api/records?action=deleteInjectable&id=${current.id}`, { method: 'DELETE' });
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

  const handleNew = () => {
    setCurrent({ ...EMPTY_INJECTABLE, date: getLocalDate() });
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
    setDialogPlane('');
    setUndoStack([]);
    setShowClearConfirm(false);
    setIsPendingDuplicate(false);
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
    setUnitsModal({
      open: true,
      pointId: id,
      pointName: pt.name || id,
      existingUnits: existing?.units ?? 0,
      isNewPoint: false,
    });
    setUnitsModalInput(String(existing?.units ?? ''));
    setUnitsModalTercio(autoTercio as 'superior' | 'medio' | 'inferior' | '');
    setUnitsModalZone(existing?.label || '');
    setUnitsModalPlane(existing?.injection_plane || '');
    setUnitsModalZoneFilter('');
    setUnitsModalStep(1);
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
      const freeCount = injectionPoints.filter(ip => ip.label?.startsWith('punto libre')).length;
      const effectiveTercio = (unitsModalTercio || 'superior') as 'superior' | 'medio' | 'inferior';
      const effectiveLabel = unitsModalZone || `punto libre ${freeCount + 1}`;

      // Siempre crear EditablePoint para que sea editable y aparezca en el panel
      const newEp: EditablePoint = {
        id: `free-${Date.now()}`,
        type: 'free',
        x: pendingFreePoint.position.x,
        y: pendingFreePoint.position.y,
        z: pendingFreePoint.position.z,
        lineIds: [],
        name: effectiveLabel,
      };
      setEditablePoints(prev => [...prev, newEp]);

      const newPoint: InjectionPoint = {
        ...pendingFreePoint,
        zone: effectiveLabel,
        tercio: effectiveTercio,
        units,
        label: effectiveLabel,
        editablePointId: newEp.id,
        // Plano solo si el usuario lo seleccionó en Siguiente → paso 4
        ...(unitsModalPlane ? { injection_plane: unitsModalPlane } : {}),
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
      const effectiveLabel = unitsModalZone || existing?.label || unitsModal.pointName;

      const newPoint: InjectionPoint = {
        id: existing?.id,
        type: 'Puntual' as const,
        pathologyId: 'botox',
        position: { x: pt.x, y: pt.y, z: pt.z },
        rotation: [0, 0, 0],
        normal: { x: 0, y: 0, z: 1 },
        zone: effectiveLabel,
        radius: 0.04,
        tercio: effectiveTercio as 'superior' | 'medio' | 'inferior',
        units,
        label: effectiveLabel,
        editablePointId: unitsModal.pointId,
        ...(unitsModalPlane ? { injection_plane: unitsModalPlane } : {}),
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
  };

  // 3D click → abrir modal en paso de UI (unidades)
  const handleMarkerPlaced = (marker: Marker3D) => {
    const isAddMode = (marker as any).isAddPointMode;
    if (!isAddMode && !canMark) {
      setMessage({ type: 'error', text: `Complete el nombre del producto y las ${unitLabel} antes de marcar puntos` });
      return;
    }

    const freeCount = injectionPoints.filter(ip => ip.label?.startsWith('punto libre')).length;
    const autoTercio = tercioBoundaries ? detectTercioFromY(marker.position.y) : '';

    setPendingFreePoint(marker);
    setUnitsModal({
      open: true,
      pointId: 'pending-free',
      pointName: 'Nuevo punto libre',
      existingUnits: 0,
      isNewPoint: true,
    });
    setUnitsModalInput('');
    setUnitsModalTercio(autoTercio as 'superior' | 'medio' | 'inferior' | '');
    setUnitsModalZone(`punto libre ${freeCount + 1}`);
    setUnitsModalZoneFilter('');
    setUnitsModalPlane('');
    setUnitsModalStep(1);
  };

  const handleRemovePoint = (index: number) => {
    pushUndo(injectionPoints, markers3D, editablePoints);
    setInjectionPoints(prev => prev.filter((_, i) => i !== index));
    setMarkers3D(prev => prev.filter((_, i) => i !== index));
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
  <title>Ficha de Inyectable — BIOSKIN</title>
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
      <h1>BIOSKIN</h1>
      <p>Centro de Medicina Estética</p>
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
        <div class="value"><span class="type-badge ${current.product_type === 'toxina' ? 'type-toxina' : 'type-relleno'}">${current.product_type === 'toxina' ? 'Toxina Botulínica' : 'Relleno (Ácido Hialurónico)'}</span></div>
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
      <div class="signature-line">Firma del Profesional</div>
    </div>
    <div class="signature-block">
      <div class="signature-line">Firma del Paciente</div>
    </div>
  </div>

  <div class="footer">
    BIOSKIN — Centro de Medicina Estética · Documento generado el ${new Date().toLocaleString('es-EC')}
  </div>
  <script>window.onload = () => window.print()</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const brands = current.product_type === 'toxina' ? toxinaBrands : rellenoBrands;

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col md:flex-row h-auto md:min-h-[650px] gap-6"
    >
      {/* ========== SIDEBAR — Historial de Inyectables ========== */}
      <div className="w-full md:w-72 border-r-0 md:border-r border-b md:border-b-0 border-gray-100 pr-0 md:pr-6 pb-4 md:pb-0 flex flex-col gap-4 shrink-0">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial de Inyectables
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
          {injectables.length === 0 && !isPendingDuplicate ? (
            <div className="text-gray-400 text-sm text-center py-8 flex flex-col items-center gap-2">
              <AlertCircle className="w-8 h-8 opacity-20" />
              No hay inyectables previos
            </div>
          ) : (
            injectables.map((inj, index) => {
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
          <Tooltip content="Nuevo Inyectable">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={handleNew}
              className="flex items-center justify-center gap-2 w-full px-3 py-2.5 text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-xl border border-gray-200 transition-all"
            >
              <Plus className="w-4 h-4" />
              Nuevo Inyectable
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
                onClick={() => setCaptureModalOpen(true)}
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
                onClick={handlePrint}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200"
              >
                <Printer className="w-5 h-5" />
              </motion.button>
            </Tooltip>
          </div>
        </div>

        {/* Main Form */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Type Toggle - Full Width Header */}
        <div className="p-4 bg-gradient-to-r from-gray-50 to-gray-50/30 border-b border-gray-100">
          <div className="flex items-center gap-4">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tipo de producto</span>
            <div className="flex bg-gray-100 rounded-xl p-1 shadow-inner">
              <button
                onClick={() => setCurrent({ ...current, product_type: 'toxina', brand: '' })}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
                  current.product_type === 'toxina'
                    ? 'bg-white text-[#b8944d] shadow-sm ring-1 ring-[#deb887]'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <FlaskConical className="w-4 h-4" />
                Toxina Botulínica
              </button>
              <button
                onClick={() => setCurrent({ ...current, product_type: 'relleno', brand: '' })}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
                  current.product_type === 'relleno'
                    ? 'bg-white text-[#b8944d] shadow-sm ring-1 ring-[#deb887]'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Droplets className="w-4 h-4" />
                Relleno (HA)
              </button>
            </div>
            {current.id && (
              <span className="ml-auto text-xs text-gray-400">
                ID: {current.id}
              </span>
            )}
          </div>
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
              <label className="block text-sm font-medium text-gray-700">Marca / Producto</label>
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
              <label className="block text-sm font-medium text-gray-700">Nombre del Producto <span className="text-red-400">*</span></label>
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
              <label className="block text-sm font-medium text-gray-700">{current.product_type === 'toxina' ? 'Unidades (UI)' : 'Volumen (ml)'}</label>
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

          {/* Row 3: Technique + Needle */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Técnica</label>
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
              <label className="block text-sm font-medium text-gray-700">Aguja / Cánula</label>
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

          {/* Row 4: Dilución (toxina only) + Fecha de control */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {current.product_type === 'toxina' && (
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  Dilución (ml SS 0.9%)
                  <span className="ml-1 text-[10px] font-normal text-gray-400 normal-case">— concentración resultante</span>
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
                {/* Toolbar: Trazado de Referencia Superior */}
                <div className="mb-3 flex flex-wrap items-center gap-2 p-3 bg-slate-800/60 rounded-xl border border-slate-700">
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
                    onClick={() => setPointMode(prev => prev === 'add' ? 'none' : 'add')}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      pointMode === 'add'
                        ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                        : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-700'
                    }`}
                    title="Añadir punto de inyección en el rostro 3D"
                  >
                    + Añadir
                  </button>

                  {/* Separador + botón para abrir panel de líneas */}
                  <div className="ml-auto flex items-center gap-2">
                    {/* Dropdown visibilidad */}
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
                            <button
                              onMouseDown={() => { setShowLines(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
                            >
                              <span>Líneas de ref.</span>
                              {showLines ? <Eye className="w-3.5 h-3.5 text-[#deb887]" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            <button
                              onMouseDown={() => { setShowBoundaryLines(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700"
                            >
                              <span>Líneas de tercios</span>
                              {showBoundaryLines ? <Eye className="w-3.5 h-3.5 text-slate-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            <button
                              onMouseDown={() => { setShowEditablePoints(v => !v); }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700"
                            >
                              <span>Puntos del trazado</span>
                              {showEditablePoints ? <Eye className="w-3.5 h-3.5 text-yellow-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                            </button>
                            {injectionPoints.some(ip => ip.units > 0) && (
                              <button
                                onMouseDown={() => { setShowUnitNumbers(v => !v); }}
                                className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700"
                              >
                                <span>Números de UI</span>
                                {showUnitNumbers ? <Eye className="w-3.5 h-3.5 text-emerald-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                              </button>
                            )}
                            <button
                              onMouseDown={() => {
                                const newVal = !(showLines && showEditablePoints);
                                setShowLines(newVal);
                                setShowEditablePoints(newVal);
                              }}
                              className="w-full flex items-center justify-between px-3 py-2.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors border-t border-slate-700"
                            >
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
                    <button
                      onClick={() => setShowLinePanel(v => !v)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                        showLinePanel
                          ? 'bg-[#deb887]/25 text-[#deb887] border-[#deb887]/40'
                          : 'bg-slate-700/50 text-slate-400 border-slate-600 hover:bg-slate-600'
                      }`}
                      title="Gestionar líneas de referencia"
                    >
                      <Minus className="w-3.5 h-3.5 rotate-90" />
                      {showLinePanel ? 'Cerrar líneas' : 'Líneas de ref.'}
                    </button>
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
                        lineDrawingMode={showLinePanel ? activeLineType : null}
                        onLinePointAnchored={handleLinePointAnchored}
                        height="420px"
                        editablePoints={editablePoints}
                        showEditablePoints={showEditablePoints}
                        pointMode={pointMode}
                        onEditablePointMoved={handleEditablePointMoved}
                        onEditablePointDeleted={handleEditablePointDeleted}
                        onEditablePointClicked={handleEditablePointClicked}
                        onProjectedPositions={handleProjectedPositions}
                        tercioBoundaries={showBoundaryLines ? tercioBoundaries : null}
                        selectedPointId={selectedPointId ?? undefined}
                      />

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

                  {/* Drawer de Líneas de Referencia — overlay sobre el viewer */}
                  <AnimatePresence>
                    {showLinePanel && (
                      <motion.div
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="absolute top-0 right-0 h-full w-72 z-20 bg-slate-800/95 backdrop-blur-sm rounded-xl shadow-2xl overflow-y-auto"
                      >
                        <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-slate-700">
                          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Líneas de Referencia</span>
                          <button
                            onClick={() => { setShowLinePanel(false); handleCancelLine(); }}
                            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <ReferenceLinePanel
                          lines={referenceLines}
                          activeType={activeLineType}
                          pendingTwoPointStep={twoPointStep}
                          pendingLabel={pendingLineMeta?.label || ''}
                          onSelectPreset={handleSelectPreset}
                          onStartManual={handleStartManualLine}
                          onLabelChange={handleLineLabelChange}
                          onCancel={handleCancelLine}
                          onToggleVisibility={handleToggleLineVisibility}
                          onOffsetChange={handleLineOffsetChange}
                          onRemove={handleRemoveLine}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>{/* /relative */}

                {/* Bottom bar — controles de puntos + deshacer */}
                {(injectionPoints.length > 0 || undoStack.length > 0) && (
                  <div className="mt-3 flex items-center justify-between gap-2 px-1">
                    {/* Estado de puntos */}
                    <span className="text-xs text-gray-500 shrink-0">
                      {injectionPoints.length > 0
                        ? `${injectionPoints.length} punto(s) · ${totalUsed} ${unitLabel} aplicadas`
                        : <span className="italic text-gray-400">Puntos limpiados</span>
                      }
                    </span>

                    <div className="flex items-center gap-2">
                      {/* Botón deshacer — visible cuando hay acciones en el stack */}
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

                      {/* Botón limpiar todos con confirmación */}
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
                          <div className="group relative">
                            <Info className="w-3.5 h-3.5 text-gray-300 hover:text-[#deb887] cursor-help transition-colors" />
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-64 p-2.5 bg-gray-800 text-white text-[11px] rounded-lg shadow-xl z-50 leading-relaxed">
                              <p className="font-semibold mb-1">Desglose de puntos de inyección</p>
                              <p>Cada punto de inyección se clasifica por <strong>tercio facial</strong> (superior, medio, inferior).</p>
                              <p className="mt-1"><strong>Zona:</strong> Área anatómica del punto de inyección.</p>
                              <p><strong>{unitLabel}:</strong> {current.product_type === 'toxina' ? 'Unidades internacionales' : 'Mililitros'} aplicadas en ese punto.</p>
                              <p><strong>% Dosis:</strong> Porcentaje que representan las unidades de ese punto respecto al <em>total de unidades aplicadas</em> en todos los puntos.</p>
                              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-800" />
                            </div>
                          </div>
                        </div>
                        <div className="overflow-y-scroll h-[400px] pr-1.5 space-y-2 scrollbar-gold">
                        {(['superior', 'medio', 'inferior'] as const).map(tercio => {
                          const pts = pointsByTercio[tercio];
                          if (!pts || pts.length === 0) return null;
                          const colors = TERCIO_COLORS[tercio];
                          const tercioTotal = pts.reduce((s, p) => s + p.units, 0);
                          return (
                            <div key={tercio} className={`rounded-xl border overflow-hidden ${colors.border}`}>
                              <div className={`flex items-center justify-between px-3 py-2 ${colors.header}`}>
                                <span className={`text-xs font-bold ${colors.text}`}>{TERCIO_LABELS[tercio]}</span>
                                <span className={`text-[10px] font-semibold ${colors.text}`}>
                                  {pts.length} pto(s) · {tercioTotal} {unitLabel}
                                </span>
                              </div>
                              <div className="divide-y divide-gray-100">
                                {pts.map((p, i) => {
                                  const globalIndex = injectionPoints.indexOf(p);
                                  const rowEpId = p.editablePointId;
                                  const isSelected = !!rowEpId && rowEpId === selectedPointId;
                                  return (
                                    <div
                                      key={i}
                                      className={`flex items-center justify-between px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                                        isSelected ? 'bg-[#deb887]/10 ring-1 ring-inset ring-[#deb887]/40' : 'hover:bg-gray-50'
                                      }`}
                                      onClick={() => { if (rowEpId) setSelectedPointId(isSelected ? null : rowEpId); }}
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className={`font-mono w-4 flex-shrink-0 ${isSelected ? 'text-[#b8944d] font-bold' : 'text-gray-400'}`}>{globalIndex + 1}</span>
                                        <div className="flex flex-col min-w-0">
                                          <span className={`font-medium truncate ${isSelected ? 'text-[#b8944d]' : 'text-gray-700'}`}>{p.label || '—'}</span>
                                          {p.injection_plane && (
                                            <span className="text-[10px] text-[#b8944d]/70 truncate">{p.injection_plane}</span>
                                          )}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <span className="font-semibold text-gray-800">{p.units} {unitLabel}</span>
                                        <span className="text-gray-400 w-9 text-right cursor-help" title={`${totalUsed > 0 ? Math.round((p.units / totalUsed) * 100) : 0}% del total de ${totalUsed} ${unitLabel} aplicadas`}>{totalUsed > 0 ? Math.round((p.units / totalUsed) * 100) : 0}%</span>
                                        {/* Editar — abre modal si tiene editablePointId */}
                                        {rowEpId && (
                                          <button
                                            onClick={e => { e.stopPropagation(); handleEditablePointClicked(rowEpId); }}
                                            className="p-0.5 text-[#deb887] hover:text-[#b8944d] hover:bg-[#deb887]/10 rounded transition-colors"
                                            title="Editar punto"
                                          >
                                            <Pencil className="w-3 h-3" />
                                          </button>
                                        )}
                                        <button
                                          onClick={e => { e.stopPropagation(); handleRemovePoint(globalIndex); }}
                                          className="p-0.5 text-red-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                                          title="Eliminar punto"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </div>
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

      {/* ========== CAPTURE MODAL ========== */}
      <InjectableCaptureModal
        isOpen={captureModalOpen}
        onClose={() => setCaptureModalOpen(false)}
        markers={markers3D}
        productType={current.product_type}
        referenceLines={referenceLines}
        editablePoints={editablePoints}
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
                    {unitsModalStep === 1 ? 'Registrar inyección' :
                     unitsModalStep === 2 ? 'Seleccionar tercio' :
                     unitsModalStep === 3 ? 'Seleccionar zona' :
                     'Plano de inyección'}
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{unitsModal.pointName}</p>
                </div>
                <button
                  onClick={() => { setPendingFreePoint(null); setSelectedPointId(null); setUnitsModal(null); setUnitsModalInput(''); setUnitsModalStep(1); setUnitsModalTercio(''); setUnitsModalZone(''); setUnitsModalPlane(''); setUnitsModalZoneFilter(''); }}
                  className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Step progress bar */}
              <div className="flex gap-1 mb-4">
                {[1, 2, 3, 4].map(s => (
                  <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${s <= unitsModalStep ? 'bg-[#deb887]' : 'bg-gray-200'}`} />
                ))}
              </div>

              {/* Step 1: Units */}
              {unitsModalStep === 1 && (
                <div className="mb-4">
                  {(unitsModalTercio || unitsModalZone || unitsModalPlane) && (
                    <div className="flex flex-wrap gap-1 mb-3 p-2 bg-gray-50 rounded-lg">
                      {unitsModalTercio && <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${TERCIO_COLORS[unitsModalTercio]?.badge || 'bg-gray-100 text-gray-600'}`}>{TERCIO_LABELS[unitsModalTercio]}</span>}
                      {unitsModalZone && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-semibold">{unitsModalZone}</span>}
                      {unitsModalPlane && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#deb887]/15 text-[#b8944d] font-semibold">{unitsModalPlane}</span>}
                    </div>
                  )}
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">
                    {current.product_type === 'toxina' ? 'Unidades (UI)' : 'Volumen (ml)'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step={current.product_type === 'toxina' ? '1' : '0.1'}
                    value={unitsModalInput}
                    onChange={e => setUnitsModalInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleUnitsModalConfirm(); }}
                    autoFocus
                    className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#deb887] focus:border-transparent text-center font-bold text-lg text-gray-800"
                    placeholder="0"
                  />
                  {unitsModal.existingUnits > 0 && (
                    <p className="text-[11px] text-gray-400 text-center mt-1">
                      Anterior: <strong>{unitsModal.existingUnits}</strong> {current.product_type === 'toxina' ? 'UI' : 'ml'}
                    </p>
                  )}
                </div>
              )}

              {/* Step 2: Tercio */}
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

              {/* Step 3: Zone */}
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
                      Usar &quot;{unitsModalZoneFilter.trim()}&quot; →
                    </button>
                  )}
                </div>
              )}

              {/* Step 4: Injection Plane */}
              {unitsModalStep === 4 && (
                <div className="mb-4">
                  <p className="text-xs text-gray-400 mb-2">Selecciona el plano de inyección (opcional).</p>
                  <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
                    {(['superficial', 'medio', 'profundo'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => setUnitsModalPlane(p)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all ${unitsModalPlane === p ? 'bg-violet-100 border-violet-400 text-violet-700 shadow-sm' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-col gap-2">
                {/* Fila secundaria: Eliminar + Cancelar (solo paso 1) */}
                {unitsModalStep === 1 && (
                  <div className="flex gap-2">
                    {/* Eliminar — solo para puntos ya existentes */}
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
                        }}
                        className="px-3 py-2.5 rounded-xl border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50 transition-colors flex items-center gap-1"
                        title="Eliminar punto"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => { setPendingFreePoint(null); setSelectedPointId(null); setUnitsModal(null); setUnitsModalInput(''); setUnitsModalStep(1); setUnitsModalTercio(''); setUnitsModalZone(''); setUnitsModalPlane(''); setUnitsModalZoneFilter(''); }}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                )}

                {/* Fila principal: Volver (pasos 2-4) + Guardar + Siguiente (pasos 1-3) */}
                <div className="flex gap-2">
                  {/* Volver — pasos 2-4 */}
                  {unitsModalStep > 1 && (
                    <button
                      onClick={() => setUnitsModalStep(prev => (prev - 1) as 1 | 2 | 3 | 4)}
                      className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 transition-colors"
                    >
                      ←
                    </button>
                  )}

                  {/* Guardar — siempre disponible */}
                  <button
                    onClick={handleUnitsModalConfirm}
                    disabled={!unitsModalInput || Number(unitsModalInput) <= 0}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-[#deb887] text-white text-sm font-semibold hover:bg-[#c5a075] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    Guardar
                  </button>

                  {/* Siguiente — pasos 1-3 */}
                  {unitsModalStep < 4 && (
                    <button
                      onClick={() => {
                        if (unitsModalStep === 2 && !unitsModalTercio) return;
                        setUnitsModalStep(prev => (prev + 1) as 2 | 3 | 4);
                        setUnitsModalZoneFilter('');
                      }}
                      disabled={unitsModalStep === 2 && !unitsModalTercio}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40 flex items-center justify-center gap-1"
                    >
                      Siguiente →
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
