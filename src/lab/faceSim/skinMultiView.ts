import { applyRegistration, fitAffineRegistration, fitHairPhotoProjection, type P2, type PersonalSurface } from './engine.ts';
import { locatePhotoPoint, surfacePoint } from './faceTransfer.ts';
import atlas from './genericFaceAtlas.json' with { type: 'json' };
import type { SkinVisualCandidate } from './skinAppearance.ts';
import { isValidSkinPolygon } from './skinRegionReview.ts';
import type { SkinScanSummary } from './skinAutoScan.ts';

export interface SkinPhotoSource {
  id: string;
  label: string;
  canvas: HTMLCanvasElement;
  group: 'front' | 'a' | 'b' | 'extra';
  confirmed: boolean;
  landmarks?: readonly P2[];
  mapping?: SkinPhotoMapping;
}
export interface SkinPhotoMapping {
  landmarks: readonly P2[];
  direction: readonly number[];
  manual: boolean;
}

/** La transferencia de puntos no depende de aprobar una foto como textura lateral. */
export function detectedSkinMapping(surface: PersonalSurface, landmarks: readonly P2[]): SkinPhotoMapping | undefined {
  const references = Array.from({ length: 468 }, (_, i) => i).filter(i =>
    surface.positions[i * 3 + 1] <= surface.positions[9 * 3 + 1]);
  const fit = fitHairPhotoProjection(surface.positions, landmarks, references);
  if (!fit || fit.error > .045) return undefined;
  return { landmarks, direction: fit.projection.towardCamera, manual: false };
}
export interface SkinPhotoResult {
  sourceId: string;
  candidates: SkinVisualCandidate[];
  score: number;
  usable: boolean;
  reason: string;
  milliseconds: number;
  scan?: SkinScanSummary;
}
export interface SkinMappedCandidate {
  id: string;
  candidate: SkinVisualCandidate;
  sourceId: string;
  point: { x: number; y: number; z: number };
  observations: string[];
  observationIds: string[];
  label: string;
  manual: boolean;
}

export function replaceSkinFocusCandidates(previous: readonly SkinVisualCandidate[], next: readonly SkinVisualCandidate[], rectangle: readonly P2[]) {
  if (!isValidSkinPolygon(rectangle)) throw new Error('La zona de búsqueda no es válida.');
  const left = Math.min(...rectangle.map(p => p.x)), right = Math.max(...rectangle.map(p => p.x));
  const top = Math.min(...rectangle.map(p => p.y)), bottom = Math.max(...rectangle.map(p => p.y));
  const outside = previous.filter(candidate => {
    const x = candidate.x + candidate.width / 2, y = candidate.y + candidate.height / 2;
    return x < left || x > right || y < top || y > bottom;
  });
  if (outside.length + next.length > 112) throw new Error('Esta foto alcanzó el límite de revisión. Usa Analizar fotos para reiniciar antes de buscar más zonas; se conserva el resultado anterior.');
  return { outside, candidates: [...outside, ...next] };
}

export const PROFILE_SKIN_ANCHORS = [
  { index: 168, label: 'Raíz de la nariz' },
  { index: 1, label: 'Punta de la nariz' },
  { index: 2, label: 'Base de la nariz' },
  { index: 0, label: 'Centro del labio superior' },
  { index: 17, label: 'Centro del labio inferior' },
  { index: 152, label: 'Punta del mentón' },
] as const;

/** Perfil puro: registro de su plano Z/Y, no reconstrucción de la hemicara oculta. */
export function alignSkinProfile(
  surface: PersonalSurface, anchors: readonly P2[], aspect: number, side: -1 | 1,
): SkinPhotoMapping {
  if (anchors.length !== PROFILE_SKIN_ANCHORS.length || anchors.some(p =>
    !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) {
    throw new Error('Marca los seis puntos sobre la fotografía.');
  }
  const height = Math.abs(surface.positions[10 * 3 + 1] - surface.positions[152 * 3 + 1]);
  if (!(height > 0) || surface.positions.length < 468 * 3) throw new Error('La máscara no tiene referencias de perfil utilizables.');
  const chart = Array.from({ length: 468 }, (_, i) => ({
    x: surface.positions[i * 3 + 2] / height,
    y: -surface.positions[i * 3 + 1] / height,
  }));
  const photoHeight = Math.hypot((anchors[0].x - anchors[5].x) * aspect, anchors[0].y - anchors[5].y);
  const fit = fitAffineRegistration(PROFILE_SKIN_ANCHORS.map(p => chart[p.index]), [...anchors], aspect, photoHeight, false);
  if (!fit || fit.rmse > 0.045 || fit.maxError > 0.09) {
    throw new Error('Los puntos no concuerdan con un perfil puro. Revisa su posición; para una toma oblicua usa la detección automática.');
  }
  return { landmarks: chart.map(point => applyRegistration(point, fit)), direction: [side, 0, 0], manual: true };
}

export function skinPolygonMask(width: number, height: number, polygons: readonly (readonly P2[])[]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1400 || height > 1400
    || polygons.length > 8 || polygons.some(p => !isValidSkinPolygon(p))) throw new Error('Delimita áreas de piel válidas, sin cruzar el trazado.');
  const mask = new Uint8Array(width * height);
  for (const polygon of polygons) {
    for (let y = 0; y < height; y++) {
      const scanY = (y + 0.5) / height, crossings: number[] = [];
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > scanY) !== (b.y > scanY)) crossings.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y));
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const start = Math.max(0, Math.ceil(crossings[i] * width - 0.5));
        const end = Math.min(width, Math.ceil(crossings[i + 1] * width - 0.5));
        for (let x = start; x < end; x++) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/** Calidad fotográfica relativa, no probabilidad de diagnóstico ni gravedad. */
