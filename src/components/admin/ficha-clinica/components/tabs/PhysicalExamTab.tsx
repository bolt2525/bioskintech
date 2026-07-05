import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, AlertCircle, Plus, Trash2, Copy, Printer, Info, Edit2, Check, User, FileText, Eye, EyeOff } from 'lucide-react';
import { CLINICAL_FIELDS, LESION_CATALOG, PARAMETER_TOOLTIPS } from '../../../../../data/clinical-catalogs';
import { Mark } from '../FaceMapCanvas';
import BodyMapCanvas from '../BodyMapCanvas';
import Clinical3DViewer from '../Clinical3DViewer';
import type { Marker3D } from '../Clinical3DViewer';
import type { ReferenceLine } from '../ReferenceLinePanel';
import { Tooltip } from '../../../../ui/Tooltip';
import { Select } from '../../../../ui/Select';
import trazadoData from '../../data/trazado-referencia-superior.json';

// ── Constantes para el visor 3D facial ────────────────────────────────────────
const _trazado = trazadoData as any;
const TERCIO_BOUNDARIES = _trazado.hairline as {
  topY: number; bottomY: number;
  tercioMedioBottomY: number; tercioInferiorBottomY: number;
};
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

// ── Zonas sugeridas por tercio (anatómicamente correctas, piel del rostro) ────
// Tercio superior: frente — desde cejas hasta nacimiento del cabello
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
// Tercio medio: zona ocular, nasal y malar — desde base del ojo hasta base de nariz
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
// Tercio inferior: perioral, mentón y mandíbula — desde base de nariz hasta límite inferior
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
  face_map_data?: string;
  body_map_data?: string;
  created_at?: string;
}

