import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import recordsFetch from "../../../../../utils/recordsFetch";
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Plus, Trash2, Copy, Printer, Info, Edit2, Check, Eye, EyeOff, History, Grid3X3, UserRound, ScanFace, Columns2 } from 'lucide-react';
import CrossConsultHistoryModal, { type ConsultationRef } from '../CrossConsultHistoryModal';
import { CLINICAL_FIELDS, LESION_CATALOG, PARAMETER_TOOLTIPS } from '../../../../../data/clinical-catalogs';
import { Mark } from '../FaceMapCanvas';
import Clinical3DViewer from '../Clinical3DViewer';
import type { Marker3D } from '../Clinical3DViewer';
import type { ReferenceLine } from '../ReferenceLinePanel';
import { Tooltip } from '../../../../ui/Tooltip';
import { Select } from '../../../../ui/Select';
import trazadoData from '../../data/trazado-referencia-superior.json';
import FieldHelp from '../FieldHelp';
import { HELP } from '../../data/fieldHelpTexts';
import { Dialog } from '../../../../ui/Dialog';
import { isZonalSkinMark, skinReviewSummaries } from '../skinEvaluation';
import type { EvaluationMark, PersistedSkinReview } from '../skinEvaluation';
import type { SkinExamSave } from '../SkinExamWorkspace';
import type { EditablePoint } from '../Clinical3DViewer';
import SkinMarkControls, { SkinMarkLegend } from '../SkinMarkControls';
import { SkinEditHistory } from '../skinEditHistory';
import type { SkinVisualReviewData } from '../skinVisualAI';
import { COLORS } from '../../../../../constants/theme';
import { useUnsavedChangesGuard } from '../../../../../hooks/useUnsavedChangesGuard';
import type { FaceSimIntegration } from '../../../../../lab/faceSim/facialSimulationSession';
import { legacySkinAnchor, skinAnatomicalOverlay, skinZoneAt } from '../skinAnatomy';
import { useAuth } from '../../../../../context/AuthContext';

const SkinExamWorkspace = lazy(() => import('../SkinExamWorkspace'));
const NO_VIEWER_MARKERS: Marker3D[] = [];
const PHOTOTYPE_COLORS: Record<string, string> = { I: '#f5dece', II: '#e8c0a3', III: '#d3a27e', IV: '#b67f59', V: '#8b573b', VI: '#593b2b' };

// -- Constantes para el visor 3D facial ----------------------------------------
const TERCIO_BOUNDARIES = (trazadoData as { hairline: {
  topY: number; bottomY: number;
  tercioMedioBottomY: number; tercioInferiorBottomY: number;
} }).hairline;
// Límite lateral: líneas verticales desplazadas hacia afuera (zona sien/temporal)
const COLA_CEJA_X_LEFT  = -1.0;
const COLA_CEJA_X_RIGHT =  1.0;
const COLA_CEJA_X       =  1.0; // umbral de detección lateral
// Líneas verticales imaginarias en cola de ceja: de frente-hairline hasta mentón
const FACE_Y_MAX = 2.2;
const FACE_Y_MIN = -2.5;
const COLA_CEJA_VERTICALS: ReferenceLine[] = [
  {
    id: 'ceja-vert-izq',
    type: 'vertical',
    label: 'Límite lateral Izq.',
    color: '#38bdf8',
    visible: true,
    dashed: true,
    anchor: { x: COLA_CEJA_X_LEFT, y: 0, z: 0 },
    offset: 0,
    yMin: FACE_Y_MIN,
    yMax: FACE_Y_MAX,
  },
  {
    id: 'ceja-vert-der',
    type: 'vertical',
    label: 'Límite lateral Der.',
    color: '#38bdf8',
    visible: true,
    dashed: true,
    anchor: { x: COLA_CEJA_X_RIGHT, y: 0, z: 0 },
    offset: 0,
    yMin: FACE_Y_MIN,
    yMax: FACE_Y_MAX,
  },
];

const FACE_REFERENCE_LINES: ReferenceLine[] = [
  ...COLA_CEJA_VERTICALS,
];

// -- Zonas sugeridas por tercio (anatómicamente correctas, piel del rostro) ----
// Tercio superior: frente - desde cejas hasta nacimiento del cabello
const ZONES_SUPERIOR = [
  'Frente central',
  'Frente lateral',
  'Glabela',
  'Entrecejo',
  'Región superciliar (cejas)',
  'Cola de ceja',
  'Líneas de expresión frontal',
  'Región temporal superior',
];
// Tercio medio: zona ocular, nasal y malar - desde base del ojo hasta base de nariz
const ZONES_MEDIO = [
  'Párpado superior',
  'Párpado inferior',
  'Surco palpebral inferior (ojeras)',
  'Valle de lágrimas',
  'Región infraorbitaria',
  'Patas de gallo',
  'Dorso nasal',
  'Punta nasal',
  'Alas nasales',
  'Pómulo / región malar',
  'Mejilla',
  'Surco nasogeniano',
  'Región cigomática',
];
// Tercio inferior: perioral, mentón y mandíbula - desde base de nariz hasta límite inferior
const ZONES_INFERIOR = [
  'Labio superior',
  'Labio inferior',
  'Filtrum (surco subnasal)',
  'Comisuras labiales',
  'Surco perioral (código de barras)',
  'Surco marioneta',
  'Mentón',
  'Región mentoniana',
  'Área submentoniana / papada',
  'Línea mandibular',
];
const ZONES_LATERAL = [
  'Sien',
  'Región preauricular',
  'Oreja',
  'Región retroauricular',
  'Nuca',
  'Cabeza',
];
const ZONES_CUELLO = [
  'Mandíbula',
  'Ángulo mandibular',
  'Área submentoniana',
  'Cuello anterior',
  'Cuello lateral',
];

// Zonas corporales agrupadas por región (sin detección automática)
const BODY_ZONE_GROUPS = [
  { region: 'Cabeza y Cuello', zones: ['Cuero cabelludo', 'Frente / Sien', 'Mejilla', 'Barbilla', 'Cuello anterior', 'Cuello posterior / Nuca'] },
  { region: 'Tórax Anterior', zones: ['Escote / Décolleté', 'Pecho superior', 'Pecho inferior / Surco intermamario', 'Abdomen superior', 'Abdomen inferior', 'Zona periumbilical', 'Flancos'] },
  { region: 'Tórax Posterior', zones: ['Espalda superior', 'Región escapular', 'Espalda media', 'Espalda inferior / Lumbar', 'Zona sacra'] },
  { region: 'Miembro Superior', zones: ['Hombro', 'Brazo anterior', 'Brazo posterior', 'Pliegue del codo', 'Antebrazo', 'Muñeca', 'Dorso de la mano', 'Palma / Dedos'] },
  { region: 'Glúteos y Cadera', zones: ['Glúteo superior', 'Glúteo inferior / Pliegue subglúteo', 'Cadera / Trocánter mayor', 'Región inguinal'] },
  { region: 'Miembro Inferior', zones: ['Muslo anterior', 'Muslo posterior', 'Cara interna del muslo', 'Rodilla', 'Pantorrilla', 'Cara posterior de la pierna', 'Tobillo', 'Dorso del pie', 'Planta / Dedos'] },
];

interface FacialRegion { tercio: string; suggestions: string[] }

function getFacialRegion(pos: { x: number; y: number; z: number }): FacialRegion {
  const { x, y } = pos;
  if (Math.abs(x) > COLA_CEJA_X) {
    return { tercio: 'Zona Lateral', suggestions: ZONES_LATERAL };
  }
  if (y > TERCIO_BOUNDARIES.bottomY) {
    return { tercio: 'Tercio Superior', suggestions: ZONES_SUPERIOR };
  }
  if (y > TERCIO_BOUNDARIES.tercioMedioBottomY) {
    return { tercio: 'Tercio Medio', suggestions: ZONES_MEDIO };
  }
  if (y > TERCIO_BOUNDARIES.tercioInferiorBottomY) {
    return { tercio: 'Tercio Inferior', suggestions: ZONES_INFERIOR };
  }
  return { tercio: 'Zona Inferior / Cuello', suggestions: ZONES_CUELLO };
}

interface PhysicalExam {
  id?: number;
  record_id: number;
  consultation_id?: number;
  skin_type: string;
  phototype: string;
  glogau_scale: string;
  hydration: string;
  elasticity: string;
  lesions_description: string;
  photoprotection?: string;
  texture?: string;
  pores?: string;
  pigmentation?: string;
  sensitivity?: string;
  face_map_data?: string | Mark[];
  skin_visual_review?: string | SkinVisualReviewData | PersistedSkinReview;
  body_map_data?: string | Mark[];
  created_at?: string;
}

