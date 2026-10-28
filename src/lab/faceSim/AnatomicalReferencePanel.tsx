import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  fitAnatomicalUVs, fitLandmarkUVs, loadAnatomicalImage, type AnatomicalReference,
  type ReferenceAnchors, type ReferencePoint,
} from './anatomicalReference';
import { detectImageLandmarks } from './detection';

export interface AnatomicalReferencePanelProps {
  /** UV de la foto frontal, normalizados, origen arriba-izquierda y orden de landmarks original. */
  surfaceUVs: Float32Array;
  /** Recibe undefined si falta registro, hay error, se limpia o se desmonta. No persistir el canvas. */
  onChange: (reference: AnatomicalReference | undefined) => void;
}

const LABELS = ['Ojo lado 33', 'Ojo lado 263', 'Mentón (152)'] as const;
const control = 'admin-focus-ring rounded border border-slate-400 bg-white p-2 text-slate-900';
const clamp = (n: number) => Math.max(0, Math.min(1, n));

export default function AnatomicalReferencePanel({ surfaceUVs, onChange }: AnatomicalReferencePanelProps) {
  const id = useId();
  const preview = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLCanvasElement>();
  const request = useRef<AbortController>();
  const callback = useRef(onChange);
  const drag = useRef<{ index: number; pointerId: number }>();
  const [canvas, setCanvas] = useState<HTMLCanvasElement>();
  const [points, setPoints] = useState<ReferencePoint[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<AnatomicalReference['kind']>('muscle');
  const [depth, setDepth] = useState(0.02);
  const [opacity, setOpacity] = useState(0.5);
  // Landmarks detectados en la ilustración; se descartan al mover un anclaje a mano.
  const [detected, setDetected] = useState<ReferencePoint[]>();

  const registration = useMemo(() => {
    if (!canvas || points.length !== 3) return { uvs: undefined, error: '' };
    try {
      if (detected) return { uvs: fitLandmarkUVs(surfaceUVs, detected), error: '' };
      const anchors: ReferenceAnchors = [points[0], points[1], points[2]];
      return { uvs: fitAnatomicalUVs(surfaceUVs, anchors), error: '' };
    } catch (cause) {
      return { uvs: undefined, error: cause instanceof Error ? cause.message : 'No se pudo registrar la referencia.' };
    }
  }, [canvas, points, surfaceUVs, detected]);
  const reference = useMemo<AnatomicalReference | undefined>(() => canvas && registration.uvs
    ? { canvas, uvs: registration.uvs, depth, opacity, kind } : undefined,
  [canvas, registration.uvs, depth, opacity, kind]);

  // La identidad del callback del anfitrión no debe volver a publicar la misma capa en bucle.
  useEffect(() => { callback.current = onChange; }, [onChange]);
  useEffect(() => { callback.current(reference); }, [reference]);
  useEffect(() => () => {
    request.current?.abort();
    callback.current(undefined);
    if (image.current) { image.current.width = 0; image.current.height = 0; }
    image.current = undefined;
  }, []);
  useEffect(() => {
    const node = preview.current;
    if (!canvas || !node) return;
    node.width = canvas.width;
    node.height = canvas.height;
    const context = node.getContext('2d');
    if (context) context.drawImage(canvas, 0, 0);
    else setError('No se puede mostrar la vista previa. Prueba en otro navegador.');
    return () => {
      node.width = 0; node.height = 0;
    };
  }, [canvas]);

  const clear = () => {
    request.current?.abort();
    request.current = undefined;
    drag.current = undefined;
    // Notificar antes de liberar: el consumidor debe retirar su textura/material.
    callback.current(undefined);
    if (image.current) { image.current.width = 0; image.current.height = 0; }
    image.current = undefined;
    setCanvas(undefined);
    setPoints([]);
    setDetected(undefined);
    setSelected(0);
    setLoading(false);
    setError('');
  };
  const upload = async (file: File) => {
    clear();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await loadAnatomicalImage(file, controller.signal);
      if (controller.signal.aborted || request.current !== controller) {
        next.width = 0; next.height = 0;
        return;
      }
      image.current = next;
      setCanvas(next);
      setDetecting(true);
      const found = await detectImageLandmarks(next).catch(() => null);
      if (controller.signal.aborted || request.current !== controller) return;
      if (found && found.length >= 468) {
        setDetected(found);
        setPoints([found[33], found[263], found[152]].map(p => ({ x: clamp(p.x), y: clamp(p.y) })));
        setSelected(2);
      }
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(cause instanceof Error ? cause.message : 'No se pudo abrir la imagen. Selecciona otro archivo.');
      }
    } finally {
      if (request.current === controller) { request.current = undefined; setLoading(false); setDetecting(false); }
    }
  };
  const update = (index: number, point: ReferencePoint) => {
    setDetected(undefined);
    setPoints(previous => {
      const next = [...previous];
      next[index] = { x: clamp(point.x), y: clamp(point.y) };
      return next;
    });
  };
  const position = (event: PointerEvent<HTMLElement>): ReferencePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  const point = points[selected];
  const problem = error || registration.error;

  return <section aria-labelledby={`${id}-title`} aria-describedby={`${id}-warning`} className="min-w-0 space-y-3 rounded-xl border border-slate-300 bg-white p-3 text-sm text-slate-900">
    <h3 id={`${id}-title`} className="font-semibold">Capa anatómica de referencia</h3>
    <p id={`${id}-warning`} className="rounded bg-amber-50 p-2 text-xs text-amber-950"
      title="Imagen y puntos solo en memoria, procesamiento local; no se envían ni guardan. Conserva las marcas de agua y usa imágenes con licencia.">
      Capa genérica, no anatomía del paciente. Se alinea sola si la ilustración muestra un rostro frontal.
    </p>
    <label className="block font-medium">Ilustración frontal (músculos, vasos…)
      <input type="file" name="anatomical-reference" accept="image/jpeg,image/png,image/webp"
        className="admin-focus-ring mt-1 block w-full min-w-0 rounded text-xs"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void upload(file);
        }} />
    </label>
    <div role="status" aria-live="polite" className="text-xs text-slate-700">
      {loading ? (detecting ? 'Buscando puntos faciales en la ilustración…' : 'Cargando imagen local…') : !canvas ? 'Sin referencia. JPEG, PNG o WebP hasta 10 MB.'
        : reference && detected ? 'Alineada automáticamente con 468 puntos faciales. Mueve un punto para corregir a mano.'
        : reference ? 'Alineada con 3 anclajes manuales.'
          : registration.error ? 'Registro inválido: ajusta los anclajes.'
          : `Sin rostro detectable: marca ${points.length} de 3 puntos. Siguiente: ${LABELS[Math.min(points.length, 2)]}.`}
    </div>
    {canvas && <>
      <p className="text-xs text-slate-700" title="Comisuras externas de los ojos (landmarks 33 y 263) y centro del mentón (152). Respeta los lados aunque la referencia esté espejada; también puedes usar flechas del teclado.">
        Puntos: ojo 33, ojo 263 y mentón.</p>
      <div className="relative mx-auto w-full select-none" style={{ maxWidth: `${320 * canvas.width / canvas.height}px` }}>
        <canvas ref={preview} aria-label="Referencia completa con sus marcas originales" className="block h-auto w-full rounded border border-slate-300" />
        <button type="button" aria-label={`Colocar ${LABELS[selected]} sobre la imagen`}
          className="admin-focus-ring absolute inset-0 h-full w-full touch-none cursor-crosshair rounded"
          onPointerDown={event => {
            if (event.button !== 0) return;
            const index = points.length < 3 ? points.length : selected;
            update(index, position(event));
            setSelected(Math.min(index + 1, 2));
          }}
          onClick={event => {
            // Alternativa al puntero para activar con Enter/Espacio.
            if (event.detail === 0) {
              const index = points.length < 3 ? points.length : selected;
              update(index, { x: 0.5, y: index === 2 ? 0.8 : 0.35 });
              setSelected(Math.min(index + 1, 2));
            }
          }} />
        {points.map((p, index) => <button key={index} type="button" aria-label={`Mover ${LABELS[index]}`}
          aria-pressed={selected === index} title={`${index + 1}: ${LABELS[index]}`}
          className={`admin-focus-ring absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full border-2 border-white font-bold shadow ${selected === index ? 'bg-slate-950 text-white' : 'bg-cyan-800 text-white'}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          onClick={() => setSelected(index)}
          onPointerDown={event => {
            if (event.button !== 0) return;
            drag.current = { index, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
            setSelected(index);
          }}
          onPointerMove={event => {
            if (drag.current?.pointerId !== event.pointerId || drag.current.index !== index) return;
            const rect = event.currentTarget.parentElement!.getBoundingClientRect();
            update(index, { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
          }}
          onPointerUp={() => { drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}
          onLostPointerCapture={() => { drag.current = undefined; }}
          onKeyDown={event => {
            const delta = event.shiftKey ? 0.01 : 0.001;
            const moves: Record<string, ReferencePoint> = {
              ArrowLeft: { x: -delta, y: 0 }, ArrowRight: { x: delta, y: 0 },
              ArrowUp: { x: 0, y: -delta }, ArrowDown: { x: 0, y: delta },
            };
            const move = moves[event.key];
            if (move) { event.preventDefault(); update(index, { x: p.x + move.x, y: p.y + move.y }); }
          }}>{index + 1}</button>)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="col-span-2 block sm:col-span-1">Anclaje
          <select value={selected} onChange={e => setSelected(Number(e.target.value))} className={`${control} mt-1 w-full`}>
            {LABELS.map((label, index) => <option key={label} value={index} disabled={index > points.length}>{label}</option>)}
          </select>
        </label>
        {(['x', 'y'] as const).map(axis => <label key={axis} className="block">Posición {axis.toUpperCase()} (%)
          <input type="number" name={`anchor-${axis}`} min={0} max={100} step={0.1} disabled={!point}
            value={point ? Number((point[axis] * 100).toFixed(2)) : ''}
            onChange={e => {
              if (point && e.currentTarget.value !== '' && e.currentTarget.validity.valid) {
                update(selected, { ...point, [axis]: Number(e.currentTarget.value) / 100 });
              }
            }} className={`${control} mt-1 w-full`} />
        </label>)}
      </div>
      <button type="button" onClick={() => { setPoints([]); setDetected(undefined); setSelected(0); drag.current = undefined; }}
        className={`${control} hover:bg-slate-100`}>Rehacer anclajes</button>
    </>}
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block">Tipo de referencia
        <select value={kind} onChange={e => setKind(e.target.value as AnatomicalReference['kind'])} className={`${control} mt-1 w-full`}>
          <option value="muscle">Músculos</option><option value="vessels">Vasos</option><option value="bone">Hueso</option>
        </select>
      </label>
      <label className="block">Profundidad relativa: {Math.round(depth * 100)} %
        <input type="range" name="reference-depth" min={0} max={0.2} step={0.005} value={depth}
          onChange={e => setDepth(Number(e.target.value))} className="admin-focus-ring mt-2 w-full" />
        <span className="text-xs text-slate-700">Hacia dentro, fracción del ancho facial; no mm.</span>
      </label>
      <label className="block">Opacidad: {Math.round(opacity * 100)} %
        <input type="range" name="reference-opacity" min={0} max={1} step={0.01} value={opacity}
          onChange={e => setOpacity(Number(e.target.value))} className="admin-focus-ring mt-2 w-full" />
      </label>
    </div>
    {problem && <p role="alert" className="rounded bg-red-50 p-2 text-xs text-red-800">{problem}</p>}
    <button type="button" onClick={clear} disabled={!canvas && !loading && !error}
      className={`${control} hover:bg-slate-100 disabled:opacity-50`}>Limpiar referencia</button>
  </section>;
}
