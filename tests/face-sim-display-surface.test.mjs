import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';
import { createSimulationMesh, deformPositions, SIMULATION_CONTROLS } from '../src/lab/faceSim/simulation.ts';
import { buildPersonalSurface } from '../src/lab/faceSim/engine.ts';

const delta = (p, a, b) => [0, 1, 2].map(k => p[a * 3 + k] - p[b * 3 + k]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, v, k) => sum + v * b[k], 0);
const normal = (p, indices, offset) => cross(delta(p, indices[offset + 1], indices[offset]), delta(p, indices[offset + 2], indices[offset]));
const generic = createSimulationMesh();
const refined = refineDisplaySurface(generic.positions, generic.indices);

test('refinado interpolante: anclas intactas, buffers independientes y sin triángulos invertidos', () => {
  assert.deepEqual(refined.positions.slice(0, generic.positions.length), generic.positions);
  assert.equal(refined.indices.length, generic.indices.length * refined.indexMultiplier);
  assert.ok(refined.indices.length / 3 <= 20000, 'presupuesto de visualización genérica');
  assert.ok(refined.positions.length < generic.positions.length * 16);
  assert.notEqual(refined.positions, generic.positions);
  assert.ok(refined.positions.every(Number.isFinite));
  for (let i = 0; i < refined.indices.length; i += 3) {
    const parent = Math.floor(i / (3 * refined.indexMultiplier)) * 3;
    const n = normal(generic.positions, generic.indices, parent), child = normal(refined.positions, refined.indices, i);
    assert.ok(dot(n, child) > 0, `orientación del triángulo ${i / 3}`);
    assert.ok(Math.hypot(...child) / Math.hypot(...n) > 0.02, 'sin láminas colapsadas');
  }
});

test('contorno curvo: reduce los ángulos del borde sin mover anclas ni cerrar agujeros', () => {
  const points = [0, 0, 0], indices = [];
  for (let i = 0; i < 12; i++) points.push(Math.cos(i * Math.PI / 6), Math.sin(i * Math.PI / 6), 0);
  for (let i = 0; i < 12; i++) indices.push(0, i + 1, (i + 1) % 12 + 1);
  const source = Float32Array.from(points), result = refineDisplaySurface(source, Uint32Array.from(indices));
  const edges = new Map();
  for (let i = 0; i < result.indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = result.indices[i + j], b = result.indices[i + (j + 1) % 3], key = [a, b].sort((a, b) => a - b).join(':');
    const edge = edges.get(key);
    if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
  }
  const boundary = new Map();
  for (const { a, b, count } of edges.values()) if (count === 1) {
    boundary.set(a, [...(boundary.get(a) ?? []), b]); boundary.set(b, [...(boundary.get(b) ?? []), a]);
  }
  assert.equal(boundary.size, 48);
  let maxTurn = 0;
  for (const [i, [a, b]] of boundary) {
    const u = delta(result.positions, i, a), v = delta(result.positions, b, i);
    maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, dot(u, v) / Math.hypot(...u) / Math.hypot(...v)))));
  }
  assert.ok(maxTurn < Math.PI / 12, `giro máximo ${maxTurn}; antes ${Math.PI / 6}`);
  assert.deepEqual(result.positions.slice(0, source.length), source);
});

test('UV, alfas y parches comparten subdivisión; conserva separación observado/inferido', () => {
  const uv = Float32Array.from({ length: generic.positions.length / 3 * 2 }, (_, i) => (i % 7) / 7);
  const alpha = new Float32Array(generic.positions.length / 3).fill(0.7);
  const nextUV = refined.attribute(uv, 2), nextAlpha = refined.attribute(alpha, 1);
  assert.equal(nextUV.length, refined.positions.length / 3 * 2);
  assert.deepEqual(nextUV.slice(0, uv.length), uv);
  assert.ok(nextUV.every(v => v >= 0 && v <= 1));
  assert.ok(nextAlpha.every(v => Math.abs(v - 0.7) < 1e-6));
  const split = 30;
  assert.deepEqual(refined.indicesFor(generic.indices.slice(0, split)), refined.indices.slice(0, split * refined.indexMultiplier));
  assert.deepEqual(refined.indicesFor(generic.indices.slice(split)), refined.indices.slice(split * refined.indexMultiplier));
  assert.throws(() => refined.attribute(new Float32Array(2), 2), /incompatible/);
  assert.throws(() => refined.indicesFor(Uint32Array.of(900000, 900001, 900002)), /ajeno/);
});

test('nariz y mentón en ambos extremos: sin inversiones, compresión ni estiramiento en aguja', () => {
  for (const key of ['noseTip', 'noseRotation', 'chinProjection', 'chinHeight', 'chinWidth']) for (const sign of [-1, 1]) {
    const output = deformPositions(refined.positions, generic.anchors, { [key]: sign });
    for (let i = 0; i < refined.indices.length; i += 3) {
      assert.ok(dot(normal(refined.positions, refined.indices, i), normal(output, refined.indices, i)) > 0, `${key} ${sign}: inversión`);
      for (let j = 0; j < 3; j++) {
        const a = refined.indices[i + j], b = refined.indices[i + (j + 1) % 3];
        const before = delta(refined.positions, a, b), after = delta(output, a, b);
        const length = Math.hypot(...before);
        if (length < 1e-6) continue;
        assert.ok(Math.hypot(...after) / length < 1.8, `${key}: estiramiento excesivo`);
        assert.ok(dot(before, after) / dot(before, before) > 0.35, `${key}: compresión excesiva`);
      }
    }
  }
  assert.deepEqual(deformPositions(refined.positions, generic.anchors, {}), refined.positions);
});

test('controles nasales y mandibulares combinados conservan orientación en genérico y máscara sintética', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
  const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
  const personal = createSimulationMesh(buildPersonalSurface(
    fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect, atlas.triangles));
  const personalDisplay = refineDisplaySurface(personal.positions, personal.indices);
  const cases = SIMULATION_CONTROLS.filter(({ group }) => group === 'Nariz' || group === 'Mentón y mandíbula')
    .flatMap(({ key }) => [-1, 1].map(sign => ({ [key]: sign })));
  for (const noseTip of [-1, 1]) for (const chinProjection of [-1, 1]) {
    cases.push({ noseTip, noseRotation: noseTip, chinProjection, chinHeight: chinProjection });
  }
  for (const [mesh, display] of [[generic, refined], [personal, personalDisplay]]) {
    for (const params of cases) {
      const output = deformPositions(display.positions, mesh.anchors, params);
      for (let i = 0; i < display.indices.length; i += 3) {
        const n = normal(display.positions, display.indices, i);
        if (Math.hypot(...n) < 1e-10) continue;
        assert.ok(dot(n, normal(output, display.indices, i)) > 0, `${mesh.source} ${JSON.stringify(params)} triángulo ${i / 3}`);
      }
    }
  }
});
