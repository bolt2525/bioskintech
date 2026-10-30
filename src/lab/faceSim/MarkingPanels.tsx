import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Droplets, FlipHorizontal2, Gem, Maximize2, Minimize2, RotateCcw, RotateCw, Scissors, SlidersHorizontal, Sparkles, Syringe, Trash2, type LucideIcon } from 'lucide-react';
import { COLORS } from '../../constants/theme';
import { SIM_MODES, type SimMode } from './engine';
import { MAX_LEVEL, PREVIEW_DESCRIPTIONS, PREVIEW_FILTERS, type PreviewSettings } from './injectablePreview';
import { ALL_ROWS, INJECTION_PLANES, QUICK_VOLUMES, filterRows, formatVolume, type LedgerFilter, type LedgerRow, type LedgerThird, type VolumeTotal } from './markingModel';

export const MODE_ICONS: Record<SimMode, LucideIcon> = { toxina: Syringe, relleno_ha: Gem, hidratacion: Droplets, bioestimulador: Sparkles };
const MODES = Object.keys(SIM_MODES) as SimMode[];
const glow = (color: string): CSSProperties => ({ boxShadow: `0 0 0 1px ${color}aa, 0 0 18px -6px ${color}` });
const SIDE: Record<LedgerRow['side'], [string, string]> = { derecho: ['D', 'Derecho del paciente'], izquierdo: ['I', 'Izquierdo del paciente'], central: ['C', 'Línea media'] };
const THIRDS: [LedgerThird, string][] = [['superior', 'Superior'], ['medio', 'Medio'], ['inferior', 'Inferior'], ['extendida', 'Extendida']];
/** Superficies del editor: carbón cálido + acento dorado BIOSKIN (mismo lenguaje que Fichas clínicas). */
export const editorPanel = 'rounded-2xl border border-gold/15 bg-stone-950 text-stone-100 shadow-[0_18px_40px_-28px_rgba(0,0,0,0.9)]';
export const hudChip = 'inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-stone-900/85 px-3 text-xs font-semibold text-stone-100 backdrop-blur';
const field = 'admin-focus-ring min-h-10 w-full rounded-lg border border-white/10 bg-stone-900 px-2 text-sm text-stone-100';
const unitLabel = (mode: SimMode, value: number) => `${formatVolume(value)} ${SIM_MODES[mode].unit}`;

/** Zona bajo el cursor fuera del estado de React del laboratorio: el hover no re-renderiza visores. */
export interface ZoneStore { get: () => string | null; set: (zone: string | null) => void; subscribe: (listener: () => void) => () => void }
export function createZoneStore(): ZoneStore {
  let zone: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => zone,
    set: next => { if (next === zone) return; zone = next; listeners.forEach(fn => fn()); },
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export function useZone(store: ZoneStore) {
  const [zone, setZone] = useState(store.get());
  useEffect(() => { setZone(store.get()); return store.subscribe(() => setZone(store.get())); }, [store]);
  return zone;
}
export function ZoneChip({ store, color }: { store: ZoneStore; color: string }) {
  const zone = useZone(store);
  return <span role="status" className={`${hudChip} max-w-full`} style={{ borderColor: zone ? color : undefined }}>
    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: zone ? color : '#57534e' }} />
    <span className="truncate" title={zone ?? undefined}>{zone ?? 'Pasa el cursor sobre la capa'}</span>
  </span>;
}
export function ZoneView({ store, children }: { store: ZoneStore; children: (zone: string | null) => ReactNode }) {
  return <>{children(useZone(store))}</>;
}

