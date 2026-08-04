import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Camera, Upload, X, ZoomIn, Trash2, Edit3, Download,
  SplitSquareHorizontal, CheckCircle, AlertCircle,
  ChevronLeft, ChevronRight, Save,
} from 'lucide-react';
import recordsFetch from '../../../../../utils/recordsFetch';

interface ClinicalPhoto {
  id: number;
  record_id: number;
  consultation_id?: number;
  photo_type: 'before' | 'after' | 'diagnostic' | 'progress' | 'general';
  r2_key: string;
  r2_url: string;
  face_zone?: string;
  body_zone?: string;
  session_label?: string;
  notes?: string;
  taken_at?: string;
  created_at: string;
}

interface PhotosTabProps {
  recordId: number;
  consultationId?: number;
  patientName: string;
}

const TYPE_LABELS: Record<ClinicalPhoto['photo_type'], string> = {
  before: 'Antes',
  after: 'Después',
  diagnostic: 'Diagnóstico',
  progress: 'Progreso',
  general: 'General',
};

const TYPE_BADGE: Record<ClinicalPhoto['photo_type'], string> = {
  before: 'bg-blue-100 text-blue-700',
  after: 'bg-green-100 text-green-700',
  diagnostic: 'bg-purple-100 text-purple-700',
  progress: 'bg-amber-100 text-amber-700',
  general: 'bg-gray-100 text-gray-600',
};

const FILTER_OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'before', label: 'Antes' },
  { value: 'after', label: 'Después' },
  { value: 'diagnostic', label: 'Diagnóstico' },
  { value: 'progress', label: 'Progreso' },
  { value: 'general', label: 'General' },
];

const FACE_ZONES = [
  'Frente', 'Zona T', 'Mejillas', 'Nariz', 'Mentón', 'Cuello',
  'Contorno de ojos', 'Labios', 'Pómulos', 'Cuerpo completo', 'Otra',
];

