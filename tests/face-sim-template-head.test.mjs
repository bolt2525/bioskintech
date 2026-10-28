import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { FaceLandmarker } from '@mediapipe/tasks-vision';

const compile = (path, replace = {}) => {
  let code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [from, to] of Object.entries(replace)) code = code.replaceAll(from, to);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const headUrl = compile('../src/lab/faceSim/estimatedHead.ts');
const { buildTemplateHead } = await import(compile('../src/lab/faceSim/templateHead.ts', { "'./estimatedHead'": `'${headUrl}'` }));
const { buildPersonalSurface, trianglesFromEdges } = await import(compile('../src/lab/faceSim/engine.ts'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const data = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const triangles = trianglesFromEdges(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const face = buildPersonalSurface(data.landmarks.map(([x, y, z]) => ({ x, y, z })), data.aspect, triangles, 1);
const template = { landmarks: atlas.positions, positions: atlas.surface.positions, triangles: atlas.surface.triangles };

function edgeUse(indices) {
  const use = new Map();
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j], b = indices[i + (j + 1) % 3], k = a < b ? `${a}:${b}` : `${b}:${a}`;
    use.set(k, (use.get(k) ?? 0) + 1);
  }
  return use;
}
const bounds = (p, from, to) => [0, 1, 2].map(a => {
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i < to; i++) { lo = Math.min(lo, p[i * 3 + a]); hi = Math.max(hi, p[i * 3 + a]); }
  return [lo, hi];
});

test('plantilla ajustada: conserva la cara, cose el óvalo sin bordes libres y aporta cráneo con orejas', () => {
  assert.ok(face);
  const head = buildTemplateHead(face, template);
  const count = face.positions.length / 3;
  assert.deepEqual(Array.from(head.positions.subarray(0, count * 3)), Array.from(face.positions));
  assert.deepEqual(Array.from(head.indices.subarray(0, head.observedIndexCount)), Array.from(face.indices));
  const use = edgeUse(head.indices);
  assert.ok([...use.values()].every(n => n <= 2), 'sin aristas no manifold');
  const ovalFree = [...use.entries()].filter(([k, n]) => n === 1 && k.split(':').some(id => +id < count));
  // Solo quedan libres las aberturas de ojos/boca de la cara observada, nunca el óvalo.
  for (const [k] of ovalFree) assert.ok(k.split(':').every(id => +id < count), `costura abierta en ${k}`);
  const [fx, fy, fz] = bounds(head.positions, 0, 468), [hx, hy, hz] = bounds(head.positions, count, head.positions.length / 3);
  const faceH = fy[1] - fy[0];
  assert.ok(hz[0] < fz[0] - faceH * 0.5, 'la nuca queda detrás de la cara');
  assert.ok(hy[1] > fy[1], 'la bóveda sobrepasa la frente');
  assert.ok(hx[1] - hx[0] > (fx[1] - fx[0]) * 1.05, 'orejas/cráneo más anchos que el óvalo');
  assert.ok((hz[1] - hz[0]) < faceH * 2.2, 'sin cráneo inflado');
});

test('las siluetas ajustan el cráneo hacia la máscara observada', () => {
  const base = buildTemplateHead(face, template), count = face.positions.length / 3;
  const [, , bz] = bounds(base.positions, count, base.positions.length / 3);
  const [fx, fy, fz] = bounds(face.positions, 0, 468);
  // Cámara lateral ortográfica: u = −z (nuca a la derecha), v = −y.
  const width = 160, height = 160, back = bz[0] - (fz[1] - bz[0]) * 0.15;
  const scale = 0.6 / (fz[1] - back), cu = 0.2 + scale * fz[1], cv = 0.5 + scale * (fy[0] + fy[1]) / 2;
  const mask = Float32Array.from({ length: width * height }, (_, i) => {
    const u = (i % width + 0.5) / width, v = (Math.floor(i / width) + 0.5) / height;
    const z = -(u - cu) / scale, y = -(v - cv) / scale;
    return z < fz[1] && z > back && y < fy[1] + (fy[1] - fy[0]) * 0.3 && y > fy[0] - (fy[1] - fy[0]) * 0.3 ? 1 : 0;
  });
  const source = { label: 'lateral', width, height, mask, texture: {},
    projection: { u: [0, 0, -scale, cu], v: [0, -scale, 0, cv], towardCamera: [1, 0, 0] } };
  const fitted = buildTemplateHead(face, template, [source]);
  const occiput = h => { let z = Infinity; for (let i = count; i < h.positions.length / 3; i++) if (h.positions[i * 3 + 1] > (fy[0] + fy[1]) / 2) z = Math.min(z, h.positions[i * 3 + 2]); return z; };
  assert.ok(occiput(fitted) < occiput(base) - 0.02, 'el occipucio se desplaza hacia la silueta más profunda');
  assert.ok(Math.abs(occiput(fitted) - back) < Math.abs(occiput(base) - back) * 0.5, 'el ajuste por vértice alcanza la silueta, no solo una escala global');
  assert.ok(fitted.positions.every(Number.isFinite));
  assert.ok(fx[1] > fx[0]);
});