export interface EditorTab<T extends string> { id: T; label: string; step: number; icon: LucideIcon; done?: boolean }
/** Pestañas tipo software de edición: los paneles se montan siempre y se ocultan con `hidden`. */
export function EditorTabs<T extends string>({ tabs, value, onChange, idBase }: {
  tabs: EditorTab<T>[]; value: T; onChange: (id: T) => void; idBase: string;
}) {
  return (
    <div role="tablist" aria-label="Pasos del editor" className="grid gap-1 rounded-xl bg-black/40 p-1" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map(({ id, label, step, icon: Icon, done }) => {
        const selected = value === id;
        return <button key={id} type="button" role="tab" id={`${idBase}-tab-${id}`} aria-selected={selected} aria-controls={`${idBase}-panel-${id}`}
          tabIndex={selected ? 0 : -1} onClick={() => onChange(id)}
          onKeyDown={e => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const at = tabs.findIndex(t => t.id === id), next = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            onChange(next.id); document.getElementById(`${idBase}-tab-${next.id}`)?.focus();
          }}
          className="admin-focus-ring flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-bold leading-tight text-stone-400 transition hover:text-stone-100 aria-selected:bg-stone-800 aria-selected:text-gold aria-selected:shadow-[inset_0_-2px_0_0_currentColor]">
          <span className="flex items-center gap-1">
            <span aria-hidden="true" className={`grid h-4 w-4 place-items-center rounded-full text-[9px] font-black ${done ? 'bg-emerald-400 text-stone-950' : selected ? 'bg-gold text-stone-950' : 'bg-stone-700 text-stone-300'}`}>
              {done ? <Check className="h-3 w-3" /> : step}
            </span>
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="text-center">{label}</span>
        </button>;
      })}
    </div>
  );
}

export function PanelSection({ title, icon: Icon, aside, children }: { title: string; icon: LucideIcon; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2 rounded-xl border border-white/5 bg-stone-900/60 p-3">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-stone-300">
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" /><span className="flex-1">{title}</span>{aside}
      </h3>
      {children}
    </section>
  );
}

export function ModeCards({ value, onChange }: { value: SimMode; onChange: (mode: SimMode) => void }) {
  return (
    <div role="group" aria-label="Tipo de inyectable" className="grid gap-1.5">
      {MODES.map(mode => {
        const { label, unit, color } = SIM_MODES[mode], Icon = MODE_ICONS[mode], active = value === mode;
        return <button key={mode} type="button" aria-pressed={active} onClick={() => onChange(mode)} style={active ? glow(color) : undefined}
          className="admin-focus-ring flex min-h-12 items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-2.5 text-left transition hover:border-white/25 aria-pressed:bg-stone-900">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: `${color}2e`, color }}><Icon className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1 text-sm font-bold text-stone-100">{label}</span>
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stone-400">{unit}</span>
        </button>;
      })}
    </div>
  );
}

export interface DockItem<T extends string> { id: T; label: string; icon: LucideIcon }
export function ToolDock<T extends string>({ label, items, value, onSelect, disabled, accent = COLORS.gold }: {
  label: string; items: DockItem<T>[]; value: T | null; onSelect: (id: T) => void; disabled?: (id: T) => boolean; accent?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {items.map(({ id, label: name, icon: Icon }) => <button key={id} type="button" aria-label={name} title={name}
        aria-pressed={value === id} disabled={disabled?.(id)} onClick={() => onSelect(id)} style={value === id ? glow(accent) : undefined}
        className="admin-focus-ring grid h-10 w-10 place-items-center rounded-lg border border-white/10 bg-black/30 text-stone-300 transition hover:text-white aria-pressed:bg-stone-800 aria-pressed:text-white disabled:opacity-30">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>)}
    </div>
  );
}

export function IconToggle({ label, icon: Icon, pressed, onClick, disabled, children }: {
  label: string; icon: LucideIcon; pressed?: boolean; onClick: () => void; disabled?: boolean; children?: ReactNode;
}) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
    className="admin-focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs font-semibold text-stone-300 transition hover:text-white aria-pressed:border-gold/60 aria-pressed:bg-gold/15 aria-pressed:text-gold disabled:opacity-30">
    <Icon className="h-4 w-4" aria-hidden="true" />{children}
  </button>;
}

export function CheckChip({ label, icon: Icon, checked, onChange, children }: {
  label: string; icon: LucideIcon; checked: boolean; onChange: (checked: boolean) => void; children: ReactNode;
}) {
  return <label title={label} className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs font-semibold text-stone-300 transition focus-within:ring-2 focus-within:ring-gold hover:text-white has-[:checked]:border-gold/60 has-[:checked]:bg-gold/15 has-[:checked]:text-gold">
    <input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-gold" />
    <Icon className="h-4 w-4" aria-hidden="true" />{children}
  </label>;
}

