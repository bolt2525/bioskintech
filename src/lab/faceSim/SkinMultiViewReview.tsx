import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { P2, PersonalSurface } from './engine';
import { analyzeSkinAppearance, SKIN_CANDIDATE_COLORS, SKIN_CANDIDATE_LABELS, skinVisualCandidates, type SkinCandidateChannel } from './skinAppearance';
import { createSkinSignalMask, skinSignalPreview } from './skinSignalTexture';
import { isValidSkinPolygon } from './skinRegionReview';
import {
  alignSkinProfile, mapSkinCandidate, mergeSkinObservations, PROFILE_SKIN_ANCHORS, replaceSkinFocusCandidates, selectSkinPhotos, skinPhotoQuality, skinPolygonMask,
  type SkinMappedCandidate, type SkinPhotoMapping, type SkinPhotoResult, type SkinPhotoSource,
} from './skinMultiView';

interface Configuration { polygons: P2[][]; reviewed: boolean; anchors: P2[]; side: -1 | 1; mapping?: SkinPhotoMapping }
type Decisions = Record<string, 'accepted' | 'dismissed'>;
const initialConfiguration = (): Configuration => ({ polygons: [], reviewed: false, anchors: [], side: -1 });
const button = 'admin-focus-ring min-h-10 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 disabled:opacity-50';
const EMPTY: readonly SkinMappedCandidate[] = [];
const FRONT = [0, 0, 1];

