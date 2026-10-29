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
  const quick = page.getByRole('region', { name: 'Registro rápido por zonas', exact: true });
  await quick.waitFor();
  const toxin = quick.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'Toxina · Vial QA ficticio' }) });
  const inputs = await toxin.locator('input[type="number"]').all();
  const amounts = [];
  for (const input of inputs) if (!(await input.getAttribute('aria-label')).startsWith('Total declarado')) amounts.push(input);
  assert.equal(amounts.length, 2, 'Cada punto lateral genera su zona y lado, no una dosis.');
  await amounts[0].fill('6'); await amounts[1].fill('4');
  await toxin.getByLabel('Total declarado Toxina Vial QA ficticio', { exact: true }).fill('10');
  await toxin.getByText('Total declarado y zonas coinciden.', { exact: true }).waitFor();
  assert.equal(await toxin.getByText('Total por zonas: 10 U · 0 pendiente(s)', { exact: true }).count(), 1);
  const save = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar JSON de Inyectables', exact: true }).click();
    const stream = await (await pending).createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk.toString();
    return JSON.parse(text);
  };
  const exported = await save(), groupKey = JSON.stringify(['toxina', 'Vial QA ficticio']);
  assert.equal(exported.mapping_data.lab.quickRecord.entries[groupKey].total, 10);
  assert.deepEqual(Object.values(exported.mapping_data.lab.quickRecord.entries[groupKey].zones).sort((a, b) => a - b), [4, 6]);
  assert.ok(Object.values(exported.mapping_data.lab.meta).every(meta => meta.dose === 0));
  await page.getByRole('button', { name: 'Seleccionar marca 1', exact: true }).click();
  await page.getByRole('button', { name: 'Espejar selección', exact: true }).click();
  assert.equal(await count(), 4);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.equal(await count(), 3);
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
  await appearance.locator('canvas').waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
    const moduleUrl = source.match(/import \* as THREE from "([^"]+)"/)?.[1];
    if (!moduleUrl) throw new Error('No se pudo instrumentar el renderer local.');
    const THREE = await import(moduleUrl);
    const previous = THREE.Mesh.prototype.onAfterRender;
    window.__faceQuickRender = { references: [] };
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera, geometry, material) {
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
  assert.deepEqual(round.mapping_data.lab.quickRecord, exported.mapping_data.lab.quickRecord);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await quick.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.FACE_QA_OUTPUT_DIRECTORY) await quick.screenshot({ path: path.join(process.env.FACE_QA_OUTPUT_DIRECTORY, 'facial-registro-movil.png') });
  assert.deepEqual(errors, []); assert.deepEqual(apiRequests, []);
  console.log(JSON.stringify({ passed: true, marks: await count(), desktop: '1440x1000', mobile: '390x844',
    checks: ['zonas y lados', 'totales sin dosis por punto', 'conciliacion', 'JSON ida/vuelta', 'espejo', 'bilateral y undo atomico',
      'capas y mallado sincronizados', 'simetria nasal reversible', 'render muscular real', 'sin API ni desbordamiento'] }));
} finally {
  await browser.close();
}
