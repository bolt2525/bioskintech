/**
 * QA NUEVA del viewer real, cámara neutra 1440px, fotos/landmarks exclusivamente
 * sintéticos. Servidor existente 127.0.0.1:5173; no inicia ni detiene servicios.
 * PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-expanded-range.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
// PNG de Chromium: desfiltrar RGBA con zlib nativo, sin dependencias ni red.
function pixelsOf(png) {
  let width, height, channels;
  const chunks = [];
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i), type = png.toString('ascii', i + 4, i + 8), data = png.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; assert.equal(data[8], 8); }
    if (type === 'IDAT') chunks.push(data);
    i += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
      out[y * stride + x] = raw[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth][filter];
    }
  }
  return { pixels: out, channels, width, height };
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => /^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(route.request().url())
    ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ fixture, atlas }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
    const { buildPersonalSurface } = await import('/src/lab/faceSim/engine.ts');
    const { buildEstimatedHead } = await import('/src/lab/faceSim/estimatedHead.ts');
    const { buildPhotoSurfacePatches } = await import('/src/lab/faceSim/multiViewHead.ts');
    const viewerCode = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
    const THREE = await import(viewerCode.match(/import \* as THREE from "([^"]+)"/)[1]);
    const face = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect, atlas.triangles);
    const surface = buildEstimatedHead(face);
    const lips = new Set([0, 13, 14, 17, 37, 39, 40, 61, 78, 80, 81, 82, 84, 87, 88, 91, 95,
      146, 178, 181, 185, 191, 267, 269, 270, 291, 308, 310, 311, 312, 314,
      317, 318, 321, 324, 375, 402, 405, 409, 415, 11, 12, 15, 16, 38, 41, 42,
      62, 72, 73, 74, 76, 77, 85, 86, 89, 90, 96, 180, 183, 184, 268, 271, 272,
      292, 302, 303, 304, 306, 307, 315, 316, 319, 320, 325, 403, 404, 407, 408]);
    const { cx, cy, k, aspect } = face.projection;
    const centerY = (surface.positions[10 * 3 + 1] + surface.positions[152 * 3 + 1]) / 2;
    const height = Math.abs(surface.positions[10 * 3 + 1] - surface.positions[152 * 3 + 1]);
    const s = .75 / height;
    const centerZ = surface.positions[1 * 3 + 2] * .5;
    const projections = [
      { u: [1 / (k * aspect), 0, 0, cx / aspect], v: [0, -1 / k, 0, -cy], towardCamera: [0, 0, 1] },
      ...[-1, 1].map(side => ({ u: [0, 0, -side * s, .5 + side * s * centerZ],
        v: [0, -s, 0, .5 + s * centerY], towardCamera: [side, 0, 0] })),
    ];
    const sources = projections.map((projection, order) => {
      const texture = document.createElement('canvas'); texture.width = 512; texture.height = 512;
      const ctx = texture.getContext('2d'); ctx.fillStyle = '#b8987c'; ctx.fillRect(0, 0, 512, 512);
      const project = (id, row) => [0, 1, 2].reduce((sum, a) => sum + surface.positions[id * 3 + a] * row[a], row[3]) * 512;
      const triangles = Array.from({ length: face.indices.length / 3 }, (_, i) => Array.from(face.indices.slice(i * 3, i * 3 + 3)));
      triangles.sort((a, b) => {
        const depth = ids => ids.reduce((sum, id) => sum + projection.towardCamera.reduce((d, v, j) => d + v * surface.positions[id * 3 + j], 0), 0);
        return depth(a) - depth(b);
      });
      for (const ids of triangles) {
        ctx.beginPath(); ids.forEach((id, i) => ctx[i ? 'lineTo' : 'moveTo'](project(id, projection.u), project(id, projection.v)));
        ctx.closePath(); ctx.fillStyle = ids.every(id => lips.has(id)) ? '#b92c4c' : order ? '#caa08a' : '#d5ae90'; ctx.fill();
      }
      return { label: ['Frontal sintética', 'Perfil A sintético', 'Perfil B sintético'][order],
        width: 512, height: 512, mask: new Float32Array(512 * 512).fill(1), texture, projection };
    });
    const patches = buildPhotoSurfacePatches(surface, sources);
    if (patches.length < 2) throw new Error('No se han construido parches multivista reales.');
    window.__range = { patches: new Set(), points: {} };
    const afterRender = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
      if (renderer.domElement.closest('#range-qa') && this.name === 'MORPHOLOGY_SKIN_AFTER') {
        const rect = renderer.domElement.getBoundingClientRect();
        const positions = this.geometry.attributes.position;
        window.__range.points = Object.fromEntries([0, 13, 14, 17, 1, 4, 168, 197, 152, 61, 291].map(id => {
          const p = new THREE.Vector3().fromBufferAttribute(positions, id).applyMatrix4(this.matrixWorld).project(camera);
          return [id, [(p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2]];
        }));
      }
      if (renderer.domElement.closest('#range-qa') && this.name === 'MULTIVIEW_PHOTO_SURFACE') window.__range.patches.add(this.material.map.uuid);
      return afterRender?.apply(this, arguments);
    };
    document.getElementById('root').style.display = 'none';
    const host = document.createElement('div'); host.id = 'range-qa';
    host.style.cssText = 'width:1440px;height:960px;color:white;background:#0f172a';
    document.body.append(host);
    createRoot(host).render(React.createElement(FacialSimulationViewer, { surface, photo: sources[0].texture, photoPatches: patches }));
  }, { fixture, atlas });
  const qa = page.locator('#range-qa');
  await qa.locator('[data-simulation-viewport][data-ready="true"]').waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const click = async name => { await qa.getByRole('button', { name, exact: true }).click(); await settle(); };
  const set = async (key, value) => {
    const group = key.startsWith('lip') ? 'Labios' : key.startsWith('nose') ? 'Nariz'
      : key.startsWith('chin') || key === 'jawWidth' ? 'Mentón y mandíbula' : 'Pómulos y mejillas';
    await click('Morfología');
    await click(group);
    const input = qa.locator(`input[id$="-${key}"]`);
    await input.waitFor({ state: 'visible' });
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    await input.click({ position: { x: 8 + (box.width - 16) * (value + 1) / 2, y: box.height / 2 } });
    for (let i = 0; i < 10; i++) {
      const current = Number(await input.inputValue());
      if (Math.abs(current - value) < .005) break;
      await input.press(current < value ? 'ArrowRight' : 'ArrowLeft');
    }
    assert.ok(Math.abs(Number(await input.inputValue()) - value) < .005, `${key} no refleja la intensidad solicitada.`);
    await settle();
  };
  const frame = async () => {
    const screenshot = await page.screenshot({ clip: await qa.locator('canvas').boundingBox(), timeout: 60000 });
    return { ...pixelsOf(screenshot),
      ...await page.evaluate(() => ({ points: window.__range.points, patches: window.__range.patches.size })) };
  };
  const changedPixels = (a, b) => {
    const before = a.pixels, after = b.pixels;
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    let count = 0;
    for (let i = 0; i < before.length; i += a.channels) {
      if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1])
        + Math.abs(before[i + 2] - after[i + 2]) > 40) count++;
    }
    return count;
  };
  const vermilionSpan = frame => {
    const x = frame.points[13][0], y = frame.points[13][1], rows = [];
    for (let row = Math.max(0, Math.floor(y - 40)); row < Math.min(frame.height, y + 45); row++) {
      for (let col = Math.floor(x - 5); col <= x + 5; col++) {
        const i = (row * frame.width + col) * frame.channels, [r, g, b] = frame.pixels.slice(i, i + 3);
        if (r > g * 1.45 && r > b * 1.25 && r > 70) { rows.push(row); break; }
      }
    }
    assert.ok(rows.length > 3, 'Bermellón sintético rojo realmente visible en la foto multivista.');
    return rows.at(-1) - rows[0] + 1;
  };
  await click('Frontal'); await click('Después'); await click('Labios');
  const neutral = await frame();
  for (const progress of [.5, 1]) {
    for (const key of ['lipUpper', 'lipLower', 'lipProjection']) await set(key, progress);
    const current = await frame();
    const upperBefore = neutral.points[13][1] - neutral.points[0][1];
    const lowerBefore = neutral.points[17][1] - neutral.points[14][1];
    const upper = current.points[13][1] - current.points[0][1];
    const lower = current.points[17][1] - current.points[14][1];
    const pixels = await changedPixels(neutral, current);
    results.push({ case: `Labios frontal ${progress}`, upperPct: (upper / upperBefore - 1) * 100,
      lowerPct: (lower / lowerBefore - 1) * 100, upperCSSpx: upper - upperBefore, lowerCSSpx: lower - lowerBefore, changedPixels: pixels });
    await qa.locator('canvas').screenshot({ path: join(tmpdir(), `bioskin-range-lips-frontal-${progress}.png`) });
    console.log(JSON.stringify(results.at(-1)));
    assert.ok(pixels > 100, `La foto visible debe cambiar, no solamente sus buffers: ${JSON.stringify(results.at(-1))}`);
    if (progress === 1) {
      assert.ok(upper >= upperBefore * 1.2 && lower >= lowerBefore * 1.2, JSON.stringify(results.at(-1)));
      assert.ok(upper - upperBefore >= 3 && lower - lowerBefore >= 3, JSON.stringify(results.at(-1)));
      assert.ok(current.patches >= 2, 'Parche frontal y perfiles deben llegar al render.');
      const before = vermilionSpan(neutral), after = vermilionSpan(current);
      results.push({ case: 'Máscara bermellón visible frontal 100%', beforeCSSpx: before, afterCSSpx: after });
      assert.ok(after >= before * 1.2 && after - before >= 6, JSON.stringify(results.at(-1)));
    }
  }
  await qa.locator('canvas').screenshot({ path: join(tmpdir(), 'bioskin-range-lips-frontal.png') });
  await click('Perfil lado A');
  const lipsAfter = await frame();
  for (const key of ['lipUpper', 'lipLower', 'lipProjection']) await set(key, 0);
  const lipsBefore = await frame();
  const lipProfile = Math.abs(lipsAfter.points[13][0] - lipsBefore.points[13][0]);
  results.push({ case: 'Labios perfil', CSSpx: lipProfile, changedPixels: await changedPixels(lipsBefore, lipsAfter) });
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(lipProfile >= 3, JSON.stringify(results.at(-1)));
  await click('Nariz');
  const noseBefore = await frame();
  for (const [key, value] of Object.entries({ noseRadix: -1, noseBridge: -.7, noseHump: -1, noseTip: -.14,
    noseRotation: 1, noseTipWidth: .58, noseWidth: -.25 })) await set(key, value);
  const noseAfter = await frame();
  const nosePx = Math.hypot(...noseAfter.points[1].map((v, i) => v - noseBefore.points[1][i]));
  results.push({ case: 'Nariz perfil combinación reportada', CSSpx: nosePx, changedPixels: await changedPixels(noseBefore, noseAfter) });
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(nosePx >= 3 && results.at(-1).changedPixels > 100, JSON.stringify(results.at(-1)));
  await qa.locator('canvas').screenshot({ path: join(tmpdir(), 'bioskin-range-nose-profile.png') });
  await click('Restablecer nariz'); await click('Mentón y mandíbula');
  const chinBefore = await frame();
  for (const key of ['chinProjection', 'chinHeight', 'chinWidth', 'jawWidth']) await set(key, -1);
  const chinAfter = await frame();
  const chinPx = Math.hypot(...chinAfter.points[152].map((v, i) => v - chinBefore.points[152][i]));
  results.push({ case: 'Mentón perfil todos −1', CSSpx: chinPx, changedPixels: await changedPixels(chinBefore, chinAfter) });
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(chinPx >= 3 && results.at(-1).changedPixels > 100, JSON.stringify(results.at(-1)));
  await qa.locator('canvas').screenshot({ path: join(tmpdir(), 'bioskin-range-chin-profile.png') });
  await click('Restablecer mentón y mandíbula'); await click('Frontal');
  const restored = await frame();
  assert.deepEqual(restored.points, neutral.points, 'Cero restaura exactamente posiciones en cámara neutra.');
  assert.equal(await changedPixels(restored, neutral), 0, 'Restauración también de píxeles multivista.');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, screenshots: tmpdir() }, null, 2));
} finally {
  await browser.close();
}
