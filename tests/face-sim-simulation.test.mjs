import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const sim = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const {
  NEUTRAL_SIMULATION, SIMULATION_CONTROLS, SIMULATION_LAYERS, createSimulationMesh, deformPositions,
  localInfluence, sanitizeSimulation, buildSimulationLayers, meshBounds, buildCutPlane, isPointRetained, vertexNormals,
  personalFaceFrame, toCanonicalPosition, fromCanonicalPosition,
} = sim;
const mesh = createSimulationMesh();
const at = (positions, i) => ({ x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const personal = () => ({
  positions: Float32Array.from(atlas.positions), indices: Uint32Array.from(atlas.triangles),
  uvs: new Float32Array(468 * 2), projection: { cx: 0, cy: 0, k: 1, aspect: 1 },
});

test('neutralidad exacta, copias independientes y evaluación sin acumulación', () => {
  const original = mesh.positions.slice();
  const neutral = deformPositions(mesh.positions, mesh.anchors, NEUTRAL_SIMULATION);
  assert.deepEqual(neutral, original);
  assert.notEqual(neutral, mesh.positions);
  const modified = deformPositions(mesh.positions, mesh.anchors, { noseTip: 1, jawWidth: -1 });
  assert.notDeepEqual(modified, original);
  assert.deepEqual(deformPositions(mesh.positions, mesh.anchors, {}), original);
  assert.deepEqual(mesh.positions, original);
  assert.deepEqual(modified, deformPositions(mesh.positions, mesh.anchors, { noseTip: 1, jawWidth: -1 }));
});

test('localización: punta cambia, frente y mentón no; mandíbula no modifica nariz', () => {
  const nasal = deformPositions(mesh.anchors, mesh.anchors, { noseTip: 1 });
  assert.ok(at(nasal, 1).z > at(mesh.anchors, 1).z + 0.05);
  for (const id of [10, 152, 172, 397]) assert.deepEqual(at(nasal, id), at(mesh.anchors, id));
  const jaw = deformPositions(mesh.anchors, mesh.anchors, { jawWidth: 1 });
  assert.ok(Math.abs(at(jaw, 172).x) > Math.abs(at(mesh.anchors, 172).x));
  assert.deepEqual(at(jaw, 1), at(mesh.anchors, 1));
  const chin = deformPositions(mesh.anchors, mesh.anchors, { chinProjection: 1, chinHeight: 1 });
  assert.ok(at(chin, 152).z > at(mesh.anchors, 152).z);
  assert.ok(at(chin, 152).y < at(mesh.anchors, 152).y);
  assert.deepEqual(at(chin, 10), at(mesh.anchors, 10));
});

test('cada control produce un cambio visible y direcciones coherentes', () => {
  for (const { key } of SIMULATION_CONTROLS) {
    const result = deformPositions(mesh.anchors, mesh.anchors, { [key]: 1 });
    assert.ok(result.some((v, i) => Math.abs(v - mesh.anchors[i]) > 0.005), key);
  }
  const rotated = deformPositions(mesh.anchors, mesh.anchors, { noseRotation: 1 });
  assert.ok(at(rotated, 1).y > at(mesh.anchors, 1).y);
  const wide = deformPositions(mesh.anchors, mesh.anchors, { noseWidth: 1 });
  assert.ok(at(wide, 98).x < at(mesh.anchors, 98).x);
  assert.ok(at(wide, 327).x > at(mesh.anchors, 327).x);
});

test('simetría de campos en una superficie simétrica, sin forzar simetría al paciente', () => {
  const anchors = mesh.anchors.slice();
  for (const id of [10, 152, 1, 4, 6, 197, 195, 175, 199]) anchors[id * 3] = 0;
  for (const [a, b] of [[98, 327], [172, 397], [136, 365]]) {
    const x = (Math.abs(anchors[a * 3]) + Math.abs(anchors[b * 3])) / 2;
    const y = (anchors[a * 3 + 1] + anchors[b * 3 + 1]) / 2;
    const z = (anchors[a * 3 + 2] + anchors[b * 3 + 2]) / 2;
    anchors.set([-x, y, z], a * 3); anchors.set([x, y, z], b * 3);
  }
  const probes = Float32Array.from([-0.25, 0.1, 1.5, 0.25, 0.1, 1.5, -0.85, -0.55, 0.6, 0.85, -0.55, 0.6]);
  const result = deformPositions(probes, anchors, { noseWidth: 1, jawWidth: 1, noseTip: 1 });
  for (const [a, b] of [[0, 1], [2, 3]]) {
    assert.ok(Math.abs(result[a * 3] + result[b * 3]) < 1e-6);
    assert.ok(Math.abs(result[a * 3 + 1] - result[b * 3 + 1]) < 1e-6);
    assert.ok(Math.abs(result[a * 3 + 2] - result[b * 3 + 2]) < 1e-6);
  }
});

test('soporte compacto y transición suave en borde de influencia', () => {
  const c = { x: 0, y: 0, z: 0 }, r = { x: 1, y: 1, z: 1 };
  assert.equal(localInfluence(c, c, r), 1);
  assert.equal(localInfluence({ x: 1, y: 0, z: 0 }, c, r), 0);
  assert.equal(localInfluence({ x: 10, y: 0, z: 0 }, c, r), 0);
  assert.ok(localInfluence({ x: 0.999, y: 0, z: 0 }, c, r) < 1e-10);
});

test('límites finitos, normalización de entradas extremas y desplazamiento acotado', () => {
  assert.equal(sanitizeSimulation({ noseTip: Infinity }).noseTip, 0);
  assert.equal(sanitizeSimulation({ noseBridge: NaN }).noseBridge, 0);
  assert.equal(sanitizeSimulation({ noseWidth: 900 }).noseWidth, 1);
  assert.equal(sanitizeSimulation({ jawWidth: -900 }).jawWidth, -1);
  for (const sign of [-1, 1]) {
    const params = Object.fromEntries(SIMULATION_CONTROLS.map(({ key }) => [key, sign * 1e10]));
    const out = deformPositions(mesh.positions, mesh.anchors, params);
    assert.ok(out.every(Number.isFinite));
    const height = meshBounds(mesh.positions).height;
    for (let i = 0; i < out.length / 3; i++) assert.ok(distance(at(out, i), at(mesh.positions, i)) < height * 0.2);
  }
});

test('fuentes personal/genérica: buffers propios y errores explícitos', () => {
  assert.equal(mesh.source, 'generic');
  assert.ok(mesh.positions.length > 468 * 3);
  const input = personal(), own = createSimulationMesh(input);
  assert.equal(own.source, 'personal');
  own.positions[0] += 1; own.uvs[0] = 0.5; own.indices[0] = 0;
  assert.notEqual(own.positions[0], input.positions[0]);
  assert.equal(input.uvs[0], 0);
  assert.throws(() => createSimulationMesh({ ...personal(), positions: new Float32Array(3) }), /mesh468/);
  const bad = personal(); bad.positions[0] = NaN;
  assert.throws(() => createSimulationMesh(bad), /no finitas/);
  const index = personal(); index.indices[0] = 10000;
  assert.throws(() => createSimulationMesh(index), /mesh468/);
  assert.throws(() => createSimulationMesh({ ...personal(), projection: { cx: 0, cy: 0, k: 0, aspect: 1 } }), /proyección/);
});

test('perfiles y roll: base canónica estable, deformación anatómica y UV sin giro', () => {
  const input = personal(), reference = createSimulationMesh(input);
  const settings = { noseTip: 1, chinProjection: 1, jawWidth: 0.7 };
  const referenceLayers = buildSimulationLayers(reference, settings);
  for (const yaw of [-1.25, 1.25]) {
    const rotated = personal(), roll = 0.28;
    for (let i = 0; i < 468; i++) {
      const p = at(input.positions, i);
      const x = p.x * Math.cos(yaw) + p.z * Math.sin(yaw), z = -p.x * Math.sin(yaw) + p.z * Math.cos(yaw);
      rotated.positions.set([x * Math.cos(roll) - p.y * Math.sin(roll) + 2, x * Math.sin(roll) + p.y * Math.cos(roll) - 3, z + 4], i * 3);
      rotated.uvs.set([i / 468, 0.25], i * 2);
    }
    const canonical = createSimulationMesh(rotated), frame = personalFaceFrame(rotated);
    assert.deepEqual(canonical.uvs, rotated.uvs);
    for (let i = 0; i < 468; i++) {
      assert.ok(distance(at(canonical.positions, i), at(reference.positions, i)) < 2e-6);
      const restored = fromCanonicalPosition(toCanonicalPosition(at(rotated.positions, i), frame), frame);
      assert.ok(distance(restored, at(rotated.positions, i)) < 1e-6);
      // Mismo píxel al volver por la proyección original (cx/cy/k/aspect no son una pose).
      const project = p => ({ x: (p.x / rotated.projection.k + rotated.projection.cx) / rotated.projection.aspect, y: -(p.y / rotated.projection.k + rotated.projection.cy) });
      assert.ok(Math.abs(project(restored).x - project(at(rotated.positions, i)).x) < 1e-6);
      assert.ok(Math.abs(project(restored).y - project(at(rotated.positions, i)).y) < 1e-6);
    }
    const a = deformPositions(reference.positions, reference.anchors, settings);
    const b = deformPositions(canonical.positions, canonical.anchors, settings);
    for (let i = 0; i < 468; i++) assert.ok(distance(at(a, i), at(b, i)) < 2e-6);
    const tip = fromCanonicalPosition(at(b, 1), frame), originalTip = at(rotated.positions, 1);
    const delta = { x: tip.x - originalTip.x, y: tip.y - originalTip.y, z: tip.z - originalTip.z };
    assert.ok(delta.x * frame.forward.x + delta.y * frame.forward.y + delta.z * frame.forward.z > 0.05);
    const layers = buildSimulationLayers(canonical, settings);
    for (let i = 0; i < layers.length; i++) {
      const expected = meshBounds(referenceLayers[i].positions), actual = meshBounds(layers[i].positions);
      assert.ok(distance(expected.min, actual.min) < 1e-4, layers[i].id);
      assert.ok(distance(expected.max, actual.max) < 1e-4, layers[i].id);
    }
  }
});

test('cinco capas simultáneas: mallas válidas, bandas y tubos no elipsoides', () => {
  const source = mesh.positions.slice();
  const layers = buildSimulationLayers(mesh, {});
  assert.deepEqual(layers.map(l => l.id), SIMULATION_LAYERS.map(l => l.id));
  for (const layer of layers) {
    assert.ok(layer.positions.length > 100 && layer.indices.length > 100, layer.id);
    assert.ok(layer.positions.every(Number.isFinite), layer.id);
    assert.equal(layer.indices.length % 3, 0);
    assert.ok(layer.indices.every(i => i < layer.positions.length / 3), layer.id);
  }
  assert.equal(layers[0].positions.length, mesh.positions.length);
  assert.notDeepEqual(layers[0].positions, layers[1].positions);
  assert.equal(layers[2].colors.length, layers[2].positions.length);
  assert.deepEqual(mesh.positions, source);
  const h = distance(at(mesh.anchors, 10), at(mesh.anchors, 152));
  const normals = vertexNormals(mesh.positions, mesh.indices);
  for (let i = 0; i < mesh.positions.length / 3; i += 31) {
    const n = at(normals, i), normalLength = Math.hypot(n.x, n.y, n.z);
    if (normalLength > 0.5) assert.ok(Math.abs(distance(at(layers[0].positions, i), at(layers[1].positions, i)) - h * 0.012) < 1e-6);
  }
});

test('capas se adaptan al modelo personal, escala y morfología modificada', () => {
  const input = personal(), own = createSimulationMesh(input);
  const neutral = buildSimulationLayers(own, {}), changed = buildSimulationLayers(own, { jawWidth: 1, chinProjection: 1, noseWidth: 1 });
  for (let i = 0; i < neutral.length; i++) assert.notDeepEqual(changed[i].positions, neutral[i].positions, neutral[i].id);
  const scaled = personal(); scaled.positions = Float32Array.from(scaled.positions, v => v * 1.5);
  const larger = buildSimulationLayers(createSimulationMesh(scaled), {});
  for (let i = 0; i < neutral.length; i++) {
    // El remuestreo puede variar un paso por redondeo, pero la envolvente debe escalar.
    const a = meshBounds(neutral[i].positions), b = meshBounds(larger[i].positions);
    assert.ok(Math.abs(b.height / a.height - 1.5) < 0.03, neutral[i].id);
  }
});

test('corte en tres ejes, inversión y extremos; no altera geometría original', () => {
  const bounds = meshBounds(mesh.positions);
  assert.equal(buildCutPlane(bounds, { scope: 'none', axis: 'x', position: 0.5, reverse: false }), null);
  assert.equal(isPointRetained(bounds.center, null), true);
  for (const axis of ['x', 'y', 'z']) {
    const cut = { scope: 'all', axis, position: 0.5, reverse: false };
    const plane = buildCutPlane(bounds, cut), reverse = buildCutPlane(bounds, { ...cut, reverse: true });
    const low = { ...bounds.center, [axis]: bounds.min[axis] }, high = { ...bounds.center, [axis]: bounds.max[axis] };
    assert.equal(isPointRetained(low, plane), false); assert.equal(isPointRetained(high, plane), true);
    assert.equal(isPointRetained(low, reverse), true); assert.equal(isPointRetained(high, reverse), false);
    assert.equal(isPointRetained(low, buildCutPlane(bounds, { ...cut, position: 0 })), true);
    assert.equal(isPointRetained(high, buildCutPlane(bounds, { ...cut, position: 1 })), false);
    assert.deepEqual(buildCutPlane(bounds, { ...cut, scope: 'skin' }), plane);
  }
});
