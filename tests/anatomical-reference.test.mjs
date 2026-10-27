import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANATOMICAL_ANCHOR_INDICES, MAX_REFERENCE_BYTES,
  applyAffineTransform, fitAffineTransform, fitAnatomicalUVs,
  loadAnatomicalImage, validateAnatomicalFile,
} from '../src/lab/faceSim/anatomicalReference.ts';

const source = [{ x: 0.25, y: 0.3 }, { x: 0.75, y: 0.3 }, { x: 0.5, y: 0.8 }];
const surface = () => {
  const uvs = new Float32Array(478 * 2).fill(0.5);
  ANATOMICAL_ANCHOR_INDICES.forEach((id, i) => uvs.set([source[i].x, source[i].y], id * 2));
  return uvs;
};
const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);

test('ajuste afín exacto: identidad, traslación, escala, giro, cizalla y reflexión', () => {
  for (const known of [
    [1, 0, 0, 0, 1, 0], [1, 0, 0.1, 0, 1, -0.1],
    [0.8, 0, 0.1, 0, 1.2, -0.1], [0, -1, 1, 1, 0, 0],
    [0.8, 0.1, 0.05, 0.1, 0.8, 0.03], [-1, 0, 1, 0, 1, 0],
  ]) {
    const target = source.map(p => applyAffineTransform(known, p));
    const transform = fitAffineTransform(source, target);
    transform.forEach((v, i) => near(v, known[i], 1e-12));
    for (const p of [...source, { x: 0.12, y: 0.67 }, { x: -0.5, y: 1.2 }]) {
      const actual = applyAffineTransform(transform, p), expected = applyAffineTransform(known, p);
      near(actual.x, expected.x, 1e-12);
      near(actual.y, expected.y, 1e-12);
    }
  }
});

test('registro foto→referencia conserva orden, longitud, origen superior y arrays originales', () => {
  const uvs = surface(), before = uvs.slice();
  const anchors = [{ x: 0.15, y: 0.2 }, { x: 0.8, y: 0.25 }, { x: 0.48, y: 0.9 }];
  const original = structuredClone(anchors);
  const fitted = fitAnatomicalUVs(uvs, anchors);
  assert.equal(fitted.length, uvs.length);
  assert.notEqual(fitted, uvs);
  ANATOMICAL_ANCHOR_INDICES.forEach((id, i) => {
    near(fitted[id * 2], anchors[i].x);
    near(fitted[id * 2 + 1], anchors[i].y);
  });
  assert.deepEqual(uvs, before);
  assert.deepEqual(anchors, original);
});

test('no satura ni recorta UV fuera de la referencia ni cambia el eje vertical', () => {
  const uvs = surface();
  uvs.set([0, 0], 0);
  const fitted = fitAnatomicalUVs(uvs, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }]);
  near(fitted[0], -0.5);
  near(fitted[1], -0.6);
});

test('rechaza triángulos repetidos, colineales y casi colineales en origen Y destino', () => {
  for (const bad of [
    [source[0], source[0], source[2]],
    [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 1e-7 }],
    [{ x: 0, y: 0 }, { x: 1e-8, y: 0 }, { x: 0, y: 1e-8 }],
  ]) {
    assert.throws(() => fitAffineTransform(bad, source), /degenerados/);
    assert.throws(() => fitAffineTransform(source, bad), /degenerados/);
  }
  const badUVs = surface();
  badUVs.set(badUVs.slice(66, 68), 526);
  assert.throws(() => fitAnatomicalUVs(badUVs, source), /degenerados/);
});

test('rechaza UV truncados, impares, no finitos o fuera del dominio y anclajes inválidos', () => {
  for (const uvs of [new Float32Array(526), new Float32Array(529), ...[NaN, Infinity, -0.1, 1.1].map(n => {
    const a = surface(); a[0] = n; return a;
  })]) assert.throws(() => fitAnatomicalUVs(uvs, source), /UV de paciente inválidos/);
  for (const n of [NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => fitAnatomicalUVs(surface(), [{ x: n, y: 0.1 }, ...source.slice(1)]), /dentro de la imagen/);
  }
  assert.throws(() => fitAffineTransform([{ x: NaN, y: 0 }, ...source.slice(1)], source), /finitas/);
});

