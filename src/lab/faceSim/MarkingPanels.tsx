import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Droplets, Filter, Gem, Scissors, Sparkles, Syringe, Trash2, type LucideIcon } from 'lucide-react';
import { SIM_MODES, type SimMode } from './engine';
import { ALL_ROWS, INJECTION_PLANES, QUICK_VOLUMES, filterRows, formatVolume, type LedgerFilter, type LedgerRow, type LedgerThird, type VolumeTotal } from './markingModel';

export const MODE_ICONS: Record<SimMode, LucideIcon> = { toxina: Syringe, relleno_ha: Gem, hidratacion: Droplets, bioestimulador: Sparkles };
const MODES = Object.keys(SIM_MODES) as SimMode[];
const glow = (color: string): CSSProperties => ({ boxShadow: `0 0 0 1px ${color}99, 0 0 22px -6px ${color}` });
const SIDE: Record<LedgerRow['side'], [string, string]> = { derecho: ['D', 'Derecho del paciente'], izquierdo: ['I', 'Izquierdo del paciente'], central: ['C', 'Línea media'] };
const THIRDS: [LedgerThird, string][] = [['superior', 'Superior'], ['medio', 'Medio'], ['inferior', 'Inferior'], ['extendida', 'Extendida']];
export const hudChip = 'inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/10 bg-slate-900/80 px-3 text-xs font-semibold text-slate-100 backdrop-blur';
const field = 'admin-focus-ring min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-2 text-sm text-slate-100';

export function StepCard({ step, title, state, icon: Icon, aside, children }: {
  step: number; title: string; state: 'done' | 'active' | 'idle'; icon: LucideIcon; aside?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={`Paso ${step}: ${title}`} data-state={state}
      className="relative rounded-2xl border border-white/10 bg-slate-900/70 p-3 transition-shadow duration-300 data-[state=active]:border-cyan-400/50 data-[state=active]:shadow-[0_0_28px_-10px_rgba(34,211,238,0.9)]">
      <header className="mb-3 flex items-center gap-2">
        <span aria-hidden="true" className={`grid h-7 w-7 place-items-center rounded-lg text-xs font-black ${state === 'done' ? 'bg-emerald-400 text-slate-950' : state === 'active' ? 'bg-cyan-400 text-slate-950' : 'bg-slate-800 text-slate-400'}`}>
          {state === 'done' ? <Check className="h-4 w-4" /> : step}
        </span>
        <Icon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
        <h2 className="flex-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-200">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function ModeCards({ value, onChange }: { value: SimMode; onChange: (mode: SimMode) => void }) {
  return (
    <div role="group" aria-label="Tipo de inyectable" className="grid grid-cols-2 gap-2">
      {MODES.map(mode => {
        const { label, unit, color } = SIM_MODES[mode], Icon = MODE_ICONS[mode], active = value === mode;
        return <button key={mode} type="button" aria-pressed={active} onClick={() => onChange(mode)} style={active ? glow(color) : undefined}
          className="admin-focus-ring group flex min-h-14 items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-2 text-left transition motion-safe:hover:-translate-y-0.5 aria-pressed:bg-slate-950">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: `${color}26`, color }}><Icon className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0"><span className="block truncate text-xs font-bold text-slate-100">{label}</span>
            <span className="block text-[10px] uppercase tracking-wider text-slate-400">{unit}</span></span>
        </button>;
      })}
    </div>
  );
}

export interface DockItem<T extends string> { id: T; label: string; icon: LucideIcon }
export function ToolDock<T extends string>({ label, items, value, onSelect, disabled, accent = '#22d3ee' }: {
  label: string; items: DockItem<T>[]; value: T | null; onSelect: (id: T) => void; disabled?: (id: T) => boolean; accent?: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-6 gap-1.5">
      {items.map(({ id, label: name, icon: Icon }) => <button key={id} type="button" aria-label={name} title={name}
        aria-pressed={value === id} disabled={disabled?.(id)} onClick={() => onSelect(id)} style={value === id ? glow(accent) : undefined}
        className="admin-focus-ring grid aspect-square min-h-10 place-items-center rounded-lg border border-white/10 bg-slate-950/60 text-slate-300 transition hover:text-white aria-pressed:bg-slate-800 aria-pressed:text-white disabled:opacity-30">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>)}
    </div>
  );
}

