import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySkinRegionRelief, applySkinRegionRgb, createSkinRegionMask, createSkinReviewRegion,
  isValidSkinPolygon,
} from '../src/lab/faceSim/skinRegionReview.ts';
import { FACE_OVAL } from '../src/lab/faceSim/engine.ts';
import { FACE_REGION_BOUNDARIES, FACE_REGION_SEEDS } from '../src/lab/faceSim/faceRegions.ts';

const square = (left = 0.25, top = 0.25, right = 0.75, bottom = 0.75) => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
function image(width = 24, height = width) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([140 + i % 60, 110, 90, 255], i * 4);
  return { width, height, data };
}
const enabled = (polygon = square(), adjustments = {}) => ({
  ...createSkinReviewRegion('zona', polygon, 'Mancha'),
  verified: true,
  adjustments: { attenuation: 0, tone: 0.8, uniformity: 0, relief: 0, ...adjustments },
});
function facialUvs() {
  const uvs = new Float32Array(468 * 2);
  for (let i = 0; i < 468; i++) uvs.set([0.5, 0.5], i * 2);
  const ellipse = (ids, cx, cy, rx, ry) => ids.forEach((id, i) => {
    const angle = 2 * Math.PI * i / ids.length;
    uvs.set([cx + rx * Math.sin(angle), cy - ry * Math.cos(angle)], id * 2);
  });
  ellipse(FACE_OVAL, 0.5, 0.5, 0.4, 0.45);
  ellipse(FACE_REGION_BOUNDARIES.leftEye, 0.34, 0.37, 0.07, 0.03);
  ellipse(FACE_REGION_BOUNDARIES.rightEye, 0.66, 0.37, 0.07, 0.03);
  ellipse([...new Set([...FACE_REGION_BOUNDARIES.upperLip, ...FACE_REGION_BOUNDARIES.lowerLip])], 0.5, 0.68, 0.12, 0.05);
  for (const [index, id] of FACE_REGION_SEEDS.find(entry => entry.zone === 'Cola de ceja').indices.entries()) {
    uvs.set([index % 2 ? 0.65 : 0.35, 0.29], id * 2);
  }
  uvs.set([0.5, 0.5], 100 * 2);
  uvs.set([0.05, 0.05], 101 * 2);
  uvs.set([0.25, 0.5], 102 * 2);
  uvs.set([0.34, 0.37], 103 * 2);
  uvs.set([0.35, 0.29], 104 * 2);
  uvs.set([0.5, 0.68], 105 * 2);
  uvs.set([0.05, 0.5], 106 * 2);
  return uvs;
}
function facialPositions() {
  const positions = new Float32Array(468 * 3);
  positions[101 * 3 + 1] = 1;
  return positions;
}

test('ROI respeta trazado y agujeros de seguridad, y rechaza dimensiones/trazados inválidos', () => {
  const safe = new Uint8Array(100).fill(1);
  safe[5 * 10 + 5] = 0;
  const mask = createSkinRegionMask(10, 10, square(0.2, 0.2, 0.8, 0.8), safe);
  assert.equal(mask[0], 0);
  assert.equal(mask[5 * 10 + 5], 0);
  assert.equal(mask[4 * 10 + 4], 1);
  assert.equal(mask.reduce((sum, value) => sum + value, 0), 35);
  assert.equal(isValidSkinPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]), false);
  assert.equal(isValidSkinPolygon([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }]), false);
  assert.equal(isValidSkinPolygon([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: 1 }]), false);
  assert.throws(() => createSkinRegionMask(769, 1, square()), RangeError);
  assert.throws(() => createSkinRegionMask(10, 10, square(), new Uint8Array(1)), TypeError);
});

test('solo una región verificada cambia RGB; valida máscara protectora y conserva alfa/original', () => {
  const source = image(), original = source.data.slice(), safe = new Uint8Array(source.width * source.height).fill(1);
  safe[12 * source.width + 12] = 0;
  const pending = enabled();
  pending.verified = false;
  assert.deepEqual(applySkinRegionRgb(source, safe, [pending]), original);
  const result = applySkinRegionRgb(source, safe, [enabled()]);
  assert.deepEqual(source.data, original);
  assert.deepEqual(result.slice(0, 4), original.slice(0, 4));
  assert.deepEqual(result.slice((12 * source.width + 12) * 4, (12 * source.width + 12) * 4 + 4),
    original.slice((12 * source.width + 12) * 4, (12 * source.width + 12) * 4 + 4));
  assert.notDeepEqual(result.slice((10 * source.width + 10) * 4, (10 * source.width + 10) * 4 + 3),
    original.slice((10 * source.width + 10) * 4, (10 * source.width + 10) * 4 + 3));
  for (let i = 3; i < result.length; i += 4) assert.equal(result[i], 255);
});

test('restablecer reproduce exactamente la fuente y mover controles no acumula retoques', () => {
  const source = image(), safe = new Uint8Array(source.width * source.height).fill(1), original = source.data.slice();
  const region = enabled();
  const first = applySkinRegionRgb(source, safe, [region]);
  const next = applySkinRegionRgb(source, safe, [{ ...region, adjustments: { ...region.adjustments, tone: -0.5 } }]);
  assert.notDeepEqual(first, next);
  assert.deepEqual(applySkinRegionRgb(source, safe, []), original);
  assert.deepEqual(applySkinRegionRgb(source, safe, [region]), first);
});

