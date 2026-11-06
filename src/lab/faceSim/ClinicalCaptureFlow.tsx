import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Images, Upload, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import Clinical3DViewer from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import Skin3DBoundary from '../../components/admin/ficha-clinica/components/Skin3DBoundary';
import { FACE_OVAL } from './engine';
import { moveFaceLandmark } from './faceContour';
import genericFaceAtlas from './genericFaceAtlas.json' with { type: 'json' };

type Landmark = { x: number; y: number; z: number };
export interface ClinicalCapture {
  id: string;
  label: string;
  canvas: HTMLCanvasElement;
  landmarks?: Landmark[];
  error?: string;
  warnings?: string[];
}
export interface ReviewedCapture { id: string; landmarks: Landmark[] }
const action = 'admin-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50';
const primary = 'admin-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gold px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gold-dark disabled:opacity-50';

function PhotoGuide() {
  return <section aria-label="Guía de fotografías" className="rounded-2xl bg-slate-50 p-4">
    <div className="mb-3"><h3 className="font-semibold">Empieza con una foto de frente</h3>
      <p className="text-sm text-gray-600">Añade ambos ángulos de 45° para ver mejor los laterales. Son opcionales.</p></div>
    <div className="grid grid-cols-3 gap-2">
      {(['Oblicua izquierda', 'Frontal', 'Oblicua derecha'] as const).map((label, index) => <div key={label}
        className={`rounded-xl border p-2 text-center ${index === 1 ? 'border-gold bg-gold-light/40' : 'border-gray-200 bg-white'}`}>
        <svg viewBox="0 0 100 100" className="mx-auto h-20 w-20 max-w-full" aria-hidden="true">
          <path d="M22 94c1-21 55-21 56 0M37 68v12m26-12v12" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400" />
          <g transform={index === 2 ? 'translate(100 0) scale(-1 1)' : undefined}>
            <path d={index === 1 ? 'M28 34c0-32 44-32 44 0v15c0 34-44 34-44 0Z' : 'M33 20q26-16 36 11l-2 12 8 9-10 5q-1 23-19 18-21-7-19-33Z'}
              fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth="2" className="text-gold-ink" />
            <path d={index === 1 ? 'M37 39h5m16 0h5M50 42v11h4m-12 9q8 4 16 0' : 'M52 39h6m-9 22q6 3 12 0'}
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </g>
        </svg>
        <p className="text-xs font-semibold">{label}</p><p className="mt-1 text-[11px] text-gray-500">{index === 1 ? 'Necesaria' : 'Opcional · 45°'}</p>
      </div>)}
    </div>
    <p className="mt-3 text-xs text-gray-500">Buena luz, rostro despejado y sin filtros. ¿No tienes fotos ahora? Puedes volver después; tus marcas se conservan.</p>
  </section>;
}