export interface MarkingCut { scope: 'none' | 'skin' | 'all'; axis: 'x' | 'y' | 'z'; position: number; reverse: boolean }
export const NO_CUT: MarkingCut = { scope: 'none', axis: 'z', position: 0.55, reverse: false };
export function CutControls({ value, onChange }: { value: MarkingCut; onChange: (cut: MarkingCut) => void }) {
  const segment = <K extends 'scope' | 'axis'>(key: K, label: string, options: [MarkingCut[K], string][]) => (
    <div role="group" aria-label={label} className="grid grid-cols-3 gap-1">
      {options.map(([id, name]) => <button key={id} type="button" aria-pressed={value[key] === id} onClick={() => onChange({ ...value, [key]: id })}
        className="admin-focus-ring min-h-9 rounded-md bg-black/30 px-1 text-[11px] font-semibold text-stone-300 aria-pressed:bg-gold aria-pressed:text-stone-950">{name}</button>)}
    </div>
  );
  return (
    <div className="space-y-2">
      {segment('scope', 'Alcance del corte', [['none', 'Sin corte'], ['skin', 'Piel'], ['all', 'Todo']])}
      {value.scope !== 'none' && <>
        {segment('axis', 'Eje del corte', [['x', 'Lateral'], ['y', 'Vertical'], ['z', 'Profundidad']])}
        <div className="flex items-center gap-2">
          <input type="range" aria-label="Posición del corte" min={0} max={1} step={0.01} value={value.position}
            onChange={e => onChange({ ...value, position: Number(e.target.value) })} className="flex-1 accent-gold" />
          <IconToggle label="Invertir corte" icon={Scissors} pressed={value.reverse} onClick={() => onChange({ ...value, reverse: !value.reverse })} />
        </div>
      </>}
    </div>
  );
}

function QuickVolumes({ mode, value, onPick }: { mode: SimMode; value: number | null; onPick: (value: number) => void }) {
  const { color } = SIM_MODES[mode];
  return <div role="group" aria-label="Volúmenes rápidos" className="grid grid-cols-5 gap-1">
    {QUICK_VOLUMES[mode].map(v => <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)}
      title={unitLabel(mode, v)}
      className="admin-focus-ring flex min-h-10 flex-col items-center justify-center rounded-lg border border-white/10 bg-stone-900 text-sm font-bold leading-none aria-pressed:text-stone-950"
      style={value === v ? { background: color } : undefined}>{v}<span className="mt-0.5 text-[9px] font-semibold uppercase opacity-70">{SIM_MODES[mode].unit}</span></button>)}
  </div>;
}

