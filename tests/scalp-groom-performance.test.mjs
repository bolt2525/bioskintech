import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loadTS = (path, dependencies = {}) => {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
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
const loadGroom = (coveragePatterns = patterns) => loadTS(
  '../src/components/admin/ficha-clinica/components/scalpGroom.ts',
  { three: THREE, '../../../../data/scalpPatterns': coveragePatterns },
).createScalpGroomGroup;
const createScalpGroomGroup = loadGroom();
const buffer = readFileSync(new URL('../public/models/clinical/male_head_hair.glb', import.meta.url));
const makeHead = async () => {
  const { scene: head } = await new GLTFLoader().parseAsync(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '',
  );
  head.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  head.traverse(mesh => {
    if (!(mesh instanceof THREE.Mesh) || mesh.name === 'SCALP_HAIR_SOURCE') return;
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  const factor = 5 / Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
  head.scale.setScalar(factor);
  head.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-factor);
  return head;
};
const options = {
  scale: 'norwood', stage: 'V', density: 'Media',
  boundaryClosed: true, boundaryPoints: SCALP_BOUNDARY_PRESET,
};
const dispose = group => group?.traverse(mesh => {
  if (!mesh.isMesh) return;
  mesh.geometry.dispose();
  mesh.material.dispose();
});
const bytes = geometry => Object.values(geometry.attributes)
  .reduce((sum, attribute) => sum + attribute.array.byteLength, geometry.index?.array.byteLength ?? 0);
const signature = group => group.children.slice(0, 2).map(mesh => {
  const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const hash = createHash('sha256');
  for (const name of ['position', 'normal', 'scalpCoverage']) {
    const array = geometry.getAttribute(name)?.array;
    if (array) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  const digest = hash.digest('hex');
  if (geometry !== mesh.geometry) geometry.dispose();
  return digest;
});
const measure = (head, configuration) => {
  const start = performance.now();
  const group = createScalpGroomGroup(configuration, head);
  const ms = performance.now() - start;
  assert.ok(group);
  return {
    group, ms, vertices: group.children.slice(0, 2).map(mesh => mesh.geometry.attributes.position.count),
    bytes: group.children.slice(0, 2).reduce((sum, mesh) => sum + bytes(mesh.geometry), 0),
  };
};
// Captured before optimization, on the same GLB/options. Expanded triangle hashes
// protect tessellation, normals, contour, 0.003 offset and every strand coordinate.
const baseline = {
  norwood: {
    vertices: [80580, 337560], bytes: 10357680, strands: 14065,
    hashes: [
      '3b8ff974f77276f68be2ea3190437e99a0670941426aad398fe05e53f1e824b1',
      'dfedf46f62f10a84674933114609d3289d1d36255972d77c59eb5397fec0fa14',
    ],
  },
  ludwig: {
    vertices: [80580, 694920], bytes: 18934320, strands: 16295,
    hashes: [
      '9c1b7a3febccf1693f341fe7bd78ff60eaf7598775194523298af8a8e89194bc',
      '3bbeefc0474d87c26bf37c1a91360d9861544664e5a1fdbb2b17bfd514a29d61',
    ],
  },
};
const stats = group => group.userData.groomPerformance;
const smallHead = () => {
  const head = new THREE.Group();
  head.add(new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.4, 2, 2).rotateX(-Math.PI / 2).translate(0, 1.8, 0),
    new THREE.MeshBasicMaterial(),
  ));
  return head;
};
const smallOptions = {
  ...options, stage: 'I',
  boundaryPoints: [{ x: 2, y: 1.3, z: 0 }, { x: -1, y: 1.3, z: 2 }, { x: -1, y: 1.3, z: -2 }],
};

test('GLB real: métricas frías/calientes, cantidad y geometría determinista', async t => {
  for (const configuration of [options, { ...options, scale: 'ludwig', stage: 'I' }]) {
    const head = await makeHead();
    const cold = measure(head, configuration);
    const expected = signature(cold.group);
    const original = baseline[configuration.scale];
    assert.deepEqual(expected, original.hashes);
    assert.equal(cold.group.userData.strandCount, original.strands);
    assert.equal(stats(cold.group).surfaceBuilds, 1);
    assert.equal(stats(cold.group).samplingBuilds, 1);
    assert.ok(cold.vertices.every((count, i) => count < original.vertices[i] * 0.45));
    assert.ok(cold.bytes < original.bytes * 0.58);
    // The old implementation also built JS number[] buffers (8-byte numbers)
    // before copying them into Float32 GPU buffers: at least 3x final buffer bytes.
    assert.ok(cold.bytes + stats(cold.group).cachedBytes < original.bytes * 1.5,
      'Current GPU buffers + bounded CPU cache stay below half the old build-buffer lower bound');
    const hotTimes = [];
    for (let i = 0; i < 3; i += 1) {
      const hot = measure(head, configuration);
      hotTimes.push(hot.ms);
      assert.equal(hot.group.userData.strandCount, cold.group.userData.strandCount);
      assert.deepEqual(signature(hot.group), expected);
      assert.equal(stats(hot.group).surfaceBuilds, 0);
      assert.equal(stats(hot.group).samplingBuilds, 0);
      assert.equal(stats(hot.group).cachedBytes, stats(cold.group).cachedBytes);
      dispose(hot.group);
    }
    const hotMedian = hotTimes.sort((a, b) => a - b)[1];
    // Coarse relative gate, not an absolute machine-dependent latency budget.
    assert.ok(hotMedian < cold.ms, 'Median warm generation must beat cold surface + sampling');
    t.diagnostic(JSON.stringify({
      scale: configuration.scale, coldMs: Math.round(cold.ms), hotMedianMs: Math.round(hotMedian),
      vertices: cold.vertices, bytes: cold.bytes, strands: cold.group.userData.strandCount,
      cachedBytes: stats(cold.group).cachedBytes, candidateCount: stats(cold.group).candidateCount,
      surfaceBuildsWarm: 0, samplingBuildsWarm: 0,
    }));
    dispose(cold.group);
  }
});

test('Máscaras independientes, densidad real y caché acotada durante cambios de estilo/etapa', () => {
  const head = smallHead();
  let mask, positions, index, previousCount = 0, cachedBytes;
  for (const density of ['Baja', 'Media', 'Alta']) {
    const group = createScalpGroomGroup({ ...smallOptions, density }, head);
    const geometry = group.children[0].geometry;
    if (mask) {
      assert.deepEqual(geometry.attributes.scalpCoverage.array, mask);
      assert.deepEqual(geometry.attributes.position.array, positions);
      assert.deepEqual(geometry.index.array, index);
      assert.equal(stats(group).surfaceBuilds, 0);
      assert.equal(stats(group).samplingBuilds, 0);
    } else {
      mask = geometry.attributes.scalpCoverage.array.slice();
      positions = geometry.attributes.position.array.slice();
      index = geometry.index.array.slice();
      cachedBytes = stats(group).cachedBytes;
    }
    assert.ok(group.userData.strandCount > previousCount);
    previousCount = group.userData.strandCount;
    assert.equal(stats(group).cachedBytes, cachedBytes);
    dispose(group);
  }
  const changed = createScalpGroomGroup({
    ...smallOptions, stage: 'VI', color: '#111111', roughness: 0.8,
    lengthScale: 1.5, layDown: 0.6, showBoundaryTrace: true,
  }, head);
  assert.notDeepEqual(changed.children[0].geometry.attributes.scalpCoverage.array, mask);
  assert.deepEqual(changed.children[0].geometry.attributes.position.array, positions);
  assert.equal(stats(changed).surfaceBuilds, 0);
  assert.equal(stats(changed).samplingBuilds, 0);
  assert.equal(stats(changed).cachedBytes, cachedBytes);
  assert.equal(changed.children.length, 2); // Zero fibers above the VI rim, plus contour trace.
  dispose(changed);
  for (const scale of ['ludwig', 'norwood', 'ludwig', 'norwood']) {
    const group = createScalpGroomGroup({ ...smallOptions, scale }, head);
    assert.equal(stats(group).surfaceBuilds, 0);
    if (scale === 'ludwig' && stats(group).samplingBuilds === 1) {
      assert.ok(stats(group).cachedBytes > cachedBytes);
      cachedBytes = stats(group).cachedBytes;
    } else {
      assert.equal(stats(group).samplingBuilds, 0);
      assert.equal(stats(group).cachedBytes, cachedBytes);
    }
    dispose(group);
  }
});

test('Invalida por contorno, matrices, atributos/versiones y topología; coincide con frío', () => {
  const head = smallHead();
  const configuration = { ...smallOptions, boundaryPoints: smallOptions.boundaryPoints.map(p => ({ ...p })) };
  dispose(createScalpGroomGroup(configuration, head));
  const mutations = [
    () => { configuration.boundaryPoints[0].y += 0.1; },
    () => { head.position.x += 0.01; },
    () => { head.children[0].rotation.y += 0.1; },
    () => { head.children[0].scale.set(1.05, 0.95, 1.1); },
    () => {
      const position = head.children[0].geometry.attributes.position;
      position.setY(0, position.getY(0) + 0.01);
      position.needsUpdate = true;
    },
    () => { head.children[0].geometry.attributes.normal.needsUpdate = true; },
    () => { head.children[0].geometry.index.needsUpdate = true; },
    () => {
      const geometry = head.children[0].geometry;
      geometry.setAttribute('position', geometry.attributes.position.clone());
    },
    () => { head.children[0].geometry = head.children[0].geometry.clone(); },
    () => { head.add(head.children[0].clone()); },
    () => { head.remove(head.children[1]); },
  ];
  for (const mutate of mutations) {
    mutate();
    const rebuilt = createScalpGroomGroup(configuration, head);
    assert.equal(stats(rebuilt).surfaceBuilds, 1);
    assert.equal(stats(rebuilt).samplingBuilds, 1);
    const cold = createScalpGroomGroup(configuration, head.clone(true));
    assert.deepEqual(signature(rebuilt), signature(cold));
    const hot = createScalpGroomGroup(configuration, head);
    assert.equal(stats(hot).surfaceBuilds, 0);
    assert.equal(stats(hot).samplingBuilds, 0);
    assert.deepEqual(signature(rebuilt), signature(hot));
    dispose(rebuilt); dispose(cold); dispose(hot);
  }
});

test('Atributos intercalados invalidan por versión; invalidar descarta las dos familias', () => {
  const head = smallHead();
  const geometry = head.children[0].geometry;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const array = new Float32Array(position.count * 6);
  for (let i = 0; i < position.count; i += 1) {
    array.set([position.getX(i), position.getY(i), position.getZ(i),
      normal.getX(i), normal.getY(i), normal.getZ(i)], i * 6);
  }
  const data = new THREE.InterleavedBuffer(array, 6);
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(data, 3, 3));
  const male = createScalpGroomGroup(smallOptions, head);
  const female = createScalpGroomGroup({ ...smallOptions, scale: 'ludwig' }, head);
  assert.equal(stats(female).surfaceBuilds, 0);
  assert.equal(stats(female).samplingBuilds, 1);
  assert.ok(stats(female).cachedBytes > stats(male).cachedBytes);
  data.array[1] += 0.01;
  data.needsUpdate = true;
  const rebuilt = createScalpGroomGroup(smallOptions, head);
  assert.equal(stats(rebuilt).surfaceBuilds, 1);
  assert.equal(stats(rebuilt).samplingBuilds, 1);
  assert.ok(stats(rebuilt).cachedBytes < stats(female).cachedBytes);
  const rebuiltFemale = createScalpGroomGroup({ ...smallOptions, scale: 'ludwig' }, head);
  assert.equal(stats(rebuiltFemale).surfaceBuilds, 0);
  assert.equal(stats(rebuiltFemale).samplingBuilds, 1);
  const cold = createScalpGroomGroup(smallOptions, head.clone(true));
  assert.deepEqual(signature(rebuilt), signature(cold));
  dispose(male); dispose(female); dispose(rebuilt); dispose(rebuiltFemale); dispose(cold);
});

