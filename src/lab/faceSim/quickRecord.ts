import { AUTO_ZONE, type Meta, type SimMode } from './engine';
import type { AnatomicalBindings } from './anatomicalAnnotations';
import type { FaceAddress } from './faceTransfer';
import { buildFaceRegionMap, buildFaceTriangleRegions } from './faceRegions';
import { buildRegionCells, regionCellAt } from './regionMesh';
import atlas from './genericFaceAtlas.json';

export type FacialThird = 'superior' | 'medio' | 'inferior';
export type PatientSide = 'derecho' | 'izquierdo' | 'central';
export interface QuickZone {
  key: string;
  zone: string;
  third: FacialThird;
  side: PatientSide;
  elements: string[];
}
export interface QuickGroup {
  key: string;
  mode: SimMode;
  product: string;
  elements: string[];
  zones: QuickZone[];
}
export interface QuickAmounts {
  total: number | null;
  zones: Record<string, number | null>;
}
export interface QuickRecordSettings {
  version: 1;
  entries: Record<string, QuickAmounts>;
}
export const initialQuickRecordSettings = (): QuickRecordSettings => ({ version: 1, entries: {} });
const regionMap = buildFaceRegionMap(
  Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })),
  atlas.triangles, 1, atlas.positions,
);
const cells = buildRegionCells(regionMap, buildFaceTriangleRegions(regionMap, atlas.positions));
const cellsByTriangle = new Map<number, typeof cells>();
for (const cell of cells) {
  const group = cellsByTriangle.get(cell.triangle) ?? [];
  group.push(cell);
  cellsByTriangle.set(cell.triangle, group);
}
const modes: readonly SimMode[] = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];
export const quickGroupKey = (mode: SimMode, product: string) => JSON.stringify([mode, product.trim()]);

export function addressPlacement(address: FaceAddress, manual: string): Omit<QuickZone, 'elements'> {
  const ids = atlas.triangles.slice(address.triangle * 3, address.triangle * 3 + 3);
  if (ids.length !== 3 || address.weights.length !== 3
    || !address.weights.every(n => Number.isFinite(n) && n >= -1e-7 && n <= 1 + 1e-7)
    || Math.abs(address.weights.reduce((sum, n) => sum + n, 0) - 1) > 1e-6) {
    throw new Error('La zona rápida requiere una dirección facial válida.');
  }
  const [x, y] = [0, 1].map(axis => ids.reduce((sum, id, j) => sum + atlas.positions[id * 3 + axis] * address.weights[j], 0));
  const width = Math.abs(atlas.positions[454 * 3] - atlas.positions[234 * 3]);
  const centerX = (atlas.positions[234 * 3] + atlas.positions[454 * 3]) / 2;
  const side: PatientSide = Math.abs(x - centerX) < width * 0.015 ? 'central' : x < centerX ? 'derecho' : 'izquierdo';
  const third: FacialThird = y > atlas.positions[9 * 3 + 1] ? 'superior'
    : y > atlas.positions[2 * 3 + 1] ? 'medio' : 'inferior';
  const zone = manual && manual !== AUTO_ZONE ? manual
    : regionCellAt(address, cellsByTriangle.get(address.triangle) ?? []) ?? 'Sin zona identificada';
  return { key: JSON.stringify([third, zone, side]), third, zone, side };
}

