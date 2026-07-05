import React, { useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Camera, X, Trash2, Check, Images, ZoomIn, ZoomOut,
  RotateCcw, RotateCw, Info, Eye, EyeOff
} from 'lucide-react';
import Clinical3DViewer, { Marker3D, EditablePoint } from './Clinical3DViewer';
import type { ReferenceLine, ProjectedPosition } from './Clinical3DViewer';

// ==========================================
// TIPOS
// ==========================================

export interface CaptureImage {
  id: string;
  dataUrl: string;
  label: string;
}

/** Punto de inyección mínimo para mostrar números de UI */
export interface UnitPoint {
  id?: string;
  editablePointId?: string;
  units: number;
}

interface InjectableCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  markers: Marker3D[];
  productType: 'toxina' | 'relleno';
  /** Líneas de referencia del trazado */
  referenceLines?: ReferenceLine[];
  /** Puntos editables del trazado */
  editablePoints?: EditablePoint[];
  /** Capturas existentes al abrir el modal */
  initialCaptures?: CaptureImage[];
  /** Callback con la lista final de capturas al confirmar */
  onConfirm: (captures: CaptureImage[]) => void;
  /** Visibilidad inicial de líneas (hereda del estado de la vista principal) */
  initialShowLines?: boolean;
  /** Visibilidad inicial de puntos del trazado (hereda del estado de la vista principal) */
  initialShowEditablePoints?: boolean;
  /** Puntos de inyección con unidades para overlay de números */
  injectionPoints?: UnitPoint[];
  /** Visibilidad inicial de números de unidades */
  initialShowUnitNumbers?: boolean;
}

// ==========================================
// COMPONENTE
// ==========================================