test('la silueta de perfil corrige la profundidad de la línea media (nariz, labios, mentón)', async () => {
  const { refineProfileDepth, PROFILE_MIDLINE } = await import(compile('../src/lab/faceSim/multiViewHead.ts'));
  const P = i => [face.positions[i * 3], face.positions[i * 3 + 1], face.positions[i * 3 + 2]];
  const faceH = Math.hypot(...P(10).map((v, k) => v - P(152)[k])), delta = faceH * 0.04;
  const mid = PROFILE_MIDLINE.map(P).sort((a, b) => a[1] - b[1]);
  const frontAt = y => {
    const j = mid.findIndex(p => p[1] >= y);
    if (j <= 0) return mid[j === 0 ? 0 : mid.length - 1][2];
    const t = (y - mid[j - 1][1]) / (mid[j][1] - mid[j - 1][1]);
    return mid[j - 1][2] + (mid[j][2] - mid[j - 1][2]) * t;
  };
  const width = 400, height = 400, scale = 0.08, cu = 0.5, cv = 0.5;
  // Perfil ortográfico: u = cu - z·scale (la cara apunta a -u); la silueta queda «delta» por delante.
  const mask = Float32Array.from({ length: width * height }, (_, i) => {
    const u = (i % width + 0.5) / width, v = (Math.floor(i / width) + 0.5) / height;
    const z = (cu - u) / scale, y = (cv - v) / scale;
    return z < frontAt(y) + delta && z > frontAt(y) - faceH ? 1 : 0;
  });
  const source = { label: 'perfil', width, height, mask, texture: {},
    projection: { u: [0, 0, -scale, cu], v: [0, -scale, 0, cv], towardCamera: [1, 0, 0] } };
  const result = refineProfileDepth(face.positions, [source]);
  assert.ok(result && result.points >= 10, 'usa la mayoría de puntos de la línea media');
  for (const id of [1, 0, 17, 199]) {
    const moved = result.positions[id * 3 + 2] - face.positions[id * 3 + 2];
    assert.ok(moved > delta * 0.5 && moved < delta * 1.3, `${id} avanza hacia la silueta (${moved / delta})`);
  }
  assert.ok(Math.abs(result.positions[234 * 3 + 2] - face.positions[234 * 3 + 2]) < delta * 0.1, 'el borde lateral no se arrastra');
  assert.equal(refineProfileDepth(face.positions, [{ ...source, projection: { u: [scale, 0, 0, cu], v: [0, -scale, 0, cv], towardCamera: [0, 0, 1] } }]), null, 'una vista frontal no aporta');
});

// QA sintético: rasterizar triángulos, no solo vértices (la cobertura entre filas importa).
function silhouette(head, projection, size = 256) {
  const rows = Array.from({ length: size }, () => [Infinity, -Infinity]);
  const uv = Array.from({ length: head.positions.length / 3 }, (_, id) =>
    [projection.u, projection.v].map(row => row[3] + row.slice(0, 3).reduce((s, v, k) => s + v * head.positions[id * 3 + k], 0)));
  for (let i = 0; i < head.indices.length; i += 3) {
    const tri = Array.from(head.indices.subarray(i, i + 3), id => uv[id]);
    const lo = Math.max(0, Math.ceil(Math.min(...tri.map(p => p[1])) * size - 0.5));
    const hi = Math.min(size - 1, Math.floor(Math.max(...tri.map(p => p[1])) * size - 0.5));
    for (let y = lo; y <= hi; y++) for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3], v = (y + 0.5) / size;
      if (a[1] === b[1] || v < Math.min(a[1], b[1]) || v > Math.max(a[1], b[1])) continue;
      const u = a[0] + (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]);
      rows[y][0] = Math.min(rows[y][0], u); rows[y][1] = Math.max(rows[y][1], u);
    }
  }
  return rows;
}

