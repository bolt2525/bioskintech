import { useId, useMemo, useState } from 'react';
import { SIM_MODES, type Meta } from './engine';
import type { AnatomicalBindings } from './anatomicalAnnotations';
import {
  quickGroupKey, quickGroupSummary, quickRecordGroups,
  type QuickAmounts, type QuickGroup, type QuickRecordSettings,
} from './quickRecord';

interface Props {
  meta: Record<string, Meta>;
  bindings: AnatomicalBindings;
  value: QuickRecordSettings;
  onChange: (value: QuickRecordSettings) => void;
  onApply: (meta: Record<string, Meta>, settings?: QuickRecordSettings) => void;
}
const inputClass = 'admin-focus-ring min-h-10 w-full min-w-0 rounded border border-slate-300 bg-white px-2 text-sm text-slate-900';
const format = (n: number) => new Intl.NumberFormat('es', { maximumFractionDigits: 4 }).format(n);

function GroupRecord({ group, meta, value, onChange, onApply }: Props & { group: QuickGroup }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const unit = SIM_MODES[group.mode].unit;
  const current = value.entries[group.key] ?? { total: null, zones: {} };
  const summary = quickGroupSummary(group, current);
  const update = (changes: Partial<QuickAmounts>) => onChange({
    ...value, entries: { ...value.entries, [group.key]: { ...current, ...changes } },
  });
  const quantity = (raw: string, commit: (amount: number | null) => void) => {
    const amount = raw.trim() ? Number(raw) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setError('Introduce una cantidad no negativa; deja vacío si aún no la conoces.');
      return;
    }
    setError(null);
    commit(amount);
  };
  return <fieldset className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-3">
    <legend className="px-1 text-sm font-semibold">{SIM_MODES[group.mode].label} · {group.product || 'Vial sin nombre'}</legend>
    <form aria-label={`Nombre de vial ${SIM_MODES[group.mode].label} ${group.product}`} className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        const product = String(new FormData(event.currentTarget).get('product') ?? '').trim();
        if (!product || product.length > 500) { setError('Indica un nombre de vial entre 1 y 500 caracteres.'); return; }
        const key = quickGroupKey(group.mode, product);
        if (key !== group.key && value.entries[key]) {
          setError('Ese vial ya tiene cantidades. Usa un nombre distinto para no mezclar sus registros.'); return;
        }
        setError(null);
        const renamed = Object.fromEntries(Object.entries(meta).map(([elementId, properties]) => [
          elementId, group.elements.includes(elementId) ? { ...properties, product } : properties,
        ]));
        let nextSettings: QuickRecordSettings | undefined;
        if (key !== group.key && value.entries[group.key]) {
          const entries = { ...value.entries, [key]: current };
          delete entries[group.key];
          nextSettings = { ...value, entries };
        }
        onApply(renamed, nextSettings);
      }}>
      <label className="min-w-[140px] flex-1 text-xs" htmlFor={`${id}-product`}>Nombre del vial
        <input key={group.product} id={`${id}-product`} name="product" autoComplete="off" maxLength={500}
          defaultValue={group.product} className={inputClass} />
      </label>
      <button type="submit" className="admin-focus-ring min-h-10 rounded border border-slate-300 px-3 text-xs hover:bg-slate-50">Guardar nombre</button>
    </form>
    <label htmlFor={`${id}-total`} className="block text-xs">Total aplicado declarado ({unit}) · opcional para conciliar
      <input id={`${id}-total`} aria-label={`Total declarado ${SIM_MODES[group.mode].label} ${group.product}`}
        type="number" min="0" step="any" inputMode="decimal" value={current.total ?? ''}
        onChange={event => quantity(event.target.value, total => update({ total }))} className={inputClass} />
    </label>
    <p className="text-xs text-slate-500">No es la capacidad del vial{group.mode === 'toxina' ? ' ni el diluyente. Las U son propias del producto, no se convierten entre marcas.' : '.'}</p>
    <div className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">
      {group.zones.map(zone => <label key={zone.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 rounded border border-slate-100 p-2 text-xs">
        <span className="min-w-0 break-words"><strong>{zone.zone}</strong> · {zone.side}<br />
          Tercio {zone.third} · {zone.elements.length} marca(s)</span>
        <span><input aria-label={`${zone.zone} ${zone.side} tercio ${zone.third} ${SIM_MODES[group.mode].label} ${group.product} (${unit})`}
          type="number" min="0" step="any" inputMode="decimal" value={current.zones[zone.key] ?? ''}
          onChange={event => quantity(event.target.value, amount => update({ zones: { ...current.zones, [zone.key]: amount } }))}
          className={`${inputClass} tabular-nums`} />{unit}</span>
      </label>)}
    </div>
    <div aria-live="polite" className="space-y-1 rounded-lg bg-slate-50 p-2 text-xs tabular-nums">
      <p className="font-semibold">Total por zonas: {format(summary.assigned)} {unit} · {summary.pending} pendiente(s)</p>
      <p>Superior: {format(summary.thirds.superior)} · Medio: {format(summary.thirds.medio)} · Inferior: {format(summary.thirds.inferior)} {unit}</p>
      {summary.difference !== null && <p className={Math.abs(summary.difference) > 1e-8 ? 'font-semibold text-amber-800' : 'text-emerald-800'}>
        {Math.abs(summary.difference) <= 1e-8 ? 'Total declarado y zonas coinciden.' : `Diferencia declarada − zonas: ${format(summary.difference)} ${unit}. Revisa el registro.`}
      </p>}
      {summary.stale.length > 0 && <p className="text-amber-800">{summary.stale.length} zona(s) con {format(summary.orphaned)} {unit} ya no tienen marcas. Se conservan en el JSON, pero no se suman al resumen activo. Deshaz el cambio o revisa sus cantidades.</p>}
    </div>
    {summary.stale.length > 0 && <details className="text-xs">
      <summary className="admin-focus-ring cursor-pointer font-semibold">Revisar zonas sin marcas</summary>
      <ul className="space-y-2 pt-2">{summary.stale.map(key => {
        const [third, zone, side] = JSON.parse(key) as [string, string, string];
        return <li key={key} className="flex flex-wrap items-center justify-between gap-2">
          <span>{zone} · {side} · {third}: {format(current.zones[key]!)} {unit}</span>
          <button type="button" className="admin-focus-ring min-h-10 rounded border px-2 hover:bg-slate-50"
            onClick={() => {
              const zones = { ...current.zones };
              delete zones[key];
              update({ zones });
            }}>Retirar cantidad sin marcas</button>
        </li>;
      })}</ul>
    </details>}
    {error && <p role="alert" className="text-xs font-semibold text-red-700">{error}</p>}
  </fieldset>;
}

