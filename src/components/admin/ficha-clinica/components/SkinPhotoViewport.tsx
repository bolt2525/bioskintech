import { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3X3, Hand, Minus, Plus, RotateCcw } from 'lucide-react';
import { genericFaceAtlas, photoPoint } from '../../../../lab/faceSim/faceTransfer';
import { faceRegionColor } from '../../../../lab/faceSim/faceRegions';
import type { PersonalSurface } from '../../../../lab/faceSim/faceTransfer';
import type { SkinPhotoSource } from '../../../../lab/faceSim/skinMultiView';
import type { EvaluationMark } from './skinEvaluation';
import { skinRegionCells } from './skinAnatomy';
import { visibleSkinTriangles } from './skinEvaluation';
import { validBox, type NormalizedBox } from './skinVisualAI';

const button = 'admin-focus-ring inline-flex min-h-11 items-center justify-center gap-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-40';
export default function SkinPhotoViewport({ source, surface, showZones, onToggleZones, marks, selectedMark, disabled, onChoose, onSelect }: {
  source: SkinPhotoSource; surface?: PersonalSurface; showZones: boolean;
  onToggleZones: () => void;
  marks: { mark: EvaluationMark; box: NormalizedBox; projected: boolean }[];
  selectedMark: string | null; disabled: boolean; onChoose: (x: number, y: number) => void; onSelect: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(false);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    node.width = source.canvas.width; node.height = source.canvas.height;
    node.getContext('2d')?.drawImage(source.canvas, 0, 0);
    setZoom(1); setPan(false); viewport.current?.scrollTo(0, 0);
  }, [source.canvas]);
  const zones = useMemo(() => {
    if (!showZones || !source.confirmed || !source.mapping || !surface) return [];
    const visible = visibleSkinTriangles(source, surface);
    return skinRegionCells().flatMap(cell => {
      if (!visible[cell.triangle]) return [];
      const points = cell.corners.map(weights => photoPoint({ triangle: cell.triangle, weights: weights as [number, number, number] },
        source.mapping!.landmarks, genericFaceAtlas));
      if (points.some(p => !p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return [];
      return [{ label: cell.label, points: points.map(p => `${p!.x},${p!.y}`).join(' ') }];
    });
  }, [showZones, source, surface]);
  return <section aria-label="Fotografía ampliable" className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 p-2">
      <span className="px-2 text-sm font-medium">{source.label}</span>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Ampliación de fotografía">
        <button type="button" className={`${button} ${showZones ? 'border-gold-ink bg-gold-light text-gold-ink' : 'border-gray-200'}`}
          aria-label={showZones ? 'Ocultar zonas en foto' : 'Mostrar zonas en foto'} aria-pressed={showZones}
          disabled={!source.confirmed || !source.mapping || !surface} onClick={onToggleZones}
          title={!source.confirmed || !source.mapping || !surface ? 'Requiere correspondencia facial confirmada' : 'Zonas anatómicas de referencia'}>
          <Grid3X3 size={16} /><span className="text-xs">Zonas</span></button>
        <button type="button" className={button} aria-label="Alejar foto" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .5))}><Minus size={16} /></button>
        <output className="min-w-12 text-center text-xs tabular-nums" aria-label="Zoom de foto">{Math.round(zoom * 100)} %</output>
        <button type="button" className={button} aria-label="Acercar foto" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .5))}><Plus size={16} /></button>
        <button type="button" className={`${button} ${pan ? 'border-gold-ink bg-gold-light text-gold-ink' : 'border-gray-200'}`}
          aria-label="Desplazar foto" aria-pressed={pan} onClick={() => setPan(value => !value)}><Hand size={16} /></button>
        <button type="button" className={button} aria-label="Restablecer foto" onClick={() => { setZoom(1); setPan(false); viewport.current?.scrollTo(0, 0); }}><RotateCcw size={16} /></button>
      </div>
    </div>
    <div ref={viewport} className={`max-h-[min(60dvh,560px)] overflow-auto overscroll-contain bg-slate-950 ${pan ? 'touch-none cursor-grab active:cursor-grabbing' : ''}`}
      onPointerDown={e => {
        if (!pan) return;
        const node = e.currentTarget;
        drag.current = { x: e.clientX, y: e.clientY, left: node.scrollLeft, top: node.scrollTop };
        node.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        if (!drag.current || !pan) return;
        e.currentTarget.scrollLeft = drag.current.left + drag.current.x - e.clientX;
        e.currentTarget.scrollTop = drag.current.top + drag.current.y - e.clientY;
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className="relative mx-auto" style={{ width: `min(${zoom * 100}%, calc(min(60dvh, 560px) * ${source.canvas.width / source.canvas.height * zoom}))` }}>
        <canvas ref={canvas} role="img" aria-label={`Foto ${source.label}`} className="block h-auto w-full" />
        {!!zones.length && <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
          {zones.map((zone, i) => <polygon key={i} points={zone.points} fill={faceRegionColor(zone.label)} fillOpacity=".08"
            stroke={faceRegionColor(zone.label)} strokeWidth=".0007" />)}
        </svg>}
        <button type="button" className={`admin-focus-ring absolute inset-0 w-full ${pan ? 'pointer-events-none' : 'cursor-crosshair'}`}
          aria-label="Añadir marca en la foto; también puedes usar el botón Añadir marca" disabled={disabled || pan}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.detail === 0 ? .5 : (e.clientX - r.left) / r.width;
            const y = e.detail === 0 ? .5 : (e.clientY - r.top) / r.height;
            if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onChoose(x, y);
          }} />
        {marks.filter(item => validBox(item.box)).map(({ mark, box, projected }) => <button key={mark.id} type="button"
          aria-label={`Seleccionar ${mark.label}, ${mark.status === 'validated' ? 'validada' : 'pendiente'}${projected ? ', correspondencia estimada' : ''}`}
          aria-pressed={selectedMark === mark.id} onClick={() => onSelect(mark.id)}
          className={`admin-focus-ring absolute z-10 rounded-full border-2 bg-white ${mark.status === 'validated' ? 'border-green-700' : 'border-amber-600'} ${selectedMark === mark.id ? 'ring-4 ring-gold-ink' : ''} ${pan ? 'pointer-events-none' : ''}`}
          style={{ left: `${(box.x + box.width / 2) * 100}%`, top: `${(box.y + box.height / 2) * 100}%`, width: 18, height: 18, transform: 'translate(-50%, -50%)' }} />)}
        {marks.filter(item => !item.projected && validBox(item.box) && (item.box.width > .06 || item.box.height > .06)).map(({ mark, box }) =>
          <span key={mark.id} aria-hidden="true" className={`pointer-events-none absolute border-2 ${mark.status === 'validated' ? 'border-green-700' : 'border-amber-500 border-dashed'}`}
            style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />)}
      </div>
    </div>
    <p className="px-3 py-2 text-xs text-gray-500">{pan ? 'Arrastra para recorrer la foto. Desactiva la mano para marcar.' : 'Pulsa sobre la foto para marcar. El zoom no cambia las coordenadas guardadas.'}</p>
  </section>;
}
