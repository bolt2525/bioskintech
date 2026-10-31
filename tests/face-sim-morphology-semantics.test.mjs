import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';

const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const sim = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const { createSimulationMesh, deformPositions, sanitizeSimulation, SIMULATION_CONTROLS,
  personalFaceFrame, fromCanonicalPosition, toCanonicalPosition } = sim;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const surface = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect,
  trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION));
const meshes = [['atlas', createSimulationMesh()], ['personal sintético', createSimulationMesh(surface)]];
const at = (p, i) => Array.from(p.slice(i * 3, i * 3 + 3));
const height = p => Math.hypot(...at(p, 10).map((v, i) => v - at(p, 152)[i]));
const cross = (a, b, c) => {
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const screenshot = { noseBridge: 0.32, noseHump: -1, noseTip: -0.05, noseRotation: 0.43,
  noseTipWidth: -0.09, noseWidth: -0.20, noseSymmetry: 1 };
const semantics = {
  noseRadix: [168, 2, 1], noseBridge: [195, 2, 1], noseHump: [197, 2, 1],
  noseTip: [1, 2, 1], noseRotation: [1, 1, 1], noseTipWidth: [44, 0, -1], noseWidth: [98, 0, -1],
  lipUpper: [0, 2, 1], lipLower: [17, 2, 1], lipProjection: [13, 2, 1], lipCorners: [61, 1, 1],
  cheekbone: [117, 2, 1], cheekVolume: [205, 2, 1], buccal: [214, 2, 1],
  chinProjection: [152, 2, 1], chinHeight: [152, 1, -1], chinWidth: [148, 0, -1], jawWidth: [172, 0, -1],
};

for (const [label, mesh] of meshes) {
  test(`${label}: superficie de visor refinada usa SUS índices y mantiene margen de área orientada`, t => {
    const dense = refineDisplaySurface(mesh.anchors, Uint32Array.from(atlas.triangles));
    assert.ok(dense.positions.length > mesh.anchors.length);
    let checked = 0, minProjection = Infinity;
    for (const params of [screenshot, ...[-1, 1].map(sign => ({
      ...Object.fromEntries(SIMULATION_CONTROLS.filter(c => c.key.startsWith('nose')).map(c => [c.key, sign])),
      noseSymmetry: sign,
    }))]) {
      const result = deformPositions(dense.positions, mesh.anchors, params, dense.indices);
      for (const id of [33, 263, 13, 14, 0, 17, 61, 291]) {
        assert.deepEqual(at(result, id), at(dense.positions, id), `protección refinada ${id}`);
      }
      for (let k = 0; k < dense.indices.length; k += 3) {
        const ids = Array.from(dense.indices.slice(k, k + 3));
        const before = cross(...ids.map(i => at(dense.positions, i)));
        const area = dot(before, before);
        if (area < 1e-20) continue;
        const after = cross(...ids.map(i => at(result, i)));
        const projection = dot(before, after) / area;
        assert.ok(projection >= 0.099, `superficie refinada: margen orientado ${projection} en ${k / 3}`);
        minProjection = Math.min(minProjection, projection); checked++;
      }
    }
    assert.ok(checked > 100);
    t.diagnostic(`triángulos refinados=${checked}; área orientada mínima=${minProjection.toFixed(4)}`);
  });

  test(`${label}: CADA control tiene dirección, neutralidad, restauración, localidad y límites`, () => {
    for (const { key } of SIMULATION_CONTROLS) {
      assert.ok(semantics[key], `falta contrato semántico de ${key}`);
      const [id, axis, direction] = semantics[key];
      const original = mesh.anchors.slice();
      for (const sign of [-1, 1]) {
        const out = deformPositions(original, original, { [key]: sign });
        assert.ok((out[id * 3 + axis] - original[id * 3 + axis]) * sign * direction > 1e-5,
          `${key}: dirección ${sign} incorrecta en ${id}`);
        assert.ok(out.every(Number.isFinite), key);
        assert.deepEqual(deformPositions(original, original, { [key]: sign * 1e9 }), out, key);
        assert.deepEqual(deformPositions(original, original, { [key]: 0 }), original, key);
        assert.deepEqual(deformPositions(original, original, { [key]: sign }), out, key);
        for (const remote of key.startsWith('nose') ? [10, 152, 33, 263, 159, 386, 145, 374, 0, 13, 14, 17, 61, 291]
          : key.startsWith('chin') || key === 'jawWidth' ? [10, 1, 13, 14, 117, 346]
            : [10, 1, 152, 172, 397]) {
          assert.deepEqual(at(out, remote), at(original, remote), `${key}: cambió región remota ${remote}`);
        }
        const h = height(original);
        for (let i = 0; i < out.length / 3; i++) {
          assert.ok(Math.hypot(...at(out, i).map((v, a) => v - original[i * 3 + a])) < h * 0.2, key);
        }
      }
      assert.equal(sanitizeSimulation({ [key]: NaN })[key], 0);
      assert.equal(sanitizeSimulation({ [key]: Infinity })[key], 0);
      assert.deepEqual(mesh.anchors, original, `${key}: mutó original`);
    }
  });

  test(`${label}: giba aislada de raíz, suprapunta, punta, alas, ojos y labios`, () => {
    for (const sign of [-1, 1]) {
      const out = deformPositions(mesh.anchors, mesh.anchors, { noseHump: sign });
      for (const id of [168, 6, 5, 1, 4, 94, 2, 98, 327, 33, 263, 0, 13, 14]) {
        assert.deepEqual(at(out, id), at(mesh.anchors, id), `giba ${sign} invade subzona ${id}`);
      }
      assert.ok((out[197 * 3 + 2] - mesh.anchors[197 * 3 + 2]) * sign > 0.005);
    }
    const bridge = deformPositions(mesh.anchors, mesh.anchors, { noseBridge: -1 });
    assert.ok(bridge[168 * 3 + 2] < mesh.anchors[168 * 3 + 2] - 0.005, 'dorso debe acompañar raíz, no dejar pico');
  });

  test(`${label}: raíz y anchuras diferenciadas; proyección no se confunde con elevación`, () => {
    const anchors = mesh.anchors;
    for (const [key, protectedIds] of [
      ['noseRadix', [1, 4, 5, 98, 327]],
      ['noseTipWidth', [168, 6, 98, 327]],
      ['noseWidth', [168, 6, 1, 4]],
    ]) for (const sign of [-1, 1]) {
      const out = deformPositions(anchors, anchors, { [key]: sign });
      for (const id of protectedIds) assert.deepEqual(at(out, id), at(anchors, id), `${key} invade ${id}`);
    }
    for (const sign of [-1, 1]) {
      const projected = deformPositions(anchors, anchors, { noseTip: sign });
      const rotated = deformPositions(anchors, anchors, { noseRotation: sign });
      const combined = deformPositions(anchors, anchors, { noseTip: sign, noseRotation: sign });
      for (const id of [1, 4]) {
        assert.equal(projected[id * 3 + 1], anchors[id * 3 + 1], 'proyección debe mantener altura');
        assert.ok((rotated[id * 3 + 1] - anchors[id * 3 + 1]) * sign > 0, 'rotación debe elevar/bajar');
        assert.equal(combined[id * 3 + 1], rotated[id * 3 + 1], 'proyección no altera rotación');
        assert.ok(Math.abs(combined[id * 3 + 2] - rotated[id * 3 + 2]
          - (projected[id * 3 + 2] - anchors[id * 3 + 2])) < 3e-7, 'proyección independiente del giro');
      }
    }
  });

  test(`${label}: extremos y combinación reportada no invierten ni colapsan triángulos afectados`, t => {
    const keys = SIMULATION_CONTROLS.filter(c => c.key.startsWith('nose')).map(c => c.key);
    const cases = [screenshot, ...keys.flatMap(key => [-1, 1].map(sign => ({ [key]: sign })))];
    // Todos los vértices del hipercubo nasal, incluyendo simetría en ambos sentidos.
    for (let bits = 0; bits < 2 ** keys.length; bits++) {
      const p = Object.fromEntries(keys.map((key, i) => [key, bits & (1 << i) ? 1 : -1]));
      cases.push(p, { ...p, noseSymmetry: 1 }, { ...p, noseSymmetry: -1 });
    }
    let checked = 0, minArea = Infinity, minCos = Infinity;
    for (const params of cases) {
      const out = deformPositions(mesh.positions, mesh.anchors, params);
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const ids = Array.from(mesh.indices.slice(i, i + 3));
        if (!ids.some(id => at(out, id).some((v, a) => v !== mesh.positions[id * 3 + a]))) continue;
        const before = cross(...ids.map(id => at(mesh.positions, id)));
        const after = cross(...ids.map(id => at(out, id)));
        const area = Math.hypot(...before);
        if (area < height(mesh.anchors) ** 2 * 1e-10) continue;
        const ratio = Math.hypot(...after) / area, cosine = dot(before, after) / (area * Math.hypot(...after));
        assert.ok(cosine > 0, `${JSON.stringify(params)}: triángulo invertido ${i / 3} cos=${cosine}`);
        assert.ok(ratio > 0.05, `${JSON.stringify(params)}: triángulo colapsado ${i / 3} ratio=${ratio}`);
        minArea = Math.min(minArea, ratio); minCos = Math.min(minCos, cosine); checked++;
      }
    }
    assert.ok(checked > 100);
    t.diagnostic(`casos=${cases.length}; triángulos afectados=${checked}; área mínima=${minArea.toFixed(4)}; cos mínimo=${minCos.toFixed(4)}`);
  });

  test(`${label}: continuidad longitudinal y lateral en extremos, sin escalón ni pico de desplazamiento`, t => {
    const anchors = mesh.anchors, h = height(anchors);
    const nodes = [4, 5, 195, 197, 6, 168].map(id => at(anchors, id)).sort((a, b) => a[1] - b[1]);
    const count = 513, step = (nodes.at(-1)[1] + h * 0.22 - (nodes[0][1] - h * 0.1)) / (count - 1);
    const samples = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const y = nodes[0][1] - h * 0.1 + i * step;
      let k = nodes.findIndex(p => p[1] >= y);
      if (k < 0) k = nodes.length - 1;
      const a = nodes[Math.max(k - 1, 0)], b = nodes[k], t = b[1] === a[1] ? 0 : (y - a[1]) / (b[1] - a[1]);
      samples.set([a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t], i * 3);
    }
    let maxSlope = 0, maxJump = 0;
    for (const p of [screenshot, { noseBridge: -1 }, { noseBridge: 1 }, { noseHump: -1 }, { noseHump: 1 }]) {
      const out = deformPositions(samples, anchors, p);
      const delta = Array.from({ length: count }, (_, i) => out[i * 3 + 2] - samples[i * 3 + 2]);
      const slopes = delta.slice(1).map((v, i) => (v - delta[i]) / step);
      const slope = Math.max(...slopes.map(Math.abs));
      const jump = Math.max(...slopes.slice(1).map((v, i) => Math.abs(v - slopes[i])));
      assert.ok(slope < 1.6, `${JSON.stringify(p)}: pendiente ${slope}`);
      assert.ok(jump < 0.12, `${JSON.stringify(p)}: salto de pendiente ${jump}`);
      maxSlope = Math.max(maxSlope, slope); maxJump = Math.max(maxJump, jump);
    }
    // El borde lateral antiguo era una compuerta binaria.
    const axis = (anchors[10 * 3] + anchors[152 * 3] + anchors[1 * 3]) / 3;
    const y = anchors[197 * 3 + 1], z = anchors[197 * 3 + 2];
    const edge = Float32Array.from([axis + h * 0.14 - h * 1e-5, y, z, axis + h * 0.14 + h * 1e-5, y, z,
      ...at(anchors, 10)]); // El contrato de superficie exige altura, incluso para probes.
    const out = deformPositions(edge, anchors, { noseHump: 1 });
    assert.ok(Math.abs((out[2] - edge[2]) - (out[5] - edge[5])) < h * 1e-6, 'salto lateral giba');
    t.diagnostic(`pendiente máxima=${maxSlope.toFixed(4)}; salto máximo=${maxJump.toFixed(4)}`);
  });
}