export function IconToggle({ label, icon: Icon, pressed, onClick, disabled, children }: {
  label: string; icon: LucideIcon; pressed?: boolean; onClick: () => void; disabled?: boolean; children?: ReactNode;
}) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
    className="admin-focus-ring inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-slate-950/60 px-2.5 text-[11px] font-semibold text-slate-300 transition hover:text-white aria-pressed:border-fuchsia-400/60 aria-pressed:bg-fuchsia-500/15 aria-pressed:text-fuchsia-100 disabled:opacity-30">
    <Icon className="h-4 w-4" aria-hidden="true" />{children}
  </button>;
}

export function CheckChip({ label, icon: Icon, checked, onChange, children }: {
  label: string; icon: LucideIcon; checked: boolean; onChange: (checked: boolean) => void; children: ReactNode;
}) {
  return <label title={label} className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-slate-950/60 px-2.5 text-[11px] font-semibold text-slate-300 transition focus-within:ring-2 focus-within:ring-cyan-400 hover:text-white has-[:checked]:border-cyan-400/60 has-[:checked]:bg-cyan-500/15 has-[:checked]:text-cyan-100">
    <input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-400" />
    <Icon className="h-4 w-4" aria-hidden="true" />{children}
  </label>;
}

export interface MarkingCut { scope: 'none' | 'skin' | 'all'; axis: 'x' | 'y' | 'z'; position: number; reverse: boolean }
export const NO_CUT: MarkingCut = { scope: 'none', axis: 'z', position: 0.55, reverse: false };
export function CutControls({ value, onChange }: { value: MarkingCut; onChange: (cut: MarkingCut) => void }) {
  const segment = <K extends 'scope' | 'axis'>(key: K, label: string, options: [MarkingCut[K], string][]) => (
    <div role="group" aria-label={label} className="grid grid-cols-3 gap-1">
      {options.map(([id, name]) => <button key={id} type="button" aria-pressed={value[key] === id} onClick={() => onChange({ ...value, [key]: id })}
        className="admin-focus-ring min-h-9 rounded-md bg-slate-950/60 text-[11px] font-semibold text-slate-300 aria-pressed:bg-amber-400 aria-pressed:text-slate-950">{name}</button>)}
    </div>
  );
  return (
    <div className="space-y-2">
      {segment('scope', 'Alcance del corte', [['none', 'Sin corte'], ['skin', 'Piel'], ['all', 'Todo']])}
      {value.scope !== 'none' && <>
        {segment('axis', 'Eje del corte', [['x', 'Lateral'], ['y', 'Vertical'], ['z', 'Profundidad']])}
        <div className="flex items-center gap-2">
          <input type="range" aria-label="Posición del corte" min={0} max={1} step={0.01} value={value.position}
            onChange={e => onChange({ ...value, position: Number(e.target.value) })} className="flex-1 accent-amber-400" />
          <IconToggle label="Invertir corte" icon={Scissors} pressed={value.reverse} onClick={() => onChange({ ...value, reverse: !value.reverse })} />
        </div>
      </>}
    </div>
  );
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
      className="w-[min(92vw,380px)] rounded-2xl border border-white/10 bg-slate-950 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm">
      <form method="dialog" className="space-y-4 p-4" onSubmit={e => { e.preventDefault(); if (valid) onSave(value, plane); }}>
        <header className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: `${color}26`, color, ...glow(color) }}><Icon className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-black uppercase tracking-[0.16em]">Volumen · {label}</h2>
            <p className="truncate text-xs text-slate-400">{place}{count > 1 ? ` · ${count} puntos (bilateral)` : ''}</p>
          </div>
        </header>
        <div role="group" aria-label="Volúmenes rápidos" className="grid grid-cols-4 gap-1.5">
          {QUICK_VOLUMES[mode].map(v => <button key={v} type="button" aria-pressed={value === v && dose !== ''} onClick={() => setDose(String(v))}
            className="admin-focus-ring min-h-10 rounded-lg border border-white/10 bg-slate-900 text-sm font-bold aria-pressed:text-slate-950" style={value === v && dose !== '' ? { background: color } : undefined}>{v}</button>)}
        </div>
        <label className="block text-xs font-semibold text-slate-300">Volumen por punto ({unit})
          <input autoFocus required type="number" min={0} step="any" inputMode="decimal" aria-label={`Volumen por punto (${unit})`} value={dose}
            onChange={e => setDose(e.target.value)} className={`${field} mt-1 text-lg font-bold`} />
        </label>
        <label className="block text-xs font-semibold text-slate-300">Plano <span className="font-normal text-slate-500">(opcional)</span>
          <select aria-label="Plano de aplicación" value={plane} onChange={e => setPlane(e.target.value)} className={`${field} mt-1`}>
            <option value="">Sin plano</option>
            {INJECTION_PLANES[mode].map(p => <option key={p}>{p}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={onDiscard} className="admin-focus-ring min-h-11 flex-1 rounded-xl border border-white/10 text-sm font-semibold text-slate-300">Descartar punto</button>
          <button type="submit" disabled={!valid} className="admin-focus-ring min-h-11 flex-1 rounded-xl text-sm font-black text-slate-950 disabled:opacity-40" style={{ background: color }}>Guardar</button>
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
      <span className="text-slate-400">· {t.points} pt{t.pending ? ` · ${t.pending}!` : ''}</span>
    </li>)}
  </ul>;
}

