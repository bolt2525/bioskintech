import { useRef, useState, type PointerEvent } from 'react';
import { FACE_OVAL, SIM_MODES, type P2, type SimMode } from './engine';
import { FACE_REGION_BOUNDARIES, FACE_REGION_SEEDS } from './faceRegions';
import { isValidSkinPolygon, pointInValidatedSkinPolygon } from './skinRegionReview';
import type { ManualEffectArea } from './injectablePreview';

interface Props {
  chart: readonly P2[];
  image?: string;
  aspect: number;
  areas: readonly ManualEffectArea[];
  onChange: (areas: ManualEffectArea[]) => void;
}
const button = 'admin-focus-ring min-h-9 rounded border border-white/20 px-2 text-xs text-stone-200 disabled:opacity-40';
const modes: SimMode[] = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];

/** Pequeño control ROI, sin el análisis/retocado clínico del editor de piel. */
export default function EffectAreaEditor({ chart, image, aspect, areas, onChange }: Props) {
  const [mode, setMode] = useState<SimMode>('hidratacion');
  const [tool, setTool] = useState<'rectangle' | 'freehand' | 'select'>('rectangle');
  const [zone, setZone] = useState('Mejillas');
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<P2[]>([]);
  const [keyboardPoint, setKeyboardPoint] = useState<P2>({ x: 0.5, y: 0.5 });
  const [keyboardStart, setKeyboardStart] = useState<P2 | null>(null);
  const [message, setMessage] = useState('Elige una zona o delimita y confirma un área.');
  const drawing = useRef<P2[] | null>(null);
  const history = useRef<Partial<Record<SimMode, ManualEffectArea[][]>>>({});
  const own = areas.filter(area => area.mode === mode);
  const change = (next: ManualEffectArea[]) => {
    (history.current[mode] ??= []).push(own.slice());
    onChange([...areas.filter(area => area.mode !== mode), ...next]);
    setSelected(undefined);
  };
  const cancel = () => { drawing.current = null; setKeyboardStart(null); setDraft([]); setMessage('Trazado cancelado; áreas guardadas intactas.'); };
  const save = (polygon: P2[], label: string) => {
    if (!isValidSkinPolygon(polygon)) { setMessage('Área inválida: evita cruces y dibuja una superficie mayor.'); return; }
    if (!chart.some(p => pointInValidatedSkinPolygon(p.x, p.y, polygon))) {
      setMessage('El área debe intersectar la superficie facial.'); return;
    }
    const area: ManualEffectArea = { id: crypto.randomUUID(), mode, label, polygon: polygon.map(p => ({ ...p })), chart };
    change([...own, area]); setSelected(area.id); setDraft([]);
    setMessage(`Área ${SIM_MODES[mode].label} añadida. Puntos y dosis intactos.`);
  };
  const point = (event: PointerEvent<SVGSVGElement>): P2 => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const update = (event: PointerEvent<SVGSVGElement>) => {
    if (!drawing.current) return;
    const p = point(event), start = drawing.current[0];
    if (tool === 'rectangle') setDraft([start, { x: p.x, y: start.y }, p, { x: start.x, y: p.y }]);
    else if (drawing.current.length < 256 && Math.hypot(p.x - drawing.current.at(-1)!.x, p.y - drawing.current.at(-1)!.y) > 0.008) {
      drawing.current.push(p); setDraft(drawing.current.slice());
    }
  };
  // Zonas delimitadas por triángulos/semillas existentes; bounding ROI explícito, no recomendación.
  const preset = () => {
    const points = (FACE_REGION_SEEDS.find(entry => entry.zone === zone)?.indices ?? []).map(id => chart[id]);
    if (!points.length) return;
    const left = Math.max(0, Math.min(...points.map(p => p.x)) - 0.025);
    const right = Math.min(1, Math.max(...points.map(p => p.x)) + 0.025);
    const top = Math.max(0, Math.min(...points.map(p => p.y)) - 0.025);
    const bottom = Math.min(1, Math.max(...points.map(p => p.y)) + 0.025);
    save([{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }], zone);
  };
  const polygonPoints = (points: readonly P2[]) => points.map(p => `${p.x},${p.y}`).join(' ');
  return <details className="rounded-xl border border-white/10 bg-black/20 p-2">
    <summary className="admin-focus-ring min-h-9 cursor-pointer text-sm font-bold text-stone-200">Áreas de efecto</summary>
    <div className="space-y-2 pt-2">
      <p className="text-[11px] text-amber-200">Áreas educativas explícitas, incluso sin puntos. Se suman por máximo al campo, sin amplificar dosis. No son marcaciones, eficacia ni dosis. Solo memoria; no se exportan.</p>
      <label className="block text-xs">Categoría de área
        <select aria-label="Categoría de área" value={mode} onChange={event => { setMode(event.target.value as SimMode); cancel(); setSelected(undefined); }}
          className={`${button} mt-1 w-full bg-stone-900`}>
          {modes.map(value => <option key={value} value={value}>{SIM_MODES[value].label}</option>)}
        </select>
      </label>
      <div className="flex gap-1">
        <select aria-label="Zona anatómica del área" value={zone} onChange={event => setZone(event.target.value)} className={`${button} min-w-0 flex-1 bg-stone-900`}>
          {FACE_REGION_SEEDS.map(entry => <option key={entry.zone}>{entry.zone}</option>)}
        </select>
        <button type="button" className={button} onClick={preset}>Añadir zona</button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {(['rectangle', 'freehand', 'select'] as const).map(value => <button type="button" key={value} aria-pressed={tool === value}
          className={`${button} aria-pressed:bg-stone-700`} onClick={() => { setTool(value); cancel(); }}>
          {value === 'rectangle' ? 'Rectángulo' : value === 'freehand' ? 'Trazo libre' : 'Seleccionar'}
        </button>)}
      </div>
      <p className="text-[11px] text-stone-300">Teclado en el esquema: flechas mueven el cursor, Enter fija esquinas o vértices; confirma con el botón. Escape cancela.</p>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" role="img" aria-label="Editor de áreas de efecto"
        tabIndex={0} className="admin-focus-ring w-full touch-none rounded bg-slate-800"
        style={{ aspectRatio: aspect }} onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); cancel(); return; }
          if (event.key.startsWith('Arrow')) {
            event.preventDefault();
            const step = event.shiftKey ? 0.05 : 0.01;
            const p = { x: Math.max(0, Math.min(1, keyboardPoint.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))),
              y: Math.max(0, Math.min(1, keyboardPoint.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))) };
            setKeyboardPoint(p);
            if (tool === 'rectangle' && keyboardStart) setDraft([keyboardStart, { x: p.x, y: keyboardStart.y }, p, { x: keyboardStart.x, y: p.y }]);
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (tool === 'rectangle') {
              if (!keyboardStart) { setKeyboardStart(keyboardPoint); setDraft([]); }
              else { setDraft([keyboardStart, { x: keyboardPoint.x, y: keyboardStart.y }, keyboardPoint, { x: keyboardStart.x, y: keyboardPoint.y }]); setKeyboardStart(null); }
            } else if (tool === 'freehand') setDraft(previous => previous.length < 256 ? [...previous, keyboardPoint] : previous);
            else setSelected([...own].reverse().find(area => pointInValidatedSkinPolygon(keyboardPoint.x, keyboardPoint.y, area.polygon))?.id);
          }
        }}
        onPointerDown={event => {
          if (tool === 'select') {
            const p = point(event), area = [...own].reverse().find(a => pointInValidatedSkinPolygon(p.x, p.y, a.polygon));
            setSelected(area?.id); return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          drawing.current = [point(event)]; setDraft([]);
        }} onPointerMove={update} onPointerUp={event => { update(event); drawing.current = null; }}
        onPointerCancel={cancel}>
        {image ? <image href={image} width="1" height="1" preserveAspectRatio="none" /> : <>
          <polygon points={polygonPoints(FACE_OVAL.map(id => chart[id]))} fill="#a18070" stroke="#f8fafc" strokeWidth="0.003" />
          {[FACE_REGION_BOUNDARIES.leftEye, FACE_REGION_BOUNDARIES.rightEye, FACE_REGION_BOUNDARIES.upperLip, FACE_REGION_BOUNDARIES.lowerLip]
            .map((ids, i) => <polygon key={i} points={polygonPoints(ids.map(id => chart[id]))} fill="#334155" />)}
          {FACE_REGION_SEEDS.filter(entry => ['Frente', 'Mejillas', 'Mentón', 'Dorso nasal'].includes(entry.zone)).map(entry => {
            const center = entry.indices.reduce((p, id) => ({ x: p.x + chart[id].x / entry.indices.length, y: p.y + chart[id].y / entry.indices.length }), { x: 0, y: 0 });
            return <text key={entry.zone} x={center.x} y={center.y} textAnchor="middle" fontSize="0.035" fill="white">{entry.zone}</text>;
          })}
        </>}
        {areas.map(area => <polygon key={area.id} points={polygonPoints(area.polygon)} fill="none"
          stroke={SIM_MODES[area.mode].color} strokeWidth={selected === area.id ? '0.009' : '0.004'} />)}
        {!!draft.length && <polygon points={polygonPoints(draft)} fill="none" stroke="white" strokeWidth="0.004" strokeDasharray="0.01" />}
        <circle cx={keyboardPoint.x} cy={keyboardPoint.y} r="0.012" fill="none" stroke="white" strokeWidth="0.003" />
      </svg>
      {!image && <p className="text-[11px] text-stone-300">Esquema frontal · UV exactos del atlas anatómico.</p>}
      <div className="flex flex-wrap gap-1">
        <button type="button" className={button} disabled={draft.length < 3} onClick={() => save(draft, tool === 'rectangle' ? 'Rectángulo' : 'Trazo libre')}>Confirmar área</button>
        <button type="button" className={button} onClick={cancel}>Cancelar trazo</button>
        <button type="button" className={button} disabled={!history.current[mode]?.length} onClick={() => {
          const previous = history.current[mode]?.pop();
          if (previous) onChange([...areas.filter(area => area.mode !== mode), ...previous]);
          setSelected(undefined);
        }}>Deshacer área</button>
      </div>
      <select aria-label="Área seleccionada" value={selected ?? ''} onChange={event => setSelected(event.target.value)} className={`${button} w-full bg-stone-900`}>
        <option value="">Seleccionar área ({own.length})</option>
        {own.map((area, i) => <option key={area.id} value={area.id}>{i + 1} · {area.label} · {SIM_MODES[mode].label}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-1">
        <button type="button" className={button} disabled={!selected} onClick={() => change(own.filter(area => area.id !== selected))}>Borrar área</button>
        <button type="button" className={button} disabled={!own.length} onClick={() => change([])}>Limpiar categoría</button>
      </div>
      <p role="status" className="text-[11px] text-stone-200">{message}</p>
    </div>
  </details>;
}
