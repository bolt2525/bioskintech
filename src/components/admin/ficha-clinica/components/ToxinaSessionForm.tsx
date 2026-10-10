import { ChevronDown, Info } from 'lucide-react';

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
  mappedUnits: number;
  error: { field: string; text: string } | null;
}

const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/30 disabled:bg-slate-100 disabled:text-slate-500';
const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700';
const TOXINA_TECHNIQUES = ['Inyección puntual', 'Microinyecciones'];

export default function ToxinaSessionForm({
  value, onChange, brands, needles, dateLocked, onUnlockDate,
  vialUnits, onVialUnitsChange, concentration, mappedUnits, error,
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
              aria-describedby={error?.field === 'product_name' ? 'toxina-product_name-error' : undefined} />
            {fieldError('product_name')}
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-date">Fecha de aplicación *</label>
            <div className="flex items-center gap-2">
              <input id="toxina-date" name="date" type="date" className={inputClass} value={value.date}
                disabled={dateLocked} onChange={event => onChange({ date: event.target.value })}
                aria-required="true" aria-invalid={error?.field === 'date'}
                aria-describedby={error?.field === 'date' ? 'toxina-date-error' : undefined} />
              {dateLocked && <button type="button" onClick={onUnlockDate} className="text-xs font-medium text-gold-ink hover:underline">Editar</button>}
            </div>
            {fieldError('date')}
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-brand">Marca / presentación</label>
            <input id="toxina-brand" name="brand" autoComplete="off" list="toxina-brands" className={inputClass}
              value={value.brand} onChange={event => onChange({ brand: event.target.value })} placeholder="Según etiqueta del vial…" />
            <datalist id="toxina-brands">{brands.map(brand => <option key={brand} value={brand} />)}</datalist>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-lot_number">Lote</label>
            <input id="toxina-lot_number" name="lot_number" autoComplete="off" spellCheck={false} className={inputClass}
              value={value.lot_number} onChange={event => onChange({ lot_number: event.target.value })} placeholder="Lote del producto…" />
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-expiration_date">Vencimiento</label>
            <input id="toxina-expiration_date" name="expiration_date" type="date" className={inputClass}
              value={value.expiration_date} onChange={event => onChange({ expiration_date: event.target.value })} />
          </div>
        </div>
      </section>

      <section className="border-t border-slate-100 pt-4" aria-labelledby="toxina-application-heading">
        <h3 id="toxina-application-heading" className="mb-4 text-base font-semibold text-slate-900">2. Aplicación registrada</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="toxina-units_used">Total declarado en sesión (U)</label>
            <input id="toxina-units_used" name="units_used" type="number" min="0" step="any" inputMode="decimal" className={inputClass}
              value={value.units_used} onChange={event => onChange({ units_used: event.target.value })} placeholder="Total aplicado…"
              aria-invalid={error?.field === 'units_used'} aria-describedby={`toxina-units-note${error?.field === 'units_used' ? ' toxina-units_used-error' : ''}`} />
            {fieldError('units_used')}
            <p id="toxina-units-note" className="mt-1.5 text-xs text-slate-500">El mapa registra {mappedUnits} U. Este total no indica la capacidad del vial.</p>
            {mappedUnits > 0 && <button type="button" onClick={() => onChange({ units_used: mappedUnits })}
              className="mt-2 rounded-lg border border-gold/40 bg-gold-light px-3 py-2 text-xs font-semibold text-gold-ink hover:border-gold">
              Usar {mappedUnits} U del mapa
            </button>}
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-injection_plane">Plano anatómico utilizado</label>
            <input id="toxina-injection_plane" name="injection_plane" className={inputClass} value={value.injection_plane}
              onChange={event => onChange({ injection_plane: event.target.value })} placeholder="Tejido / plano realmente utilizado…" />
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-technique">Técnica utilizada</label>
            <input id="toxina-technique" name="technique" autoComplete="off" list="toxina-techniques" className={inputClass}
              value={value.technique} onChange={event => onChange({ technique: event.target.value })} placeholder="Registrar técnica realizada…" />
            <datalist id="toxina-techniques">{TOXINA_TECHNIQUES.map(technique => <option key={technique} value={technique} />)}</datalist>
          </div>
          <div>
            <label className={labelClass} htmlFor="toxina-needle_type">Aguja utilizada</label>
            <input id="toxina-needle_type" name="needle_type" autoComplete="off" list="toxina-needles" className={inputClass}
              value={value.needle_type} onChange={event => onChange({ needle_type: event.target.value })} placeholder="Calibre y longitud…" />
            <datalist id="toxina-needles">{needles.filter(needle => !/cánula|canula/i.test(needle)).map(needle => <option key={needle} value={needle} />)}</datalist>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">Registra lo realizado, sin recomendaciones automáticas. Las unidades de distintas toxinas no son intercambiables. Las líneas y formas del visor no representan dosis.</p>
      </section>

      <details className="rounded-xl border border-slate-200">
        <summary className="flex cursor-pointer items-center justify-between gap-3 p-3 text-sm font-medium text-slate-700">
          Preparación del vial <span className="flex items-center gap-2 text-xs text-slate-500">{vialUnits !== '' || value.dilution_volume !== '' ? 'Con datos' : 'Opcional'} <ChevronDown className="h-4 w-4" aria-hidden="true" /></span>
        </summary>
        <div className="space-y-3 border-t border-slate-100 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="toxina-vial_units">Unidades originales del vial (U)</label>
              <input id="toxina-vial_units" name="vial_units" type="number" min="0" step="any" className={inputClass}
                value={vialUnits} onChange={event => onVialUnitsChange(event.target.value)} placeholder="Según presentación del fabricante…"
                aria-invalid={error?.field === 'vial_units'} aria-describedby={error?.field === 'vial_units' ? 'toxina-vial_units-error' : undefined} />
              {fieldError('vial_units')}
            </div>
            <div>
              <label className={labelClass} htmlFor="toxina-dilution_volume">Diluyente añadido al vial (ml)</label>
              <input id="toxina-dilution_volume" name="dilution_volume" type="number" min="0" step="any" className={inputClass}
                value={value.dilution_volume} onChange={event => onChange({ dilution_volume: event.target.value })} placeholder="Volumen real de reconstitución…"
                aria-invalid={error?.field === 'dilution_volume'} aria-describedby={error?.field === 'dilution_volume' ? 'toxina-dilution_volume-error' : undefined} />
              {fieldError('dilution_volume')}
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

      <details className="rounded-xl border border-slate-200">
        <summary className="cursor-pointer p-3 text-sm font-medium text-slate-700">Seguimiento y observaciones <span className="ml-2 text-xs font-normal text-slate-500">{value.follow_up_date || value.notes ? 'Con datos' : 'Opcional'}</span></summary>
        <div className="grid grid-cols-3 gap-4 border-t border-slate-100 p-4">
          <div>
            <label className={labelClass} htmlFor="toxina-follow_up_date">Fecha de control</label>
            <input id="toxina-follow_up_date" name="follow_up_date" type="date" className={inputClass}
              value={value.follow_up_date} onChange={event => onChange({ follow_up_date: event.target.value })} />
          </div>
          <div className="col-span-2">
            <label className={labelClass} htmlFor="toxina-notes">Observaciones clínicas</label>
            <textarea id="toxina-notes" name="notes" rows={3} className={inputClass} value={value.notes}
              onChange={event => onChange({ notes: event.target.value })} placeholder="Incidencias y seguimiento de la sesión…" />
          </div>
        </div>
      </details>
    </div>
  );
}
