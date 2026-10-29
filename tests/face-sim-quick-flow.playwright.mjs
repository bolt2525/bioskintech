/**
 * QA local con atlas sintético; nunca usar fotografías ni fichas de pacientes.
 * PLAYWRIGHT_MODULE=<playwright/index.mjs existente> node tests/face-sim-quick-flow.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const position = id => ({ x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] });
const points = [50, 280, 10].map((id, i) => ({ id: `qa${i}`, position: position(id), units: 0 }));
const metadata = Object.fromEntries(points.map((point, i) => [point.id, {
  mode: i === 2 ? 'relleno_ha' : 'toxina', product: i === 2 ? 'Vial HA ficticio' : 'Vial QA ficticio', zone: 'Auto', dose: 0,
}]));
const encoded = JSON.stringify({ mapping_data: { injectionPoints: points, freehandLines: [], surfaceShapes: [],
  lab: { version: 1, meta: metadata } } });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], apiRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await page.route('**/*', route => /^(http:\/\/127\.0\.0\.1:5173\/|blob:|data:)/.test(route.request().url())
    ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(encoded);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  const count = () => page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] > li').length === 3);
  // Listado único: la dosis vive en cada punto y el HUD suma en tiempo real por tipo de inyectable.
  const ledger = page.getByRole('region', { name: 'Listado de puntos', exact: true });
  await ledger.waitFor();
  await page.getByLabel('Dosis marca 1', { exact: true }).fill('6');
  await page.getByLabel('Dosis marca 2', { exact: true }).fill('4');
  const hud = page.getByRole('list', { name: 'Volumen acumulado', exact: true });
  await page.waitForFunction(() => /10\s*U/.test(document.querySelector('[aria-label="Volumen acumulado"]')?.textContent ?? ''));
  await ledger.getByLabel('Filtrar por tercio', { exact: true }).selectOption('superior');
  assert.ok(await count() < 3, 'el filtro por tercio reduce el listado');
  await ledger.getByLabel('Filtrar por tercio', { exact: true }).selectOption('all');
  assert.equal(await count(), 3);
  const save = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar JSON de Inyectables', exact: true }).click();
    const stream = await (await pending).createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk.toString();
    return JSON.parse(text);
  };
  const exported = await save();
  assert.deepEqual(Object.values(exported.mapping_data.lab.meta).map(meta => meta.dose).sort((a, b) => a - b), [0, 4, 6]);
  await page.getByRole('button', { name: 'Seleccionar marca 1', exact: true }).click();
  await page.getByRole('button', { name: 'Espejar selección', exact: true }).click();
  assert.equal(await count(), 4);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.equal(await count(), 3);
  // El modal de volumen se valida en face-sim-local-flow; aquí se mide la acción bilateral pura.
  await page.getByLabel('Pedir volumen al marcar', { exact: true }).uncheck();
  const bilateral = page.getByLabel('Modo bilateral · crear ambos lados en una acción', { exact: true });
  await bilateral.check();
  await page.getByRole('button', { name: 'Punto', exact: true }).click();
  const annotationCanvas = page.locator('canvas:visible');
  await annotationCanvas.scrollIntoViewIfNeeded();
  for (const [x, y] of [[0.46, 0.4], [0.46, 0.5], [0.54, 0.55]]) {
    const box = await annotationCanvas.boundingBox();
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    await page.waitForTimeout(300);
    if (await count() > 3) break;
  }
  assert.equal(await count(), 5, 'Una acción bilateral crea exactamente dos marcas.');
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.equal(await count(), 3, 'Un solo deshacer retira el par completo.');
  await bilateral.uncheck();
  // La geometría y los controles permanecen compartidos entre vistas.
  const annotationLayers = page.getByRole('group', { name: 'Capa rápida', exact: true }).filter({ visible: true });
  await annotationLayers.getByRole('button', { name: 'Músculo', exact: true }).click();
  await page.getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  const appearance = page.locator('[data-face-appearance-group]');
  await appearance.locator('canvas').waitFor({ state: 'visible' }).catch(async error => {
    throw new Error(`${error.message}\n${await page.locator('body').innerText({ timeout: 5000 })}\n${errors.join('\n')}`);
  });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
    const moduleUrl = source.match(/import \* as THREE from "([^"]+)"/)?.[1];
    if (!moduleUrl) throw new Error('No se pudo instrumentar el renderer local.');
    const THREE = await import(moduleUrl);
    const previous = THREE.Mesh.prototype.onAfterRender;
    window.__faceQuickRender = { references: [], skin: null };
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera, geometry, material) {
      if (this.name === 'MORPHOLOGY_SKIN_AFTER') {
        window.__faceQuickRender.skin = geometry;
      }
      if (this.name === 'ALIGNED_ANATOMICAL_REFERENCE' && renderer.domElement.closest('[data-face-appearance-group]')) {
        window.__faceQuickRender.references.push({ triangles: geometry.index.count / 3,
          width: material.map?.image?.width ?? 0, opacity: material.opacity });
      }
      return previous?.apply(this, arguments);
    };
  });
  await appearance.getByRole('button', { name: 'Capas', exact: true }).click();
  assert.equal(await appearance.getByRole('group', { name: 'Capa rápida' }).getByRole('button', { name: 'Músculo', exact: true }).getAttribute('aria-pressed'), 'true');
  await appearance.getByRole('button', { name: 'Frontal', exact: true }).click();
  await page.waitForFunction(() => window.__faceQuickRender?.references.some(reference => reference.width > 100 && reference.triangles > 100 && reference.opacity > 0));
  if (process.env.FACE_QA_OUTPUT_DIRECTORY) await appearance.screenshot({ path: path.join(process.env.FACE_QA_OUTPUT_DIRECTORY, 'facial-capas-desktop.png') });
  const mesh = appearance.getByLabel('Mostrar mallado de zonas', { exact: true });
  await mesh.uncheck();
  await appearance.getByRole('button', { name: 'Morfología', exact: true }).click();
  const symmetry = appearance.getByLabel(/^Intensidad de simetría nasal/);
  await symmetry.fill('0.75');
  await appearance.getByLabel(/^Simetría nasal · lado de origen del paciente/).selectOption('-1');
  assert.equal(await symmetry.inputValue(), '0.75');
  await appearance.getByRole('button', { name: 'Restaurar simetría', exact: true }).click();
  assert.equal(await symmetry.inputValue(), '0');
  await appearance.getByRole('button', { name: 'Capas', exact: true }).click();
  await appearance.getByRole('group', { name: 'Capa rápida' }).getByRole('button', { name: 'Piel', exact: true }).click();
  await appearance.getByRole('button', { name: 'Morfología', exact: true }).click();
  await page.waitForFunction(() => window.__faceQuickRender.skin !== null);
  assert.equal(await page.evaluate(() => window.__faceQuickRender.skin.index.count), atlas.surface.triangles.length * 4);
  const neutralGeometry = await page.evaluate(() => Array.from(window.__faceQuickRender.skin.attributes.position.array));
  await appearance.getByRole('button', { name: 'Perfil lado A', exact: true }).click();
  for (const sign of ['-1', '1']) {
    await appearance.getByLabel('Punta · proyección', { exact: false }).fill(sign);
    await appearance.getByLabel('Mentón · altura', { exact: false }).fill(sign);
    await appearance.getByLabel('Mentón · proyección', { exact: false }).fill(sign);
    await page.waitForFunction(neutral => {
      const positions = window.__faceQuickRender.skin?.attributes.position.array;
      return positions?.some((v, i) => Math.abs(v - neutral[i]) > 0.01);
    }, neutralGeometry);
    assert.equal(await page.evaluate(() => window.__faceQuickRender.skin.attributes.position.array.every(Number.isFinite)), true);
    if (process.env.FACE_QA_OUTPUT_DIRECTORY) await appearance.locator('canvas').screenshot({
      path: path.join(process.env.FACE_QA_OUTPUT_DIRECTORY, `facial-mallado-perfil-${sign}.png`),
    });
  }
  await appearance.getByRole('button', { name: 'Restablecer todo', exact: true }).press('Enter');
  await page.waitForFunction(neutral => {
    const positions = window.__faceQuickRender.skin?.attributes.position.array;
    return positions?.length === neutral.length && positions.every((v, i) => v === neutral[i]);
  }, neutralGeometry);
  await appearance.getByRole('button', { name: 'Capas', exact: true }).press('Enter');
  await mesh.uncheck();
  await page.getByRole('button', { name: 'Marcaciones e inyectables', exact: true }).click();
  assert.equal(await page.getByLabel('Mostrar mallado de zonas', { exact: true }).filter({ visible: true }).isChecked(), false);
  assert.equal(await count(), 3);
  await page.getByRole('button', { name: 'Limpiar', exact: true }).click();
  if (!await page.getByLabel('JSON de Inyectables', { exact: true }).isVisible()) {
    await page.getByText('Importar de Inyectables', { exact: true }).click();
  }
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(JSON.stringify(exported));
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] > li').length === 3);
  const round = await save();
  assert.deepEqual(round.mapping_data.lab.meta && Object.values(round.mapping_data.lab.meta).map(meta => meta.dose).sort((a, b) => a - b), [0, 4, 6]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ledger.isVisible(), true);
  assert.equal(await hud.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.FACE_QA_OUTPUT_DIRECTORY) await ledger.screenshot({ path: path.join(process.env.FACE_QA_OUTPUT_DIRECTORY, 'facial-registro-movil.png') });
  assert.deepEqual(errors, []); assert.deepEqual(apiRequests, []);
  console.log(JSON.stringify({ passed: true, marks: await count(), desktop: '1440x1000', mobile: '390x844',
    checks: ['dosis por punto', 'volumen acumulado en tiempo real', 'filtro por tercio', 'JSON ida/vuelta', 'espejo', 'bilateral y undo atomico',
      'capas y mallado sincronizados', 'simetria nasal reversible', 'render muscular real', 'mallado refinado y extremos nariz/menton reversibles', 'sin API ni desbordamiento'] }));
} finally {
  await browser.close();
}
