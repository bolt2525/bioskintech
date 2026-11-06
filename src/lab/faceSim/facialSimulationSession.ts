import type { AffineRegistration, DepthDiagnostic, FaceFrame, PersonalProjection, PersonalSurface, Vec3 } from './engine';
import type { EstimatedHeadSurface } from './estimatedHead';
import type { HairPhotoProjection } from './estimatedHair';
import type { PhotoSurfacePatch } from './multiViewHead';
import type { PhotoReference, SkinContext } from '../../components/admin/ficha-clinica/components/skinVisualAI';
import type { EvaluationMark } from '../../components/admin/ficha-clinica/components/skinEvaluation';
import type { Mark } from '../../components/admin/ficha-clinica/components/FaceMapCanvas';
import atlas from './genericFaceAtlas.json' with { type: 'json' };

export type SimulationPhotoSlot = 'frontal' | 'izquierda' | 'derecha' | 'extra_a' | 'extra_b';
export const SIMULATION_PHOTO_SLOTS: readonly SimulationPhotoSlot[] = ['frontal', 'izquierda', 'derecha', 'extra_a', 'extra_b'];
export interface CaptureAlignment {
  frame: FaceFrame;
  landmarks?: { x: number; y: number; z: number }[];
  detectedLandmarks?: { x: number; y: number; z: number }[];
  contourAdjusted?: number;
  pose?: number[];
  detectionError?: string;
  detectionRecovered?: boolean;
  captureWarnings?: string[];
  captureConfirmed?: boolean;
  foreheadReviewed?: boolean;
  modelAnchors?: Vec3[];
  registration?: AffineRegistration;
  registrationFlip?: boolean;
  registrationSource?: 'auto' | 'manual';
}
export interface StoredSurface {
  positions: number[]; uvs: number[]; indices: number[]; projection: PersonalProjection;
  observedIndexCount?: number; observedVertexCount?: number; preservedOpenings?: number;
  inferredColor?: string; inferredSkinColor?: string;
}
export interface StoredPhotoPatch {
  slot: SimulationPhotoSlot;
  projection: HairPhotoProjection;
  indices: number[]; uvs: number[];
  blendIndices?: number[]; alpha?: number[];
}
export interface StoredMaskGeometry {
  surface: StoredSurface; renderSurface: StoredSurface; glbBase64: string;
}
export interface StoredMask extends StoredMaskGeometry {
  view: 'frontal' | 'izquierda' | 'derecha';
  depth: number; depthDetails: string;
  diagnostics: (DepthDiagnostic & { label: string })[];
  closedHead: boolean;
  photoPatches?: StoredPhotoPatch[];
  base?: StoredMaskGeometry;
}
export interface FacialSimulationState {
  version: 1;
  atlas: { modelId: string; version: 1; glbSha256: string };
  photos: { slot: SimulationPhotoSlot; photo: PhotoReference; alignment: CaptureAlignment }[];
  mask?: StoredMask;
  marks: EvaluationMark[];
}
export interface FaceSimController {
  getPhotos(): { id: string; canvas: HTMLCanvasElement; original?: File }[];
  getMarks(): EvaluationMark[];
  snapshot(references: Record<string, PhotoReference>): Promise<FacialSimulationState>;
  restore(state: FacialSimulationState, photos: Record<string, HTMLCanvasElement>, originals?: Record<string, Blob>): Promise<void>;
  importPhoto(file: File, slot: SimulationPhotoSlot): Promise<void>;
  reset(): void;
}
export interface FaceSimIntegration {
  mode?: 'simulation' | 'skin-exam';
  recordId?: number;
  context?: SkinContext;
  onController: (controller: FaceSimController | null) => void;
  onDirty: () => void;
  initialMarks?: EvaluationMark[];
  onMarksChange?: (marks: EvaluationMark[]) => void;
  legacyMigration?: { examId: number; marks: readonly Mark[] };
}

