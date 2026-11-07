import { locatePhotoPoint, photoPoint, modelPoint, surfacePoint, genericFaceAtlas } from '../../../../lab/faceSim/faceTransfer.ts';
import type { FaceAddress, PersonalSurface } from '../../../../lab/faceSim/faceTransfer';
import type { SkinPhotoSource } from '../../../../lab/faceSim/skinMultiView';
import { mapSkinCandidate } from '../../../../lab/faceSim/skinMultiView.ts';
import { parseSkinReview, validBox } from './skinVisualAI.ts';
import type { NormalizedBox, PhotoReference, ReviewedSkinMark, SkinContext } from './skinVisualAI';
import type { EditablePoint } from './Clinical3DViewer';
import { COLORS } from '../../../../constants/theme.ts';

export type EvaluationAnchor = FaceAddress & { version: 1 };
export type EvaluationOriginalSource = { provider: 'manual' } | ReviewedSkinMark['source'];
export type EvaluationSource = EvaluationOriginalSource | { provider: 'edited'; original: EvaluationOriginalSource };
export interface EvaluationObservation { sourceId: string; box: NormalizedBox }
export interface EvaluationMark {
  id: string;
  sourceId: string;
  category: string;
  label: string;
  note: string;
  box: NormalizedBox;
  status: 'pending' | 'validated';
  source: EvaluationSource;
  reviewedAt?: string;
  anchor?: EvaluationAnchor;
  observations?: EvaluationObservation[];
  crop?: { box: NormalizedBox; sourceWidth: number; sourceHeight: number };
}
export interface PersistedSkinMark {
  id: string; category: string; label: string; note: string;
  coordinateSpace: 'clinical-photo-2d'; reviewVersion: 2;
  photo: PhotoReference; normalizedBox: NormalizedBox;
  reviewStatus: 'validated'; reviewedAt: string;
  source: EvaluationSource;
  anchor?: EvaluationAnchor;
  observations?: { photo: PhotoReference; normalizedBox: NormalizedBox }[];
  crop?: { originalPhoto: PhotoReference; normalizedBox: NormalizedBox; sourceWidth: number; sourceHeight: number };
}
export interface PersistedSkinReview { version: 2; annotations: PersistedSkinMark[]; simulationId?: number }
export function skinSimulationId(review: unknown): number | undefined {
  let data = review;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return undefined; } }
  if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 2 || !('simulationId' in data)) return;
  return typeof data.simulationId === 'number' && Number.isInteger(data.simulationId) && data.simulationId > 0 ? data.simulationId : undefined;
}

export function isZonalSkinMark(box: NormalizedBox): boolean {
  return box.width > .06 || box.height > .06;
}

