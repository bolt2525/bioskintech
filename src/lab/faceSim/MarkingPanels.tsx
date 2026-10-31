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
interface LedgerPatternGroup { label: string; rows: LedgerRow[] }
interface LedgerVialGroup { mode: SimMode; product: string; loose: LedgerRow[]; patterns: Map<string, LedgerPatternGroup> }
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
/** Profundidad = pelado por capas (no un plano): piel → músculo → vascular → óseo. */
export const isDepthCut = (cut: MarkingCut) => cut.scope !== 'none' && cut.axis === 'z';
const DEPTH_LABELS = ['Piel', 'Músculo', 'Vascular', 'Óseo'];
export function CutControls({ value, onChange }: { value: MarkingCut; onChange: (cut: MarkingCut) => void }) {
  const kind = value.scope === 'none' ? 'none' : value.axis === 'z' ? 'depth' : 'plane';
  const button = (pressed: boolean, label: string, onClick: () => void) => <button key={label} type="button" aria-pressed={pressed} onClick={onClick}
    className="admin-focus-ring min-h-9 min-w-0 rounded-md bg-black/30 px-1 text-[11px] font-semibold leading-tight text-stone-300 [overflow-wrap:anywhere] aria-pressed:bg-gold aria-pressed:text-stone-950">{label}</button>;
  const stop = Math.round(value.position * 3);
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Tipo de corte" className="grid grid-cols-[1fr_1.45fr_1fr] gap-1">
        {button(kind === 'none', 'Sin corte', () => onChange({ ...value, scope: 'none' }))}
        {button(kind === 'depth', 'Profundidad', () => onChange({ ...value, scope: 'all', axis: 'z', position: kind === 'depth' ? value.position : 0 }))}
        {button(kind === 'plane', 'Plano', () => onChange({ ...value, scope: value.scope === 'skin' ? 'skin' : 'all', axis: value.axis === 'z' ? 'x' : value.axis, position: kind === 'plane' ? value.position : 0.5 }))}
      </div>
      {kind === 'depth' && <>
        <input type="range" aria-label="Profundidad del corte" aria-valuetext={DEPTH_LABELS[stop]} min={0} max={1} step={0.01} value={value.position}
          onChange={e => onChange({ ...value, position: Number(e.target.value) })} className="w-full accent-gold" />
        <div role="group" aria-label="Capas de profundidad" className="grid grid-cols-2 gap-1">
          {DEPTH_LABELS.map((label, i) => button(Math.abs(value.position * 3 - i) < 0.5, label, () => onChange({ ...value, position: i / 3 })))}
        </div>
        <p className="text-[11px] leading-snug text-stone-400">Retira la piel y avanza por músculo y vasos hasta el hueso. Se marca sobre la capa dominante.</p>
      </>}
      {kind === 'plane' && <>
        <div role="group" aria-label="Alcance del corte" className="grid grid-cols-2 gap-1">
          {button(value.scope === 'skin', 'Solo piel', () => onChange({ ...value, scope: 'skin' }))}
          {button(value.scope === 'all', 'Todas las capas', () => onChange({ ...value, scope: 'all' }))}
        </div>
        <div role="group" aria-label="Eje del corte" className="grid grid-cols-2 gap-1">
          {button(value.axis === 'x', 'Lateral', () => onChange({ ...value, axis: 'x' }))}
          {button(value.axis === 'y', 'Vertical', () => onChange({ ...value, axis: 'y' }))}
        </div>
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

export interface DoseTarget { id: string; label: string }
/**
 * Volumen tras marcar. Con varias puntas (patrón, bilateral) permite la misma dosis para todas
 * o una dosis individual por punta; el total se calcula en vivo.
 */
export function VolumeDialog({ open, mode, count, place, initialDose, targets, technique, allowWithoutPoints = false, initialWithPoints = true, onSave, onDiscard }: {
  open: boolean; mode: SimMode; count: number; place: string; initialDose: number;
  targets?: DoseTarget[]; technique?: string; allowWithoutPoints?: boolean; initialWithPoints?: boolean;
  onSave: (dose: number, plane: string, perTarget?: Record<string, number>, withPoints?: boolean) => void; onDiscard: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  const [dose, setDose] = useState(String(initialDose || ''));
  const [plane, setPlane] = useState('');
  const [individual, setIndividual] = useState(false);
  const [each, setEach] = useState<Record<string, string>>({});
  const [withPoints, setWithPoints] = useState(initialWithPoints);
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    if (open && !dialog.open) { setDose(initialDose ? String(initialDose) : ''); setPlane(''); setIndividual(false); setEach({}); setWithPoints(initialWithPoints); dialog.showModal(); }
    if (!open && dialog.open) dialog.close();
  }, [open, initialDose, initialWithPoints]);
  const recording = !allowWithoutPoints || withPoints;
  const { unit, color, label } = SIM_MODES[mode], Icon = MODE_ICONS[mode];
  const value = Number(dose), validShared = dose !== '' && Number.isFinite(value) && value >= 0;
  const list = targets ?? [], perTarget = list.length > 1 && individual;
  const parsed = Object.fromEntries(list.map(t => [t.id, Number(each[t.id] ?? dose)]));
  const validEach = list.every(t => { const raw = each[t.id] ?? dose, v = Number(raw); return raw !== '' && Number.isFinite(v) && v >= 0; });
  const valid = !recording || (perTarget ? validEach : validShared);
  const total = perTarget ? Object.values(parsed).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) : (validShared ? value : 0) * count;
  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onDiscard(); }}
      className="w-[min(94vw,440px)] rounded-2xl border border-gold/20 bg-stone-950 p-0 text-stone-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm">
      <form method="dialog" className="max-h-[85dvh] space-y-4 overflow-y-auto overscroll-contain p-4" onSubmit={e => {
        e.preventDefault();
        if (valid) onSave(recording ? value : 0, recording ? plane : '', recording && perTarget ? parsed : undefined, recording);
      }}>
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}2e`, color, ...glow(color) }}><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.14em]">Volumen · {label}</h2>
            <p className="break-words text-xs text-stone-400">{technique ? `${technique} · ` : ''}{place}{count > 1 ? ` · ${count} ${technique ? 'puntas' : 'puntos'}` : ''}</p>
          </div>
        </header>
        {allowWithoutPoints && <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={withPoints} onChange={e => setWithPoints(e.target.checked)} className="h-4 w-4 accent-gold" />
          Crear puntos de registro
        </label>}
        {!recording && <p role="status" className="text-xs text-stone-300">Se guardará solo el gráfico, sin dosis ni plano.</p>}
        {recording && technique && <p className="rounded-xl border border-white/5 bg-black/30 p-2 text-[11px] leading-snug text-stone-400">
          La entrada del trazo es la entrada de aguja y define la zona; la dosis se deposita en cada punta.</p>}
        <fieldset disabled={!recording} className="min-w-0 space-y-4 disabled:opacity-40">
          <legend className="sr-only">Dosis y plano de los puntos de registro</legend>
        {list.length > 1 && <div role="radiogroup" aria-label="Reparto de dosis" className="grid grid-cols-2 gap-1 rounded-xl bg-black/40 p-1">
          {([[false, 'Igual en todas'], [true, 'Individual']] as const).map(([v, text]) => <button key={text} type="button" role="radio" aria-checked={individual === v}
            onClick={() => setIndividual(v)} className="admin-focus-ring min-h-9 rounded-lg text-xs font-bold text-stone-300 aria-checked:bg-gold aria-checked:text-stone-950">{text}</button>)}
        </div>}
        <QuickVolumes mode={mode} value={dose !== '' && Number.isFinite(value) ? value : null} onPick={v => { setDose(String(v)); setEach({}); }} />
        <label className="block text-xs font-semibold text-stone-300">{perTarget ? 'Dosis base' : count > 1 ? 'Dosis por punta' : 'Volumen por punto'} ({unit})
          <input autoFocus required={!perTarget} type="number" min={0} step="any" inputMode="decimal" aria-label={`Volumen por punto (${unit})`} value={dose}
            onChange={e => { setDose(e.target.value); setEach({}); }} className={`${field} mt-1 text-lg font-bold`} />
        </label>
        {perTarget && <ul aria-label="Dosis por punta" className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
          {list.map((t, i) => <li key={t.id}><label className="flex items-center gap-1.5 rounded-lg border border-white/5 bg-black/30 p-1.5 text-[11px] font-semibold text-stone-300">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-black text-stone-950" style={{ background: color }}>{i + 1}</span>
            <span className="min-w-0 flex-1 break-words leading-tight">{t.label}</span>
            <input type="number" min={0} step="any" inputMode="decimal" aria-label={`Dosis ${t.label}`} value={each[t.id] ?? dose}
              onChange={e => setEach(c => ({ ...c, [t.id]: e.target.value }))} className="admin-focus-ring min-h-8 w-14 rounded-md border border-white/10 bg-stone-900 px-1 text-right text-sm font-bold tabular-nums" />
          </label></li>)}
        </ul>}
        <label className="block text-xs font-semibold text-stone-300">Plano <span className="font-normal text-stone-500">(opcional)</span>
          <select aria-label="Plano de aplicación" value={plane} onChange={e => setPlane(e.target.value)} className={`${field} mt-1`}>
            <option value="">Sin plano</option>
            {INJECTION_PLANES[mode].map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        </fieldset>
        {recording && count > 1 && <p role="status" className="flex items-center justify-between rounded-xl border border-white/5 bg-black/30 px-3 py-2 text-xs text-stone-300">
          Total de esta marca <b className="text-base tabular-nums" style={{ color }}>{unitLabel(mode, total)}</b></p>}
        <div className="flex gap-2">
          <button type="button" onClick={onDiscard} className="admin-focus-ring min-h-11 flex-1 rounded-xl border border-white/10 text-sm font-semibold text-stone-300">Descartar</button>
          <button type="submit" disabled={!valid} className="admin-focus-ring min-h-11 flex-1 rounded-xl text-sm font-black text-stone-950 disabled:opacity-40" style={{ background: color }}>Guardar</button>
        </div>
      </form>
    </dialog>
  );
}

export type PatternKind = 'fan' | 'grid' | 'fern';
export interface PatternSettings { fanLines: number; fanAngle: number; gridCells: number; fernBranches: number }
const PATTERN_INFO: Record<PatternKind, { label: string; help: string }> = {
  fan: { label: 'Abanico', help: 'Pulsa en la entrada de aguja y arrastra hacia la zona a tratar. Cada línea termina en una punta con dosis.' },
  grid: { label: 'Malla', help: 'Pulsa en la entrada, arrastra para fijar el largo y suelta; luego ajusta el ancho. Cada línea termina en una punta.' },
  fern: { label: 'Helecho', help: 'Pulsa en la entrada y arrastra a lo largo del eje. Cada rama termina en una punta con dosis.' },
};
/** Vista previa fiel a la geometría: segmentos desde la entrada y puntas con dosis. */
export function patternPreview(kind: PatternKind, c: PatternSettings): { segments: [number, number, number, number][]; entry: [number, number] } {
  const entry: [number, number] = [20, 60];
  if (kind === 'fan') {
    const n = Math.max(2, c.fanLines), half = c.fanAngle * Math.PI / 180;
    return { entry, segments: Array.from({ length: n }, (_, i) => {
      const a = -half + 2 * half * i / (n - 1);
      return [20, 60, 20 + Math.cos(a) * 92, 60 + Math.sin(a) * 92];
    }) };
  }
  if (kind === 'grid') {
    const n = Math.max(2, c.gridCells), w = 70, step = w / n;
    return { entry, segments: [
      ...Array.from({ length: n + 1 }, (_, i): [number, number, number, number] => [20, 25 + i * step, 112, 25 + i * step]),
      ...Array.from({ length: n + 1 }, (_, i): [number, number, number, number] => [20 + i * 92 / n, 25, 20 + i * 92 / n, 95]),
    ] };
  }
  const b = Math.max(2, c.fernBranches);
  return { entry, segments: [[20, 60, 112, 60], ...Array.from({ length: b }, (_, i) => (i + 1) / (b + 1)).flatMap(t =>
    [-1, 1].map((s): [number, number, number, number] => [20 + 92 * t, 60, 20 + 92 * Math.min(1, t + 0.15), 60 + s * 26]))] };
}

/** Ajuste previo del patrón (como Fichas → Inyectables): parámetros + vista previa, luego «Trazar». */
export function PatternSetupDialog({ open, kind, config, color, onKind, onConfirm, onCancel }: {
  open: boolean; kind: PatternKind; config: PatternSettings; color: string;
  onKind?: (kind: PatternKind) => void; onConfirm: (config: PatternSettings) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  const [draft, setDraft] = useState(config);
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    if (open && !dialog.open) { setDraft(config); dialog.showModal(); }
    if (!open && dialog.open) dialog.close();
  }, [open, config]);
  const { segments, entry } = patternPreview(kind, draft);
  const tips = segments.length;
  const range = (key: keyof PatternSettings, text: string, min: number, max: number, scale = 1, suffix = '') => (
    <label className="block text-xs font-semibold text-stone-300">
      <span className="flex justify-between"><span>{text}</span><b className="tabular-nums text-stone-100">{draft[key] * scale}{suffix}</b></span>
      <input type="range" min={min} max={max} step={1} value={draft[key]} aria-label={text}
        onChange={e => setDraft(d => ({ ...d, [key]: Number(e.target.value) }))} className="mt-1 w-full" style={{ accentColor: color }} />
    </label>);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onCancel(); }}
      className="w-[min(94vw,420px)] rounded-2xl border border-gold/20 bg-stone-950 p-0 text-stone-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm">
      <form method="dialog" className="max-h-[88dvh] space-y-4 overflow-y-auto p-4" onSubmit={e => { e.preventDefault(); onConfirm(draft); }}>
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}2e`, color, ...glow(color) }}><SlidersHorizontal className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.14em]">Ajustar {PATTERN_INFO[kind].label}</h2>
            <p className="text-xs text-stone-400">{tips} puntas con dosis · {kind === 'grid' ? 'una entrada por línea' : '1 entrada de aguja'}</p>
          </div>
        </header>
        {onKind && <div role="radiogroup" aria-label="Tipo de patrón" className="grid grid-cols-3 gap-1 rounded-xl bg-black/40 p-1">
          {(Object.keys(PATTERN_INFO) as PatternKind[]).map(k => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => onKind(k)}
            className="admin-focus-ring min-h-9 rounded-lg text-xs font-bold text-stone-300 aria-checked:bg-gold aria-checked:text-stone-950">{PATTERN_INFO[k].label}</button>)}
        </div>}
        <svg viewBox="0 0 132 120" role="img" aria-label={`Vista previa: ${PATTERN_INFO[kind].label} con ${tips} puntas`} className="h-40 w-full rounded-xl border border-white/5 bg-black/40">
          {segments.map(([x1, y1, x2, y2], i) => <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0c0a09" strokeWidth={5} strokeLinecap="round" />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2.6} strokeLinecap="round" />
            <circle cx={x2} cy={y2} r={3.4} fill={color} stroke="#0c0a09" strokeWidth={1.2} />
          </g>)}
          {kind !== 'grid' ? <circle cx={entry[0]} cy={entry[1]} r={5} fill="#0c0a09" stroke="white" strokeWidth={2} />
            : segments.map(([x1, y1], i) => <circle key={`e${i}`} cx={x1} cy={y1} r={2.6} fill="#0c0a09" stroke="white" strokeWidth={1.2} />)}
        </svg>
        <div className="space-y-3">
          {kind === 'fan' && <>{range('fanLines', 'Líneas', 3, 12)}{range('fanAngle', 'Apertura total', 10, 60, 2, '°')}</>}
          {kind === 'grid' && range('gridCells', 'Celdas por lado', 2, 8)}
          {kind === 'fern' && range('fernBranches', 'Ramas por lado', 2, 10)}
        </div>
        <p className="rounded-xl border border-white/5 bg-black/30 p-2 text-[11px] leading-snug text-stone-400">{PATTERN_INFO[kind].help} Verás la vista previa antes de soltar.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="admin-focus-ring min-h-11 flex-1 rounded-xl border border-white/10 text-sm font-semibold text-stone-300">Cancelar</button>
          <button type="submit" className="admin-focus-ring min-h-11 flex-1 rounded-xl text-sm font-black text-stone-950" style={{ background: color }}>Trazar</button>
        </div>
      </form>
    </dialog>
  );
}

