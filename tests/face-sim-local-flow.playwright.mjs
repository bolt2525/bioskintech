/**
 * QA local con atlas y capturas sintéticas, sin datos de pacientes.
 * npm run dev -- --host 127.0.0.1 --port 5173
 * PLAYWRIGHT_MODULE=<ruta a playwright/index.mjs> node tests/face-sim-local-flow.playwright.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], remote = [], blocked = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith('http://127.0.0.1:5173/') && !/^(data:|blob:)/.test(url)) {
      blocked.push(url); return route.abort();
    }
    return route.continue();
  });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => {
    if (['fetch', 'xhr'].includes(request.resourceType()) && (!request.url().startsWith('http://127.0.0.1:5173/')
      || request.url().includes('/api/'))) remote.push(request.url());
  });
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  const space = page.getByRole('navigation', { name: 'Espacios del laboratorio' });
  await space.waitFor();
  assert.equal(await space.getByRole('button').count(), 2);
  await space.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.locator('canvas:visible').waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('canvas:visible').count(), 1);
  const canvas = page.locator('canvas:visible');
  const count = () => page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count();
  const bounds = await canvas.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
  const at = (x, y) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  // Cámara no registra ni al hacer clic ni al arrastrar.
  await page.mouse.click(at(0.5, 0.5).x, at(0.5, 0.5).y);
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: 'Punto', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Antes', exact: true }).getAttribute('aria-pressed'), 'true');
  await canvas.waitFor({ state: 'visible' }); await page.waitForTimeout(700);
  // Varias posiciones interiores, sin asumir la proyección exacta del visor compartido.
  for (const [x, y] of [[0.5, 0.5], [0.45, 0.6], [0.55, 0.6]]) {
    const p = at(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(600);
    if (await count()) break;
  }
  assert.ok(await count() > 0, `El raycast no creó una marca. Estado: ${await page.getByRole('status').allTextContents()}`);
  const initialCount = await count();
  const dose = page.getByLabel('Dosis marca 1', { exact: true });
  await dose.fill('7.5');
  assert.equal(await dose.inputValue(), '7.5');
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('0.9');
  assert.equal(await dose.inputValue(), '7.5');
  for (const name of ['Toxina', 'Relleno HA', 'Hidratación', 'Bioestimulador']) {
    const effect = page.getByLabel(`Efecto ${name}`, { exact: true });
    await effect.uncheck(); await effect.check();
  }
  await page.getByRole('button', { name: 'Antes', exact: true }).click();
  await page.getByRole('button', { name: 'Después', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Mover cámara', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(700);
  const previewBounds = await page.locator('canvas:visible').boundingBox();
  await page.mouse.click(previewBounds.x + previewBounds.width * 0.5, previewBounds.y + previewBounds.height * 0.5);
  assert.equal(await count(), initialCount, 'Después no puede registrar marcas.');
  await page.getByRole('button', { name: 'Seleccionar marca 1', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Editar marca seleccionada' });
  await editor.getByLabel('Producto registrado', { exact: true }).fill('Producto QA ficticio');
  await editor.getByRole('button', { name: 'Guardar cambios de marca', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar JSON de Inyectables', exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  let encoded = ''; for await (const chunk of stream) encoded += chunk.toString();
  const exported = JSON.parse(encoded);
  assert.equal(exported.mapping_data.injectionPoints.length, initialCount);
  assert.equal(Object.values(exported.mapping_data.lab.meta)[0].dose, 7.5);
  await page.getByRole('button', { name: 'Eliminar marca 1', exact: true }).click();
  assert.equal(await count(), initialCount - 1);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.equal(await count(), initialCount);
  await space.getByRole('button', { name: 'Capturas', exact: true }).click();
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).count(), 0);
  await space.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  assert.equal(await count(), initialCount);
  await page.getByRole('button', { name: 'Limpiar', exact: true }).click();
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(encoded);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  assert.equal(await count(), initialCount);
  assert.equal(await page.getByLabel('Dosis marca 1', { exact: true }).inputValue(), '7.5');
  const groups = page.getByRole('navigation', { name: 'Grupos del editor' });
  assert.equal(await groups.getByRole('button').count(), 2);
  await groups.getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  const advanced = page.locator('[data-face-appearance-group]');
  await advanced.locator('canvas').waitFor({ state: 'visible' });
  assert.equal(await page.locator('canvas:visible').count(), 1);
  const nose = advanced.locator('input[id$="-noseTip"]');
  await nose.fill('0.42');
  for (const name of ['Piel', 'Capas', 'Corte', 'Morfología']) {
    await advanced.getByRole('button', { name, exact: true }).click();
  }
  await groups.getByRole('button', { name: 'Marcaciones e inyectables', exact: true }).click();
  assert.equal(await count(), initialCount);
  assert.equal(await page.locator('canvas:visible').count(), 1);
  await groups.getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  assert.equal(await nose.inputValue(), '0.42');
  await groups.getByRole('button', { name: 'Marcaciones e inyectables', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('button', { name: 'Punto', exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('Intensidad visual independiente', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log(JSON.stringify({ passed: true, marks: initialCount, desktop: '1440×1000', mobile: '390×844',
    externalResourcesBlocked: blocked.length,
    checks: ['dos espacios', 'cámara sin marcas', 'raycast punto', 'edición', 'dosis independiente', '4 efectos',
      'antes/después', 'export/import', 'quitar/undo', 'registro persistente entre espacios',
      'grupos internos', 'morfología/piel/capas/corte', 'estado avanzado conservado', 'un viewport visible',
      'sin red externa', 'sin overflow móvil'] }, null, 2));
} finally {
  await browser.close();
}
