import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { FACE_OVAL, buildPersonalSurface, expandElems, frameFromLandmarks, projectPersonal, DEFAULT_FRAME } from '../src/lab/faceSim/engine.ts';
import { moveFaceLandmark, refinePhotoContour } from '../src/lab/faceSim/faceContour.ts';
import { buildFaceRegionMap, buildFaceTriangleRegions, FACE_REGION_BOUNDARIES, facialZoneAt, isOnObservedFace, faceAttentionColor, faceRegionEducation, rasterizeFaceRegions, FACE_REGION_SEEDS, faceRegionColor } from '../src/lab/faceSim/faceRegions.ts';

test('atlas real: labios y nariz siguen contornos cerrados sin invadir piel vecina', () => {
  const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] }));
  const map = buildFaceRegionMap(landmarks, atlas.triangles, 1, atlas.positions);
  const labels = buildFaceTriangleRegions(map, atlas.positions);
  const faces = Array.from({ length: labels.length }, (_, i) => atlas.triangles.slice(i * 3, i * 3 + 3));
  const key = (a, b) => [a, b].sort((a, b) => a - b).join(':');
  for (const [boundary, zones] of [
    [FACE_REGION_BOUNDARIES.upperLip, ['Labio superior', 'Comisuras']],
    [FACE_REGION_BOUNDARIES.lowerLip, ['Labio inferior', 'Comisuras']],
    [FACE_REGION_BOUNDARIES.nose, ['Dorso nasal']],
    [FACE_REGION_BOUNDARIES.leftEye, ['Contorno ocular (revisar)']],
    [FACE_REGION_BOUNDARIES.rightEye, ['Contorno ocular (revisar)']],
  ]) {
    const borders = boundary.map((id, i) => key(id, boundary[(i + 1) % boundary.length]));
    for (const edge of borders) {
      const adjacent = faces.map((face, i) => ({ face, i })).filter(({ face }) =>
        face.some((id, j) => key(id, face[(j + 1) % 3]) === edge));
      assert.ok(adjacent.length >= 1 && adjacent.length <= 2);
      assert.ok(adjacent.some(({ i }) => zones.includes(labels[i])), `${edge}: interior`);
      // El puente de comisura es compartido por ambos labios, no por piel exterior.
      if (adjacent.length === 2 && !edge.includes('76') && !edge.includes('62') && !edge.includes('306') && !edge.includes('292')) {
        assert.ok(adjacent.some(({ i }) => !zones.includes(labels[i])), `${edge}: exterior`);
      }
    }
  }
  const zone = ids => labels[faces.findIndex(face => ids.every(id => face.includes(id)))];
  assert.equal(zone([0, 11, 37]), 'Labio superior');
  assert.equal(zone([17, 84, 85]), 'Labio inferior');
  assert.equal(zone([164, 0, 267]), 'Piel supralabial / filtrum');
  assert.notEqual(zone([83, 18, 17]), 'Labio inferior');
  assert.equal(zone([6, 122, 168]), 'Dorso nasal');
  assert.throws(() => buildFaceTriangleRegions({ ...map, triangles: [0, 11, 37] }, atlas.positions), /límites/);
});

function ovalFixture() {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  FACE_OVAL.forEach((index, i) => {
    const angle = 2 * Math.PI * i / FACE_OVAL.length;
    landmarks[index] = { x: 0.5 + 0.29 * Math.sin(angle), y: 0.5 - 0.38 * Math.cos(angle), z: 0.02 };
  });
  const triangles = FACE_OVAL.flatMap((index, i) => [1, index, FACE_OVAL[(i + 1) % FACE_OVAL.length]]);
  return { landmarks, triangles };
}

test('capa educativa distingue referencias de ausencia de información, nunca zonas seguras', () => {
  assert.match(faceRegionEducation('Glabela'), /supratroclear/);
  assert.match(faceRegionEducation('Labio superior'), /labiales/);
  assert.equal(faceRegionEducation('Región desconocida'), undefined);
  assert.equal(faceAttentionColor('Glabela'), '#f59e0b');
  assert.equal(faceAttentionColor('Región desconocida'), '#94a3b8');
});

