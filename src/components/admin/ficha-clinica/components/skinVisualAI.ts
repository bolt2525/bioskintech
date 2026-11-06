import lesionCatalog from '../../../../data/skin-lesion-catalog.json' with { type: 'json' };

export const SKIN_CATEGORIES = lesionCatalog;
export type SkinCategory = keyof typeof SKIN_CATEGORIES;
export interface NormalizedBox { x: number; y: number; width: number; height: number }
export interface SkinProposal {
  id: string; category: SkinCategory; label: string; box: NormalizedBox; note: string;
}
export interface PhotoReference { id: number; r2Key: string }
export interface SkinAnalysis {
  analysisId: string; model: string; proposals: SkinProposal[];
  summary: string; limitations: string[];
  usage: { usedUsd: number; limitUsd: number; remainingUsd: number };
}
export type SkinStatus = SkinAnalysis['usage'] & { enabled: boolean; reason?: string; model: string };
/** Stored exclusively in skin_visual_review, never in the generic face/body maps. */
export interface ReviewedSkinMark {
  id: string;
  category: SkinCategory;
  label: string;
  note: string;
  coordinateSpace: 'clinical-photo-2d';
  reviewVersion: 1;
  photo: PhotoReference;
  normalizedBox: NormalizedBox;
  reviewStatus: 'validated';
  reviewedAt: string;
  source: {
    provider: 'google-gemini'; analysisId: string; model: string; requestId: string;
    analyzedAt: string; consentedAt: string; imageWidth: number; imageHeight: number;
    proposal: SkinProposal; summary: string; limitations: string[];
    context: SkinContext;
  };
}
export interface SkinVisualReviewData { version: 1; annotations: ReviewedSkinMark[] }
export interface SkinContext { skinType?: string; phototype?: string; hydration?: string }
export interface PreparedSkinPhoto {
  blob: Blob; base64: string; width: number; height: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function validBox(value: unknown): value is NormalizedBox {
  if (!object(value)) return false;
  const { x, y, width, height } = value;
  return [x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) &&
    Number(x) >= 0 && Number(y) >= 0 && Number(width) > 0 && Number(height) > 0 &&
    Number(x) + Number(width) <= 1.000001 && Number(y) + Number(height) <= 1.000001;
}
function validProposal(value: unknown): value is SkinProposal {
  return object(value) && typeof value.id === 'string' && typeof value.category === 'string' &&
    Object.prototype.hasOwnProperty.call(SKIN_CATEGORIES, value.category) &&
    !['other', 'poros-dilatados', 'nevo-displasico'].includes(value.category) && typeof value.label === 'string' &&
    value.label.trim().length > 0 && value.label.length <= 300 && typeof value.note === 'string' &&
    value.note.length <= 3000 && validBox(value.box);
}
function validUsage(value: unknown): value is SkinAnalysis['usage'] {
  return object(value) && ['usedUsd', 'limitUsd', 'remainingUsd'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0);
}
export function parseSkinStatus(value: unknown): SkinStatus {
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' ||
    (value.reason !== undefined && typeof value.reason !== 'string') || !validUsage(value)) {
    throw new Error('No se pudo verificar el permiso del servidor. Reintenta.');
  }
  return value as unknown as SkinStatus;
}
export function parseSkinAnalysis(value: unknown): SkinAnalysis {
  if (!object(value) || typeof value.analysisId !== 'string' || !value.analysisId ||
    typeof value.model !== 'string' || !value.model || !Array.isArray(value.proposals) ||
    value.proposals.length > 100 || !value.proposals.every(validProposal) ||
    new Set(value.proposals.map(p => p.id)).size !== value.proposals.length ||
    typeof value.summary !== 'string' || !Array.isArray(value.limitations) ||
    !value.limitations.every(s => typeof s === 'string') || !validUsage(value.usage)) {
    throw new Error('La respuesta de IA no es válida. No se incorporó ninguna propuesta.');
  }
  return value as unknown as SkinAnalysis;
}
function validReviewedMark(value: unknown): value is ReviewedSkinMark {
  if (!object(value) || value.coordinateSpace !== 'clinical-photo-2d' || value.reviewVersion !== 1 ||
    value.reviewStatus !== 'validated' || typeof value.id !== 'string' || typeof value.reviewedAt !== 'string' ||
    !object(value.photo) || !Number.isInteger(value.photo.id) || Number(value.photo.id) <= 0 ||
    typeof value.photo.r2Key !== 'string' || !value.photo.r2Key ||
    !validProposal({ ...value, box: value.normalizedBox }) || !object(value.source)) return false;
  const source = value.source;
  return source.provider === 'google-gemini' && typeof source.analysisId === 'string' &&
    typeof source.model === 'string' && typeof source.requestId === 'string' &&
    typeof source.analyzedAt === 'string' && typeof source.consentedAt === 'string' &&
    typeof source.imageWidth === 'number' && typeof source.imageHeight === 'number' &&
    typeof source.summary === 'string' && Array.isArray(source.limitations) &&
    source.limitations.every(s => typeof s === 'string') && object(source.context) && validProposal(source.proposal);
}
export function parseSkinReview(data?: string | SkinVisualReviewData): ReviewedSkinMark[] {
  let parsed: unknown = data;
  if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch { parsed = []; } }
  if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.annotations)) return [];
  return parsed.annotations.filter(validReviewedMark);
}
/** Legacy saves must not require the optional column until a review is actually used. */
export function skinReviewSaveField(
  existing: string | SkinVisualReviewData | undefined, annotations: ReviewedSkinMark[],
): { skin_visual_review?: SkinVisualReviewData } {
  return annotations.length || parseSkinReview(existing).length
    ? { skin_visual_review: { version: 1, annotations } } : {};
}
/** Descriptive text only: never expose storage keys, signed URLs, image data or 3D coordinates. */
export function skinReviewDescription(annotation: ReviewedSkinMark): string {
  return `${SKIN_CATEGORIES[annotation.category]} · ${annotation.label}${annotation.note ? ` — ${annotation.note}` : ''} · Foto clínica #${annotation.photo.id}`;
}
export function parsePhotoReference(value: unknown, recordId: number): PhotoReference {
  if (!object(value) || !Number.isInteger(value.id) || Number(value.id) <= 0 ||
    typeof value.r2_key !== 'string' || !value.r2_key.startsWith('clinics/') ||
    !value.r2_key.includes(`/records/${recordId}/photos/`) || /[?#\\\s]/.test(value.r2_key)) {
    throw new Error('No se obtuvo una referencia válida de foto para esta ficha.');
  }
  return { id: Number(value.id), r2Key: value.r2_key };
}
export function safePhotoReadURL(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Foto no disponible. Actualiza la biblioteca para renovar el acceso.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('La referencia de acceso a la foto no es segura. Actualiza la biblioteca.');
  }
  return url.href;
}
export function validateProposal(
  proposal: SkinProposal, photo: PhotoReference | null, source: ReviewedSkinMark['source'],
): ReviewedSkinMark {
  if (!photo || !Number.isInteger(photo.id) || photo.id <= 0 || !photo.r2Key ||
    !validProposal(proposal)) throw new Error('Guarda primero la foto y revisa los datos de la región.');
  return {
    id: `skin-photo:${source.analysisId}:${proposal.id}`, category: proposal.category,
    label: proposal.label.trim(), note: proposal.note,
    coordinateSpace: 'clinical-photo-2d', reviewVersion: 1,
    photo: { ...photo }, normalizedBox: { ...proposal.box }, reviewStatus: 'validated',
    reviewedAt: new Date().toISOString(), source: structuredClone(source),
  };
}