function CaptureCard({ capture, onChange, disabled }: { capture: ClinicalCapture;
  onChange: (value: ReviewedCapture | null) => void; disabled: boolean }) {
  const preview = useRef<HTMLCanvasElement>(null);
  const [included, setIncluded] = useState(!!capture.landmarks);
  const [points, setPoints] = useState(capture.landmarks);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(10);
  const [error, setError] = useState('');
  useEffect(() => {
    const canvas = preview.current;
    if (canvas) { canvas.width = capture.canvas.width; canvas.height = capture.canvas.height;
      canvas.getContext('2d')?.drawImage(capture.canvas, 0, 0); }
  }, [capture.canvas]);
  function update(target: { x: number; y: number }) {
    if (!points || disabled) return;
    const next = moveFaceLandmark(points, selected, target, capture.canvas.width / capture.canvas.height, genericFaceAtlas.triangles);
    if (!next) { setError('Acerca el punto al borde original.'); return; }
    setPoints(next); setError('');
    if (included) onChange({ id: capture.id, landmarks: next });
  }
  return <article className={`min-w-0 overflow-hidden rounded-2xl border ${included ? 'border-gold bg-gold-light/30' : 'border-gray-200 bg-gray-50'}`}>
    <div className="relative bg-slate-950">
      <canvas ref={preview} role="img" aria-label={`Foto para confirmar ${capture.label}`}
        className="block h-auto max-h-[42dvh] w-full object-contain" />
      {points && <svg viewBox={`0 0 ${capture.canvas.width} ${capture.canvas.height}`} preserveAspectRatio="xMidYMid meet"
        className={`absolute inset-0 h-full w-full ${editing ? 'touch-none cursor-crosshair' : 'pointer-events-none'}`}
        aria-label={editing ? `Ajustar límite de ${capture.label}` : undefined}
        onPointerDown={e => {
          if (!editing) return;
          const r = e.currentTarget.getBoundingClientRect(), scale = Math.min(r.width / capture.canvas.width, r.height / capture.canvas.height);
          const x = (e.clientX - r.left - (r.width - capture.canvas.width * scale) / 2) / (capture.canvas.width * scale);
          const y = (e.clientY - r.top - (r.height - capture.canvas.height * scale) / 2) / (capture.canvas.height * scale);
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) update({ x, y });
        }}>
        <polygon points={FACE_OVAL.map(i => `${points[i].x * capture.canvas.width},${points[i].y * capture.canvas.height}`).join(' ')}
          fill="none" stroke="#38bdf8" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {FACE_OVAL.map(i => <circle key={i} cx={points[i].x * capture.canvas.width} cy={points[i].y * capture.canvas.height}
          r={(editing && i === selected ? .012 : .004) * capture.canvas.width} fill={editing && i === selected ? '#f59e0b' : '#38bdf8'}
          stroke="white" strokeWidth={1} vectorEffect="non-scaling-stroke"
          onPointerDown={e => { if (editing) { e.stopPropagation(); setSelected(i); } }} />)}
      </svg>}
    </div>
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="h-4 w-4 accent-gold-ink" checked={included} disabled={disabled || !points}
            onChange={e => { setIncluded(e.target.checked); onChange(e.target.checked && points ? { id: capture.id, landmarks: points } : null); }} />
          Usar {capture.label}
        </label>
        {points && <button type="button" className="admin-focus-ring min-h-11 rounded-lg px-2 py-2 text-xs font-medium text-gray-600 hover:bg-white"
          disabled={disabled} aria-expanded={editing} onClick={() => setEditing(value => !value)}>{editing ? 'Listo' : 'Ajustar borde'}</button>}
      </div>
      {editing && points && <div className="space-y-2 rounded-xl bg-white p-2">
        <label className="block text-xs">Punto del borde
          <select className="admin-focus-ring mt-1 w-full rounded-lg border p-2" value={selected} onChange={e => setSelected(Number(e.target.value))}>
            {FACE_OVAL.map((id, i) => <option key={id} value={id}>{id === 10 ? 'Frente' : id === 152 ? 'Mentón' : `Borde ${i + 1}`}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">{(['x', 'y'] as const).map(axis => <label key={axis} className="text-xs">Posición {axis.toUpperCase()} (%)
          <input className="admin-focus-ring mt-1 w-full rounded-lg border p-2" type="number" min={0} max={100} step={.1}
            value={Math.round(points[selected][axis] * 1000) / 10}
            onChange={e => { if (e.currentTarget.value && e.currentTarget.validity.valid) update({ ...points[selected], [axis]: Number(e.target.value) / 100 }); }} />
        </label>)}</div>
      </div>}
      {capture.error && <p role="alert" className="text-xs text-red-700">{capture.error}</p>}
      {!!capture.warnings?.length && <p className="text-xs text-amber-800">{capture.warnings.join(' ')}</p>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </div>
  </article>;
}

