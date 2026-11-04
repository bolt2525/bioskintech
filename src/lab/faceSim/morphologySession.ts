import { NEUTRAL_SIMULATION, sanitizeSimulation, type SimulationParameters } from './simulation';

export interface MorphologyVariant {
  id: string;
  name: string;
  parameters: SimulationParameters;
  symmetryDirection: 1 | -1;
}
interface Snapshot {
  parameters: SimulationParameters;
  symmetryDirection: 1 | -1;
  variants: readonly MorphologyVariant[];
}
export interface MorphologySession {
  present: Snapshot;
  past: readonly Snapshot[];
  future: readonly Snapshot[];
  gesture: Snapshot | null;
}
export type MorphologyAction =
  | { type: 'begin' | 'end' | 'undo' | 'redo' | 'restart' }
  | { type: 'change'; parameters?: Partial<SimulationParameters>; symmetryDirection?: 1 | -1 }
  | { type: 'save'; id: string; name: string }
  | { type: 'apply' | 'delete'; id: string };

// Solo parámetros en memoria: nunca fotos, buffers GPU ni persistencia.
export const MORPHOLOGY_HISTORY_LIMIT = 80;
export const MORPHOLOGY_VARIANT_LIMIT = 12;
export function initialMorphologySession(): MorphologySession {
  return { present: { parameters: { ...NEUTRAL_SIMULATION }, symmetryDirection: 1, variants: [] },
    past: [], future: [], gesture: null };
}
const equal = (a: Snapshot, b: Snapshot) => a.symmetryDirection === b.symmetryDirection
  && a.variants === b.variants
  && (Object.keys(a.parameters) as (keyof SimulationParameters)[]).every(key => a.parameters[key] === b.parameters[key]);
const append = (past: readonly Snapshot[], snapshot: Snapshot) => [...past, snapshot].slice(-MORPHOLOGY_HISTORY_LIMIT);

export function morphologySessionReducer(state: MorphologySession, action: MorphologyAction): MorphologySession {
  if (action.type === 'restart') return initialMorphologySession();
  if (action.type === 'begin') return state.gesture ? state : { ...state, gesture: state.present };
  if (action.type === 'end') {
    if (!state.gesture) return state;
    return { ...state, gesture: null,
      past: equal(state.gesture, state.present) ? state.past : append(state.past, state.gesture) };
  }
  if (state.gesture && action.type !== 'change') {
    state = morphologySessionReducer(state, { type: 'end' });
  }
  if (action.type === 'undo') {
    const previous = state.past[state.past.length - 1];
    return previous ? { present: previous, past: state.past.slice(0, -1),
      future: [state.present, ...state.future], gesture: null } : state;
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    return next ? { present: next, past: append(state.past, state.present),
      future: state.future.slice(1), gesture: null } : state;
  }
  let present = state.present;
  if (action.type === 'change') {
    const parameters = sanitizeSimulation({ ...present.parameters, ...action.parameters });
    const sameParameters = (Object.keys(parameters) as (keyof SimulationParameters)[])
      .every(key => parameters[key] === present.parameters[key]);
    present = { ...present, parameters: sameParameters ? present.parameters : parameters,
      symmetryDirection: action.symmetryDirection ?? present.symmetryDirection };
  } else if (action.type === 'save') {
    const name = action.name.trim().slice(0, 48);
    if (!name || present.variants.length >= MORPHOLOGY_VARIANT_LIMIT || present.variants.some(v => v.id === action.id)) return state;
    present = { ...present, variants: [...present.variants, {
      id: action.id, name, parameters: { ...present.parameters }, symmetryDirection: present.symmetryDirection,
    }] };
  } else if (action.type === 'apply') {
    const variant = present.variants.find(v => v.id === action.id);
    if (!variant) return state;
    present = { ...present, parameters: { ...variant.parameters }, symmetryDirection: variant.symmetryDirection };
  } else if (action.type === 'delete') {
    if (!present.variants.some(v => v.id === action.id)) return state;
    present = { ...present, variants: present.variants.filter(v => v.id !== action.id) };
  }
  if (equal(present, state.present)) return state;
  return { present, past: state.gesture ? state.past : append(state.past, state.present),
    future: [], gesture: state.gesture };
}
