import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FaceLandmarker } from '@mediapipe/tasks-vision';

const read = path => readFileSync(new URL(path, import.meta.url));
const atlas = JSON.parse(read('../src/lab/faceSim/genericFaceAtlas.json'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function load(path) {
  const source = read(path).toString().replace("import atlasData from './genericFaceAtlas.json' with { type: 'json' };", `const atlasData = ${JSON.stringify(atlas)};`);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const {
  locateModelPoint, locatePhotoPoint, locateSurfacePoint, modelPoint, photoPoint, surfacePoint, roundTripDifference,
} = await load('../src/lab/faceSim/faceTransfer.ts');
const {
  buildPersonalSurface, trianglesFromEdges, LANDMARK_ANCHORS, MODEL_REGISTRATION_ANCHORS, projectPersonal,
} = await load('../src/lab/faceSim/engine.ts');

const point = (index, positions = atlas.positions) => ({
  x: positions[index * 3], y: positions[index * 3 + 1], z: positions[index * 3 + 2],
});
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const vector = p => new THREE.Vector3(p.x, p.y, p.z);
const near = (a, b, epsilon = 1e-9) => assert.ok(roundTripDifference(a, b) <= epsilon, `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const indices = t => atlas.triangles.slice(t * 3, t * 3 + 3);
const addressAt = id => {
  const offset = atlas.triangles.indexOf(id);
  const weights = [0, 0, 0]; weights[offset % 3] = 1;
  return { triangle: Math.floor(offset / 3), weights };
};
const photo = atlas.positions.reduce((out, _, i) => {
  if (i % 3 === 0) out.push({ x: 0.5 + atlas.positions[i] / 5.3, y: 0.5 - atlas.positions[i + 1] / 5.3 });
  return out;
}, []);

// Lectura independiente del GLB ORIGINAL y normalización como Clinical3DViewer:
// bbox mundial de meshes, maxDim=5, centro bbox, sin atlas/casquete como referencia.
const bytes = read('../public/models/clinical/male_head.glb');
const original = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
original.updateMatrixWorld(true);
const bbox = new THREE.Box3();
original.traverse(mesh => {
  if (!mesh.isMesh || mesh.name === 'SCALP_HAIR_SOURCE') return;
  mesh.geometry.computeBoundingBox();
  bbox.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
});
const center = bbox.getCenter(new THREE.Vector3()), size = bbox.getSize(new THREE.Vector3());
const scale = 5 / Math.max(size.x, size.y, size.z);
const positions = [], originalIndices = [];
original.traverse(mesh => {
  if (!mesh.isMesh || mesh.name === 'SCALP_HAIR_SOURCE') return;
  const offset = positions.length / 3, attribute = mesh.geometry.getAttribute('position');
  for (let i = 0; i < attribute.count; i++) {
    positions.push(...new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).sub(center).multiplyScalar(scale).toArray());
  }
  for (let i = 0; i < mesh.geometry.index.count; i++) originalIndices.push(offset + mesh.geometry.index.getX(i));
});
const triangleOnGLB = face => new THREE.Triangle(...originalIndices.slice(face * 3, face * 3 + 3).map(i => vector(point(i, positions))));
const nearestGLBDistance = p => {
  const q = vector(p), out = new THREE.Vector3();
  let best = Infinity;
  for (let face = 0; face < originalIndices.length / 3; face++) {
    best = Math.min(best, triangleOnGLB(face).closestPointToPoint(q, out).distanceTo(q));
  }
  return best;
};

test('procedencia versionada: hash GLB, detector y script reproducible, sin fotos de pacientes', () => {
  assert.equal(atlas.provenance.glbSha256, sha256(bytes));
  assert.equal(atlas.provenance.detectorSha256, sha256(read('../public/models/face/face_landmarker.task')));
  assert.equal(atlas.provenance.generatorSha256, sha256(read('../scripts/build-face-atlas.mjs')));
  assert.equal(atlas.provenance.schemaVersion, 1);
  assert.equal(atlas.provenance.landmarkCount, 468);
  assert.equal(atlas.provenance.detection.length, 468);
  assert.equal(atlas.provenance.rayHits.length, 468);
  assert.equal(atlas.provenance.frame.width, 1400);
  assert.ok(atlas.modelId.includes('male_head.glb'));
});

test('superficie de apoyo es exactamente el GLB original, normalizado maxDim5 y centro bbox', () => {
  assert.equal(atlas.surface.positions.length, positions.length);
  assert.deepEqual(atlas.surface.triangles, originalIndices);
  positions.forEach((v, i) => assert.ok(Math.abs(v - atlas.surface.positions[i]) < 2e-15));
  assert.equal(Math.max(size.x, size.y, size.z) * scale, 5);
  assert.equal(atlas.provenance.normalization.scale, scale);
});

test('468 landmarks finitos y cada uno pertenece al triángulo raycasteado del GLB REAL', () => {
  assert.equal(atlas.positions.length, 468 * 3);
  assert.ok(atlas.positions.every(Number.isFinite));
  for (let i = 0; i < 468; i++) {
    const p = vector(point(i)), triangle = triangleOnGLB(atlas.provenance.rayHits[i].face);
    assert.ok(triangle.closestPointToPoint(p, new THREE.Vector3()).distanceTo(p) < 1e-12, `landmark ${i}`);
  }
  assert.ok(atlas.provenance.adjustments.length > 0, 'agujeros reales tratados explícitamente');
  assert.ok(atlas.provenance.adjustments.every(a => a.distance <= 0.08));
  assert.ok(atlas.provenance.topologyCorrections.every(a => a.distance < 0.015));
  assert.ok(atlas.provenance.topologyCorrections.every(a => ![0, 13, 14, 17, 61, 291].includes(a.index)));
});

test('852 triángulos MediaPipe originales, prefijo468 intacto y chart sin inversiones/colapsos', () => {
  assert.deepEqual(atlas.triangles, trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION));
  assert.equal(atlas.triangles.length, 852 * 3);
  assert.equal(new Set(atlas.triangles).size, 468);
  for (let t = 0; t < 852; t++) {
    const [a, b, c] = indices(t).map(i => point(i));
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    assert.ok(area >= 0.999e-6, `triángulo ${t}, área=${area}`);
  }
});

test('los 27 anclajes previos sirven de referencia, no se usan como plantilla del atlas', t => {
  const errors = LANDMARK_ANCHORS.map((group, i) => {
    const mean = group.reduce((a, id) => {
      const p = point(id); return { x: a.x + p.x / group.length, y: a.y + p.y / group.length, z: a.z + p.z / group.length };
    }, { x: 0, y: 0, z: 0 });
    return distance(mean, MODEL_REGISTRATION_ANCHORS[i]);
  });
  t.diagnostic(`27 anclajes: max=${Math.max(...errors).toFixed(4)}; labios/comisuras=${[5, 11, 12, 17, 18].map(i => errors[i].toFixed(4)).join(',')}`);
  assert.ok(errors.every(e => e < 0.5));
  [5, 11, 12, 17, 18].forEach(i => assert.ok(errors[i] < 0.025, `seed labial ${i}`));
});

test('modelo→dirección→modelo sobre GLB real: eleva cuerdas y rechaza zonas de chart sobre agujeros', () => {
  let lifted = 0, missing = 0;
  for (let t = 0; t < 852; t++) {
    const address = { triangle: t, weights: [0.2, 0.3, 0.5] };
    const p = modelPoint(address, atlas);
    if (!p) {
      missing++;
      const xy = indices(t).reduce((s, id, i) => ({
        x: s.x + point(id).x * address.weights[i], y: s.y + point(id).y * address.weights[i],
      }), { x: 0, y: 0 });
      const ray = new THREE.Ray(new THREE.Vector3(xy.x, xy.y, 10), new THREE.Vector3(0, 0, -1));
      for (let face = 0; face < originalIndices.length / 3; face++) {
        const triangle = triangleOnGLB(face);
        assert.equal(ray.intersectTriangle(triangle.a, triangle.b, triangle.c, true, new THREE.Vector3()), null,
          `solo es válido rechazar por agujero REAL, chart ${t}`);
      }
      continue;
    }
    const round = locateModelPoint(p, atlas);
    assert.ok(round, `triángulo ${t} sin dirección`);
    near(modelPoint(round, atlas), p);
    const chordZ = indices(t).reduce((s, id, i) => s + point(id).z * address.weights[i], 0);
    if (Math.abs(chordZ - p.z) > 1e-4) lifted++;
  }
  assert.ok(lifted > 100, 'la corrección al GLB real no es un no-op');
  assert.equal(missing, 1, 'una muestra del borde del ojo cae en el agujero poligonal real y no se inventa');
});

test('múltiples marcas finas upper/lower/comisura coinciden con semillas anatómicas conocidas', () => {
  const groups = {
    upper: [0, 13, 37, 267, 39, 269],
    lower: [14, 17, 84, 314, 181, 405],
    corner: [61, 291, 78, 308],
  };
  for (const [region, seeds] of Object.entries(groups)) {
    for (const id of seeds) {
      const p = point(id), address = locateModelPoint(p, atlas);
      assert.ok(address, `${region}:${id}`);
      near(photoPoint(address, photo, atlas), photo[id]);
      near(modelPoint(address, atlas), p);
      assert.ok(nearestGLBDistance(modelPoint(address, atlas)) < 1e-12);
    }
  }
  assert.ok(point(13).y - point(14).y > 0.005, 'abertura interna no colapsada');
  assert.ok(point(0).y - point(13).y > 0.05, 'espesor upper');
  assert.ok(point(14).y - point(17).y > 0.08, 'espesor lower');
});

test('la abertura de boca y ambos ojos siguen siendo agujeros: no inventar direcciones', () => {
  for (const [a, b] of [[13, 14], [159, 145], [386, 374]]) {
    const p = { x: (photo[a].x + photo[b].x) / 2, y: (photo[a].y + photo[b].y) / 2 };
    assert.equal(locatePhotoPoint(p, photo, atlas), null, `agujero ${a}/${b}`);
  }
});

test('transferencia upper/lower/comisura entre fotos y superficies de formas distintas conserva direcciones', () => {
  for (const variant of [0, 1, 2]) {
    const landmarks = photo.map((p, i) => {
      const x = p.x - 0.5, y = p.y - 0.5;
      return {
        x: 0.48 + x * (0.8 + variant * 0.2) + y * (0.1 - variant * 0.07),
        y: 0.51 + y * (1.1 - variant * 0.1) + x * x * variant * 0.3,
        z: -0.07 * Math.cos(x * 8) * Math.cos(y * 5) * (variant + 1) + i * 1e-7,
      };
    });
    const surface = buildPersonalSurface(landmarks, 0.8 + variant * 0.3, atlas.triangles, 1 + variant * 0.4);
    assert.ok(surface);
    const lipIds = new Set([0, 13, 14, 17, 37, 267, 84, 314, 61, 291]);
    for (let t = 0; t < 852; t++) {
      if (!indices(t).some(i => lipIds.has(i))) continue;
      for (const w of [[0.2, 0.3, 0.5], [0.7, 0.2, 0.1], [0.05, 0.05, 0.9]]) {
        const address = { triangle: t, weights: w };
        const q = photoPoint(address, landmarks, atlas);
        const found = locatePhotoPoint(q, landmarks, atlas);
        assert.ok(found, `variante ${variant}, triángulo labial ${t}`);
        assert.equal(found.triangle, t);
        near(photoPoint(found, landmarks, atlas), q);
        near(projectPersonal(surfacePoint(found, surface, atlas), surface.projection), q, 5e-8);
        const fromSurface = locateSurfacePoint(surfacePoint(found, surface, atlas), surface, atlas);
        assert.ok(fromSurface);
        assert.equal(fromSurface.triangle, t);
        near(photoPoint(fromSurface, landmarks, atlas), q, 5e-8);
        near(modelPoint(found, atlas), modelPoint(address, atlas));
      }
    }
  }
});

test('rechaza orejas, nuca, cuello, fuera de rostro y desplazamiento excesivo respecto al GLB', () => {
  for (const p of [
    { x: -1.32, y: 0.6, z: 0.2 }, { x: 1.32, y: 0.6, z: 0.2 },
    { x: 0, y: 0.3, z: -1.5 }, { x: 0, y: -2, z: 0.5 },
    { x: 0, y: 2.45, z: 0 }, { ...point(0), z: point(0).z + 0.1 },
  ]) assert.equal(locateModelPoint(p, atlas), null, JSON.stringify(p));
  assert.equal(locatePhotoPoint({ x: -0.1, y: 0.5 }, photo, atlas), null);
});

test('normal capturada y dirección a cámara rechazan selección desde atrás/grazing; tolerancias explícitas', () => {
  const p = modelPoint(addressAt(0), atlas);
  assert.ok(locateModelPoint(p, atlas, { normal: { x: 0, y: 0, z: 1 }, viewDirection: { x: 0, y: 0, z: 1 } }));
  assert.equal(locateModelPoint(p, atlas, { normal: { x: 0, y: 0, z: -1 } }), null);
  assert.equal(locateModelPoint(p, atlas, { viewDirection: { x: 0, y: 0, z: -1 } }), null);
  assert.equal(locateModelPoint(p, atlas, { normal: { x: 0, y: 0, z: 0 } }), null);
  const displaced = { ...p, z: p.z + 0.04 };
  assert.equal(locateModelPoint(displaced, atlas), null);
  assert.ok(locateModelPoint(displaced, atlas, { maxDistance: 0.05 }));
});

test('máscara de cobertura bloquea todos los triángulos no observados (no presume perfiles visibles)', () => {
  const address = { triangle: 359, weights: [0.2, 0.3, 0.5] }, p = modelPoint(address, atlas);
  const mask = Array(852).fill(false);
  assert.equal(locateModelPoint(p, atlas, { visibleTriangles: mask }), null);
  assert.equal(locatePhotoPoint(photoPoint(address, photo, atlas), photo, atlas, { visibleTriangles: mask }), null);
  mask[address.triangle] = true;
  assert.equal(locateModelPoint(p, atlas, { visibleTriangles: mask }).triangle, address.triangle);
});

const synthetic = {
  modelId: 'fixture', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1],
  triangles: [0, 1, 2, 3, 4, 5],
};
const flatPhoto = Array.from({ length: 468 }, () => ({ x: NaN, y: NaN }));
for (let i = 0; i < 6; i++) flatPhoto[i] = { x: synthetic.positions[i * 3], y: synthetic.positions[i * 3 + 1] };

test('solapamiento/oclusión 2D ambiguo se rechaza; máscara observada permite resolverlo', () => {
  const p = { x: 0.2, y: 0.3 };
  assert.equal(locatePhotoPoint(p, flatPhoto, synthetic), null);
  const address = locatePhotoPoint(p, flatPhoto, synthetic, { visibleTriangles: [false, true] });
  assert.equal(address.triangle, 1);
  near(photoPoint(address, flatPhoto, synthetic), p);
});

test('degenerados 2D/3D, NaN, landmarks ausentes, opciones y direcciones inválidas => null', () => {
  const address = { triangle: 0, weights: [0.2, 0.3, 0.5] };
  const degenerate = { ...synthetic, positions: synthetic.positions.map(() => 0) };
  assert.equal(modelPoint(address, degenerate), null);
  assert.equal(photoPoint(address, Array(468).fill({ x: 0, y: 0 }), synthetic), null);
  assert.equal(locatePhotoPoint({ x: 0, y: 0 }, [], atlas), null);
  assert.equal(locatePhotoPoint({ x: NaN, y: 0 }, photo, atlas), null);
  assert.equal(locatePhotoPoint(photo[0], photo, atlas, { aspect: 0 }), null);
  assert.equal(locatePhotoPoint(photo[0], photo, atlas, { minTriangleArea: -1 }), null);
  assert.equal(locateModelPoint(point(0), atlas, { maxDistance: NaN }), null);
  for (const bad of [
    { triangle: -1, weights: [1, 0, 0] }, { triangle: 852, weights: [1, 0, 0] },
    { triangle: 0.5, weights: [1, 0, 0] }, { triangle: 0, weights: [NaN, 0, 0] },
    { triangle: 0, weights: [0.5, 0.5, 0.5] }, { triangle: 0, weights: [-0.1, 0.6, 0.5] },
  ]) {
    assert.equal(modelPoint(bad, atlas), null);
    assert.equal(photoPoint(bad, photo, atlas), null);
  }
});

test('aristas/vértices compartidos se resuelven de forma determinista sin falsa ambigüedad', () => {
  for (const id of [0, 13, 14, 17, 61, 291, 1, 152]) {
    const address = locatePhotoPoint(photo[id], photo, atlas);
    assert.ok(address, `vértice ${id}`);
    assert.deepEqual(address, locatePhotoPoint(photo[id], photo, atlas));
    near(photoPoint(address, photo, atlas), photo[id]);
  }
});

test('surfacePoint conserva prefijo mesh468, admite extensión inferida pero nunca la direcciona', () => {
  const surface = buildPersonalSurface(photo, 1, atlas.triangles);
  const address = addressAt(13), expected = surfacePoint(address, surface, atlas);
  const extended = {
    ...surface, positions: Float32Array.from([...surface.positions, 0, 0, -5]),
    indices: Uint32Array.from([...surface.indices, 0, 1, 468]),
  };
  near(surfacePoint(address, extended, atlas), expected);
  assert.equal(surfacePoint({ triangle: 852, weights: [1, 0, 0] }, extended, atlas), null);
  assert.equal(locateSurfacePoint({ x: 0, y: 0, z: -5 }, extended, atlas), null);
  assert.ok(locateSurfacePoint(expected, extended, atlas));
  assert.equal(locateSurfacePoint(expected, extended, atlas, { visibleTriangles: [] }), null);
  const reordered = { ...surface, indices: Uint32Array.from(surface.indices).reverse() };
  assert.equal(surfacePoint(address, reordered, atlas), null);
  const degenerate = { ...surface, positions: new Float32Array(surface.positions.length) };
  assert.equal(surfacePoint(address, degenerate, atlas), null);
});

test('métrica round-trip devuelve error explícito o null, sin garantías clínicas ni mutación', () => {
  assert.equal(roundTripDifference({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(roundTripDifference({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 }), 3);
  assert.equal(roundTripDifference(photo[0], null), null);
  assert.equal(roundTripDifference(photo[0], point(0)), null);
  const before = JSON.stringify(atlas), photoBefore = JSON.stringify(photo);
  const address = locateModelPoint(point(0), atlas);
  modelPoint(address, atlas); photoPoint(address, photo, atlas); locatePhotoPoint(photo[0], photo, atlas);
  assert.equal(JSON.stringify(atlas), before);
  assert.equal(JSON.stringify(photo), photoBefore);
});
