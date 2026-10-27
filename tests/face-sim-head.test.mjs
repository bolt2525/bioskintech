import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';

// Módulos puros compilados en memoria: sin DOM, loader TS ni archivos generados.
async function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { buildEstimatedHead, FACE_OVAL } = await load('../src/lab/faceSim/estimatedHead.ts');
const { buildPersonalSurface, trianglesFromEdges, projectPersonal } = await load('../src/lab/faceSim/engine.ts');
const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);

function edges(indices) {
  const result = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j], b = indices[i + (j + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const e = result.get(key) ?? { count: 0, direction: 0, a, b };
      e.count++;
      e.direction += a < b ? 1 : -1;
      result.set(key, e);
    }
  }
  return result;
}

// Embedding armónico de la topología REAL MediaPipe. No requiere fotos ni red.
function fixture(concave = false) {
  const neighbors = Array.from({ length: 468 }, () => new Set());
  for (const { a, b } of edges(triangles).values()) {
    neighbors[a].add(b);
    neighbors[b].add(a);
  }
  const xy = Array.from({ length: 468 }, () => [0, 0]), fixed = new Set(FACE_OVAL);
  FACE_OVAL.forEach((id, i) => {
    const t = i * 2 * Math.PI / FACE_OVAL.length;
    const r = concave && i === 9 ? 0.93 : 1;
    xy[id] = [Math.sin(t) * 0.31 * r, Math.cos(t) * 0.4 * r];
  });
  for (let iteration = 0; iteration < 3000; iteration++) {
    for (let id = 0; id < 468; id++) {
      if (fixed.has(id) || !neighbors[id].size) continue;
      xy[id] = [0, 1].map(axis =>
        [...neighbors[id]].reduce((sum, other) => sum + xy[other][axis], 0) / neighbors[id].size);
    }
  }
  const landmarks = xy.map(([x, y]) =>
    ({ x: 0.5 + x, y: 0.5 - y, z: -0.07 * Math.exp(-(x * x + y * y) / 0.04) }));
  const surface = buildPersonalSurface(landmarks, 1, triangles);
  assert.ok(surface);
  return surface;
}
const original = fixture();
const detected = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const detectedSurface = buildPersonalSurface(
  detected.landmarks.map(([x, y, z]) => ({ x, y, z })), detected.aspect, triangles,
);