export function PointLedger({ rows, selectedId, onSelect, onHover, onDose, onDelete, onPlane, children }: {
  rows: LedgerRow[]; selectedId: string | null;
  onSelect: (row: LedgerRow) => void; onHover: (row: LedgerRow | null) => void;
  onDose: (id: string, dose: number) => void; onDelete: (id: string) => void;
  onPlane: (ids: string[], plane: string) => void; children?: ReactNode;
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
  return (
    <section aria-label="Listado de puntos" className="min-w-0 rounded-2xl border border-white/10 bg-slate-950 p-3 text-slate-100">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-xs font-black uppercase tracking-[0.18em]">Puntos <span className="text-cyan-300 tabular-nums">{visible.length}/{rows.length}</span></h2>
        <Filter className="h-4 w-4 text-slate-500" aria-hidden="true" />
        <div role="group" aria-label="Filtrar por inyectable" className="flex gap-1">
          {(['all', ...MODES] as const).map(m => <button key={m} type="button" aria-pressed={filter.mode === m} onClick={() => set('mode', m)}
            title={m === 'all' ? 'Todos' : SIM_MODES[m].label}
            className="admin-focus-ring grid h-8 min-w-8 place-items-center rounded-full border border-white/10 px-2 text-[11px] font-bold text-slate-300 aria-pressed:bg-white aria-pressed:text-slate-950">
            {m === 'all' ? 'Todos' : <span className="h-2.5 w-2.5 rounded-full" style={{ background: SIM_MODES[m].color }}><span className="sr-only">{SIM_MODES[m].label}</span></span>}
          </button>)}
        </div>
      </header>
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <select aria-label="Filtrar por zona" value={filter.zone} onChange={e => set('zone', e.target.value)} className={field}>
          <option value="all">Todas las zonas</option>{zones.map(z => <option key={z}>{z}</option>)}
        </select>
        <select aria-label="Filtrar por tercio" value={filter.third} onChange={e => set('third', e.target.value as LedgerFilter['third'])} className={field}>
          <option value="all">Todos los tercios</option>{THIRDS.map(([id, name]) => <option key={id} value={id}>Tercio {name.toLowerCase()}</option>)}
        </select>
        <select aria-label="Filtrar por volumen" value={filter.volume} onChange={e => set('volume', e.target.value as LedgerFilter['volume'])} className={field}>
          <option value="all">Todo volumen</option><option value="with">Con volumen</option><option value="without">Sin volumen</option>
        </select>
      </div>
      {rows.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-slate-900/70 p-2">
        <label className="flex min-h-10 items-center gap-2 text-xs font-semibold text-slate-300">
          <input type="checkbox" aria-label="Seleccionar todos los puntos visibles" checked={visible.length > 0 && picked.length === visible.length}
            onChange={e => setChecked(e.target.checked ? new Set(visible.map(r => r.id)) : new Set())} className="h-4 w-4 accent-cyan-400" />
          {picked.length ? `${picked.length} seleccionados` : 'Lote: visibles'}
        </label>
        <select aria-label="Plano para el lote" value={bulkPlane} onChange={e => setBulkPlane(e.target.value)} className={`${field} w-auto flex-1`}>
          <option value="">Sin plano</option>{planes.map(p => <option key={p}>{p}</option>)}
        </select>
        <button type="button" disabled={!targets.length} onClick={() => onPlane(targets.map(r => r.id), bulkPlane)}
          className="admin-focus-ring min-h-10 rounded-lg bg-cyan-400 px-3 text-xs font-black text-slate-950 disabled:opacity-40">Aplicar plano ({targets.length})</button>
      </div>}
      {!rows.length && <p className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-slate-400">Elige una herramienta y marca sobre el rostro.</p>}
      <ul aria-label="Elementos marcados" className="max-h-[26rem] space-y-1.5 overflow-auto pr-1 [content-visibility:auto]">
        {visible.map(r => {
          const { color, unit, label } = SIM_MODES[r.mode], [sideShort, sideLong] = SIDE[r.side], active = selectedId === r.id;
          return <li key={r.id} onPointerEnter={() => onHover(r)} onPointerLeave={() => onHover(null)}
            className={`flex flex-wrap items-center gap-2 rounded-xl border bg-slate-900/70 p-1.5 pl-2 transition ${active ? 'border-cyan-400/70' : 'border-white/5'}`}
            style={active ? glow(color) : { borderLeft: `3px solid ${color}` }}>
            <input type="checkbox" aria-label={`Incluir marca ${r.index} en lote`} checked={checked.has(r.id)} className="h-4 w-4 accent-cyan-400"
              onChange={e => setChecked(c => { const n = new Set(c); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
            <button type="button" aria-pressed={active} aria-label={`Seleccionar marca ${r.index}`} onFocus={() => onHover(r)} onBlur={() => onHover(null)}
              onClick={() => onSelect(r)} className="admin-focus-ring flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg text-left">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-black text-slate-950" style={{ background: color }}>{r.index}</span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold">{r.zone}</span>
                <span className="block truncate text-[10px] text-slate-400">{r.product || label}{r.plane ? ` · ${r.plane}` : ''}{r.kind !== 'point' ? ` · ${r.kind}` : ''}</span>
              </span>
            </button>
            <span title={sideLong} className="grid h-6 w-6 place-items-center rounded-md bg-slate-800 text-[10px] font-black text-slate-200">{sideShort}<span className="sr-only">{sideLong}</span></span>
            {r.extended && <span title="Solo en el modelo completo; no se transfiere a la máscara" className="rounded-md bg-amber-400/15 px-1.5 py-1 text-[10px] font-bold text-amber-300">3D</span>}
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              <input type="number" min={0} step="any" inputMode="decimal" value={r.dose} aria-label={`Dosis marca ${r.index}`}
                onChange={e => onDose(r.id, Number(e.target.value))} className="admin-focus-ring min-h-9 w-16 rounded-md border border-white/10 bg-slate-950 px-1.5 text-right text-sm font-bold tabular-nums text-white" />
              {unit}
            </label>
            <button type="button" aria-label={`Eliminar marca ${r.index}`} title="Eliminar" onClick={() => onDelete(r.id)}
              className="admin-focus-ring grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-red-500/15 hover:text-red-300"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </li>;
        })}
      </ul>
      {children}
    </section>
  );
}
