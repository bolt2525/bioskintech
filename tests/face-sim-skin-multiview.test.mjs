import assert from 'node:assert/strict';
import test from 'node:test';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with { type: 'json' };
import { alignSkinProfile, detectedSkinMapping, mapSkinCandidate, mergeSkinObservations, PROFILE_SKIN_ANCHORS, selectSkinPhotos, skinPhotoQuality, skinPolygonMask } from '../src/lab/faceSim/skinMultiView.ts';
import { analyzeSkinAppearance, skinVisualCandidates } from '../src/lab/faceSim/skinAppearance.ts';
import { applyRegistration, fitAffineRegistration } from '../src/lab/faceSim/engine.ts';

const surface = { positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: new Float32Array(atlas.positions.length / 3 * 2) };
const height = Math.abs(surface.positions[31] - surface.positions[457]);
const profile = id => ({ x: .3 + surface.positions[id * 3 + 2] / height * .8, y: .5 - surface.positions[id * 3 + 1] / height * .8 });
const anchors = PROFILE_SKIN_ANCHORS.map(({ index }) => profile(index));

test('perfil puro manual: seis puntos, registro no acumulativo, lado explícito y sin alterar geometría', () => {
  const before = surface.positions.slice();
  for (const side of [-1, 1]) {
    const fit = alignSkinProfile(surface, anchors, 1, side);
    assert.equal(fit.landmarks.length, 468); assert.equal(fit.manual, true);
    assert.deepEqual(fit.direction, [side, 0, 0]);
    fit.landmarks.forEach((point, id) => {
      assert.ok(Math.hypot(point.x - profile(id).x, point.y - profile(id).y) < 1e-6);
    });
  }
  assert.deepEqual(surface.positions, before);
  assert.throws(() => alignSkinProfile(surface, anchors.slice(1), 1, -1), /seis/);
  assert.throws(() => alignSkinProfile(surface, anchors.map(() => ({ x: .5, y: .5 })), 1, -1), /concuerdan/);
  assert.throws(() => alignSkinProfile(surface, anchors.map((p, i) => i === 3 ? { x: .98, y: .01 } : p), 1, -1), /concuerdan/);
  assert.throws(() => alignSkinProfile(surface, anchors.map(p => ({ ...p, x: NaN })), 1, -1), /seis/);
});

test('área manual de piel: no analiza toda la imagen por defecto ni acepta polígonos cruzados', () => {
  const polygon = [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  const mask = skinPolygonMask(100, 100, [polygon]);
  assert.equal(mask.reduce((a, b) => a + b), 3600);
  assert.equal(mask[0], 0); assert.equal(mask[50 * 100 + 50], 1);
  assert.ok(skinPolygonMask(50, 50, []).every(value => value === 0));
  assert.throws(() => skinPolygonMask(100, 100, [[polygon[0], polygon[2], polygon[1], polygon[3]]]), /válidas/);
  assert.ok(skinPolygonMask(1024, 1024, [polygon]).some(Boolean));
  assert.throws(() => skinPolygonMask(1401, 1024, [polygon]), /válidas/);
});

test('perfil con clics imperfectos usa la afín real, no los coeficientes modificados por TPS', () => {
  const points = PROFILE_SKIN_ANCHORS.map(({ index }) => ({
    x: surface.positions[index * 3 + 2] / height, y: -surface.positions[index * 3 + 1] / height,
  }));
  const imperfect = anchors.map((p, i) => ({ x: p.x + (i === 2 ? .003 : 0), y: p.y }));
  const affine = fitAffineRegistration(points, imperfect, 1, 1, false);
  assert.ok(affine); assert.equal(affine.warp, undefined);
  const residuals = points.map((p, i) => applyRegistration(p, affine).x - imperfect[i].x);
  assert.ok(Math.abs(residuals.reduce((sum, value) => sum + value, 0)) < 1e-8);
  assert.ok(Math.abs(residuals.reduce((sum, value, i) => sum + value * points[i].x, 0)) < 1e-8);
  assert.ok(Math.abs(residuals.reduce((sum, value, i) => sum + value * points[i].y, 0)) < 1e-8);
  const mapped = alignSkinProfile(surface, imperfect, 1, -1);
  points.forEach((point, i) => assert.deepEqual(mapped.landmarks[PROFILE_SKIN_ANCHORS[i].index], applyRegistration(point, affine)));
  assert.ok(fitAffineRegistration(points, imperfect, 1, 1).warp, 'el registro anterior conserva el warp por defecto');
});

test('selección multivista: mejor frontal y ambos lados, máximo tres y sin fotos no confirmadas', () => {
  const sources = ['front', 'a', 'b', 'a', 'extra'].map((group, i) => ({ id: `${i}`, group, confirmed: i !== 4 }));
  const results = [0.8, .7, .85, .95, 1].map((score, i) => ({ sourceId: `${i}`, score, usable: true }));
  assert.deepEqual(selectSkinPhotos(sources, results), ['0', '3', '2']);
  results[2].usable = false;
  assert.deepEqual(selectSkinPhotos(sources, results), ['0', '3', '1']);
  assert.deepEqual(selectSkinPhotos(sources, results.map(result => ({ ...result, usable: false }))), []);
});

test('RGB sintético: calidad rechaza exposición oscura y candidatos compactos son repetibles', () => {
  const width = 128, height = 128, mask = new Uint8Array(width * height).fill(1);
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const signal = Math.exp(-((x - 64) ** 2 + (y - 64) ** 2) / 18);
    image.data.set([180 + 45 * signal, 130 - 30 * signal, 110 - 10 * signal, 255], (y * width + x) * 4);
  }
  assert.ok(skinPhotoQuality(image, mask) >= .6);
  const result = analyzeSkinAppearance(image, mask, { sensitivity: .5 });
  assert.ok(skinVisualCandidates(result, mask, width, height).some(c => c.channel === 'redness'));
  image.data.fill(0); assert.equal(skinPhotoQuality(image, mask), 0);
});