function point(surface, id) { return [...surface.positions.subarray(id * 3, id * 3 + 3)]; }
function normal(surface, offset) {
  const [a, b, c] = [...surface.indices.subarray(offset, offset + 3)].map(id => point(surface, id));
  const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function assertClosed(surface) {
  for (const [key, edge] of edges(surface.indices)) {
    assert.equal(edge.count, 2, `incidencia ${key}`);
    assert.equal(edge.direction, 0, `orientación ${key}`);
  }
  assert.ok(surface.positions.every(Number.isFinite));
  assert.ok(surface.uvs.every(Number.isFinite));
  const used = new Set(surface.indices);
  assert.ok([...used].every(id => id < surface.positions.length / 3));
  for (let i = 0; i < surface.indices.length; i += 3) {
    assert.ok(Math.hypot(...normal(surface, i)) > 0, `normal degenerada ${i / 3}`);
  }
  assert.equal(used.size - edges(surface.indices).size + surface.indices.length / 3, 2, 'esfera topológica');
}

test('cierra óvalo, ambos ojos y boca de la teselación real, con orientación consistente', () => {
  assert.equal([...edges(original.indices).values()].filter(e => e.count === 1).length, 88);
  const head = buildEstimatedHead(original);
  assertClosed(head);
  assert.equal(head.observedIndexCount, 852 * 3);
  assert.equal(head.positions.length / 3, 468 + 36 * 12);
});

test('labios/párpados colapsados en XY no bloquean el cráneo ni se tapan con triángulos ficticios', () => {
  const positions = original.positions.slice();
  const outer = new Set(FACE_OVAL);
  const holeEdges = [...edges(original.indices).values()].filter(e => e.count === 1 && !outer.has(e.a));
  const remaining = new Set(holeEdges.flatMap(e => [e.a, e.b]));
  while (remaining.size) {
    const ids = [remaining.values().next().value], visited = new Set(ids);
    for (let i = 0; i < ids.length; i++) for (const e of holeEdges) {
      const next = e.a === ids[i] ? e.b : e.b === ids[i] ? e.a : -1;
      if (next >= 0 && !visited.has(next)) { visited.add(next); ids.push(next); }
    }
    const y = ids.reduce((sum, id) => sum + positions[id * 3 + 1], 0) / ids.length;
    for (const id of ids) { positions[id * 3 + 1] = y; remaining.delete(id); }
  }
  const input = { ...original, positions }, head = buildEstimatedHead(input);
  assert.equal(head.preservedOpenings, 3);
  assert.deepEqual(head.positions.subarray(0, positions.length), positions);
  const remainingBoundary = [...edges(head.indices).values()].filter(e => e.count === 1);
  assert.equal(remainingBoundary.length, holeEdges.length);
  assert.ok(remainingBoundary.every(e => !outer.has(e.a) && !outer.has(e.b)), 'cráneo completo, solo aberturas originales conservadas');
});

test('preserva exactamente originales, UV y proyección, sin mutar ni compartir buffers', () => {
  const before = {
    positions: original.positions.slice(), uvs: original.uvs.slice(), indices: original.indices.slice(),
  };
  const head = buildEstimatedHead(original);
  for (const key of ['positions', 'uvs', 'indices']) {
    assert.deepEqual(head[key].subarray(0, original[key].length), before[key]);
    assert.deepEqual(original[key], before[key]);
    assert.notEqual(head[key].buffer, original[key].buffer);
  }
  assert.equal(head.projection, original.projection);
  assert.deepEqual(projectPersonal({ x: 0.2, y: -0.5, z: 0.1 }, head.projection),
    projectPersonal({ x: 0.2, y: -0.5, z: 0.1 }, original.projection));
  assert.ok(head.uvs.subarray(original.uvs.length).every(v => v === 0.5));
  assert.deepEqual(buildEstimatedHead(original), head, 'determinista');
});

test('tapas conservadoras de ojos/boca: índices estimados, sin vértices o UV frontales nuevos', () => {
  const head = buildEstimatedHead(original);
  const outer = new Set(FACE_OVAL);
  const holes = [...edges(original.indices).values()].filter(e => e.count === 1 && !outer.has(e.a));
  const addedEdges = edges(head.indices.subarray(head.observedIndexCount));
  for (const e of holes) {
    assert.equal(addedEdges.get(e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`).count, 1);
  }
  let caps = 0;
  for (let i = head.observedIndexCount; i < head.indices.length; i += 3) {
    const ids = [...head.indices.subarray(i, i + 3)];
    if (ids.every(id => id < 468)) {
      caps++;
      assert.ok(ids.every(id => !outer.has(id)));
      assert.ok(normal(head, i)[2] > 0, 'tapa mirando al frente');
    }
  }
  assert.equal(caps, (16 - 2) * 2 + 20 - 2);
});

test('normales posteriores y laterales hacia afuera, casquete detrás de toda la cara', () => {
  const head = buildEstimatedHead(original);
  const center = [0, 0, Math.min(...original.positions.filter((_, i) => i % 3 === 2)) - 0.4];
  const minZ = Math.min(...original.positions.filter((_, i) => i % 3 === 2));
  for (let id = 468; id < head.positions.length / 3; id++) assert.ok(point(head, id)[2] < minZ);
  for (let i = head.observedIndexCount; i < head.indices.length; i += 3) {
    const ids = [...head.indices.subarray(i, i + 3)];
    if (ids.every(id => id < 468)) continue;
    const centroid = [0, 1, 2].map(axis => ids.reduce((s, id) => s + point(head, id)[axis], 0) / 3);
    const n = normal(head, i);
    assert.ok(n.reduce((sum, v, axis) => sum + v * (centroid[axis] - center[axis]), 0) > 0);
  }
});

test('equivarianza de escala positiva y traslación, sin renormalizar ni cambiar projection', () => {
  const base = buildEstimatedHead(original);
  for (const scale of [0.000001, 0.001, 0.5, 7, 1000]) {
    const delta = [3 * scale, -2 * scale, 4 * scale];
    const transformed = { ...original,
      positions: original.positions.map((v, i) => v * scale + delta[i % 3]),
    };
    const head = buildEstimatedHead(transformed);
    assertClosed(head);
    assert.deepEqual(head.indices, base.indices);
    assert.equal(head.projection, original.projection);
    head.positions.forEach((v, i) => {
      assert.ok(Math.abs(v - (base.positions[i] * scale + delta[i % 3])) < scale * 2e-6);
    });
  }
});

test('concavidad suave en óvalo: cierra sin abanico externo ni cruce radial', () => {
  const surface = fixture(true);
  const head = buildEstimatedHead(surface);
  assertClosed(head);
  const convexSigns = FACE_OVAL.map((id, i) => {
    const a = point(surface, FACE_OVAL[(i + 35) % 36]), b = point(surface, id);
    const c = point(surface, FACE_OVAL[(i + 1) % 36]);
    return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  });
  assert.ok(convexSigns.includes(1) && convexSigns.includes(-1), 'fixture realmente cóncava');
});

test('el casquete posterior se centra por área, no por densidad de puntos del contorno', () => {
  const surface = fixture();
  const positions = surface.positions.slice();
  for (let id = 0; id < 468; id++) {
    const x = positions[id * 3] / 0.31, y = positions[id * 3 + 1] / 0.4;
    const radius = Math.hypot(x, y), angle = Math.atan2(x, y);
    const sampledAngle = angle + 0.2 * Math.sin(angle);
    positions[id * 3] = Math.sin(sampledAngle) * radius * 0.31;
    positions[id * 3 + 1] = Math.cos(sampledAngle) * radius * 0.4;
  }
  const skewed = { ...surface, positions };
  const head = buildEstimatedHead(skewed);
  const oval = new Set(FACE_OVAL);
  const outerEdges = [...edges(skewed.indices).values()].filter(e =>
    e.count === 1 && oval.has(e.a) && oval.has(e.b));
  const next = new Map(outerEdges.map(e => [e.a, e.b]));
  const loop = [outerEdges[0].a];
  while (next.has(loop.at(-1)) && next.get(loop.at(-1)) !== loop[0]) loop.push(next.get(loop.at(-1)));
  const origin = point(skewed, loop[0]);
  let twiceArea = 0, cx = 0, cy = 0, vertexX = 0, vertexY = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = point(skewed, loop[i]), b = point(skewed, loop[(i + 1) % loop.length]);
    const ax = a[0] - origin[0], ay = a[1] - origin[1];
    const bx = b[0] - origin[0], by = b[1] - origin[1];
    const wedge = ax * by - ay * bx;
    twiceArea += wedge;
    cx += (ax + bx) * wedge; cy += (ay + by) * wedge;
    vertexX += a[0] / loop.length; vertexY += a[1] / loop.length;
  }
  const expected = [origin[0] + cx / (3 * twiceArea), origin[1] + cy / (3 * twiceArea)];
  const radius = Math.cos(Math.PI / 24);
  const firstRing = point(head, positions.length / 3 + FACE_OVAL.length);
  const firstBoundary = point(skewed, loop[0]);
  const height = Math.max(...FACE_OVAL.map(id => point(skewed, id)[1])) - Math.min(...FACE_OVAL.map(id => point(skewed, id)[1]));
  const recoveredCenter = firstRing.slice(0, 2).map((value, axis) =>
    (value - (axis === 1 ? height * (0.125 + 0.20 * Math.sin(Math.PI / 24)) : 0)
      - radius * (axis === 1 ? 1.25 : 1.04) * firstBoundary[axis]) / (1 - radius * (axis === 1 ? 1.25 : 1.04)));
  assert.ok(Math.hypot(recoveredCenter[0] - expected[0], recoveredCenter[1] - expected[1]) < 2e-5,
    `${recoveredCenter} vs ${expected}`);
  assert.ok(Math.hypot(expected[0] - vertexX, expected[1] - vertexY) > 0.015,
    'el fixture distingue centroide geométrico y media de vértices');
});

test('bóveda posterior elevada, no una copia del óvalo facial extruida hacia atrás', () => {
  const head = buildEstimatedHead(detectedSurface);
  const observedTop = Math.max(...detectedSurface.positions.filter((_, i) => i % 3 === 1));
  const inferredTop = Math.max(...head.positions.subarray(detectedSurface.positions.length).filter((_, i) => i % 3 === 1));
  assert.ok(inferredTop > observedTop + 0.5);
});

test('pequeña salida periférica de una sien conserva landmarks y permite cerrar sin cruces nuevos', () => {
  const positions = detectedSurface.positions.slice();
  const a = point(detectedSurface, 234), b = point(detectedSurface, 127);
  const center = [0, 1, 2].map(axis => (a[axis] + b[axis]) / 2);
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  positions.set([center[0] - Math.abs(dy) / length * 0.005, center[1] - Math.sign(dy) * dx / length * 0.005,
    Math.max(a[2], b[2]) + 0.2], 227 * 3);
  const source = { ...detectedSurface, positions };
  const head = buildEstimatedHead(source);
  assertClosed(head);
  assert.deepEqual(head.positions.subarray(0, positions.length), positions);
});

// Intersección segmento/triángulo; las parejas coplanares se prueban en 2D.
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function hitsSegment(p, q, [a, b, c]) {
  const d = subtract(q, p), ab = subtract(b, a), ac = subtract(c, a);
  const h = cross3(d, ac), det = dot(ab, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = subtract(p, a), u = dot(s, h) / det;
  const r = cross3(s, ab), v = dot(d, r) / det, t = dot(ac, r) / det;
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9;
}
function trianglesIntersect(a, b) {
  const n = cross3(subtract(a[1], a[0]), subtract(a[2], a[0]));
  const coplanar = b.every(p => Math.abs(dot(n, subtract(p, a[0]))) < Math.hypot(...n) * 1e-9);
  if (!coplanar) {
    return a.some((p, i) => hitsSegment(p, a[(i + 1) % 3], b)) ||
      b.some((p, i) => hitsSegment(p, b[(i + 1) % 3], a));
  }
  const drop = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const project = p => p.filter((_, i) => i !== drop);
  const aa = a.map(project), bb = b.map(project);
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const inside = (p, tri) => {
    const values = tri.map((q, i) => orient(q, tri[(i + 1) % 3], p));
    return values.every(v => v > 1e-10) || values.every(v => v < -1e-10);
  };
  if (aa.some(p => inside(p, bb)) || bb.some(p => inside(p, aa))) return true;
  return aa.some((p, i) => bb.some((q, j) => {
    const r = aa[(i + 1) % 3], s = bb[(j + 1) % 3];
    return orient(p, r, q) * orient(p, r, s) < -1e-18 && orient(q, s, p) * orient(q, s, r) < -1e-18;
  }));
}

test('sin cruces añadidos en triángulos no adyacentes: óvalo convexo, cóncavo y detección MediaPipe', () => {
  for (const source of [original, fixture(true), detectedSurface]) {
    const head = buildEstimatedHead(source), faces = [];
    for (let i = 0; i < head.indices.length; i += 3) {
      const ids = [...head.indices.subarray(i, i + 3)], p = ids.map(id => point(head, id));
      faces.push({ ids, p, min: [0, 1, 2].map(k => Math.min(...p.map(v => v[k]))),
        max: [0, 1, 2].map(k => Math.max(...p.map(v => v[k]))) });
    }
    for (let i = 0; i < faces.length; i++) {
      const a = faces[i];
      for (let j = i + 1; j < faces.length; j++) {
        // Los defectos observados se preservan, no se reparan. Solo certificamos
        // que las tapas/casquete no introduzcan cruces nuevos en estas muestras.
        if (j * 3 < head.observedIndexCount) continue;
        const b = faces[j];
        if (a.ids.some(id => b.ids.includes(id))) continue;
        if (a.min.some((v, k) => v > b.max[k] + 1e-9 || b.min[k] > a.max[k] + 1e-9)) continue;
        assert.equal(trianglesIntersect(a.p, b.p), false, `cruce ${i}/${j}`);
      }
    }
  }
});

test('regresión QA MediaPipe detectado: tolera inversión XY interior, cierra y preserva todos los prefijos', () => {
  assert.equal(detected.used, 2);
  assert.equal(detected.coverage, 'bilateral');
  assert.equal(detected.landmarks.length, 478);
  let inverted = 0;
  for (let i = 0; i < detectedSurface.indices.length; i += 3) {
    if (normal(detectedSurface, i)[2] < 0) inverted++;
  }
  assert.equal(inverted, 1, 'reproduce el triángulo interior invertido del fixture runtime');
  const head = buildEstimatedHead(detectedSurface);
  assertClosed(head);
  assert.equal(head.observedIndexCount, 2556);
  assert.equal(head.indices.length, 5388);
  assert.equal(head.positions.length / 3, 910);
  assert.equal(head.projection, detectedSurface.projection);
  for (const key of ['positions', 'uvs', 'indices']) {
    assert.deepEqual(head[key].subarray(0, detectedSurface[key].length), detectedSurface[key]);
  }
});

test('tolera triángulos interiores degenerados solo en XY sin alterar la geometría observada', () => {
  const positions = original.positions.slice();
  // Triángulo nasal interior: dos vértices comparten XY pero mantienen Z distinto.
  const [a, b] = [209, 129];
  positions[b * 3] = positions[a * 3];
  positions[b * 3 + 1] = positions[a * 3 + 1];
  positions[b * 3 + 2] = positions[a * 3 + 2] + 0.01;
  const head = buildEstimatedHead({ ...original, positions });
  assertClosed(head);
  assert.deepEqual(head.positions.subarray(0, positions.length), positions);
});

test('conserva iris/vértices no referenciados sin usarlos para inflar el prior', () => {
  const positions = new Float32Array(478 * 3);
  positions.set(original.positions);
  positions.fill(100, original.positions.length);
  const uvs = new Float32Array(478 * 2);
  uvs.set(original.uvs);
  const head = buildEstimatedHead({ ...original, positions, uvs });
  assertClosed(head);
  assert.deepEqual(head.positions.subarray(0, positions.length), positions);
  const base = buildEstimatedHead(original);
  assert.deepEqual(head.positions.subarray(positions.length), base.positions.subarray(original.positions.length));
  for (const id of head.indices) assert.ok(id < 468 || id >= 478);
});

test('hereda winding global invertido sin alterar ningún índice observado', () => {
  const indices = original.indices.slice();
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const head = buildEstimatedHead({ ...original, indices });
  assertClosed(head);
  assert.deepEqual(head.indices.subarray(0, indices.length), indices);
});

test('rechaza entradas inválidas, no manifold, winding inconsistente y salidas del óvalo', () => {
  assert.throws(() => buildEstimatedHead({ ...original, uvs: new Float32Array(2) }), /incompletos/);
  const bad = original.positions.slice(); bad[0] = NaN;
  assert.throws(() => buildEstimatedHead({ ...original, positions: bad }), /no finitos/);
  assert.throws(() => buildEstimatedHead({ ...original, indices: new Uint32Array([0, 1, 999]) }), /índices inválidos/);
  const duplicate = new Uint32Array([...original.indices, ...original.indices.subarray(0, 3)]);
  assert.throws(() => buildEstimatedHead({ ...original, indices: duplicate }), /manifold|orientación/);
  const flipped = original.indices.slice();
  [flipped[1], flipped[2]] = [flipped[2], flipped[1]];
  assert.throws(() => buildEstimatedHead({ ...original, indices: flipped }), /orientación|ramificada/);
  const folded = original.positions.slice();
  folded[1 * 3] = 100;
  assert.throws(() => buildEstimatedHead({ ...original, positions: folded }), /fuera del óvalo/);
  assert.throws(() => buildEstimatedHead(buildEstimatedHead(original)), /FACE_OVAL/);
});
