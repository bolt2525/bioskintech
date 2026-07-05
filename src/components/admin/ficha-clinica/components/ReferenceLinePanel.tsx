import React, { useState } from 'react';
import { Minus, X, Eye, EyeOff, Plus, Move, Crosshair } from 'lucide-react';

// ==========================================
// TIPOS EXPORTADOS
// ==========================================

export type LineType = 'vertical' | 'horizontal' | 'two-points';

export interface ReferenceLine {
  id: string;
  type: LineType;
  label: string;
  color: string;
  /** Línea entrecortada (imaginaria) */
  dashed?: boolean;
  /** Punto de superficie donde se ancló la línea (primer clic) */
  anchor: { x: number; y: number; z: number };
  /** Offset de desplazamiento aplicado (eje X para vertical, eje Y para horizontal) */
  offset: number;
  /** Para two-points: los dos anchors de superficie */
  anchors?: { x: number; y: number; z: number }[];
  visible: boolean;
  /** Para líneas verticales: límite superior del barrido (hairline topY escalado) */
  yMax?: number;
  /** Para líneas verticales: límite inferior del barrido (hairline bottomY escalado) */
  yMin?: number;
}

// ==========================================
// CATÁLOGO DE LÍNEAS ANATÓMICAS PREDEFINIDAS
// ==========================================

export interface LinePreset {
  label: string;
  type: LineType;
  color: string;
  group: 'vertical' | 'horizontal' | 'diagonal';
  description: string;
  /** Línea imaginaria — se renderiza entrecortada */
  dashed?: boolean;
}

export const REFERENCE_LINE_PRESETS: LinePreset[] = [
  // Verticales
  { label: 'Línea Media Nasal', type: 'vertical', color: '#facc15', group: 'vertical', description: 'Eje de simetría central del tercio superior' },
  { label: 'L. Pupilar Izq.', type: 'vertical', color: '#ffffff', group: 'vertical', description: 'Pasa por el centro de la pupila izquierda' },
  { label: 'L. Pupilar Der.', type: 'vertical', color: '#ffffff', group: 'vertical', description: 'Pasa por el centro de la pupila derecha' },
  { label: 'Canto Interno Izq.', type: 'vertical', color: '#a3e635', group: 'vertical', description: 'Ángulo interno del ojo izquierdo' },
  { label: 'Canto Interno Der.', type: 'vertical', color: '#a3e635', group: 'vertical', description: 'Ángulo interno del ojo derecho' },
  { label: 'Canto Externo Izq.', type: 'vertical', color: '#fb923c', group: 'vertical', description: 'Ángulo externo del ojo izquierdo' },
  { label: 'Canto Externo Der.', type: 'vertical', color: '#fb923c', group: 'vertical', description: 'Ángulo externo del ojo derecho' },
  { label: 'Borde Iris Int. Izq.', type: 'vertical', color: '#c4b5fd', group: 'vertical', dashed: true, description: 'Entre línea pupilar y canto interno izq.' },
  { label: 'Borde Iris Int. Der.', type: 'vertical', color: '#c4b5fd', group: 'vertical', dashed: true, description: 'Entre línea pupilar y canto interno der.' },
  // Horizontales
  { label: '1ª Arruga Frontal', type: 'horizontal', color: '#f87171', group: 'horizontal', description: 'Primera arruga completa del tercio superior' },
  { label: 'Última Arruga Frontal', type: 'horizontal', color: '#f87171', group: 'horizontal', description: 'Última arruga completa del tercio superior' },
  { label: 'Intermedio Arrugas', type: 'horizontal', color: '#fca5a5', group: 'horizontal', description: 'Punto medio entre primera y última arruga frontal' },
  // Diagonales / Procerus-Corrugador
  { label: 'Diag. C.Int. Izq. → Ceja Der.', type: 'two-points', color: '#22d3ee', group: 'diagonal', dashed: true, description: 'Canto interno izquierdo a cabeza de ceja derecha' },
  { label: 'Diag. C.Int. Der. → Ceja Izq.', type: 'two-points', color: '#22d3ee', group: 'diagonal', dashed: true, description: 'Canto interno derecho a cabeza de ceja izquierda' },
  { label: 'Cola Ceja Izq. → Cola Ceja Der.', type: 'two-points', color: '#38bdf8', group: 'diagonal', dashed: true, description: 'Proyección imaginaria entre colas de cejas' },
];

// ==========================================
// PROPS
// ==========================================

