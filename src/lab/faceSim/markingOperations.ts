import type { FreehandLine, Marker3D } from '../../components/admin/ficha-clinica/components/Clinical3DViewer';
import { requireMappedPoint, surfaceNormal, type AnatomicalBinding, type AnatomicalBindings } from './anatomicalAnnotations';
import { canonicalAnnotationPoint, mirrorAnnotation } from './annotationSymmetry';
import { SIM_MODES, type Meta } from './engine';
import { locatePhotoPoint, modelPoint as tryModelPoint, type FaceAddress, type GenericFaceAtlas } from './faceTransfer';
import { copySelectionRows, ledgerRows, volumeTotals, type VolumeTotal } from './markingModel';

export type MarkingCopyOperation = 'duplicate' | 'mirror';
export interface MarkingCopyIntent {
  confirmedQuantities: true;
  discardExtended: boolean;
}
/** Se conserva en lab.meta mediante localRecord, sin alterar el contrato del motor. */
export interface MarkingCopyRecord extends MarkingCopyIntent {
  operation: MarkingCopyOperation;
  sourceId: string;
  transactionId: string;
  confirmedAt: string;
  totals: VolumeTotal[];
}
type CopyMeta = Meta & { markingCopyIntent: MarkingCopyRecord };
const modelPoint = (...args: Parameters<typeof tryModelPoint>) => requireMappedPoint(tryModelPoint(...args));

function validateBinding(binding: AnatomicalBinding, atlas: GenericFaceAtlas, accepts: (a: FaceAddress) => boolean) {
  const valid = (a: FaceAddress) => !!tryModelPoint(a, atlas) && accepts(a);
  if (!binding.paths.length || binding.paths.some(path => !path.length || path.some(a => !valid(a)))
    || binding.center && !valid(binding.center)) throw new Error('La selección no tiene cobertura válida en la superficie activa.');
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1] }));
  // También comprueba el interior de segmentos: dos extremos válidos no permiten cruzar un hueco.
  for (const path of binding.paths) for (let i = 1; i < path.length; i++) {
    const a = canonicalAnnotationPoint(path[i - 1], atlas), b = canonicalAnnotationPoint(path[i], atlas);
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.01);
    if (steps > 2000) throw new Error('El trazo es demasiado largo para validar su cobertura.');
    for (let j = 1; j < steps; j++) {
      const t = j / steps, address = locatePhotoPoint({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, landmarks, atlas);
      if (!address || !valid(address)) throw new Error('El trazo cruza una zona sin cobertura; no se ha copiado ninguna marca.');
    }
  }
}

/** Preparación pura: valida TODO antes de que el llamador tome un único snapshot. */
export function prepareMarkingCopy(input: {
  ids: readonly string[]; operation: MarkingCopyOperation; intent: MarkingCopyIntent;
  meta: Record<string, Meta>; bindings: AnatomicalBindings; markers: Marker3D[]; lines: FreehandLine[];
  atlas: GenericFaceAtlas; plane: NonNullable<AnatomicalBinding['illustrativePlane']>;
  accepts: (address: FaceAddress) => boolean; newId: () => string;
}) {
  const { meta, bindings, atlas, accepts, operation, intent } = input;
  if (intent.confirmedQuantities !== true) throw new Error('Confirma explícitamente la duplicación de cantidades antes de continuar.');
  const rows = copySelectionRows(ledgerRows(meta, bindings, input.ids.filter(id => !bindings[id])), input.ids);
  if (input.ids.some(id => !rows.some(r => r.id === id))) throw new Error('La selección cambió. Vuelve a seleccionar las marcas.');
  const excluded = rows.filter(r => r.extended);
  if (excluded.length && !intent.discardExtended) throw new Error('Excluye explícitamente las marcas extendidas: no son transferibles.');
  const transferable = rows.filter(r => !r.extended);
  if (!transferable.length) throw new Error('No hay marcas transferibles seleccionadas.');
  const taken = new Set([...Object.keys(meta), ...Object.keys(bindings), ...input.markers.flatMap(m => m.id ? [m.id] : []), ...input.lines.map(l => l.id)]);
  const fresh = () => {
    const id = input.newId();
    if (!id || taken.has(id)) throw new Error('No se pudo generar un identificador único. Reintenta la operación.');
    taken.add(id); return id;
  };
  const transactionId = fresh(), confirmedAt = new Date().toISOString();
  const remap = new Map(transferable.map(row => [row.id, fresh()]));
  const nextBindings: AnatomicalBindings = {}, nextMeta: Record<string, CopyMeta> = {};
  const markers: Marker3D[] = [], lines: FreehandLine[] = [];
  const totals = volumeTotals(transferable);
  for (const row of transferable) {
    const original = bindings[row.id], item = meta[row.id], id = remap.get(row.id)!;
    if (!original || (original.illustrativePlane ?? 'skin') !== input.plane) throw new Error('La selección pertenece a otra capa. Activa su superficie antes de copiar; no se cambian capas automáticamente.');
    if (item.parent && !remap.has(item.parent)) throw new Error('Una punta no tiene su entrada transferible; se canceló toda la operación.');
    validateBinding(original, atlas, accepts);
    const binding = operation === 'mirror' ? mirrorAnnotation(original, atlas, accepts) : structuredClone(original);
    if (!binding) throw new Error('El espejo no tiene cobertura válida. No se ha copiado ninguna marca.');
    validateBinding(binding, atlas, accepts);
    nextBindings[id] = binding;
    nextMeta[id] = { ...item, ...(item.parent ? { parent: remap.get(item.parent) } : {}),
      ...(row.graphicOnly ? { graphicOnly: true, dose: 0, plane: undefined, entry: undefined } : row.entry ? { dose: 0, plane: undefined } : {}),
      markingCopyIntent: { ...intent, operation, sourceId: row.id, transactionId, confirmedAt, totals } };
    if (binding.kind === 'point') {
      const address = binding.paths[0][0];
      markers.push({ ...input.markers.find(m => m.id === row.id), id, type: 'Puntual', pathologyId: 'filler',
        zone: '', rotation: [0, 0, 0], position: modelPoint(address, atlas), normal: surfaceNormal(address, atlas, a => modelPoint(a, atlas)) });
    } else {
      const paths = binding.paths.map(path => path.map(a => modelPoint(a, atlas)));
      lines.push({ ...input.lines.find(l => l.id === row.id), id, points: paths[0], segments: paths.length > 1 ? paths : undefined,
        color: item.strokeColor ?? SIM_MODES[item.mode].color, thickness: item.strokeWidth ?? input.lines.find(l => l.id === row.id)?.thickness ?? 1,
        ...(binding.kind === 'arrow' ? { technique_preset: 'Flecha' } : {}) });
    }
  }
  return { bindings: nextBindings, meta: nextMeta, markers, lines, excluded: excluded.length, firstId: remap.get(transferable[0].id)! };
}