export default function InjectableCaptureModal({
  isOpen,
  onClose,
  markers,
  productType,
  referenceLines = [],
  editablePoints = [],
  initialCaptures = [],
  onConfirm,
  initialShowLines = true,
  initialShowEditablePoints = true,
  injectionPoints = [],
  initialShowUnitNumbers = true,
}: InjectableCaptureModalProps) {
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const [captures, setCaptures] = useState<CaptureImage[]>(initialCaptures);
  const [showLines, setShowLines] = useState(initialShowLines);
  const [showEditablePoints, setShowEditablePoints] = useState(initialShowEditablePoints);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showUnitNumbers, setShowUnitNumbers] = useState(initialShowUnitNumbers);
  const unitOverlayRef = useRef<HTMLDivElement>(null);
  const [pendingLabel, setPendingLabel] = useState('');
  const [previewCapture, setPreviewCapture] = useState<CaptureImage | null>(null);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState('');

  const handleProjectedPositions = useCallback((positions: ProjectedPosition[]) => {
    const overlay = unitOverlayRef.current;
    if (!overlay) return;
    positions.forEach(({ id, x, y }) => {
      if (id === '__zoom__') {
        const REF_DIST = 12;
        const BASE_PX = 9;
        const MIN_PX = 7;
        const MAX_PX = 15;
        const raw = BASE_PX * REF_DIST / Math.max(x, 0.1);
        const clamped = Math.max(MIN_PX, Math.min(MAX_PX, raw));
        overlay.style.setProperty('--unit-font-size', `${clamped.toFixed(1)}px`);
        return;
      }
      const el = overlay.querySelector(`[data-pid="${id}"]`) as HTMLElement | null;
      if (el) el.style.transform = `translate(${Math.round(x + 5)}px, ${Math.round(y - 12)}px)`;
    });
  }, []);

  const handleCapture = useCallback(() => {
    if (!viewerContainerRef.current) return;
    const canvas = viewerContainerRef.current.querySelector('canvas');
    if (!canvas) return;

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch {
      return;
    }

    const newCapture: CaptureImage = {
      id: Date.now().toString(),
      dataUrl,
      label: pendingLabel.trim() || '',
    };

    setCaptures(prev => [...prev, newCapture]);
    setPendingLabel('');

    // Flash visual feedback
    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 400);
  }, [pendingLabel]);

  const handleRemoveCapture = (id: string) => {
    setCaptures(prev => prev.filter(c => c.id !== id));
    if (previewCapture?.id === id) setPreviewCapture(null);
  };

  const handleStartEditLabel = (capture: CaptureImage) => {
    setEditingLabelId(capture.id);
    setEditingLabelValue(capture.label);
  };

  const handleSaveLabel = () => {
    if (!editingLabelId) return;
    setCaptures(prev =>
      prev.map(c => c.id === editingLabelId ? { ...c, label: editingLabelValue.trim() } : c)
    );
    setEditingLabelId(null);
  };

  const handleConfirm = () => {
    onConfirm(captures);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  const selectedPathology = productType === 'toxina' ? 'botox' : 'filler';

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden border border-gray-100"
          >
            {/* ---- HEADER ---- */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-[#deb887]/10 to-[#deb887]/5 shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#deb887]/20 rounded-xl">
                  <Images className="w-5 h-5 text-[#b8944d]" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-800">Capturas del Mapeo 3D</h2>
                  <p className="text-xs text-gray-500">Gira el modelo a la vista deseada y captura. Añade una etiqueta opcional a cada imagen.</p>
                </div>
              </div>
              <button
                onClick={handleClose}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* ---- BODY ---- */}
            <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">

              {/* LEFT: 3D viewer */}
              <div className="flex-1 flex flex-col min-w-0 p-4 gap-3">
                <div className="flex items-center gap-2 text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <Info className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>Usa el ratón para rotar, hacer zoom o mover el modelo. Cuando tengas la vista deseada, escribe una etiqueta y captura.</span>
                </div>

                {/* Toolbar: visibilidad + captura en una sola fila */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* Toggles de visibilidad */}
                  <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide shrink-0">Ver:</span>
                    <button
                      onMouseDown={() => setShowLines(v => !v)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                        showLines
                          ? 'bg-[#deb887]/15 border-[#deb887]/40 text-[#b8944d]'
                          : 'bg-gray-100 border-gray-200 text-gray-400'
                      }`}
                      title={showLines ? 'Ocultar líneas' : 'Mostrar líneas'}
                    >
                      {showLines ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      Líneas
                    </button>
                    {editablePoints.length > 0 && (
                      <button
                        onMouseDown={() => setShowEditablePoints(v => !v)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                          showEditablePoints
                            ? 'bg-yellow-50 border-yellow-200 text-yellow-700'
                            : 'bg-gray-100 border-gray-200 text-gray-400'
                        }`}
                        title={showEditablePoints ? 'Ocultar puntos' : 'Mostrar puntos'}
                      >
                        {showEditablePoints ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        Puntos
                      </button>
                    )}
                    {markers.length > 0 && (
                      <button
                        onMouseDown={() => setShowMarkers(v => !v)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                          showMarkers
                            ? 'bg-[#deb887]/10 border-[#deb887]/30 text-[#b8944d]'
                            : 'bg-gray-100 border-gray-200 text-gray-400'
                        }`}
                        title={showMarkers ? 'Ocultar marcadores' : 'Mostrar marcadores'}
                      >
                        {showMarkers ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        Marcadores
                      </button>
                    )}
                    {injectionPoints.some(ip => ip.units > 0) && (
                      <button
                        onMouseDown={() => setShowUnitNumbers(v => !v)}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all ${
                          showUnitNumbers
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-gray-100 border-gray-200 text-gray-400'
                        }`}
                        title={showUnitNumbers ? 'Ocultar números UI' : 'Mostrar números UI'}
                      >
                        {showUnitNumbers ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        Números
                      </button>
                    )}
                  </div>

                  {/* Input etiqueta + botón Capturar */}
                  <div className="flex gap-1.5 items-center shrink-0">
                    <input
                      type="text"
                      className="w-40 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs focus:ring-2 focus:ring-[#deb887] focus:border-[#deb887] outline-none bg-gray-50 transition-all"
                      placeholder="Etiqueta (opcional)"
                      value={pendingLabel}
                      onChange={e => setPendingLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCapture(); }}
                    />
                    <button
                      onClick={handleCapture}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#deb887] hover:bg-[#c5a075] text-white text-xs font-semibold rounded-lg shadow-sm hover:shadow-md transition-all shrink-0"
                      title="Capturar vista actual (Enter)"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Capturar
                    </button>
                  </div>
                </div>

                {/* Viewer container with flash overlay */}
                <div className="relative flex-1 min-h-[260px]" ref={viewerContainerRef}>
                  <Clinical3DViewer
                    markers={showMarkers ? markers : []}
                    selectedPathology={selectedPathology}
                    readOnly
                    height="100%"
                    referenceLines={showLines ? referenceLines : []}
                    editablePoints={editablePoints}
                    showEditablePoints={showEditablePoints && editablePoints.length > 0}
                    onProjectedPositions={handleProjectedPositions}
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
                  {/* Flash animation on capture */}
                  <AnimatePresence>
                    {captureFlash && (
                      <motion.div
                        initial={{ opacity: 0.8 }}
                        animate={{ opacity: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.4 }}
                        className="absolute inset-0 bg-white rounded-xl pointer-events-none z-10"
                      />
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* RIGHT: Gallery */}
              <div className="w-full lg:w-72 border-t lg:border-t-0 lg:border-l border-gray-100 flex flex-col min-h-0">
                <div className="px-4 pt-4 pb-2 shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-600 uppercase tracking-wide">
                      Capturas ({captures.length})
                    </span>
                    {captures.length > 0 && (
                      <button
                        onClick={() => { setCaptures([]); setPreviewCapture(null); }}
                        className="text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        Limpiar todo
                      </button>
                    )}
                  </div>
                </div>

                {/* Gallery scroll */}
                <div className="flex-1 overflow-y-scroll px-4 pb-4 space-y-3 min-h-0 scrollbar-gold">
                  {captures.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-gray-300">
                      <Camera className="w-10 h-10 mb-2 opacity-40" />
                      <p className="text-xs font-medium">Aún no hay capturas</p>
                      <p className="text-[10px] mt-1 opacity-70">Posiciona el modelo y presiona "Capturar"</p>
                    </div>
                  ) : (
                    captures.map((capture, index) => (
                      <div
                        key={capture.id}
                        className="group relative bg-gray-50 border border-gray-200 rounded-xl overflow-hidden hover:border-[#deb887] hover:shadow-sm transition-all"
                      >
                        {/* Thumbnail */}
                        <div
                          className="relative cursor-pointer"
                          onClick={() => setPreviewCapture(capture)}
                        >
                          <img
                            src={capture.dataUrl}
                            alt={capture.label || `Captura ${index + 1}`}
                            className="w-full h-28 object-cover"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                            <ZoomIn className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                          <span className="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                            {index + 1}
                          </span>
                        </div>

                        {/* Label row */}
                        <div className="px-2.5 py-2 flex items-center gap-1.5">
                          {editingLabelId === capture.id ? (
                            <>
                              <input
                                autoFocus
                                type="text"
                                className="flex-1 text-xs px-2 py-1 border border-[#deb887] rounded-lg focus:ring-1 focus:ring-[#deb887] outline-none"
                                value={editingLabelValue}
                                onChange={e => setEditingLabelValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleSaveLabel();
                                  if (e.key === 'Escape') setEditingLabelId(null);
                                }}
                              />
                              <button onClick={handleSaveLabel} className="p-1 text-emerald-500 hover:text-emerald-700">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="flex-1 text-left text-xs text-gray-600 truncate hover:text-[#b8944d] transition-colors"
                                onClick={() => handleStartEditLabel(capture)}
                                title="Clic para editar etiqueta"
                              >
                                {capture.label || <span className="text-gray-300 italic">Sin etiqueta</span>}
                              </button>
                              <button
                                onClick={() => handleRemoveCapture(capture.id)}
                                className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                                title="Eliminar captura"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* ---- FOOTER ---- */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/50 shrink-0">
              <p className="text-xs text-gray-400">
                {captures.length === 0
                  ? 'No hay capturas. Puedes confirmar y se omitirán imágenes en la impresión.'
                  : `${captures.length} imagen${captures.length !== 1 ? 'es' : ''} lista${captures.length !== 1 ? 's' : ''} para incluir en el documento`}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl border border-gray-200 transition-all"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-[#deb887] hover:bg-[#c5a075] rounded-xl shadow-sm hover:shadow-md transition-all"
                >
                  <Check className="w-4 h-4" />
                  Confirmar ({captures.length})
                </button>
              </div>
            </div>
          </motion.div>

          {/* Full-screen preview */}
          <AnimatePresence>
            {previewCapture && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-60 bg-black/90 flex items-center justify-center p-4"
                onClick={() => setPreviewCapture(null)}
              >
                <motion.div
                  initial={{ scale: 0.85 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.85 }}
                  className="relative max-w-2xl w-full"
                  onClick={e => e.stopPropagation()}
                >
                  <img
                    src={previewCapture.dataUrl}
                    alt={previewCapture.label}
                    className="w-full rounded-xl border border-white/10"
                  />
                  {previewCapture.label && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-4 py-1.5 rounded-full backdrop-blur-sm">
                      {previewCapture.label}
                    </div>
                  )}
                  <button
                    onClick={() => setPreviewCapture(null)}
                    className="absolute top-3 right-3 p-2 bg-black/60 hover:bg-black/80 text-white rounded-full transition-all"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
