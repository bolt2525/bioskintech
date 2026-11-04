import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(url)) return route.abort();
    if (!url.includes('/src/lab/faceSim/FaceSimLab.tsx')) return route.continue();
    const response = await route.fetch({ timeout: 120000 }), source = await response.text();
    const pattern = /async function detectFrame\([^]*?\n\}/;
    assert.match(source, pattern);
    return route.fulfill({ response, body: source.replace(pattern, `async function detectFrame(img) {
      const marker=img.getContext("2d").getImageData(0,0,1,1).data[0];
      const angle=(marker===2?55:marker===3?-55:0)*Math.PI/180;
      const landmarks=${JSON.stringify(fixture.landmarks)}.map(([x,y,z])=>({
        x:0.5+(x-0.5)*Math.cos(angle)+z*Math.sin(angle),y,
        z:-(x-0.5)*Math.sin(angle)+z*Math.cos(angle)
      }));
      const recovered=marker!==1;
      return {frame:frameFromLandmarks(landmarks),landmarks,detectedLandmarks:landmarks,
        regionMap:buildFaceRegionMap(landmarks,${JSON.stringify(atlas.triangles)},img.width/img.height,genericFaceAtlas.positions),
        pose:[Math.cos(angle),0,-Math.sin(angle),0,0,1,0,0,Math.sin(angle),0,Math.cos(angle),0,0,0,0,1],
        detectionRecovered:recovered,contourAdjusted:0,reason:"",
        captureWarnings:recovered?["Detección recuperada: referencia visual únicamente."]:[]};
    }`) });
  });
  await page.goto(`${origin}/dev/hair-lab`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  await page.evaluate(async () => {
    const code = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(code.match(/import \* as THREE from "([^"]+)"/)[1]);
    const original = THREE.Mesh.prototype.onAfterRender;
    window.__renderedMeshes = new Set();
    THREE.Mesh.prototype.onAfterRender = function (renderer) {
      window.__renderedMeshes.add(`${this.name}:${renderer.domElement.closest('section')?.getAttribute('aria-label')}`);
      if (this.name.startsWith('PERSONAL_FACE_SURFACE') && !this.name.includes('_POINT')
        && renderer.domElement.closest('section[aria-label="Foto personal en 3D"]')) {
        window.__baseMask = { uuid: this.uuid, positions: Array.from(this.geometry.attributes.position.array) };
      }
      if (this.name.startsWith('PERSONAL_FACE_SURFACE') && !this.name.includes('_POINT')
        && renderer.domElement.closest('section[aria-label="Perfil base calibrado en 3D"]')) {
        window.__calibrationMask = { uuid: this.uuid, positions: Array.from(this.geometry.attributes.position.array) };
      }
      return original?.apply(this, arguments);
    };
  });
  const payloads = await page.evaluate(() => [1, 2, 3].map(marker => {
    const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 600;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#bf9287'; ctx.fillRect(0, 0, 500, 600);
    ctx.fillStyle = `rgb(${marker},0,0)`; ctx.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const load = async (label, index) => {
    await page.getByRole('button', { name: 'Capturas', exact: true }).click();
    await page.getByLabel(`Cargar ${label}`, { exact: true }).setInputFiles({
      name: `synthetic-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(payloads[index], 'base64'),
    });
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
    await dialog.getByLabel('Bordes sobre piel visible; sin cabello ni fondo.').check();
    await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
    await page.getByLabel(`Confirmar captura ${label}`, { exact: true }).check();
  };
  const build = async () => {
    const previous = await page.evaluate(() => window.__baseMask?.uuid);
    await page.getByRole('button', { name: '2. Generar y revisar máscara', exact: true }).click();
    await page.getByRole('dialog', { name: 'Revisar máscara antes de usarla' }).waitFor();
    await page.getByRole('button', { name: 'Usar generada sin ajustes', exact: true }).click();
    await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
    try {
      await page.waitForFunction(uuid => window.__baseMask && window.__baseMask.uuid !== uuid, previous);
    } catch (error) {
      console.error(await page.locator('header').allTextContents(), await page.evaluate(() => [...window.__renderedMeshes]), errors);
      throw error;
    }
    return page.evaluate(() => window.__baseMask);
  };
  await load('Frontal', 1);
  await page.getByRole('button', { name: '2. Generar y revisar máscara', exact: true }).click();
  await page.getByText(/^La captura asignada a Frontal muestra un giro lateral/).waitFor();
  assert.equal(await page.evaluate(() => window.__baseMask), undefined);
  await page.getByLabel('Retirar Frontal', { exact: true }).click();
  await load('Frontal', 0);
  const monocular = await build();
  await load('Ángulo A', 1);
  await load('Ángulo B', 2);
  const recovered = await build();
  assert.deepEqual(recovered.positions, monocular.positions, 'dos recuperaciones no alteran la base frontal');
  console.log('Frontal con dos perfiles recuperados: geometría original exacta.');
  await page.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar máscara aceptada', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Revisar máscara antes de usarla' });
  await review.waitFor();
  const slider = review.getByLabel('Ajuste de perfil Filtrum', { exact: true });
  const previewHost = review.getByTestId('mask-review-preview');
  await page.waitForFunction(() => document.querySelector('[data-testid="mask-review-preview"]')?.dataset.displacement === '0');
  await slider.focus();
  await slider.press('Home');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="mask-review-preview"]')?.dataset.displacement) > 0.02);
  const liveMax = await previewHost.getAttribute('data-displacement');
  assert.ok(Number(liveMax) > 0.02, 'el borrador cambia inmediatamente, sin aplicar ni recalcular');
  await review.getByRole('button', { name: 'Comparar sin ajustes', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="mask-review-preview"]')?.dataset.displacement === '0');
  await review.getByRole('button', { name: 'Ver ajustes', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="mask-review-preview"]')?.dataset.displacement) > 0.02);
  await review.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.waitForFunction(() => window.__baseMask);
  assert.deepEqual((await page.evaluate(() => window.__baseMask)).positions, monocular.positions, 'cancelar no modifica la base aceptada');
  await page.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar máscara aceptada', exact: true }).click();
  await slider.focus(); await slider.press('Home');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="mask-review-preview"]')?.dataset.displacement) > 0.02);
  await page.evaluate(() => { window.__calibrationMask = null; });
  await review.getByRole('button', { name: 'Confirmar propuesta ajustada', exact: true }).click();
  await review.waitFor({ state: 'detached' });
  await page.getByRole('region', { name: 'Perfil base calibrado en 3D', exact: true }).locator('canvas').waitFor();
  await page.waitForFunction(() => window.__calibrationMask);
  const oldUuid = await page.evaluate(() => window.__baseMask?.uuid);
  const appliedPreview = await page.evaluate(() => window.__calibrationMask);
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.waitForFunction(uuid => window.__baseMask?.uuid !== uuid, oldUuid);
  const calibrated = await page.evaluate(() => window.__baseMask);
  assert.deepEqual(appliedPreview.positions, calibrated.positions, 'Capturas y Simular comparten la base aplicada');
  let max = 0;
  for (let i = 0; i < monocular.positions.length; i++) {
    if (i % 3 !== 2) assert.equal(calibrated.positions[i], monocular.positions[i]);
    else max = Math.max(max, Math.abs(calibrated.positions[i] - monocular.positions[i]));
  }
  assert.ok(max > 0.02, `relieve real: ${max}`);
  console.log(`Filtrum calibrado: desplazamiento Z ${max}; XY exacto.`);
  await page.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar máscara aceptada', exact: true }).click();
  await page.getByRole('button', { name: 'Usar generada sin ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.waitForFunction(uuid => window.__baseMask?.uuid !== uuid, calibrated.uuid);
  assert.deepEqual((await page.evaluate(() => window.__baseMask)).positions, monocular.positions);
  await page.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByRole('button', { name: 'Revisar máscara aceptada', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await slider.evaluate(node => node.scrollIntoView({ block: 'end' }));
  assert.equal(await slider.isVisible(), true);
  assert.equal(await review.isVisible(), true);
  const mobilePreview = await review.getByRole('region', { name: 'Comparación de máscara preliminar' }).boundingBox();
  const mobileSlider = await slider.boundingBox();
  assert.ok(mobilePreview.y >= 0 && mobilePreview.y + mobilePreview.height <= mobileSlider.y, 'visor visible mientras se ajusta en móvil');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sin desbordamiento móvil');
  assert.deepEqual(errors, []);
  await review.getByRole('button', { name: 'Cancelar', exact: true }).click();
  console.log(JSON.stringify({ cases: 11, recoveredProfiles: 'base frontal exacta', calibrationMax: max,
    restore: 'exacto', frontalXY: 'exacto', mobile: 390, errors: errors.length }));
} finally {
  await browser.close();
}
