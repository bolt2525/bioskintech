import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { buildPersonalSurface, trianglesFromEdges } from '../src/lab/faceSim/engine.ts';
import { refineDisplaySurface } from '../src/lab/faceSim/displaySurface.ts';

const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8')
  .replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`);
export const sim = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`);
const personal = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect,
  trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION));
const headSource = readFileSync(new URL('../src/lab/faceSim/estimatedHead.ts', import.meta.url), 'utf8');
const { buildEstimatedHead } = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(headSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`);
export const meshes = [sim.createSimulationMesh(), sim.createSimulationMesh(personal),
  sim.createSimulationMesh(buildEstimatedHead(personal))].map(mesh => ({
  ...mesh, ...refineDisplaySurface(mesh.positions, mesh.indices),
}));
const contracts = {
  noseRadix: [168, 2], noseBridge: [195, 2], noseHump: [197, 2],
  noseTip: [1, 2], noseRotation: [1, 1], noseTipWidth: [44, 0], noseWidth: [98, 0],
  lipUpper: [0, 1], lipLower: [17, 1], lipProjection: [13, 2], lipCorners: [61, 1],
  cheekbone: [117, 2], cheekVolume: [205, 2], buccal: [214, 2],
  chinProjection: [152, 2], chinHeight: [152, 1], chinWidth: [148, 0], jawWidth: [172, 0],
};
for (const mesh of meshes) {
  test(`${mesh.source}: diagnóstico rango materializado por control`, t => {
    const h = Math.abs(mesh.anchors[10 * 3 + 1] - mesh.anchors[152 * 3 + 1]);
    for (const [key, [anchorId, axis]] of Object.entries(contracts)) {
      const id = mesh.source === 'personal' ? anchorId : Array.from({ length: mesh.positions.length / 3 }, (_, i) => i)
        .reduce((best, i) => {
          const distance = j => [0, 1, 2].reduce((sum, a) => sum + (mesh.positions[j * 3 + a] - mesh.anchors[anchorId * 3 + a]) ** 2, 0);
          return distance(i) < distance(best) ? i : best;
        }, 0);
      const measures = [-1, -.5, 0, .5, 1].map(value => {
        const result = sim.deformPositions(mesh.positions, mesh.anchors, { [key]: value }, mesh.indices);
        return (result[id * 3 + axis] - mesh.positions[id * 3 + axis]) / h * 100;
      });
      t.diagnostic(`${key} %altura [−1,−.5,0,.5,1]: ${measures.map(x => x.toFixed(3)).join(', ')}`);
      assert.equal(measures[2], 0);
      for (const [half, full] of [[1, 0], [3, 4]]) {
        assert.ok(Math.abs(measures[full]) >= .5, `${key}: cambio mínimo de 0.5% altura anatómica`);
        assert.ok(Math.abs(measures[full]) > Math.abs(measures[half]) * 1.02, `${key}: meseta entre 50 y 100%`);
        assert.ok(measures[full] * measures[half] > 0, `${key}: dirección consistente`);
      }
    }
  });
  test(`${mesh.source}: combinaciones de todas las regiones conservan orientación, abertura y cero`, t => {
    const reported = { noseRadix: -1, noseBridge: -.7, noseHump: -1, noseTip: -.14,
      noseRotation: 1, noseTipWidth: .58, noseWidth: -.25 };
    const lips = { lipUpper: 1, lipLower: 1, lipProjection: 1 };
    const cases = [reported, lips, { ...reported, ...lips },
      ...[-1, 1].map(sign => Object.fromEntries(sim.SIMULATION_CONTROLS.map(c => [c.key, sign]))),
      ...sim.SIMULATION_CONTROLS.flatMap(c => [-1, 1].map(sign => ({ [c.key]: sign })))];
    const at = (p, i) => Array.from(p.slice(i * 3, i * 3 + 3));
    const normal = (p, ids) => {
      const [a, b, c] = ids.map(i => at(p, i)), u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
      return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    };
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    let minimum = 1, moderated = 0;
    for (const params of cases) {
      let protection;
      const out = sim.deformPositions(mesh.positions, mesh.anchors, params, mesh.indices, p => { protection = p; });
      moderated += protection.moderatedComponents;
      assert.ok(out.every(Number.isFinite));
      for (let k = 0; k < mesh.indices.length; k += 3) {
        const ids = Array.from(mesh.indices.slice(k, k + 3)), before = normal(mesh.positions, ids), after = normal(out, ids);
        const area = dot(before, before);
        if (area < 1e-20) continue;
        const projection = dot(before, after) / area;
        assert.ok(projection >= .099, `${JSON.stringify(params)} triángulo ${k / 3}: ${projection}`);
        minimum = Math.min(minimum, projection);
      }
      if (mesh.source === 'personal' && params.lipUpper === 1 && params.lipLower === 1 && Object.keys(params).length <= 10) {
        for (const [outer, inner, direction] of [[0, 13, 1], [17, 14, -1]]) {
          const baseline = (mesh.positions[outer * 3 + 1] - mesh.positions[inner * 3 + 1]) * direction;
          const thickness = (out[outer * 3 + 1] - out[inner * 3 + 1]) * direction;
          assert.ok(thickness >= baseline * 1.2, `100% combinado ${JSON.stringify(params)}: bermellón ${outer} llega a ${(thickness / baseline - 1) * 100}%, protección=${JSON.stringify(protection)}`);
        }
        assert.equal(out[13 * 3 + 1] - out[14 * 3 + 1], mesh.positions[13 * 3 + 1] - mesh.positions[14 * 3 + 1]);
      }
    }
    assert.deepEqual(sim.deformPositions(mesh.positions, mesh.anchors, sim.NEUTRAL_SIMULATION, mesh.indices), mesh.positions);
    t.diagnostic(`casos=${cases.length}, área orientada mínima=${minimum.toFixed(4)}, componentes moderadas=${moderated}`);
  });
}