test('Recursos propios: dispose y mutación de buffers no dañan la caché ni otro groom', () => {
  const head = smallHead();
  const first = createScalpGroomGroup({ ...smallOptions, showBoundaryTrace: true }, head);
  const expected = signature(first);
  const second = createScalpGroomGroup({ ...smallOptions, showBoundaryTrace: true }, head);
  let disposedGeometries = 0, disposedMaterials = 0, disposedSecond = 0;
  first.children.forEach((mesh, i) => {
    assert.notEqual(mesh.geometry, second.children[i].geometry);
    assert.notEqual(mesh.material, second.children[i].material);
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
      assert.notEqual(attribute.array, second.children[i].geometry.attributes[name].array);
    }
    mesh.geometry.addEventListener('dispose', () => disposedGeometries++);
    mesh.material.addEventListener('dispose', () => disposedMaterials++);
    second.children[i].geometry.addEventListener('dispose', () => disposedSecond++);
  });
  first.children[0].geometry.attributes.position.array.fill(0);
  first.children[0].geometry.attributes.scalpCoverage.array.fill(0);
  first.children[0].geometry.index.array.fill(0);
  dispose(first);
  assert.equal(disposedGeometries, 3);
  assert.equal(disposedMaterials, 3);
  assert.equal(disposedSecond, 0);
  assert.deepEqual(signature(second), expected);
  dispose(second);
  const next = createScalpGroomGroup(smallOptions, head);
  assert.equal(stats(next).surfaceBuilds, 0);
  assert.equal(stats(next).samplingBuilds, 0);
  assert.deepEqual(signature(next), expected);
  dispose(next);
});

