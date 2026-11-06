import recordsFetch from '../../../../utils/recordsFetch';
import { parsePhotoReference, safePhotoReadURL } from './skinVisualAI';
import type { PhotoReference } from './skinVisualAI';
import type { FaceSimController, FacialSimulationState } from '../../../../lab/faceSim/facialSimulationSession';

type Capture = ReturnType<FaceSimController['getPhotos']>[number];
export interface SimulationPhotoCacheEntry {
  recordId: number;
  canvas: HTMLCanvasElement;
  original?: File;
  reference: PhotoReference;
}
export type SimulationPhotoCache = Map<string, SimulationPhotoCacheEntry>;

async function responseJSON(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Error HTTP ${response.status}.`);
  return data;
}

function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1]) : reject(new Error('No se pudo leer la foto.'));
    reader.onerror = () => reject(new Error('No se pudo leer la foto.'));
    reader.readAsDataURL(file);
  });
}

/** Reutiliza referencias solo si expediente, canvas y original siguen siendo idénticos. */
export async function ensureSimulationPhotos(
  recordId: number, captures: Capture[], cache: SimulationPhotoCache, signal?: AbortSignal,
): Promise<Record<string, PhotoReference>> {
  const references: Record<string, PhotoReference> = {};
  for (const capture of captures) {
    signal?.throwIfAborted();
    const cached = cache.get(capture.id);
    if (cached?.recordId === recordId && cached.canvas === capture.canvas && cached.original === capture.original) {
      references[capture.id] = cached.reference;
      continue;
    }
    const original = capture.original;
    if (!original || !['image/jpeg', 'image/png', 'image/webp'].includes(original.type)) {
      throw new Error('Falta el archivo original JPEG, PNG o WebP de una foto. Vuelve a cargarla antes de guardar.');
    }
    if (4 * Math.ceil(original.size / 3) > 3_999_000) {
      throw new Error('La foto original supera el límite de envío de 4 MB. Usa un archivo más pequeño; no se ha sustituido ni comprimido.');
    }
    const content = await base64(original);
    signal?.throwIfAborted();
    const body = JSON.stringify({ action: 'uploadPhotoProxy', record_id: recordId, fileBase64: content,
      content_type: original.type, photo_type: 'general', session_label: 'Simulación facial' });
    if (new Blob([body]).size > 4_000_000) {
      throw new Error('La foto original supera el límite de envío de 4 MB. Usa un archivo más pequeño; no se ha sustituido ni comprimido.');
    }
    let response: Response;
    try {
      response = await recordsFetch('/api/records', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('No se confirmó la subida. Podría haberse guardado una copia; revisa Fotos antes de reintentar.');
    }
    const reference = parsePhotoReference(await responseJSON(response), recordId);
    cache.set(capture.id, { recordId, canvas: capture.canvas, original, reference });
    references[capture.id] = reference;
  }
  if (new Set(Object.values(references).map(reference => reference.id)).size !== Object.keys(references).length) {
    throw new Error('Cada vista debe usar una foto diferente del expediente.');
  }
  return references;
}

/** Recupera URLs firmadas renovadas de la biblioteca y reconstruye capturas sin persistirlas. */
export async function loadSimulationPhotos(
  recordId: number, state: FacialSimulationState, signal?: AbortSignal,
): Promise<{ canvases: Record<string, HTMLCanvasElement>; originals: Record<string, Blob> }> {
  const wanted = new Map(state.photos.map(entry => [entry.photo.id, entry]));
  const found = new Map<number, { r2_key: string; r2_url: string | null }>();
  for (let offset = 0; found.size < wanted.size;) {
    signal?.throwIfAborted();
    const page = await responseJSON(await recordsFetch(
      `/api/records?action=listPhotos&record_id=${recordId}&limit=50&offset=${offset}`, { signal },
    ));
    if (!Array.isArray(page.photos)) throw new Error('Respuesta inválida de la biblioteca.');
    for (const photo of page.photos) if (wanted.has(photo.id)) found.set(photo.id, photo);
    offset += page.photos.length;
    if (!page.hasMore || page.photos.length === 0) break;
  }
  const canvases: Record<string, HTMLCanvasElement> = {}, originals: Record<string, Blob> = {};
  for (const entry of state.photos) {
    const photo = found.get(entry.photo.id);
    if (!photo || photo.r2_key !== entry.photo.r2Key) throw new Error('Una foto de la máscara ya no está disponible en este expediente.');
    const url = safePhotoReadURL(photo.r2_url);
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw new Error('No se pudo recuperar una foto de la máscara.');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('La foto recuperada no es una imagen.');
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Una foto supera el límite de 40 megapíxeles.');
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No se pudo preparar la foto.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvases[entry.slot] = canvas; originals[entry.slot] = blob;
    } finally { bitmap.close(); }
  }
  return { canvases, originals };
}