interface PhysicalExamTabProps {
  recordId: number;
  physicalExams: PhysicalExam[];
  patientName: string;
  consultationId?: number;
  consultations?: ConsultationRef[];
  onSave: () => void;
}

const EMPTY_EXAM: Omit<PhysicalExam, 'record_id'> = {
  skin_type: '',
  phototype: '',
  glogau_scale: '',
  hydration: '',
  elasticity: '',
  lesions_description: '',
  photoprotection: '',
  texture: '',
  pores: '',
  pigmentation: '',
  sensitivity: '',
  face_map_data: '[]',
  body_map_data: '[]'
};

// Modal Component for Editing Marks
const MarkEditModal = ({
  mark, onSave, onCancel, categories, onMove,
  tercio, suggestedZones, zoneGroups,
}: {
  mark: Mark;
  onSave: (m: Mark) => void;
  onCancel: () => void;
  onMove?: (mark: Mark) => void;
  categories: string[];
  tercio?: string;
  suggestedZones?: string[];
  zoneGroups?: { region: string; zones: string[] }[];
}) => {
  const [editedMark, setEditedMark] = useState<Mark>({
    ...mark,
    distribution: mark.distribution || 'puntual',
    severity: mark.severity || 'leve'
  });

  return (
    <Dialog open onClose={onCancel} labelledBy="lesion-details-title">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-gray-100 bg-white p-6 shadow-2xl"
      >
        <h3 id="lesion-details-title" className="text-xl font-bold mb-4 text-gray-800 flex items-center gap-2 border-b border-gray-100 pb-4">
          <div className="w-1.5 h-6 bg-[#deb887] rounded-full" />
          Detalles de la Lesión
          {tercio && (
            <span className="ml-auto text-xs font-semibold px-2.5 py-1 rounded-full bg-[#deb887]/15 text-[#b8956a] border border-[#deb887]/30">
              {tercio}
            </span>
          )}
        </h3>
        
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Tipo de Lesión</label>
            <input 
              list="lesion-options-modal"
              value={editedMark.category}
              onChange={e => setEditedMark({...editedMark, category: e.target.value})}
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all bg-gray-50/50 focus:bg-white"
              placeholder="Seleccione o escriba..."
            />
            <datalist id="lesion-options-modal">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Severidad / Grado</label>
            <Select 
              value={editedMark.severity ?? ''}
              onChange={val => setEditedMark({...editedMark, severity: val as Mark['severity']})}
              options={[
                { value: "leve", label: "Leve" },
                { value: "moderado", label: "Moderado" },
                { value: "severo", label: "Severo" },
                { value: "profundo", label: "Profundo" }
              ]}
              placeholder="Seleccionar..."
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Distribución</label>
            <div className="flex gap-4 p-3 bg-gray-50 rounded-xl border border-gray-100">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input 
                  type="radio" 
                  name="distribution" 
                  value="puntual"
                  checked={editedMark.distribution === 'puntual'}
                  onChange={() => setEditedMark({...editedMark, distribution: 'puntual'})}
                  className="text-[#deb887] focus:ring-[#deb887]"
                />
                <span className="text-sm group-hover:text-[#deb887] transition-colors font-medium">Puntual</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input 
                  type="radio" 
                  name="distribution" 
                  value="zonal"
                  checked={editedMark.distribution === 'zonal'}
                  onChange={() => setEditedMark({...editedMark, distribution: 'zonal'})}
                  className="text-[#deb887] focus:ring-[#deb887]"
                />
                <span className="text-sm group-hover:text-[#deb887] transition-colors font-medium">Zonal (Área aproximada)</span>
              </label>
            </div>
          </div>

          {mark.is3D && <label className="block text-sm font-semibold text-gray-700">Tamaño de la marca
            <input aria-label="Tamaño de la marca anatómica" className="mt-2 w-full" type="range"
              min={editedMark.distribution === 'zonal' ? .06 : .08} max={editedMark.distribution === 'zonal' ? 1.5 : .32}
              step=".01" value={editedMark.radius3D ?? .16}
              onChange={event => setEditedMark({ ...editedMark, radius3D: Number(event.target.value) })} /></label>}

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Zona / Ubicación</label>
            {/* Grouped body zones — rendered when zoneGroups provided */}
            {zoneGroups && zoneGroups.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-2 bg-gray-50/60 rounded-xl border border-gray-100 p-2">
                {zoneGroups.map(g => (
                  <div key={g.region}>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1 mb-1">{g.region}</p>
                    <div className="flex flex-wrap gap-1 mb-1">
                      {g.zones.map(z => (
                        <button key={z} type="button"
                          onClick={() => setEditedMark({ ...editedMark, notes: z })}
                          className={`text-xs px-2 py-0.5 rounded-full border transition-all ${
                            editedMark.notes === z
                              ? 'bg-[#deb887] text-white border-[#deb887]'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-[#deb887] hover:text-[#b8956a]'
                          }`}
                        >{z}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Flat suggested zones — rendered when suggestedZones provided (facial) */}
            {!zoneGroups && suggestedZones && suggestedZones.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {suggestedZones.map(z => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setEditedMark({ ...editedMark, notes: z })}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                      editedMark.notes === z
                        ? 'bg-[#deb887] text-white border-[#deb887]'
                        : 'bg-gray-50 text-gray-600 border-gray-200 hover:border-[#deb887] hover:text-[#b8956a]'
                    }`}
                  >
                    {z}
                  </button>
                ))}
              </div>
            )}
            <input 
              type="text"
              value={editedMark.notes || ''}
              onChange={e => setEditedMark({...editedMark, notes: e.target.value})}
              className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] focus:border-transparent outline-none transition-all bg-gray-50/50 focus:bg-white"
              placeholder="Ej: Mejilla derecha, Frente..."
              autoFocus={!suggestedZones && !zoneGroups}
            />
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Info size={12} />
              {mark.notes ? 'Ubicación precargada; puedes corregirla si lo necesitas.' :
                (zoneGroups || suggestedZones) ? 'Seleccione una zona o escríbala.' : 'Puede ajustar el nombre de la zona manualmente.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
          {onMove && mark.is3D && <button type="button" className="admin-focus-ring min-h-11 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700"
            onClick={() => onMove(editedMark)}>Reubicar marca</button>}
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onCancel} 
            className="px-5 py-2.5 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors border border-gray-200 font-medium"
          >
            Cancelar
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSave(editedMark)} 
            className="px-5 py-2.5 bg-[#deb887] text-white rounded-xl hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
          >
            Confirmar
          </motion.button>
        </div>
      </motion.div>
    </Dialog>
  );
};

export default function PhysicalExamTab({ recordId, physicalExams, consultationId, consultations = [], onSave }: PhysicalExamTabProps) {
  const [currentExam, setCurrentExam] = useState<PhysicalExam>({ ...EMPTY_EXAM, record_id: recordId });
  const [crossHistOpen, setCrossHistOpen] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const currentExams = physicalExams.filter(e => Number(e.consultation_id) === Number(consultationId));
  const otherExamCount = physicalExams.filter(e => Number(e.consultation_id) !== Number(consultationId)).length;
  
  // Canvas State
  const [faceMarks, setFaceMarks] = useState<Mark[]>([]);
  const [preparedReview, setPreparedReview] = useState<PersistedSkinReview | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [showSkinWorkspace, setShowSkinWorkspace] = useState(false);
  const [mapView, setMapView] = useState<'generic' | 'mask' | 'split'>('generic');
  const [maskReady, setMaskReady] = useState(false);
  const [referencePoints, setReferencePoints] = useState<EditablePoint[]>([]);
  const [evaluationMarks, setEvaluationMarks] = useState<EvaluationMark[]>([]);
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null);
  const [markVisibility, setMarkVisibility] = useState({ marks: true, names: true });
  const saveController = useRef<SkinExamSave | null>(null);
  const saveInFlight = useRef(false);
  const highlightedPoints = useMemo(() => hoveredMarkId ? [hoveredMarkId,
    ...(hoveredMarkId.startsWith(`legacy-exam:${currentExam.id}:`) ? [hoveredMarkId.slice(`legacy-exam:${currentExam.id}:`.length)] : [])] : [],
  [hoveredMarkId, currentExam.id]);
  const handleHoverMark = useCallback((id: string | null) => {
    const migrated = id && evaluationMarks.find(mark => mark.id === `legacy-exam:${currentExam.id}:${id}`);
    setHoveredMarkId(migrated ? migrated.id : id);
  }, [evaluationMarks, currentExam.id]);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string>();
  const visibleReferencePoints = useMemo(() => referencePoints.filter(point => !point.id.startsWith(`legacy-exam:${currentExam.id}:`)),
    [referencePoints, currentExam.id]);
  const { hasFeature } = useAuth();
  const [parameterDraft, setParameterDraft] = useState<PhysicalExam | null>(null);
  const [parameterKey, setParameterKey] = useState<keyof typeof CLINICAL_FIELDS>('skin_type');
  const [showAnatomicalZones, setShowAnatomicalZones] = useState(false);
  const genericOverlay = useMemo(() => showAnatomicalZones ? skinAnatomicalOverlay() : undefined, [showAnatomicalZones]);
  const [legacyMigration, setLegacyMigration] = useState<FaceSimIntegration['legacyMigration']>();
  const workspaceReview = useRef<PhysicalExam['skin_visual_review']>();
  useUnsavedChangesGuard(reviewDirty || preparedReview !== null);
  const [reviewSession, setReviewSession] = useState(0);
  const [bodyMarks, setBodyMarks] = useState<Mark[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'facial' | 'corporal'>('facial');
  const faceHistory = useRef(new SkinEditHistory<Mark>());
  const bodyHistory = useRef(new SkinEditHistory<Mark>());
  const [, refreshMarkHistory] = useState(0);
  const [markDeletedNotice, setMarkDeletedNotice] = useState<{ text: string; sequence: number; tab: 'facial' | 'corporal' } | null>(null);
  const markDeletedSequence = useRef(0);
  faceHistory.current.sync(faceMarks); bodyHistory.current.sync(bodyMarks);
  useEffect(() => {
    faceHistory.current.clear(); bodyHistory.current.clear(); setMarkDeletedNotice(null); refreshMarkHistory(n => n + 1);
  }, [recordId, consultationId, currentExam.id]);
  useEffect(() => {
    if (!markDeletedNotice) return;
    const timer = window.setTimeout(() => setMarkDeletedNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [markDeletedNotice]);
  function changeOriginalMarks(tab: 'facial' | 'corporal', next: Mark[]) {
    const history = tab === 'facial' ? faceHistory.current : bodyHistory.current;
    history.push(tab === 'facial' ? faceMarks : bodyMarks, next);
    if (tab === 'facial') setFaceMarks(next); else setBodyMarks(next);
    setMarkDeletedNotice(null); refreshMarkHistory(n => n + 1);
  }
  function restoreOriginalMarks(direction: 'undo' | 'redo') {
    if (saving) return;
    const history = activeTab === 'facial' ? faceHistory.current : bodyHistory.current;
    const next = history[direction]();
    if (!next) return;
    const previous = activeTab === 'facial' ? faceMarks : bodyMarks;
    const removed = previous.filter(mark => !next.some(item => item.id === mark.id));
    if (activeTab === 'facial') setFaceMarks(next); else setBodyMarks(next);
    setMarkDeletedNotice(removed.length ? { text: `Marca «${removed[0].category}» eliminada.`,
      tab: activeTab, sequence: ++markDeletedSequence.current } : null);
    setRelocatingLegacy(null); refreshMarkHistory(n => n + 1);
  }

  // Modal State
  const [editingMark, setEditingMark] = useState<Mark | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // 3D region context for modal suggestions
  const [pendingRegion, setPendingRegion] = useState<FacialRegion | null>(null);
  const [relocatingLegacy, setRelocatingLegacy] = useState<{ id: string; tab: 'facial' | 'corporal' } | null>(null);
  const [showReferenceLines, setShowReferenceLines] = useState(true);
  useEffect(() => { setRelocatingLegacy(null); }, [activeTab, mapView]);
  // Warning modal para confirmación de guardado con campos incompletos
  const [saveWarning, setSaveWarning] = useState<{ messages: string[]; payload: PhysicalExam } | null>(null);

  // Reset form when active consultation changes

  useEffect(() => {
    const examForConsult = physicalExams.find(e => Number(e.consultation_id) === Number(consultationId));
    if (examForConsult) loadExam(examForConsult);
    else resetExam();
  }, [consultationId, recordId]);

  // Load exam from data on initial load (data arrives async after mount)

  useEffect(() => {
    if (currentExam.id) return;
    const examForConsult = physicalExams.find(e => Number(e.consultation_id) === Number(consultationId));
    if (examForConsult) loadExam(examForConsult);
    else resetExam();
  }, [physicalExams.length, recordId]);

  useEffect(() => {
    if (message) {
      messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Reset selectedCategory when switching between facial and corporal
  useEffect(() => { setSelectedCategory(''); }, [activeTab]);

  const loadExam = (exam: PhysicalExam) => {
    setEvaluationMarks([]); setHoveredMarkId(null);
    setRelocatingLegacy(null);
    setReferencePoints([]);
    setSelectedReferenceId(undefined);
    setLegacyMigration(undefined); setMapView('generic');
    setCurrentExam(exam);
    setReviewSession(value => value + 1);
    try {
      const parseData = (data?: string | Mark[]): Mark[] => {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (typeof data === 'string') {
          try {
            const parsed: unknown = JSON.parse(data);
            return Array.isArray(parsed) ? parsed as Mark[] : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      setFaceMarks(parseData(exam.face_map_data));
      setPreparedReview(null); setReviewDirty(false); setShowSkinWorkspace(false);
      setBodyMarks(parseData(exam.body_map_data));
    } catch (e) {
      console.error("Error parsing map data", e);
      setFaceMarks([]);
      setPreparedReview(null); setReviewDirty(false); setShowSkinWorkspace(false);
      setBodyMarks([]);
    }
  };

  const resetExam = () => {
    setEvaluationMarks([]); setHoveredMarkId(null);
    setRelocatingLegacy(null);
    setReferencePoints([]);
    setSelectedReferenceId(undefined);
    setLegacyMigration(undefined); setMapView('generic');
    setReviewSession(value => value + 1);
    setCurrentExam({ ...EMPTY_EXAM, record_id: recordId });
    setFaceMarks([]);
    setPreparedReview(null); setReviewDirty(false); setShowSkinWorkspace(false);
    setBodyMarks([]);
    setMessage(null);
  };

  const handleNew = () => {
    if ((reviewDirty || preparedReview) && !window.confirm('Hay una evaluación de piel sin guardar en el examen. ¿Descartarla?')) return;
    resetExam();
  };

  const handleDuplicate = () => {
    if ((reviewDirty || preparedReview) && !window.confirm('Hay una evaluación de piel sin guardar en el examen. ¿Descartarla?')) return;
    const duplicate = { ...currentExam };
    delete duplicate.id;
    delete duplicate.created_at;
    setCurrentExam({ ...duplicate, record_id: recordId });
    setPreparedReview(null); setReviewDirty(false); setShowSkinWorkspace(false); setReviewSession(value => value + 1);
    setMessage({ type: 'success', text: 'Examen duplicado. Guarde para crear uno nuevo.' });
  };

  const handleDelete = async () => {
    if (!currentExam.id || !confirm('¿Eliminar este examen físico?')) return;
    setDeleting(true);
    try {
      const response = await recordsFetch(`/api/records?action=deletePhysicalExam&id=${currentExam.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        onSave();
        handleNew();
        setMessage({ type: 'success', text: 'Examen físico eliminado correctamente' });
      } else {
        throw new Error('Error al eliminar');
      }
    } catch (error) {
      console.error('Error deleting exam:', error);
      setMessage({ type: 'error', text: 'Error al eliminar el examen físico' });
    } finally {
      setDeleting(false);
    }
  };

  const doSave = async (payload: PhysicalExam) => {
    saveInFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const response = await recordsFetch('/api/records?action=savePhysicalExam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const resData = await response.json().catch(() => null);
        const savedId = currentExam.id ?? resData?.id ?? null;
        setMessage({ type: 'success', text: 'Examen físico guardado correctamente' });
        setCurrentExam(prev => ({ ...prev, ...(savedId != null ? { id: savedId } : {}),
          ...(payload.skin_visual_review ? { skin_visual_review: payload.skin_visual_review } : {}) }));
        setPreparedReview(null);
        onSave();
        if (savedId != null) {
          setHighlightedId(savedId);
          setTimeout(() => setHighlightedId(null), 2500);
        }
      } else {
        const errData = await response.json();
        throw new Error(errData.error || 'Error al guardar');
      }
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Error al guardar el examen físico' });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true; setSaving(true); setMessage(null);
    try {
    let review = preparedReview;
    if (reviewDirty) {
      if (!saveController.current) throw new Error('Abre la evaluación de piel y espera a que esté lista antes de guardar.');
      review = await saveController.current();
    }
    const hasEmptyFields = !currentExam.skin_type || !currentExam.phototype || !currentExam.glogau_scale;
    const hasNoMarks = faceMarks.length === 0 && bodyMarks.length === 0 && skinReviewSummaries(review ?? currentExam.skin_visual_review).length === 0;

    const { skin_visual_review: existingReview, ...manualExam } = currentExam;
    const payload = {
      ...manualExam,
      face_map_data: JSON.stringify(faceMarks),
      ...(review ? { skin_visual_review: review } : existingReview ? { skin_visual_review: existingReview } : {}),
      body_map_data: JSON.stringify(bodyMarks),
      ...(consultationId ? { consultation_id: consultationId } : {})
    };

    if (hasEmptyFields || hasNoMarks) {
      const msgs: string[] = [];
      if (hasEmptyFields) msgs.push('Hay campos obligatorios sin seleccionar (Tipo de piel, Fototipo, Glogau).');
      if (hasNoMarks) msgs.push('No se han registrado lesiones en el mapa facial ni corporal.');
      setSaveWarning({ messages: msgs, payload });
      return;
    }

    await doSave(payload);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo guardar la evaluación.' });
    } finally { saveInFlight.current = false; setSaving(false); }
  };

  const handlePrint = () => {
    setMessage({ type: 'success', text: 'Imprimiendo página actual...' });
    window.print();
  };

  const handleSkinDirty = useCallback(() => setReviewDirty(true), []);
  const handleSkinPrepared = useCallback((review: PersistedSkinReview) => {
    setPreparedReview(review); setReviewDirty(false);
  }, []);

  // 3D model click ? identify tercio ? open modal with suggestions
  const handle3DMarkerPlaced = (marker3D: Marker3D) => {
    if (relocatingLegacy?.tab === 'facial') {
      const region = getFacialRegion(marker3D.position);
      const anchor = legacySkinAnchor(marker3D.position, marker3D.normal);
      changeOriginalMarks('facial', faceMarks.map(mark => mark.id === relocatingLegacy.id ? { ...mark,
        position3D: marker3D.position, normal3D: marker3D.normal, rotation3D: marker3D.rotation,
        tercio: region.tercio, notes: anchor ? skinZoneAt(anchor) ?? mark.notes : mark.notes } : mark));
      setRelocatingLegacy(null); return;
    }
    if (!selectedCategory) {
      alert('Por favor seleccione una lesión/categoría primero');
      return;
    }
    const region = getFacialRegion(marker3D.position);
    const anchor = legacySkinAnchor(marker3D.position, marker3D.normal);
    const detectedZone = anchor ? skinZoneAt(anchor) : null;
    setPendingRegion(region);
    const newMark: Mark = {
      id: Date.now().toString(),
      x: 0,
      y: 0,
      category: selectedCategory,
      is3D: true,
      position3D: marker3D.position,
      normal3D: marker3D.normal,
      rotation3D: marker3D.rotation,
      radius3D: 0.16,
      tercio: region.tercio,
      notes: detectedZone ?? '',
    };
    setEditingMark(newMark);
    setIsModalOpen(true);
  };

  const initiateEditMark = (mark: Mark) => {
    // For 3D marks, restore region context so modal shows suggestions
    if (mark.is3D && mark.position3D) {
      setPendingRegion(getFacialRegion(mark.position3D));
    } else {
      setPendingRegion(null);
    }
    setEditingMark(mark);
    setIsModalOpen(true);
  };

  const saveMarkFromModal = (mark: Mark) => {
    const previous = activeTab === 'facial' ? faceMarks : bodyMarks;
    changeOriginalMarks(activeTab, previous.some(m => m.id === mark.id) ? previous.map(m => m.id === mark.id ? mark : m) : [...previous, mark]);
    setIsModalOpen(false);
    setEditingMark(null);
    setPendingRegion(null);
  };

  const removeFaceMark = (id: string) => {
    const original = faceMarks.find(m => m.id === id);
    changeOriginalMarks('facial', faceMarks.filter(m => m.id !== id));
    setMarkDeletedNotice({ text: `Marca «${original?.category ?? id}» eliminada.`, tab: 'facial', sequence: ++markDeletedSequence.current });
  };

  const removeBodyMark = (id: string) => {
    const original = bodyMarks.find(m => m.id === id);
    changeOriginalMarks('corporal', bodyMarks.filter(m => m.id !== id));
    setMarkDeletedNotice({ text: `Marca «${original?.category ?? id}» eliminada.`, tab: 'corporal', sequence: ++markDeletedSequence.current });
  };

  // Convert face marks to Marker3D[] for the 3D viewer (only 3D marks)
  // Memoized: solo recalcula cuando cambian las marcas, no en cada tecla de selectedCategory
  // (una nueva referencia de array forzaba al visor 3D a reconstruir toda la escena Three.js)
  const face3DMarkers: Marker3D[] = useMemo(() => faceMarks
    .filter(m => m.is3D && m.position3D)
    .map(m => ({
      id: m.id,
      pathologyId: 'lesion',
      color: COLORS.skinValidated,
      label: m.category,
      type: (m.distribution === 'zonal' ? 'Zonal' : 'Puntual') as 'Puntual' | 'Zonal',
      position: m.position3D!,
      normal: m.normal3D || { x: 0, y: 0, z: 1 },
      rotation: m.rotation3D || [0, 0, 0],
      zone: m.notes || m.tercio || '',
      radius: m.radius3D ?? 0.16,
      size: (m.radius3D ?? .16) / .16,
    })), [faceMarks]);

  // Body 3D markers (no zone detection)
  const body3DMarkers: Marker3D[] = useMemo(() => bodyMarks
    .filter(m => m.is3D && m.position3D)
    .map(m => ({
      id: m.id,
      pathologyId: 'lesion',
      color: COLORS.skinValidated,
      label: m.category,
      type: (m.distribution === 'zonal' ? 'Zonal' : 'Puntual') as 'Puntual' | 'Zonal',
      position: m.position3D!,
      normal: m.normal3D || { x: 0, y: 0, z: 1 },
      rotation: m.rotation3D || [0, 0, 0],
      zone: m.notes || '',
      radius: m.radius3D ?? 0.16,
      size: (m.radius3D ?? .16) / .16,
    })), [bodyMarks]);

  const handleBody3DMarkerPlaced = (marker3D: Marker3D) => {
    if (relocatingLegacy?.tab === 'corporal') {
      changeOriginalMarks('corporal', bodyMarks.map(mark => mark.id === relocatingLegacy.id ? { ...mark,
        position3D: marker3D.position, normal3D: marker3D.normal, rotation3D: marker3D.rotation } : mark));
      setRelocatingLegacy(null); return;
    }
    if (!selectedCategory) {
      alert('Por favor seleccione una lesión/categoría primero');
      return;
    }
    // ponytail: body region passed for grouped zone picker, no auto-detection
    setPendingRegion({ tercio: 'Corporal', suggestions: [] });
    const newMark: Mark = {
      id: Date.now().toString(),
      x: 0,
      y: 0,
      category: selectedCategory,
      is3D: true,
      position3D: marker3D.position,
      normal3D: marker3D.normal,
      rotation3D: marker3D.rotation,
      radius3D: 0.16,
      tercio: 'Corporal',
      notes: '',
    };
    setEditingMark(newMark);
    setIsModalOpen(true);
  };

  const legacyFaceMarks = faceMarks.filter(m => !m.is3D);
  const storedSkinRows = !showSkinWorkspace ? skinReviewSummaries(preparedReview ?? currentExam.skin_visual_review) : [];
  const migratedIds = new Set([...evaluationMarks, ...storedSkinRows].filter(mark => mark.id.startsWith(`legacy-exam:${currentExam.id}:`))
    .map(mark => mark.id.slice(`legacy-exam:${currentExam.id}:`.length)));
  const listedFaceMarks = faceMarks.filter(mark => !migratedIds.has(mark.id));
  const totalCount = listedFaceMarks.length + bodyMarks.length + evaluationMarks.length + storedSkinRows.length;
  const zonalCount = [...listedFaceMarks, ...bodyMarks].filter(mark => mark.distribution === 'zonal').length +
    evaluationMarks.filter(mark => isZonalSkinMark(mark.box)).length + storedSkinRows.filter(mark => mark.box && isZonalSkinMark(mark.box)).length;
  const referenceLabels = useMemo(() => visibleReferencePoints.map(point => ({
    id: point.id, position: { x: point.x, y: point.y + .07, z: point.z },
    anchor: { x: point.x, y: point.y, z: point.z }, text: point.name ?? '', color: '#ffffff',
  })), [visibleReferencePoints]);
  function editEvaluation(id: string) {
    if (!showSkinWorkspace) {
      workspaceReview.current = preparedReview ?? currentExam.skin_visual_review;
      setLegacyMigration(undefined); setMaskReady(false); setReviewSession(value => value + 1); setShowSkinWorkspace(true);
    }
    setSelectedReferenceId(id); setMapView('mask'); setActiveTab('facial');
  }
  const lesionSelector = <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 p-3 text-gray-900">
    <label htmlFor="physical-lesion-select" className="text-sm font-semibold">Lesión a marcar</label>
    <input id="physical-lesion-select" list="lesion-options-main" value={selectedCategory}
      onChange={event => setSelectedCategory(event.target.value)} placeholder="Seleccione o escriba una lesión…"
      className="admin-focus-ring min-h-11 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 text-sm" />
    <datalist id="lesion-options-main">{LESION_CATALOG.map(lesion => <option key={lesion} value={lesion} />)}</datalist>
  </div>;
  const referenceView = <div className="min-w-0 overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
    {mapView === 'generic' && <div className="border-b border-slate-700 px-3 py-2"><SkinMarkControls value={markVisibility} onChange={setMarkVisibility} tone="dark"
        undo={mapView === 'generic' ? { disabled: saving || !faceHistory.current.size, onClick: () => restoreOriginalMarks('undo') } : undefined}
        redo={mapView === 'generic' ? { disabled: saving || !faceHistory.current.redoSize, onClick: () => restoreOriginalMarks('redo') } : undefined} /></div>}
    <div data-skin-viewer-header className="grid h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-white">
      <div className="min-w-0"><h4 className="text-sm font-semibold">Modelo anatómico de referencia</h4>
        <p className="text-xs text-slate-300">Las marcas originales se conservan</p></div>
      <button type="button" aria-pressed={showAnatomicalZones} onClick={() => setShowAnatomicalZones(current => !current)}
        className={`admin-focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-xs ${showAnatomicalZones ? 'border-gold bg-gold-light text-gray-900' : 'border-slate-500 text-white hover:bg-slate-800'}`}>
        <Grid3X3 size={16} aria-hidden="true" />{showAnatomicalZones ? 'Ocultar zonas' : 'Mostrar zonas'}</button>
    </div>
    {(!showSkinWorkspace || !maskReady || mapView === 'generic') && lesionSelector}
    <div className="relative">
      <button type="button" onClick={() => setShowReferenceLines(v => !v)}
        className="admin-focus-ring absolute right-2 top-2 z-10 rounded-lg border border-white/20 bg-slate-900/80 px-2 py-2 text-xs text-white">
        {showReferenceLines ? <EyeOff size={12} className="mr-1 inline" /> : <Eye size={12} className="mr-1 inline" />}
        {showReferenceLines ? 'Ocultar líneas' : 'Mostrar líneas'}</button>
      <Clinical3DViewer readOnly={showSkinWorkspace && maskReady && mapView !== 'generic'} anatomicalOverlay={genericOverlay} markers={markVisibility.marks ? face3DMarkers : NO_VIEWER_MARKERS} selectedPathology="lesion"
        editablePoints={visibleReferencePoints} occludeAnnotations labInteraction
        showEditablePoints={markVisibility.marks} showMarkerLabels={markVisibility.names}
        highlightedPointIds={highlightedPoints} annotationLabels={markVisibility.marks && markVisibility.names ? referenceLabels : []}
        onEditablePointHovered={handleHoverMark}
        markerInteraction={{ onHover: handleHoverMark, onSelect: id => {
          const evaluation = evaluationMarks.find(mark => mark.id === id || mark.id === `legacy-exam:${currentExam.id}:${id}`);
          if (showSkinWorkspace && maskReady && mapView !== 'generic' && !evaluation) {
            setSelectedReferenceId(`legacy-exam:${currentExam.id}:${id}`); handleHoverMark(id); return;
          }
          if (evaluation) editEvaluation(evaluation.id);
          else { const original = faceMarks.find(mark => mark.id === id); if (original) initiateEditMark(original); }
        } }}
        onEditablePointClicked={id => { setSelectedReferenceId(id); setMapView('mask'); }}
        tercioBoundaries={showReferenceLines ? TERCIO_BOUNDARIES : null} referenceLines={showReferenceLines ? FACE_REFERENCE_LINES : []}
        skipConfirmation onMarkerPlaced={handle3DMarkerPlaced}
        onMarkerRadiusChange={showSkinWorkspace && maskReady ? undefined : (id, radius) => changeOriginalMarks('facial', faceMarks.map(mark => mark.id === id ? { ...mark, radius3D: radius } : mark))}
        height="min(62dvh,560px)" pointMarkerScale={0.5} />
    </div>
    <div className="text-slate-200"><SkinMarkLegend notice={markDeletedNotice?.tab === 'facial' ? markDeletedNotice.text : undefined}
      onUndo={() => restoreOriginalMarks('undo')} undoDisabled={saving || !faceHistory.current.size} /></div>
  </div>;

  return (
    <>
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex h-auto min-w-0 flex-col gap-4"
    >
      {typeof document !== 'undefined' && createPortal(
        <>
          <AnimatePresence>
            {activeTab === 'facial' && storedSkinRows.map(mark => <button key={mark.id} type="button"
              className="admin-focus-ring block min-h-11 w-full border-b p-3 text-left text-sm hover:bg-cyan-50"
              aria-label={`Editar marca guardada: ${mark.description}`} onClick={() => editEvaluation(mark.id)}>
              {mark.description}<span className="mt-1 block text-xs text-blue-700">Editar en la evaluación de piel</span>
            </button>)}
            {isModalOpen && editingMark && (
              <MarkEditModal 
                mark={editingMark} 
                onSave={saveMarkFromModal} 
                onCancel={() => { setIsModalOpen(false); setPendingRegion(null); }}
                onMove={mark => { saveMarkFromModal(mark); setRelocatingLegacy({ id: mark.id, tab: activeTab }); }}
                categories={LESION_CATALOG}
                tercio={pendingRegion?.tercio}
                suggestedZones={activeTab === 'facial' ? pendingRegion?.suggestions : undefined}
                zoneGroups={activeTab === 'corporal' ? BODY_ZONE_GROUPS : undefined}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {saveWarning && (
              <Dialog open onClose={() => setSaveWarning(null)} labelledBy="physical-save-warning-title">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                  className="w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-gray-100 bg-white p-6 shadow-2xl"
                >
                  <div className="flex items-start gap-4 mb-5">
                    <div className="p-2.5 rounded-xl bg-amber-100 shrink-0">
                      <AlertCircle className="w-5 h-5 text-amber-600" />
                    </div>
                    <div>
                      <h3 id="physical-save-warning-title" className="font-bold text-gray-800 text-lg">Advertencia</h3>
                      <ul className="mt-2 space-y-1">
                        {saveWarning.messages.map((m, i) => (
                          <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
                            <span className="text-amber-500 font-bold mt-0.5">•</span>
                            {m}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-sm text-gray-500">¿Desea guardar de todos modos?</p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                    <button
                      onClick={() => setSaveWarning(null)}
                      className="px-5 py-2.5 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors border border-gray-200 font-medium"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => { const p = saveWarning.payload; setSaveWarning(null); doSave(p); }}
                      className="px-5 py-2.5 bg-[#deb887] text-white rounded-xl hover:bg-[#c5a075] transition-colors font-medium shadow-lg shadow-[#deb887]/20"
                    >
                      Guardar de todos modos
                    </button>
                  </div>
                </motion.div>
              </Dialog>
            )}
          </AnimatePresence>
        </>,
        document.body
      )}

      {/* Sidebar List */}
      <details className="rounded-xl border border-gray-200 bg-slate-50 p-3">
        <summary className="admin-focus-ring cursor-pointer text-sm font-semibold text-gray-700">Historial de exámenes · {currentExams.length} en esta consulta</summary>
        <div className="mt-3 font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial de Exámenes
          <span className="ml-auto flex items-center gap-1">
            <span className="text-xs bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{currentExams.length}</span>
            {otherExamCount > 0 && (
              <button onClick={() => setCrossHistOpen(true)} aria-label="Ver historial de exámenes de otras consultas" title={`Ver ${otherExamCount} examen(es) de otras consultas`} className="p-1 hover:bg-[#deb887]/10 rounded-lg relative">
                <History className="w-3.5 h-3.5 text-[#b8944d]" />
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[#b8944d] text-white text-[8px] rounded-full flex items-center justify-center font-bold">{otherExamCount > 9 ? '9+' : otherExamCount}</span>
              </button>
            )}
          </span>
        </div>
        <div className="mt-3 flex max-h-48 flex-wrap gap-2 overflow-auto">
          {currentExams.map((exam, index) => (
            <motion.button type="button"
              key={exam.id || index}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                if ((reviewDirty || preparedReview) && !window.confirm('Hay una evaluación de piel sin guardar en el examen. ¿Descartarla?')) return;
                loadExam(exam);
              }}
              className={`admin-focus-ring min-w-40 p-3 rounded-xl cursor-pointer border text-left transition-colors shadow-sm ${
                highlightedId === exam.id
                  ? 'ring-2 ring-[#b8944d] ring-offset-2 ring-offset-white animate-pulse'
                  : ''
              } ${
                currentExam.id === exam.id 
                  ? 'bg-[#deb887]/10 border-[#deb887] ring-1 ring-[#deb887]' 
                  : 'bg-white border-gray-100 hover:border-[#deb887]/50'
              }`}
            >
              <div className="font-bold text-sm mb-1 text-gray-800">
                {exam.created_at ? new Date(exam.created_at).toLocaleDateString() : 'Nuevo Examen'}
              </div>
              <div className="text-xs opacity-90 truncate flex items-center gap-2 text-gray-500">
                <span className={`w-2 h-2 rounded-full ${exam.skin_type ? 'bg-emerald-400' : 'bg-gray-300'}`} />
                {exam.skin_type ? `Piel ${exam.skin_type}` : 'Sin datos'}
              </div>
            </motion.button>
          ))}
        </div>
      </details>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm shrink-0">
          <div className="flex gap-2">
            <button type="button" aria-label="Nuevo examen" onClick={handleNew} disabled={saving}
              className="admin-focus-ring flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 hover:bg-gray-50">
              <Plus size={18} aria-hidden="true" /><span className="hidden sm:inline">Nuevo</span></button>
            <Tooltip content="Guardar cambios">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSubmit} 
                aria-label="Guardar examen físico"
                disabled={saving} 
                className="flex items-center gap-2 px-4 py-2 bg-[#deb887] text-white rounded-lg hover:bg-[#c5a075] transition-colors shadow-lg shadow-[#deb887]/20 font-medium"
              >
                {saving ? <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> : <Save size={18} />}
                <span className="hidden sm:inline">Guardar</span>
              </motion.button>
            </Tooltip>
            
            <Tooltip content="Duplicar examen">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDuplicate} 
                aria-label="Duplicar examen"
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 transition-colors"
              >
                <Copy size={18} />
              </motion.button>
            </Tooltip>

            <Tooltip content="Eliminar examen">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDelete}
                aria-label="Eliminar examen"
                disabled={deleting}
                className="p-2 hover:bg-red-50 rounded-lg text-red-500 border border-red-100 transition-colors disabled:opacity-50"
              >
                {deleting ? <div className="animate-spin w-4 h-4 border-2 border-red-300 border-t-red-500 rounded-full" /> : <Trash2 size={18} />}
              </motion.button>
            </Tooltip>

            <Tooltip content="Imprimir">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePrint} 
                aria-label="Imprimir examen"
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-600 border border-gray-200 transition-colors"
              >
                <Printer size={18} />
              </motion.button>
            </Tooltip>
          </div>
          <div className={`text-sm font-medium px-3 py-1 rounded-full flex items-center gap-2 ${
            currentExam.id ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {currentExam.id ? <Edit2 size={12} /> : <Plus size={12} />}
            {currentExam.id ? 'Editando' : 'Nuevo Registro'}
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

        <section aria-label="Resumen clínico" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-slate-50 p-3">
          <div className="min-w-0"><h3 className="text-sm font-semibold">Evaluación clínica</h3>
            <p className="text-xs text-gray-600">{currentExam.skin_type ? `Piel ${currentExam.skin_type}` : 'Tipo de piel pendiente'} · {currentExam.phototype ? `Fototipo ${currentExam.phototype}` : 'Fototipo pendiente'} · {Object.keys(CLINICAL_FIELDS).filter(key => currentExam[key as keyof PhysicalExam]).length}/10 parámetros</p></div>
          <button type="button" className="admin-focus-ring min-h-11 rounded-lg border border-gold bg-white px-4 py-2 text-sm font-semibold" disabled={saving}
            onClick={() => { setParameterDraft({ ...currentExam }); setParameterKey('skin_type'); }}>Evaluar parámetros</button>
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          {/* Left Column: Maps */}
          <div className="flex min-w-0 flex-1 flex-col">
            {(!showSkinWorkspace || !maskReady) && <div className="mb-5 space-y-3 rounded-2xl border border-gray-200 bg-white p-4">
              <div><h3 className="text-sm font-bold text-gray-900">{showSkinWorkspace && maskReady ? 'Vista de evaluación facial' : '¿Dónde quieres marcar?'}</h3>
                {(!showSkinWorkspace || !maskReady) && <p className="mt-1 text-xs text-gray-500">{currentExam.id && faceMarks.length > 0 ? 'Conserva el modelo actual o traslada sus marcas a una máscara con fotos.' : 'Usa el modelo genérico o crea una máscara con fotos del paciente.'}</p>}</div>
              {(!showSkinWorkspace || !maskReady) && <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" disabled={saving} aria-pressed={!showSkinWorkspace || mapView === 'generic'}
                className="admin-focus-ring min-h-14 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:border-gold"
                onClick={() => {
                  if (showSkinWorkspace && !maskReady) {
                    if (reviewDirty && !window.confirm('¿Descartar los cambios temporales de piel y continuar en el modelo genérico? Las marcas originales se conservan.')) return;
                    setShowSkinWorkspace(false); setReviewDirty(false);
                  }
                  setMapView('generic'); setActiveTab('facial');
                }}>
                {currentExam.id ? 'Continuar en modelo genérico' : 'Marcar en modelo genérico'}
                <span className="mt-1 block text-xs font-normal text-gray-500">Sin fotos · marcas originales intactas</span>
              </button>
              <button type="button" disabled={saving} aria-expanded={showSkinWorkspace}
                className="admin-focus-ring min-h-14 rounded-xl border border-gold bg-gold-light/50 px-4 py-3 text-left text-sm font-semibold text-gray-800 hover:bg-gold-light"
                onClick={() => {
                  if (showSkinWorkspace) { setMapView('mask'); setActiveTab('facial'); return; }
                  if (reviewDirty && !window.confirm('Se reiniciará el editor de piel sin preparar. ¿Continuar con la migración?')) return;
                  workspaceReview.current = preparedReview ?? currentExam.skin_visual_review;
                  setLegacyMigration(currentExam.id && faceMarks.length > 0 ? { examId: currentExam.id, marks: structuredClone(faceMarks) } : undefined);
                  setMaskReady(false); setReviewSession(value => value + 1); setReviewDirty(false); setShowSkinWorkspace(true); setMapView('mask'); setActiveTab('facial');
                }}>{currentExam.skin_visual_review ? 'Abrir máscara y evaluación' : currentExam.id && faceMarks.length > 0 ? 'Migrar marcaciones a máscara' : 'Crear máscara facial'}
                <span className="mt-1 block text-xs font-normal text-gray-500">Fotos del expediente o nuevas · revisión guiada</span>
              </button>
              </div>}
            </div>}
            <div className="admin-tabs mb-6 w-fit shrink-0" role="group" aria-label="Zona de examen físico">
              {(['facial', 'corporal'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  aria-pressed={activeTab === tab}
                  className="admin-tab admin-focus-ring relative"
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {activeTab === tab && (
                    <motion.div
                      layoutId="activeTabMap"
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#deb887]"
                    />
                  )}
                </button>
              ))}
            </div>

            <section aria-label="Visor de evaluación facial" className="min-w-0 shrink-0 rounded-2xl border border-gray-200 bg-white p-3 sm:p-4"
              onKeyDown={event => {
                const target = event.target;
                if ((showSkinWorkspace && maskReady && mapView !== 'generic' && activeTab === 'facial') ||
                  !(target instanceof HTMLElement) || !event.currentTarget.contains(target) ||
                  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"]') ||
                  event.nativeEvent.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
                const key = event.key.toLowerCase();
                if (key !== 'z' && key !== 'y') return;
                event.preventDefault(); event.stopPropagation(); restoreOriginalMarks(key === 'y' || event.shiftKey ? 'redo' : 'undo');
              }}>
            {showSkinWorkspace && maskReady && activeTab === 'facial' && <div className="mb-4 space-y-2 border-b border-gray-100 pb-3">
              <div role="group" aria-label="Modo de visor facial" className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-slate-100 p-1">
                {([
                  { mode: 'generic', label: 'Modelo anatómico', description: 'Modelo 3D de referencia con las marcaciones originales.', Icon: UserRound },
                  { mode: 'mask', label: 'Máscara del paciente', description: 'Superficie creada con las fotos del paciente y sus marcas sincronizadas.', Icon: ScanFace },
                  { mode: 'split', label: 'Comparar ambos', description: 'Modelo anatómico y máscara, uno al lado del otro en pantallas amplias.', Icon: Columns2 },
                ] as const).map(({ mode, label, description, Icon }) => <button key={mode} type="button" aria-pressed={mapView === mode}
                  title={description} className={`admin-focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mapView === mode ? 'border-gold-ink bg-gold-light text-gold-ink shadow-sm ring-1 ring-gold-ink' : 'border-transparent text-gray-600 hover:bg-white'}`}
                  onClick={() => { setSelectedReferenceId(undefined); setMapView(mode); }}><Icon size={17} aria-hidden="true" />{label}{mapView === mode && <Check size={16} aria-hidden="true" />}</button>)}
              </div>
              <p role="status" className="text-xs text-gray-500">{mapView === 'generic' ? 'Referencia anatómica: conserva todas las marcas originales.' :
                mapView === 'mask' ? 'Máscara personalizada: marca aquí y revisa la correspondencia en las fotos desplegables.' : 'Comparación visual. Las marcas originales no se eliminan al migrar.'}</p>
            </div>}
            <div className="space-y-4">
            {relocatingLegacy && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-gold-light p-3 text-sm text-gray-900">
              Pulsa la nueva ubicación en el modelo anatómico.
              <button type="button" className="admin-focus-ring min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2"
                onClick={() => setRelocatingLegacy(null)}>Cancelar reubicación anatómica</button>
            </div>}
            {showSkinWorkspace && <fieldset disabled={saving}
              className={`min-w-0 ${mapView === 'generic' || activeTab !== 'facial' ? 'hidden' : ''} ${saving ? 'pointer-events-none opacity-60' : ''}`}>
              <Suspense fallback={<p role="status">Abriendo evaluación de piel…</p>}>
                <SkinExamWorkspace key={`${recordId}:${consultationId ?? 'none'}:${reviewSession}`}
                  recordId={recordId} review={workspaceReview.current} legacyMigration={legacyMigration}
                  context={{ skinType: currentExam.skin_type, phototype: currentExam.phototype, hydration: currentExam.hydration }}
                  referenceView={referenceView} viewMode={mapView === 'split' ? 'split' : 'mask'} aiAllowed={hasFeature('skin_visual_ai')}
                  active={mapView !== 'generic' && activeTab === 'facial'} referenceVisible={mapView !== 'mask' && activeTab === 'facial'}
                  onReferencePoints={setReferencePoints}
                  selectedReferenceId={selectedReferenceId}
                  hoveredMarkId={hoveredMarkId} onHoverMark={handleHoverMark} visibility={markVisibility}
                  onVisibilityChange={setMarkVisibility}
                  onEvaluationChange={setEvaluationMarks} saveController={saveController}
                  onPrepared={handleSkinPrepared} onDirty={handleSkinDirty} onCaptureReady={setMaskReady} />
              </Suspense>
            </fieldset>}
            {!(showSkinWorkspace && maskReady && mapView !== 'generic' && activeTab === 'facial') && <div className="min-w-0 rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              {activeTab === 'facial' ? (
                referenceView
              ) : (
                <div className="flex flex-col bg-white h-full">
                  {lesionSelector}
                  <div className="p-2"><SkinMarkControls value={markVisibility} onChange={setMarkVisibility}
                    undo={{ disabled: saving || !bodyHistory.current.size, onClick: () => restoreOriginalMarks('undo') }}
                    redo={{ disabled: saving || !bodyHistory.current.redoSize, onClick: () => restoreOriginalMarks('redo') }} /></div>
                  <Clinical3DViewer
                    markers={markVisibility.marks ? body3DMarkers : NO_VIEWER_MARKERS}
                    showMarkerLabels={markVisibility.names}
                    selectedPathology="lesion"
                    modelUrl="/models/clinical/male_body.glb"
                    skipConfirmation={true}
                    onMarkerPlaced={handleBody3DMarkerPlaced}
                    onMarkerRadiusChange={(id, radius) => changeOriginalMarks('corporal', bodyMarks.map(mark => mark.id === id ? { ...mark, radius3D: radius } : mark))}
                    height="420px"
                    pointMarkerScale={0.5}
                  />
                  <SkinMarkLegend notice={markDeletedNotice?.tab === 'corporal' ? markDeletedNotice.text : undefined}
                    onUndo={() => restoreOriginalMarks('undo')} undoDisabled={saving || !bodyHistory.current.size} />
                </div>
              )}
            </div>}
            </div>
            </section>
            
            <div className="mt-6">
              <h4 className="font-bold text-gray-800 mb-3 flex items-center gap-2 flex-wrap">
                <div className="w-1 h-4 bg-[#deb887] rounded-full shrink-0" />
                <span>Lesiones Marcadas</span>
                <span className="ml-auto flex items-center gap-2 text-sm font-normal text-gray-500">
                  <span className="font-bold text-gray-800"><span>{totalCount}</span> total</span>
                  <span className="text-gray-300">·</span>
                  <span>Puntual: <span className="font-semibold text-gray-700">{totalCount - zonalCount}</span></span>
                  <span className="text-gray-300">·</span>
                  <span>Zonal: <span className="font-semibold text-[#b8944d]">{zonalCount}</span></span>
                </span>
              </h4>

              {/* Legacy 2D marks banner */}
              {activeTab === 'facial' && legacyFaceMarks.length > 0 && (
                <div className="mb-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-amber-700">
                  <Info size={13} className="mt-0.5 shrink-0" />
                  <span>
                    <strong>{legacyFaceMarks.length}</strong> marcación{legacyFaceMarks.length > 1 ? 'es' : ''} anterior{legacyFaceMarks.length > 1 ? 'es' : ''} (formato 2D) preservada{legacyFaceMarks.length > 1 ? 's' : ''}.
                    No se visualizan en el modelo 3D pero sus datos están intactos.
                  </span>
                </div>
              )}

              <div aria-label="Lista de lesiones marcadas" className="max-h-72 overflow-y-auto overscroll-contain border border-gray-100 rounded-xl bg-white shadow-sm custom-scrollbar">
                <AnimatePresence>
                  {activeTab === 'facial' && (!showSkinWorkspace || mapView === 'generic') && evaluationMarks.map(mark => <div key={mark.id}
                    onMouseEnter={() => setHoveredMarkId(mark.id)} onMouseLeave={() => setHoveredMarkId(null)}
                    className={`flex items-center justify-between gap-2 border-b p-3 ${hoveredMarkId === mark.id ? 'bg-cyan-50 ring-1 ring-inset ring-cyan-400' : ''}`}>
                    <button type="button" className="admin-focus-ring min-h-11 min-w-0 flex-1 rounded-lg text-left"
                      onFocus={() => setHoveredMarkId(mark.id)} onBlur={() => setHoveredMarkId(null)} onClick={() => editEvaluation(mark.id)}>
                      <span className="block break-words [overflow-wrap:anywhere] text-sm font-semibold line-clamp-2" title={mark.label}>{mark.label}</span>
                      <span className="block truncate text-xs text-gray-600" title={mark.note}>{mark.note} · {isZonalSkinMark(mark.box) ? 'Zonal' : 'Puntual'} · {mark.status === 'validated' ? 'Confirmada' : 'Pendiente'}</span>
                    </button>
                    <button type="button" className="admin-focus-ring min-h-11 rounded-lg px-3 text-blue-700"
                      aria-label={`Editar ${mark.label} en la máscara`} onClick={() => editEvaluation(mark.id)}><Edit2 size={16} /></button>
                  </div>)}
                  {(activeTab === 'facial' ? listedFaceMarks : bodyMarks).map((mark, i) => (
                    <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      key={mark.id} 
                      onMouseEnter={() => setHoveredMarkId(mark.id)} onMouseLeave={() => setHoveredMarkId(null)}
                      className={`flex justify-between items-center p-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors ${hoveredMarkId === mark.id ? 'bg-cyan-50 ring-1 ring-inset ring-cyan-400' : ''}`}
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button type="button" onClick={() => initiateEditMark(mark)} onFocus={() => setHoveredMarkId(mark.id)} onBlur={() => setHoveredMarkId(null)}
                            title={mark.category} className="admin-focus-ring min-h-11 min-w-0 max-w-full break-words [overflow-wrap:anywhere] rounded-lg text-left font-medium text-gray-800 text-sm line-clamp-2">{i + 1}. {mark.category}</button>
                          {activeTab === 'facial' && (
                            mark.is3D
                              ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#deb887]/20 text-[#b8956a] border border-[#deb887]/30">3D</span>
                              : <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">2D</span>
                          )}
                          {mark.tercio && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 truncate max-w-[100px]">{mark.tercio}</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                          {mark.notes && <span className="max-w-full truncate font-medium text-gray-600" title={mark.notes}>{mark.notes}</span>}
                          {mark.severity && <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-600 border border-gray-200">{mark.severity}</span>}
                          {mark.distribution && <span className="text-gray-400 italic">{mark.distribution}</span>}
                        </span>
                      </div>
                      <div className="flex gap-1 shrink-0 ml-2">
                        <Tooltip content="Editar">
                          <button 
                            aria-label={`Editar ${mark.category}`}
                            onClick={() => initiateEditMark(mark)}
                            className="admin-focus-ring min-h-11 min-w-11 text-blue-700 hover:bg-blue-50 p-1.5 rounded-lg transition-colors"
                          >
                            <Edit2 size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Eliminar">
                          <button 
                            aria-label={`Eliminar ${mark.category}`}
                            onClick={() => activeTab === 'facial' ? removeFaceMark(mark.id) : removeBodyMark(mark.id)}
                            className="admin-focus-ring min-h-11 min-w-11 text-red-700 hover:bg-red-50 p-1.5 rounded-lg transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {(activeTab === 'facial' ? listedFaceMarks.length + evaluationMarks.length + storedSkinRows.length : bodyMarks.length) === 0 && (
                  <div className="p-8 text-center text-gray-400 text-sm flex flex-col items-center gap-2">
                    <Info className="w-8 h-8 opacity-20" />
                    No hay lesiones marcadas
                  </div>
                )}
              </div>
            </div>
          </div>

          <Dialog open={parameterDraft !== null} onClose={() => setParameterDraft(null)} labelledBy="clinical-parameters-title">
          {parameterDraft && <div className="flex max-h-[90dvh] w-[min(60rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white text-gray-900">
            <header className="shrink-0 border-b p-4"><h2 id="clinical-parameters-title" className="text-lg font-semibold">Evaluación clínica de la piel</h2>
              <p className="text-sm text-gray-500">Selecciona un parámetro y registra tu valoración. No se calcula a partir de las fotos.</p></header>
            <div className="grid min-h-0 overflow-auto md:grid-cols-[200px_minmax(0,1fr)]">
            <nav aria-label="Parámetros clínicos" className="flex gap-2 overflow-auto bg-slate-50 p-3 md:flex-col">
              {(Object.entries(CLINICAL_FIELDS) as [keyof typeof CLINICAL_FIELDS, (typeof CLINICAL_FIELDS)[keyof typeof CLINICAL_FIELDS]][]).map(([key, field]) =>
                <button key={key} type="button" aria-pressed={parameterKey === key} onClick={() => setParameterKey(key)}
                  className={`admin-focus-ring min-h-11 shrink-0 rounded-lg border p-3 text-left text-sm ${parameterKey === key ? 'border-gold-ink bg-gold-light' : 'border-transparent hover:bg-white'}`}>
                  {field.label}<span className="block text-xs text-gray-500">{parameterDraft[key] || 'Sin registrar'}</span></button>)}
            </nav>
            <div className="min-w-0 p-5">
            
            {(Object.entries(CLINICAL_FIELDS) as [keyof typeof CLINICAL_FIELDS, (typeof CLINICAL_FIELDS)[keyof typeof CLINICAL_FIELDS]][]).map(([key, field]) => (
              <div key={key} hidden={parameterKey !== key} className="space-y-3">
                <div className="flex items-center gap-2">
                  <label className="block text-sm font-bold text-gray-700 group-hover:text-[#deb887] transition-colors">{field.label}<FieldHelp text={HELP.physical[key] || ''} /></label>
                  <Tooltip content={(
                    <div className="space-y-1 text-left">
                      {(PARAMETER_TOOLTIPS[key] || []).map(item => (
                        <p key={item.label}><strong>{item.label}:</strong> {item.description}</p>
                      ))}
                    </div>
                  )}>
                    <button
                      type="button"
                      aria-label={`Ayuda sobre ${field.label}`}
                      className="rounded-sm text-gray-400 transition-colors hover:text-[#deb887] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#deb887]"
                    >
                      <Info size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {field.options.filter(Boolean).map(option => <button key={option} type="button" aria-pressed={parameterDraft[key] === option}
                    className={`admin-focus-ring flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-sm ${parameterDraft[key] === option ? 'border-gold-ink bg-gold-light ring-1 ring-gold-ink' : 'border-gray-200 hover:bg-slate-50'}`}
                    onClick={() => setParameterDraft(prev => prev ? { ...prev, [key]: option } : prev)}>
                    <svg viewBox="0 0 64 64" aria-hidden="true" className="h-10 w-10 text-gold-ink">
                      <path d="M17 21c0-22 30-22 30 0v15c0 25-30 25-30 0Z"
                        fill={key === 'phototype' ? PHOTOTYPE_COLORS[option] ?? 'currentColor' : 'currentColor'}
                        fillOpacity={key === 'phototype' ? 1 : .15} stroke="currentColor" strokeWidth="2" />
                      <path d="M24 28h3m10 0h3m-8 3v7m-6 7q6 3 12 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      {key === 'skin_type' && ['Grasa', 'Mixta'].includes(option) && <path d="M22 18h20v7h-7v18h-6V25h-7Z" fill="currentColor" fillOpacity=".3" />}
                      {key === 'skin_type' && option === 'Seca' && <path d="m20 34 4 3-3 3m20-6-4 3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />}
                      {key === 'skin_type' && option === 'Sensible' && <g fill="#dc6a62" fillOpacity=".5"><circle cx="23" cy="36" r="4" /><circle cx="41" cy="36" r="4" /></g>}
                    </svg>
                    <span>{option}</span>
                  </button>)}
                </div>
                <p className="text-sm text-gray-600">{PARAMETER_TOOLTIPS[key]?.find(item => item.label === parameterDraft[key] || item.label.startsWith(`${parameterDraft[key]} (`))?.description}</p>
                <button type="button" className="admin-focus-ring min-h-11 rounded-lg border px-3 text-sm" onClick={() => setParameterDraft(prev => prev ? { ...prev, [key]: '' } : prev)}>Dejar sin registrar</button>
              </div>
            ))}

            <div className="mt-4 space-y-2 border-t border-gray-100 pt-4">
              <label className="block text-sm font-bold text-gray-700">Notas Adicionales<FieldHelp text={HELP.physical.lesions_description} /></label>
              <textarea
                name="lesions_description"
                rows={4}
                className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none resize-none text-sm transition-all bg-gray-50/50 focus:bg-white"
                placeholder="Observaciones generales..."
                value={parameterDraft.lesions_description || ''}
                onChange={e => setParameterDraft(prev => prev ? { ...prev, lesions_description: e.target.value } : prev)}
              />
            </div></div></div>
            <footer className="flex shrink-0 justify-end gap-2 border-t p-4">
              <button type="button" className="admin-focus-ring min-h-11 rounded-lg border px-4" onClick={() => setParameterDraft(null)}>Cancelar</button>
              <button type="button" className="admin-focus-ring min-h-11 rounded-lg bg-gold px-4 font-semibold" onClick={() => { setCurrentExam(parameterDraft); setParameterDraft(null); }}>Aplicar evaluación</button>
            </footer>
            </div>}
            </Dialog>
        </div>
      </div>
    </motion.div>
    <CrossConsultHistoryModal
      isOpen={crossHistOpen}
      onClose={() => setCrossHistOpen(false)}
      tabLabel="Exámen Físico"
      consultations={consultations}
      items={physicalExams}
      currentConsultationId={consultationId}
      renderItem={e => (
        <div>
          <p className="font-medium text-gray-800">{e.skin_type || 'Examen físico'}{e.phototype ? ` — Fototipo: ${e.phototype}` : ''}</p>
          <p className="text-gray-400">{e.created_at ? new Date(e.created_at).toLocaleDateString('es-EC') : ''}</p>
          <p>Revisión visual 2D: {skinReviewSummaries(e.skin_visual_review).length} regiones validadas</p>
        </div>
      )}
      renderDetail={e => (
        <>
          {e.skin_type && <div><span className="text-gray-400">Tipo piel:</span> {e.skin_type}</div>}
          {e.phototype && <div><span className="text-gray-400">Fototipo:</span> {e.phototype}</div>}
          {e.glogau_scale && <div><span className="text-gray-400">Glogau:</span> {e.glogau_scale}</div>}
          {e.hydration && <div><span className="text-gray-400">Hidratación:</span> {e.hydration}</div>}
          {e.elasticity && <div><span className="text-gray-400">Elasticidad:</span> {e.elasticity}</div>}
          {e.lesions_description && <div><span className="text-gray-400">Lesiones:</span> {e.lesions_description}</div>}
          <div className="space-y-2 border-t border-gray-200 pt-2">
            <p className="font-semibold">Revisión visual 2D validada</p>
            <p>Regiones revisadas sobre fotografía, no diagnóstico. Una revisión vacía no descarta lesiones.</p>
            {skinReviewSummaries(e.skin_visual_review).length ? (
              <ul className="space-y-1 break-words">{skinReviewSummaries(e.skin_visual_review).map(annotation => (
                <li key={annotation.id}>{annotation.description}</li>
              ))}</ul>
            ) : <p>Sin regiones validadas.</p>}
          </div>
          {e.created_at && <div><span className="text-gray-400">Fecha:</span> {new Date(e.created_at).toLocaleDateString('es-EC')}</div>}
        </>
      )}
    />
    </>
  );
}
