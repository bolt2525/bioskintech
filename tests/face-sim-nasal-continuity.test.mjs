import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';

const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const simulation = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const { createSimulationMesh, deformPositions, meshBounds } = simulation;
const params = { noseBridge: -0.3, noseHump: -0.25, noseTip: -0.41, noseRotation: 0.46, noseWidth: 0.14 };
const pointAt = (positions, index) => Array.from(positions.slice(index * 3, index * 3 + 3));
const average = (positions, ids) => ids.reduce((sum, id) => {
  const point = pointAt(positions, id);
  return sum.map((value, axis) => value + point[axis] / ids.length);
}, [0, 0, 0]);

function syntheticPersonalMesh() {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const surface = buildPersonalSurface(
    fixture.landmarks.map(([x, y, z]) => ({ x, y, z })),
    fixture.aspect,
    trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
  );
  assert.ok(surface, 'la fixture sintética debe producir una superficie facial válida');
  return createSimulationMesh(surface);
}

function dorsalSamples(anchors, count = 129) {
  const tip = average(anchors, [1, 4]);
  const landmarks = [tip, average(anchors, [5]), average(anchors, [195]), average(anchors, [197]), average(anchors, [6])]
    .sort((a, b) => a[1] - b[1]);
  const height = Math.hypot(
    anchors[10 * 3] - anchors[152 * 3],
    anchors[10 * 3 + 1] - anchors[152 * 3 + 1],
    anchors[10 * 3 + 2] - anchors[152 * 3 + 2],
  );
  const start = landmarks[0][1] - height * 0.06;
  const end = landmarks.at(-1)[1] + height * 0.08;
  const axis = (anchors[10 * 3] + anchors[152 * 3] + anchors[1 * 3]) / 3;
  const samples = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const y = start + (end - start) * i / (count - 1);
    let upper = landmarks.findIndex(point => point[1] >= y);
    if (upper < 0) upper = landmarks.length - 1;
    const lower = Math.max(0, upper - 1);
    const span = landmarks[upper][1] - landmarks[lower][1];
    const t = span > 1e-8 ? (y - landmarks[lower][1]) / span : 0;
    const z = landmarks[lower][2] + (landmarks[upper][2] - landmarks[lower][2]) * t;
    samples.set([axis, y, z], i * 3);
  }
  return { samples, height, step: (end - start) / (count - 1) };
}

function cross(a, b, c) {
  const ab = b.map((value, i) => value - a[i]), ac = c.map((value, i) => value - a[i]);
  return [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
}

function dot(a, b) {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

for (const [label, mesh] of [['atlas sintético', createSimulationMesh()], ['fixture personal sintética', syntheticPersonalMesh()]]) {
  test(`${label}: dorso continuo C1, finito y sin pico de deformación agudo`, t => {
    const { samples, height, step } = dorsalSamples(mesh.anchors);
    const result = deformPositions(samples, mesh.anchors, params);
    assert.ok(result.every(Number.isFinite));
    const displacement = Array.from({ length: samples.length / 3 }, (_, i) =>
      result[i * 3 + 2] - samples[i * 3 + 2]);
    const slopes = displacement.slice(1).map((value, i) => (value - displacement[i]) / step);
    const maxSlopeIndex = slopes.reduce((best, value, i) => Math.abs(value) > Math.abs(slopes[best]) ? i : best, 0);
    const maxSlope = Math.abs(slopes[maxSlopeIndex]);
    const maxSlopeJump = Math.max(...slopes.slice(1).map((value, i) => Math.abs(value - slopes[i])));
    const maxCurvature = maxSlopeJump / step;

    assert.ok(maxSlope < 1.6, `gradiente de dorso demasiado abrupto: ${maxSlope} en y=${samples[maxSlopeIndex * 3 + 1]}`);
    assert.ok(maxSlopeJump < 0.12, `el gradiente no es continuo: salto ${maxSlopeJump}`);
    assert.ok(maxCurvature < 14, `curvatura longitudinal aguda: ${maxCurvature}`);
    assert.ok(meshBounds(result).height > 0);
    t.diagnostic(`|∂z/∂y|max=${maxSlope.toFixed(3)}; |∂²z/∂y²|max=${maxCurvature.toFixed(3)}`);
  });

  test(`${label}: conserva ojos y labios; no invierte triángulos nasales`, t => {
    const result = deformPositions(mesh.positions, mesh.anchors, params);
    const deformedAnchors = deformPositions(mesh.anchors, mesh.anchors, params);
    assert.ok(result.every(Number.isFinite));
    for (const id of [33, 263, 159, 386, 0, 13, 14, 17, 61, 291]) {
      assert.deepEqual(pointAt(deformedAnchors, id), pointAt(mesh.anchors, id), `landmark protegido ${id}`);
    }

    let checked = 0, minAreaRatio = Infinity;
    const height = Math.hypot(
      mesh.anchors[10 * 3] - mesh.anchors[152 * 3],
      mesh.anchors[10 * 3 + 1] - mesh.anchors[152 * 3 + 1],
      mesh.anchors[10 * 3 + 2] - mesh.anchors[152 * 3 + 2],
    );
    const axis = (mesh.anchors[10 * 3] + mesh.anchors[152 * 3] + mesh.anchors[1 * 3]) / 3;
    const tipY = average(mesh.anchors, [1, 4])[1], radixY = average(mesh.anchors, [6, 197, 195])[1];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ids = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
      const original = ids.map(id => pointAt(mesh.positions, id));
      const center = original[0].map((_, axis) => original.reduce((sum, point) => sum + point[axis] / 3, 0));
      if (Math.abs(center[0] - axis) > height * 0.2
        || center[1] < tipY - height * 0.1 || center[1] > radixY + height * 0.15) continue;

      const deformed = ids.map(id => pointAt(result, id));
      const beforeNormal = cross(...original), afterNormal = cross(...deformed);
      if (Math.hypot(...beforeNormal) < 1e-8) continue;
      assert.ok(dot(beforeNormal, afterNormal) > 0, `triángulo invertido en nariz: ${i / 3}`);
      const areaRatio = Math.hypot(...afterNormal) / Math.hypot(...beforeNormal);
      minAreaRatio = Math.min(minAreaRatio, areaRatio);
      assert.ok(areaRatio > 0.05, `triángulo colapsado: ${i / 3}`);
      checked++;
    }
    assert.ok(checked > 0, 'debe validarse un conjunto de triángulos nasales');
    t.diagnostic(`triángulos comprobados=${checked}; ratio de área mínimo=${minAreaRatio.toFixed(3)}`);
  });
}

test('neutralidad exacta y simetría nasal direccional permanecen estables', () => {
  const mesh = createSimulationMesh();
  assert.deepEqual(deformPositions(mesh.positions, mesh.anchors, {}), mesh.positions);
  const positive = deformPositions(mesh.anchors, mesh.anchors, { noseSymmetry: 0.5 });
  const negative = deformPositions(mesh.anchors, mesh.anchors, { noseSymmetry: -0.5 });
  assert.notDeepEqual(positive, mesh.anchors);
  assert.notDeepEqual(negative, mesh.anchors);
  assert.notDeepEqual(positive, negative);
});
