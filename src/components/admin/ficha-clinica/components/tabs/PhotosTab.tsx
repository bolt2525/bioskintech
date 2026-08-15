import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Camera, Upload, X, Trash2, Edit3, Download,
  CheckCircle, AlertCircle, ChevronLeft, ChevronRight,
  Save, Tag, Calendar, LayoutGrid, Clock,
  SplitSquareHorizontal, ZoomIn, ZoomOut,
} from 'lucide-react';
import recordsFetch from '../../../../../utils/recordsFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClinicalPhoto {
  id: number;
  record_id: number;
  consultation_id?: number;
  consultation_date?: string;
  consultation_reason?: string;
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

type ViewMode = 'grid' | 'timeline' | 'compare';

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<ClinicalPhoto['photo_type'], string> = {
  before: 'Antes', after: 'Después', diagnostic: 'Diagnóstico',
  progress: 'Progreso', general: 'General',
};
const TYPE_BADGE: Record<ClinicalPhoto['photo_type'], string> = {
  before: 'bg-blue-100 text-blue-700', after: 'bg-green-100 text-green-700',
  diagnostic: 'bg-purple-100 text-purple-700', progress: 'bg-amber-100 text-amber-700',
  general: 'bg-gray-100 text-gray-600',
};
const TYPE_DOT: Record<ClinicalPhoto['photo_type'], string> = {
  before: 'bg-blue-400', after: 'bg-green-400', diagnostic: 'bg-purple-400',
  progress: 'bg-amber-400', general: 'bg-gray-400',
};
const FILTER_OPTIONS = [
  { value: 'all', label: 'Todos' },
  { value: 'before', label: 'Antes' }, { value: 'after', label: 'Después' },
  { value: 'diagnostic', label: 'Diagnóstico' }, { value: 'progress', label: 'Progreso' },
  { value: 'general', label: 'General' },
];
// ─── Photo card ───────────────────────────────────────────────────────────────
// Separates image click zone from action bar — eliminates hover-overlay propagation issues.

interface CardProps {
  photo: ClinicalPhoto;
  viewMode: ViewMode;
  compareLeft: ClinicalPhoto | null;
  compareRight: ClinicalPhoto | null;
  onOpen: (p: ClinicalPhoto) => void;
  onEdit: (p: ClinicalPhoto) => void;
  onDelete: (p: ClinicalPhoto) => void;
  onTypeChange: (p: ClinicalPhoto, t: ClinicalPhoto['photo_type']) => void;
  onCompareSelect: (p: ClinicalPhoto) => void;
}