export function VolumeHud({ totals, activeMode, activeProduct, onSelect }: {
  totals: VolumeTotal[]; activeMode?: SimMode; activeProduct?: string; onSelect?: (mode: SimMode, product: string) => void;
}) {
  if (!totals.length) return null;
  return <ul aria-label="Volumen acumulado" className="flex flex-wrap gap-1.5">
    {totals.map(t => {
      const active = activeMode === t.mode && (activeProduct?.trim() ?? '') === t.product;
      const content = <>
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: SIM_MODES[t.mode].color }} />
        <span className="min-w-0 break-words">{t.product || SIM_MODES[t.mode].label}</span>
        <b className="tabular-nums" style={{ color: SIM_MODES[t.mode].color }}>{formatVolume(t.total)} {SIM_MODES[t.mode].unit}</b>
        <span className="text-stone-300">· {t.points} pt{t.pending ? ` · ${t.pending}!` : ''}</span>
        {active && <span className="font-black text-gold">Activo</span>}
      </>;
      const title = `${SIM_MODES[t.mode].label} · ${t.points} punto(s)${t.pending ? ` · ${t.pending} sin volumen` : ''}${onSelect ? ' · Usar solo para nuevas marcas' : ''}`;
      return <li key={t.key} className="min-w-0 max-w-full">
        {onSelect ? <button type="button" aria-pressed={active} onClick={() => onSelect(t.mode, t.product)} title={title}
          className={`${hudChip} admin-focus-ring max-w-full !whitespace-normal text-left hover:bg-stone-800 aria-pressed:bg-gold/15`}
          style={{ borderColor: `${SIM_MODES[t.mode].color}80`, ...(active ? glow(SIM_MODES[t.mode].color) : {}) }}>{content}</button>
          : <span className={`${hudChip} max-w-full !whitespace-normal`} title={title} style={{ borderColor: `${SIM_MODES[t.mode].color}80` }}>{content}</span>}
      </li>;
    })}
  </ul>;
}