test('controles centralizados: claves únicas, hints direccionales y advertencia educativa', () => {
  assert.equal(new Set(SIMULATION_CONTROLS.map(c => c.key)).size, SIMULATION_CONTROLS.length);
  for (const { key, hint } of SIMULATION_CONTROLS.filter(c => c.key.startsWith('nose'))) {
    assert.ok(hint?.includes('−') && hint.includes('+'), `${key}: faltan direcciones comprensibles`);
  }
  assert.match(sim.SIMULATION_NOTICE, /ilustrativa educativa/);
  assert.match(sim.SIMULATION_NOTICE, /no representa medidas ni predice resultados clínicos/);
});

test('perfiles ±90°, escala y chart: misma morfología después de canonizar; UV intactos', () => {
  const base = createSimulationMesh(surface), settings = screenshot;
  const expected = deformPositions(base.positions, base.anchors, settings);
  for (const angle of [-Math.PI / 2, Math.PI / 2, 0.63]) {
    const positions = surface.positions.slice(), c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < positions.length / 3; i++) {
      const [x, y, z] = at(surface.positions, i);
      positions.set([(x * c + z * s) * 1.7 + 2, y * 1.7 - 3, (-x * s + z * c) * 1.7 + 4], i * 3);
    }
    const rotated = { ...surface, positions }, mesh = createSimulationMesh(rotated);
    const out = deformPositions(mesh.positions, mesh.anchors, settings);
    for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - expected[i] * 1.7) < 3e-6, `perfil ${angle}, coordenada ${i}`);
    assert.deepEqual(mesh.uvs, surface.uvs);
    const frame = personalFaceFrame(rotated);
    const q = at(positions, 197), p = { x: q[0], y: q[1], z: q[2] };
    const roundtrip = fromCanonicalPosition(toCanonicalPosition(p, frame), frame);
    assert.ok(Math.hypot(roundtrip.x - p.x, roundtrip.y - p.y, roundtrip.z - p.z) < 1e-6);
  }
});