test('SCALP_HAIR_SOURCE excluido; padres transformados y contornos inválidos', () => {
  const head = smallHead();
  const expected = createScalpGroomGroup(smallOptions, head);
  const excluded = new THREE.Mesh(new THREE.SphereGeometry(5), new THREE.MeshBasicMaterial());
  excluded.name = 'SCALP_HAIR_SOURCE';
  head.add(excluded);
  const group = createScalpGroomGroup(smallOptions, head);
  assert.equal(stats(group).surfaceBuilds, 0);
  assert.deepEqual(signature(group), signature(expected));
  assert.equal(createScalpGroomGroup({ ...smallOptions, boundaryClosed: false }, head), null);
  assert.equal(createScalpGroomGroup({ ...smallOptions, boundaryPoints: [] }, head), null);
  assert.equal(createScalpGroomGroup(smallOptions, new THREE.Group()), null);
  const parent = new THREE.Group();
  parent.add(head);
  parent.position.x = 0.02; // Do not manually update matrices: groom must update ancestors.
  const moved = createScalpGroomGroup(smallOptions, head);
  assert.equal(stats(moved).surfaceBuilds, 1);
  assert.notDeepEqual(signature(moved), signature(expected));
  dispose(expected); dispose(group); dispose(moved);
});

test('Savin reutiliza muestreo/peinado femenino y delega las nueve etapas al patrón compartido', async () => {
  // Contract test while main implements Savin in scalpPatterns: no clinical formulas here.
  const stages = ['I-1', 'I-2', 'I-3', 'I-4', 'II-1', 'II-2', 'III', 'Advanced', 'Frontal'];
  const calls = new Set();
  const groom = loadGroom({
    ...patterns,
    getScalpCoverage: (point, visualization) => {
      if (visualization.scale !== 'savin') return patterns.getScalpCoverage(point, visualization);
      calls.add(visualization.stage);
      return patterns.getScalpCoverage(point, { ...visualization, scale: 'ludwig', stage: 'I' });
    },
  });
  const head = await makeHead();
  const female = groom({ ...options, scale: 'ludwig', stage: 'I' }, head);
  const expected = signature(female);
  dispose(female);
  for (const stage of stages) {
    const savin = groom({ ...options, scale: 'savin', stage }, head);
    assert.equal(stats(savin).surfaceBuilds, 0);
    assert.equal(stats(savin).samplingBuilds, 0);
    assert.deepEqual(signature(savin), expected);
    dispose(savin);
  }
  assert.deepEqual([...calls], stages);
});