export type CoveragePreviewSettings = PreviewSettings & {
  coverage?: Partial<Record<SimMode, number>>;
  showCoverage?: boolean;
};

/** Variador propio por inyectable: actúa como filtro visual independiente de la dosis. */
export function EffectMixer({ value, onChange }: { value: CoveragePreviewSettings; onChange: (next: CoveragePreviewSettings) => void }) {
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
          <label className="mt-2 block text-[11px] font-semibold text-stone-300">
            Cobertura visual
            <span className="mt-1 flex items-center gap-2">
              <input type="range" aria-label={`Cobertura visual ${label}`} min={0.5} max={2} step={0.05} value={value.coverage?.[mode] ?? 1} disabled={!on}
                onChange={e => onChange({ ...value, coverage: { ...value.coverage, [mode]: Number(e.target.value) } })}
                className="min-w-0 flex-1 disabled:opacity-30" style={{ accentColor: color }} />
              <span className="w-11 text-right tabular-nums">{Math.round((value.coverage?.[mode] ?? 1) * 100)}%</span>
            </span>
          </label>
        </div>;
      })}
      <label className="flex min-h-9 cursor-pointer items-center gap-2 text-xs text-stone-300">
        <input type="checkbox" checked={value.showCoverage ?? false} onChange={e => onChange({ ...value, showCoverage: e.target.checked })} className="h-4 w-4 accent-gold" />
        Mostrar cobertura visual
      </label>
      <label className="flex items-center gap-2 pt-1 text-xs text-stone-400"><SlidersHorizontal className="h-3.5 w-3.5 text-gold" aria-hidden="true" />Global
        <input aria-label="Intensidad visual independiente" type="range" min={0} max={1} step={0.05} value={value.intensity}
          onChange={e => onChange({ ...value, intensity: Number(e.target.value) })} className="flex-1 accent-gold" />
        <span className="w-11 text-right tabular-nums">{Math.round(value.intensity * 100)}%</span>
      </label>
    </div>
  );
}