export default function ClinicalCaptureFlow({ open, onClose, photos, busy, status, library, onFiles, onConfirm,
  candidate, onAccept, blocked, onAssign, coverage }: {
  open: boolean; onClose: () => void; photos: ClinicalCapture[]; busy: boolean; status: string;
  library?: ReactNode; onFiles: (files: File[]) => void; onConfirm: (photos: ReviewedCapture[]) => void;
  candidate?: ArrayBuffer; onAccept: () => void; blocked: boolean;
  onAssign: (id: string, view: string) => void;
  coverage: string;
}) {
  const [source, setSource] = useState<'upload' | 'library'>('upload');
  const [reviewed, setReviewed] = useState<Record<string, ReviewedCapture | null>>({});
  useEffect(() => { if (!busy && photos.length) setSource('upload'); }, [busy, photos.length]);
  const selected = photos.flatMap(photo => {
    const choice = reviewed[photo.id];
    return choice === null ? [] : choice ? [choice] : photo.landmarks ? [{ id: photo.id, landmarks: photo.landmarks }] : [];
  });
  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} labelledBy="clinical-capture-title">
    <div className="flex max-h-[calc(100dvh-2rem)] w-[min(70rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white text-gray-900 shadow-xl">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
        <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{candidate ? 'Paso 3 de 3' : photos.length ? 'Paso 2 de 3' : 'Paso 1 de 3'} · Máscara facial</p>
          <h2 id="clinical-capture-title" className="text-lg font-semibold">{candidate ? 'Confirmar máscara' : photos.length ? 'Revisar fotos juntas' : 'Elegir fotografías'}</h2>
        </div>
        <button type="button" className={`${action} !min-h-10 !px-2`} aria-label="Cerrar selección de fotos" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {!candidate && <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Origen de las fotos">
            <label className={`${action} cursor-pointer focus-within:ring-2 focus-within:ring-gold-ink ${busy || blocked ? 'pointer-events-none opacity-50' : ''}`}>
              <Upload size={17} aria-hidden="true" /> Subir una o varias fotos
              <input type="file" accept="image/*" multiple className="sr-only" disabled={busy || blocked}
                onChange={e => { setSource('upload'); onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            </label>
            {library && <button type="button" className={action} aria-pressed={source === 'library'} disabled={busy || blocked}
              onClick={() => setSource(value => value === 'library' ? 'upload' : 'library')}><Images size={17} aria-hidden="true" /> Fotos del expediente</button>}
          </div>
          {!photos.length && <PhotoGuide />}
          {source === 'library' && library}
          {!!photos.length && <>
            <p className="text-sm text-gray-600">{photos.length} foto(s) · revisa los bordes sugeridos y desmarca las que no quieras usar.</p>
            {photos.length === 1 && <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-gray-600">
              Una frontal es suficiente. Las oblicuas son opcionales; con una sola foto la cobertura lateral y la profundidad son limitadas.
            </p>}
            <div className={`grid gap-4 ${photos.length === 1 ? 'mx-auto max-w-lg' : 'md:grid-cols-2 xl:grid-cols-3'}`}>
              {photos.map(photo => <div key={`${photo.id}:${!!photo.landmarks}`} className="min-w-0 space-y-2">
                <CaptureCard capture={photo} disabled={busy || blocked}
                  onChange={value => setReviewed(current => ({ ...current, [photo.id]: value }))} />
                {photo.id.startsWith('extra') && photo.landmarks && <label className="block text-xs text-gray-600">Confirma la vista
                  <select className="admin-focus-ring mt-1 min-h-11 w-full rounded-lg border p-2" value="" disabled={busy || blocked}
                    onChange={e => { if (e.target.value) onAssign(photo.id, e.target.value); }}>
                    <option value="">Referencia sin vista asignada</option>
                    {[['frontal', 'Frontal'], ['izquierda', 'Oblicua izquierda'], ['derecha', 'Oblicua derecha']].map(([id, label]) =>
                      <option key={id} value={id} disabled={photos.some(item => item.id === id)}>{label}</option>)}
                  </select>
                </label>}
              </div>)}
            </div>
          </>}
        </>}
        {candidate && <><Skin3DBoundary onPhoto={onClose}><Clinical3DViewer modelData={candidate} markers={[]} readOnly height="min(48dvh,460px)" cameraPreset="face-surface" /></Skin3DBoundary>
          <p role="status" className="text-sm text-amber-800">{coverage}</p>
          <p className="text-sm text-gray-600">Aproximación visual. Las zonas ocultas no acreditan piel observada.</p></>}
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-gray-600"><span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-gold-ink motion-reduce:animate-none" />{status || 'Procesando fotos…'}</p>}
        {!busy && status && <p role="status" className="text-sm text-amber-800">{status}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-gray-100 bg-gray-50 px-5 py-4">
        <p className="max-w-md text-xs text-gray-500">{candidate ? 'Las marcas originales se conservan.' : 'Al confirmar verificas que las fotos son de la misma persona y los bordes corresponden a piel visible.'}</p>
        <div className="flex flex-wrap gap-2">
        <button type="button" className={action} disabled={busy} onClick={onClose}>{photos.length || candidate ? 'Cancelar' : 'Ahora no'}</button>
        {!candidate && !!photos.length && <button type="button" className={action} disabled={busy} onClick={onClose}>Continuar solo en foto</button>}
        <button type="button" className={primary} disabled={busy || (!candidate && (!selected.length || blocked))}
          onClick={() => candidate ? onAccept() : onConfirm(selected)}><Check size={17} aria-hidden="true" />
          {candidate ? 'Usar máscara' : 'Confirmar fotos y generar máscara'}</button>
        </div>
      </footer>
    </div>
  </Dialog>;
}
