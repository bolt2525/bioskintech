import { useEffect, useRef, useState } from 'react';
import { FACE_OVAL, type P2 } from './engine';
import { extendVisibleForehead, moveFaceLandmark, proposeForeheadBoundary } from './faceContour';

type Landmark = { x: number; y: number; z: number };
interface Props {
  canvas: HTMLCanvasElement;
  landmarks: Landmark[];
  triangles: readonly number[];
  onApply: (landmarks: Landmark[], foreheadReviewed: boolean) => void;
  onClose: () => void;
}

export default function FaceBoundaryReview({ canvas, landmarks, triangles, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState(landmarks);
  const [selected, setSelected] = useState(10);
  const [forehead, setForehead] = useState<P2 | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const aspect = canvas.width / canvas.height;
  const point = selected === 10 && forehead ? forehead : points[selected];
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    const context = preview.current?.getContext('2d');
    context?.drawImage(canvas, 0, 0);
    const source = canvas.getContext('2d');
    if (!source) { setError('No se pudo leer la imagen; conserva el contorno o vuelve a cargarla.'); return; }
    const proposal = proposeForeheadBoundary(landmarks, source.getImageData(0, 0, canvas.width, canvas.height));
    setForehead(proposal.point ?? null);
    if (!proposal.point) setError('Sin borde superior claro. Selecciona la frente sobre la foto o conserva el límite detectado.');
  }, [canvas, landmarks]);
  const update = (target: P2) => {
    setConfirmed(false);
    if (selected === 10) { setForehead(target); setError(''); return; }
    const next = moveFaceLandmark(points, selected, target, aspect, triangles);
    if (!next) { setError('Movimiento excesivo o malla invertida. Acerca el punto a su posición anterior.'); return; }
    setPoints(next); setError('');
  };
  const apply = () => {
    const next = forehead ? extendVisibleForehead(points, forehead, aspect, triangles) : points;
    if (!next) { setError('El borde propuesto de la frente deforma la malla. Mueve el límite o conserva el original.'); return; }
    onApply(next, true); onClose();
  };
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="boundary-title"
    className="w-[min(94vw,820px)] max-h-[92dvh] overflow-y-auto overscroll-contain rounded-2xl bg-white p-4 text-slate-800 shadow-xl backdrop:bg-slate-950/70">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id="boundary-title" className="font-semibold">Revisar límites del rostro</h2>
      <button type="button" onClick={onClose} aria-label="Cerrar revisión" className="admin-focus-ring rounded-lg border px-3 py-2">Cerrar</button>
    </div>
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_230px]">
      <div className="relative self-start overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: String(aspect) }}>
        <canvas ref={preview} width={canvas.width} height={canvas.height} className="h-full w-full" aria-label="Miniatura para revisar frente, sienes y mentón" />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
          onPointerDown={e => {
            const r = e.currentTarget.getBoundingClientRect();
            update({ x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) });
          }} aria-hidden="true">
          <polygon points={FACE_OVAL.map(i => `${points[i].x},${points[i].y}`).join(' ')} fill="none" stroke="#38bdf8" strokeWidth="0.003" />
          {FACE_OVAL.map(i => <circle key={i} cx={i === 10 && forehead ? forehead.x : points[i].x} cy={i === 10 && forehead ? forehead.y : points[i].y}
            r={i === selected ? 0.012 : 0.005} fill={i === selected ? '#f59e0b' : '#38bdf8'} stroke="white" strokeWidth="0.002" />)}
        </svg>
      </div>
      <div className="space-y-3 text-sm">
        <p>¿Conservar el límite propuesto de la frente o moverlo?</p>
        <label className="block">Borde a editar
          <select value={selected} onChange={e => setSelected(Number(e.target.value))} className="admin-focus-ring mt-1 w-full rounded border p-2">
            {FACE_OVAL.map((i, order) => <option key={i} value={i}>{i === 10 ? 'Frente · centro' : i === 152 ? 'Mentón · centro' : `Borde ${order + 1} · ${order < 8 || order > 28 ? 'sien / frente' : 'mandíbula'}`}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-500">Toca el borde en la miniatura o usa las coordenadas.</p>
        {(['x', 'y'] as const).map(axis => <label key={axis} className="block">Posición {axis.toUpperCase()} (%)
          <input type="number" min={0} max={100} step={0.1} value={Number((point[axis] * 100).toFixed(2))}
            onChange={e => { if (e.currentTarget.value !== '' && e.currentTarget.validity.valid) update({ ...point, [axis]: Number(e.target.value) / 100 }); }}
            className="admin-focus-ring mt-1 w-full rounded border p-2" />
        </label>)}
        <button type="button" onClick={() => { setPoints(landmarks); setForehead(null); setConfirmed(false); setError(''); }}
          className="admin-focus-ring rounded border px-3 py-2">Conservar detección original</button>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          Bordes sobre piel visible; sin cabello ni fondo.
        </label>
        {error && <p role="status" className="text-xs text-amber-800">{error}</p>}
        <button type="button" disabled={!confirmed} onClick={apply} className="admin-focus-ring w-full rounded-lg bg-slate-900 px-3 py-3 font-semibold text-white disabled:opacity-40">Confirmar límites</button>
      </div>
    </div>
  </dialog>;
}