export function VolumeDialog({ open, mode, count, place, initialDose, onSave, onDiscard }: {
  open: boolean; mode: SimMode; count: number; place: string; initialDose: number;
  onSave: (dose: number, plane: string) => void; onDiscard: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  const [dose, setDose] = useState(String(initialDose || ''));
  const [plane, setPlane] = useState('');
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    if (open && !dialog.open) { setDose(initialDose ? String(initialDose) : ''); setPlane(''); dialog.showModal(); }
    if (!open && dialog.open) dialog.close();
  }, [open, initialDose]);
  const { unit, color, label } = SIM_MODES[mode], Icon = MODE_ICONS[mode];
  const value = Number(dose), valid = dose !== '' && Number.isFinite(value) && value >= 0;
  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onDiscard(); }}
      className="w-[min(92vw,400px)] rounded-2xl border border-gold/20 bg-stone-950 p-0 text-stone-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm">
      <form method="dialog" className="space-y-4 p-4" onSubmit={e => { e.preventDefault(); if (valid) onSave(value, plane); }}>
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}2e`, color, ...glow(color) }}><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.14em]">Volumen · {label}</h2>
            <p className="text-xs text-stone-400">{place}{count > 1 ? ` · ${count} puntos (bilateral)` : ''}</p>
          </div>
        </header>
        <QuickVolumes mode={mode} value={dose !== '' && Number.isFinite(value) ? value : null} onPick={v => setDose(String(v))} />
        <label className="block text-xs font-semibold text-stone-300">Volumen por punto ({unit})
          <input autoFocus required type="number" min={0} step="any" inputMode="decimal" aria-label={`Volumen por punto (${unit})`} value={dose}
            onChange={e => setDose(e.target.value)} className={`${field} mt-1 text-lg font-bold`} />
        </label>
        <label className="block text-xs font-semibold text-stone-300">Plano <span className="font-normal text-stone-500">(opcional)</span>
          <select aria-label="Plano de aplicación" value={plane} onChange={e => setPlane(e.target.value)} className={`${field} mt-1`}>
            <option value="">Sin plano</option>
            {INJECTION_PLANES[mode].map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={onDiscard} className="admin-focus-ring min-h-11 flex-1 rounded-xl border border-white/10 text-sm font-semibold text-stone-300">Descartar punto</button>
          <button type="submit" disabled={!valid} className="admin-focus-ring min-h-11 flex-1 rounded-xl text-sm font-black text-stone-950 disabled:opacity-40" style={{ background: color }}>Guardar</button>
        </div>
      </form>
    </dialog>
  );
}

export function VolumeHud({ totals }: { totals: VolumeTotal[] }) {
  if (!totals.length) return null;
  return <ul aria-label="Volumen acumulado" className="flex flex-wrap gap-1.5">
    {totals.map(t => <li key={t.key} className={hudChip} style={{ borderColor: `${SIM_MODES[t.mode].color}80` }}
      title={`${t.points} punto(s)${t.pending ? ` · ${t.pending} sin volumen` : ''}`}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: SIM_MODES[t.mode].color }} />
      {t.product || SIM_MODES[t.mode].label}
      <b className="tabular-nums" style={{ color: SIM_MODES[t.mode].color }}>{formatVolume(t.total)} {SIM_MODES[t.mode].unit}</b>
      <span className="text-stone-400">· {t.points} pt{t.pending ? ` · ${t.pending}!` : ''}</span>
    </li>)}
  </ul>;
}

/** Variador propio por inyectable: actúa como filtro visual independiente de la dosis. */
export function EffectMixer({ value, onChange }: { value: PreviewSettings; onChange: (next: PreviewSettings) => void }) {
  return (
    <div role="group" aria-label="Preview cosmético ilustrativo" className="space-y-2">
      {MODES.map(mode => {
        const { label, color } = SIM_MODES[mode], Icon = MODE_ICONS[mode], level = value.levels?.[mode] ?? 1, on = value.enabled[mode];
        return <div key={mode} className="rounded-xl border border-white/5 bg-black/30 p-2" style={on ? { borderColor: `${color}66` } : undefined}>
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-bold text-stone-200" title={PREVIEW_DESCRIPTIONS[mode]}>
            <input type="checkbox" aria-label={`Efecto ${label}`} checked={on} className="h-3.5 w-3.5" style={{ accentColor: color }}
              onChange={e => onChange({ ...value, enabled: { ...value.enabled, [mode]: e.target.checked } })} />
            <Icon className="h-3.5 w-3.5" style={{ color }} aria-hidden="true" />
            <span className="flex-1">{label}</span>
            <span className="font-medium text-stone-400">{PREVIEW_FILTERS[mode]}</span>
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input type="range" aria-label={`Intensidad ${label}`} min={0} max={MAX_LEVEL} step={0.05} value={level} disabled={!on}
              onChange={e => onChange({ ...value, levels: { ...value.levels, [mode]: Number(e.target.value) } })}
              className="flex-1 disabled:opacity-30" style={{ accentColor: color }} />
            <span className="w-11 text-right text-xs tabular-nums text-stone-300">{Math.round(level * 100)}%</span>
          </div>
        </div>;
      })}
      <label className="flex items-center gap-2 pt-1 text-xs text-stone-400"><SlidersHorizontal className="h-3.5 w-3.5 text-gold" aria-hidden="true" />Global
        <input aria-label="Intensidad visual independiente" type="range" min={0} max={1} step={0.05} value={value.intensity}
          onChange={e => onChange({ ...value, intensity: Number(e.target.value) })} className="flex-1 accent-gold" />
        <span className="w-11 text-right tabular-nums">{Math.round(value.intensity * 100)}%</span>
      </label>
    </div>
  );
}

/** Edición inmediata de la marca seleccionada (clic en el visor o en el listado). */
export function SelectionInspector({ row, onDose, onDelete, onMirror, mirrorDisabled, onTransform, children }: {
  row: LedgerRow; onDose: (id: string, dose: number) => void; onDelete: (id: string) => void;
  onMirror: () => void; mirrorDisabled?: boolean; onTransform?: (change: { scale?: number; degrees?: number }) => void; children?: ReactNode;
}) {
  const { color, label } = SIM_MODES[row.mode], Icon = MODE_ICONS[row.mode], [, sideLong] = SIDE[row.side];
  return (
    <section aria-label="Marca seleccionada" className="space-y-2 rounded-xl border bg-stone-900/80 p-3" style={{ borderColor: `${color}88` }}>
      <header className="flex items-start gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-black text-stone-950" style={{ background: color }}>{row.index}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-tight">{row.zone}</p>
          <p className="text-[11px] text-stone-400"><Icon className="mr-1 inline h-3 w-3" style={{ color }} aria-hidden="true" />{row.product || label} · {sideLong}</p>
        </div>
        <button type="button" aria-label={`Eliminar marca ${row.index} seleccionada`} title="Eliminar" onClick={() => onDelete(row.id)}
          className="admin-focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-red-500/15 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
      </header>
      <QuickVolumes mode={row.mode} value={row.dose} onPick={v => onDose(row.id, v)} />
      <div className="flex flex-wrap gap-1">
        <IconToggle label="Espejar selección" icon={FlipHorizontal2} disabled={mirrorDisabled} onClick={onMirror}>Espejo</IconToggle>
        {onTransform && row.kind !== 'point' && <>
          <IconToggle label="Reducir figura" icon={Minimize2} onClick={() => onTransform({ scale: 0.9 })} />
          <IconToggle label="Ampliar figura" icon={Maximize2} onClick={() => onTransform({ scale: 1.1 })} />
          <IconToggle label="Rotar a la izquierda" icon={RotateCcw} onClick={() => onTransform({ degrees: 15 })} />
          <IconToggle label="Rotar a la derecha" icon={RotateCw} onClick={() => onTransform({ degrees: -15 })} />
        </>}
      </div>
      {row.kind !== 'point' && <p className="text-[11px] text-stone-500">Con «Seleccionar / editar» arrastra extremos para alargar o el trazo para moverlo.</p>}
      {children}
    </section>
  );
}

export function PointLedger({ rows, selectedId, onSelect, onHover, onDose, onDelete, onPlane, header, children }: {
  rows: LedgerRow[]; selectedId: string | null;
  onSelect: (row: LedgerRow) => void; onHover: (row: LedgerRow | null) => void;
  onDose: (id: string, dose: number) => void; onDelete: (id: string) => void;
  onPlane: (ids: string[], plane: string) => void; header?: ReactNode; children?: ReactNode;
}) {
  const [filter, setFilter] = useState<LedgerFilter>(ALL_ROWS);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [bulkPlane, setBulkPlane] = useState('');
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const zones = useMemo(() => [...new Set(rows.map(r => r.zone))].sort((a, b) => a.localeCompare(b, 'es')), [rows]);
  const live = new Set(rows.map(r => r.id)), picked = visible.filter(r => checked.has(r.id) && live.has(r.id));
  const targets = picked.length ? picked : visible;
  const planes = [...new Set(targets.flatMap(r => INJECTION_PLANES[r.mode]))];
  const set = <K extends keyof LedgerFilter>(key: K, v: LedgerFilter[K]) => setFilter(f => ({ ...f, [key]: v }));
  const compact = 'admin-focus-ring min-h-9 w-full rounded-lg border border-white/10 bg-stone-900 px-2 text-xs text-stone-100';
  return (
    <section aria-label="Listado de puntos" className={`${editorPanel} flex h-full min-h-0 min-w-0 flex-col gap-2 p-3`}>
      {header}
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-xs font-black uppercase tracking-[0.16em]">Puntos <span className="text-gold tabular-nums">{visible.length}/{rows.length}</span></h2>
        <div role="group" aria-label="Filtrar por inyectable" className="flex gap-1">
          {(['all', ...MODES] as const).map(m => <button key={m} type="button" aria-pressed={filter.mode === m} onClick={() => set('mode', m)}
            title={m === 'all' ? 'Todos' : SIM_MODES[m].label}
            className="admin-focus-ring grid h-8 min-w-8 place-items-center rounded-full border border-white/10 px-2 text-[11px] font-bold text-stone-300 aria-pressed:bg-gold aria-pressed:text-stone-950">
            {m === 'all' ? 'Todos' : <span className="h-2.5 w-2.5 rounded-full" style={{ background: SIM_MODES[m].color }}><span className="sr-only">{SIM_MODES[m].label}</span></span>}
          </button>)}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-1.5">
        <select aria-label="Filtrar por zona" value={filter.zone} onChange={e => set('zone', e.target.value)} className={`${compact} col-span-2`}>
          <option value="all">Todas las zonas</option>{zones.map(z => <option key={z}>{z}</option>)}
        </select>
        <select aria-label="Filtrar por tercio" value={filter.third} onChange={e => set('third', e.target.value as LedgerFilter['third'])} className={compact}>
          <option value="all">Todo tercio</option>{THIRDS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select aria-label="Filtrar por volumen" value={filter.volume} onChange={e => set('volume', e.target.value as LedgerFilter['volume'])} className={compact}>
          <option value="all">Todo volumen</option><option value="with">Con volumen</option><option value="without">Sin volumen</option>
        </select>
      </div>
      {rows.length > 0 && <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/5 bg-black/30 p-1.5">
        <label className="flex min-h-9 items-center gap-1.5 text-[11px] font-semibold text-stone-300">
          <input type="checkbox" aria-label="Seleccionar todos los puntos visibles" checked={visible.length > 0 && picked.length === visible.length}
            onChange={e => setChecked(e.target.checked ? new Set(visible.map(r => r.id)) : new Set())} className="h-4 w-4 accent-gold" />
          {picked.length ? `${picked.length} sel.` : 'Lote'}
        </label>
        <select aria-label="Plano para el lote" value={bulkPlane} onChange={e => setBulkPlane(e.target.value)} className={`${compact} w-auto min-w-0 flex-1`}>
          <option value="">Sin plano</option>{planes.map(p => <option key={p}>{p}</option>)}
        </select>
        <button type="button" disabled={!targets.length} onClick={() => onPlane(targets.map(r => r.id), bulkPlane)}
          className="admin-focus-ring min-h-9 whitespace-nowrap rounded-lg bg-gold px-2.5 text-[11px] font-black text-stone-950 disabled:opacity-40">Aplicar plano ({targets.length})</button>
      </div>}
      {!rows.length && <p className="rounded-xl border border-dashed border-white/15 p-5 text-center text-sm text-stone-400">Elige una herramienta y marca sobre el rostro.</p>}
      <ul aria-label="Elementos marcados" className="min-h-[8rem] flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-1">
        {visible.map(r => {
          const { color, unit, label } = SIM_MODES[r.mode], [sideShort, sideLong] = SIDE[r.side], active = selectedId === r.id;
          return <li key={r.id} onPointerEnter={() => onHover(r)} onPointerLeave={() => onHover(null)}
            className={`flex items-center gap-1.5 rounded-xl border bg-stone-900/70 p-1.5 transition ${active ? 'border-gold/70' : 'border-white/5'}`}
            style={active ? glow(color) : { borderLeft: `3px solid ${color}` }}>
            <input type="checkbox" aria-label={`Incluir marca ${r.index} en lote`} checked={checked.has(r.id)} className="h-4 w-4 shrink-0 accent-gold"
              onChange={e => setChecked(c => { const n = new Set(c); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
            <button type="button" aria-pressed={active} aria-label={`Seleccionar marca ${r.index}`} onFocus={() => onHover(r)} onBlur={() => onHover(null)}
              onClick={() => onSelect(r)} className="admin-focus-ring flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg text-left">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-black text-stone-950" style={{ background: color }}>{r.index}</span>
              <span className="min-w-0">
                <span className="block text-xs font-bold leading-tight">{r.zone} <span title={sideLong} className="font-black text-stone-400">· {sideShort}</span></span>
                <span className="block text-[10px] leading-tight text-stone-400">{r.product || label}{r.plane ? ` · ${r.plane}` : ''}{r.kind !== 'point' ? ` · ${r.kind}` : ''}{r.extended ? ' · solo 3D' : ''}</span>
              </span>
            </button>
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-stone-400">
              <input type="number" min={0} step="any" inputMode="decimal" value={r.dose} aria-label={`Dosis marca ${r.index}`}
                onChange={e => onDose(r.id, Number(e.target.value))} className="admin-focus-ring min-h-9 w-14 rounded-md border border-white/10 bg-stone-950 px-1 text-right text-sm font-bold tabular-nums text-white" />
              {unit}
            </label>
            <button type="button" aria-label={`Eliminar marca ${r.index}`} title="Eliminar" onClick={() => onDelete(r.id)}
              className="admin-focus-ring grid h-9 w-8 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-red-500/15 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </li>;
        })}
      </ul>
      {children}
    </section>
  );
}