interface ReferenceLinePanelProps {
  lines: ReferenceLine[];
  activeType: LineType | null;
  pendingTwoPointStep: 0 | 1 | 2; // 0 = inactivo, 1 = esperando 1er punto, 2 = esperando 2do punto
  pendingLabel: string;
  onSelectPreset: (preset: LinePreset) => void;
  onStartManual: (type: LineType) => void;
  onLabelChange: (label: string) => void;
  onCancel: () => void;
  onToggleVisibility: (id: string) => void;
  onOffsetChange: (id: string, offset: number) => void;
  onRemove: (id: string) => void;
}

// ==========================================
// COLORES POR TIPO
// ==========================================

const GROUP_STYLES = {
  vertical: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  horizontal: 'bg-red-50 border-red-200 text-red-700',
  diagonal: 'bg-cyan-50 border-cyan-200 text-cyan-800',
};

const GROUP_LABELS = {
  vertical: 'Verticales',
  horizontal: 'Horizontales',
  diagonal: 'Procerus / Corrugador (Diagonales)',
};

const TYPE_LABELS: Record<LineType, string> = {
  vertical: 'Vertical',
  horizontal: 'Horizontal',
  'two-points': 'Entre dos puntos',
};

const TWO_POINT_STEP_MESSAGES = [
  '',
  'Haz clic en el modelo para el 1er punto',
  'Haz clic en el modelo para el 2do punto',
];

// ==========================================
// COMPONENTE
// ==========================================

