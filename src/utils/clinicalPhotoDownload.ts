export const MAX_DOWNLOAD_PHOTOS = 15;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface DownloadPhoto {
  id: number;
  r2_url: string;
}

export interface PhotoDownloadProgress {
  completed: number;
  total: number;
  bytes: number;
  phase: 'reading' | 'packing';
}

const RETRY_MESSAGE = 'Actualiza la lista para renovar los enlaces y vuelve a intentar. Si persiste, revisa la configuración CORS de R2.';
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/avif': 'avif', 'image/tiff': 'tif', 'image/bmp': 'bmp',
};

function validatePhotos(photos: readonly DownloadPhoto[], zip: boolean) {
  if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_DOWNLOAD_PHOTOS || (!zip && photos.length !== 1)) {
    throw new Error('Selecciona entre 1 y 15 fotos por paquete (una para descarga individual).');
  }
  const ids = new Set<number>();
  for (const photo of photos) {
    if (!photo || !Number.isSafeInteger(photo.id) || photo.id <= 0 || ids.has(photo.id)) {
      throw new Error('La selección contiene identificadores inválidos o duplicados. Actualiza la lista.');
    }
    ids.add(photo.id);
    let url: URL;
    if (typeof photo.r2_url !== 'string') throw new Error(`El enlace de la foto ${photo.id} no está disponible. ${RETRY_MESSAGE}`);
    try { url = new URL(photo.r2_url); }
    catch { throw new Error(`El enlace de la foto ${photo.id} no está disponible. ${RETRY_MESSAGE}`); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`El enlace de la foto ${photo.id} no es válido. ${RETRY_MESSAGE}`);
    }
  }
}

async function readOriginal(
  photo: DownloadPhoto,
  signal: AbortSignal,
  previousBytes: number,
  onBytes: (bytes: number) => void,
): Promise<Blob> {
  let response: Response;
  try {
    // R2 presignado: nunca usar recordsFetch, tokens ni cookies.
    response = await fetch(photo.r2_url, { credentials: 'omit', mode: 'cors', redirect: 'error', signal });
  } catch {
    signal.throwIfAborted();
    throw new Error(`No se pudo leer la foto ${photo.id}: error de red o CORS. ${RETRY_MESSAGE}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Foto ${photo.id}: HTTP ${response.status}; el enlace puede haber caducado o no tener permiso. ${RETRY_MESSAGE}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES - previousBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('El paquete supera 100 MiB de originales. Selecciona menos fotos.');
  }
  if (!response.body) throw new Error(`La foto ${photo.id} no tiene un cuerpo legible. ${RETRY_MESSAGE}`);

  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: BlobPart[] = [];
  let bytes = previousBytes;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      // El encabezado puede faltar o mentir: comprobar ANTES de retener cada chunk.
      if (value.byteLength > MAX_DOWNLOAD_BYTES - bytes) {
        throw new Error('El paquete supera 100 MiB de originales. Selecciona menos fotos.');
      }
      bytes += value.byteLength;
      chunks.push(new Uint8Array(value));
      onBytes(bytes);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    signal.throwIfAborted();
    if (error instanceof TypeError) {
      throw new Error(`Lectura interrumpida de la foto ${photo.id}: red o CORS. ${RETRY_MESSAGE}`);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || 'application/octet-stream' });
}

function saveBlob(blob: Blob, filename: string) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Dar tiempo al navegador a iniciar la descarga; revocar incluso si click falla.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Una sola operación activa; el límite es de entrada, no de memoria total del navegador. */
export class ClinicalPhotoDownloader {
  private active: AbortController | null = null;

  get busy() { return this.active !== null; }

  cancel() { this.active?.abort(); }

  async download(
    photos: readonly DownloadPhoto[],
    zip: boolean,
    onProgress: (progress: PhotoDownloadProgress) => void = () => undefined,
  ): Promise<void> {
    if (this.active) throw new Error('Ya hay una descarga en curso.');
    validatePhotos(photos, zip);
    // Congelar los campos relevantes antes de cualquier await.
    photos = photos.map(photo => ({ id: photo.id, r2_url: photo.r2_url }));
    const controller = new AbortController();
    this.active = controller;
    const { signal } = controller;
    let bytes = 0;
    try {
      // Cargar zip.js solo para ZIP. Sin worker ni recompresión de originales.
      const zipModule = zip ? await import('@zip.js/zip.js') : null;
      signal.throwIfAborted();
      const writer = zipModule
        ? new zipModule.ZipWriter(new zipModule.BlobWriter('application/zip'), { level: 0, useWebWorkers: false })
        : null;
      let finished = false;
      try {
        for (let index = 0; index < photos.length; index++) {
          signal.throwIfAborted();
          onProgress({ completed: index, total: photos.length, bytes, phase: 'reading' });
          const blob = await readOriginal(photos[index], signal, bytes, value => {
            bytes = value;
            onProgress({ completed: index, total: photos.length, bytes, phase: 'reading' });
          });
          signal.throwIfAborted();
          const extension = EXTENSIONS[blob.type] || 'bin';
          const filename = `foto-${photos[index].id}.${extension}`;
          if (writer && zipModule) {
            onProgress({ completed: index, total: photos.length, bytes, phase: 'packing' });
            await writer.add(filename, new zipModule.BlobReader(blob), { level: 0, useWebWorkers: false, signal });
          } else {
            saveBlob(blob, filename);
          }
          onProgress({ completed: index + 1, total: photos.length, bytes, phase: 'reading' });
        }
        if (writer) {
          const blob = await writer.close();
          finished = true;
          signal.throwIfAborted();
          saveBlob(blob, 'fotos-originales.zip');
        }
      } finally {
        // Cerrar recursos en fallo/cancelación, pero NUNCA guardar un archivo parcial.
        if (writer && !finished) await writer.close().catch(() => undefined);
      }
    } finally {
      this.active = null;
    }
  }
}