test('zonas distintas tienen colores propios y la capa interpola sin pintar fuera del rostro', () => {
  assert.equal(new Set(FACE_REGION_SEEDS.map(z => faceRegionColor(z.zone))).size, FACE_REGION_SEEDS.length);
  const map = { landmarks: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], triangles: [0, 1, 2], labels: ['A', 'B', 'C'] };
  const pixels = rasterizeFaceRegions(map, 100, 100, z => ({ A: '#ff0000', B: '#00ff00', C: '#0000ff' })[z]);
  const at = (x, y) => [...pixels.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
  assert.deepEqual(at(25, 25), [125, 65, 65, 255]);
  assert.deepEqual(at(90, 90), [0, 0, 0, 0]);
  assert.ok(rasterizeFaceRegions(map, 20, 20, undefined, () => false).every(v => v === 0));
  assert.match(facialZoneAt({ x: 0.4, y: 0.3 }, map), /límite aproximado/);
  assert.equal(facialZoneAt({ x: 0.01, y: 0.01 }, map), 'A');
  assert.throws(() => rasterizeFaceRegions(map, 0, 20), /inválidas/);
});

test('métrica canónica conserva etiquetas entre rostros y la caché no expone arrays mutables', () => {
  const { landmarks, triangles } = regionFixture();
  const reference = landmarks.slice(0, 468).flatMap(p => [p.x, p.y, p.z]);
  const a = buildFaceRegionMap(landmarks, triangles, 0.75, reference);
  const warped = landmarks.map(p => ({ ...p, x: p.x * p.x, y: p.y * 1.4 }));
  const b = buildFaceRegionMap(warped, triangles, 0.75, reference);
  assert.deepEqual(a.labels, b.labels);
  a.labels[9] = 'Mutación externa';
  assert.equal(buildFaceRegionMap(warped, triangles, 0.75, reference).labels[9], 'Glabela');
});

test('corregir mentón fuera del óvalo actual modifica marco, malla y UV sin cambiar Z', () => {
  const { landmarks, triangles } = ovalFixture();
  const before = structuredClone(landmarks);
  const target = { x: landmarks[152].x, y: landmarks[152].y + 0.035 };
  const corrected = moveFaceLandmark(landmarks, 152, target, 0.75, triangles);
  assert.ok(corrected);
  assert.deepEqual(landmarks, before);
  assert.deepEqual({ x: corrected[152].x, y: corrected[152].y }, target);
  assert.equal(frameFromLandmarks(corrected).bottom, target.y);
  assert.ok(corrected[148].y > landmarks[148].y, 'también mueve la mandíbula adyacente');
  corrected.forEach((p, i) => assert.equal(p.z, before[i].z));
  const surface = buildPersonalSurface(corrected, 0.75, triangles);
  const index = 152;
  const projected = projectPersonal({ x: surface.positions[index * 3], y: surface.positions[index * 3 + 1], z: surface.positions[index * 3 + 2] }, surface.projection);
  assert.ok(Math.abs(projected.y - target.y) < 1e-6);
  assert.ok(Math.abs(surface.uvs[index * 2 + 1] - target.y) < 1e-6);
});

test('sien: la corrección es local; puntos opuestos intactos y pliegues rechazados', () => {
  const { landmarks, triangles } = ovalFixture();
  const p = landmarks[356];
  const result = moveFaceLandmark(landmarks, 356, { x: p.x + 0.02, y: p.y }, 0.75, triangles);
  assert.ok(result);
  assert.deepEqual(result[127], landmarks[127]);
  assert.equal(moveFaceLandmark(landmarks, 356, { x: -0.1, y: 0.5 }, 0.75, triangles), null);
  assert.equal(moveFaceLandmark(landmarks, 356, { x: NaN, y: 0.5 }, 0.75, triangles), null);
  assert.equal(moveFaceLandmark(landmarks, 356, { x: 0.4, y: p.y }, 0.75, triangles), null);
  assert.equal(moveFaceLandmark(landmarks, 356, { x: p.x, y: p.y }, 0.75, [0, 1, 999]), null);
});

test('referencia compuesta: el promedio de ambos bordes de ceja coincide exactamente', () => {
  const { landmarks, triangles } = ovalFixture();
  landmarks[70] = { x: 0.3, y: 0.3, z: 0 };
  landmarks[46] = { x: 0.3, y: 0.32, z: 0 };
  const target = { x: 0.31, y: 0.32 };
  const moved = moveFaceLandmark(landmarks, 70, target, 0.75, triangles, [70, 46]);
  assert.ok(moved);
  assert.ok(Math.abs((moved[70].x + moved[46].x) / 2 - target.x) < 1e-12);
  assert.ok(Math.abs((moved[70].y + moved[46].y) / 2 - target.y) < 1e-12);
});

