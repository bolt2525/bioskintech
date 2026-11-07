import { Edit2, Trash2 } from 'lucide-react';
import { emptySkinFilter, matchesSkinFilter } from './skinMarkPresentation';
import type { SkinListRow, SkinListFilter } from './skinMarkPresentation';
import { skinRegionCells } from './skinAnatomy';

/** Una lista para originales y evaluación; los filtros nunca alteran el modelo clínico. */
export default function SkinMarkList({ rows, filter, onFilter, catalog, zoneCatalog, hovered, onHover, disabled = false }: {
  rows: SkinListRow[]; filter: SkinListFilter; onFilter: (filter: SkinListFilter) => void;
  catalog: readonly string[]; hovered?: string | null; onHover: (id: string | null) => void; disabled?: boolean;
  zoneCatalog?: readonly string[];
}) {
  const visible = rows.filter(row => matchesSkinFilter(row, filter));
  const zones = [...new Set([...(zoneCatalog ?? skinRegionCells().map(cell => cell.label)), ...rows.map(row => row.zone || 'Sin zona'), 'Sin zona'])].sort();
  const lesions = [...new Set([...catalog, ...rows.map(row => row.label)])].sort();
  const button = 'admin-focus-ring min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50';
  return <section aria-label="Marcas de la evaluación" className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 text-gray-900">
    <div className="flex flex-wrap items-end gap-3">
      <h4 className="mr-auto font-semibold">Lesiones marcadas <span className="block text-xs font-normal text-gray-600" role="status">{visible.length} mostradas / {rows.length} total</span></h4>
      <label className="min-w-0 text-sm">Filtrar por zona
        <select aria-label="Filtrar por zona" className={`${button} block w-full max-w-64`} value={filter.zone}
          onChange={e => onFilter({ ...filter, zone: e.target.value })}>
          <option value="">Todas las zonas</option>{zones.map(zone => <option key={zone}>{zone}</option>)}
        </select>
      </label>
      <label className="min-w-0 text-sm">Filtrar por lesión
        <select aria-label="Filtrar por lesión" className={`${button} block w-full max-w-64`} value={filter.lesion}
          onChange={e => onFilter({ ...filter, lesion: e.target.value })}>
          <option value="">Todas las lesiones</option>{lesions.map(lesion => <option key={lesion}>{lesion}</option>)}
        </select>
      </label>
      <button type="button" className={button} disabled={!filter.zone && !filter.lesion} onClick={() => onFilter(emptySkinFilter)}>Borrar filtros</button>
    </div>
    <div className="grid max-h-72 grid-cols-1 gap-2 overflow-auto overscroll-contain sm:grid-cols-2 lg:grid-cols-3">
      {visible.map(row => <article key={row.id} data-skin-card={row.id}
        onMouseEnter={() => onHover(row.id)} onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(row.id)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onHover(null); }}
        className={`min-w-0 rounded-xl border p-3 ${hovered === row.id ? 'border-cyan-600 bg-cyan-50' : 'border-gray-200'}`}>
        <button type="button" className="admin-focus-ring min-h-11 w-full rounded-lg text-left" onClick={row.detail}>
          <span className="block break-words font-semibold [overflow-wrap:anywhere]">{row.label}</span>
          <span className="block text-xs text-gray-600">{row.third ? `${row.third} · ` : ''}{row.zone || 'Sin zona'}</span>
          <span className="block text-xs">{row.distribution} · {row.status} · {row.origin} · Ver detalle</span>
        </button>
        <div className="mt-1 flex gap-2">
          <button type="button" className={button} disabled={disabled} aria-label={`Editar ${row.label}`} onClick={row.detail}><Edit2 size={16} aria-hidden="true" /></button>
          {row.remove && <button type="button" className={`${button} text-red-700`} disabled={disabled} aria-label={`Eliminar ${row.label}`} onClick={row.remove}><Trash2 size={16} aria-hidden="true" /></button>}
        </div>
      </article>)}
    </div>
    {!visible.length && <p role="status" className="p-4 text-sm text-gray-600">{rows.length ? 'No hay lesiones que coincidan con los filtros. Los datos ocultos se conservan.' : 'No hay lesiones marcadas.'}</p>}
  </section>;
}