export function skinPhotoQuality(image: { width: number; height: number; data: Uint8ClampedArray }, mask: Uint8Array): number {
  const { width, height, data } = image;
  if (mask.length !== width * height || data.length !== width * height * 4) throw new Error('Imagen o área de piel incompatible.');
  let count = 0, valid = 0, detail = 0;
  const light = (i: number) => data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (!mask[i]) continue;
    count++;
    const value = light(i);
    if (value > 30 && value < 235 && data[i * 4 + 3] === 255) valid++;
    if (mask[i - 1] && mask[i + 1]) detail += Math.min(20, Math.abs(light(i - 1) - 2 * value + light(i + 1)));
  }
  return count < 64 ? 0 : valid / count * 0.8 + Math.min(1, detail / count / 4) * 0.2;
}

/** Una por vista cuando está disponible; completa hasta tres con las restantes de mejor calidad. */
export function selectSkinPhotos(sources: readonly SkinPhotoSource[], results: readonly SkinPhotoResult[]): string[] {
  const eligible = results.filter(r => r.usable && sources.some(s => s.id === r.sourceId && s.confirmed))
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
  const selected: string[] = [];
  for (const group of ['front', 'a', 'b'] as const) {
    const next = eligible.find(r => sources.find(s => s.id === r.sourceId)?.group === group);
    if (next) selected.push(next.sourceId);
  }
  for (const result of eligible) if (selected.length < 3 && !selected.includes(result.sourceId)) selected.push(result.sourceId);
  return selected;
}

export function mapSkinCandidate(
  sourceId: string, candidate: SkinVisualCandidate, mapping: SkinPhotoMapping, surface: PersonalSurface,
): SkinMappedCandidate | null {
  if (mapping.landmarks.length < 468 || mapping.direction.length !== 3 || !mapping.direction.every(Number.isFinite)) return null;
  const visibleTriangles = Array.from({ length: atlas.triangles.length / 3 }, (_, triangle) => {
    const ids = atlas.triangles.slice(triangle * 3, triangle * 3 + 3);
    const [a, b, c] = ids.map(id => Array.from(surface.positions.slice(id * 3, id * 3 + 3)));
    const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const norm = Math.hypot(...normal) * Math.hypot(...mapping.direction);
    return norm > 0 && normal.reduce((sum, value, i) => sum + value * mapping.direction[i], 0) / norm > 0.12;
  });
  const address = locatePhotoPoint({ x: candidate.x + candidate.width / 2, y: candidate.y + candidate.height / 2 },
    mapping.landmarks, atlas, { visibleTriangles });
  const point = address && surfacePoint(address, surface, atlas);
  if (!point) return null;
  const id = `${sourceId}/${candidate.id}`;
  return { id, sourceId, candidate, point, observations: [sourceId], observationIds: [id], label: sourceId, manual: mapping.manual };
}

export function mergeSkinObservations(candidates: readonly SkinMappedCandidate[], height: number): SkinMappedCandidate[] {
  const result: SkinMappedCandidate[] = [];
  for (const candidate of candidates) {
    const same = result.find(other => other.sourceId !== candidate.sourceId && other.candidate.channel === candidate.candidate.channel
      && Math.hypot(other.point.x - candidate.point.x, other.point.y - candidate.point.y, other.point.z - candidate.point.z) < height * 0.012);
    if (same) {
      same.observations = [...new Set([...same.observations, ...candidate.observations])];
      same.observationIds = [...new Set([...same.observationIds, ...candidate.observationIds])];
      same.manual ||= candidate.manual;
    } else result.push({ ...candidate, observations: [...candidate.observations], observationIds: [...candidate.observationIds] });
  }
  return result;
}
