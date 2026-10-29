import { importInjectable, type ElemKind, type Meta, type SimMode, type Vec3 } from './engine';

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
const modes: SimMode[] = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];
const kinds: ElemKind[] = ['point', 'line', 'arrow', 'free', 'pattern', 'circle', 'rect'];

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
  const restoredKinds: Record<string, ElemKind> = {};
  const restoredCenters: Record<string, Vec3> = {};
  const groups = { p: mapping?.injectionPoints, l: mapping?.freehandLines, s: mapping?.surfaceShapes };
  for (const id of Object.keys(result.meta)) {
    const match = /-([pls])(\d+)$/.exec(id);
    if (!match) continue;
    const group = groups[match[1] as keyof typeof groups];
    const original = Array.isArray(group) ? object(group[Number(match[2])]) : null;
    const value = typeof original?.id === 'string' ? object(stored?.[original.id]) : null;
    const kind = typeof original?.id === 'string' ? storedKinds?.[original.id] : undefined;
    if (kinds.includes(kind as ElemKind)) restoredKinds[id] = kind as ElemKind;
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
      || value.product !== undefined && typeof value.product !== 'string') {
      throw new Error('Los metadatos locales son inválidos; no se ha importado el registro.');
    }
    result.meta[id] = { mode: value.mode, dose: value.dose, zone: value.zone, product: value.product } as Meta;
  }
  return { ...result, kinds: restoredKinds, centers: restoredCenters };
}

export function localRecord(
  markers: readonly { id?: string }[], lines: readonly { id: string }[], shapes: readonly { id: string }[],
  meta: Record<string, Meta>, annotationKinds: Record<string, ElemKind> = {}, centers: Record<string, Vec3> = {},
) {
  const withDose = <T extends { id?: string }>(item: T) => ({ ...item,
    units: meta[item.id ?? '']?.dose, label: meta[item.id ?? '']?.zone });
  return { mapping_data: {
    injectionPoints: markers.map(withDose), freehandLines: lines.map(withDose), surfaceShapes: shapes.map(withDose),
    lab: { version: 1, meta, kinds: annotationKinds, centers },
  } };
}
