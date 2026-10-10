import { Check, ChevronDown, Info } from 'lucide-react';
import { useRef, useState } from 'react';

export interface ToxinaSessionFields {
  date: string;
  product_name: string;
  brand: string;
  lot_number: string;
  expiration_date: string;
  units_used: number | string;
  dilution_volume: number | string;
  technique: string;
  injection_plane: string;
  needle_type: string;
  follow_up_date: string;
  notes: string;
}

interface Props {
  value: ToxinaSessionFields;
  onChange: (patch: Partial<ToxinaSessionFields>) => void;
  brands: string[];
  needles: string[];
  dateLocked: boolean;
  onUnlockDate: () => void;
  vialUnits: string;
  onVialUnitsChange: (value: string) => void;
  concentration: number | null;
  error: { field: string; text: string } | null;
}

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/30 disabled:bg-slate-100 disabled:text-slate-500';
const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700';
const TOXINA_TECHNIQUES = ['Inyección puntual', 'Microinyecciones'];
const TOXINA_PLANES = ['Intramuscular', 'Intradérmico', 'Subdérmico', 'Subcutáneo'];

function DocumentedSelect({ id, label, value, options, help, onChange }: {
  id: string; label: string; value: string; options: string[]; help: string; onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const isCustom = custom || (value !== '' && !options.includes(value));
  const choices = ['', ...options, '__custom__'];
  const selected = isCustom ? '__custom__' : value;
  const choiceLabel = (choice: string) => choice === '__custom__' ? 'Escribir valor personalizado…' : choice || 'Sin especificar';
  const choose = (choice: string) => {
    setCustom(choice === '__custom__');
    if (choice !== '__custom__') onChange(choice);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div>
      <label className={labelClass} htmlFor={id}>{label}</label>
      <div className="relative" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
        <button id={id} ref={trigger} type="button" role="combobox" aria-expanded={open}
          aria-controls={`${id}-options`} aria-haspopup="listbox" aria-describedby={`${id}-help`}
          aria-activedescendant={open ? `${id}-option-${active}` : undefined}
          className={`${inputClass} flex items-center justify-between gap-2 text-left hover:border-gold`}
          onClick={() => { setActive(Math.max(0, choices.indexOf(selected))); setOpen(previous => !previous); }}
          onKeyDown={event => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
                : !open ? Math.max(0, choices.indexOf(selected))
                : Math.max(0, Math.min(choices.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
              setActive(next);
              document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (open && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              choose(choices[active]);
            }
          }}>
          <span className={value || isCustom ? 'text-slate-800' : 'text-slate-400'}>
            {isCustom ? value || 'Valor personalizado…' : value || 'Seleccionar…'}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-gold-ink ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {open && <ul id={`${id}-options`} role="listbox" aria-label={label}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-56 overflow-y-auto rounded-xl border border-gold/40 bg-white p-1 shadow-xl">
          {choices.map((choice, index) => (
            <li id={`${id}-option-${index}`} key={choice} role="option" aria-selected={choice === selected}
              onMouseDown={event => event.preventDefault()} onClick={() => choose(choice)} onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm ${
                index === active ? 'bg-gold-light text-gold-ink' : 'text-slate-700 hover:bg-gold-light'
              }`}>
              {choiceLabel(choice)}{choice === selected && <Check className="h-4 w-4 shrink-0 text-gold-ink" aria-hidden="true" />}
            </li>
          ))}
        </ul>}
      </div>
      {isCustom && <>
        <label className="sr-only" htmlFor={`${id}-custom`}>{label}: valor personalizado</label>
        <input id={`${id}-custom`} className={`${inputClass} mt-2`} value={value} aria-describedby={`${id}-help`}
          onChange={event => onChange(event.target.value)} placeholder="Describe lo utilizado…" />
      </>}
      <p id={`${id}-help`} className="mt-1.5 text-xs leading-relaxed text-slate-500">{help}</p>
    </div>
  );
}

export default function ToxinaSessionForm({
  value, onChange, brands, needles, dateLocked, onUnlockDate,
  vialUnits, onVialUnitsChange, concentration, error,
}: Props) {
  const fieldError = (field: string) => error?.field === field ? (
    <p id={`toxina-${field}-error`} className="mt-1 text-sm text-red-700" role="alert">{error.text}</p>
  ) : null;
  return (
    <div className="space-y-5 p-5">
      <section aria-labelledby="toxina-product-heading">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h3 id="toxina-product-heading" className="text-base font-semibold text-slate-900">1. Producto y sesión</h3>
          <span className="text-xs text-slate-500">* Obligatorio</span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <label className={labelClass} htmlFor="toxina-product_name">Producto comercial *</label>
            <input id="toxina-product_name" name="product_name" autoComplete="off" className={inputClass}
              value={value.product_name} onChange={event => onChange({ product_name: event.target.value })}
              placeholder="Nombre exacto del producto…" aria-required="true" aria-invalid={error?.field === 'product_name'}
              aria-describedby={`toxina-product-help${error?.field === 'product_name' ? ' toxina-product_name-error' : ''}`} />
            {fieldError('product_name')}
            <p id="toxina-product-help" className="mt-1.5 text-xs text-slate-500">Nombre comercial exacto del producto aplicado, según su etiqueta.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-date">Fecha de aplicación *</label>
            <div className="flex items-center gap-2">
              <input id="toxina-date" name="date" type="date" className={inputClass} value={value.date}
                disabled={dateLocked} onChange={event => onChange({ date: event.target.value })}
                aria-required="true" aria-invalid={error?.field === 'date'}
                aria-describedby={`toxina-date-help${error?.field === 'date' ? ' toxina-date-error' : ''}`} />
              {dateLocked && <button type="button" onClick={onUnlockDate} className="text-xs font-medium text-gold-ink hover:underline">Editar</button>}
            </div>
            {fieldError('date')}
            <p id="toxina-date-help" className="mt-1.5 text-xs text-slate-500">Día en que se realizó la aplicación, no la fecha de control.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-brand">Marca / presentación</label>
            <input id="toxina-brand" name="brand" autoComplete="off" list="toxina-brands" className={inputClass}
              value={value.brand} onChange={event => onChange({ brand: event.target.value })} placeholder="Según etiqueta del vial…" aria-describedby="toxina-brand-help" />
            <datalist id="toxina-brands">{brands.map(brand => <option key={brand} value={brand} />)}</datalist>
            <p id="toxina-brand-help" className="mt-1.5 text-xs text-slate-500">Identifica la marca y presentación. Sus unidades no se convierten entre productos.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-lot_number">Lote</label>
            <input id="toxina-lot_number" name="lot_number" autoComplete="off" spellCheck={false} className={inputClass}
              value={value.lot_number} onChange={event => onChange({ lot_number: event.target.value })} placeholder="Lote del producto…" aria-describedby="toxina-lot-help" />
            <p id="toxina-lot-help" className="mt-1.5 text-xs text-slate-500">Código del envase para identificar el lote utilizado.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-expiration_date">Vencimiento</label>
            <input id="toxina-expiration_date" name="expiration_date" type="date" className={inputClass}
              value={value.expiration_date} onChange={event => onChange({ expiration_date: event.target.value })} aria-describedby="toxina-expiration-help" />
            <p id="toxina-expiration-help" className="mt-1.5 text-xs text-slate-500">Caducidad indicada en el envase; no equivale al plazo tras reconstituir.</p>
          </div>
        </div>
      </section>

      <details className="rounded-xl border border-slate-200">
        <summary className="flex cursor-pointer items-center justify-between gap-3 p-3 text-sm font-medium text-slate-700">
          2. Preparación del vial <span className="flex items-center gap-2 text-xs text-slate-500">{vialUnits !== '' || value.dilution_volume !== '' ? 'Con datos' : 'Opcional'} <ChevronDown className="h-4 w-4" aria-hidden="true" /></span>
        </summary>
        <div className="space-y-3 border-t border-slate-100 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="toxina-vial_units">Unidades originales del vial (U)</label>
              <input id="toxina-vial_units" name="vial_units" type="number" min="0" step="any" className={inputClass}
                value={vialUnits} onChange={event => onVialUnitsChange(event.target.value)} placeholder="Según presentación del fabricante…"
                aria-invalid={error?.field === 'vial_units'} aria-describedby={`toxina-vial-units-help${error?.field === 'vial_units' ? ' toxina-vial_units-error' : ''}`} />
              {fieldError('vial_units')}
              <p id="toxina-vial-units-help" className="mt-1.5 text-xs text-slate-500">Cantidad de unidades de la presentación original, antes de la aplicación. No es el total usado en esta sesión.</p>
            </div>
            <div>
              <label className={labelClass} htmlFor="toxina-dilution_volume">Diluyente añadido al vial (ml)</label>
              <input id="toxina-dilution_volume" name="dilution_volume" type="number" min="0" step="any" className={inputClass}
                value={value.dilution_volume} onChange={event => onChange({ dilution_volume: event.target.value })} placeholder="Volumen real de reconstitución…"
                aria-invalid={error?.field === 'dilution_volume'} aria-describedby={`toxina-dilution-help${error?.field === 'dilution_volume' ? ' toxina-dilution_volume-error' : ''}`} />
              {fieldError('dilution_volume')}
              <p id="toxina-dilution-help" className="mt-1.5 text-xs text-slate-500">Volumen real añadido para reconstituir este vial. Junto con sus unidades originales permite calcular U/ml.</p>
            </div>
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {concentration === null
              ? 'La concentración requiere las unidades originales del vial y el diluyente. No se calcula usando el total aplicado en la sesión.'
              : `Concentración documentada: ${new Intl.NumberFormat('es-EC', { maximumFractionDigits: 2 }).format(concentration)} U/ml (unidades del vial ÷ diluyente).`}
          </p>
          <p className="text-xs text-slate-500">Comprueba diluyente y reconstitución en la ficha técnica del producto. No se infiere la presentación a partir de la marca ni se asigna dosis.</p>
        </div>
      </details>

      <section className="border-t border-slate-100 pt-4" aria-labelledby="toxina-application-heading">
        <h3 id="toxina-application-heading" className="mb-4 text-base font-semibold text-slate-900">3. Técnica de aplicación</h3>
        <div className="grid grid-cols-3 gap-4">
          <DocumentedSelect id="toxina-technique" label="Técnica utilizada" value={value.technique}
            options={TOXINA_TECHNIQUES} onChange={next => onChange({ technique: next })}
            help="Forma de aplicación realizada. Puedes elegir una opción o describir otra técnica; no se prescribe un protocolo." />
          <DocumentedSelect id="toxina-injection_plane" label="Plano anatómico utilizado" value={value.injection_plane}
            options={TOXINA_PLANES} onChange={next => onChange({ injection_plane: next })}
            help="Tejido donde se realizó la aplicación. Documenta lo utilizado según el producto y procedimiento, sin recomendaciones automáticas." />
          <DocumentedSelect id="toxina-needle_type" label="Aguja utilizada" value={value.needle_type}
            options={needles.filter(needle => !/cánula|canula/i.test(needle))} onChange={next => onChange({ needle_type: next })}
            help="Calibre y longitud del dispositivo: G indica calibre y mm longitud. Comprueba ambos en el envase." />
        </div>
      </section>
    </div>
  );
}

export function ToxinaApplicationTotal({ units, unitsFromMap, mappedUnits, onChange, onManualUnits, error }: {
  units: number | string; unitsFromMap: boolean; mappedUnits: number; onChange: (units: string) => void;
  onManualUnits: () => void; error: Props['error'];
}) {
  return (
    <div className="grid grid-cols-[14rem_1fr] items-start gap-5 border-t border-slate-100 bg-gold-light/30 p-4">
      <div>
        <label className={labelClass} htmlFor="toxina-units_used">Total aplicado en sesión (U)</label>
        <input id="toxina-units_used" name="units_used" type="number" min="0" step="any" inputMode="decimal"
          readOnly={unitsFromMap} className={inputClass} value={units} onChange={event => onChange(event.target.value)}
          placeholder="Total aplicado…" aria-invalid={error?.field === 'units_used'}
          aria-describedby={`toxina-units-note${error?.field === 'units_used' ? ' toxina-units_used-error' : ''}`} />
        {error?.field === 'units_used' && <p id="toxina-units_used-error" className="mt-1 text-sm text-red-700" role="alert">{error.text}</p>}
      </div>
      <div>
        <span className="text-xs font-semibold text-gold-ink">{unitsFromMap ? 'Automático · desde el mapa 3D' : 'Registro manual · sin mapa 3D'}</span>
        <p id="toxina-units-note" className="mt-1.5 text-xs leading-relaxed text-slate-600">{unitsFromMap
          ? 'Suma automática de las unidades de cada punto. Cambia al añadir, editar, eliminar o deshacer puntos. No es la capacidad del vial.'
          : 'Si no usas el modelo 3D, escribe el total realmente aplicado. Al registrar puntos, este campo pasa a sumar sus unidades automáticamente.'}</p>
        {unitsFromMap && mappedUnits === 0 && <button type="button" onClick={onManualUnits}
          className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
          Registrar total sin mapa
        </button>}
      </div>
    </div>
  );
}

export function ToxinaFollowUpForm({ value, onChange }: Pick<Props, 'value' | 'onChange'>) {
  return (
      <details className="rounded-xl border border-slate-200">
        <summary className="cursor-pointer p-3 text-sm font-medium text-slate-700">5. Seguimiento y observaciones <span className="ml-2 text-xs font-normal text-slate-500">{value.follow_up_date || value.notes ? 'Con datos' : 'Opcional'}</span></summary>
        <div className="grid grid-cols-3 gap-4 border-t border-slate-100 p-4">
          <div>
            <label className={labelClass} htmlFor="toxina-follow_up_date">Fecha de control</label>
            <input id="toxina-follow_up_date" name="follow_up_date" type="date" className={inputClass}
              value={value.follow_up_date} onChange={event => onChange({ follow_up_date: event.target.value })} aria-describedby="toxina-follow-up-help" />
            <p id="toxina-follow-up-help" className="mt-1.5 text-xs text-slate-500">Fecha acordada para revisar la evolución, cuando corresponda.</p>
          </div>
          <div className="col-span-2">
            <label className={labelClass} htmlFor="toxina-notes">Observaciones clínicas</label>
            <textarea id="toxina-notes" name="notes" rows={3} className={inputClass} value={value.notes}
              onChange={event => onChange({ notes: event.target.value })} placeholder="Incidencias y seguimiento de la sesión…" aria-describedby="toxina-notes-help" />
            <p id="toxina-notes-help" className="mt-1.5 text-xs text-slate-500">Observaciones, incidencias y particularidades que no quedan descritas en los otros campos.</p>
          </div>
        </div>
      </details>
  );
}
