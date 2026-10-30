import { importInjectable, type ElemKind, type Meta, type SimMode, type Vec3 } from './engine';
import { validateQuickRecord, type QuickRecordSettings } from './quickRecord';
import type { AnatomyPlane } from './defaultLayers';

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const modes: SimMode[] = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];
const kinds: ElemKind[] = ['point', 'line', 'arrow', 'free', 'pattern', 'circle', 'rect'];
const planes: AnatomyPlane[] = ['skin', 'muscle', 'vessels', 'bone'];

/** Extensión local opcional. Inyectables sigue recibiendo su mapping_data habitual. */
export function importLocalRecord(text: string, zones: string[]) {
  const parsed: unknown = JSON.parse(text), root = object(parsed);
  const rawMapping = root?.mapping_data ?? parsed;
  const mapping = object(typeof rawMapping === 'string' ? JSON.parse(rawMapping) : rawMapping);
  if (!mapping && !Array.isArray(rawMapping)) throw new Error('El registro no contiene un mapa válido.');
  const result = importInjectable(parsed, zones);
  const extension = object(mapping?.lab);
  const stored = extension?.version === 1 ? object(extension.meta) : null;
  const storedKinds = extension?.version === 1 ? object(extension.kinds) : null;
  const storedCenters = extension?.version === 1 ? object(extension.centers) : null;
  const storedPlanes = extension?.version === 1 ? object(extension.illustrativePlanes) : null;
  const quickRecord = extension?.quickRecord === undefined ? undefined : validateQuickRecord(extension.quickRecord);
  const restoredKinds: Record<string, ElemKind> = {};
  const restoredCenters: Record<string, Vec3> = {};
  const illustrativePlanes: Record<string, AnatomyPlane> = {};
  const restoredIds = new Map<string, string>();
  const groups = { p: mapping?.injectionPoints, l: mapping?.freehandLines, s: mapping?.surfaceShapes };
  for (const id of Object.keys(result.meta)) {
    const match = /-([pls])(\d+)$/.exec(id);
    if (!match) continue;
    const group = groups[match[1] as keyof typeof groups];
    const original = Array.isArray(group) ? object(group[Number(match[2])]) : null;
    if (typeof original?.id === 'string') restoredIds.set(original.id, id);
    const value = typeof original?.id === 'string' ? object(stored?.[original.id]) : null;
    const kind = typeof original?.id === 'string' ? storedKinds?.[original.id] : undefined;
    if (kinds.includes(kind as ElemKind)) restoredKinds[id] = kind as ElemKind;
    const plane = typeof original?.id === 'string' ? storedPlanes?.[original.id] : undefined;
    if (plane !== undefined) {
      if (!planes.includes(plane as AnatomyPlane)) throw new Error('La capa ilustrativa registrada es inválida.');
      illustrativePlanes[id] = plane as AnatomyPlane;
    }
    const center = typeof original?.id === 'string' ? storedCenters?.[original.id] : undefined;
    if (center !== undefined) {
      const point = object(center);
      if (!point || !['x', 'y', 'z'].every(axis => typeof point[axis] === 'number' && Number.isFinite(point[axis]))) {
        throw new Error('El centro del contorno local es inválido.');
      }
      restoredCenters[id] = { x: point.x, y: point.y, z: point.z } as Vec3;
    }
    if (!value) continue;
    if (!modes.includes(value.mode as SimMode) || typeof value.dose !== 'number'
      || !Number.isFinite(value.dose) || value.dose < 0 || typeof value.zone !== 'string'
      || value.product !== undefined && typeof value.product !== 'string'
      || value.plane !== undefined && typeof value.plane !== 'string'
      || value.entry !== undefined && typeof value.entry !== 'boolean'
      || value.technique !== undefined && typeof value.technique !== 'string'
      || value.parent !== undefined && typeof value.parent !== 'string'
      || value.tip !== undefined && (!Number.isInteger(value.tip) || Number(value.tip) < 0)
      || value.graphicOnly !== undefined && typeof value.graphicOnly !== 'boolean'
      || value.strokeColor !== undefined && (typeof value.strokeColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.strokeColor))
      || value.strokeWidth !== undefined && (typeof value.strokeWidth !== 'number' || !Number.isFinite(value.strokeWidth) || value.strokeWidth < 1 || value.strokeWidth > 10)
      || value.annotationText !== undefined && (typeof value.annotationText !== 'string' || value.annotationText.length > 120)
      || value.annotationKind !== undefined && !['ellipse', 'text', 'ruler'].includes(String(value.annotationKind))) {
      throw new Error('Los metadatos locales son inválidos; no se ha importado el registro.');
    }
    result.meta[id] = { mode: value.mode, dose: value.dose, zone: value.zone, product: value.product,
      ...(value.plane ? { plane: value.plane } : {}),
      ...(value.entry ? { entry: true } : {}), ...(value.technique ? { technique: value.technique } : {}),
      ...(value.graphicOnly ? { graphicOnly: true } : {}),
      ...(value.strokeColor ? { strokeColor: value.strokeColor } : {}),
      ...(value.strokeWidth ? { strokeWidth: value.strokeWidth } : {}),
      ...(value.annotationText ? { annotationText: value.annotationText } : {}),
      ...(value.annotationKind ? { annotationKind: value.annotationKind } : {}),
      ...(value.parent ? { parent: value.parent, tip: value.tip ?? 0 } : {}) } as Meta;
  }
  for (const [id, item] of Object.entries(result.meta)) {
    if (item.parent) {
      const parent = restoredIds.get(item.parent);
      if (!parent || !result.meta[parent]) throw new Error('Una punta no tiene su trazo asociado. No se ha importado el registro.');
      result.meta[id] = { ...item, parent };
    }
    if (item.graphicOnly) {
      result.meta[id] = { ...result.meta[id], graphicOnly: true, dose: 0, plane: undefined, entry: undefined };
    }
  }
  return { ...result, kinds: restoredKinds, centers: restoredCenters, quickRecord, illustrativePlanes };
}

export function localRecord(
  markers: readonly { id?: string }[], lines: readonly { id: string }[], shapes: readonly { id: string }[],
  meta: Record<string, Meta>, annotationKinds: Record<string, ElemKind> = {}, centers: Record<string, Vec3> = {},
  quickRecord?: QuickRecordSettings,
  illustrativePlanes: Record<string, AnatomyPlane> = {},
) {
  const withDose = <T extends { id?: string }>(item: T) => ({ ...item,
    units: meta[item.id ?? '']?.dose, label: meta[item.id ?? '']?.zone,
    ...(meta[item.id ?? '']?.plane ? { plane: meta[item.id ?? '']!.plane } : {}) });
  return { mapping_data: {
    injectionPoints: markers.map(withDose), freehandLines: lines.map(withDose), surfaceShapes: shapes.map(withDose),
    lab: { version: 1, meta, kinds: annotationKinds, centers, illustrativePlanes,
      ...(quickRecord ? { quickRecord: validateQuickRecord(quickRecord) } : {}) },
  } };
}