/** Resumen visual; el texto íntegro permanece en la lista y el nombre accesible. */
export function skinMarkLabel(label: string): string {
  const text = label.trim();
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

export function resizeSkinBox(box: NormalizedBox, width: number, height = width): NormalizedBox {
  const w = Math.max(.01, Math.min(1, width)), h = Math.max(.01, Math.min(1, height));
  return { x: Math.max(0, Math.min(1 - w, box.x + box.width / 2 - w / 2)),
    y: Math.max(0, Math.min(1 - h, box.y + box.height / 2 - h / 2)), width: w, height: h };
}

/** Proyección de presentación: nunca crea ni modifica marcaciones legacy. */
const displayCache = {
  mask: new WeakMap<PersonalSurface, WeakMap<EvaluationMark, { sources: readonly SkinPhotoSource[]; points: EditablePoint[] }>>(),
  reference: new WeakMap<PersonalSurface, WeakMap<EvaluationMark, { sources: readonly SkinPhotoSource[]; points: EditablePoint[] }>>(),
};
export function skinDisplayPoints(marks: readonly EvaluationMark[], sources: readonly SkinPhotoSource[], surface: PersonalSurface,
  target: 'mask' | 'reference' = 'mask'): EditablePoint[] {
  let cache = displayCache[target].get(surface);
  if (!cache) { cache = new WeakMap(); displayCache[target].set(surface, cache); }
  const project = (anchor: EvaluationAnchor) => target === 'reference' ? modelPoint(anchor) : surfacePoint(anchor, surface);
  return marks.flatMap(mark => {
    const cached = cache.get(mark);
    if (cached?.sources === sources) return cached.points;
    const position = mark.anchor && project(mark.anchor);
    if (!position) return [];
    const photo = sources.find(item => item.id === mark.sourceId);
    const area = photo && isZonalSkinMark(mark.box) ? [
      [mark.box.x, mark.box.y + mark.box.height / 2], [mark.box.x + mark.box.width, mark.box.y + mark.box.height / 2],
      [mark.box.x + mark.box.width / 2, mark.box.y], [mark.box.x + mark.box.width / 2, mark.box.y + mark.box.height],
    ].flatMap(([x, y]) => {
      if (x < .001 || x > .999 || y < .001 || y > .999) return [];
      const anchor = anchorForPhoto({ x: x - .001, y: y - .001, width: .002, height: .002 }, photo, surface);
      const point = anchor && project(anchor);
      return point ? [point] : [];
    }) : [];
    const positions = target === 'reference' ? genericFaceAtlas.positions : surface.positions;
    const vertices = genericFaceAtlas.triangles.slice(mark.anchor!.triangle * 3, mark.anchor!.triangle * 3 + 3)
      .map(id => Array.from(positions.slice(id * 3, id * 3 + 3)));
    const a = vertices[1].map((n, i) => n - vertices[0][i]), b = vertices[2].map((n, i) => n - vertices[0][i]);
    const normal = { x: a[1] * b[2] - a[2] * b[1], y: a[2] * b[0] - a[0] * b[2], z: a[0] * b[1] - a[1] * b[0] };
    const length = Math.hypot(normal.x, normal.y, normal.z);
    const points: EditablePoint[] = [{ id: mark.id, type: 'free' as const, lineIds: [], ...position, size: isZonalSkinMark(mark.box) ? 1 : mark.box.width / .04,
      color: mark.status === 'validated' ? COLORS.skinValidated : COLORS.skinPending,
      name: mark.label,
      ...(area.length === 4 && length > 0 ? { area: { radius: Math.max(...area.map(q =>
        Math.hypot(q.x - position.x, q.y - position.y, q.z - position.z))),
      normal: { x: normal.x / length, y: normal.y / length, z: normal.z / length } } } : {}) }];
    cache.set(mark, { sources, points });
    return points;
  });
}

const visibility = new WeakMap<PersonalSurface, WeakMap<SkinPhotoSource, boolean[]>>();
export function skinRequestContext(context: SkinContext): SkinContext {
  const result: SkinContext = {};
  for (const key of ['skinType', 'phototype', 'hydration'] as const) {
    const value = context[key]?.trim();
    if (!value) continue;
    if (value.length > 40 || !/^[\p{L}\p{N} ()/-]+$/u.test(value)) {
      throw new Error('El contexto manual contiene caracteres no admitidos o supera 40 caracteres.');
    }
    result[key] = value;
  }
  return result;
}

export function cropToOriginal(box: NormalizedBox, crop: NormalizedBox): NormalizedBox {
  if (!validBox(box) || !validBox(crop)) throw new Error('El recorte o la región no son válidos.');
  return { x: crop.x + box.x * crop.width, y: crop.y + box.y * crop.height,
    width: box.width * crop.width, height: box.height * crop.height };
}

export function visibleSkinTriangles(source: SkinPhotoSource, surface: PersonalSurface): boolean[] {
  const direction = source.mapping?.direction;
  if (!direction || direction.length !== 3 || !direction.every(Number.isFinite)) return [];
  let sources = visibility.get(surface);
  if (!sources) { sources = new WeakMap(); visibility.set(surface, sources); }
  const cached = sources.get(source);
  if (cached) return cached;
  const result = Array.from({ length: genericFaceAtlas.triangles.length / 3 }, (_, triangle) => {
    const ids = genericFaceAtlas.triangles.slice(triangle * 3, triangle * 3 + 3);
    if (ids.some((id, i) => surface.indices[triangle * 3 + i] !== id)) return false;
    const [a, b, c] = ids.map(id => Array.from(surface.positions.slice(id * 3, id * 3 + 3)));
    if ([a, b, c].some(p => p.length !== 3 || !p.every(Number.isFinite))) return false;
    const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) * Math.hypot(...direction);
    return length > 0 && normal.reduce((sum, n, i) => sum + n * direction[i], 0) / length > 0.12;
  });
  sources.set(source, result);
  return result;
}

export function anchorForPhoto(box: NormalizedBox, source: SkinPhotoSource, surface?: PersonalSurface): EvaluationAnchor | undefined {
  if (!surface || !source.confirmed || !source.mapping || !validBox(box)) return undefined;
  if (!mapSkinCandidate(source.id, { id: 'selection', channel: 'contrast', ...box }, source.mapping, surface)) return undefined;
  const address = locatePhotoPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 },
    source.mapping.landmarks, genericFaceAtlas, { visibleTriangles: visibleSkinTriangles(source, surface) });
  return address && surfacePoint(address, surface) ? { version: 1, ...address } : undefined;
}