function ellipseImage() {
  const width = 400, height = 500, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = ((x / width - 0.5) / 0.305) ** 2 + ((y / height - 0.5) / 0.405) ** 2 < 1;
    data.set(inside ? [190, 145, 130, 255] : [15, 20, 25, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test('borde visible: reduce el recorte del mentón sin expansión arbitraria en imágenes uniformes', () => {
  const { landmarks, triangles } = ovalFixture();
  const image = ellipseImage();
  const refined = refinePhotoContour(landmarks, FACE_OVAL, triangles, image);
  assert.ok(refined.adjusted > 0);
  assert.ok(refined.landmarks[152].y > landmarks[152].y);
  assert.ok(Math.abs(refined.landmarks[152].y - 0.905) < Math.abs(landmarks[152].y - 0.905));
  image.data.fill(100);
  const unchanged = refinePhotoContour(landmarks, FACE_OVAL, triangles, image);
  assert.equal(unchanged.adjusted, 0);
  assert.equal(unchanged.landmarks, landmarks);
});

function regionFixture(transform = p => p) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const groups = [
    { ids: [9, 8, 55], label: 'Glabela', x: 0.5, y: 0.3 },
    { ids: [0, 11, 13], label: 'Labio superior', x: 0.5, y: 0.70 },
    { ids: [14, 15, 17], label: 'Labio inferior', x: 0.5, y: 0.79 },
    { ids: [152, 175, 199], label: 'Mentón', x: 0.5, y: 0.87 },
    { ids: [127, 162, 21], label: 'Región temporal', x: 0.2, y: 0.25 },
    { ids: [1, 4, 6], label: 'Dorso nasal', x: 0.5, y: 0.5 },
    { ids: [10, 151, 108], label: 'Frente', x: 0.5, y: 0.12 },
  ];
  groups.forEach(({ ids, x, y }) => {
    [[x - 0.04, y - 0.02], [x + 0.04, y - 0.02], [x, y + 0.04]].forEach(([x, y], i) => {
      landmarks[ids[i]] = { ...transform({ x, y }), z: -0.03 };
    });
  });
  const triangles = groups.flatMap(g => g.ids);
  return { landmarks, triangles, groups };
}

test('zonas por triángulos anatómicos: glabela, labios, mentón, sien, nariz y frente en rostro inclinado', () => {
  const transform = p => ({ x: 0.7 * p.x - 0.3 * p.y + 0.2, y: 0.3 * p.x + 0.7 * p.y + 0.08 });
  const { landmarks, triangles, groups } = regionFixture(transform);
  const map = buildFaceRegionMap(landmarks, triangles, 0.75);
  for (const { x, y, label } of groups) assert.equal(facialZoneAt(transform({ x, y }), map), label);
  assert.equal(facialZoneAt({ x: 0.99, y: 0.99 }, map), null);
  assert.equal(facialZoneAt({ x: NaN, y: 0.5 }, map), null);
  assert.throws(() => buildFaceRegionMap(landmarks, [0, 1, 999], 1), /inválida/);
});

test('auto se aplica a puntos y muestras de trazos; zona manual tiene prioridad', () => {
  const { landmarks, triangles } = regionFixture();
  const map = buildFaceRegionMap(landmarks, triangles, 0.75);
  const base = { mode: 'toxina', dose: 1, zone: 'Auto' };
  const elements = [
    { ...base, id: 'm', kind: 'point', paths: [[{ x: 0.5, y: 0.3 }]] },
    { ...base, id: 'l', kind: 'line', paths: [[{ x: 0.49, y: 0.715 }, { x: 0.51, y: 0.725 }]] },
    { ...base, id: 'manual', kind: 'point', zone: 'Mi zona', paths: [[{ x: 0.5, y: 0.3 }]] },
  ];
  const result = expandElems(elements, DEFAULT_FRAME, 0.75, p => facialZoneAt(p, map));
  assert.equal(result.points[0].zone, 'Glabela');
  assert.equal(result.points[1].zone, 'Mi zona');
  assert.ok(result.derived.length > 0);
  assert.ok(result.derived.every(p => p.zone === 'Labio superior'));
});

test('un punto posterior no se clasifica como facial por coincidir XY', () => {
  const { landmarks, triangles } = regionFixture();
  const surface = buildPersonalSurface(landmarks, 0.75, triangles);
  const map = buildFaceRegionMap(landmarks, triangles, 0.75);
  const ids = [9, 8, 55], p = { x: 0, y: 0, z: 0 };
  for (const i of ids) for (const [j, key] of ['x', 'y', 'z'].entries()) p[key] += surface.positions[i * 3 + j] / 3;
  assert.equal(isOnObservedFace(p, surface, map), true);
  assert.equal(isOnObservedFace({ ...p, z: p.z - 1 }, surface, map), false);
});