export default function SkinMultiViewReview({ sources, surface, renderMask }: {
  sources: readonly SkinPhotoSource[];
  surface?: PersonalSurface;
  renderMask?: (points: readonly SkinMappedCandidate[], direction: readonly number[], selectedPoint?: string) => ReactNode;
}) {
  const preview = useRef<HTMLCanvasElement>(null), request = useRef(0);
  const advanced = useRef<HTMLDetailsElement>(null), alignment = useRef<HTMLDetailsElement>(null);
  const analyzeRef = useRef<(focus?: readonly P2[]) => Promise<void>>();
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? '');
  const [configurations, setConfigurations] = useState<Record<string, Configuration>>({});
  const [draft, setDraft] = useState<P2[]>([]), [focus, setFocus] = useState<P2[]>([]);
  const [mode, setMode] = useState<'roi' | 'align' | 'focus' | null>(null);
  const [results, setResults] = useState<SkinPhotoResult[]>([]);
  const [usedIds, setUsedIds] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Decisions>({}), [history, setHistory] = useState<Decisions[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('Preparando fotos…');
  const [error, setError] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState({ x: 50, y: 50 }), [sensitivity, setSensitivity] = useState(50);
  const [category, setCategory] = useState<SkinCandidateChannel | 'all'>('all');
  const [reviewFilter, setReviewFilter] = useState('pending'), [activeId, setActiveId] = useState('');
  const selected = sources.find(source => source.id === selectedId);
  const config = configurations[selectedId] ?? initialConfiguration();
  const mapping = config.mapping ?? selected?.mapping;
  const selectedResult = results.find(result => result.sourceId === selectedId);
  const candidates = selectedResult?.candidates ?? [];
  useEffect(() => {
    const token = request;
    request.current++;
    setResults([]); setUsedIds([]); setDecisions({}); setHistory([]); setConfigurations({}); setBusy(false);
    setMode(null); setDraft([]); setFocus([]); setSelectedId(sources[0]?.id ?? ''); setActiveId(''); setError(null);
    setMessage('El análisis comienza con las fotos confirmadas. Las fotos sin detección necesitan un área de piel.');
    const timer = sources.some(source => source.confirmed && source.landmarks)
      ? setTimeout(() => void analyzeRef.current?.(), 150) : undefined;
    return () => { clearTimeout(timer); token.current++; };
  }, [sources, surface]);
  useEffect(() => {
    const canvas = preview.current, context = canvas?.getContext('2d');
    if (!selected || !canvas || !context) return;
    const scale = Math.min(1, 768 / Math.max(selected.canvas.width, selected.canvas.height));
    canvas.width = Math.round(selected.canvas.width * scale); canvas.height = Math.round(selected.canvas.height * scale);
    context.drawImage(selected.canvas, 0, 0, canvas.width, canvas.height);
  }, [selected]);
  const invalidate = () => {
    request.current++; setBusy(false); setResults([]); setUsedIds([]); setDecisions({}); setHistory([]);
    setMessage('Ajustes cambiados. Pulsa Analizar fotos para actualizar.'); setError(null);
  };
  const configure = (next: Configuration) => {
    invalidate(); setConfigurations(previous => ({ ...previous, [selectedId]: next }));
  };
  const addPoint = (point: P2) => {
    if (!mode || busy) return;
    if (mode === 'roi' && draft.length < 64) setDraft(previous => [...previous, point]);
    if (mode === 'align' && config.anchors.length < PROFILE_SKIN_ANCHORS.length) configure({ ...config, mapping: undefined, anchors: [...config.anchors, point] });
    if (mode === 'focus') {
      if (!draft.length) { setDraft([point]); return; }
      const a = draft[0], left = Math.min(a.x, point.x), right = Math.max(a.x, point.x);
      const top = Math.min(a.y, point.y), bottom = Math.max(a.y, point.y);
      if (right - left < .01 || bottom - top < .01) { setError('Amplía un poco la zona.'); return; }
      const polygon = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
      setFocus(polygon); setDraft([]); setMode(null); setError(null);
      if (!selected?.landmarks && !config.polygons.length) configure({ ...config, polygons: [polygon], reviewed: false });
    }
  };
  const maskFor = (source: SkinPhotoSource, width: number, height: number) => {
    const entry = configurations[source.id];
    if (!source.confirmed) throw new Error('Confirma esta captura en Capturas.');
    if (entry?.polygons.length) {
      if (!entry.reviewed) throw new Error('Confirma que el área marcada contiene solo piel.');
      return skinPolygonMask(width, height, entry.polygons);
    }
    if (!source.landmarks) throw new Error('Marca una zona de piel para incluir esta foto.');
    return createSkinSignalMask(width, height, source.landmarks);
  };
  const analyze = async (target?: readonly P2[]) => {
    const id = ++request.current;
    setBusy(true); setError(null); setMode(null); setDraft([]);
    if (!target) { setResults([]); setUsedIds([]); setDecisions({}); setHistory([]); }
    const quality: SkinPhotoResult[] = [];
    try {
      for (const source of target ? sources.filter(source => source.id === selectedId) : sources) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (id !== request.current) return;
        try {
          const base = skinSignalPreview(source.canvas, 384), context = base.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('No se pudieron leer los píxeles de la foto.');
          const score = skinPhotoQuality(context.getImageData(0, 0, base.width, base.height), maskFor(source, base.width, base.height));
          quality.push({ sourceId: source.id, candidates: [], score, usable: score >= .6,
            reason: score >= .6 ? '' : 'Revisa la luz y el área de piel.', milliseconds: 0 });
        } catch (cause) {
          console.warn('Captura excluida del análisis local de piel.', cause);
          quality.push({ sourceId: source.id, candidates: [], score: 0, usable: false,
            reason: cause instanceof Error ? cause.message : 'Captura no utilizable.', milliseconds: 0 });
        }
      }
      const chosen = selectSkinPhotos(sources, quality);
      if (!chosen.length) throw new Error(quality[0]?.reason || 'Confirma una captura y marca un área de piel.');
      for (const sourceId of chosen) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (id !== request.current) return;
        const source = sources.find(item => item.id === sourceId)!;
        setMessage(`Analizando ${source.label}…`);
        const started = performance.now(), base = skinSignalPreview(source.canvas, target ? 768 : 512);
        const context = base.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('No se pudieron leer los píxeles.');
        const mask = maskFor(source, base.width, base.height);
        if (target) {
          const focusMask = skinPolygonMask(base.width, base.height, [target]);
          mask.forEach((value, i) => { mask[i] = value && focusMask[i] ? 1 : 0; });
        }
        const analysis = analyzeSkinAppearance(context.getImageData(0, 0, base.width, base.height), mask,
          { sensitivity: Math.min(1, sensitivity / 100 + (target ? .15 : 0)) });
        const entry = quality.find(item => item.sourceId === sourceId)!;
        entry.usable = analysis.usable;
        entry.reason = analysis.usable ? '' : analysis.warnings.find(warning => warning.startsWith('No utilizable:')) ?? 'Sin soporte visual suficiente.';
        entry.candidates = skinVisualCandidates(analysis, mask, base.width, base.height, true);
        entry.milliseconds = performance.now() - started;
      }
      if (id !== request.current) return;
      if (target) {
        const entry = quality[0];
        if (!entry.usable) throw new Error(entry.reason);
        const replacement = replaceSkinFocusCandidates(candidates, entry.candidates, target);
        setResults(previous => [...previous.filter(item => item.sourceId !== selectedId), { ...entry, candidates: replacement.candidates }]);
        setDecisions(previous => Object.fromEntries(Object.entries(previous).filter(([key]) =>
          !key.startsWith(`${selectedId}/`) || replacement.outside.some(candidate => key === `${selectedId}/${candidate.id}`))));
        setHistory([]); setUsedIds(previous => [...new Set([...previous, selectedId])]);
        setMessage('Zona revisada con más detalle. Los candidatos anteriores fuera de ella se conservan.');
      } else {
        setResults(quality);
        const used = chosen.filter(sourceId => quality.find(item => item.sourceId === sourceId)?.usable);
        setUsedIds(used);
        setMessage(`${used.length} fotos analizadas; revisa los candidatos. No son lesiones confirmadas.`);
      }
    } catch (cause) {
      console.error('Falló la revisión multivista de piel.', cause);
      if (id === request.current) setError(cause instanceof Error ? cause.message : 'No se pudo analizar la piel.');
    } finally { if (id === request.current) setBusy(false); }
  };
  useEffect(() => { analyzeRef.current = analyze; });
  const projected = useMemo(() => {
    if (!surface) return EMPTY;
    const points: SkinMappedCandidate[] = [];
    for (const source of sources) {
      const projection = configurations[source.id]?.mapping ?? source.mapping;
      if (!projection) continue;
      for (const [index, candidate] of (results.find(result => result.sourceId === source.id)?.candidates ?? []).entries()) {
        const point = mapSkinCandidate(source.id, candidate, projection, surface);
        if (point) points.push({ ...point, label: `${source.label} ${index + 1}` });
      }
    }
    return points;
  }, [sources, configurations, results, surface]);
  const mapped = useMemo(() => mergeSkinObservations(projected.filter(point =>
    decisions[point.id] !== 'dismissed' && (category === 'all' || point.candidate.channel === category)),
  surface ? Math.abs(surface.positions[31] - surface.positions[457]) : 0), [projected, decisions, category, surface]);
  const filtered = candidates.filter(candidate => (category === 'all' || candidate.channel === category)
    && (reviewFilter === 'all' || (decisions[`${selectedId}/${candidate.id}`] ?? 'pending') === reviewFilter));
  const active = filtered.find(candidate => candidate.id === activeId) ?? filtered[0];
  const decide = (ids: string[], decision: 'accepted' | 'dismissed') => {
    if (!ids.length) return;
    setHistory(previous => [...previous.slice(-19), decisions]);
    setDecisions(previous => ({ ...previous, ...Object.fromEntries(ids.map(id => [`${selectedId}/${id}`, decision])) }));
    setActiveId(filtered.find(candidate => !ids.includes(candidate.id) && !decisions[`${selectedId}/${candidate.id}`])?.id ?? '');
  };
  const undo = () => { if (history.length) { setDecisions(history[history.length - 1]); setHistory(previous => previous.slice(0, -1)); } };
  const activePoint = mapped.find(point => point.observationIds.includes(`${selectedId}/${active?.id}`));
  return <section aria-label="Revisión de piel · fotos y máscara" className="min-w-0 space-y-3 rounded-xl bg-slate-50 p-3 text-slate-900"
    onKeyDown={event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
      if (active && ['a', 'd'].includes(event.key.toLowerCase())) {
        event.preventDefault(); decide([active.id], event.key.toLowerCase() === 'a' ? 'accepted' : 'dismissed');
      }
    }}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-semibold">Piel · buscar y revisar</h3><p className="text-xs">Candidatos visuales, no diagnósticos. Aceptar no retoca ni entrena un modelo.</p></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy || !sources.length} onClick={() => void analyze()}>Analizar fotos</button>
        <button type="button" className={button} disabled={busy || !selected} aria-pressed={mode === 'focus'}
          onClick={() => { setMode('focus'); setDraft([]); setFocus([]); }}>Buscar en zona</button>
        {busy && <button type="button" className={button} onClick={() => { request.current++; setBusy(false); setMessage('Análisis cancelado. No se aplicaron cambios.'); }}>Cancelar análisis</button>}
      </div>
    </header>
    <div role="group" aria-label="Fotos de piel" className="flex flex-wrap gap-2">
      {sources.map(source => <button type="button" key={source.id} className={`${button} aria-pressed:border-sky-700 aria-pressed:bg-sky-50`} aria-pressed={selectedId === source.id}
        onClick={() => { setSelectedId(source.id); setMode(null); setDraft([]); setFocus([]); setActiveId(''); setError(null); }}>
        {source.label}{usedIds.includes(source.id) ? ' · analizada' : ''}{!source.confirmed ? ' · sin confirmar' : ''}
      </button>)}
    </div>
    <p role="status" aria-live="polite" aria-busy={busy} className="text-xs">{message}</p>
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{error}</p>}
    {!sources.length ? <p>Carga y confirma fotos en Capturas para comenzar.</p> : <>
      <div className="grid min-w-0 items-start gap-3 md:grid-cols-2" data-skin-split>
        <figure className="min-w-0">
          <figcaption className="mb-1 text-xs font-semibold">{selected?.label} · pulsa un cuadro para revisarlo</figcaption>
          <button type="button" className="admin-focus-ring relative mx-auto block max-w-full overflow-hidden rounded-xl bg-slate-900"
            aria-label={`Foto ${selected?.label}. ${mode === 'focus' ? 'Marca dos esquinas de la zona.' : mode === 'roi' ? 'Marca el borde del área de piel.' : mode === 'align' ? 'Marca el punto de perfil indicado.' : 'Vista de candidatos de piel.'}`}
            onClick={event => {
              if (!event.detail) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
              if (mode) addPoint(point);
              else { const found = filtered.find(candidate => point.x >= candidate.x && point.x <= candidate.x + candidate.width && point.y >= candidate.y && point.y <= candidate.y + candidate.height); if (found) setActiveId(found.id); }
            }}>
            <canvas ref={preview} className="block h-auto max-h-[42dvh] max-w-full" role="img" aria-label={`Fotografía local ${selected?.label}`} />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
              {[...config.polygons, ...(focus.length ? [focus] : [])].map((polygon, i) => <polygon key={i} points={polygon.map(p => `${p.x},${p.y}`).join(' ')} fill="#38bdf8" fillOpacity=".08" stroke="#38bdf8" strokeWidth=".003" />)}
              {!!draft.length && <polyline points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#f59e0b" strokeWidth=".004" />}
              {filtered.map(candidate => <g key={candidate.id} fill="none" stroke={SKIN_CANDIDATE_COLORS[candidate.channel]} strokeWidth={candidate === active ? '.007' : '.003'}>
                <rect x={candidate.x} y={candidate.y} width={candidate.width} height={candidate.height} />
                <text x={candidate.x} y={Math.max(.025, candidate.y - .008)} fill="white" stroke="black" strokeWidth=".002" paintOrder="stroke" fontSize=".025">{candidates.indexOf(candidate) + 1}</text>
              </g>)}
              {config.anchors.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r=".008" fill="#38bdf8" /><text x={p.x + .01} y={p.y} fill="white" fontSize=".025">{i + 1}</text></g>)}
            </svg>
          </button>
        </figure>
        <section aria-label="Candidatos sobre máscara" className="min-w-0">
          <h4 className="mb-1 text-xs font-semibold">Máscara · ubicaciones aproximadas</h4>
          {renderMask ? renderMask(mapped, mapping?.direction ?? FRONT, activePoint?.id) : <p className="rounded border p-4 text-xs">Genera y acepta una máscara para comparar en 3D. Puedes revisar las fotos mientras tanto.</p>}
          <p className="mt-1 text-xs">{mapped.filter(point => point.observations.includes(selectedId)).length} ubicaciones de esta foto sobre la máscara. Las zonas sin correspondencia segura permanecen solo en la foto.</p>
          {surface && !mapping && <button type="button" className={button} onClick={() => {
            if (advanced.current) advanced.current.open = true;
            if (alignment.current) { alignment.current.open = true; alignment.current.scrollIntoView({ block: 'nearest' }); }
          }}>Revisar alineación de esta foto</button>}
        </section>
      </div>
      {mode && <div className="flex flex-wrap items-end gap-2 rounded border bg-white p-2">
        <p className="w-full text-xs">{mode === 'focus' ? 'Marca dos esquinas alrededor de la zona que quieres revisar.' : mode === 'roi' ? 'Rodea solo piel visible, sin ojos, labios ni pelo.' : `Punto ${Math.min(6, config.anchors.length + 1)}/6: ${PROFILE_SKIN_ANCHORS[Math.min(5, config.anchors.length)].label}`}</p>
        <details><summary className="admin-focus-ring cursor-pointer text-xs">Introducir punto con teclado</summary><div className="flex flex-wrap gap-2">
          {(['x', 'y'] as const).map(axis => <label key={axis} className="text-xs">{axis.toUpperCase()} (%)<input type="number" min="0" max="100" value={coordinates[axis]} className="admin-focus-ring w-20 rounded border p-2"
            onChange={event => setCoordinates(previous => ({ ...previous, [axis]: Number(event.target.value) }))} /></label>)}
          <button type="button" className={button} onClick={() => {
            if ([coordinates.x, coordinates.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) addPoint({ x: coordinates.x / 100, y: coordinates.y / 100 });
            else setError('Las coordenadas deben estar entre 0 y 100 %.');
          }}>Añadir punto</button>
        </div></details>
        <button type="button" className={button} onClick={() => mode === 'align' ? configure({ ...config, mapping: undefined, anchors: config.anchors.slice(0, -1) }) : setDraft(previous => previous.slice(0, -1))}>Quitar último punto</button>
        <button type="button" className={button} onClick={() => { setMode(null); setDraft([]); }}>Cancelar trazado</button>
        {mode === 'roi' && <button type="button" className={button} onClick={() => {
          if (!isValidSkinPolygon(draft)) { setError('Marca al menos tres puntos y evita cruzar el borde.'); return; }
          configure({ ...config, polygons: [...config.polygons, draft], reviewed: false }); setMode(null); setDraft([]);
        }}>Cerrar área</button>}
      </div>}
      {!!config.polygons.length && <label className="flex gap-2 text-xs"><input type="checkbox" className="admin-focus-ring" checked={config.reviewed}
        onChange={event => configure({ ...config, reviewed: event.target.checked })} />Las áreas contienen solo piel visible, sin ojos, labios, pelo ni fondo.</label>}
      {!!focus.length && <button type="button" className={button} disabled={busy} onClick={() => void analyze(focus)}>Buscar aquí con más detalle</button>}
      <div role="group" aria-label="Categorías de candidatos" className="flex flex-wrap gap-1">
        <button type="button" className={button} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>Todas · {candidates.length}</button>
        {(Object.keys(SKIN_CANDIDATE_LABELS) as SkinCandidateChannel[]).filter(channel => candidates.some(candidate => candidate.channel === channel)).map(channel =>
          <button type="button" key={channel} className={button} aria-pressed={category === channel} onClick={() => setCategory(channel)}>
            {SKIN_CANDIDATE_LABELS[channel]} · {candidates.filter(candidate => candidate.channel === channel).length}
          </button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">Mostrar<select aria-label="Estado de revisión" className="admin-focus-ring ml-2 rounded border bg-white p-2" value={reviewFilter} onChange={event => setReviewFilter(event.target.value)}>
          <option value="pending">Pendientes</option><option value="accepted">Aceptados</option><option value="dismissed">Descartados</option><option value="all">Todos</option>
        </select></label>
        <button type="button" className={button} disabled={!active || busy} onClick={() => active && decide([active.id], 'accepted')}>Aceptar y siguiente · A</button>
        <button type="button" className={button} disabled={!active || busy} onClick={() => active && decide([active.id], 'dismissed')}>Descartar y siguiente · D</button>
        <button type="button" className={button} disabled={!history.length} onClick={undo}>Deshacer revisión</button>
      </div>
      <ol aria-label="Candidatos multivista" className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
        {filtered.map(candidate => {
          const id = `${selectedId}/${candidate.id}`, index = candidates.indexOf(candidate) + 1;
          const point = mapped.find(item => item.observationIds.includes(id));
          return <li key={id} className={`rounded border bg-white p-2 text-xs ${active === candidate ? 'border-sky-700' : 'border-slate-200'}`}>
            <button type="button" className="admin-focus-ring w-full rounded text-left" aria-pressed={active === candidate} onClick={() => setActiveId(candidate.id)}>
              {index}. {SKIN_CANDIDATE_LABELS[candidate.channel]} · {decisions[id] === 'accepted' ? 'revisado' : decisions[id] === 'dismissed' ? 'descartado' : 'pendiente'}
            </button>
            <p>{point ? `Indicador en máscara: ${point.label}.` : 'Solo foto: sin correspondencia 3D segura.'}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              <button type="button" className={button} onClick={() => decide([candidate.id], 'accepted')}>Aceptar candidato {index}</button>
              <button type="button" className={button} onClick={() => decide([candidate.id], 'dismissed')}>Descartar candidato {index}</button>
            </div>
          </li>;
        })}
      </ol>
      {!filtered.length && <p className="text-xs">{selectedResult ? 'No quedan candidatos en este filtro. Esto no significa ausencia de lesiones.' : 'Analiza las fotos o marca una zona para empezar.'}</p>}
      <details ref={advanced} className="rounded border bg-white p-3">
        <summary className="admin-focus-ring cursor-pointer text-sm font-semibold">Avanzados · áreas, sensibilidad y alineación</summary>
        <div className="mt-2 space-y-3">
          <label className="block text-xs">Sensibilidad · {sensitivity}%<input aria-label="Sensibilidad de candidatos de piel" type="range" min="0" max="100" value={sensitivity} className="admin-focus-ring block w-full"
            onChange={event => { setSensitivity(Number(event.target.value)); invalidate(); }} /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy || config.polygons.length >= 8} onClick={() => { setMode('roi'); setDraft([]); }}>Delimitar piel</button>
            <button type="button" className={button} disabled={!config.polygons.length} onClick={() => configure({ ...config, polygons: [], reviewed: false })}>Borrar áreas</button>
            <button type="button" className={button} onClick={() => { setDecisions({}); setHistory([]); }}>Restablecer revisión</button>
            <button type="button" className={button} disabled={busy || !filtered.length} onClick={() => decide(filtered.map(candidate => candidate.id), 'accepted')}>Aceptar visibles</button>
            <button type="button" className={button} disabled={busy || !filtered.length} onClick={() => decide(filtered.map(candidate => candidate.id), 'dismissed')}>Descartar visibles</button>
          </div>
          <details ref={alignment}>
            <summary className="admin-focus-ring cursor-pointer text-xs">Alinear perfil puro con la máscara</summary>
            <p className="text-xs">Solo perfiles de 90°. No cambia anatomía ni textura. {mapping ? 'Correspondencia disponible.' : 'Sin proyección segura: revisa en foto o alinea manualmente.'}</p>
            <label className="block text-xs">Lado visible<select aria-label="Lado visible del perfil" className="admin-focus-ring ml-2 rounded border bg-white p-2" value={config.side}
              onChange={event => configure({ ...config, side: Number(event.target.value) === -1 ? -1 : 1, mapping: undefined })}>
              <option value="-1">Derecho del paciente</option><option value="1">Izquierdo del paciente</option>
            </select></label>
            <button type="button" className={button} disabled={!surface || busy} onClick={() => { configure({ ...config, anchors: [], mapping: undefined }); setMode('align'); }}>Marcar seis referencias</button>
            <button type="button" className={button} disabled={!surface || config.anchors.length !== 6 || busy} onClick={() => {
              try {
                if (!surface || !selected) return;
                configure({ ...config, mapping: alignSkinProfile(surface, config.anchors, selected.canvas.width / selected.canvas.height, config.side) });
                setMode(null); setMessage('Alineación manual aceptada. Vuelve a analizar y comprueba los indicadores en la máscara.');
              } catch (cause) { console.warn('Alineación de perfil rechazada.', cause); setError(cause instanceof Error ? cause.message : 'Alineación no válida.'); }
            }}>Validar alineación</button>
          </details>
          {results.map(result => <p key={result.sourceId} className="text-xs">{sources.find(source => source.id === result.sourceId)?.label}: {result.reason || `${result.candidates.length} candidatos · ${Math.round(result.milliseconds)} ms`}</p>)}
          <p className="text-xs">Luz, maquillaje, pelo y compresión producen falsos candidatos. Puntos oscuros/rojos no confirman poros, comedones ni acné; surcos no confirman arrugas. Hasta tres fotos a 512 px y búsqueda dirigida a 768 px, una a la vez. Sin tokens ni envíos. La revisión se pierde al salir del laboratorio; no alimenta aprendizaje automático.</p>
        </div>
      </details>
    </>}
  </section>;
}
