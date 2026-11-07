import type { EvaluationMark } from './skinEvaluation';

/** Solo marcas en memoria: nunca retiene fotos, superficies o GLB ni usa storage. */
export class SkinEditHistory<T = EvaluationMark> {
  private entries: T[][] = [];
  private future: T[][] = [];
  private expected: readonly T[] | null = null;
  private readonly limit: number;
  constructor(limit = 30) { this.limit = Math.max(1, Math.min(30, limit)); }
  get size() { return this.entries.length; }
  get redoSize() { return this.future.length; }
  clear() { this.entries = []; this.future = []; this.expected = null; }
  sync(value: readonly T[]) {
    // Una restauración externa/examen distinto invalida el historial local.
    if (this.expected && value !== this.expected) this.clear();
  }
  push(before: readonly T[], after: T[]) {
    this.future = [];
    this.entries.push(structuredClone(before) as T[]);
    if (this.entries.length > this.limit) this.entries.shift();
    this.expected = after;
  }
  /** Continúa un gesto sin clonar un snapshot por cada evento del slider. */
  replace(after: T[]) { this.expected = after; }
  undo(): T[] | undefined {
    const previous = this.entries.pop();
    if (previous) {
      this.future.push(structuredClone(this.expected ?? []) as T[]);
      this.expected = previous;
    }
    return previous;
  }
  redo(): T[] | undefined {
    const next = this.future.pop();
    if (next) {
      this.entries.push(structuredClone(this.expected ?? []) as T[]);
      this.expected = next;
    }
    return next;
  }
}