export function storeSurface(surface: PersonalSurface | EstimatedHeadSurface): StoredSurface {
  return {
    positions: Array.from(surface.positions), uvs: Array.from(surface.uvs), indices: Array.from(surface.indices),
    projection: { ...surface.projection },
    ...('observedIndexCount' in surface ? {
      observedIndexCount: surface.observedIndexCount, observedVertexCount: surface.observedVertexCount,
      preservedOpenings: surface.preservedOpenings, inferredColor: surface.inferredColor, inferredSkinColor: surface.inferredSkinColor,
    } : {}),
  };
}
export function restoreSurface(surface: StoredSurface): PersonalSurface | EstimatedHeadSurface {
  const { positions, uvs, indices, projection } = surface;
  if (!Array.isArray(positions) || positions.length < 468 * 3 || positions.length > 300_000 ||
      positions.length % 3 || !positions.every(n => Number.isFinite(n) && Math.abs(n) < 1000) ||
      !Array.isArray(uvs) || uvs.length !== positions.length / 3 * 2 || !uvs.every(Number.isFinite) ||
      !Array.isArray(indices) || indices.length > 900_000 || indices.length % 3 ||
      !indices.every(n => Number.isInteger(n) && n >= 0 && n < positions.length / 3) ||
      !projection || ![projection.cx, projection.cy, projection.k, projection.aspect].every(Number.isFinite) ||
      projection.k <= 0 || projection.aspect <= 0) throw new Error('La superficie guardada no es válida.');
  const base: PersonalSurface = { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices), projection: { ...projection } };
  if (surface.observedIndexCount === undefined) return base;
  if (!Number.isInteger(surface.observedIndexCount) || surface.observedIndexCount < 0 ||
      surface.observedIndexCount > indices.length || surface.observedIndexCount % 3 ||
      !Number.isInteger(surface.preservedOpenings)) throw new Error('La cobertura guardada no es válida.');
  return { ...base, observedIndexCount: surface.observedIndexCount, preservedOpenings: surface.preservedOpenings!,
    observedVertexCount: surface.observedVertexCount, inferredColor: surface.inferredColor, inferredSkinColor: surface.inferredSkinColor };
}
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}
export function base64ToBuffer(encoded: string): ArrayBuffer {
  if (typeof encoded !== 'string' || encoded.length > 5_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error('El GLB guardado no es válido.');
  const decoded = atob(encoded), bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  if (bytes.length < 12 || new DataView(bytes.buffer).getUint32(0, true) !== 0x46546c67 ||
      new DataView(bytes.buffer).getUint32(4, true) !== 2 ||
      new DataView(bytes.buffer).getUint32(8, true) !== bytes.length) throw new Error('El GLB guardado está incompleto.');
  return bytes.buffer;
}
export function storePhotoPatches(
  patches: readonly PhotoSurfacePatch[] | undefined,
  captures: Partial<Record<SimulationPhotoSlot, { canvas: HTMLCanvasElement }>>,
): StoredPhotoPatch[] | undefined {
  return patches?.map(patch => {
    const slot = SIMULATION_PHOTO_SLOTS.find(slot => captures[slot]?.canvas === patch.source.texture) ??
      SIMULATION_PHOTO_SLOTS.find(slot => ({ frontal: 'Frontal', izquierda: 'Ángulo A', derecha: 'Ángulo B',
        extra_a: 'Foto 4', extra_b: 'Foto 5' })[slot] === patch.source.label);
    if (!slot || !captures[slot]) throw new Error('Una textura no está vinculada a sus capturas originales.');
    return { slot, projection: structuredClone(patch.source.projection), indices: Array.from(patch.indices),
      uvs: Array.from(patch.uvs), blendIndices: patch.blendIndices && Array.from(patch.blendIndices),
      alpha: patch.alpha && Array.from(patch.alpha) };
  });
}
export function restorePhotoPatches(patches: StoredPhotoPatch[] | undefined, photos: Record<string, HTMLCanvasElement>): PhotoSurfacePatch[] | undefined {
  return patches?.map(patch => {
    const texture = photos[patch.slot];
    if (!texture || !patch.projection || ![...patch.projection.u, ...patch.projection.v, ...patch.projection.towardCamera].every(Number.isFinite))
      throw new Error('Falta una fotografía o su alineación multivista.');
    return { source: { label: patch.slot, width: texture.width, height: texture.height,
      texture, projection: structuredClone(patch.projection), mask: new Float32Array(0) },
      indices: Uint32Array.from(patch.indices), uvs: Float32Array.from(patch.uvs),
      blendIndices: patch.blendIndices && Uint32Array.from(patch.blendIndices),
      alpha: patch.alpha && Float32Array.from(patch.alpha) };
  });
}
export function assertSessionAtlas(state: FacialSimulationState): void {
  if (state.version !== 1 || state.atlas?.modelId !== atlas.modelId || state.atlas.version !== 1 ||
      state.atlas.glbSha256 !== atlas.provenance.glbSha256 ||
      !Array.isArray(state.photos) || state.photos.length > 5 ||
      new Set(state.photos.map(photo => photo.slot)).size !== state.photos.length ||
      state.photos.some(photo => !SIMULATION_PHOTO_SLOTS.includes(photo.slot)) || !Array.isArray(state.marks))
    throw new Error('La sesión pertenece a otra versión del atlas. No se moverán las marcas.');
}
