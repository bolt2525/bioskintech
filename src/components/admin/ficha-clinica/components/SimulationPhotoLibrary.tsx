import { useEffect, useRef, useState } from 'react';
import recordsFetch from '../../../../utils/recordsFetch';
import { parsePhotoReference, safePhotoReadURL } from './skinVisualAI';
import type { PhotoReference } from './skinVisualAI';

interface LibraryPhoto {
  id: number;
  r2_key: string;
  r2_url: string | null;
  session_label?: string;
}

interface SimulationPhotoLibraryProps {
  recordId: number;
  onSelect: (photo: PhotoReference, file: File) => void | Promise<void>;
  selection?: 'single' | 'multiple';
  onSelectMany?: (photos: { photo: PhotoReference; file: File }[]) => void | Promise<void>;
}

const button = 'admin-focus-ring min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 hover:bg-gray-100 disabled:opacity-50';
const PAGE_SIZE = 24;

/** Fotos del expediente: descargar no crea una nueva copia ni guarda la simulación. */
export function SimulationPhotoLibrary({ recordId, onSelect, onSelectMany, selection = 'single' }: SimulationPhotoLibraryProps) {
  const [photos, setPhotos] = useState<LibraryPhoto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<number[]>([]);
  const scope = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    scope.current?.abort();
    scope.current = request;
    setPhotos([]); setHasMore(false); setError(''); setSelectedId(null); setChecked([]); setLoading(true);
    recordsFetch(`/api/records?action=listPhotos&record_id=${recordId}&limit=${PAGE_SIZE}&offset=0`, { signal: request.signal })
      .then(async response => {
        if (!response.ok) throw new Error('No se pudo cargar la biblioteca de fotos.');
        const data = await response.json();
        if (!Array.isArray(data.photos)) throw new Error('Respuesta inválida de la biblioteca.');
        if (!request.signal.aborted) { setPhotos(data.photos); setHasMore(data.hasMore === true); }
      })
      .catch(e => { if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'Error al cargar fotos.'); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => { request.abort(); };
  }, [recordId]);

  async function loadMore() {
    const request = scope.current;
    if (!request || loading) return;
    setLoading(true); setError('');
    try {
      const response = await recordsFetch(`/api/records?action=listPhotos&record_id=${recordId}&limit=${PAGE_SIZE}&offset=${photos.length}`, { signal: request.signal });
      if (!response.ok) throw new Error('No se pudieron cargar más fotos.');
      const data = await response.json();
      if (!Array.isArray(data.photos)) throw new Error('Respuesta inválida de la biblioteca.');
      if (!request.signal.aborted) {
        setPhotos(previous => [...previous, ...data.photos.filter((p: LibraryPhoto) => !previous.some(item => item.id === p.id))]);
        setHasMore(data.hasMore === true);
      }
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'Error al cargar fotos.');
    } finally { if (!request.signal.aborted) setLoading(false); }
  }

  async function select(items: LibraryPhoto[]) {
    const request = scope.current;
    if (!request || selectedId !== null) return;
    setSelectedId(items[0]?.id ?? -1); setError('');
    try {
      const loaded: { photo: PhotoReference; file: File }[] = [];
      for (const photo of items) {
        request.signal.throwIfAborted();
        setSelectedId(photo.id);
        const reference = parsePhotoReference(photo, recordId);
        const url = safePhotoReadURL(photo.r2_url);
        const response = await fetch(url, { signal: request.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
        if (!response.ok) throw new Error('No se pudo abrir la foto. Actualiza la biblioteca e intenta de nuevo.');
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error('La foto no tiene un formato de imagen válido.');
        loaded.push({ photo: reference, file: new File([blob], `foto-${photo.id}`, { type: blob.type }) });
      }
      request.signal.throwIfAborted();
      if (onSelectMany) await onSelectMany(loaded);
      else for (const item of loaded) await onSelect(item.photo, item.file);
      if (!request.signal.aborted) setChecked(current => current.filter(id => !items.some(photo => photo.id === id)));
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'No se pudo abrir la foto.');
    } finally { if (!request.signal.aborted) setSelectedId(null); }
  }

  return (
    <section aria-label="Biblioteca de fotos del expediente" className="space-y-3">
      <h3 className="font-semibold text-gray-900">Fotos del expediente</h3>
      {selection === 'single' && <p className="text-sm text-gray-600">Selecciona una foto para usarla en la sesión. No se crea una copia al seleccionarla.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {loading && <p role="status" className="text-sm text-gray-600">Cargando fotos…</p>}
      {!loading && photos.length === 0 && <p className="text-sm text-gray-600">Este expediente todavía no tiene fotos.</p>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map(photo => {
          let url: string | undefined;
          try { url = safePhotoReadURL(photo.r2_url); } catch { /* Foto sin URL válida. */ }
          return <li key={photo.id} className="min-w-0 rounded-lg border border-gray-200 p-2">
            {url ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" className="aspect-square w-full rounded object-cover" /> :
              <div className="flex aspect-square items-center justify-center bg-gray-100 text-sm text-gray-600">No disponible</div>}
            <p className="truncate py-2 text-xs text-gray-700">Foto #{photo.id}{photo.session_label ? ` · ${photo.session_label}` : ''}</p>
            {selection === 'multiple' ? <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-gold-ink" disabled={!url || selectedId !== null || (!checked.includes(photo.id) && checked.length >= 3)}
                checked={checked.includes(photo.id)} onChange={e => setChecked(current => e.target.checked ? [...current, photo.id] : current.filter(id => id !== photo.id))} />
              Seleccionar foto {photo.id}
            </label> : <button type="button" className={button} disabled={!url || selectedId !== null} onClick={() => void select([photo])}
              aria-label={`Usar foto ${photo.id}`}>{selectedId === photo.id ? 'Abriendo…' : 'Usar foto'}</button>}
          </li>;
        })}
      </ul>
      {hasMore && <button type="button" className={button} disabled={loading} onClick={() => void loadMore()}>Cargar más fotos</button>}
      {selection === 'multiple' && photos.length > 0 && <button type="button" className={button} disabled={selectedId !== null || !checked.length}
        onClick={() => void select(photos.filter(photo => checked.includes(photo.id)))}>{selectedId !== null ? 'Abriendo fotos…' : `Usar fotos seleccionadas (${checked.length})`}</button>}
    </section>
  );
}