function PhotoCard({ photo, viewMode, compareLeft, compareRight, onOpen, onEdit, onDelete, onTypeChange, onCompareSelect }: CardProps) {
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const isA = compareLeft?.id === photo.id;
  const isB = compareRight?.id === photo.id;
  const isSelected = isA || isB;

  const handleImageClick = () => {
    if (viewMode === 'compare') onCompareSelect(photo);
    else onOpen(photo);
  };

  return (
    <div className={`rounded-xl overflow-hidden border-2 transition-all shadow-sm bg-white ${
      isSelected ? 'border-[#deb887] ring-2 ring-[#deb887]/30' : 'border-gray-100 hover:border-gray-300'
    }`}>
      {/* Image zone — sole click target for lightbox/compare */}
      <div className="aspect-square bg-gray-100 cursor-pointer relative overflow-hidden" onClick={handleImageClick}>
        <img src={photo.r2_url} alt={TYPE_LABELS[photo.photo_type]} className="w-full h-full object-cover" loading="lazy" />
        <span className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${TYPE_BADGE[photo.photo_type]}`}>
          {TYPE_LABELS[photo.photo_type]}
        </span>
        {viewMode === 'compare' && (isA || isB) && (
          <div className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-xs shadow ${isA ? 'bg-blue-500' : 'bg-green-500'}`}>
            {isA ? 'A' : 'B'}
          </div>
        )}
        {(photo.session_label || photo.face_zone) && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 px-2 py-1">
            {photo.session_label && <p className="text-white text-[10px] truncate">{photo.session_label}</p>}
            {photo.face_zone && <p className="text-white/80 text-[9px] truncate italic">{photo.face_zone}</p>}
          </div>
        )}
      </div>

      {/* Action bar — always visible, isolated from image click zone */}
      {viewMode !== 'compare' && (
        <div className="flex items-center justify-between px-2 py-1.5 bg-white border-t border-gray-100">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowTypeMenu(m => !m)}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
              title="Cambiar categoría"
            >
              <Tag className="w-3.5 h-3.5" />
            </button>
            {showTypeMenu && (
              <div className="absolute bottom-full left-0 mb-1 bg-white rounded-xl shadow-xl border border-gray-100 p-1.5 min-w-[140px] z-30">
                {(Object.entries(TYPE_LABELS) as [ClinicalPhoto['photo_type'], string][]).map(([type, label]) => (
                  <button key={type} type="button"
                    onClick={() => { onTypeChange(photo, type); setShowTypeMenu(false); }}
                    className={`w-full text-left px-2 py-1.5 text-xs rounded-lg hover:bg-gray-50 flex items-center gap-2 ${
                      photo.photo_type === type ? 'font-semibold text-[#b8944d]' : 'text-gray-700'
                    }`}>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${TYPE_DOT[type]}`} />
                    {label}
                    {photo.photo_type === type && <CheckCircle className="w-3 h-3 text-[#b8944d] ml-auto" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={() => onEdit(photo)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors" title="Editar">
              <Edit3 className="w-3.5 h-3.5" />
            </button>
            <a href={photo.r2_url} target="_blank" rel="noopener noreferrer" download
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors" title="Descargar">
              <Download className="w-3.5 h-3.5" />
            </a>
            <button type="button" onClick={() => onDelete(photo)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition-colors" title="Eliminar">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const PAGE_SIZE = 24;

export default function PhotosTab({ recordId, consultationId }: PhotosTabProps) {
  const [photos, setPhotos] = useState<ClinicalPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [r2Available, setR2Available] = useState<boolean | null>(null);
  const [filterType, setFilterType] = useState('all');
  const [dragOver, setDragOver] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  // Grid
  const [selectedPhoto, setSelectedPhoto] = useState<ClinicalPhoto | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [editingPhoto, setEditingPhoto] = useState<ClinicalPhoto | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Compare
  const [compareLeft, setCompareLeft] = useState<ClinicalPhoto | null>(null);
  const [compareRight, setCompareRight] = useState<ClinicalPhoto | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const compareRef = useRef<HTMLDivElement>(null);

  // Timeline
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [timelineMultiSelect, setTimelineMultiSelect] = useState(false);
  const [timelineSelected, setTimelineSelected] = useState<Set<number>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredPhotos = useMemo(
    () => filterType === 'all' ? photos : photos.filter(p => p.photo_type === filterType),
    [photos, filterType],
  );

  const dateGroups = useMemo(() => {
    const map = new Map<string, { label: string; photos: ClinicalPhoto[] }>();
    for (const p of filteredPhotos) {
      const key = (p.taken_at || p.created_at)?.slice(0, 10) ?? 'sin-fecha';
      if (!map.has(key)) map.set(key, {
        label: key !== 'sin-fecha'
          ? new Date(key + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : 'Sin fecha registrada',
        photos: [],
      });
      map.get(key)!.photos.push(p);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [filteredPhotos]);

  const allDateGroups = useMemo(() => {
    const map = new Map<string, { label: string; photos: ClinicalPhoto[] }>();
    for (const p of photos) {
      const key = (p.taken_at || p.created_at)?.slice(0, 10) ?? 'sin-fecha';
      if (!map.has(key)) map.set(key, {
        label: key !== 'sin-fecha'
          ? new Date(key + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : 'Sin fecha registrada',
        photos: [],
      });
      map.get(key)!.photos.push(p);
    }
    return [...map.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [photos]);

  const timelinePhotos = useMemo(
    () => [...photos].sort((a, b) =>
      new Date(a.taken_at || a.created_at).getTime() - new Date(b.taken_at || b.created_at).getTime(),
    ),
    [photos],
  );

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => { fetchPhotos(0); }, [recordId]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSelectedPhoto(null); setEditingPhoto(null); }
      if (selectedPhoto && e.key === 'ArrowLeft') lightboxNav(-1);
      if (selectedPhoto && e.key === 'ArrowRight') lightboxNav(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Global mouse move/up for pan drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isPanning.current) {
        setPan({
          x: panOrigin.current.x + (e.clientX - panStart.current.x),
          y: panOrigin.current.y + (e.clientY - panStart.current.y),
        });
      }
    };
    const onUp = () => { isPanning.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Non-passive wheel listener on compare container to prevent page scroll
  useEffect(() => {
    const el = compareRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => {
        const next = Math.max(1, Math.min(5, z + (e.deltaY > 0 ? -0.2 : 0.2)));
        if (next <= 1) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [compareLeft, compareRight]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchPhotos = async (startOffset: number) => {
    const isReset = startOffset === 0;
    if (isReset) setLoading(true); else setLoadingMore(true);
    try {
      const res = await recordsFetch(
        `/api/records?action=listPhotos&record_id=${recordId}&limit=${PAGE_SIZE}&offset=${startOffset}`
      );
      if (res.ok) {
        const d = await res.json();
        const loaded: ClinicalPhoto[] = Array.isArray(d.photos) ? d.photos : [];
        if (isReset) setPhotos(loaded); else setPhotos(prev => [...prev, ...loaded]);
        setTotal(d.total ?? 0);
        setHasMore(d.hasMore ?? false);
        setNextOffset(startOffset + PAGE_SIZE);
      }
    } catch { setMessage({ type: 'error', text: 'Error al cargar las fotos' }); }
    finally { if (isReset) setLoading(false); else setLoadingMore(false); }
  };

  // ── Upload ─────────────────────────────────────────────────────────────────

  // ponytail: >5 MB → DIM 2048 + q 0.85 (dimensión reduce más sin perder calidad); 3.2-5 MB → DIM 2560 + q 0.88; ambos cap en q=0.65 por límite Vercel 4.5 MB
  const compressImage = (file: File): Promise<{ base64: string; type: string }> =>
    new Promise((resolve, reject) => {
      const MAX = 3.2 * 1024 * 1024;
      if (file.size <= MAX) {
        const r = new FileReader();
        r.onload = () => resolve({ base64: (r.result as string).split(',')[1], type: file.type || 'image/jpeg' });
        r.onerror = reject; r.readAsDataURL(file); return;
      }
      const isLarge = file.size > 5 * 1024 * 1024;
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        const DIM = isLarge ? 2048 : 2560;
        let { width, height } = img;
        if (width > DIM || height > DIM) {
          if (width > height) { height = Math.round(height * DIM / width); width = DIM; }
          else { width = Math.round(width * DIM / height); height = DIM; }
        }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        let q = isLarge ? 0.85 : 0.88;
        const go = () => {
          const d = canvas.toDataURL('image/jpeg', q);
          const b = d.split(',')[1];
          if (b.length * 0.75 < MAX || q <= 0.65) resolve({ base64: b, type: 'image/jpeg' });
          else { q -= 0.07; go(); }
        };
        go();
      };
      img.onerror = reject; img.src = url;
    });

  const handleUpload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    let anyFailed = false;
    for (let i = 0; i < files.length; i++) {
      try {
        setUploadProgress(`Procesando ${i + 1}/${files.length}…`);
        const { base64, type } = await compressImage(files[i]);
        setUploadProgress(`Subiendo ${i + 1}/${files.length}…`);
        const res = await recordsFetch('/api/records', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'uploadPhotoProxy', fileBase64: base64, content_type: type,
            record_id: recordId, consultation_id: consultationId,
            session_label: new Date().toLocaleDateString('es-CL'),
          }),
        });
        if (res.status === 503) { setR2Available(false); setMessage({ type: 'error', text: 'Almacenamiento R2 no configurado' }); setUploading(false); setUploadProgress(''); return; }
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Error ${res.status}`); }
        setR2Available(true);
      } catch (err: any) { anyFailed = true; setMessage({ type: 'error', text: err.message || 'Error al subir' }); }
    }
    setUploading(false); setUploadProgress('');
    if (!anyFailed) setMessage({ type: 'success', text: `${files.length} foto(s) subida(s)` });
    await fetchPhotos(0);
  }, [recordId, consultationId]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) handleUpload(files);
  };

  // ── CRUD ───────────────────────────────────────────────────────────────────

  const handleDelete = async (photo: ClinicalPhoto) => {
    if (!confirm('¿Eliminar esta foto? Esta acción no se puede deshacer.')) return;
    const res = await recordsFetch('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deletePhoto', id: photo.id }),
    });
    if (res.ok) {
      setPhotos(prev => prev.filter(p => p.id !== photo.id));
      if (selectedPhoto?.id === photo.id) setSelectedPhoto(null);
      if (compareLeft?.id === photo.id) setCompareLeft(null);
      if (compareRight?.id === photo.id) setCompareRight(null);
      setMessage({ type: 'success', text: 'Foto eliminada' });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingPhoto) return;
    const res = await recordsFetch('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updatePhoto', id: editingPhoto.id, photo_type: editingPhoto.photo_type, notes: editingPhoto.notes, session_label: editingPhoto.session_label, face_zone: editingPhoto.face_zone }),
    });
    if (res.ok) { setPhotos(prev => prev.map(p => p.id === editingPhoto.id ? editingPhoto : p)); setMessage({ type: 'success', text: 'Foto actualizada' }); setEditingPhoto(null); }
  };

  const handleTypeChange = async (photo: ClinicalPhoto, newType: ClinicalPhoto['photo_type']) => {
    if (photo.photo_type === newType) return;
    const res = await recordsFetch('/api/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updatePhoto', id: photo.id, photo_type: newType }),
    });
    if (res.ok) setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, photo_type: newType } : p));
  };

  // ── Lightbox ───────────────────────────────────────────────────────────────

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

  // ── Compare ────────────────────────────────────────────────────────────────

  const resetCompare = () => { setCompareLeft(null); setCompareRight(null); setZoom(1); setPan({ x: 0, y: 0 }); };

  const handleCompareSelect = (photo: ClinicalPhoto) => {
    if (compareLeft?.id === photo.id) { setCompareLeft(compareRight); setCompareRight(null); return; }
    if (compareRight?.id === photo.id) { setCompareRight(null); return; }
    if (!compareLeft) { setCompareLeft(photo); return; }
    if (!compareRight) { setCompareRight(photo); return; }
    setCompareLeft(photo); setCompareRight(null);
  };

  const imgStyle = {
    transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
    transformOrigin: 'center center',
  };

  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // ── Shared card props ──────────────────────────────────────────────────────

  const cardProps = {
    viewMode, compareLeft, compareRight,
    onOpen: openLightbox, onEdit: setEditingPhoto, onDelete: handleDelete,
    onTypeChange: handleTypeChange, onCompareSelect: handleCompareSelect,
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-[#b8944d]" />
          <h3 className="text-lg font-semibold text-gray-800">Registro Fotográfico</h3>
          {total > 0 && (
            <span className="px-2 py-0.5 bg-[#deb887]/20 text-[#b8944d] rounded-full text-xs font-medium">{total}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* View mode tabs */}
          {photos.length >= 1 && (
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              {([
                ['grid', LayoutGrid, 'Galería'],
                ['timeline', Clock, 'Línea de tiempo'],
                ['compare', SplitSquareHorizontal, 'Comparar'],
              ] as [ViewMode, React.ElementType, string][]).map(([mode, Icon, label]) => (
                <button key={mode} type="button"
                  onClick={() => { setViewMode(mode); if (mode !== 'compare') resetCompare(); }}
                  className={`flex items-center gap-1 px-3 py-2 font-medium transition-colors ${
                    viewMode === mode ? 'bg-[#deb887] text-white' : 'text-gray-600 hover:bg-gray-50'
                  }`}>
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-[#deb887] text-white rounded-lg hover:bg-[#b8944d] transition-colors disabled:opacity-60">
            <Upload className="w-4 h-4" />
            Subir Fotos
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
            onChange={e => { if (e.target.files?.length) { handleUpload(Array.from(e.target.files)); e.target.value = ''; } }} />
        </div>
      </div>

      {/* ── Status banners ─────────────────────────────────────────── */}
      <AnimatePresence>
        {message && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm border ${
              message.type === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
            }`}>
            {message.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>

      {uploading && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-[#deb887]/40 rounded-lg text-sm text-[#b8944d]">
          <div className="w-4 h-4 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin" />
          {uploadProgress || 'Subiendo…'}
        </div>
      )}

      {/* ── Filter chips — solo en vista galería ────────────────── */}
      {viewMode === 'grid' && photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map(opt => (
            <button key={opt.value} type="button" onClick={() => setFilterType(opt.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filterType === opt.value ? 'bg-[#deb887] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {opt.label}
              {opt.value !== 'all' && <span className="ml-1 opacity-70">({photos.filter(p => p.photo_type === opt.value).length})</span>}
            </button>
          ))}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          VISTA GALERÍA
      ════════════════════════════════════════════════════════════ */}
      {viewMode === 'grid' && (
        <>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {[1, 2, 3, 4].map(i => <div key={i} className="aspect-square bg-gray-100 rounded-xl animate-pulse" />)}
            </div>
          ) : filteredPhotos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-gray-200 rounded-xl"
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)} onDrop={handleDrop}>
              <Camera className="w-14 h-14 text-gray-300 mb-3" />
              <p className="text-gray-500 font-medium mb-1">Sin fotos registradas</p>
              <p className="text-gray-400 text-sm mb-4">Arrastra imágenes aquí o usa el botón para subir</p>
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-[#deb887] text-white rounded-lg text-sm hover:bg-[#b8944d]">
                + Subir primera foto
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {dateGroups.map(([key, group]) => {
                const isCollapsed = collapsedGroups.has(key);
                return (
                  <div key={key}>
                    <button type="button" onClick={() => toggleGroup(key)}
                      className="flex items-center gap-2 w-full mb-3 text-left">
                      <Calendar className="w-4 h-4 text-[#b8944d]" />
                      <span className="text-sm font-semibold text-gray-700">{group.label}</span>
                      <span className="text-xs text-gray-400">({group.photos.length})</span>
                      <ChevronRight className={`w-3.5 h-3.5 text-gray-300 ml-auto transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                      <div className="flex-1 h-px bg-gray-100 ml-1" />
                    </button>
                    {!isCollapsed && (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                        {group.photos.map(photo => <PhotoCard key={photo.id} photo={photo} {...cardProps} />)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {hasMore && (
            <div className="flex justify-center mt-2">
              <button type="button" disabled={loadingMore} onClick={() => fetchPhotos(nextOffset)}
                className="flex items-center gap-2 px-5 py-2 rounded-lg border border-[#deb887] text-[#b8944d] text-sm font-medium hover:bg-[#deb887]/10 transition-colors disabled:opacity-60">
                {loadingMore
                  ? <><div className="w-3.5 h-3.5 border-2 border-[#deb887] border-t-transparent rounded-full animate-spin" />Cargando…</>
                  : `Cargar más fotos (${total - photos.length} restantes)`}
              </button>
            </div>
          )}

          {photos.length > 0 && (
            <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
              className={`flex items-center justify-center gap-2 py-4 border-2 border-dashed rounded-xl text-sm mt-2 transition-colors ${
                dragOver ? 'border-[#deb887] bg-[#deb887]/10 text-[#b8944d]' : 'border-gray-200 text-gray-400 hover:border-gray-300'
              }`}>
              <Upload className="w-4 h-4" />
              Arrastra fotos aquí para subir
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════════
          VISTA LÍNEA DE TIEMPO — carrusel cronológico
      ════════════════════════════════════════════════════════════ */}
      {viewMode === 'timeline' && (
        <div className="space-y-4">
          {!loading && timelinePhotos.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">
                {timelineMultiSelect && timelineSelected.size > 0
                  ? `${timelineSelected.size} foto(s) seleccionada(s)`
                  : `${timelinePhotos.length} foto(s) en total`}
              </span>
              <button type="button"
                onClick={() => { setTimelineMultiSelect(m => !m); setTimelineSelected(new Set()); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  timelineMultiSelect ? 'bg-[#deb887] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>
                <CheckCircle className="w-3.5 h-3.5" />
                {timelineMultiSelect ? 'Cancelar selección' : 'Selección múltiple'}
              </button>
            </div>
          )}
          {loading || timelinePhotos.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              {loading ? 'Cargando…' : 'No hay fotos para mostrar en la línea de tiempo'}
            </div>
          ) : timelineMultiSelect ? (
            <div className="space-y-4">
              {allDateGroups.map(([dateKey, group]) => (
                <div key={dateKey}>
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="w-3.5 h-3.5 text-[#b8944d]" />
                    <span className="text-xs font-semibold text-gray-700">{group.label}</span>
                    <span className="text-xs text-gray-400">({group.photos.length})</span>
                  </div>
                  <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    {group.photos.map(photo => {
                      const isSel = timelineSelected.has(photo.id);
                      return (
                        <button key={photo.id} type="button"
                          onClick={() => setTimelineSelected(prev => { const n = new Set(prev); n.has(photo.id) ? n.delete(photo.id) : n.add(photo.id); return n; })}
                          className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-all ${
                            isSel ? 'border-[#deb887] ring-2 ring-[#deb887]/40' : 'border-transparent hover:border-gray-300'
                          }`}>
                          <img src={photo.r2_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          {isSel && (
                            <div className="absolute top-1 right-1 w-5 h-5 bg-[#deb887] rounded-full flex items-center justify-center">
                              <CheckCircle className="w-3.5 h-3.5 text-white" />
                            </div>
                          )}
                          <span className={`absolute top-1 left-1 px-1 py-0.5 rounded text-[8px] font-semibold leading-tight ${TYPE_BADGE[photo.photo_type]}`}>
                            {TYPE_LABELS[photo.photo_type].slice(0, 3)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Carrusel principal */}
              <div className="relative bg-gray-900 rounded-xl overflow-hidden" style={{ height: 420 }}>
                <AnimatePresence mode="wait">
                  <motion.img key={timelinePhotos[timelineIndex]?.id} src={timelinePhotos[timelineIndex]?.r2_url}
                    alt="" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }}
                    transition={{ duration: 0.2 }} className="w-full h-full object-contain" />
                </AnimatePresence>
                {/* Info overlay */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pointer-events-none">
                  <div className="flex items-end justify-between">
                    <div>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${TYPE_BADGE[timelinePhotos[timelineIndex]?.photo_type]}`}>
                        {TYPE_LABELS[timelinePhotos[timelineIndex]?.photo_type]}
                      </span>
                      {timelinePhotos[timelineIndex]?.session_label && (
                        <p className="text-white text-sm mt-1">{timelinePhotos[timelineIndex].session_label}</p>
                      )}
                      {timelinePhotos[timelineIndex]?.notes && (
                        <p className="text-white/70 text-xs italic mt-0.5">"{timelinePhotos[timelineIndex].notes}"</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-white/70 text-xs">
                        {new Date(timelinePhotos[timelineIndex]?.taken_at || timelinePhotos[timelineIndex]?.created_at)
                          .toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </p>
                      <p className="text-white/40 text-xs mt-0.5">{timelineIndex + 1} / {timelinePhotos.length}</p>
                    </div>
                  </div>
                </div>
                {/* Navigation */}
                {timelinePhotos.length > 1 && (
                  <>
                    <button type="button"
                      onClick={() => setTimelineIndex(i => (i - 1 + timelinePhotos.length) % timelinePhotos.length)}
                      className="absolute left-3 top-1/2 -translate-y-1/2 p-2.5 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors">
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    <button type="button"
                      onClick={() => setTimelineIndex(i => (i + 1) % timelinePhotos.length)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors">
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>

              {/* Thumbnail strip */}
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                {timelinePhotos.map((photo, idx) => (
                  <button key={photo.id} type="button" onClick={() => setTimelineIndex(idx)}
                    className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${
                      idx === timelineIndex ? 'border-[#deb887] scale-105 ring-2 ring-[#deb887]/40' : 'border-transparent opacity-50 hover:opacity-80'
                    }`}>
                    <img src={photo.r2_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>

              {/* Dot timeline */}
              <div className="relative overflow-x-auto pb-2 scrollbar-hide">
                <div className="absolute left-0 right-0 h-px bg-gray-200" style={{ top: 6 }} />
                <div className="flex items-start gap-0 min-w-max px-2">
                  {timelinePhotos.map((photo, idx) => (
                    <button key={photo.id} type="button" onClick={() => setTimelineIndex(idx)}
                      className="flex flex-col items-center gap-1 px-3 group" style={{ minWidth: 64 }}>
                      <div className={`w-3 h-3 rounded-full border-2 z-10 transition-all ${
                        idx === timelineIndex
                          ? 'bg-[#deb887] border-[#deb887] scale-125'
                          : `${TYPE_DOT[photo.photo_type]} border-white ring-1 ring-gray-300 group-hover:scale-110`
                      }`} />
                      <span className="text-[9px] text-gray-400 whitespace-nowrap group-hover:text-gray-600">
                        {new Date(photo.taken_at || photo.created_at).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' })}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          VISTA COMPARAR — selección libre + slider + zoom sincronizado
      ════════════════════════════════════════════════════════════ */}
      {viewMode === 'compare' && (
        <div className="space-y-4">
          {/* Instrucción contextual */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
            <SplitSquareHorizontal className="w-4 h-4 flex-shrink-0" />
            {!compareLeft ? 'Selecciona la foto A (azul) en la galería de abajo — de cualquier categoría'
              : !compareRight ? 'Ahora selecciona la foto B (verde) — pueden ser de categorías diferentes'
              : 'Rueda del ratón = zoom sincronizado en ambas fotos · Arrastra para mover · Ambas imágenes se mueven juntas'}
          </div>

          {/* Panel comparación — aparece cuando hay 2 fotos seleccionadas */}
          {compareLeft && compareRight && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">Zoom {zoom.toFixed(1)}x</span>
                  <button type="button" onClick={() => setZoom(z => Math.max(1, z - 0.25))} className="p-1 rounded hover:bg-gray-100 text-gray-600"><ZoomOut className="w-4 h-4" /></button>
                  <button type="button" onClick={() => setZoom(z => Math.min(5, z + 0.25))} className="p-1 rounded hover:bg-gray-100 text-gray-600"><ZoomIn className="w-4 h-4" /></button>
                  <button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                    className="px-2 py-0.5 text-xs rounded border border-gray-200 hover:bg-gray-50 text-gray-600">Reset</button>
                </div>
                <button type="button" onClick={resetCompare} className="text-xs text-gray-400 hover:text-gray-600 underline">Cambiar selección</button>
              </div>

              {/* Side-by-side container — ambas fotos completas con zoom/pan sincronizado */}
              <div ref={compareRef}
                className="flex gap-1 rounded-xl overflow-hidden border border-gray-200 select-none bg-gray-900"
                style={{ height: 440, cursor: zoom > 1 ? 'grab' : 'default', userSelect: 'none' }}
                onMouseDown={e => {
                  isPanning.current = true;
                  panStart.current = { x: e.clientX, y: e.clientY };
                  panOrigin.current = pan;
                }}>
                {/* Panel A — foto completa izquierda */}
                <div className="relative flex-1 overflow-hidden flex items-center justify-center bg-gray-900">
                  <img src={compareLeft.r2_url} alt="A" className="w-full h-full object-contain" style={imgStyle} draggable={false} />
                  <span className="absolute top-2 left-2 z-10 text-xs font-medium text-white bg-blue-500/80 px-2 py-0.5 rounded pointer-events-none">
                    A · {TYPE_LABELS[compareLeft.photo_type]}{compareLeft.session_label ? ` · ${compareLeft.session_label}` : ''}
                  </span>
                </div>
                {/* Separador */}
                <div className="w-0.5 bg-white/30 flex-shrink-0" />
                {/* Panel B — foto completa derecha */}
                <div className="relative flex-1 overflow-hidden flex items-center justify-center bg-gray-900">
                  <img src={compareRight.r2_url} alt="B" className="w-full h-full object-contain" style={imgStyle} draggable={false} />
                  <span className="absolute top-2 right-2 z-10 text-xs font-medium text-white bg-green-500/80 px-2 py-0.5 rounded pointer-events-none">
                    B · {TYPE_LABELS[compareRight.photo_type]}{compareRight.session_label ? ` · ${compareRight.session_label}` : ''}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Galería de selección — todos los tipos, agrupados por categoría */}
          <div className="space-y-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Seleccionar fotos — toca para marcar A o B</p>
            {loading ? (
              <div className="grid grid-cols-4 gap-2">{[1,2,3,4].map(i => <div key={i} className="aspect-square bg-gray-100 rounded-lg animate-pulse" />)}</div>
            ) : photos.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">Sin fotos disponibles</p>
            ) : (
              allDateGroups.map(([dateKey, group]) => (
                <div key={dateKey}>
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="w-3.5 h-3.5 text-[#b8944d]" />
                    <span className="text-xs font-medium text-gray-600">{group.label} ({group.photos.length})</span>
                  </div>
                  <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    {group.photos.map(photo => {
                      const isA = compareLeft?.id === photo.id;
                      const isB = compareRight?.id === photo.id;
                      return (
                        <button key={photo.id} type="button" onClick={() => handleCompareSelect(photo)}
                          className={`aspect-square rounded-lg overflow-hidden border-2 relative transition-all ${
                            isA ? 'border-blue-500 ring-2 ring-blue-300' : isB ? 'border-green-500 ring-2 ring-green-300' : 'border-transparent hover:border-gray-300 hover:scale-105'
                          }`}>
                          <img src={photo.r2_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          {(isA || isB) && (
                            <div className={`absolute inset-0 flex items-center justify-center text-white font-bold text-lg ${isA ? 'bg-blue-500/40' : 'bg-green-500/40'}`}>
                              {isA ? 'A' : 'B'}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════
          LIGHTBOX
      ════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {selectedPhoto && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setSelectedPhoto(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="relative max-w-4xl w-full flex flex-col gap-3"
              onClick={e => e.stopPropagation()}>
              <button onClick={() => setSelectedPhoto(null)} className="absolute -top-10 right-0 text-white/70 hover:text-white">
                <X className="w-6 h-6" />
              </button>
              {filteredPhotos.length > 1 && (
                <>
                  <button onClick={() => lightboxNav(-1)} className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white">
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button onClick={() => lightboxNav(1)} className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full text-white">
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}
              <img src={selectedPhoto.r2_url} alt={TYPE_LABELS[selectedPhoto.photo_type]} className="w-full max-h-[65vh] object-contain rounded-xl" />
              <div className="bg-white/10 backdrop-blur rounded-xl p-4 text-white text-sm flex flex-wrap gap-4">
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${TYPE_BADGE[selectedPhoto.photo_type]}`}>
                  {TYPE_LABELS[selectedPhoto.photo_type]}
                </span>
                {selectedPhoto.session_label && <span>Sesión: <strong>{selectedPhoto.session_label}</strong></span>}
                {selectedPhoto.face_zone && <span>Zona: <strong>{selectedPhoto.face_zone}</strong></span>}
                {selectedPhoto.notes && <span className="w-full text-white/80 italic">"{selectedPhoto.notes}"</span>}
                <span className="ml-auto text-white/50 text-xs">{new Date(selectedPhoto.created_at).toLocaleDateString('es-CL')}</span>
              </div>
              {filteredPhotos.length > 1 && (
                <p className="text-center text-white/50 text-xs">{lightboxIndex + 1} / {filteredPhotos.length}</p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════════════════════════════
          EDIT MODAL
      ════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {editingPhoto && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
            onClick={() => setEditingPhoto(null)}>
            <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
              className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-gray-800">Editar foto</h4>
                <button onClick={() => setEditingPhoto(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
              </div>
              <img src={editingPhoto.r2_url} alt="" className="w-full h-40 object-contain bg-gray-50 rounded-lg" />

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Tipo</label>
                <div className="grid grid-cols-3 gap-2">
                  {(Object.entries(TYPE_LABELS) as [ClinicalPhoto['photo_type'], string][]).map(([type, label]) => (
                    <button key={type} type="button"
                      onClick={() => setEditingPhoto(p => p ? { ...p, photo_type: type } : p)}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        editingPhoto.photo_type === type ? 'bg-[#deb887]/20 border-[#deb887] text-[#b8944d]' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Descripción / Zona</label>
                <input value={editingPhoto.face_zone || ''} onChange={e => setEditingPhoto(p => p ? { ...p, face_zone: e.target.value } : p)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Ej: dorso nasal, frente, mejillas…" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Etiqueta de sesión</label>
                <input value={editingPhoto.session_label || ''} onChange={e => setEditingPhoto(p => p ? { ...p, session_label: e.target.value } : p)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Ej: Sesión 1, Pre-tratamiento…" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
                <textarea value={editingPhoto.notes || ''} onChange={e => setEditingPhoto(p => p ? { ...p, notes: e.target.value } : p)}
                  rows={2} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" placeholder="Observaciones…" />
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setEditingPhoto(null)}
                  className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
                <button type="button" onClick={handleSaveEdit}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 bg-[#deb887] text-white rounded-lg text-sm hover:bg-[#b8944d]">
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