/** Un trazo puede tocar varias zonas; su cantidad nunca se reparte ni multiplica. */
export function quickRecordGroups(meta: Record<string, Meta>, bindings: AnatomicalBindings): QuickGroup[] {
  const groups = new Map<string, QuickGroup>();
  const zoneMaps = new Map<string, Map<string, QuickZone>>();
  for (const [id, binding] of Object.entries(bindings)) {
    const item = meta[id];
    if (!item || !modes.includes(item.mode)) throw new Error('Hay una marcación sin categoría válida para el registro rápido.');
    const product = item.product?.trim() ?? '', key = quickGroupKey(item.mode, product);
    if (!groups.has(key)) {
      groups.set(key, { key, mode: item.mode, product, elements: [], zones: [] });
      zoneMaps.set(key, new Map());
    }
    const group = groups.get(key)!, zones = zoneMaps.get(key)!;
    group.elements.push(id);
    const addresses = [...binding.paths.flat(), ...(binding.center ? [binding.center] : [])];
    if (!addresses.length) throw new Error('Hay una marcación sin recorrido facial.');
    for (const address of addresses) {
      const zone = addressPlacement(address, item.zone);
      const existing = zones.get(zone.key);
      if (existing) {
        if (!existing.elements.includes(id)) existing.elements.push(id);
      } else zones.set(zone.key, { ...zone, elements: [id] });
    }
  }
  for (const [key, group] of groups) group.zones = [...zoneMaps.get(key)!.values()].sort((a, b) =>
    ['superior', 'medio', 'inferior'].indexOf(a.third) - ['superior', 'medio', 'inferior'].indexOf(b.third)
    || a.zone.localeCompare(b.zone, 'es') || a.side.localeCompare(b.side, 'es'));
  return [...groups.values()];
}

export function quickGroupSummary(group: QuickGroup, values?: QuickAmounts) {
  const thirds: Record<FacialThird, number> = { superior: 0, medio: 0, inferior: 0 };
  let assigned = 0, pending = 0;
  for (const zone of group.zones) {
    const amount = values?.zones[zone.key];
    if (amount === null || amount === undefined) pending++;
    else {
      if (!Number.isFinite(amount) || amount < 0) throw new Error('La cantidad por zona debe ser finita y no negativa.');
      assigned += amount;
      thirds[zone.third] += amount;
    }
  }
  const active = new Set(group.zones.map(zone => zone.key));
  const stale = Object.entries(values?.zones ?? {}).filter(([key, amount]) => !active.has(key) && amount !== null);
  const orphaned = stale.reduce((sum, [, amount]) => sum + amount!, 0);
  if (!Number.isFinite(assigned) || !Number.isFinite(orphaned)) throw new Error('El total excede el rango numérico admitido.');
  const difference = values?.total === null || values?.total === undefined ? null : values.total - assigned;
  return { assigned, pending, thirds, stale: stale.map(([key]) => key), orphaned, difference };
}

export function validateQuickRecord(value: unknown): QuickRecordSettings {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const amount = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!object(value) || value.version !== 1 || !object(value.entries) || Object.keys(value.entries).length > 500) {
    throw new Error('El registro rápido tiene un formato o versión no admitidos.');
  }
  const entries: QuickRecordSettings['entries'] = {};
  for (const [key, item] of Object.entries(value.entries)) {
    let group: unknown;
    try { group = JSON.parse(key); } catch { throw new Error('La presentación del registro rápido es inválida.'); }
    if (!Array.isArray(group) || group.length !== 2 || !modes.includes(group[0]) || typeof group[1] !== 'string'
      || group[1].length > 500 || quickGroupKey(group[0], group[1]) !== key
      || !object(item) || !amount(item.total) || !object(item.zones) || Object.keys(item.zones).length > 5000) {
      throw new Error('La presentación o sus cantidades son inválidas.');
    }
    const zones: QuickAmounts['zones'] = {};
    for (const [zoneKey, quantity] of Object.entries(item.zones)) {
      let parts: unknown;
      try { parts = JSON.parse(zoneKey); } catch { throw new Error('Hay una zona rápida inválida.'); }
      if (!Array.isArray(parts) || parts.length !== 3 || !['superior', 'medio', 'inferior'].includes(parts[0])
        || typeof parts[1] !== 'string' || !parts[1].trim() || parts[1].length > 500
        || !['derecho', 'izquierdo', 'central'].includes(parts[2]) || JSON.stringify(parts) !== zoneKey || !amount(quantity)) {
        throw new Error('Hay una zona o cantidad rápida inválida.');
      }
      zones[zoneKey] = quantity as number | null;
    }
    entries[key] = { total: item.total as number | null, zones };
  }
  return { version: 1, entries };
}
