/**
 * UI/React/WebGL reales con imágenes procedurales y geometría sintética existente.
 * Se aísla SOLO detectFrame: no acredita detección MediaPipe ni identidad.
 * PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-captures-comparison.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const evidence = [];
const cameraFailures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(url)) return route.abort();
    if (!url.includes('/src/lab/faceSim/FaceSimLab.tsx')) return route.continue();
    const response = await route.fetch(), source = await response.text();
    const pattern = /async function detectFrame\([^]*?\n\}/;
    assert.match(source, pattern);
    const detector = `async function detectFrame(img) {
      const marker = img.getContext("2d").getImageData(0,0,1,1).data[0];
      if (marker === 4) return { frame:null, reason:"Sin detector fiable en captura sintética." };
      const angle = (marker === 2 ? -45 : marker === 3 ? 45 : 0) * Math.PI / 180;
      const landmarks = ${JSON.stringify(fixture.landmarks)}.map(([x,y,z]) => ({
        x:0.5+(x-0.5)*Math.cos(angle)+z*Math.sin(angle), y,
        z:-(x-0.5)*Math.sin(angle)+z*Math.cos(angle)
      }));
      return { frame:frameFromLandmarks(landmarks), landmarks, detectedLandmarks:landmarks,
        regionMap:buildFaceRegionMap(landmarks,${JSON.stringify(atlas.triangles)},img.width/img.height,genericFaceAtlas.positions),
        contourAdjusted:0, reason:"", captureWarnings:[] };
    }`;
    return route.fulfill({ response, body: source.replace(pattern, detector) });
  });
  await page.goto(`${origin}/dev/hair-lab`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  // Observa cámaras entregadas al render real, sin sustituir OrbitControls ni el contrato.
  await page.evaluate(async () => {
    const source = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const onAfterRender = THREE.Mesh.prototype.onAfterRender;
    window.__comparisonCameras = [];
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
      const comparison = renderer.domElement.closest('[aria-label="Comparación Antes y Después"], [aria-label="Comparación con deslizador"]');
      if (comparison) {
        const index = [...comparison.querySelectorAll('canvas')].indexOf(renderer.domElement);
        if (index >= 0) window.__comparisonCameras[index] = {
          world: Array.from(camera.matrixWorld.elements),
          projection: Array.from(camera.projectionMatrix.elements),
        };
      }
      return onAfterRender?.apply(this, arguments);
    };
  });
  const payloads = await page.evaluate(({ top, chin }) => {
    return [1, 2, 3, 4].map(marker => {
      const c = document.createElement('canvas'); c.width = 500; c.height = 600;
      const ctx = c.getContext('2d'), image = ctx.createImageData(c.width, c.height);
      const cutoff = Math.round((top - (chin - top) * 0.1) * c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const noise = (x * 7 + y * 13) % 9;
        image.data.set(y < cutoff ? [215 + noise, 185 + noise, 95, 255]
          : [190 + noise, 145 + noise, 130 + noise, 255], (y * c.width + x) * 4);
      }
      image.data.set([marker, 0, 0, 255], 0);
      ctx.putImageData(image, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    });
  }, { top: fixture.landmarks[10][1], chin: fixture.landmarks[152][1] });
  const file = (index, name) => ({ name, mimeType: 'image/png', buffer: Buffer.from(payloads[index], 'base64') });
  const multi = page.getByLabel('Seleccionar hasta 3 fotos', { exact: true });
  await multi.setInputFiles([file(2, 'primera.png'), file(0, 'segunda.png'), file(1, 'tercera.png')]);
  await page.waitForFunction(() => {
    const input = document.querySelector('input[multiple]');
    return input && !input.disabled && document.body.textContent.includes('3 de 5 fotos cargadas');
  });
  assert.equal(await page.getByLabel('Confirmar captura Frontal').isChecked(), false);
  assert.equal(await page.getByLabel('Confirmar captura Ángulo A').isChecked(), false);
  assert.equal(await page.getByLabel('Confirmar captura Ángulo B').isChecked(), false);
  assert.equal(await page.getByRole('dialog').count(), 0, 'contorno coherente válido no abre modal');
  evidence.push('3 archivos en un selector: orden B/frontal/A clasificado por pose; contorno autoaceptado; identidad no aceptada');
  await multi.setInputFiles([file(0, 'repetida-con-otro-nombre.png')]);
  await page.getByText(/foto repetida, omitida/).waitFor();
  assert.match(await page.locator('body').textContent(), /3 de 5 fotos cargadas/);
  evidence.push('SHA-256 detecta repetición aunque cambia el nombre; no reemplaza');
  const alternative = await page.evaluate(base64 => {
    const c = document.createElement('canvas'); c.width = 500; c.height = 600;
    return new Promise(resolve => { const img = new Image(); img.onload = () => {
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); ctx.fillStyle = 'red'; ctx.fillRect(499, 599, 1, 1);
      resolve(c.toDataURL('image/png').split(',')[1]);
    }; img.src = `data:image/png;base64,${base64}`; });
  }, payloads[1]);
  await multi.setInputFiles([{ name: 'otro-lateral-a.png', mimeType: 'image/png', buffer: Buffer.from(alternative, 'base64') }]);
  await page.getByLabel('Asignar vista · otro-lateral-a.png').waitFor();
  assert.match(await page.locator('body').textContent(), /mismo lado.*No se reemplazó/);
  await page.getByRole('button', { name: 'Descartar otro-lateral-a.png', exact: true }).click();
  await multi.setInputFiles([file(3, 'sin-pose.png')]);
  const manual = page.getByLabel('Asignar vista · sin-pose.png');
  await manual.waitFor();
  assert.match(await page.locator('body').textContent(), /Sin detector fiable/);
  await manual.selectOption('extra_a');
  await page.getByLabel('Cargar Foto 4').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.body.textContent.includes('Sin detector fiable en captura sintética.'));
  evidence.push('mismo lado no sobrescribe; sin detector queda en asignación manual y como referencia, no inventa malla');
  await page.getByRole('button', { name: 'Ver', exact: true }).nth(0).click();
  await page.getByRole('button', { name: 'Revisar frente, sienes y mentón', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const contourCheck = dialog.getByRole('checkbox');
  await contourCheck.waitFor();
  assert.equal(await contourCheck.isChecked(), true, 'propuesta geométricamente válida preseleccionada');
  await dialog.getByLabel('Posición Y (%)').fill('0');
  await contourCheck.check();
  assert.equal(await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).isEnabled(), false);
  await dialog.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
  await contourCheck.check();
  await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
  evidence.push('reedición posterior a subida; punto inválido bloquea Confirmar y restaurar permite continuar');
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.getByRole('tab', { name: /Revisar/ }).click();
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  const points = [50, 280].map(id => ({ id: `qa-${id}`,
    position: { x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] }, units: 0 }));
  const meta = Object.fromEntries(points.map(p => [p.id, { mode: 'hidratacion', dose: 1, zone: 'Auto', product: 'QA ficticio' }]));
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(JSON.stringify({ mapping_data: {
    injectionPoints: points, freehandLines: [], surfaceShapes: [], lab: { version: 1, meta },
  } }));
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Foto', exact: true }).click();
  await page.getByRole('tab', { name: /Revisar/ }).click();
  const amounts = await page.getByLabel('Volumen acumulado', { exact: true }).textContent();
  await page.getByRole('button', { name: 'Doble visor', exact: true }).click();
  const before = page.getByLabel('Foto Antes', { exact: true }), after = page.getByLabel('Foto Después', { exact: true });
  await before.waitFor(); await after.waitFor();
  const hash = locator => locator.evaluate(c => {
    const gl = c.getContext('webgl'), bytes = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes.reduce((sum, value, index) => sum + value * (index % 13 + 1), 0);
  });
  await page.waitForTimeout(800);
  assert.notEqual(await hash(before), await hash(after), 'píxeles WebGL realmente diferentes');
  await page.getByRole('button', { name: 'Deslizador', exact: true }).click();
  const slider = page.getByLabel('Comparación Antes / Después', { exact: true });
  await slider.fill('0.75');
  assert.equal(await page.getByLabel('Comparación con deslizador').locator('[style*="clip-path"]').evaluate(n => n.style.clipPath), 'inset(0px 25% 0px 0px)');
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 2);
  assert.equal(await page.getByLabel('Volumen acumulado', { exact: true }).textContent(), amounts);
  evidence.push('doble visor reutiliza WebGL con píxeles Antes/Después distintos; slider 75%; dosis y 2 puntos intactos');
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Genérico', exact: true }).click();
  await page.getByRole('button', { name: 'Doble visor', exact: true }).click();
  const models = page.getByLabel('Comparación Antes y Después').getByRole('region', { name: 'Modelo genérico 3D', exact: true });
  await models.nth(0).locator('canvas').waitFor(); await models.nth(1).locator('canvas').waitFor();
  assert.equal(await models.count(), 2);
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 2);
  const cameraState = () => page.evaluate(() => structuredClone(window.__comparisonCameras));
  const waitSynchronized = async () => {
    try { await page.waitForFunction(() => {
      const [a, b] = window.__comparisonCameras;
      return a && b && ['world', 'projection'].every(key => a[key].every((value, i) => Math.abs(value - b[key][i]) < 1e-6));
    }, undefined, { timeout: 15000 }); } catch (error) {
      const cameras = await cameraState();
      console.error('Cámaras reales no sincronizadas:', JSON.stringify(cameras));
      cameraFailures.push({ step: evidence.at(-1), cameras, error: error.message });
    }
  };
  const dragCamera = async (canvas, button = 'left') => {
    await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox(), x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;
    await page.mouse.move(x, y); await page.mouse.down({ button });
    await page.mouse.move(x + 50, y + 30, { steps: 12 }); await page.mouse.up({ button });
  };
  await waitSynchronized();
  let previousCamera = (await cameraState())[0];
  await dragCamera(models.nth(0).locator('canvas'));
  await page.waitForFunction(previous => JSON.stringify(window.__comparisonCameras[0]?.world) !== JSON.stringify(previous), previousCamera.world);
  await waitSynchronized();
  evidence.push('Cámara 3D: giro en Antes ejercitado; matrices comparadas');
  previousCamera = (await cameraState())[1];
  await dragCamera(models.nth(1).locator('canvas'), 'right');
  await page.waitForFunction(previous => JSON.stringify(window.__comparisonCameras[1]?.world) !== JSON.stringify(previous), previousCamera.world);
  await waitSynchronized();
  evidence.push('Cámara 3D: pan en Después ejercitado; matrices comparadas');
  previousCamera = (await cameraState())[0];
  await models.nth(0).locator('canvas').scrollIntoViewIfNeeded();
  const zoomBounds = await models.nth(0).locator('canvas').boundingBox();
  await page.mouse.move(zoomBounds.x + zoomBounds.width / 2, zoomBounds.y + zoomBounds.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(previous => JSON.stringify(window.__comparisonCameras[0]) !== JSON.stringify(previous), previousCamera);
  await waitSynchronized();
  await page.waitForTimeout(600);
  const stableCamera = (await cameraState())[0];
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('0.6');
  await page.waitForTimeout(1200);
  await waitSynchronized();
  const filteredCamera = (await cameraState())[0];
  for (const key of ['world', 'projection']) filteredCamera[key].forEach((value, i) =>
    assert.ok(Math.abs(value - stableCamera[key][i]) < 1e-6, `intensidad conserva ${key}[${i}]`));
  evidence.push('Cámara 3D: zoom ejercitado; intensidad conserva encuadre del visor activo');
  await page.getByRole('button', { name: 'Deslizador', exact: true }).click();
  await page.getByLabel('Comparación Antes / Después', { exact: true }).fill('0.25');
  assert.equal(await page.getByLabel('Comparación con deslizador').locator('canvas').count(), 2);
  await waitSynchronized();
  const sliderCamera = (await cameraState())[0];
  for (const key of ['world', 'projection']) sliderCamera[key].forEach((value, i) =>
    // Cambiar de doble a slider duplica el ancho: solo el término horizontal
    // de la proyección debe adaptarse al aspect; pose y zoom vertical permanecen.
    { if (key !== 'projection' || i !== 0) assert.ok(Math.abs(value - stableCamera[key][i]) < 1e-6,
      `slider conserva ${key}[${i}]: doble=${stableCamera[key][i]}, slider=${value}`); });
  assert.equal(await page.getByLabel('Volumen acumulado', { exact: true }).textContent(), amounts);
  evidence.push('3D real: dos Clinical3DViewer independientes de morfología, doble/slider y registro intacto');
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Foto', exact: true }).click();
  await page.getByRole('tab', { name: /Revisar/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Doble visor', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'sin overflow móvil');
  assert.equal(await before.isVisible(), true); assert.equal(await after.isVisible(), true);
  evidence.push('390×844: ambos visores visibles y sin overflow horizontal');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: evidence, cameraFailures, pageErrors: errors, detector: 'aislado; no probado' }, null, 2));
  assert.deepEqual(cameraFailures, [], 'giro/pan/zoom sincronizados con tolerancia 1e-6');
} finally { await browser.close(); }
