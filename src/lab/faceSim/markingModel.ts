import type { ElemKind, Meta, SimMode } from './engine';
import type { AnatomicalBinding, AnatomicalBindings } from './anatomicalAnnotations';
import type { FaceAddress } from './faceTransfer';
import { addressPlacement, type FacialThird, type PatientSide } from './quickRecord';

/** Planos de aplicación por inyectable (copias de los catálogos de Fichas clínicas). */
export const INJECTION_PLANES: Record<SimMode, readonly string[]> = {
  toxina: ['Intramuscular', 'Intradérmico', 'Subdérmico', 'Subcutáneo'],
  relleno_ha: ['Dérmico superficial', 'Dérmico medio', 'Dérmico profundo', 'Subcutáneo', 'Supraperióstico'],
  hidratacion: ['Intradérmico', 'Dérmico superficial', 'Subcutáneo'],
  bioestimulador: ['Subdérmico', 'Subcutáneo', 'Supraperióstico'],
};
export const QUICK_VOLUMES: Record<SimMode, readonly number[]> = {
  toxina: [1, 2, 4, 5, 10],
  relleno_ha: [0.05, 0.1, 0.2, 0.5, 1],
  hidratacion: [0.05, 0.1, 0.2, 0.5, 1],
  bioestimulador: [0.1, 0.2, 0.3, 0.5, 1],
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
  /** Trazo de entrada de aguja: no suma volumen; lo suman sus puntas. */
  entry: boolean;
  /** Etiqueta legible: «Punto», «Abanico», «Punta 3»… */
  label: string;
  parent?: string;
  tips: number;
  graphicOnly?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  annotationText?: string;
  annotationKind?: 'ellipse' | 'text' | 'ruler';
}
export interface LedgerFilter { mode: SimMode | 'all'; zone: string; third: LedgerThird | 'all'; volume: 'all' | 'with' | 'without' }
export const ALL_ROWS: LedgerFilter = { mode: 'all', zone: 'all', third: 'all', volume: 'all' };

export const KIND_LABELS: Record<ElemKind, string> = {
  point: 'Punto', line: 'Línea', arrow: 'Flecha', free: 'Trazo libre', circle: 'Círculo', rect: 'Área', pattern: 'Patrón',
};
/** Trazos con entrada de aguja: la dosis se deposita en sus puntas, no a lo largo del trazo. */
export const TIP_KINDS: ReadonlySet<ElemKind> = new Set(['pattern', 'line', 'arrow']);
/**
 * Puntas de dosis de un trazo de entrada. Cada segmento empieza en la entrada (vértice del
 * abanico, base de la malla o de la rama) y termina en su punta. La flecha solo su asta.
 */
export function patternTips(binding: AnatomicalBinding): FaceAddress[] {
  if (!TIP_KINDS.has(binding.kind)) return [];
  const paths = binding.kind === 'arrow' ? binding.paths.slice(0, 1) : binding.paths;
  return paths.filter(path => path.length > 1).map(path => path[path.length - 1]);
}

/** Una fila por marca (bilateral = dos filas); las puntas siguen a su entrada. */
export function ledgerRows(meta: Record<string, Meta>, bindings: AnatomicalBindings, freeIds: readonly string[] = []): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const base = (id: string, item: Meta, kind?: ElemKind) => {
    // Los contornos históricos conservan su Meta; el registro nunca los trata como dosis.
    const graphicOnly = !!item.graphicOnly || kind === 'circle' || kind === 'rect';
    return { id, index: 0, mode: item.mode, product: item.product?.trim() ?? '',
      dose: graphicOnly || item.entry ? 0 : item.dose,
      plane: graphicOnly || item.entry ? '' : item.plane ?? '', entry: !graphicOnly && !!item.entry, tips: 0,
      graphicOnly, strokeColor: item.strokeColor, strokeWidth: item.strokeWidth,
      annotationText: item.annotationText, annotationKind: item.annotationKind,
      ...(item.parent ? { parent: item.parent } : {}) };
  };
  for (const [id, binding] of Object.entries(bindings)) {
    const item = meta[id];
    if (!item) continue;
    const address = binding.center ?? binding.paths[0]?.[0];
    let place: { zone: string; third: FacialThird; side: PatientSide } = { zone: item.zone, third: 'medio', side: 'central' };
    try { if (address) place = addressPlacement(address, item.zone); } catch { /* dirección degenerada: conserva la zona manual */ }
    const label = item.parent ? `Punta ${(item.tip ?? 0) + 1}` : item.technique ?? KIND_LABELS[binding.kind] ?? binding.kind;
    rows.push({ ...base(id, item, binding.kind), ...place, kind: binding.kind, extended: false, label });
  }
  for (const id of freeIds) {
    const item = meta[id];
    if (item && !bindings[id]) rows.push({ ...base(id, item), zone: EXTENDED_ZONE, third: 'extendida', side: 'central', kind: 'point', extended: true, label: 'Punto' });
  }
  const children = new Map<string, LedgerRow[]>();
  for (const row of rows) if (row.parent && rows.some(r => r.id === row.parent)) children.set(row.parent, [...children.get(row.parent) ?? [], row]);
  const ordered: LedgerRow[] = [];
  for (const row of rows) {
    if (row.parent && children.has(row.parent)) continue;
    const tips = (children.get(row.id) ?? []).sort((a, b) => (meta[a.id]?.tip ?? 0) - (meta[b.id]?.tip ?? 0));
    ordered.push({ ...row, tips: tips.length }, ...tips);
  }
  return ordered.map((row, i) => ({ ...row, index: i + 1 }));
}

export const filterRows = (rows: readonly LedgerRow[], f: LedgerFilter) => rows.filter(r =>
  (f.mode === 'all' || r.mode === f.mode) && (f.zone === 'all' || r.zone === f.zone)
  && (f.third === 'all' || r.third === f.third)
  && (f.volume === 'all' || !r.entry && !r.graphicOnly && (f.volume === 'with' ? r.dose > 0 : r.dose <= 0)));

export interface VolumeTotal { key: string; mode: SimMode; product: string; total: number; points: number; pending: number }
/** Totales en tiempo real por inyectable y vial; los puntos sin volumen cuentan como pendientes. */
export function volumeTotals(rows: readonly LedgerRow[]): VolumeTotal[] {
  const totals = new Map<string, VolumeTotal>();
  for (const r of rows) {
    if (r.entry || r.graphicOnly) continue;
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
