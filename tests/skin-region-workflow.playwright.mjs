/** Fixture exclusivamente sintética; usa el servidor existente, un navegador secuencial. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url)));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => /^http:\/\/127\.0\.0\.1:5173\/|^data:|^blob:/.test(route.request().url()) ? route.continue() : route.abort());
    await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ({ fixture, atlas }) => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
      const { buildPersonalSurface } = await import('/src/lab/faceSim/engine.ts');
      const code = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
      const THREE = await import(code.match(/import \* as THREE from "([^"]+)"/)[1]);
      const surface = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect, atlas.triangles);
      const photo = document.createElement('canvas'); photo.width = 512; photo.height = 512;
      const ctx = photo.getContext('2d'), image = ctx.createImageData(512, 512);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const variation = x > 115 && x < 205 && y > 230 && y < 345 ? (x % 5 < 2 ? -12 : 7) : 0;
        image.data.set([180 + variation, 135 + variation * 0.5, 110 + variation * 0.25, 255], (y * 512 + x) * 4);
      }
      ctx.putImageData(image, 0, 0);
      window.__skinQA = { surface, photo, points: {}, positions: [], maps: [] };
      const intersect = THREE.Raycaster.prototype.intersectObjects;
      THREE.Raycaster.prototype.intersectObjects = function (...args) {
        const result = intersect.apply(this, args);
        window.__skinQA.hits = result.slice(0, 6).map(h => ({
          name: h.object.name, uv: h.uv && [h.uv.x, h.uv.y], observed: h.object.userData.observed,
          source: h.object.userData.skinSource ? (h.object.userData.skinSource === window.__skinQA.photo ? 'front' : 'side') : null,
          distance: h.distance, alpha: h.face && h.object.geometry?.attributes.color
            ? [h.face.a, h.face.b, h.face.c].map(i => h.object.geometry.attributes.color.getW(i)) : null,
        }));
        return result;
      };
      const previous = THREE.Mesh.prototype.onAfterRender;
      THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
        if (renderer.domElement.closest('#skin-qa') && this.name === 'MORPHOLOGY_SKIN_AFTER') {
          const rect = renderer.domElement.getBoundingClientRect(), positions = this.geometry.attributes.position;
          window.__skinQA.positions = Array.from(positions.array);
          window.__skinQA.map = this.material[0].map?.image;
          window.__skinQA.points = Object.fromEntries(Array.from({ length: 468 }, (_, i) => i).map(id => {
            const p = new THREE.Vector3().fromBufferAttribute(positions, id).applyMatrix4(this.matrixWorld).project(camera);
            return [id, [(p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2]];
          }));
        }
        return previous?.apply(this, arguments);
      };
      document.getElementById('root').style.display = 'none';
      const host = document.createElement('div'); host.id = 'skin-qa'; host.style.cssText = 'width:100%;background:#0f172a;color:white';
      document.body.append(host);
      window.__skinQA.root = createRoot(host);
      window.__skinQA.root.render(React.createElement(FacialSimulationViewer, { surface, photo }));
    }, { fixture, atlas });
    const qa = page.locator('#skin-qa');
    await qa.getByRole('button', { name: 'Piel', exact: true }).click();
    await qa.getByRole('button', { name: 'Frontal', exact: true }).click();
    const editor = qa.getByRole('region', { name: 'Revisión visual manual por zonas' });
    await editor.waitFor();
    await qa.locator('canvas[aria-label]').first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => Object.keys(window.__skinQA.points).length > 0);
    const initialGeometry = await page.evaluate(() => window.__skinQA.positions);
    await editor.getByRole('button', { name: 'Pincel', exact: true }).click();
    await editor.getByRole('button', { name: 'Marcar sobre máscara', exact: true }).click();
    const canvas = qa.locator('canvas[aria-label]').first();
    // Buscar un punto seguro visible; cada intento debe confirmar ROI, no solo ausencia de excepción.
    let marked = false, chosenId;
    for (const id of [50, 101, 100, 205, 36]) {
      await canvas.scrollIntoViewIfNeeded();
      const rect = await canvas.boundingBox();
      const point = await page.evaluate(id => window.__skinQA.points[id], id);
      await page.mouse.click(rect.x + point[0], rect.y + point[1]);
      if (await editor.locator('select').count()) { marked = true; chosenId = id; break; }
    }
    assert.ok(marked, 'raycast visible debe crear ROI seguro');
    assert.ok(await canvas.getAttribute('data-skin-raycast-uv'), 'UV debe proceder del raycast real');
    await editor.locator('select').selectOption('Cicatriz');
    await editor.getByRole('button', { name: 'Analizar solo esta zona', exact: true }).click();
    await editor.getByRole('button', { name: 'Validar revisión manual', exact: true }).click();
    await editor.getByRole('button', { name: /Aplicar combinación educativa/ }).click();
    await page.waitForFunction(before => window.__skinQA.positions.some((value, i) => value !== before[i]), initialGeometry);
    const geometryAfter = await page.evaluate(() => window.__skinQA.positions);
    assert.notDeepEqual(geometryAfter, initialGeometry, 'relieve debe desplazar geometría real');
    await page.waitForFunction(() => window.__skinQA.map && window.__skinQA.map !== window.__skinQA.photo);
    const pixelEvidence = await page.evaluate(async baseline => {
      const { createSkinRegionMask } = await import('/src/lab/faceSim/skinRegionReview.ts');
      const { skinBrushPolygon } = await import('/src/lab/faceSim/skinDrawing.ts');
      const { createSkinSignalMask } = await import('/src/lab/faceSim/skinSignalTexture.ts');
      const { photo, map, surface, positions } = window.__skinQA;
      const uv = document.querySelector('#skin-qa canvas[data-skin-raycast-uv]').dataset.skinRaycastUv.split(',').map(Number);
      const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: surface.uvs[i * 2], y: surface.uvs[i * 2 + 1] }));
      const safe = createSkinSignalMask(512, 512, landmarks);
      const mask = createSkinRegionMask(512, 512, skinBrushPolygon([{ x: uv[0], y: uv[1] }]), safe);
      const before = photo.getContext('2d').getImageData(0, 0, 512, 512).data;
      const after = map.getContext('2d').getImageData(0, 0, 512, 512).data;
      let changed = 0, exterior = 0, alpha = 0;
      const variance = (pixels, color) => {
        const values = [...mask.keys()].filter(i => mask[i]).map(i => color
          ? pixels[i * 4] - pixels[i * 4 + 1] : pixels[i * 4] * 0.2126 + pixels[i * 4 + 1] * 0.7152 + pixels[i * 4 + 2] * 0.0722);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      };
      for (let i = 0; i < mask.length; i++) {
        if (after[i * 4 + 3] !== before[i * 4 + 3]) alpha++;
        for (let c = 0; c < 3; c++) if (before[i * 4 + c] !== after[i * 4 + c]) {
          if (!mask[i]) exterior++; else changed++;
        }
      }
      // La máscara de protección conserva geometría ocular y bucal canónica exactamente.
      const safeVertices = createSkinSignalMask(384, 384, landmarks);
      let protectedGeometryChanges = 0;
      for (let id = 0; id < 468; id++) {
        const p = landmarks[id];
        if (safeVertices[Math.min(383, Math.floor(p.y * 384)) * 384 + Math.min(383, Math.floor(p.x * 384))]) continue;
        for (let c = 0; c < 3; c++) if (positions[id * 3 + c] !== baseline[id * 3 + c]) protectedGeometryChanges++;
      }
      return { changed, exterior, alpha, protectedGeometryChanges,
        colorBefore: variance(before, true), colorAfter: variance(after, true),
        contrastBefore: variance(before, false), contrastAfter: variance(after, false) };
    }, initialGeometry);
    assert.ok(pixelEvidence.changed > 0, 'combinación cicatriz cambia RGB real');
    assert.equal(pixelEvidence.exterior, 0); assert.equal(pixelEvidence.alpha, 0);
    assert.equal(pixelEvidence.protectedGeometryChanges, 0);
    assert.ok(pixelEvidence.colorAfter < pixelEvidence.colorBefore, 'uniformiza color dentro de ROI');
    assert.ok(pixelEvidence.contrastAfter < pixelEvidence.contrastBefore, 'reduce contraste dentro de ROI');
    await editor.getByRole('button', { name: 'Ver antes', exact: true }).click();
    await page.waitForFunction(before => window.__skinQA.positions.every((value, i) => value === before[i]), initialGeometry);
    await editor.getByRole('button', { name: 'Ver después', exact: true }).click();
    await page.waitForFunction(after => window.__skinQA.positions.every((value, i) => value === after[i]), geometryAfter);
    await editor.getByRole('button', { name: 'Restablecer · imagen original', exact: true }).click();
    await page.waitForFunction(before => window.__skinQA.positions.every((value, i) => value === before[i]), initialGeometry);
    await page.waitForFunction(() => window.__skinQA.map === window.__skinQA.photo);
    const contourBefore = await editor.getByRole('application').locator('polygon').first().getAttribute('points');
    await editor.getByRole('button', { name: 'Trazado libre', exact: true }).click();
    await canvas.scrollIntoViewIfNeeded();
    const modelRect = await canvas.boundingBox(), center = await page.evaluate(id => window.__skinQA.points[id], chosenId);
    await page.mouse.move(modelRect.x + center[0] + 10, modelRect.y + center[1]);
    await page.mouse.down();
    for (let i = 1; i <= 16; i++) await page.mouse.move(modelRect.x + center[0] + Math.cos(i * Math.PI / 8) * 10,
      modelRect.y + center[1] + Math.sin(i * Math.PI / 8) * 10);
    await page.mouse.up();
    const contourAfter = await editor.getByRole('application').locator('polygon').first().getAttribute('points');
    assert.notEqual(contourAfter, contourBefore);
    assert.ok(contourAfter.trim().split(' ').length >= 10 && contourAfter.trim().split(' ').length <= 20,
      'contorno real UV sobre modelo, no un click simulado');
    await qa.getByRole('button', { name: 'Desplazar', exact: true }).click();
    assert.equal(await editor.getByRole('button', { name: 'Marcar sobre máscara', exact: true }).getAttribute('aria-pressed'), 'false');
    await qa.getByRole('button', { name: 'Girar', exact: true }).click();
    await editor.getByRole('button', { name: 'Pincel', exact: true }).click();
    // Modal real: foco, zoom, pan y dibujo comparten ROI; coordenadas mediante bounds transformados.
    await editor.getByRole('button', { name: 'Ampliar foto', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Foto ampliada/ });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: 'Acercar foto', exact: true }).click();
    await dialog.getByRole('button', { name: 'Mover foto', exact: true }).click();
    const svg = dialog.getByRole('application');
    let bounds = await svg.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 8, bounds.y + bounds.height / 2 + 8); await page.mouse.up();
    await dialog.getByRole('button', { name: 'Dibujar foto', exact: true }).click();
    bounds = await svg.boundingBox();
    const uv = await canvas.getAttribute('data-skin-raycast-uv');
    const [u, v] = uv.split(',').map(Number);
    await page.mouse.click(bounds.x + bounds.width * u, bounds.y + bounds.height * v);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await editor.getByRole('button', { name: 'Ampliar foto', exact: true }).evaluate(e => document.activeElement === e), true);
    await qa.getByRole('button', { name: 'Perfil lado A', exact: true }).click();
    await qa.getByText(/Esta vista no tiene correspondencia fotográfica/).waitFor();
    assert.equal(await qa.locator('select[aria-label^="Etiqueta"]').count(), 0, 'perfil sin foto no puede usar ROI frontal');
    // Fuente lateral REAL, UV de parche visible; no se simula la foto frontal en una cámara lateral.
    const lateralContext = await page.evaluate(async () => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
      const { buildEstimatedHead } = await import('/src/lab/faceSim/estimatedHead.ts');
      const { buildPhotoSurfacePatches } = await import('/src/lab/faceSim/multiViewHead.ts');
      const surface = buildEstimatedHead(window.__skinQA.surface);
      const y = (surface.positions[10 * 3 + 1] + surface.positions[152 * 3 + 1]) / 2;
      const height = Math.abs(surface.positions[10 * 3 + 1] - surface.positions[152 * 3 + 1]);
      const s = 0.75 / height, z = surface.positions[1 * 3 + 2] * 0.5;
      const texture = document.createElement('canvas'); texture.width = 512; texture.height = 512;
      const ctx = texture.getContext('2d'); ctx.fillStyle = '#bc927c'; ctx.fillRect(0, 0, 512, 512);
      const source = { label: 'Perfil A sintético · foto correspondiente', texture, width: 512, height: 512,
        mask: new Float32Array(512 * 512).fill(1),
        projection: { u: [0, 0, s, 0.5 - s * z], v: [0, -s, 0, 0.5 + s * y], towardCamera: [-1, 0, 0] } };
      const { cx, cy, k, aspect } = window.__skinQA.surface.projection;
      const front = { ...source, label: 'Frontal sintética', texture: window.__skinQA.photo,
        projection: { u: [1 / (k * aspect), 0, 0, cx / aspect], v: [0, -1 / k, 0, -cy], towardCamera: [0, 0, 1] } };
      const patches = buildPhotoSurfacePatches(surface, [front, source]);
      const sidePatch = patches.find(p => p.source === source);
      window.__skinQA.lateralTriangles = [];
      for (let i = 0; i < sidePatch.indices.length; i += 3) {
        const ids = Array.from(sidePatch.indices.slice(i, i + 3));
        if (ids.every(id => id < 468 && sidePatch.alpha[id] > 0.65)) window.__skinQA.lateralTriangles.push(ids);
      }
      window.__skinQA.root.render(React.createElement(FacialSimulationViewer, { surface, photo: window.__skinQA.photo, photoPatches: patches }));
      return { patches: patches.length, lateralObserved: patches.find(p => p.source === source)?.indices.length };
    });
    assert.ok(lateralContext.patches > 0);
    assert.ok(lateralContext.lateralObserved > 0, 'fixture lateral debe aportar triángulos ganadores reales');
    await editor.getByText('Fuente: Perfil A sintético · foto correspondiente', { exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Pincel', exact: true }).click();
    await editor.getByRole('button', { name: 'Marcar sobre máscara', exact: true }).click();
    const lateralCanvas = qa.locator('canvas[aria-label]').first();
    await lateralCanvas.scrollIntoViewIfNeeded();
    // Escaneo acotado de pantalla: raycast y máscara real deciden, nunca un mock de UV.
    let lateralMarked = false;
    const box = await lateralCanvas.boundingBox();
    const targets = await page.evaluate(() => window.__skinQA.lateralTriangles.map(ids => ids.reduce((p, id) =>
      [p[0] + window.__skinQA.points[id][0] / 3, p[1] + window.__skinQA.points[id][1] / 3], [0, 0])));
    for (const target of targets.slice(0, 120)) {
      await page.mouse.click(box.x + target[0], box.y + target[1]);
      if (await editor.locator('select').count()) { lateralMarked = true; break; }
    }
    if (!lateralMarked) console.log('LATERAL_DEBUG', JSON.stringify(await page.evaluate(() => ({
      hits: window.__skinQA.hits, status: document.querySelector('#skin-qa [aria-live="polite"]')?.textContent,
      points: Object.fromEntries([50, 101, 100, 205, 36].map(id => [id, window.__skinQA.points[id]])),
    }))));
    assert.ok(lateralMarked, 'debe marcar perfil mediante UV del parche lateral real');
    const lateralUv = await lateralCanvas.getAttribute('data-skin-raycast-uv');
    await editor.getByRole('button', { name: 'Ampliar foto', exact: true }).click();
    const lateralDialog = page.getByRole('dialog', { name: /Perfil A sintético/ });
    await lateralDialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await lateralDialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin overflow horizontal');
    console.log(JSON.stringify({ width, raycast: 'UV real', geometry: 'before/restaurar exactos',
      pixels: pixelEvidence, modal: 'zoom/pan/foco', profile: lateralUv, errors: errors.length }));
    await page.close();
  }
} finally { await browser.close(); }