interface PhysicalExamTabProps {
  recordId: number;
  physicalExams: PhysicalExam[];
  patientName: string;
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
  mark, onSave, onCancel, categories,
  tercio, suggestedZones,
}: {
  mark: Mark;
  onSave: (m: Mark) => void;
  onCancel: () => void;
  categories: string[];
  tercio?: string;
  suggestedZones?: string[];
}) => {
  const [editedMark, setEditedMark] = useState<Mark>({
    ...mark,
    distribution: mark.distribution || 'puntual',
    severity: mark.severity || 'leve'
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] backdrop-blur-sm p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="bg-white p-6 rounded-2xl shadow-2xl w-full max-w-md border border-gray-100"
      >
        <h3 className="text-xl font-bold mb-4 text-gray-800 flex items-center gap-2 border-b border-gray-100 pb-4">
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
              value={editedMark.severity}
              onChange={val => setEditedMark({...editedMark, severity: val as any})}
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
                <span className="text-sm group-hover:text-[#deb887] transition-colors font-medium">Zonal (Toda la zona)</span>
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-bold text-gray-700">Zona / Ubicación</label>
            {suggestedZones && suggestedZones.length > 0 && (
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
              autoFocus={!suggestedZones}
            />
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Info size={12} />
              {suggestedZones ? 'Seleccione una zona sugerida o escríbala.' : 'Puede ajustar el nombre de la zona manualmente.'}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
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
    </div>
  );
};

export default function PhysicalExamTab({ recordId, physicalExams, patientName, onSave }: PhysicalExamTabProps) {
  const [currentExam, setCurrentExam] = useState<PhysicalExam>({ ...EMPTY_EXAM, record_id: recordId });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  
  // Canvas State
  const [faceMarks, setFaceMarks] = useState<Mark[]>([]);
  const [bodyMarks, setBodyMarks] = useState<Mark[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'facial' | 'corporal'>('facial');

  // Modal State
  const [editingMark, setEditingMark] = useState<Mark | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // 3D region context for modal suggestions
  const [pendingRegion, setPendingRegion] = useState<FacialRegion | null>(null);
  const [showReferenceLines, setShowReferenceLines] = useState(true);

  useEffect(() => {
    if (physicalExams.length > 0 && !currentExam.id) {
      loadExam(physicalExams[0]);
    } else if (physicalExams.length === 0 && !currentExam.id) {
      resetExam();
    }
  }, [physicalExams, recordId]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadExam = (exam: PhysicalExam) => {
    setCurrentExam(exam);
    try {
      const parseData = (data: any) => {
        if (!data) return [];
        if (typeof data === 'string') {
          try {
            return JSON.parse(data);
          } catch {
            return [];
          }
        }
        return data;
      };

      setFaceMarks(parseData(exam.face_map_data));
      setBodyMarks(parseData(exam.body_map_data));
    } catch (e) {
      console.error("Error parsing map data", e);
      setFaceMarks([]);
      setBodyMarks([]);
    }
  };

  const resetExam = () => {
    setCurrentExam({ ...EMPTY_EXAM, record_id: recordId });
    setFaceMarks([]);
    setBodyMarks([]);
    setMessage(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setCurrentExam(prev => ({ ...prev, [name]: value }));
  };

  const handleNew = () => {
    resetExam();
  };

  const handleDuplicate = () => {
    const { id, created_at, ...rest } = currentExam;
    setCurrentExam({ ...rest, record_id: recordId });
    setMessage({ type: 'success', text: 'Examen duplicado. Guarde para crear uno nuevo.' });
  };

  const handleDelete = async () => {
    if (!currentExam.id || !confirm('¿Eliminar este examen físico?')) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/records?action=deletePhysicalExam&id=${currentExam.id}`, {
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

  const handleSubmit = async () => {
    // Validation
    const hasEmptyFields = !currentExam.skin_type || !currentExam.phototype || !currentExam.glogau_scale;
    const hasNoMarks = faceMarks.length === 0 && bodyMarks.length === 0;

    if (hasEmptyFields || hasNoMarks) {
      let warningMsg = 'Advertencia:\n';
      if (hasEmptyFields) warningMsg += '- Hay campos obligatorios sin seleccionar (Tipo de piel, Fototipo, Glogau).\n';
      if (hasNoMarks) warningMsg += '- No se han registrado lesiones en el mapa facial ni corporal.\n';
      warningMsg += '\n¿Desea guardar de todos modos?';

      if (!confirm(warningMsg)) return;
    }

    setSaving(true);
    setMessage(null);

    const examToSave = {
      ...currentExam,
      face_map_data: JSON.stringify(faceMarks),
      body_map_data: JSON.stringify(bodyMarks)
    };

    try {
      const response = await fetch('/api/records?action=savePhysicalExam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(examToSave),
      });

      if (response.ok) {
        setMessage({ type: 'success', text: 'Examen físico guardado correctamente' });
        onSave();
      } else {
        const errData = await response.json();
        throw new Error(errData.error || 'Error al guardar');
      }
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message || 'Error al guardar el examen físico' });
    } finally {
      setSaving(false);
    }
  };

  const handlePrint = () => {
    setMessage({ type: 'success', text: 'Imprimiendo página actual...' });
    window.print();
  };

  // Map Handlers
  const initiateAddMark = (mark: Omit<Mark, 'id'>) => {
    const newMark = { ...mark, id: Date.now().toString() };
    setEditingMark(newMark);
    setIsModalOpen(true);
  };

  // 3D model click → identify tercio → open modal with suggestions
  const handle3DMarkerPlaced = (marker3D: Marker3D) => {
    if (!selectedCategory) {
      alert('Por favor seleccione una lesión/categoría primero');
      return;
    }
    const region = getFacialRegion(marker3D.position);
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
      tercio: region.tercio,
      notes: '',
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
    if (activeTab === 'facial') {
      setFaceMarks(prev => {
        const exists = prev.find(m => m.id === mark.id);
        if (exists) return prev.map(m => m.id === mark.id ? mark : m);
        return [...prev, mark];
      });
    } else {
      setBodyMarks(prev => {
        const exists = prev.find(m => m.id === mark.id);
        if (exists) return prev.map(m => m.id === mark.id ? mark : m);
        return [...prev, mark];
      });
    }
    setIsModalOpen(false);
    setEditingMark(null);
    setPendingRegion(null);
  };

  const removeFaceMark = (id: string) => {
    setFaceMarks(prev => prev.filter(m => m.id !== id));
  };

  const removeBodyMark = (id: string) => {
    setBodyMarks(prev => prev.filter(m => m.id !== id));
  };

  // Convert face marks to Marker3D[] for the 3D viewer (only 3D marks)
  const face3DMarkers: Marker3D[] = faceMarks
    .filter(m => m.is3D && m.position3D)
    .map(m => ({
      id: m.id,
      pathologyId: 'lesion',
      type: (m.distribution === 'zonal' ? 'Zonal' : 'Puntual') as 'Puntual' | 'Zonal',
      position: m.position3D!,
      normal: m.normal3D || { x: 0, y: 0, z: 1 },
      rotation: m.rotation3D || [0, 0, 0],
      zone: m.notes || m.tercio || '',
      radius: 0.1,
    }));

  const legacyFaceMarks = faceMarks.filter(m => !m.is3D);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col md:flex-row h-auto md:h-[800px] gap-6"
    >
      <AnimatePresence>
        {isModalOpen && editingMark && (
          <MarkEditModal 
            mark={editingMark} 
            onSave={saveMarkFromModal} 
            onCancel={() => { setIsModalOpen(false); setPendingRegion(null); }}
            categories={LESION_CATALOG}
            tercio={pendingRegion?.tercio}
            suggestedZones={pendingRegion?.suggestions}
          />
        )}
      </AnimatePresence>

      {/* Sidebar List */}
      <div className="w-full md:w-72 border-r-0 md:border-r border-b md:border-b-0 border-gray-100 pr-0 md:pr-6 pb-4 md:pb-0 flex flex-col gap-4 shrink-0">
        <div className="font-bold text-gray-800 flex items-center gap-2">
          <div className="w-1 h-5 bg-[#deb887] rounded-full" />
          Historial de Exámenes
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 max-h-[200px] md:max-h-none pr-2 custom-scrollbar">
          {physicalExams.map((exam, index) => (
            <motion.div
              key={exam.id || index}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => loadExam(exam)}
              className={`p-4 rounded-xl cursor-pointer border transition-all shadow-sm ${
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
            </motion.div>
          ))}
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleNew}
            className="w-full py-3 mt-2 border-2 border-dashed border-gray-200 rounded-xl text-gray-500 hover:border-[#deb887] hover:text-[#deb887] transition-colors font-medium flex items-center justify-center gap-2 bg-gray-50/50 hover:bg-[#deb887]/5"
          >
            <Plus className="w-4 h-4" />
            Nuevo Examen
          </motion.button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col gap-6 overflow-visible md:overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap gap-4 justify-between items-center bg-white p-4 rounded-xl border border-gray-100 shadow-sm shrink-0">
          <div className="flex gap-2">
            <Tooltip content="Guardar cambios">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleSubmit} 
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

        <div className="flex-1 flex flex-col md:flex-row gap-6 overflow-visible md:overflow-hidden">
          {/* Left Column: Maps */}
          <div className="flex-1 flex flex-col overflow-y-auto min-w-0 custom-scrollbar pr-2">
            <div className="flex gap-2 mb-6 border-b border-gray-100">
              {['facial', 'corporal'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab as any)}
                  className={`relative px-6 py-3 font-medium transition-colors ${
                    activeTab === tab ? 'text-[#deb887]' : 'text-gray-500 hover:text-gray-700'
                  }`}
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

            <div className="mb-6 space-y-2">
              <label className="block text-sm font-bold text-gray-700">Seleccionar Lesión para Marcar:</label>
              <div className="relative">
                <input 
                  list="lesion-options-main"
                  className="w-full p-3 pl-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none transition-all shadow-sm bg-white"
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  placeholder="Seleccione o escriba una lesión..."
                />
                <datalist id="lesion-options-main">
                  {LESION_CATALOG.map(l => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </div>
              {activeTab === 'facial' && !selectedCategory && (
                <p className="text-xs text-amber-600 flex items-center gap-1 bg-amber-50 px-3 py-1.5 rounded-lg border border-amber-100">
                  <Info size={11} />
                  Seleccione una lesión antes de marcar en el modelo 3D
                </p>
              )}
            </div>

            <div className="flex-1 rounded-2xl border border-gray-100 shadow-sm overflow-hidden min-h-[420px]">
              {activeTab === 'facial' ? (
                <div className="relative">
                  <button
                    onClick={() => setShowReferenceLines(v => !v)}
                    className="absolute top-2 right-2 z-10 flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-900/65 text-white hover:bg-gray-900/90 transition-colors border border-white/15 backdrop-blur-sm select-none"
                    title={showReferenceLines ? 'Ocultar líneas de referencia' : 'Mostrar líneas de referencia'}
                  >
                    {showReferenceLines ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showReferenceLines ? 'Ocultar líneas' : 'Mostrar líneas'}
                  </button>
                  <Clinical3DViewer
                    markers={face3DMarkers}
                    selectedPathology="lesion"
                    tercioBoundaries={showReferenceLines ? TERCIO_BOUNDARIES : null}
                    referenceLines={showReferenceLines ? FACE_REFERENCE_LINES : []}
                    skipConfirmation={true}
                    onMarkerPlaced={handle3DMarkerPlaced}
                    height="420px"
                  />
                </div>
              ) : (
                <div className="p-6 flex flex-col items-center bg-white h-full">
                  <BodyMapCanvas 
                    marks={bodyMarks} 
                    onAddMark={initiateAddMark} 
                    onRemoveMark={removeBodyMark}
                    selectedCategory={selectedCategory}
                  />
                </div>
              )}
            </div>
            
            <div className="mt-6">
              <h4 className="font-bold text-gray-800 mb-3 flex items-center gap-2">
                <div className="w-1 h-4 bg-[#deb887] rounded-full" />
                Lesiones Marcadas ({activeTab === 'facial' ? faceMarks.length : bodyMarks.length})
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

              <div className="max-h-48 overflow-y-auto border border-gray-100 rounded-xl bg-white shadow-sm custom-scrollbar">
                <AnimatePresence>
                  {(activeTab === 'facial' ? faceMarks : bodyMarks).map((mark, i) => (
                    <motion.div 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      key={mark.id} 
                      className="flex justify-between items-center p-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-gray-800 text-sm">{i + 1}. {mark.category}</span>
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
                          {mark.notes && <span className="font-medium text-gray-600">{mark.notes}</span>}
                          {mark.severity && <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-600 border border-gray-200">{mark.severity}</span>}
                          {mark.distribution && <span className="text-gray-400 italic">{mark.distribution}</span>}
                        </span>
                      </div>
                      <div className="flex gap-1 shrink-0 ml-2">
                        <Tooltip content="Editar">
                          <button 
                            onClick={() => initiateEditMark(mark)}
                            className="text-blue-500 hover:bg-blue-50 p-1.5 rounded-lg transition-colors"
                          >
                            <Edit2 size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Eliminar">
                          <button 
                            onClick={() => activeTab === 'facial' ? removeFaceMark(mark.id) : removeBodyMark(mark.id)}
                            className="text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {(activeTab === 'facial' ? faceMarks : bodyMarks).length === 0 && (
                  <div className="p-8 text-center text-gray-400 text-sm flex flex-col items-center gap-2">
                    <Info className="w-8 h-8 opacity-20" />
                    No hay lesiones marcadas
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Clinical Parameters */}
          <div className="w-full md:w-[350px] flex flex-col gap-4 overflow-y-auto pr-2 shrink-0 custom-scrollbar">
            <h3 className="font-bold text-gray-800 border-b border-gray-100 pb-3 flex items-center gap-2 sticky top-0 bg-white z-10">
              <div className="w-1 h-5 bg-[#deb887] rounded-full" />
              Parámetros Clínicos
            </h3>
            
            {Object.entries(CLINICAL_FIELDS).map(([key, field]) => (
              <div key={key} className="space-y-1.5 group">
                <div className="flex items-center gap-2">
                  <label className="block text-sm font-bold text-gray-700 group-hover:text-[#deb887] transition-colors">{field.label}</label>
                  <Tooltip content={PARAMETER_TOOLTIPS[key] || ''}>
                    <Info size={14} className="text-gray-400 hover:text-[#deb887] transition-colors cursor-help" />
                  </Tooltip>
                </div>
                <Select
                  value={(currentExam as any)[key] || ''}
                  onChange={(value) => setCurrentExam(prev => ({ ...prev, [key]: value }))}
                  options={field.options}
                  placeholder="Seleccionar..."
                />
              </div>
            ))}

            <div className="space-y-2 mt-4 pt-4 border-t border-gray-100">
              <label className="block text-sm font-bold text-gray-700">Notas Adicionales</label>
              <textarea
                name="lesions_description"
                rows={4}
                className="w-full p-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#deb887] outline-none resize-none text-sm transition-all bg-gray-50/50 focus:bg-white"
                placeholder="Observaciones generales..."
                value={currentExam.lesions_description || ''}
                onChange={handleChange}
              />
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
