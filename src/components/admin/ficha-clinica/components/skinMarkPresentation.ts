import { skinZoneAt } from './skinAnatomy.ts';
import type { EvaluationMark } from './skinEvaluation';
import { isZonalSkinMark } from './skinEvaluation.ts';
import { modelPoint } from '../../../../lab/faceSim/faceTransfer.ts';
import trazado from '../data/trazado-referencia-superior.json' with { type: 'json' };

export function facialThird({ x, y }: { x: number; y: number }): string {
  if (Math.abs(x) > 1) return 'Zona Lateral';
  if (y > trazado.hairline.bottomY) return 'Tercio Superior';
  if (y > trazado.hairline.tercioMedioBottomY) return 'Tercio Medio';
  if (y > trazado.hairline.tercioInferiorBottomY) return 'Tercio Inferior';
  return 'Zona Inferior / Cuello';
}

export interface SkinListRow {
  id: string;
  label: string;
  zone: string;
  third?: string;
  distribution: 'Puntual' | 'Zonal';
  status: string;
  origin: string;
  detail: () => void;
  remove?: () => void;
}
export interface SkinListFilter { zone: string; lesion: string }
export const emptySkinFilter: SkinListFilter = { zone: '', lesion: '' };
export function matchesSkinFilter(row: Pick<SkinListRow, 'zone' | 'label'>, filter: SkinListFilter) {
  const zone = row.zone || 'Sin zona';
  return (!filter.zone || zone === filter.zone || zone.startsWith(`${filter.zone} · `)) && (!filter.lesion || row.label === filter.lesion);
}
export function evaluationRow(mark: EvaluationMark): Omit<SkinListRow, 'detail' | 'remove'> {
  const zone = mark.anchor ? skinZoneAt(mark.anchor) ?? '' : '';
  const position = mark.anchor && modelPoint(mark.anchor);
  return { id: mark.id, label: mark.label, zone,
    third: position ? facialThird(position) : undefined,
    distribution: isZonalSkinMark(mark.box) ? 'Zonal' : 'Puntual',
    status: mark.status === 'validated' ? 'Confirmada' : 'Por revisar',
    origin: mark.id.startsWith('legacy-exam:') ? 'Original trasladado' :
      (mark.source.provider === 'edited' ? mark.source.original : mark.source).provider === 'manual' ? 'Manual' : 'Propuesta revisada' };
}