export default function ReferenceLinePanel({
  lines,
  activeType,
  pendingTwoPointStep,
  pendingLabel,
  onSelectPreset,
  onStartManual,
  onLabelChange,
  onCancel,
  onToggleVisibility,
  onOffsetChange,
  onRemove,
}: ReferenceLinePanelProps) {
  const [openGroup, setOpenGroup] = useState<'vertical' | 'horizontal' | 'diagonal' | null>('vertical');
  const [manualLabel, setManualLabel] = useState('');

  const groups = (['vertical', 'horizontal', 'diagonal'] as const);

  const isActive = activeType !== null;

  const handlePreset = (preset: LinePreset) => {
    onLabelChange(preset.label);
    onSelectPreset(preset);
  };

  const handleManualStart = (type: LineType) => {
    onLabelChange(manualLabel || TYPE_LABELS[type]);
    onStartManual(type);
  };

  return (
    <div className="flex flex-col gap-4 text-sm">

      {/* ===== ESTADO ACTIVO DE DIBUJO ===== */}
      {isActive && (
        <div className="flex items-center gap-3 bg-cyan-900/80 border border-cyan-500/40 rounded-xl p-3 animate-pulse-slow">
          <Crosshair className="w-5 h-5 text-cyan-400 shrink-0 animate-spin" style={{ animationDuration: '3s' }} />
          <div className="flex-1 min-w-0">
            <p className="text-cyan-200 font-semibold text-xs uppercase tracking-wide">
              Modo: {TYPE_LABELS[activeType!]}
            </p>
            <p className="text-cyan-300 text-xs mt-0.5">
              {activeType === 'two-points'
                ? TWO_POINT_STEP_MESSAGES[pendingTwoPointStep] || 'Haz clic en el modelo'
                : 'Haz clic en el modelo para anclar la línea'}
            </p>
            {pendingLabel && (
              <p className="text-cyan-400 text-[10px] mt-1 truncate">"{pendingLabel}"</p>
            )}
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg bg-red-600/40 hover:bg-red-600/70 text-red-300 hover:text-white transition-colors shrink-0"
            title="Cancelar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ===== PRESETS POR GRUPO ===== */}
      {!isActive && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Líneas Anatómicas</p>
          {groups.map(group => {
            const presets = REFERENCE_LINE_PRESETS.filter(p => p.group === group);
            const isOpen = openGroup === group;
            return (
              <div key={group} className={`rounded-xl border overflow-hidden ${GROUP_STYLES[group]}`}>
                <button
                  className="w-full flex items-center justify-between px-3 py-2 font-semibold text-xs uppercase tracking-wide"
                  onClick={() => setOpenGroup(isOpen ? null : group)}
                >
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full"
                      style={{ background: group === 'vertical' ? '#facc15' : group === 'horizontal' ? '#f87171' : '#22d3ee' }}
                    />
                    {GROUP_LABELS[group]}
                  </span>
                  <span className="text-[10px] opacity-60">{isOpen ? '▲' : '▼'}</span>
                </button>
                {isOpen && (
                  <div className="px-2 pb-2 space-y-1">
                    {presets.map(preset => (
                      <button
                        key={preset.label}
                        onClick={() => handlePreset(preset)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/60 hover:bg-white/90 transition-colors group"
                        title={preset.description}
                      >
                        <span
                          className="w-3 h-0.5 shrink-0"
                          style={preset.dashed
                            ? { background: `repeating-linear-gradient(to right, ${preset.color} 0px, ${preset.color} 3px, transparent 3px, transparent 5px)`, boxShadow: `0 0 4px ${preset.color}` }
                            : { background: preset.color, borderRadius: '9999px', boxShadow: `0 0 4px ${preset.color}` }}
                        />
                        <span className="text-xs font-medium truncate">{preset.label}</span>
                        <Plus className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-60 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== MANUAL ===== */}
      {!isActive && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Línea Manual</p>
          <input
            type="text"
            className="w-full px-2.5 py-1.5 bg-slate-700/50 border border-slate-600 rounded-lg text-xs text-white placeholder-slate-400 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            placeholder="Etiqueta de la línea..."
            value={manualLabel}
            onChange={e => setManualLabel(e.target.value)}
          />
          <div className="grid grid-cols-3 gap-1.5">
            {(['vertical', 'horizontal', 'two-points'] as LineType[]).map(type => (
              <button
                key={type}
                onClick={() => handleManualStart(type)}
                className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg bg-slate-700/60 hover:bg-slate-600/80 border border-slate-600 hover:border-cyan-500/50 text-slate-300 hover:text-cyan-300 transition-all text-[10px] font-medium"
                title={TYPE_LABELS[type]}
              >
                {type === 'vertical' && <Minus className="w-4 h-4 rotate-90" />}
                {type === 'horizontal' && <Minus className="w-4 h-4" />}
                {type === 'two-points' && <Move className="w-4 h-4" />}
                <span className="truncate w-full text-center leading-tight">
                  {type === 'vertical' ? 'Vert.' : type === 'horizontal' ? 'Horiz.' : '2 Pts.'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ===== LISTA DE LÍNEAS AGREGADAS ===== */}
      {lines.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
            Líneas ({lines.length})
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
            {lines.map(line => (
              <div
                key={line.id}
                className={`rounded-xl border bg-slate-800/60 overflow-hidden transition-opacity ${line.visible ? 'border-slate-600' : 'border-slate-700 opacity-50'}`}
              >
                {/* Header */}
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <span
                    className="w-3 h-0.5 shrink-0"
                    style={(line as any).dashed
                      ? { background: `repeating-linear-gradient(to right, ${line.color} 0px, ${line.color} 3px, transparent 3px, transparent 5px)`, boxShadow: `0 0 5px ${line.color}` }
                      : { background: line.color, borderRadius: '9999px', boxShadow: `0 0 5px ${line.color}` }}
                  />
                  <span className="text-xs font-medium text-slate-200 truncate flex-1">{line.label}</span>
                  <span className="text-[9px] text-slate-500 shrink-0">{TYPE_LABELS[line.type]}</span>
                  <button
                    onClick={() => onToggleVisibility(line.id)}
                    className="p-1 rounded hover:bg-slate-600/50 text-slate-400 hover:text-white transition-colors shrink-0"
                    title={line.visible ? 'Ocultar' : 'Mostrar'}
                  >
                    {line.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => onRemove(line.id)}
                    className="p-1 rounded hover:bg-red-600/40 text-slate-500 hover:text-red-400 transition-colors shrink-0"
                    title="Eliminar"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Slider de desplazamiento — solo para vertical y horizontal */}
                {line.type !== 'two-points' && (
                  <div className="px-2.5 pb-2">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[9px] text-slate-500">Desplazamiento</span>
                      <span className="text-[9px] text-slate-400 font-mono">{line.offset.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min="-2"
                      max="2"
                      step="0.01"
                      value={line.offset}
                      onChange={e => onOffsetChange(line.id, parseFloat(e.target.value))}
                      className="w-full h-1 accent-cyan-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[8px] text-slate-600 mt-0.5">
                      <span>-2.0</span><span>0</span><span>+2.0</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* EMPTY STATE */}
      {lines.length === 0 && !isActive && (
        <div className="text-center py-4 text-slate-500">
          <Minus className="w-6 h-6 mx-auto opacity-20 mb-1" />
          <p className="text-xs">Selecciona un preset o crea una línea manual</p>
          <p className="text-[10px] mt-1 opacity-60">Las líneas aparecerán sobre el modelo 3D</p>
        </div>
      )}
    </div>
  );
}