/** Abort alone is insufficient: canvas work and already-resolved responses can finish late. */
export class SkinRequestScope {
  private version = 0;
  private controller: AbortController | null = null;
  cancel() { this.version++; this.controller?.abort(); this.controller = null; }
  start() {
    this.cancel();
    const version = this.version;
    this.controller = new AbortController();
    return { signal: this.controller.signal, current: () => version === this.version };
  }
}

// Inspect JPEG/PNG dimensions before decoding to avoid oversized bitmap allocations.
export function skinImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 &&
    bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  throw new Error('Usa una foto JPEG o PNG válida.');
}
export async function prepareSkinPhoto(file: Blob, signal: AbortSignal): Promise<PreparedSkinPhoto> {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('Usa JPEG o PNG de hasta 12 MB.');
  }
  const dimensions = skinImageDimensions(new Uint8Array(await file.arrayBuffer()));
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 24_000_000 ||
    Math.max(dimensions.width, dimensions.height) > 16000) {
    throw new Error('La foto supera 24 megapíxeles o sus dimensiones no son válidas. Reduce la imagen.');
  }
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar la foto en este navegador.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.88, 0.76, 0.64, 0.5]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      signal.throwIfAborted();
      if (blob && blob.size <= 1_500_000) {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('No se pudo leer la foto.'));
          reader.readAsDataURL(blob);
        });
        signal.throwIfAborted();
        return { blob, base64, width: canvas.width, height: canvas.height };
      }
    }
    throw new Error('No se pudo reducir la foto a 1,5 MB. Prueba otra imagen.');
  } finally { bitmap.close(); }
}
