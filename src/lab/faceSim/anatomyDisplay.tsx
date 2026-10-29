/* eslint-disable react-refresh/only-export-components -- Contrato compartido: componente y helpers en este módulo. */
import { ANATOMY_PLANES, type AnatomyPlane } from './defaultLayers';
import type { ReferenceKind } from './maskAnatomy';

export interface AnatomyDisplayState {
  anatomy: AnatomyPlane;
  skin: { visible: boolean; opacity: number };
  references: Record<ReferenceKind, { visible: boolean; opacity: number }>;
  overlay: boolean;
}

export function initialAnatomyDisplay(): AnatomyDisplayState {
  return {
    anatomy: 'skin', skin: { visible: true, opacity: 1 }, overlay: false,
    references: {
      muscle: { visible: false, opacity: 1 },
      vessels: { visible: false, opacity: 0.8 },
      bone: { visible: false, opacity: 1 },
    },
  };
}

/** Vista rápida: conserva opacidades de referencias y elimina la superposición anterior. */
export function chooseAnatomyDisplay(current: AnatomyDisplayState, kind: AnatomyPlane): AnatomyDisplayState {
  return {
    anatomy: kind, skin: { visible: true, opacity: kind === 'skin' ? 1 : 0 }, overlay: false,
    references: {
      muscle: { ...current.references.muscle, visible: kind === 'muscle' || kind === 'vessels' },
      vessels: { ...current.references.vessels, visible: kind === 'vessels' },
      bone: { ...current.references.bone, visible: kind === 'bone' },
    },
  };
}

export interface AnatomyLayerControlsProps {
  value: AnatomyDisplayState;
  onChange: (value: AnatomyDisplayState) => void;
  showMesh: boolean;
  onMeshChange: (visible: boolean) => void;
  disabled?: boolean;
}

export function AnatomyLayerControls({ value, onChange, showMesh, onMeshChange, disabled }: AnatomyLayerControlsProps) {
  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-slate-700 p-2 text-xs disabled:opacity-50">
    <legend className="px-1 font-semibold">Capas · controles sincronizados</legend>
    <div role="group" aria-label="Capa rápida" className="grid grid-cols-2 gap-1">
      {ANATOMY_PLANES.map(({ id, label, hint }) => <button key={id} type="button" title={hint}
        aria-pressed={value.anatomy === id}
        className="min-h-9 rounded border border-slate-600 px-2 focus-visible:outline-cyan-300 aria-pressed:border-cyan-300 aria-pressed:bg-cyan-950"
        onClick={() => { onChange(chooseAnatomyDisplay(value, id)); onMeshChange(true); }}>{label}</button>)}
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={showMesh}
      onChange={event => onMeshChange(event.target.checked)} />Mostrar mallado de zonas</label>
    <details className="space-y-2">
    <summary className="min-h-9 cursor-pointer font-semibold focus-visible:outline-cyan-300">Visibilidad y opacidades</summary>
    {ANATOMY_PLANES.map(({ id, label }) => {
      const layer = id === 'skin' ? value.skin : value.references[id];
      const update = (patch: Partial<typeof layer>) => onChange(id === 'skin'
        ? { ...value, skin: { ...layer, ...patch } }
        : { ...value, references: { ...value.references, [id]: { ...layer, ...patch } } });
      return <div key={id} className="space-y-1">
        <label className="flex items-center gap-2"><input type="checkbox" checked={layer.visible}
          onChange={event => update({ visible: event.target.checked })} />{id === 'skin' ? label : `Mostrar imagen ${label}`}</label>
        <label className="block">{id === 'skin' ? 'Opacidad: Piel' : `Opacidad imagen ${label}`} · {Math.round(layer.opacity * 100)} %
          <input type="range" min="0" max="1" step="0.01" value={layer.opacity}
            aria-label={`Opacidad: ${label}`} onChange={event => update({ opacity: Number(event.target.value) })}
            className="block w-full accent-cyan-400 focus-visible:outline-cyan-300" />
        </label>
      </div>;
    })}
    <label className="flex items-start gap-2"><input type="checkbox" checked={value.overlay}
      onChange={event => onChange({ ...value, overlay: event.target.checked })} />Superponer anatomía sobre piel opaca</label>
    </details>
    <p className="text-[11px] text-slate-300">Controles sincronizados entre vistas. Referencias genéricas ilustrativas, no anatomía individual. Sin superposición, la piel opaca oculta las referencias.</p>
  </fieldset>;
}