test('validación por MIME y bytes, sin confiar en extensión; acepta el límite exacto', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.doesNotThrow(() => validateAnatomicalFile({ type, size: MAX_REFERENCE_BYTES }));
  }
  for (const type of ['', 'image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream']) {
    assert.throws(() => validateAnatomicalFile({ type, size: 100 }), /Formato no admitido/);
  }
  for (const size of [0, -1, NaN, Infinity, MAX_REFERENCE_BYTES + 1]) {
    assert.throws(() => validateAnatomicalFile({ type: 'image/png', size }), /10 MB/);
  }
});

function browser(t, { width = 800, height = 1000, context = true } = {}) {
  const images = [], canvases = [], revoked = [], draws = [];
  const originalImage = globalThis.Image, originalDocument = globalThis.document;
  globalThis.Image = class {
    naturalWidth = width;
    naturalHeight = height;
    constructor() { images.push(this); }
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0, height: 0,
        getContext: () => context ? { drawImage: (...args) => draws.push(args) } : null,
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  t.mock.method(URL, 'createObjectURL', () => 'blob:local-reference');
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.after(() => {
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  });
  return { images, canvases, revoked, draws };
}
const file = { type: 'image/png', size: 1024 };

test('carga local dibuja imagen COMPLETA sin recorte y revoca URL al terminar', async t => {
  const b = browser(t), controller = new AbortController();
  const pending = loadAnatomicalImage(file, controller.signal);
  assert.equal(b.images[0].src, 'blob:local-reference');
  b.images[0].onload();
  const canvas = await pending;
  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 1000);
  assert.deepEqual(b.draws[0], [b.images[0], 0, 0], 'sin crop, flip ni filtros');
  assert.deepEqual(b.revoked, ['blob:local-reference']);
  assert.equal(b.images[0].onload, null);
  assert.equal(b.images[0].onerror, null);
  assert.equal(b.images[0].src, '');
});

test('cancelación durante carga suelta eventos y URL e ignora resolución tardía', async t => {
  const b = browser(t), controller = new AbortController();
  const pending = loadAnatomicalImage(file, controller.signal);
  const lateLoad = b.images[0].onload;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  lateLoad();
  assert.equal(b.canvases.length, 0);
  assert.deepEqual(b.revoked, ['blob:local-reference']);
  assert.equal(b.images[0].onload, null);
});

test('cancelación después de decodificar pero antes de dibujar no crea lienzo', async t => {
  const b = browser(t), controller = new AbortController();
  const pending = loadAnatomicalImage(file, controller.signal);
  b.images[0].onload();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(b.canvases.length, 0);
  assert.equal(b.revoked.length, 1);
});

test('cancelación previa y MIME inválido no crean URL ni decodificador', async t => {
  const b = browser(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(loadAnatomicalImage(file, controller.signal), { name: 'AbortError' });
  await assert.rejects(loadAnatomicalImage({ ...file, type: 'image/svg+xml' }, new AbortController().signal), /Formato/);
  assert.equal(b.images.length, 0);
  assert.equal(b.revoked.length, 0);
});

test('error de decodificación es explícito y revoca URL', async t => {
  const b = browser(t);
  const pending = loadAnatomicalImage(file, new AbortController().signal);
  b.images[0].onerror();
  await assert.rejects(pending, /decodificar/);
  assert.equal(b.revoked.length, 1);
});

for (const [width, height] of [[1, 10], [8193, 10], [4096, 4096]]) {
  test(`rechaza dimensiones ${width} × ${height} antes de crear canvas`, async t => {
    const b = browser(t, { width, height });
    const pending = loadAnatomicalImage(file, new AbortController().signal);
    b.images[0].onload();
    await assert.rejects(pending, /Dimensiones no admitidas/);
    assert.equal(b.canvases.length, 0);
    assert.equal(b.revoked.length, 1);
  });
}

test('fallo de contexto libera el canvas y URL', async t => {
  const b = browser(t, { context: false });
  const pending = loadAnatomicalImage(file, new AbortController().signal);
  b.images[0].onload();
  await assert.rejects(pending, /lienzo local/);
  assert.equal(b.canvases[0].width, 0);
  assert.equal(b.canvases[0].height, 0);
  assert.equal(b.revoked.length, 1);
});