test('transfiere candidato solo sobre región visible no ambigua y conserva datos de origen', () => {
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: .5 + surface.positions[i * 3] / height * .7, y: .5 - surface.positions[i * 3 + 1] / height * .7 }));
  let mapped = null;
  for (const id of [205, 50, 101, 187, 425]) {
    const p = landmarks[id], candidate = { id: 'red-1', channel: 'redness', x: p.x - .002, y: p.y - .002, width: .004, height: .004 };
    mapped = mapSkinCandidate('front', candidate, { landmarks, direction: [0, 0, 1], manual: false }, surface);
    if (mapped) break;
  }
  assert.ok(mapped);
  assert.equal(mapped.sourceId, 'front'); assert.equal(mapped.manual, false);
  assert.deepEqual(mapSkinCandidate('missing', mapped.candidate, { landmarks: [], direction: [0, 0, 1], manual: false }, surface), null);
  assert.equal(mapSkinCandidate('back', mapped.candidate, { landmarks, direction: [0, 0, -1], manual: false }, surface), null);
});

test('deduplicación solo espacial/canal entre vistas; no mezcla color y textura ni muta revisión', () => {
  const base = { id: 'front/red', sourceId: 'front', candidate: { id: 'red', channel: 'redness' },
    point: { x: 0, y: 0, z: 0 }, observations: ['front'], observationIds: ['front/red'], label: 'Frontal 1', manual: false };
  const other = { ...base, id: 'a/red', sourceId: 'a', observations: ['a'], observationIds: ['a/red'], manual: true };
  const merged = mergeSkinObservations([base, other, { ...other, id: 'b/texture', sourceId: 'b', candidate: { id: 'texture', channel: 'texture' } }], 1);
  assert.equal(merged.length, 2); assert.deepEqual(merged[0].observations, ['front', 'a']);
  assert.deepEqual(merged[0].observationIds, ['front/red', 'a/red']);
  assert.equal(merged[0].manual, true); assert.deepEqual(base.observations, ['front']); assert.equal(base.manual, false);
});

test('laterales detectados se proyectan sin exigir parche de textura ni reflejar el lado', () => {
  for (const sign of [-1, 1]) {
    const yaw = sign * Math.PI / 3;
    const landmarks = Array.from({ length: 468 }, (_, i) => ({
      x: .5 + (Math.cos(yaw) * surface.positions[i * 3] - Math.sin(yaw) * surface.positions[i * 3 + 2]) * .7 / height,
      y: .5 - surface.positions[i * 3 + 1] * .7 / height,
    }));
    const mapping = detectedSkinMapping(surface, landmarks);
    assert.ok(mapping);
    assert.equal(Math.sign(mapping.direction[0]), sign);
    const transferred = landmarks.flatMap((p, i) => {
      if (Math.sign(surface.positions[i * 3]) !== sign) return [];
      const point = mapSkinCandidate('lateral', { id: `${i}`, channel: 'redDots', x: p.x - .001, y: p.y - .001, width: .002, height: .002 }, mapping, surface);
      return point ? [point] : [];
    });
    assert.ok(transferred.length > 20);
    assert.ok(transferred.every(point => Math.sign(point.point.x) === sign));
  }
});