export default function QuickInjectableRecord(props: Props) {
  const result = useMemo(() => {
    try { return { groups: quickRecordGroups(props.meta, props.bindings), error: null }; }
    catch (cause) { return { groups: [], error: cause instanceof Error ? cause.message : 'No se pudieron identificar las zonas.' }; }
  }, [props.meta, props.bindings]);
  const active = new Set(result.groups.map(group => group.key));
  const orphaned = Object.keys(props.value.entries).filter(key => !active.has(key));
  return <section aria-label="Registro rápido por zonas" className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
    <h2 className="text-sm font-semibold">Registro rápido · cantidades por zona</h2>
    <p className="text-xs text-slate-600">Marca → indica el nombre del vial → registra U/ml por zona. Los tercios se suman automáticamente, sin asignar dosis a puntos ni trazos.</p>
    <p className="text-xs text-slate-500">Zonas cutáneas y lados del paciente; no cambian al explorar músculo, arterias o hueso. Se identifican por el recorrido y el centro de los contornos, no por toda su área interior. Una marca puede aparecer en varias zonas: registra solo la cantidad aplicada en cada una. Vacío = pendiente; 0 = cero confirmado.</p>
    {result.error && <p role="alert" className="text-sm text-red-700">{result.error}</p>}
    {!result.error && !result.groups.length && <p className="text-sm text-slate-500">Añade una marcación para identificar sus zonas.</p>}
    {result.groups.map(group => <GroupRecord key={group.key} {...props} group={group} />)}
    {orphaned.length > 0 && <details className="text-xs text-amber-800">
      <summary className="admin-focus-ring cursor-pointer">{orphaned.length} vial(es) sin marcas activas · revisar cantidades conservadas</summary>
      <p className="py-2">No se incluyen en el resumen activo; se conservan para deshacer y exportar.</p>
      <ul className="space-y-2">{orphaned.map(key => {
        const [mode, product] = JSON.parse(key) as [keyof typeof SIM_MODES, string];
        const entry = props.value.entries[key];
        return <li key={key} className="space-y-1">
          <strong>{SIM_MODES[mode].label} · {product || 'Vial sin nombre'}</strong>
          <p>Declarado: {entry.total === null ? 'pendiente' : `${format(entry.total)} ${SIM_MODES[mode].unit}`}</p>
          {Object.entries(entry.zones).map(([zoneKey, amount]) => {
            const [third, zone, side] = JSON.parse(zoneKey) as [string, string, string];
            return <p key={zoneKey}>{zone} · {side} · {third}: {amount === null ? 'pendiente' : `${format(amount)} ${SIM_MODES[mode].unit}`}</p>;
          })}
          <button type="button" className="admin-focus-ring min-h-10 rounded border px-2 hover:bg-amber-50" onClick={() => {
            const entries = { ...props.value.entries };
            delete entries[key];
            props.onChange({ ...props.value, entries });
          }}>Retirar cantidades del vial sin marcas</button>
        </li>;
      })}</ul>
    </details>}
    <p className="text-xs font-semibold text-amber-800">Solo laboratorio local. Exporta el JSON antes de salir: aún no guarda en ficha clínica. Las cantidades detalladas importadas son independientes de estos totales; no se suman dos veces.</p>
  </section>;
}
