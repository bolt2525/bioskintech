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
    const response = await route.fetch(), source = await response.text();
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
    await page.getByRole('button', { name: /^Calcular superficie con/ }).click();
    await page.getByText(/^Superficie 3D personal generada desde la foto Frontal/).waitFor();
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
  await page.getByRole('button', { name: /^Calcular superficie con/ }).click();
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
  await page.getByText('Opciones de superficie y cabeza experimental', { exact: true }).click();
  await page.getByText('Concordancia por foto', { exact: true }).click();
  assert.equal(await page.getByText(/Detección recuperada: referencia visual únicamente; calibra/).count(), 2);
  await page.getByText('Calibrar perfil base · nariz, filtrum y labios', { exact: true }).click();
  await page.getByRole('region', { name: 'Perfil base calibrado en 3D', exact: true }).locator('canvas').waitFor();
  await page.waitForFunction(() => window.__calibrationMask);
  const preview = await page.evaluate(() => window.__calibrationMask);
  assert.deepEqual(preview.positions, monocular.positions, 'el visor de calibración usa la base sin efectos');
  const slider = page.getByLabel('Calibración base Filtrum', { exact: true });
  await slider.evaluate(node => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '-0.04');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.deepEqual((await page.evaluate(() => window.__calibrationMask)).positions, preview.positions,
    'el borrador no cambia la base antes de aplicar');
  const oldUuid = recovered.uuid;
  await page.getByRole('button', { name: 'Aplicar calibración', exact: true }).click();
  await page.getByText(/^Superficie 3D personal generada desde la foto Frontal/).waitFor();
  await page.waitForFunction(uuid => window.__calibrationMask?.uuid !== uuid, preview.uuid);
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
  await page.getByText('Calibrar perfil base · nariz, filtrum y labios', { exact: true }).click();
  await page.getByRole('button', { name: 'Poner calibración a cero', exact: true }).click();
  await page.getByRole('button', { name: 'Aplicar calibración', exact: true }).click();
  await page.getByText(/^Superficie 3D personal generada desde la foto Frontal/).waitFor();
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.waitForFunction(uuid => window.__baseMask?.uuid !== uuid, calibrated.uuid);
  assert.deepEqual((await page.evaluate(() => window.__baseMask)).positions, monocular.positions);
  await page.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByText('Calibrar perfil base · nariz, filtrum y labios', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await slider.scrollIntoViewIfNeeded();
  assert.equal(await slider.isVisible(), true);
  assert.equal(await page.getByRole('region', { name: 'Perfil base calibrado en 3D', exact: true }).isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sin desbordamiento móvil');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: 8, recoveredProfiles: 'base frontal exacta', calibrationMax: max,
    restore: 'exacto', frontalXY: 'exacto', mobile: 390, errors: errors.length }));
} finally {
  await browser.close();
}
