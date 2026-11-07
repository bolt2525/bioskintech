import { COLORS } from '../../../../constants/theme';

export interface SkinMarkVisibility { marks: boolean; names: boolean }
export default function SkinMarkControls({ value, onChange, undo, redo, tone = 'light' }: {
  value: SkinMarkVisibility; onChange?: (value: SkinMarkVisibility) => void;
  undo?: { disabled: boolean; onClick: () => void };
  redo?: { disabled: boolean; onClick: () => void };
  tone?: 'light' | 'dark';
}) {
  const button = `admin-focus-ring min-h-11 rounded-lg border px-2 py-2 text-xs font-medium ${
    tone === 'dark' ? 'border-slate-500 bg-slate-800 text-slate-100 enabled:hover:bg-slate-700 disabled:border-slate-600 disabled:bg-slate-900 disabled:text-slate-400' :
      'border-slate-300 bg-white text-slate-900 enabled:hover:bg-slate-100 disabled:bg-slate-100 disabled:text-slate-500'}`;
  return <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Visibilidad y edición de marcas">
    {onChange && <>
      <button type="button" className={button} aria-pressed={value.marks} onClick={() => onChange({ ...value, marks: !value.marks })}>{value.marks ? 'Ocultar marcas' : 'Mostrar marcas'}</button>
      <button type="button" className={button} aria-pressed={value.names} onClick={() => onChange({ ...value, names: !value.names })}>{value.names ? 'Ocultar nombres' : 'Mostrar nombres'}</button>
    </>}
    {undo && <button type="button" className={button} disabled={undo.disabled} onClick={undo.onClick}>Deshacer</button>}
    {redo && <button type="button" className={button} disabled={redo.disabled} onClick={redo.onClick}>Rehacer</button>}
  </div>;
}

export function SkinMarkLegend({ notice, onUndo, undoDisabled }: { notice?: string; onUndo?: () => void; undoDisabled?: boolean }) {
  return <div className="relative flex min-h-11 items-center px-3 py-2 text-xs">
  <p className={`flex flex-wrap gap-3 ${notice ? 'invisible' : ''}`} aria-label="Estado de las marcas">
    <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: COLORS.skinPending }} />Por revisar</span>
    <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: COLORS.skinValidated }} />Confirmada</span>
  </p>
  {notice && <div role="status" aria-live="polite" className="absolute inset-0 flex items-center justify-between gap-2 rounded-b-xl bg-slate-100 px-3 text-slate-900">
    <span className="min-w-0 truncate" title={notice}>{notice}</span>
    {onUndo && <button type="button" className="admin-focus-ring min-h-11 shrink-0 px-2 font-semibold underline disabled:opacity-40" disabled={undoDisabled} onClick={onUndo}>Deshacer eliminación</button>}
  </div>}
  </div>;
}