export default function PhotosTab({ recordId, consultationId, patientName }: PhotosTabProps) {
  const [photos, setPhotos] = useState<ClinicalPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [selectedPhoto, setSelectedPhoto] = useState<ClinicalPhoto | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareLeft, setCompareLeft] = useState<ClinicalPhoto | null>(null);
  const [compareRight, setCompareRight] = useState<ClinicalPhoto | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [dragOver, setDragOver] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState<ClinicalPhoto | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [r2Available, setR2Available] = useState<boolean | null>(null);
  // lightbox nav index
  const [lightboxIndex, setLightboxIndex] = useState<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareContainerRef = useRef<HTMLDivElement>(null);
  const [sliderPct, setSliderPct] = useState(50);
  const isDraggingSlider = useRef(false);

  const filteredPhotos = filterType === 'all'
    ? photos
    : photos.filter(p => p.photo_type === filterType);

  useEffect(() => {
    fetchPhotos();
  }, [recordId]);

  useEffect(() => {
    if (message) {
      const t = setTimeout(() => setMessage(null), 4000);
      return () => clearTimeout(t);
    }
  }, [message]);

  // Close lightbox on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedPhoto(null);
        setEditingPhoto(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const fetchPhotos = async () => {
    setLoading(true);
    try {
      const res = await recordsFetch(`/api/records?action=listPhotos&record_id=${recordId}`);
      if (res.ok) {
        const data = await res.json();
        setPhotos(Array.isArray(data) ? data : []);
      }
    } catch {
      setMessage({ type: 'error', text: 'Error al cargar las fotos' });
    } finally {
      setLoading(false);
    }
  };

  // ponytail: compress via canvas hasta < 3MB para caber en el JSON body de Vercel (4.5MB límite)
  const compressImage = (file: File, maxBytes = 3 * 1024 * 1024): Promise<{ base64: string; type: string }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const MAX_DIM = 1920;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) { height = Math.round(height * MAX_DIM / width); width = MAX_DIM; }
          else { width = Math.round(width * MAX_DIM / height); height = MAX_DIM; }
        }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        // reducir calidad hasta caber en límite
        let quality = 0.85;
        const tryCompress = () => {
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const base64 = dataUrl.split(',')[1];
          if (base64.length * 0.75 < maxBytes || quality <= 0.4) {
            resolve({ base64, type: 'image/jpeg' });
          } else {
            quality -= 0.15;
            tryCompress();
          }
        };
        tryCompress();
      };
      img.onerror = reject;
      img.src = url;
    });

  const handleUpload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    let anyFailed = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(`Subiendo ${i + 1} de ${files.length}: ${file.name}`);
      try {
        setUploadProgress(`Procesando ${i + 1} de ${files.length}…`);
        const { base64, type } = await compressImage(file);
        setUploadProgress(`Subiendo ${i + 1} de ${files.length}: ${file.name}`);
        const res = await recordsFetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'uploadPhotoProxy',
            fileBase64: base64,
            filename: file.name,
            content_type: type,
            record_id: recordId,
            consultation_id: consultationId,
            session_label: new Date().toLocaleDateString('es-CL'),
          }),
        });
        if (res.status === 503) {
          setR2Available(false);
          setMessage({ type: 'error', text: 'Almacenamiento no configurado — Configure las variables R2 en Vercel' });
          setUploading(false); setUploadProgress(''); return;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Error al subir (${res.status})`);
        }
        setR2Available(true);
      } catch (err: any) {
        anyFailed = true;
        setMessage({ type: 'error', text: err.message || 'Error al subir foto' });
      }
    }
    setUploading(false); setUploadProgress('');
    if (!anyFailed) setMessage({ type: 'success', text: `${files.length} foto(s) subida(s) correctamente` });
    await fetchPhotos();
  }, [recordId, consultationId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      handleUpload(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) handleUpload(files);
  };

  const handleDelete = async (photo: ClinicalPhoto) => {
    if (!confirm(`¿Eliminar esta foto? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deletePhoto', id: photo.id }),
      });
      if (res.ok) {
        setPhotos(prev => prev.filter(p => p.id !== photo.id));
        if (selectedPhoto?.id === photo.id) setSelectedPhoto(null);
        setMessage({ type: 'success', text: 'Foto eliminada' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Error al eliminar' });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingPhoto) return;
    try {
      const res = await recordsFetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updatePhoto',
          id: editingPhoto.id,
          photo_type: editingPhoto.photo_type,
          notes: editingPhoto.notes,
          session_label: editingPhoto.session_label,
          face_zone: editingPhoto.face_zone,
        }),
      });
      if (res.ok) {
        setPhotos(prev => prev.map(p => p.id === editingPhoto.id ? editingPhoto : p));
        setMessage({ type: 'success', text: 'Foto actualizada' });
        setEditingPhoto(null);
      }
    } catch {
      setMessage({ type: 'error', text: 'Error al actualizar' });
    }
  };

  // Compare slider drag
  const handleSliderMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSlider.current = true;
  };
  const handleSliderMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingSlider.current || !compareContainerRef.current) return;
    const rect = compareContainerRef.current.getBoundingClientRect();
    const pct = Math.max(5, Math.min(95, ((e.clientX - rect.left) / rect.width) * 100));
    setSliderPct(pct);
  }, []);
  const handleSliderMouseUp = useCallback(() => { isDraggingSlider.current = false; }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleSliderMouseMove);
    window.addEventListener('mouseup', handleSliderMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleSliderMouseMove);
      window.removeEventListener('mouseup', handleSliderMouseUp);
    };
  }, [handleSliderMouseMove, handleSliderMouseUp]);

  // Lightbox navigation
  const openLightbox = (photo: ClinicalPhoto) => {
    const idx = filteredPhotos.findIndex(p => p.id === photo.id);
    setLightboxIndex(idx >= 0 ? idx : 0);
    setSelectedPhoto(photo);
  };
  const lightboxNav = (dir: 1 | -1) => {
    const next = (lightboxIndex + dir + filteredPhotos.length) % filteredPhotos.length;
    setLightboxIndex(next);
    setSelectedPhoto(filteredPhotos[next]);
  };

  const handleCompareSelect = (photo: ClinicalPhoto) => {
    if (!compareLeft) { setCompareLeft(photo); return; }
    if (!compareRight && photo.id !== compareLeft.id) { setCompareRight(photo); return; }
    // reset
    setCompareLeft(photo);
    setCompareRight(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-[#b8944d]" />
          <h3 className="text-lg font-semibold text-gray-800">Registro Fotográfico</h3>
          {photos.length > 0 && (
            <span className="px-2 py-0.5 bg-[#deb887]/20 text-[#b8944d] rounded-full text-xs font-medium">
              {photos.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {photos.length >= 2 && (
            <button
              onClick={() => { setCompareMode(m => !m); setCompareLeft(null); setCompareRight(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                compareMode
                  ? 'bg-[#deb887]/20 border-[#deb887]/60 text-[#b8944d]'
                  : 'border-gray-200 text-gray-600 hover:border-[#deb887]/40 hover:text-[#b8944d]'
              }`}
            >
              <SplitSquareHorizontal className="w-4 h-4" />
              {compareMode ? 'Cancelar' : 'Comparar'}
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#deb887] text-white rounded-lg hover:bg-[#b8944d] transition-colors disabled:opacity-60"
          >
            <Upload className="w-4 h-4" />
            Subir Fotos
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {/* Message */}
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-green-50 text-green-700 border border-green-200'
                : 'bg-red-50 text-red-700 border border-red-200'
            }`}
          >
            {message.type === 'success'
              ? <CheckCircle className="w-4 h-4 flex-shrink-0" />
              : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload progress */}
      {uploading && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-[#deb887]/40 rounded-lg text-sm text-[#b8944d]">
          <div className="w-4 h-4 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin" />
          {uploadProgress || 'Subiendo...'}
        </div>
      )}

      {/* R2 not configured warning */}
      {r2Available === false && (
        <div className="flex items-center gap-2 px-4 py-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Almacenamiento no configurado — Configure las variables R2 en el panel de administración
        </div>
      )}

      {/* Compare mode instructions */}
      {compareMode && (
        <div className="px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
          {!compareLeft
            ? 'Selecciona la primera foto para comparar'
            : !compareRight
            ? 'Selecciona la segunda foto para comparar'
            : null}
        </div>
      )}

      {/* Filter chips */}
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilterType(opt.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filterType === opt.value
                  ? 'bg-[#deb887] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
              {opt.value !== 'all' && (
                <span className="ml-1 opacity-70">
                  ({photos.filter(p => p.photo_type === opt.value).length})
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Compare view */}
      {compareMode && compareLeft && compareRight && (
        <div className="rounded-xl overflow-hidden border border-gray-200 shadow-sm">
          <div
            ref={compareContainerRef}
            className="relative h-80 bg-gray-900 select-none cursor-col-resize"
            style={{ userSelect: 'none' }}
          >
            {/* Right image — full width base */}
            <img
              src={compareRight.r2_url}
              alt="Después"
              className="absolute inset-0 w-full h-full object-contain"
            />
            {/* Left image — clipped by slider */}
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${sliderPct}%` }}
            >
              <img
                src={compareLeft.r2_url}
                alt="Antes"
                className="absolute inset-0 h-full object-contain"
                style={{ width: compareContainerRef.current?.offsetWidth ?? '100%' }}
              />
            </div>
            {/* Slider line */}
            <div
              className="absolute top-0 bottom-0 flex items-center justify-center cursor-col-resize"
              style={{ left: `${sliderPct}%`, transform: 'translateX(-50%)' }}
              onMouseDown={handleSliderMouseDown}
            >
              <div className="w-0.5 h-full bg-white opacity-80" />
              <div className="absolute w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center">
                <ChevronLeft className="w-3 h-3 text-gray-600" />
                <ChevronRight className="w-3 h-3 text-gray-600" />
              </div>
            </div>
            {/* Labels */}
            <span className="absolute top-2 left-2 text-xs text-white bg-black/50 px-2 py-0.5 rounded">
              {TYPE_LABELS[compareLeft.photo_type]} {compareLeft.session_label ? `· ${compareLeft.session_label}` : ''}
            </span>
            <span className="absolute top-2 right-2 text-xs text-white bg-black/50 px-2 py-0.5 rounded">
              {TYPE_LABELS[compareRight.photo_type]} {compareRight.session_label ? `· ${compareRight.session_label}` : ''}
            </span>
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-white bg-black/50 px-2 py-0.5 rounded">
              {Math.round(sliderPct)}%
            </span>
          </div>
        </div>
      )}

      {/* Photo grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="aspect-square bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filteredPhotos.length === 0 && !compareMode ? (
        // Empty state
        <div
          className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-gray-200 rounded-xl text-center"
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <Camera className="w-14 h-14 text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium mb-1">Sin fotos registradas</p>
          <p className="text-gray-400 text-sm mb-4">
            {filterType !== 'all'
              ? `No hay fotos del tipo "${TYPE_LABELS[filterType as ClinicalPhoto['photo_type']]}"`
              : 'Arrastra imágenes aquí o usa el botón para subir'}
          </p>
          {filterType === 'all' && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-[#deb887] text-white rounded-lg text-sm hover:bg-[#b8944d] transition-colors"
            >
              + Subir primera foto
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filteredPhotos.map(photo => {
            const isCompareSelected = compareLeft?.id === photo.id || compareRight?.id === photo.id;
            return (
              <motion.div
                key={photo.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className={`group relative aspect-square bg-gray-100 rounded-xl overflow-hidden cursor-pointer border-2 transition-all ${
                  isCompareSelected
                    ? 'border-[#deb887] ring-2 ring-[#deb887]/40'
                    : 'border-transparent hover:border-gray-200'
                }`}
                onClick={() => compareMode ? handleCompareSelect(photo) : openLightbox(photo)}
              >
                <img
                  src={photo.r2_url}
                  alt={TYPE_LABELS[photo.photo_type]}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {/* Type badge */}
                <span className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-semibold ${TYPE_BADGE[photo.photo_type]}`}>
                  {TYPE_LABELS[photo.photo_type]}
                </span>
                {/* Compare check */}
                {compareMode && isCompareSelected && (
                  <div className="absolute top-2 right-2 w-6 h-6 bg-[#deb887] rounded-full flex items-center justify-center">
                    <CheckCircle className="w-4 h-4 text-white" />
                  </div>
                )}
                {/* Hover overlay */}
                {!compareMode && (
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                    <div className="flex gap-1 ml-auto">
                      <button
                        onClick={e => { e.stopPropagation(); setEditingPhoto(photo); }}
                        className="p-1.5 bg-white/90 rounded-lg hover:bg-white transition-colors"
                        title="Editar"
                      >
                        <Edit3 className="w-3 h-3 text-gray-700" />
                      </button>
                      <a
                        href={photo.r2_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="p-1.5 bg-white/90 rounded-lg hover:bg-white transition-colors"
                        title="Descargar"
                      >
                        <Download className="w-3 h-3 text-gray-700" />
                      </a>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(photo); }}
                        className="p-1.5 bg-white/90 rounded-lg hover:bg-red-50 transition-colors"
                        title="Eliminar"
                      >
                        <Trash2 className="w-3 h-3 text-red-500" />
                      </button>
                    </div>
                  </div>
                )}
                {/* Session label */}
                {photo.session_label && (
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1">
                    <p className="text-white text-[10px] truncate">{photo.session_label}</p>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Drop zone (shown when photos exist) */}
      {photos.length > 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`flex items-center justify-center gap-2 py-4 border-2 border-dashed rounded-xl text-sm transition-colors ${
            dragOver
              ? 'border-[#deb887] bg-[#deb887]/10 text-[#b8944d]'
              : 'border-gray-200 text-gray-400 hover:border-gray-300'
          }`}
        >
          <Upload className="w-4 h-4" />
          Arrastra fotos aquí para subir
        </div>
      )}

      {/* Lightbox */}
      <AnimatePresence>
        {selectedPhoto && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setSelectedPhoto(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="relative max-w-4xl w-full max-h-full flex flex-col gap-3"
              onClick={e => e.stopPropagation()}
            >
              {/* Close */}
              <button
                onClick={() => setSelectedPhoto(null)}
                className="absolute -top-10 right-0 text-white/70 hover:text-white"
              >
                <X className="w-6 h-6" />
              </button>
              {/* Nav */}
              {filteredPhotos.length > 1 && (
                <>
                  <button
                    onClick={() => lightboxNav(-1)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => lightboxNav(1)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}
              <img
                src={selectedPhoto.r2_url}
                alt={TYPE_LABELS[selectedPhoto.photo_type]}
                className="w-full max-h-[65vh] object-contain rounded-xl"
              />
              {/* Meta */}
              <div className="bg-white/10 backdrop-blur rounded-xl p-4 text-white text-sm flex flex-wrap gap-4">
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${TYPE_BADGE[selectedPhoto.photo_type]}`}>
                  {TYPE_LABELS[selectedPhoto.photo_type]}
                </span>
                {selectedPhoto.session_label && <span>Sesión: <strong>{selectedPhoto.session_label}</strong></span>}
                {selectedPhoto.face_zone && <span>Zona: <strong>{selectedPhoto.face_zone}</strong></span>}
                {selectedPhoto.notes && <span className="w-full text-white/80 italic">"{selectedPhoto.notes}"</span>}
                <span className="ml-auto text-white/50 text-xs">
                  {new Date(selectedPhoto.created_at).toLocaleDateString('es-CL')}
                </span>
              </div>
              {/* Counter */}
              {filteredPhotos.length > 1 && (
                <p className="text-center text-white/50 text-xs">
                  {lightboxIndex + 1} / {filteredPhotos.length}
                </p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit modal */}
      <AnimatePresence>
        {editingPhoto && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
            onClick={() => setEditingPhoto(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-gray-800">Editar foto</h4>
                <button onClick={() => setEditingPhoto(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <img
                src={editingPhoto.r2_url}
                alt=""
                className="w-full h-40 object-contain bg-gray-50 rounded-lg"
              />
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tipo de foto</label>
                  <select
                    value={editingPhoto.photo_type}
                    onChange={e => setEditingPhoto(p => p ? { ...p, photo_type: e.target.value as ClinicalPhoto['photo_type'] } : p)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-[#deb887] focus:border-[#deb887] outline-none"
                  >
                    {Object.entries(TYPE_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Etiqueta de sesión</label>
                  <input
                    type="text"
                    value={editingPhoto.session_label || ''}
                    onChange={e => setEditingPhoto(p => p ? { ...p, session_label: e.target.value } : p)}
                    placeholder="ej: Sesión 1, Mes 2..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-[#deb887] focus:border-[#deb887] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Zona</label>
                  <select
                    value={editingPhoto.face_zone || ''}
                    onChange={e => setEditingPhoto(p => p ? { ...p, face_zone: e.target.value } : p)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-[#deb887] focus:border-[#deb887] outline-none"
                  >
                    <option value="">Sin especificar</option>
                    {FACE_ZONES.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
                  <textarea
                    value={editingPhoto.notes || ''}
                    onChange={e => setEditingPhoto(p => p ? { ...p, notes: e.target.value } : p)}
                    rows={2}
                    placeholder="Observaciones adicionales..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-1 focus:ring-[#deb887] focus:border-[#deb887] outline-none resize-none"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setEditingPhoto(null)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSaveEdit}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#deb887] text-white rounded-lg text-sm hover:bg-[#b8944d] transition-colors"
                >
                  <Save className="w-4 h-4" />
                  Guardar
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
