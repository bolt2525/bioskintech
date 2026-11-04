/**
 * QA local con fixture sintética. NO inicia/detiene el servidor ni usa APIs.
 * Ejecutar solo con turno pesado concedido:
 * FACE_SIM_HEAVY_QA=1 PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-nov4-session.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

if (process.env.FACE_SIM_HEAVY_QA !== '1') throw new Error('Solicita el turno pesado antes de activar FACE_SIM_HEAVY_QA=1.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => /^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(route.request().url())
    ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ fixture, atlas }) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
    const { buildPersonalSurface } = await import('/src/lab/faceSim/engine.ts');
    const { createSimulationMesh, nasalProfileExcess, personalFaceFrame, fromCanonicalPosition } = await import('/src/lab/faceSim/simulation.ts');
    const viewerCode = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
    const THREE = await import(viewerCode.match(/import \* as THREE from "([^"]+)"/)[1]);
    let surface = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect, atlas.triangles);
    if (!surface) throw new Error('Fixture sintética no válida.');
    const qa = window.__nov4 = { points: {}, buffers: new Set(), before6: null, expectedBefore6: null };
    const afterRender = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
      if (renderer.domElement.closest('#nov4-qa')) {
        const attribute = this.geometry.attributes.position;
        if (this.name === 'MORPHOLOGY_SKIN_AFTER') {
          qa.buffers.add(attribute.array);
          qa.afterArray = Float32Array.from(attribute.array);
          const rect = renderer.domElement.getBoundingClientRect();
          qa.points = Object.fromEntries([1, 6, 13, 14, 33, 263].map(id => {
            const v = new THREE.Vector3().fromBufferAttribute(attribute, id).applyMatrix4(this.matrixWorld).project(camera);
            return [id, [v.x * rect.width / 2, v.y * rect.height / 2]];
          }));
        }
        if (this.name === 'MORPHOLOGY_SKIN_BEFORE') qa.before6 = Array.from(attribute.array.slice(18, 21));
      }
      afterRender.call(this, renderer, scene, camera);
    };
    const host = document.createElement('main'); host.id = 'nov4-qa';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const render = () => root.render(React.createElement(FacialSimulationViewer, { surface }));
    qa.changeBase = () => {
      surface = { ...surface, positions: surface.positions.slice() };
      surface.positions[20] -= .015; // nuevo relieve calibrado, exclusivamente sintético
      qa.expectedBefore6 = Array.from(createSimulationMesh(surface).positions.slice(18, 21));
      render();
    };
    // Giba central sintética y conocida (E·h sobre la cuerda 9→5), construida en el
    // frame canónico y devuelta al chart propio. No toca las anclas del frame.
    qa.humpBase = elevation => {
      const mesh = createSimulationMesh(surface), frame = personalFaceFrame(surface);
      const p = mesh.positions, h = Math.hypot(p[30] - p[456], p[31] - p[457], p[32] - p[458]);
      const axis = (p[30] + p[456] + p[3]) / 3, y5 = p[16], y9 = p[28], cy = (p[19] + p[592]) / 2;
      const frameIds = new Set([33, 263, 10, 152, 454, 234]);
      const bump = amplitude => {
        const out = Float32Array.from(p);
        for (let i = 0; i < out.length / 3; i++) {
          const t = (out[i * 3 + 1] - y5) / (y9 - y5);
          if (frameIds.has(i) || t <= 0 || t >= 1) continue;
          const dx = (out[i * 3] - axis) / (h * .10), dy = (out[i * 3 + 1] - cy) / (h * .07);
          out[i * 3 + 2] += amplitude * Math.exp(-(dx * dx + dy * dy) / 2) * Math.sin(Math.PI * t) ** 2;
        }
        return out;
      };
      let low = 0, high = h * .5;
      for (let step = 0; step < 40; step++) {
        const middle = (low + high) / 2;
        if (nasalProfileExcess(bump(middle), p) < elevation) low = middle; else high = middle;
      }
      const canonical = bump(high), positions = surface.positions.slice();
      for (let i = 0; i < positions.length / 3; i++) {
        const back = fromCanonicalPosition({ x: canonical[i * 3], y: canonical[i * 3 + 1], z: canonical[i * 3 + 2] }, frame);
        positions.set([back.x, back.y, back.z], i * 3);
      }
      surface = { ...surface, positions };
      render();
    };
    qa.profileExcess = (positions, anchorsSource) => nasalProfileExcess(positions, anchorsSource.slice(0, 468 * 3));
    render();
  }, { fixture, atlas });
  const editor = page.locator('#nov4-qa [data-face-editor]');
  const button = name => editor.getByRole('button', { name, exact: true });
  const slider = key => editor.locator(`input[id$="-${key}"]`);
  const ready = () => editor.locator('[data-simulation-viewport][data-ready="true"]').waitFor();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const value = key => slider(key).inputValue();
  const metrics = [];
  await ready();
  await button('Frontal').click(); await settle();
  const neutral = await page.evaluate(() => window.__nov4.points);

  // Arrastre real con muchos pointermove: undo único, no una entrada por frame.
  const radix = slider('noseRadix');
  await radix.scrollIntoViewIfNeeded();
  const box = await radix.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  assert.ok(Number(await value('noseRadix')) < -.8);
  await button('Deshacer morfología').click();
  assert.equal(Number(await value('noseRadix')), 0);
  assert.equal(await button('Deshacer morfología').isDisabled(), true);
  await button('Rehacer morfología').click();
  assert.ok(Number(await value('noseRadix')) < -.8);
  await button('Deshacer morfología').click();

  // Repetición de teclas: una entrada hasta keyup.
  await slider('noseRotation').focus();
  await page.keyboard.down('ArrowRight');
  for (let i = 0; i < 9; i++) await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  const rotation = Number(await value('noseRotation'));
  assert.ok(rotation > 0);
  await button('Deshacer morfología').focus();
  await page.keyboard.press('Control+z');
  assert.equal(Number(await value('noseRotation')), 0);
  await button('Rehacer morfología').focus();
  await page.keyboard.press('Control+Shift+z');
  assert.equal(Number(await value('noseRotation')), rotation);
  await slider('noseRotation').press('End'); await settle();
  const front = await page.evaluate(() => window.__nov4.points);
  assert.ok(Math.abs(front[1][1] - neutral[1][1]) > 5);
  for (const id of [13, 14, 33, 263]) assert.deepEqual(front[id], neutral[id], `abertura frontal ${id}`);
  metrics.push(`rotación frontal=${Math.abs(front[1][1] - neutral[1][1]).toFixed(2)}px`);
  await button('Perfil lado A').click(); await settle();
  const rotatedProfile = await page.evaluate(() => window.__nov4.points);
  await button('Restaurar nariz').click(); await settle();
  const neutralProfile = await page.evaluate(() => window.__nov4.points);
  const profilePx = Math.hypot(...rotatedProfile[1].map((v, i) => v - neutralProfile[1][i]));
  assert.ok(profilePx > 5);
  metrics.push(`rotación perfil=${profilePx.toFixed(2)}px`);

  // Variantes: aplicar usa el comparador existente contra original.
  await editor.getByText(/^Variantes de esta sesión/).click();
  await editor.getByLabel('Nombre de variante').fill('Neutra sintética');
  await button('Guardar variante').click();
  await slider('noseBridge').press('Home');
  await button('Aplicar y comparar con original').click();
  assert.equal(Number(await value('noseBridge')), 0);
  assert.equal(await button('Comparar 3D').getAttribute('aria-pressed'), 'true');
  await button('Deshacer morfología').click();
  assert.equal(Number(await value('noseBridge')), -1);
  // Atajo en input de texto no consume el undo morfológico.
  await editor.getByLabel('Nombre de variante').fill('Texto editable');
  await page.keyboard.press('Control+z');
  assert.equal(Number(await value('noseBridge')), -1);
  await button('Eliminar variante').click();
  assert.equal(await editor.getByLabel('Variante guardada').count(), 0);
  await button('Deshacer morfología').click();
  assert.equal(await editor.getByLabel('Variante guardada').count(), 1);
  assert.equal(await page.evaluate(() => window.__nov4.buffers.size), 1, 'gestos, variantes y undo reutilizan el buffer GPU');

  // Base nueva: no reaparecen estados/variantes viejos, Antes usa esa base.
  await page.evaluate(() => window.__nov4.changeBase());
  await editor.getByRole('status').filter({ hasText: 'La base o la foto fuente cambió' }).waitFor();
  await ready(); await button('Comparar 3D').click(); await settle();
  assert.equal(Number(await value('noseBridge')), 0);
  assert.equal(await button('Deshacer morfología').isDisabled(), true);
  assert.equal(await button('Rehacer morfología').isDisabled(), true);
  assert.equal(await editor.getByLabel('Variante guardada').count(), 0);
  const base = await page.evaluate(() => ({ actual: window.__nov4.before6, expected: window.__nov4.expectedBefore6 }));
  assert.deepEqual(base.actual, base.expected);

  // Dorso · alinear perfil: giba sintética conocida (2 % de altura facial) medida en
  // la malla REALMENTE dibujada; 100 % debe dejar ≤10 % o mostrar el aviso de protección.
  await page.evaluate(() => window.__nov4.humpBase(.02));
  await editor.getByRole('status').filter({ hasText: 'La base o la foto fuente cambió' }).waitFor();
  await ready(); await button('Después').click(); await button('Perfil lado A').click(); await settle();
  await editor.locator('[id$="-noseProfileAlign-hint"]').filter({ hasText: 'Relieve de la base sobre la línea' }).waitFor(); await settle();
  assert.match(await editor.locator('[id$="-noseProfileAlign-hint"]').innerText(), /Relieve de la base sobre la línea: \d/);
  const humpProfile = await page.evaluate(() => ({ array: Array.from(window.__nov4.afterArray), points: window.__nov4.points }));
  await slider('noseProfileAlign').focus(); await slider('noseProfileAlign').press('End'); await settle();
  assert.equal(Number(await value('noseProfileAlign')), 1);
  const aligned = await page.evaluate(base => {
    const before = Float32Array.from(base), after = window.__nov4.afterArray;
    let xy = 0;
    for (let i = 0; i < before.length; i += 3) xy = Math.max(xy, Math.abs(after[i] - before[i]), Math.abs(after[i + 1] - before[i + 1]));
    return { before: window.__nov4.profileExcess(before, before), after: window.__nov4.profileExcess(after, before), xy, length: after.length === before.length, points: window.__nov4.points };
  }, humpProfile.array);
  const residual = aligned.after / aligned.before;
  const protectedNotice = await editor.locator('[data-morphology-protection]').count();
  assert.ok(aligned.length && aligned.xy < 1e-6, `XY/UV del perfil movidos: ${aligned.xy}`);
  assert.ok(aligned.before > .015, `giba sintética no visible: ${aligned.before}`);
  assert.ok(residual <= .10 || protectedNotice > 0, `residual ${residual} sin aviso de protección`);
  const dorsumPx = Math.hypot(...aligned.points[6].map((v, i) => v - humpProfile.points[6][i]));
  for (const id of [13, 14, 33, 263]) assert.deepEqual(aligned.points[id], humpProfile.points[id], `abertura perfil ${id}`);
  metrics.push(`alinear perfil: relieve ${(100 * aligned.before).toFixed(2)}%h→residual ${(100 * residual).toFixed(1)}%, dorso 6 ${dorsumPx.toFixed(1)}px, aviso ${protectedNotice}`);
  await button('Restaurar nariz').click();
  assert.equal(Number(await value('noseProfileAlign')), 0);
  await button('Deshacer morfología').click();
  assert.equal(Number(await value('noseProfileAlign')), 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await button('Después').click(); await button('Frontal').click(); await settle();
  assert.equal(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'sin desborde horizontal móvil');
  await slider('noseRadix').press('Home'); await button('Restablecer nariz').click();
  await button('Deshacer morfología').click();
  assert.equal(Number(await value('noseRadix')), -1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'ok', viewport: ['1440×1000', '390×844'], metrics, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
