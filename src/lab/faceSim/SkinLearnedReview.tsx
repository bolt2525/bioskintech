import { useEffect, useRef, useState } from 'react';
import { COLORS } from '../../constants/theme';
import { SkinLearnedClient } from './skinLearnedClient';
import { SKIN_MODEL, skinLetterboxGeometry, type SkinLearnedResult } from './skinLearnedImage';
import { createSkinSignalMask } from './skinSignalTexture';
import type { SkinPhotoSource } from './skinMultiView';

const button = 'admin-focus-ring min-h-11 rounded-lg border border-white/20 bg-stone-950 px-3 py-2 text-sm text-stone-100 hover:border-gold disabled:cursor-not-allowed disabled:opacity-50';
const unavailable = ['Acné', 'Manchas', 'Lunares', 'Cicatrices', 'Poros', 'Arrugas finas', 'Arrugas gruesas'];
interface Area { left: number; top: number; right: number; bottom: number }
const initialArea: Area = { left: 15, top: 25, right: 85, bottom: 85 };
const areaLabels = { left: 'Izquierda (%)', top: 'Arriba (%)', right: 'Derecha (%)', bottom: 'Abajo (%)' };

export default function SkinLearnedReview({ sources }: { sources: readonly SkinPhotoSource[] }) {
  const client = useRef<SkinLearnedClient>();
  const generation = useRef(0);
  const photo = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLCanvasElement>(null);
  const [selectedId, setSelectedId] = useState(sources[0]?.id ?? '');
  const [results, setResults] = useState<Record<string, SkinLearnedResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [areas, setAreas] = useState<Record<string, Area>>({});
  const [draft, setDraft] = useState<Area>(initialArea), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('Confirma las fotos en Capturas y pulsa Analizar piel.');
  const [visible, setVisible] = useState(true), [opacity, setOpacity] = useState(40), [zoom, setZoom] = useState(1);
  const [overlayError, setOverlayError] = useState('');
  const selected = sources.find(item => item.id === selectedId);
  const result = results[selectedId];
  const eligible = sources.filter(item => item.confirmed && (item.landmarks || areas[item.id]));
  useEffect(() => {
    const counter = generation, activeClient = client;
    generation.current++;
    client.current?.dispose(); client.current = undefined;
    setResults({}); setErrors({}); setAreas({}); setBusy(false); setSelectedId(sources[0]?.id ?? '');
    setDraft(initialArea); setApproved(false); setZoom(1);
    setStatus('Confirma las fotos en Capturas y pulsa Analizar piel.');
    return () => { counter.current++; activeClient.current?.dispose(); activeClient.current = undefined; };
  }, [sources]);
  useEffect(() => {
    const canvas = photo.current, context = canvas?.getContext('2d');
    if (!selected || !canvas || !context) return;
    const scale = Math.min(1, 1200 / Math.max(selected.canvas.width, selected.canvas.height));
    canvas.width = Math.max(1, Math.round(selected.canvas.width * scale));
    canvas.height = Math.max(1, Math.round(selected.canvas.height * scale));
    context.drawImage(selected.canvas, 0, 0, canvas.width, canvas.height);
  }, [selected]);
  useEffect(() => {
    setOverlayError('');
    const canvas = layer.current, context = canvas?.getContext('2d');
    if (!canvas || !context || !result || !selected) return;
    try {
      canvas.width = result.width; canvas.height = result.height;
      const manual = areas[selected.id];
      const mask = manual ? new Uint8Array(result.width * result.height).fill(1) :
        createSkinSignalMask(result.width, result.height, selected.landmarks);
      const image = context.createImageData(result.width, result.height);
      const color = parseInt(COLORS.gold.slice(1), 16);
      let eligiblePixels = 0;
      for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
        const index = y * result.width + x, u = (x + .5) / result.width, v = (y + .5) / result.height;
        if (!mask[index] || (manual && (u < manual.left / 100 || u > manual.right / 100 ||
          v < manual.top / 100 || v > manual.bottom / 100))) continue;
        eligiblePixels++;
        if (result.probability[index] >= SKIN_MODEL.threshold) image.data.set([color >> 16, (color >> 8) & 255, color & 255, 255], index * 4);
      }
      if (!eligiblePixels) throw new Error('El área de piel no contiene píxeles utilizables. Revisa las referencias o delimita una zona mayor.');
      context.putImageData(image, 0, 0);
    } catch (error) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      setOverlayError(error instanceof Error ? error.message : 'No se pudo preparar la capa de piel.');
    }
  }, [selected, result, areas]);
  const cancel = () => {
    generation.current++; client.current?.dispose(); client.current = undefined;
    setBusy(false); setStatus('Análisis cancelado. Se conservan las capas anteriores.');
  };
  const analyze = async () => {
    const token = ++generation.current;
    setBusy(true); setErrors({});
    const updates: Record<string, SkinLearnedResult> = {}, failures: Record<string, string> = {};
    for (const [index, source] of eligible.entries()) {
      let bitmap: ImageBitmap | undefined;
      try {
        skinLetterboxGeometry(source.canvas.width, source.canvas.height);
        bitmap = await createImageBitmap(source.canvas);
        if (generation.current !== token) { bitmap.close(); return; }
        client.current ??= new SkinLearnedClient();
        updates[source.id] = await client.current.analyze(bitmap, message => {
          if (generation.current === token) setStatus(`${index + 1}/${eligible.length} · ${source.label} · ${message}`);
        });
      } catch (error) {
        bitmap?.close();
        if (generation.current !== token) return;
        failures[source.id] = error instanceof Error ? error.message : 'No se pudo analizar esta foto.';
        client.current?.dispose(); client.current = undefined;
      }
      if (generation.current !== token) return;
    }
    if (generation.current !== token) return;
    setResults(previous => ({ ...previous, ...updates })); setErrors(failures); setBusy(false);
    setStatus(`${Object.keys(updates).length}/${eligible.length} fotos procesadas. ${Object.keys(failures).length ? 'Hay fotos con errores; sus capas anteriores se conservan.' : 'La capa es experimental, no una confirmación de lesiones.'}`);
  };
  const select = (source: SkinPhotoSource) => {
    setSelectedId(source.id); setDraft(areas[source.id] ?? initialArea); setApproved(false); setZoom(1);
  };
  const confirmArea = () => {
    if (!selected || !approved || !Object.values(draft).every(Number.isFinite) ||
      draft.left < 0 || draft.top < 0 || draft.right > 100 || draft.bottom > 100 ||
      draft.right - draft.left < 1 || draft.bottom - draft.top < 1) {
      setErrors(previous => ({ ...previous, [selectedId]: 'Confirma un rectángulo de piel válido de al menos 1% por lado.' })); return;
    }
    setAreas(previous => ({ ...previous, [selectedId]: { ...draft } }));
    setErrors(previous => { const next = { ...previous }; delete next[selectedId]; return next; });
  };
  return <section aria-label="Análisis local de piel" className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-stone-950 p-3 text-stone-100 [color-scheme:dark]">
    <header className="space-y-2">
      <h3 className="font-semibold text-gold">Piel · análisis local experimental</h3>
      <p className="text-sm text-stone-300">Analiza fotos confirmadas y muestra una capa por categoría, sin aceptar puntos individualmente.</p>
      <p className="rounded-lg border border-amber-400/40 p-2 text-xs text-amber-100">
        Asistente experimental de análisis visual cosmético. No es un diagnóstico médico ni identifica o descarta enfermedades, y no sustituye la evaluación profesional. Solo hay un prototipo de segmentación asociado a melasma, entrenado en vistas laterales; no es una clasificación diferencial y no alcanza el objetivo de localización. Acné y las otras categorías aún no son evaluables.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy || !eligible.length} onClick={() => void analyze()}>Analizar piel</button>
        {busy && <button type="button" className={button} onClick={cancel}>Cancelar análisis local</button>}
      </div>
      <p className="text-xs text-stone-400">Sin descarga manual: el modelo (~13 MB) y su motor se cargan internamente al analizar. Las fotos y los resultados de esta herramienta permanecen en el dispositivo; no se envían a Gemini.</p>
    </header>
    <p role="status" aria-live="polite" aria-busy={busy} className="text-sm">{status}</p>
    {Object.keys(errors).length > 0 && <ul role="alert" className="space-y-1 text-sm text-red-200">
      {Object.entries(errors).map(([id, message]) => <li key={id}>{sources.find(item => item.id === id)?.label}: {message}</li>)}
    </ul>}
    <div role="group" aria-label="Fotos para análisis local" className="flex flex-wrap gap-2">
      {sources.map(source => <button key={source.id} type="button" className={button} aria-pressed={selectedId === source.id} onClick={() => select(source)}>
        {source.label}{!source.confirmed ? ' · sin confirmar' : results[source.id] ? ' · capa disponible' : !source.landmarks && !areas[source.id] ? ' · área requerida' : ''}
      </button>)}
    </div>
    <ul aria-label="Categorías de piel" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <li><button type="button" className={`${button} h-full w-full text-left`} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
        <span className="block text-gold">Melasma · experimental</span><span className="block text-xs">Solo patrón aprendido; no confirmado</span>
      </button></li>
      {unavailable.map(label => <li key={label} className="rounded-lg border border-white/10 p-2 text-sm text-stone-400">
        {label}<span className="block text-xs">No evaluable con este motor</span>
      </li>)}
    </ul>
    {!selected ? <p>Carga y confirma fotos en Capturas para comenzar.</p> : <>
      {!selected.confirmed && <p className="text-sm text-amber-100">Confirma esta foto en Capturas antes de analizar.</p>}
      {selected.group === 'front' && <p className="text-xs text-amber-100">Vista frontal fuera de la evaluación lateral del prototipo: no se presupone la misma calidad.</p>}
      {!selected.landmarks && selected.confirmed && <details open={!areas[selectedId]} className="rounded-lg border border-white/20 p-2">
        <summary className="admin-focus-ring cursor-pointer text-sm">Área manual de piel · sin referencias faciales</summary>
        <p className="my-2 text-xs">Delimita solo piel visible. Excluye ojos, labios, pelo, fondo y tatuajes. Esto limita la capa, no entrena el modelo.</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(areaLabels) as (keyof Area)[]).map(key => <label key={key} className="text-xs">{areaLabels[key]}
            <input type="number" min="0" max="100" step="1" disabled={busy} value={draft[key]}
              className="admin-focus-ring block min-h-11 w-full rounded border border-white/20 bg-stone-900 p-2"
              onChange={event => { setDraft(value => ({ ...value, [key]: Number(event.target.value) })); setApproved(false); }} />
          </label>)}
        </div>
        <label className="my-2 flex items-start gap-2 text-xs"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} />
          Confirmo que el rectángulo contiene solo piel visible, sin tatuajes ni zonas excluidas.</label>
        <button type="button" className={button} disabled={busy || !approved} onClick={confirmArea}>Confirmar área manual de piel</button>
      </details>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .5))}>Acercar foto</button>
        <button type="button" className={button} disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .5))}>Alejar foto</button>
        <button type="button" className={button} onClick={() => setZoom(1)}>Reencuadrar foto</button>
        <label className="flex min-h-11 items-center gap-2 text-xs">Opacidad de capa
          <input type="range" min="0" max="80" value={opacity} onChange={event => setOpacity(Number(event.target.value))} />
        </label>
      </div>
      <figure>
        <figcaption className="mb-1 text-sm">{selected.label} · foto original{result ? ' con capa experimental 2D' : ' sin análisis'}. No se proyecta automáticamente a 3D.</figcaption>
        <div className="max-h-[60dvh] overflow-auto rounded-lg border border-white/20">
          <div className="relative" style={{ width: `${zoom * 100}%` }}>
            <canvas ref={photo} aria-label={`Foto de piel ${selected.label}`} className="block h-auto w-full" />
            {result && <canvas ref={layer} aria-label="Capa experimental de segmentación" className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ opacity: visible && !overlayError ? opacity / 100 : 0 }} />}
            {!selected.landmarks && !areas[selectedId] && <div aria-hidden="true" className="pointer-events-none absolute border-2 border-dashed border-gold"
              style={{ left: `${draft.left}%`, top: `${draft.top}%`, width: `${Math.max(0, draft.right - draft.left)}%`, height: `${Math.max(0, draft.bottom - draft.top)}%` }} />}
          </div>
        </div>
      </figure>
      {overlayError && <p role="alert" className="text-sm text-red-200">{overlayError}</p>}
      {result && <p className="text-xs text-stone-300">Sin capa visible no significa ausencia de lesiones. El área facial/manual recorta la visualización; no aporta una nueva validación de precisión. El original no se modifica, y no se entrena con estas fotos.</p>}
    </>}
    <p className="text-xs text-stone-400">Fuentes de entrenamiento: <a className="underline" href="https://doi.org/10.6084/m9.figshare.29209229.v1" target="_blank" rel="noreferrer">MEMI-DS · Zhenwei Zhai · CC BY 4.0</a> e <a className="underline" href="https://challenge.isic-archive.com/data/" target="_blank" rel="noreferrer">ISIC 2017 · CC0</a>.</p>
  </section>;
}
