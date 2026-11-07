import type { Mark } from './FaceMapCanvas';
import type { EvaluationMark } from './skinEvaluation';
import { bestPhotoForAnchor, photoForAnchor } from './skinEvaluation.ts';
import { legacySkinAnchor } from './skinAnatomy.ts';
import type { PersonalSurface } from '../../../../lab/faceSim/faceTransfer';
import type { SkinPhotoSource } from '../../../../lab/faceSim/skinMultiView';
import catalog from '../../../../data/skin-lesion-catalog.json' with { type: 'json' };

export interface UntransferredSkinMark { id: string; reason: string; original?: Mark }

export function migrateLegacySkinMarks(
  marks: readonly Mark[], examId: number, sources: readonly SkinPhotoSource[], surface: PersonalSurface,
  existing: readonly EvaluationMark[],
): { marks: EvaluationMark[]; skipped: UntransferredSkinMark[]; added: number } {
  const result = [...existing], skipped: UntransferredSkinMark[] = [];
  let added = 0;
  for (const mark of marks) {
    if (!mark || typeof mark.id !== 'string' || typeof mark.category !== 'string' ||
      (mark.notes !== undefined && typeof mark.notes !== 'string')) {
      skipped.push({ id: String(mark?.id ?? 'sin identificador'), reason: 'Formato histórico no reconocido; los datos originales se conservan.' }); continue;
    }
    const id = `legacy-exam:${examId}:${mark.id}`;
    if (result.some(item => item.id === id)) continue;
    if (!mark.is3D || !mark.position3D) {
      skipped.push({ id: mark.id, original: mark, reason: 'Marca 2D histórica sin anclaje anatómico; ubícala manualmente.' }); continue;
    }
    const address = legacySkinAnchor(mark.position3D, mark.normal3D);
    const anchor = address && { ...address, version: 1 as const };
    const source = anchor && bestPhotoForAnchor(anchor, sources, surface);
    const photo = source && anchor && photoForAnchor(anchor, source, surface);
    if (!anchor) { skipped.push({ id: mark.id, original: mark, reason: 'El punto original queda fuera de la correspondencia facial observada (p. ej., frente alta o borde). No se proyecta a otra zona: selecciona el original y ubícalo manualmente en la máscara.' }); continue; }
    if (!source || !photo) { skipped.push({ id: mark.id, original: mark, reason: 'Anclaje anatómico encontrado, pero no hay una foto con correspondencia visible fiable. Revisa otra vista; la marca original se conserva.' }); continue; }
    const label = mark.category.trim() || 'Lesión histórica';
    const note = [`Traslado aproximado del examen #${examId}, marca ${mark.id}. Confirmar sobre la foto original.`,
      mark.notes, mark.severity ? `Severidad histórica: ${mark.severity}.` : ''].filter(Boolean).join(' ');
    if (id.length > 200 || label.length > 300 || note.length > 3000) {
      skipped.push({ id: mark.id, original: mark, reason: 'El texto histórico supera los límites actuales; revísalo manualmente sin recortarlo.' }); continue;
    }

    const size = mark.distribution === 'zonal' ? .1 : .04;
    result.push({ id, sourceId: source.id, category: Object.entries(catalog).find(([, value]) => value === label)?.[0] ?? 'other',
      label, note,
      box: { x: Math.max(0, Math.min(1 - size, photo.x - size / 2)), y: Math.max(0, Math.min(1 - size, photo.y - size / 2)),
        width: size, height: size }, anchor, status: 'pending', source: { provider: 'manual' } });
    added++;
  }
  return { marks: result, skipped, added };
}

/** La colocación explícita conserva identidad y original; repetirla reemplaza, no duplica. */
export function placeUntransferredSkinMark(original: Mark, examId: number, sourceId: string,
  box: EvaluationMark['box'], anchor: NonNullable<EvaluationMark['anchor']>): EvaluationMark {
  const label = original.category.trim() || 'Lesión histórica';
  const note = [`Ubicación manual revisada del examen #${examId}, marca ${original.id}. El original se conserva.`,
    original.notes].filter(Boolean).join(' ');
  const id = `legacy-exam:${examId}:${original.id}`;
  if (id.length > 200 || label.length > 300 || note.length > 3000) throw new Error('Revisa el texto histórico antes de trasladar; no se recortó ni modificó el original.');
  return { id, sourceId, box, anchor, label, note, category: Object.entries(catalog).find(([, value]) => value === label)?.[0] ?? 'other',
    status: 'pending', source: { provider: 'manual' } };
}
