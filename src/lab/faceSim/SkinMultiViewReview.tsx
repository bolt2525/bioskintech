import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { P2, PersonalSurface } from './engine';
import { analyzeSkinAppearance, SKIN_CANDIDATE_COLORS, SKIN_CANDIDATE_LABELS, skinVisualCandidates } from './skinAppearance';
import { createSkinSignalMask, skinSignalPreview } from './skinSignalTexture';
import { isValidSkinPolygon } from './skinRegionReview';
import {
  alignSkinProfile, mapSkinCandidate, mergeSkinObservations, PROFILE_SKIN_ANCHORS, selectSkinPhotos, skinPhotoQuality, skinPolygonMask,
  type SkinMappedCandidate, type SkinPhotoMapping, type SkinPhotoResult, type SkinPhotoSource,
} from './skinMultiView';

interface Configuration {
  polygons: P2[][];
  reviewed: boolean;
  anchors: P2[];
  side: -1 | 1;
  mapping?: SkinPhotoMapping;
}
const initialConfiguration = (): Configuration => ({ polygons: [], reviewed: false, anchors: [], side: -1 });
const button = 'admin-focus-ring min-h-10 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 disabled:opacity-50';
const EMPTY: readonly SkinMappedCandidate[] = [];

export default function SkinMultiViewReview({ sources, surface, renderMask, onClose }: {
  sources: readonly SkinPhotoSource[];
  surface?: PersonalSurface;
  renderMask?: (points: readonly SkinMappedCandidate[]) => ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), preview = useRef<HTMLCanvasElement>(null);
  const request = useRef(0);
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? '');
  const [configurations, setConfigurations] = useState<Record<string, Configuration>>({});
  const [draft, setDraft] = useState<P2[]>([]);
  const [mode, setMode] = useState<'roi' | 'align' | null>(null);
  const [results, setResults] = useState<SkinPhotoResult[]>([]);
  const [usedIds, setUsedIds] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'dismissed'>>({});
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('Elige fotos confirmadas y revisa sus áreas de piel.');
  const [error, setError] = useState<string | null>(null), [showMask, setShowMask] = useState(false);
  const [coordinates, setCoordinates] = useState({ x: 50, y: 50 });
  const [sensitivity, setSensitivity] = useState(50);
  const selected = sources.find(source => source.id === selectedId);
  const config = configurations[selectedId] ?? initialConfiguration();
  const selectedResult = results.find(result => result.sourceId === selectedId);
  const candidates = selectedResult?.candidates ?? [];
  useEffect(() => {
    const element = dialog.current, focus = document.activeElement;
    const token = request;
    element?.showModal();
    return () => { token.current++; element?.close(); if (focus instanceof HTMLElement && focus.isConnected) focus.focus(); };
  }, []);
  useEffect(() => {
    request.current++;
    setResults([]); setUsedIds([]); setDecisions({}); setConfigurations({}); setBusy(false); setMode(null); setDraft([]);
    setSelectedId(sources[0]?.id ?? '');
    setMessage('Capturas actualizadas. Revisa las áreas antes de analizar.');
  }, [sources, surface]);
  useEffect(() => {
    const canvas = preview.current, context = canvas?.getContext('2d');
    if (!selected || !canvas || !context) return;
    const scale = Math.min(1, 768 / Math.max(selected.canvas.width, selected.canvas.height));
    canvas.width = Math.round(selected.canvas.width * scale); canvas.height = Math.round(selected.canvas.height * scale);
    context.drawImage(selected.canvas, 0, 0, canvas.width, canvas.height);
  }, [selected]);
  const invalidate = () => {
    request.current++; setBusy(false); setResults([]); setUsedIds([]); setDecisions({});
    setMessage('Configuración cambiada. Vuelve a analizar las fotos.');
  };
  const configure = (next: Configuration) => {
    invalidate(); setConfigurations(previous => ({ ...previous, [selectedId]: next })); setError(null);
  };
  const addPoint = (point: P2) => {
    if (!mode || busy) return;
    if (mode === 'roi' && draft.length < 64) setDraft(previous => [...previous, point]);
    if (mode === 'align' && config.anchors.length < PROFILE_SKIN_ANCHORS.length) configure({ ...config, mapping: undefined, anchors: [...config.anchors, point] });
  };
  const maskFor = (source: SkinPhotoSource, width: number, height: number) => {
    const entry = configurations[source.id];
    if (!source.confirmed) throw new Error('Confirma que la captura corresponde a la persona revisada.');
    if (entry?.polygons.length) {
      if (!entry.reviewed) throw new Error('Confirma que las áreas marcadas contienen solo piel.');
      return skinPolygonMask(width, height, entry.polygons);
    }
    if (!source.landmarks) throw new Error('Sin detección fiable: delimita primero una o varias áreas de piel.');
    return createSkinSignalMask(width, height, source.landmarks);
  };
  const analyze = async () => {
    const id = ++request.current;
    setBusy(true); setError(null); setResults([]); setUsedIds([]); setDecisions({}); setMode(null); setDraft([]);
    const quality: SkinPhotoResult[] = [];
    try {
      for (const source of sources) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (id !== request.current) return;
        try {
          const base = skinSignalPreview(source.canvas, 384), context = base.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('No se pudieron leer los píxeles de la foto.');
          const mask = maskFor(source, base.width, base.height);
          const score = skinPhotoQuality(context.getImageData(0, 0, base.width, base.height), mask);
          quality.push({ sourceId: source.id, candidates: [], score, usable: score >= 0.6,
            reason: score >= 0.6 ? '' : 'Piel insuficiente, oscuridad o exposición inadecuada.', milliseconds: 0 });
        } catch (cause) {
          console.warn('Captura excluida del análisis local de piel.', cause);
          quality.push({ sourceId: source.id, candidates: [], score: 0, usable: false,
            reason: cause instanceof Error ? cause.message : 'Captura no utilizable.', milliseconds: 0 });
        }
      }
      const chosen = selectSkinPhotos(sources, quality);
      if (!chosen.length) throw new Error('No hay fotos utilizables. Confirma la captura y delimita una zona de piel visible.');
      for (const sourceId of chosen) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (id !== request.current) return;
        const source = sources.find(item => item.id === sourceId)!;
        setMessage(`Analizando ${source.label}… Todo se procesa en este dispositivo.`);
        const started = performance.now(), base = skinSignalPreview(source.canvas, 384);
        const context = base.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('No se pudieron leer los píxeles.');
        const mask = maskFor(source, base.width, base.height);
        const analysis = analyzeSkinAppearance(context.getImageData(0, 0, base.width, base.height), mask, { sensitivity: sensitivity / 100 });
        const entry = quality.find(item => item.sourceId === sourceId)!;
        entry.usable = analysis.usable;
        entry.reason = analysis.usable ? '' : analysis.warnings.find(warning => warning.startsWith('No utilizable:')) ?? 'Sin soporte visual suficiente.';
        entry.candidates = skinVisualCandidates(analysis, mask, base.width, base.height);
        entry.milliseconds = performance.now() - started;
      }
      if (id !== request.current) return;
      setResults(quality);
      const used = chosen.filter(sourceId => quality.find(item => item.sourceId === sourceId)?.usable);
      setUsedIds(used);
      setSelectedId(used[0] ?? chosen[0]);
      setMessage(used.length
        ? `${used.length} fotos analizadas; revisa los candidatos. No son lesiones confirmadas.`
        : 'Las fotos seleccionadas no ofrecen soporte suficiente. Revisa luz y áreas de piel.');
    } catch (cause) {
      console.error('Falló la revisión multivista de piel.', cause);
      if (id === request.current) setError(cause instanceof Error ? cause.message : 'No se pudo analizar la piel.');
    } finally { if (id === request.current) setBusy(false); }
  };
  const mapped = useMemo(() => {
    if (!surface) return EMPTY;
    const points: SkinMappedCandidate[] = [];
    for (const source of sources) {
      const mapping = configurations[source.id]?.mapping ?? source.mapping;
      if (!mapping) continue;
      for (const [index, candidate] of (results.find(result => result.sourceId === source.id)?.candidates ?? []).entries()) {
        if (decisions[`${source.id}/${candidate.id}`] === 'dismissed') continue;
        const point = mapSkinCandidate(source.id, candidate, mapping, surface);
        if (point) points.push({ ...point, label: `${source.label} ${index + 1}` });
      }
    }
    return mergeSkinObservations(points, Math.abs(surface.positions[31] - surface.positions[457]));
  }, [sources, configurations, results, decisions, surface]);
  const mapping = config.mapping ?? selected?.mapping;
  const visibleCandidates = candidates.filter(candidate => decisions[`${selectedId}/${candidate.id}`] !== 'dismissed');
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }}
    aria-labelledby="skin-multiview-title" className="m-auto max-h-[96dvh] w-[min(1500px,98vw)] max-w-none overflow-y-auto overscroll-contain rounded-2xl bg-slate-50 p-3 text-slate-900 shadow-xl backdrop:bg-slate-950/70 sm:p-5">
    <header className="flex items-start justify-between gap-3">
      <div><h2 id="skin-multiview-title" className="text-lg font-semibold">Revisión de piel · fotos y máscara</h2>
        <p className="mt-1 text-xs">Candidatos de rojez, contraste y textura. Revisión humana obligatoria; no identifica enfermedades ni tipos de lesión.</p></div>
      <button type="button" className={button} onClick={onClose}>Cerrar</button>
    </header>
    <div className="my-3 flex flex-wrap gap-2" role="group" aria-label="Fotos de piel">
      {sources.map(source => <button type="button" key={source.id} className={`${button} aria-pressed:border-sky-700 aria-pressed:bg-sky-50`}
        aria-pressed={selectedId === source.id} onClick={() => { setSelectedId(source.id); setMode(null); setDraft([]); setError(null); }}>
        {source.label}{usedIds.includes(source.id) ? ' · analizada' : ''}{!source.confirmed ? ' · sin confirmar' : ''}
      </button>)}
    </div>
    {!sources.length ? <p role="status">Carga primero una foto en Capturas.</p> : <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
      <div className="min-w-0 space-y-3">
        <button type="button" className="admin-focus-ring relative mx-auto block max-w-full overflow-hidden rounded-xl bg-slate-900"
          aria-label={`Foto ${selected?.label}. ${mode === 'roi' ? 'Marca el borde del área de piel.' : mode === 'align' ? 'Marca el punto de perfil indicado.' : 'Vista de candidatos de piel.'}`}
          onClick={event => {
            if (!mode) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.detail === 0) return;
            addPoint({ x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
          }}>
          <canvas ref={preview} className="block h-auto max-h-[60dvh] max-w-full" role="img" aria-label={`Fotografía local ${selected?.label}`} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
            {config.polygons.map((polygon, i) => <polygon key={i} points={polygon.map(p => `${p.x},${p.y}`).join(' ')}
              fill="#38bdf8" fillOpacity=".08" stroke="#38bdf8" strokeWidth=".003" />)}
            {draft.length > 0 && <polyline points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#f59e0b" strokeWidth=".004" />}
            {visibleCandidates.map(candidate => {
              const index = candidates.indexOf(candidate) + 1;
              return <g key={candidate.id} fill="none" stroke={SKIN_CANDIDATE_COLORS[candidate.channel]} strokeWidth=".004">
                <rect x={candidate.x} y={candidate.y} width={candidate.width} height={candidate.height} />
                <text x={candidate.x} y={Math.max(.025, candidate.y - .008)} fill="white" stroke="black" strokeWidth=".002" paintOrder="stroke" fontSize=".025">{index}</text>
              </g>;
            })}
            {config.anchors.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r=".008" fill="#38bdf8" stroke="black" strokeWidth=".002" />
              <text x={p.x + .01} y={p.y} fill="white" stroke="black" strokeWidth=".001" paintOrder="stroke" fontSize=".025">{i + 1}</text></g>)}
          </svg>
        </button>
        {mode && <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-white p-2">
          <p className="w-full text-xs">{mode === 'roi' ? 'Haz clic alrededor de piel visible, sin ojo, labios, pelo ni fondo.' : `Punto ${Math.min(6, config.anchors.length + 1)}/6: ${PROFILE_SKIN_ANCHORS[Math.min(5, config.anchors.length)].label}`}</p>
          <label className="text-xs">X (%)<input type="number" min="0" max="100" value={coordinates.x} className="admin-focus-ring ml-1 w-20 rounded border p-2"
            onChange={event => setCoordinates(previous => ({ ...previous, x: Number(event.target.value) }))} /></label>
          <label className="text-xs">Y (%)<input type="number" min="0" max="100" value={coordinates.y} className="admin-focus-ring ml-1 w-20 rounded border p-2"
            onChange={event => setCoordinates(previous => ({ ...previous, y: Number(event.target.value) }))} /></label>
          <button type="button" className={button} onClick={() => {
            if ([coordinates.x, coordinates.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) addPoint({ x: coordinates.x / 100, y: coordinates.y / 100 });
            else setError('Las coordenadas deben estar entre 0 y 100 %.');
          }}>Añadir punto</button>
          <button type="button" className={button} onClick={() => mode === 'roi' ? setDraft(previous => previous.slice(0, -1)) : configure({ ...config, mapping: undefined, anchors: config.anchors.slice(0, -1) })}>Quitar último punto</button>
        </div>}
        {showMask && renderMask && <section aria-label="Candidatos sobre máscara" className="min-w-0 rounded-xl bg-slate-900 p-2 text-white">
          {renderMask(mapped)}
          <p className="p-2 text-xs">{mapped.length} ubicaciones aproximadas, identificadas por foto y número. Un indicador puede reunir varias fotos; no es un recuento clínico de lesiones. Gira para revisar el lado visible.</p>
        </section>}
      </div>
      <div className="min-w-0 space-y-3">
        <section className="space-y-2 rounded-xl border bg-white p-3" aria-label="Preparar áreas de piel">
          <h3 className="text-sm font-semibold">1. Revisa el área de piel</h3>
          <p className="text-xs">{selected?.landmarks ? 'Hay una selección automática aproximada que protege ojos y labios. Puedes delimitar áreas más precisas.' : 'Esta foto se acepta en 2D aunque no tenga malla. Delimita piel visible para analizarla.'}</p>
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || config.polygons.length >= 8}
            onClick={() => { setMode('roi'); setDraft([]); }}>Delimitar piel</button>
          {mode === 'roi' && <button type="button" className={button} onClick={() => {
            if (!isValidSkinPolygon(draft)) { setError('Marca al menos tres puntos y evita cruzar el borde.'); return; }
            configure({ ...config, polygons: [...config.polygons, draft], reviewed: false }); setMode(null); setDraft([]);
          }}>Cerrar área</button>}
          {config.polygons.length > 0 && <button type="button" className={button} onClick={() => configure({ ...config, polygons: [], reviewed: false })}>Borrar áreas</button>}</div>
          {config.polygons.length > 0 && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="admin-focus-ring mt-0.5" checked={config.reviewed}
            onChange={event => configure({ ...config, reviewed: event.target.checked })} />Las áreas contienen solo piel visible, sin ojos, labios, pelo ni fondo.</label>}
        </section>
        <section className="space-y-2 rounded-xl border bg-white p-3">
          <h3 className="text-sm font-semibold">2. Buscar candidatos en las mejores fotos</h3>
          <p className="text-xs">Hasta tres fotos: frontal y ambos lados, si son utilizables. Luz, maquillaje, barba y compresión pueden crear falsos candidatos.</p>
          <label className="block text-xs">Sensibilidad · {sensitivity}%<input aria-label="Sensibilidad de candidatos de piel" type="range" min="0" max="100" value={sensitivity}
            className="admin-focus-ring mt-1 w-full" onChange={event => { setSensitivity(Number(event.target.value)); invalidate(); }} /></label>
          <button type="button" className={button} disabled={busy} onClick={() => void analyze()}>{busy ? 'Analizando fotos…' : 'Analizar mejores 3 fotos'}</button>
          {busy && <button type="button" className={button} onClick={() => { request.current++; setBusy(false); setMessage('Análisis cancelado. No se aplicaron cambios.'); }}>Cancelar análisis</button>}
          <p role="status" aria-live="polite" aria-busy={busy} className="text-xs">{message}</p>
          {results.map(result => <p key={result.sourceId} className="text-xs text-slate-600">{sources.find(source => source.id === result.sourceId)?.label}: {result.reason || (usedIds.includes(result.sourceId) ? `${result.candidates.length} candidatos · ${Math.round(result.milliseconds)} ms` : 'Otra foto cubre mejor esta vista; no analizada.')}</p>)}
        </section>
        <details className="rounded-xl border bg-white p-3" open={!mapping && !!surface}>
          <summary className="admin-focus-ring cursor-pointer text-sm font-semibold">Alinear perfil puro con la máscara</summary>
          <p className="my-2 text-xs">Solo perfiles de 90°. Marca seis referencias. Esto coloca indicadores aproximados: no cambia la máscara ni añade textura lateral o anatomía oculta.</p>
          <label className="block text-xs">Lado visible del paciente<select aria-label="Lado visible del perfil" className="admin-focus-ring my-2 block w-full rounded border p-2" value={config.side}
            onChange={event => configure({ ...config, side: Number(event.target.value) === -1 ? -1 : 1, mapping: undefined })}>
            <option value="-1">Derecho del paciente</option><option value="1">Izquierdo del paciente</option>
          </select></label>
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!surface || busy} onClick={() => { configure({ ...config, anchors: [], mapping: undefined }); setMode('align'); }}>Marcar seis referencias</button>
            <button type="button" className={button} disabled={!surface || config.anchors.length !== 6 || busy} onClick={() => {
              try {
                if (!surface || !selected) return;
                const next = alignSkinProfile(surface, config.anchors, selected.canvas.width / selected.canvas.height, config.side);
                configure({ ...config, mapping: next }); setMode(null); setMessage('Alineación manual aceptada. Vuelve a analizar y comprueba los indicadores en la máscara.');
              } catch (cause) { console.warn('Alineación de perfil rechazada.', cause); setError(cause instanceof Error ? cause.message : 'Alineación no válida.'); }
            }}>Validar alineación</button></div>
          <p className="mt-2 text-xs">{mapping?.manual ? 'Alineación manual aproximada activa.' : mapping ? 'Correspondencia automática disponible.' : 'Sin proyección segura: los candidatos quedan solo en la foto.'}</p>
          {!surface && <p className="mt-2 text-xs">Genera y acepta una máscara para habilitar la alineación.</p>}
        </details>
        <section className="space-y-2 rounded-xl border bg-white p-3">
          <h3 className="text-sm font-semibold">3. Revisar, no diagnosticar</h3>
          {!!renderMask && <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="admin-focus-ring" checked={showMask} onChange={event => setShowMask(event.target.checked)} />Mostrar indicadores en la máscara</label>}
          <p className="text-xs">Los cuadros no confirman acné, lunares ni cicatrices. Aceptar solo registra tu revisión en esta sesión; no aplica retoques.</p>
          <ol aria-label="Candidatos multivista" className="max-h-64 space-y-2 overflow-y-auto">
            {visibleCandidates.map(candidate => {
              const id = `${selectedId}/${candidate.id}`, index = candidates.indexOf(candidate) + 1;
              return <li key={id} className="rounded border p-2 text-xs"><p>{index}. {SKIN_CANDIDATE_LABELS[candidate.channel]}{decisions[id] === 'accepted' ? ' · revisado' : ' · pendiente'}</p>
                <p>{mapped.find(point => point.observationIds.includes(id))
                  ? `Indicador en máscara: ${mapped.find(point => point.observationIds.includes(id))!.label}.`
                  : 'Solo foto: sin correspondencia 3D segura.'}</p>
                <div className="mt-1 flex gap-2"><button type="button" className={button} onClick={() => setDecisions(previous => ({ ...previous, [id]: 'accepted' }))}>Aceptar candidato {index}</button>
                  <button type="button" className={button} onClick={() => setDecisions(previous => ({ ...previous, [id]: 'dismissed' }))}>Descartar candidato {index}</button></div>
              </li>;
            })}
          </ol>
          {selectedResult && !candidates.length && <p className="text-xs">Sin candidatos con esta configuración. No significa ausencia de lesiones.</p>}
          {Object.keys(decisions).length > 0 && <button type="button" className={button} onClick={() => setDecisions({})}>Restablecer revisión</button>}
        </section>
        {error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
        <p className="text-xs text-slate-600">Procesamiento local, sin API keys ni tokens. 384 px por foto, una a la vez; se conservan cuadros y decisiones, no mapas RGB completos. Todo se descarta al cerrar.</p>
      </div>
    </div>}
  </dialog>;
}