/** Edición inmediata de la marca seleccionada (clic en el visor o en el listado). */
export function SelectionInspector({ row, onDose, onDelete, onMirror, mirrorDisabled, onTransform, tipDose, onStyle, strokeColor, strokeWidth, onText, children }: {
  row: LedgerRow; onDose: (id: string, dose: number) => void; onDelete: (id: string) => void;
  onMirror: () => void; mirrorDisabled?: boolean; onTransform?: (change: { scale?: number; degrees?: number }) => void; children?: ReactNode;
  tipDose?: number | null; onStyle?: (style: { color?: string; thickness?: number }) => void;
  strokeColor?: string; strokeWidth?: number; onText?: (text: string) => void;
}) {
  const { color, label } = SIM_MODES[row.mode], Icon = MODE_ICONS[row.mode], [, sideLong] = SIDE[row.side];
  const appliedDose = row.entry ? tipDose ?? null : row.dose;
  const graphicColor = strokeColor ?? row.strokeColor ?? color;
  const graphicWidth = strokeWidth ?? row.strokeWidth ?? 1;
  return (
    <section aria-label="Marca seleccionada" className="space-y-2 rounded-xl border bg-stone-900/80 p-3" style={{ borderColor: `${color}88` }}>
      <header className="flex items-start gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-black text-stone-950" style={{ background: color }}>{row.index}</span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-bold leading-tight">{row.zone}</p>
          <p className="break-words text-[11px] text-stone-400"><Icon className="mr-1 inline h-3 w-3" style={{ color }} aria-hidden="true" />{row.label} · {row.product || label} · {sideLong}</p>
          {!row.graphicOnly && row.entry && <p className="text-[11px] text-stone-400">Entrada de aguja · la dosis rápida se aplica a sus {row.tips} puntas.</p>}
        </div>
        <button type="button" aria-label={`Eliminar marca ${row.index} seleccionada`} title="Eliminar" onClick={() => onDelete(row.id)}
          className="admin-focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-red-500/15 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
      </header>
      {row.graphicOnly ? <p className="text-xs text-stone-300">Solo gráfico · sin dosis ni plano</p> : <>
        <p role="status" className="text-xs text-stone-300">{appliedDose === null ? 'Dosis distintas o sin puntas de registro' : `Dosis aplicada${row.entry ? ' por punta' : ''}: ${unitLabel(row.mode, appliedDose)}`}</p>
        <QuickVolumes mode={row.mode} value={appliedDose} onPick={v => onDose(row.id, v)} />
      </>}
      {onText && row.annotationKind === 'text' && <label className="block text-xs font-semibold text-stone-300">Texto de la anotación
        <input type="text" value={row.annotationText ?? ''} onChange={e => onText(e.target.value)} className={`${field} mt-1`} />
      </label>}
      {onStyle && <div role="group" aria-label="Estilo independiente de la marca" className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
        <label className="text-xs font-semibold text-stone-300">Color
          <input type="color" aria-label="Color de la marca" value={graphicColor} onChange={e => onStyle({ color: e.target.value })}
            className="admin-focus-ring ml-2 h-9 w-10 cursor-pointer rounded border border-white/10 bg-stone-950 align-middle" />
        </label>
        <label className="text-xs font-semibold text-stone-300">Grosor
          <input type="number" aria-label="Grosor de la marca" min={0.1} step={0.1} value={graphicWidth}
            onChange={e => { const width = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(width) && width > 0) onStyle({ thickness: width }); }}
            className={`${field} mt-1`} />
        </label>
      </div>}
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

function LedgerPatternList({ label, count, entry, children }: { label: string; count: number; entry: ReactNode; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return <div className="rounded-xl border border-white/10 bg-black/20 p-1.5">
    <ul role="presentation" className="space-y-1.5">{entry}</ul>
    <button type="button" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(current => !current)}
      className="admin-focus-ring min-h-9 w-full break-words rounded-lg px-1 py-2 text-left text-xs font-semibold text-stone-300 hover:bg-stone-800">
      <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{label} · {count} puntas en el filtro
    </button>
    <ul id={listId} role="presentation" hidden={!expanded} className="space-y-1.5">{children}</ul>
  </div>;
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
  const [panel, setPanel] = useState<'list' | 'edit'>('list');
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const zones = useMemo(() => [...new Set(rows.map(r => r.zone))].sort((a, b) => a.localeCompare(b, 'es')), [rows]);
  const picked = rows.filter(r => checked.has(r.id));
  const visiblePicked = visible.filter(r => checked.has(r.id));
  // Una entrada en lote arrastra sus puntas; la entrada no lleva dosis ni plano propio.
  const targets = picked.flatMap(r => r.entry ? rows.filter(t => t.parent === r.id) : [r])
    .filter((r, i, all) => !r.graphicOnly && !r.entry && all.findIndex(x => x.id === r.id) === i);
  const planes = [...new Set(targets.flatMap(r => INJECTION_PLANES[r.mode]))];
  const groups = useMemo(() => {
    const vials = new Map<string, LedgerVialGroup>();
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const row of visible) {
      const key = JSON.stringify([row.mode, row.product]);
      const vial: LedgerVialGroup = vials.get(key) ?? { mode: row.mode, product: row.product, loose: [], patterns: new Map() };
      const patternId = row.parent ?? (row.entry || row.kind === 'pattern' ? row.id : undefined);
      if (patternId) {
        const pattern: LedgerPatternGroup = vial.patterns.get(patternId) ?? { label: byId.get(patternId)?.label ?? 'Patrón', rows: [] };
        pattern.rows.push(row);
        vial.patterns.set(patternId, pattern);
      } else vial.loose.push(row);
      vials.set(key, vial);
    }
    return [...vials];
  }, [rows, visible]);
  const set = <K extends keyof LedgerFilter>(key: K, v: LedgerFilter[K]) => setFilter(f => ({ ...f, [key]: v }));
  const compact = 'admin-focus-ring min-h-9 w-full rounded-lg border border-white/10 bg-stone-900 px-2 text-xs text-stone-100';
  return (
    <section aria-label="Listado de puntos" className={`${editorPanel} flex h-full min-h-0 min-w-0 flex-col gap-2 p-3`}>
      <div role="group" aria-label="Panel de marcas" className="flex shrink-0 gap-1 rounded-xl bg-black/40 p-1">
        <button type="button" aria-pressed={panel === 'list'} onClick={() => setPanel('list')}
          className="admin-focus-ring min-h-9 flex-1 rounded-lg px-2 text-xs font-bold aria-pressed:bg-gold/20 aria-pressed:text-gold">Listado</button>
        <button type="button" aria-pressed={panel === 'edit'} disabled={!header} onClick={() => setPanel('edit')}
          className="admin-focus-ring min-h-9 flex-1 rounded-lg px-2 text-xs font-bold disabled:opacity-40 aria-pressed:bg-gold/20 aria-pressed:text-gold">Editar selección</button>
      </div>
      <div hidden={panel !== 'edit'} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {header || <p className="p-3 text-xs text-stone-400">Selecciona una marca en el visor o en el listado.</p>}
      </div>
      <div hidden={panel !== 'list'} className="min-h-0 flex-1 flex-col gap-2 data-[active=true]:flex" data-active={panel === 'list'}>
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 whitespace-nowrap text-xs font-black uppercase tracking-[0.16em]">Marcas <span className="text-gold tabular-nums">{visible.length}/{rows.length}</span></h2>
        <div role="group" aria-label="Filtrar por inyectable" className="flex gap-1">
          {(['all', ...MODES] as const).map(m => <button key={m} type="button" aria-pressed={filter.mode === m} onClick={() => set('mode', m)}
            title={m === 'all' ? 'Todos' : SIM_MODES[m].label}
            className="admin-focus-ring grid h-8 min-w-8 place-items-center rounded-full border border-white/10 px-2 text-[11px] font-bold text-stone-300 aria-pressed:bg-gold aria-pressed:text-stone-950">
            {m === 'all' ? 'Todos' : <span className="h-2.5 w-2.5 rounded-full" style={{ background: SIM_MODES[m].color }}><span className="sr-only">{SIM_MODES[m].label}</span></span>}
          </button>)}
        </div>
      </header>
      <details className="shrink-0 rounded-lg border border-white/10 p-2">
        <summary className="admin-focus-ring cursor-pointer text-xs font-semibold text-stone-300">Filtros de zona, tercio y volumen</summary>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
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
      </details>
      {rows.length > 0 && <details className="shrink-0 rounded-xl border border-white/5 bg-black/30 p-2">
        <summary className="admin-focus-ring cursor-pointer text-xs font-semibold text-stone-300">Selección y plano en lote · {picked.length}</summary>
        <div className="mt-2 grid grid-cols-2 items-center gap-1.5">
        <label className="flex min-h-9 items-center gap-1.5 text-[11px] font-semibold text-stone-300">
          <input type="checkbox" aria-label="Seleccionar todos los puntos visibles" checked={visible.length > 0 && visiblePicked.length === visible.length}
            onChange={e => {
              const select = e.target.checked;
              setChecked(current => { const next = new Set(current); visible.forEach(r => { if (select) next.add(r.id); else next.delete(r.id); }); return next; });
            }} className="h-4 w-4 accent-gold" />
          Visibles
        </label>
        <button type="button" onClick={() => setChecked(new Set(rows.map(r => r.id)))} className={`${compact} hover:bg-stone-800`}>Todo el registro</button>
        <button type="button" onClick={() => setChecked(new Set())} disabled={!picked.length} className={`${compact} disabled:opacity-40 hover:bg-stone-800`}>Deseleccionar todo</button>
        <span role="status" className="text-right text-[11px] text-stone-300">{picked.length} seleccionadas</span>
        <select aria-label="Plano para el lote" disabled={!targets.length} value={bulkPlane} onChange={e => setBulkPlane(e.target.value)} className={`${compact} col-span-2 min-w-0 disabled:opacity-40`}>
          <option value="">Sin plano</option>{planes.map(p => <option key={p}>{p}</option>)}
        </select>
        <button type="button" disabled={!targets.length} onClick={() => { if (targets.length) onPlane(targets.map(r => r.id), bulkPlane); }}
          className="admin-focus-ring col-span-2 min-h-9 rounded-lg bg-gold px-2.5 text-[11px] font-black text-stone-950 disabled:opacity-40">Aplicar plano a {targets.length} punto(s)</button>
        {!picked.length && <p className="col-span-2 text-[11px] text-stone-300">Selecciona marcas para aplicar un plano.</p>}
      </div></details>}
      {header && <button type="button" onClick={() => setPanel('edit')}
        className="admin-focus-ring min-h-9 shrink-0 rounded-lg border border-gold/30 bg-gold/10 px-2 text-left text-xs font-semibold text-gold">Editar marca seleccionada · #{rows.find(row => row.id === selectedId)?.index}</button>}
      {!rows.length && <p className="rounded-xl border border-dashed border-white/15 p-5 text-center text-sm text-stone-400">Elige una herramienta y marca sobre el rostro.</p>}
      {rows.length > 0 && !visible.length && <p role="status" className="text-xs text-stone-300">No hay marcas con estos filtros.</p>}
      <div role="list" aria-label="Elementos marcados" className="min-h-[8rem] flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        {groups.map(([key, vial]) => {
          const renderRow = (r: LedgerRow) => {
          const { color, unit, label } = SIM_MODES[r.mode], [sideShort, sideLong] = SIDE[r.side], active = selectedId === r.id;
          const tipTotal = r.entry ? rows.filter(t => t.parent === r.id && !t.graphicOnly).reduce((sum, t) => sum + t.dose, 0) : 0;
          const detail = [r.product || label, r.extended ? 'solo 3D' : ''].filter(Boolean).join(' · ');
          return <li role="listitem" key={r.id} onPointerEnter={() => onHover(r)} onPointerLeave={() => onHover(null)}
            className={`rounded-xl border bg-stone-900/70 p-1.5 transition ${r.parent ? 'ml-4' : ''} ${active ? 'border-gold/70' : 'border-white/5'}`}
            style={active ? glow(color) : { borderLeft: `3px solid ${color}` }}>
            <div className="flex items-start gap-1.5">
              <input type="checkbox" aria-label={`Incluir marca ${r.index} en lote`} checked={checked.has(r.id)} className="mt-2.5 h-4 w-4 shrink-0 accent-gold"
                onChange={e => setChecked(c => { const n = new Set(c); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
              <button type="button" aria-pressed={active} aria-label={`Seleccionar marca ${r.index}`} onFocus={() => onHover(r)} onBlur={() => onHover(null)}
                onClick={() => onSelect(r)} className="admin-focus-ring flex min-h-10 min-w-0 flex-1 items-start gap-2 rounded-lg py-0.5 text-left">
                <span className={`grid shrink-0 place-items-center text-[11px] font-black ${r.entry ? 'h-7 w-7 rounded-full border-2 bg-stone-950 text-stone-100' : r.parent ? 'mt-0.5 h-6 w-6 rounded-md text-stone-950' : 'h-7 w-7 rounded-lg text-stone-950'}`}
                  style={r.entry ? { borderColor: color } : { background: color }}>{r.parent ? r.label.replace(/\D+/g, '') : r.index}</span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-xs font-bold leading-snug">
                    {r.parent ? r.label : <>{r.zone} <span title={sideLong} className="font-black text-stone-400">· {sideShort}</span></>}
                  </span>
                  <span className="block break-words text-[11px] leading-snug text-stone-400">
                    {r.graphicOnly ? `Gráfico · ${r.annotationText || r.label}` : r.entry ? `Entrada · ${r.label} · ${r.tips} puntas` : r.parent ? r.zone : `${r.label} · ${detail}`}
                  </span>
                  {!r.graphicOnly && !r.entry && <span className="block break-words text-[11px] leading-snug text-stone-300">Plano: {r.plane || 'Sin plano'}</span>}
                </span>
              </button>
              {r.parent && !r.graphicOnly && <label className="flex shrink-0 items-center gap-1 self-center text-[11px] text-stone-400">
                <span className="sr-only">Dosis</span>
                <input type="number" min={0} step="any" inputMode="decimal" value={r.dose} aria-label={`Dosis marca ${r.index}`}
                  onChange={e => onDose(r.id, Number(e.target.value))} className="admin-focus-ring min-h-8 w-14 rounded-md border border-white/10 bg-stone-950 px-1 text-right text-sm font-bold tabular-nums text-white" />
                <span>{unit}</span>
              </label>}
              <button type="button" aria-label={`Eliminar marca ${r.index}`} title={r.entry ? 'Eliminar trazo y sus puntas' : 'Eliminar'} onClick={() => onDelete(r.id)}
                className="admin-focus-ring grid h-9 w-8 shrink-0 place-items-center rounded-lg text-stone-400 hover:bg-red-500/15 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
            </div>
            {!r.parent && !r.graphicOnly && <div className="mt-1 flex items-center justify-end gap-1.5 pl-6 text-[11px] text-stone-400">
              {r.entry
                ? <span className="tabular-nums">Total <b style={{ color }}>{formatVolume(tipTotal)} {unit}</b></span>
                : <label className="flex items-center gap-1">Dosis
                  <input type="number" min={0} step="any" inputMode="decimal" value={r.dose} aria-label={`Dosis marca ${r.index}`}
                    onChange={e => onDose(r.id, Number(e.target.value))} className="admin-focus-ring min-h-8 w-16 rounded-md border border-white/10 bg-stone-950 px-1.5 text-right text-sm font-bold tabular-nums text-white" />
                  <span className="w-6">{unit}</span>
                </label>}
            </div>}
          </li>;
          };
          return <section key={key} className="space-y-1.5">
            <h3 className="break-words text-xs font-bold text-stone-200">{vial.product || 'Sin vial'} <span className="font-normal text-stone-400">· {SIM_MODES[vial.mode].label}</span></h3>
            {[...vial.patterns].map(([id, pattern]) => <LedgerPatternList key={id} label={pattern.label}
              count={pattern.rows.filter(r => r.id !== id).length} entry={pattern.rows.filter(r => r.id === id).map(renderRow)}>
              {pattern.rows.filter(r => r.id !== id).map(renderRow)}
            </LedgerPatternList>)}
            {vial.loose.length > 0 && <>
              <h4 className="text-[11px] font-semibold text-stone-400">Puntos sueltos y gráficos</h4>
              <ul role="presentation" className="space-y-1.5">{vial.loose.map(renderRow)}</ul>
            </>}
          </section>;
        })}
      </div>
      {children}
      </div>
    </section>
  );
}