export function photoForAnchor(anchor: EvaluationAnchor, source: SkinPhotoSource, surface?: PersonalSurface) {
  if (!surface || !source.confirmed || !source.mapping || !visibleSkinTriangles(source, surface)[anchor.triangle] || !surfacePoint(anchor, surface)) return null;
  const point = photoPoint(anchor, source.mapping.landmarks);
  if (!point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const round = locatePhotoPoint(point, source.mapping.landmarks, genericFaceAtlas,
    { visibleTriangles: visibleSkinTriangles(source, surface) });
  if (!round || round.triangle !== anchor.triangle) return null;
  return point;
}

export function bestPhotoForAnchor(anchor: EvaluationAnchor, sources: readonly SkinPhotoSource[], surface?: PersonalSurface) {
  const score = (source: SkinPhotoSource) => {
    if (!surface || !source.mapping) return 0;
    const ids = genericFaceAtlas.triangles.slice(anchor.triangle * 3, anchor.triangle * 3 + 3);
    const [a, b, c] = ids.map(id => Array.from(surface.positions.slice(id * 3, id * 3 + 3)));
    if ([a, b, c].some(p => p.length !== 3)) return 0;
    const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const d = source.mapping.direction, magnitude = Math.hypot(...normal) * Math.hypot(...d);
    const facing = magnitude ? normal.reduce((sum, n, i) => sum + n * d[i], 0) / magnitude : 0;
    const [p, q, r] = ids.map(id => source.mapping!.landmarks[id]);
    if (!p || !q || !r) return 0;
    const area = Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return facing * Math.sqrt(area * source.canvas.width * source.canvas.height);
  };
  return sources.filter(s => s.confirmed && photoForAnchor(anchor, s, surface))
    .sort((a, b) => score(b) - score(a) || Number(b.group === 'front') - Number(a.group === 'front') || a.id.localeCompare(b.id))[0];
}

export function validateEvaluationGroup(marks: readonly EvaluationMark[], ids: readonly string[], reviewedAt = new Date().toISOString()): EvaluationMark[] {
  const selected = new Set(ids);
  if (!selected.size || marks.some(m => selected.has(m.id) && (!m.label.trim() || !validBox(m.box)))) {
    throw new Error('Revisa la etiqueta y la región de todas las propuestas seleccionadas.');
  }
  return marks.map(m => selected.has(m.id) ? { ...m, label: m.label.trim(), status: 'validated', reviewedAt } : m);
}

function durable(ref: PhotoReference | undefined): ref is PhotoReference {
  return !!ref && Number.isInteger(ref.id) && ref.id > 0 && typeof ref.r2Key === 'string' &&
    ref.r2Key.startsWith('clinics/') && !/[?#\\\s]/.test(ref.r2Key);
}
export function toPersistedSkinReview(marks: readonly EvaluationMark[], refs: Record<string, PhotoReference>): PersistedSkinReview {
  const annotations: PersistedSkinMark[] = [];
  for (const mark of marks) {
    if (mark.status !== 'validated') continue;
    if (!durable(refs[mark.sourceId])) throw new Error('Falta una foto durable para una región validada.');
    if (!validBox(mark.box) || !mark.label.trim() || !mark.reviewedAt) throw new Error('Hay una región validada con datos incompletos.');
    if (mark.crop && (!validBox(mark.crop.box) || !Number.isInteger(mark.crop.sourceWidth) ||
      !Number.isInteger(mark.crop.sourceHeight) || mark.crop.sourceWidth <= 0 || mark.crop.sourceHeight <= 0)) {
      throw new Error('La evidencia del recorte no es válida.');
    }
    const photo = refs[mark.sourceId];
    const observations = mark.observations?.map(o => {
      if (!durable(refs[o.sourceId]) || !validBox(o.box)) throw new Error('Falta una foto durable o una región multivista válida.');
      return { photo: refs[o.sourceId], normalizedBox: o.box };
    });
    annotations.push({ id: mark.id, category: mark.category, label: mark.label, note: mark.note,
      coordinateSpace: 'clinical-photo-2d', reviewVersion: 2, photo, normalizedBox: mark.box,
      reviewStatus: 'validated', reviewedAt: mark.reviewedAt, source: mark.source,
      ...(mark.anchor ? { anchor: mark.anchor } : {}), ...(observations?.length ? { observations } : {}),
      ...(mark.crop ? { crop: { originalPhoto: photo, normalizedBox: mark.crop.box,
        sourceWidth: mark.crop.sourceWidth, sourceHeight: mark.crop.sourceHeight } } : {}) });
  }
  return { version: 2, annotations };
}

export function fromPersistedSkinReview(data: string | PersistedSkinReview | undefined, refs: Record<string, PhotoReference>): EvaluationMark[] {
  let review: PersistedSkinReview | undefined;
  try { review = typeof data === 'string' ? JSON.parse(data) : data; } catch { return []; }
  if (!review || review.version !== 2 || !Array.isArray(review.annotations)) return [];
  const sourceId = (photo: PhotoReference) => Object.keys(refs).find(id =>
    durable(refs[id]) && refs[id].id === photo?.id && refs[id].r2Key === photo?.r2Key);
  return review.annotations.flatMap(mark => {
    if (!mark || typeof mark !== 'object') return [];
    const id = sourceId(mark.photo);
    if (!id || mark.reviewStatus !== 'validated' || !validBox(mark.normalizedBox) || !mark.id || !mark.label ||
      !mark.source || !['manual', 'google-gemini', 'edited'].includes(mark.source.provider)) return [];
    return [{ id: mark.id, sourceId: id, category: mark.category, label: mark.label, note: mark.note,
      box: mark.normalizedBox, status: 'validated' as const, reviewedAt: mark.reviewedAt, source: mark.source,
      ...(mark.anchor ? { anchor: mark.anchor } : {}),
      ...(mark.crop && validBox(mark.crop.normalizedBox) && Number.isInteger(mark.crop.sourceWidth) && Number.isInteger(mark.crop.sourceHeight)
        ? { crop: { box: mark.crop.normalizedBox, sourceWidth: mark.crop.sourceWidth, sourceHeight: mark.crop.sourceHeight } } : {}),
      ...(mark.observations ? { observations: mark.observations.flatMap(o => {
        const other = sourceId(o.photo);
        return other && validBox(o.normalizedBox) ? [{ sourceId: other, box: o.normalizedBox }] : [];
      }) } : {}) }];
  });
}

/** Migración de lectura v1; una foto sin correspondencia no se atribuye a otra vista. */
export function fromLegacySkinReview(data: Parameters<typeof parseSkinReview>[0], refs: Record<string, PhotoReference>): EvaluationMark[] {
  return parseSkinReview(data).flatMap(mark => {
    const sourceId = Object.keys(refs).find(id => refs[id].id === mark.photo.id && refs[id].r2Key === mark.photo.r2Key);
    return sourceId ? [{ id: mark.id, sourceId, category: mark.category, label: mark.label,
      note: mark.note, box: mark.normalizedBox, status: 'validated' as const,
      reviewedAt: mark.reviewedAt, source: mark.source }] : [];
  });
}

/** Presentación descriptiva, sin exponer claves ni URL de las fotografías. */
export function skinReviewSummaries(data: unknown): { id: string; label: string; note: string; description: string; box?: NormalizedBox }[] {
  let review = data;
  if (typeof review === 'string') { try { review = JSON.parse(review); } catch { return []; } }
  if (!review || typeof review !== 'object' || !('version' in review)) return [];
  if (review.version === 1) return parseSkinReview(review as Parameters<typeof parseSkinReview>[0])
    .map(mark => ({ id: mark.id, label: mark.label, note: mark.note, box: mark.normalizedBox, description: `${mark.label}${mark.note ? ` — ${mark.note}` : ''} · Foto clínica #${mark.photo.id}` }));
  if (review.version !== 2 || !('annotations' in review) || !Array.isArray(review.annotations)) return [];
  return review.annotations.flatMap((mark: unknown) => {
    if (!mark || typeof mark !== 'object' || !('reviewStatus' in mark) || mark.reviewStatus !== 'validated' ||
      !('id' in mark) || typeof mark.id !== 'string' || !('label' in mark) || typeof mark.label !== 'string' ||
      !('note' in mark) || typeof mark.note !== 'string' || !('photo' in mark) || !mark.photo ||
      typeof mark.photo !== 'object' || !('id' in mark.photo) || typeof mark.photo.id !== 'number') return [];
    return [{ id: mark.id, label: mark.label, note: mark.note, ...('normalizedBox' in mark && validBox(mark.normalizedBox) ? { box: mark.normalizedBox } : {}),
      description: `${mark.label}${mark.note ? ` — ${mark.note}` : ''} · Foto clínica #${mark.photo.id}` }];
  });
}
