import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SkinRequestScope, parseSkinAnalysis, parseSkinStatus, parseSkinReview,
  skinImageDimensions, prepareSkinPhoto, validateProposal, validBox,
  parsePhotoReference, safePhotoReadURL, skinReviewDescription,
  skinReviewSaveField,
} from '../src/components/admin/ficha-clinica/components/skinVisualAI.ts';

const proposal = { id: 'p1', category: 'spot', label: 'Área ilustrativa',
  box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, note: 'Verificar personalmente' };
const usage = { usedUsd: 0.01, limitUsd: 5, remainingUsd: 4.99 };
const result = { analysisId: 'a1', model: 'modelo-mock', proposals: [proposal],
  summary: 'Ilustración, no diagnóstico', limitations: ['Cajas aproximadas'], usage };
const source = { provider: 'google-gemini', analysisId: 'a1', model: 'modelo-mock',
  requestId: 'req1', analyzedAt: '2026-11-05T00:00:00Z', consentedAt: '2026-11-05T00:00:00Z',
  imageWidth: 800, imageHeight: 600, proposal, summary: result.summary,
  limitations: result.limitations, context: { skinType: 'Manual' } };

test('permiso servidor obligatorio y respuesta vacía válida no significa ausencia de lesiones', () => {
  assert.equal(parseSkinStatus({ enabled: false, reason: 'Deshabilitado', model: 'mock', ...usage }).enabled, false);
  assert.throws(() => parseSkinStatus({ enabled: true }), /permiso/);
  assert.throws(() => parseSkinStatus({ enabled: 'true', model: 'mock', ...usage }), /permiso/);
  assert.throws(() => parseSkinStatus({ enabled: true, model: 'mock', ...usage, remainingUsd: NaN }), /permiso/);
  assert.deepEqual(parseSkinAnalysis({ ...result, proposals: [] }).proposals, []);
});
test('rechaza categorías fuera de contrato, poros, cajas inválidas y duplicados', () => {
  assert.deepEqual(parseSkinAnalysis(result), result);
  for (const patch of [{ category: 'pores' }, { category: 'skin-type' }, { box: { ...proposal.box, x: -0.1 } },
    { box: { ...proposal.box, width: 0 } }, { box: { ...proposal.box, y: NaN } },
    { box: { ...proposal.box, x: 0.9 } }, { label: '   ' }]) {
    assert.throws(() => parseSkinAnalysis({ ...result, proposals: [{ ...proposal, ...patch }] }), /no es válida/);
  }
  assert.throws(() => parseSkinAnalysis({ ...result, proposals: [proposal, proposal] }), /no es válida/);
  assert.equal(validBox({ x: 0, y: 0, width: 1, height: 1 }), true);
});
test('solo validación explícita con foto durable crea anotación 2D; conserva origen y edición', () => {
  assert.throws(() => validateProposal(proposal, null, source), /foto/);
  const mark = validateProposal({ ...proposal, label: 'Etiqueta revisada', box: { ...proposal.box, x: 0.25 } },
    { id: 8, r2Key: 'clinics/ficticia/records/12/photos/sintetica.jpg' }, source);
  assert.equal(mark.label, 'Etiqueta revisada');
  assert.equal(mark.normalizedBox.x, 0.25);
  assert.equal(mark.source.proposal.box.x, 0.1);
  assert.equal(mark.reviewStatus, 'validated');
  assert.equal(mark.coordinateSpace, 'clinical-photo-2d');
  assert.ok(!('position3D' in mark) && !('x' in mark) && !('y' in mark));
  source.context.skinType = 'Cambio posterior';
  assert.equal(mark.source.context.skinType, 'Manual');
  source.context.skinType = 'Manual';
  const stored = JSON.stringify({ version: 1, annotations: [mark] });
  assert.deepEqual(parseSkinReview(stored), [mark]);
  assert.deepEqual(parseSkinReview({ version: 1, annotations: [mark] }), [mark]);
  assert.deepEqual(skinReviewSaveField(undefined, []), {}, 'legacy sin IA no requiere columna');
  assert.deepEqual(skinReviewSaveField({ version: 1, annotations: [] }, []), {}, 'vacío por defecto no fuerza migración');
  assert.deepEqual(skinReviewSaveField(stored, []), { skin_visual_review: { version: 1, annotations: [] } }, 'limpieza intencional de revisión previa');
  assert.deepEqual(skinReviewSaveField(undefined, [mark]), { skin_visual_review: { version: 1, annotations: [mark] } });
  assert.ok(!/base64|blob:|https:/.test(stored));
  assert.deepEqual(parseSkinReview('[]'), []);
  assert.deepEqual(parseSkinReview('{'), []);
  assert.deepEqual(parseSkinReview({ version: 1, annotations: [{ ...mark, reviewStatus: 'pending' }, {}] }), []);
  const description = skinReviewDescription(mark);
  assert.match(description, /Mancha · Etiqueta revisada.*Foto clínica #8/);
  assert.ok(!description.includes(mark.photo.r2Key) && !description.includes('modelo-mock'));
  assert.deepEqual(parsePhotoReference({ id: 8, r2_key: mark.photo.r2Key }, 12), mark.photo);
  assert.throws(() => parsePhotoReference({ id: 8, r2_key: mark.photo.r2Key }, 13), /esta ficha/);
  assert.throws(() => parsePhotoReference({ id: 8, r2_key: 'blob:temporal' }, 12), /esta ficha/);
  assert.equal(safePhotoReadURL('https://synthetic-storage.invalid/photo?signature=mock'), 'https://synthetic-storage.invalid/photo?signature=mock');
  for (const unsafe of ['javascript:alert(1)', 'http://synthetic-storage.invalid/photo', 'https://user:pass@synthetic-storage.invalid/photo', null]) {
    assert.throws(() => safePhotoReadURL(unsafe));
  }
});
test('cancelación y cambio de foto/paciente invalidan incluso una respuesta ya resuelta', async () => {
  const scope = new SkinRequestScope();
  const old = scope.start();
  const next = scope.start();
  assert.equal(old.signal.aborted, true);
  assert.equal(old.current(), false);
  assert.equal(next.current(), true);
  scope.cancel();
  assert.equal(next.current(), false);
  assert.equal(next.signal.aborted, true);
  await Promise.resolve();
  assert.equal(old.current(), false);
});
function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
test('lee dimensiones PNG/JPEG antes de bitmap y rechaza entrada enorme sin decodificar', async () => {
  assert.deepEqual(skinImageDimensions(png(800, 600)), { width: 800, height: 600 });
  const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 2, 88, 3, 32, 1, 0, 0]);
  assert.deepEqual(skinImageDimensions(jpeg), { width: 800, height: 600 });
  assert.throws(() => skinImageDimensions(new Uint8Array(3)), /JPEG o PNG/);
  await assert.rejects(prepareSkinPhoto(new Blob([png(12000, 12000)], { type: 'image/png' }),
    new AbortController().signal), /24 megapíxeles/);
  await assert.rejects(prepareSkinPhoto(new Blob(['x'], { type: 'text/html' }),
    new AbortController().signal), /JPEG o PNG/);
});
test('canvas siempre reencodea JPEG, reduce a 1280, exige bytes y libera bitmap', async () => {
  const original = { bitmap: globalThis.createImageBitmap, document: globalThis.document, FileReader: globalThis.FileReader };
  let closed = 0, drawn = 0;
  const canvas = { width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage() { drawn++; } }),
    toBlob(resolve, mime) { assert.equal(mime, 'image/jpeg'); resolve(new Blob(['jpeg-mock'], { type: mime })); } };
  globalThis.createImageBitmap = async () => ({ width: 2400, height: 1600, close() { closed++; } });
  globalThis.document = { createElement: () => canvas };
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/jpeg;base64,anBlZy1tb2Nr'; this.onload(); }
  };
  try {
    const prepared = await prepareSkinPhoto(new Blob([png(2400, 1600)], { type: 'image/png' }), new AbortController().signal);
    assert.equal(prepared.width, 1280); assert.equal(prepared.height, 853);
    assert.equal(prepared.base64, 'anBlZy1tb2Nr');
    assert.ok(prepared.blob.size <= 1_500_000); assert.equal(drawn, 1); assert.equal(closed, 1);
    canvas.toBlob = resolve => resolve(new Blob([new Uint8Array(1_500_001)], { type: 'image/jpeg' }));
    await assert.rejects(prepareSkinPhoto(new Blob([png(2400, 1600)], { type: 'image/png' }),
      new AbortController().signal), /1,5 MB/);
    assert.equal(closed, 2);
  } finally {
    globalThis.createImageBitmap = original.bitmap;
    globalThis.document = original.document;
    globalThis.FileReader = original.FileReader;
  }
});