test('cicatriz: reduce contraste multiescala solo en ROI validado sin alterar alfa, zonas protegidas ni original', () => {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const shade = y >= 63 && y <= 65 ? 150 : 180;
    data.set([shade, shade - 20, shade - 35, 255], (y * width + x) * 4);
  }
  const source = { width, height, data }, original = data.slice(), safe = new Uint8Array(width * height).fill(1);
  safe[64 * width + 60] = 0;
  const region = enabled(square(), { tone: 0, scarAttenuation: 1 });
  const result = applySkinRegionRgb(source, safe, [region]);
  const contrast = bytes => bytes[(58 * width + 64) * 4] - bytes[(64 * width + 64) * 4];
  assert.ok(contrast(result) < contrast(data) * 0.75, `contraste ${contrast(data)} → ${contrast(result)}`);
  assert.deepEqual(applySkinRegionRgb(source, safe, [{ ...region, verified: false }]), original);
  assert.deepEqual(applySkinRegionRgb(source, safe, [{ ...region, adjustments: { ...region.adjustments, scarAttenuation: 0 } }]), original);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    assert.equal(result[i * 4 + 3], 255);
    if (!safe[i] || x < 32 || x >= 96 || y < 32 || y >= 96)
      assert.deepEqual(result.slice(i * 4, i * 4 + 4), data.slice(i * 4, i * 4 + 4));
  }
  assert.deepEqual(data, original);
});

test('zonas múltiples conservan sus propios ROI sin acumular cambios solapados', () => {
  const source = image(), safe = new Uint8Array(source.width * source.height).fill(1);
  const left = enabled(square(0.05, 0.1, 0.48, 0.9), { tone: 0.5 });
  const right = enabled(square(0.52, 0.1, 0.95, 0.9), { tone: -0.5 });
  const both = applySkinRegionRgb(source, safe, [left, right]);
  const overlapA = enabled(square(0.1, 0.1, 0.8, 0.9), { tone: 0.5 });
  const overlapB = enabled(square(0.2, 0.1, 0.9, 0.9), { tone: -0.5 });
  const overlapped = applySkinRegionRgb(source, safe, [overlapA, overlapB]);
  const overlapIndex = (12 * source.width + 12) * 4;
  const expectedLast = applySkinRegionRgb(source, safe, [overlapB]);
  assert.deepEqual(overlapped.slice(overlapIndex, overlapIndex + 3), expectedLast.slice(overlapIndex, overlapIndex + 3));
  assert.notDeepEqual(both, source.data);
});

test('relieve manual copia posiciones, feather suave, limita a ±1% y excluye ROI no validado', () => {
  const positions = facialPositions();
  const uvs = facialUvs();
  const original = positions.slice();
  const region = enabled(square(0.1, 0.1, 0.9, 0.9), { relief: 1 });
  const result = applySkinRegionRelief(positions, uvs, [region]);
  assert.deepEqual(positions, original);
  assert.ok(Math.abs(result[100 * 3 + 2] - 0.01) < 1e-6);
  assert.deepEqual(result.slice(101 * 3, 101 * 3 + 3), original.slice(101 * 3, 101 * 3 + 3));
  assert.deepEqual(result.slice(106 * 3, 106 * 3 + 3), original.slice(106 * 3, 106 * 3 + 3));
  for (const protectedVertex of [103, 104, 105]) {
    assert.deepEqual(result.slice(protectedVertex * 3, protectedVertex * 3 + 3),
      original.slice(protectedVertex * 3, protectedVertex * 3 + 3));
  }
  const normals = new Float32Array(positions.length);
  normals[100 * 3 + 1] = 1;
  const alongNormal = applySkinRegionRelief(positions, uvs, [region], normals);
  assert.ok(Math.abs(alongNormal[100 * 3 + 1] - 0.01) < 1e-6);
  assert.deepEqual(applySkinRegionRelief(positions, uvs, [{ ...region, verified: false }]), positions);
  const oversized = facialPositions();
  oversized[101 * 3 + 1] = 100;
  const bounded = applySkinRegionRelief(oversized, uvs, [region]);
  assert.ok(Math.abs(bounded[100 * 3 + 2]) <= 1);
  assert.deepEqual(applySkinRegionRelief(positions, new Float32Array(2), [region]), positions);
  assert.deepEqual(applySkinRegionRelief(positions, new Float32Array(positions.length / 3 * 2), [region]), positions,
    'atlas/UV sin contorno facial soportado no desplaza geometría');
});

test('rechaza estructuras de píxeles/máscara inválidas en el punto puro de confianza', () => {
  assert.throws(() => applySkinRegionRgb({ width: 4, height: 4, data: new Uint8ClampedArray(1) }, new Uint8Array(16), []), TypeError);
  assert.throws(() => applySkinRegionRgb(image(4), new Uint8Array(1), []), TypeError);
  assert.throws(() => createSkinReviewRegion('', square()), TypeError);
  assert.throws(() => createSkinReviewRegion('id', [{ x: 0, y: 0 }]), TypeError);
});