function syntheticPhoto(head, projection) {
  const width = 256, height = 256, rows = silhouette(head, projection, height);
  return { label: 'sintética', width, height, projection, texture: {},
    mask: Float32Array.from({ length: width * height }, (_, i) => {
      const [l, r] = rows[Math.floor(i / width)], u = (i % width + 0.5) / width;
      return u >= l && u <= r ? 1 : 0;
    }) };
}

test('perfil menos profundo: reduce error occipital sin ensanchar frontal ni mover cara/UV/costura', t => {
  const base = buildTemplateHead(face, template), count = face.positions.length / 3;
  const [fx, fy] = bounds(face.positions, 0, count), faceH = fy[1] - fy[0];
  const pivotZ = (face.positions[234 * 3 + 2] + face.positions[454 * 3 + 2]) / 2;
  const target = { ...base, positions: Float32Array.from(base.positions) };
  for (let id = count; id < target.positions.length / 3; id++) {
    const z = target.positions[id * 3 + 2];
    if (z < pivotZ) target.positions[id * 3 + 2] = pivotZ + (z - pivotZ) * 0.65;
  }
  const scale = 0.6 / faceH, cv = 0.5 + scale * (fy[0] + fy[1]) / 2;
  const frontal = { u: [scale, 0, 0, 0.5 - scale * (fx[0] + fx[1]) / 2], v: [0, -scale, 0, cv], towardCamera: [0, 0, 1] };
  // Perfil oblicuo: invertir el plano de imagen sin restricciones también altera el ancho frontal.
  const profile = { u: [scale * 0.25, 0, -scale, 0.3], v: [0, -scale, 0, cv], towardCamera: [1, 0, 0.25] };
  const photos = [syntheticPhoto(target, frontal), syntheticPhoto(target, profile)];
  const fitted = buildTemplateHead(face, template, photos);
  const targetRows = silhouette(target, profile), error = head => {
    const rows = silhouette(head, profile);
    let sum = 0, n = 0;
    for (let y = 0; y < rows.length; y++) {
      const worldY = (cv - (y + 0.5) / rows.length) / scale;
      if (worldY < (fy[0] + fy[1]) / 2 || worldY > fy[1]) continue;
      if (Number.isFinite(rows[y][1]) && Number.isFinite(targetRows[y][1])) { sum += Math.abs(rows[y][1] - targetRows[y][1]); n++; }
    }
    assert.ok(n > 30, 'cobertura suficiente para medir');
    return sum / n;
  };
  const before = error(base), after = error(fitted);
  t.diagnostic(`error occipital normalizado: ${before.toFixed(5)} → ${after.toFixed(5)}`);
  assert.ok(after < before * 0.35, 'corrige al menos el 65 % del error de silueta posterior');
  assert.deepEqual(fitted.positions.subarray(0, face.positions.length), face.positions);
  assert.deepEqual(fitted.uvs.subarray(0, face.uvs.length), face.uvs);
  const baseBounds = bounds(base.positions, count, base.positions.length / 3);
  const fitBounds = bounds(fitted.positions, count, fitted.positions.length / 3);
  const widthRatio = (fitBounds[0][1] - fitBounds[0][0]) / (baseBounds[0][1] - baseBounds[0][0]);
  assert.ok(Math.abs(widthRatio - 1) < 0.02, `ancho frontal protegido: ${widthRatio}`);
  // Localizar aristas cara-cráneo sin asumir el tamaño del bucle.
  const seam = new Set();
  for (let i = face.indices.length; i < base.indices.length; i += 3) {
    const ids = Array.from(base.indices.subarray(i, i + 3));
    if (ids.some(id => id < count)) ids.filter(id => id >= count).forEach(id => seam.add(id));
  }
  assert.ok(seam.size > 20);
  for (const id of seam) assert.deepEqual(fitted.positions.subarray(id * 3, id * 3 + 3), base.positions.subarray(id * 3, id * 3 + 3), 'el ajuste craneal no desplaza la costura facial');
});