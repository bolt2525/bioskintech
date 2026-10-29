import type { Meta, SimMode } from './engine';
import type { AnatomicalBindings } from './anatomicalAnnotations';
import { addressPlacement, type FacialThird, type PatientSide } from './quickRecord';

/** Planos de aplicación por inyectable (copias de los catálogos de Fichas clínicas). */
export const INJECTION_PLANES: Record<SimMode, readonly string[]> = {
  toxina: ['Intramuscular', 'Intradérmico', 'Subdérmico', 'Subcutáneo'],
  relleno_ha: ['Dérmico superficial', 'Dérmico medio', 'Dérmico profundo', 'Subcutáneo', 'Supraperióstico'],
  hidratacion: ['Intradérmico', 'Dérmico superficial', 'Subcutáneo'],
  bioestimulador: ['Subdérmico', 'Subcutáneo', 'Supraperióstico'],
};
export const QUICK_VOLUMES: Record<SimMode, readonly number[]> = {
  toxina: [2, 4, 5, 10],
  relleno_ha: [0.05, 0.1, 0.2, 0.5],
  hidratacion: [0.05, 0.1, 0.2, 0.5],
  bioestimulador: [0.1, 0.2, 0.3, 0.5],
};
export const EXTENDED_ZONE = 'Zona extendida';

export type LedgerThird = FacialThird | 'extendida';
export interface LedgerRow {
  id: string;
  index: number;
  mode: SimMode;
  product: string;
  dose: number;
  plane: string;
  zone: string;
  third: LedgerThird;
  side: PatientSide;
  kind: string;
  /** Marca solo en el modelo completo: no se transfiere a máscara ni foto. */
  extended: boolean;
}
export interface LedgerFilter { mode: SimMode | 'all'; zone: string; third: LedgerThird | 'all'; volume: 'all' | 'with' | 'without' }
export const ALL_ROWS: LedgerFilter = { mode: 'all', zone: 'all', third: 'all', volume: 'all' };

/** Una fila por marca (bilateral = dos filas). Las marcas libres conservan meta sin binding. */
export function ledgerRows(meta: Record<string, Meta>, bindings: AnatomicalBindings, freeIds: readonly string[] = []): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const base = (id: string, item: Meta) => ({ id, index: rows.length + 1, mode: item.mode, product: item.product?.trim() ?? '',
    dose: item.dose, plane: item.plane ?? '' });
  for (const [id, binding] of Object.entries(bindings)) {
    const item = meta[id];
    if (!item) continue;
    const address = binding.center ?? binding.paths[0]?.[0];
    let place: { zone: string; third: FacialThird; side: PatientSide } = { zone: item.zone, third: 'medio', side: 'central' };
    try { if (address) place = addressPlacement(address, item.zone); } catch { /* dirección degenerada: conserva la zona manual */ }
    rows.push({ ...base(id, item), ...place, kind: binding.kind, extended: false });
  }
  for (const id of freeIds) {
    const item = meta[id];
    if (item && !bindings[id]) rows.push({ ...base(id, item), zone: EXTENDED_ZONE, third: 'extendida', side: 'central', kind: 'point', extended: true });
  }
  return rows;
}

export const filterRows = (rows: readonly LedgerRow[], f: LedgerFilter) => rows.filter(r =>
  (f.mode === 'all' || r.mode === f.mode) && (f.zone === 'all' || r.zone === f.zone)
  && (f.third === 'all' || r.third === f.third)
  && (f.volume === 'all' || (f.volume === 'with' ? r.dose > 0 : r.dose <= 0)));

export interface VolumeTotal { key: string; mode: SimMode; product: string; total: number; points: number; pending: number }
/** Totales en tiempo real por inyectable y vial; los puntos sin volumen cuentan como pendientes. */
export function volumeTotals(rows: readonly LedgerRow[]): VolumeTotal[] {
  const totals = new Map<string, VolumeTotal>();
  for (const r of rows) {
    const key = JSON.stringify([r.mode, r.product]);
    const t = totals.get(key) ?? { key, mode: r.mode, product: r.product, total: 0, points: 0, pending: 0 };
    t.points++;
    if (r.dose > 0) t.total += r.dose; else t.pending++;
    totals.set(key, t);
  }
  return [...totals.values()];
}

/** Redondeo de presentación: evita 0.30000000000000004 en ml. */
export const formatVolume = (value: number) => String(Math.round(value * 1000) / 1000);
