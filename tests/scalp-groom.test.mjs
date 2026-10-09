import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const require = createRequire(import.meta.url);
const loadTS = (path, dependencies = {}, exposed = '') => {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source + exposed, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  vm.runInNewContext(outputText, {
    exports, require: name => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return exports;
};
const patterns = loadTS('../src/data/scalpPatterns.ts');
const { SCALP_BOUNDARY_PRESET } = loadTS('../src/data/scalpBoundaryPreset.ts');
const { createScalpGroomGroup } = loadTS(
  '../src/components/admin/ficha-clinica/components/scalpGroom.ts',
  { three: THREE, '../../../../data/scalpPatterns': patterns },
);
const coverage = (stage, x, y, z, scale = 'norwood') =>
  patterns.getScalpCoverage({ x, y, z }, { scale, stage });

test('Norwood: entradas progresivas sin coronilla artificial en I, II y III', () => {
  assert.ok(coverage('I', 0.78, 1.8, 1.32) > 0.95);
  assert.ok(coverage('II', 0.78, 1.8, 1.32) < 0.05);
  assert.ok(coverage('II', 0.78, 2.1, 0.75) > 0.95);
  assert.ok(coverage('III', 0.78, 2.1, 0.95) < 0.05);
  for (const stage of ['I', 'II', 'III']) assert.equal(coverage(stage, 0, 2.25, -0.65), 1);
  assert.equal(coverage('III Vertex', 0, 2.25, -0.65), 0);
});

test('Norwood IV/V conservan puente; VI lo elimina y VII reduce la banda residual', () => {
  assert.ok(coverage('IV', 0, 2.48, 0.15) > 0.95);
  assert.ok(coverage('V', 0, 2.48, 0.15) > 0.5);
  assert.equal(coverage('VI', 0, 2.48, 0.15), 0);
  assert.ok(coverage('IV', 0, 2.4, 0.6) > 0.95);
  assert.equal(coverage('V', 0, 2.4, 0.6), 0);
  assert.equal(coverage('VI', 1.12, 1.2, -0.3), 1);
  assert.equal(coverage('VII', 1.12, 1.2, -0.3), 0);
  assert.equal(coverage('VII', 1.1, 0.7, -0.3), 1);
});

test('Ludwig: aclaramiento difuso progresivo, raya central y banda frontal preservada', () => {
  const stages = patterns.LUDWIG_STAGES;
  const values = stages.map(stage => coverage(stage, 0.3, 2.4, 0.3, 'ludwig'));
  assert.ok(values[0] > values[1] + 0.2);
  assert.ok(values[1] > values[2] + 0.2);
  for (const stage of stages) {
    assert.equal(coverage(stage, 0, 1.6, 1.45, 'ludwig'), 1);
    assert.ok(coverage(stage, 1.1, 1.2, 0, 'ludwig') > 0.95);
    assert.ok(coverage(stage, 0, 2.4, 0.3, 'ludwig') < coverage(stage, 0.3, 2.4, 0.3, 'ludwig'));
  }
});

test('Tarjetas clínicas comparten patrones; VI no conserva una franja frontal artificial', () => {
  const { ScalpStageIllustration } = loadTS(
    '../src/components/admin/ficha-clinica/components/tabs/ClinicalDataModal.tsx',
    {
      react: {}, 'react/jsx-runtime': require('react/jsx-runtime'), 'lucide-react': {},
      '../../../../ui/Dialog': {}, '../../../../ui/Tooltip': {},
      '../../../../../data/scalpPatterns': patterns,
    },
    '\nexport { ScalpStageIllustration };',
  );
  for (const scale of ['norwood', 'ludwig']) {
    const stages = scale === 'norwood' ? patterns.NORWOOD_STAGES : patterns.LUDWIG_STAGES;
    const signatures = new Set();
    stages.forEach((_, stageIndex) => {
      const svg = ScalpStageIllustration({ scale, stageIndex });
      const samples = svg.props.children[1];
      const signature = samples.map(sample => Math.round(sample.props.opacity * 100)).join(',');
      assert.ok(!signatures.has(signature));
      signatures.add(signature);
      if (scale === 'norwood' && stageIndex >= 6) {
        const front = samples.filter(sample =>
          sample.props.y <= 13 && sample.props.x >= 28 && sample.props.x <= 44);
        assert.ok(front.length > 0);
        assert.ok(front.every(sample => sample.props.opacity < 0.01));
      }
    });
  }
});

const buffer = readFileSync(new URL('../public/models/clinical/male_head_hair.glb', import.meta.url));
const { scene: head } = await new GLTFLoader().parseAsync(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '',
);
head.updateMatrixWorld(true);
const bounds = new THREE.Box3();
head.traverse(mesh => {
  if (!(mesh instanceof THREE.Mesh) || mesh.name === 'SCALP_HAIR_SOURCE') return;
  mesh.geometry.computeBoundingBox();
  bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  mesh.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
});
const center = bounds.getCenter(new THREE.Vector3());
const dimensions = bounds.getSize(new THREE.Vector3());
const factor = 5 / Math.max(dimensions.x, dimensions.y, dimensions.z);
head.scale.setScalar(factor);
head.position.copy(center).multiplyScalar(-factor);
head.updateMatrixWorld(true);
const options = {
  scale: 'norwood', stage: 'V', density: 'Media',
  boundaryPoints: SCALP_BOUNDARY_PRESET, boundaryClosed: true,
};
const dispose = group => group.traverse(mesh => {
  if (!(mesh instanceof THREE.Mesh)) return;
  mesh.geometry.dispose();
  mesh.material.dispose();
});
const scalpMeshes = [];
head.traverse(mesh => {
  if (mesh instanceof THREE.Mesh && mesh.name !== 'SCALP_HAIR_SOURCE') scalpMeshes.push(mesh);
});

test('Todas las etapas producen máscaras distintas sobre el GLB real', () => {
  for (const scale of ['norwood', 'ludwig']) {
    const signatures = [];
    const averages = [];
    const stages = scale === 'norwood' ? patterns.NORWOOD_STAGES : patterns.LUDWIG_STAGES;
    for (const stage of stages) {
      const group = createScalpGroomGroup({ ...options, scale, stage, density: 'Baja' }, head);
      assert.ok(group);
      const values = group.children[0].geometry.getAttribute('scalpCoverage').array;
      const signature = Array.from(values, value => Math.round(value * 100)).join(',');
      assert.ok(!signatures.includes(signature), `${scale} ${stage} duplicates another stage`);
      signatures.push(signature);
      averages.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      assert.ok(group.userData.strandCount > 0);
      dispose(group);
    }
    for (let index = 1; index < averages.length; index += 1) {
      assert.ok(averages[index - 1] - averages[index] > 0.005,
        `${scale} ${stages[index]} needs a measurable decrease on the actual head`);
    }
  }
});

test('Densidad cambia fibras, no el contorno anatómico; generación determinista', () => {
  const counts = [];
  let mask;
  for (const density of ['Baja', 'Media', 'Alta']) {
    const group = createScalpGroomGroup({ ...options, density }, head);
    counts.push(group.userData.strandCount);
    const values = group.children[0].geometry.getAttribute('scalpCoverage').array;
    if (mask) assert.deepEqual(values, mask);
    else mask = values.slice();
    dispose(group);
  }
  assert.ok(counts[1] > counts[0] * 1.65);
  assert.ok(counts[2] > counts[1] * 1.35);
  const repeat = createScalpGroomGroup({ ...options, density: 'Baja' }, head);
  assert.equal(repeat.userData.strandCount, counts[0]);
  dispose(repeat);
});

test('Superficie capilar adherida a piel (máximo 0.004 unidades), sin proxy inflado', () => {
  const group = createScalpGroomGroup(options, head);
  const geometry = group.children[0].geometry;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const coverages = geometry.getAttribute('scalpCoverage');
  const raycaster = new THREE.Raycaster();
  let verified = 0;
  for (let i = 0; i < positions.count; i += 211) {
    if (coverages.getX(i) < 0.5) continue;
    const point = new THREE.Vector3().fromBufferAttribute(positions, i);
    const normal = new THREE.Vector3().fromBufferAttribute(normals, i);
    raycaster.set(point.clone().addScaledVector(normal, 0.02), normal.clone().negate());
    const hit = raycaster.intersectObjects(scalpMeshes, false)[0];
    assert.ok(hit, `No skin beneath hair vertex ${i}`);
    assert.ok(point.distanceTo(hit.point) <= 0.004, `Detached surface: ${point.distanceTo(hit.point)}`);
    verified += 1;
  }
  assert.ok(verified > 20);
  dispose(group);
});

test('Ludwig tiene fibras laterales más largas, no el peinado masculino', () => {
  const male = createScalpGroomGroup({ ...options, stage: 'I' }, head);
  const female = createScalpGroomGroup({ ...options, scale: 'ludwig', stage: 'I' }, head);
  // Both share the same scalp geometry; the feminine groom extends beyond the nape.
  female.children[1].geometry.computeBoundingBox();
  male.children[1].geometry.computeBoundingBox();
  assert.ok(female.children[1].geometry.boundingBox.min.y < male.children[1].geometry.boundingBox.min.y - 0.25);
  assert.ok(Number.isFinite(female.children[1].geometry.boundingBox.min.y));
  dispose(male);
  dispose(female);
});

test('Sin contorno cerrado no se genera cabello ni se altera la cabeza', () => {
  assert.equal(createScalpGroomGroup({ ...options, boundaryClosed: false }, head), null);
  assert.equal(createScalpGroomGroup({ ...options, boundaryPoints: [] }, head), null);
});
