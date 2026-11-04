/**
 * QA coordinado con el principal. Solo atlas y metadatos sintéticos, sin adjuntos.
 * PLAYWRIGHT_MODULE=<playwright/index.mjs> node tests/face-sim-marking-premium.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5173';
const position = i => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1], z: atlas.positions[i * 3 + 2] });
const meta = {
  fan: { mode: 'relleno_ha', dose: 0, zone: 'Auto', product: 'QA entrada', entry: true, technique: 'Abanico' },
  t0: { mode: 'relleno_ha', dose: 0.1, zone: 'Auto', product: 'QA HA A', plane: 'Subcutáneo', parent: 'fan', tip: 0 },
  t1: { mode: 'relleno_ha', dose: 0.2, zone: 'Auto', product: 'QA HA B', plane: 'Supraperióstico', parent: 'fan', tip: 1 },
  toxin: { mode: 'toxina', dose: 4, zone: 'Auto', product: 'QA toxina' },
  pending: { mode: 'toxina', dose: 0, zone: 'Auto', product: 'QA pendiente' },
  graphic: { mode: 'toxina', dose: 0, zone: 'Auto', graphicOnly: true, annotationKind: 'text', annotationText: 'QA gráfico' },
};
const fixture = { mapping_data: {
  injectionPoints: ['t0', 't1', 'toxin', 'pending', 'graphic'].map((id, i) => ({ id, position: position(i === 0 ? 205 : 50), units: meta[id].dose })),
  freehandLines: [{ id: 'fan', points: [position(50), position(205)], segments: [[position(50), position(205)], [position(50), position(50)]], color: '#e879f9', thickness: 2 }],
  surfaceShapes: [],
  lab: { version: 1, meta, kinds: { fan: 'pattern' }, illustrativePlanes: Object.fromEntries(Object.keys(meta).map(id => [id, 'skin'])) },
} };
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) || /^(data:|blob:)/.test(route.request().url()) ? route.continue() : route.abort());
  const button = name => page.getByRole('button', { name, exact: true });
  const ledger = page.getByRole('region', { name: 'Listado de puntos', exact: true });
  const list = ledger.getByRole('list', { name: 'Elementos marcados', exact: true });
  const count = () => list.locator('li').count();
  const exportRecord = async () => {
    await page.getByRole('tab', { name: /Revisar/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), button('Exportar JSON de Inyectables').click()]);
    const stream = await download.createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk;
    await button('Antes').click();
    return JSON.parse(text).mapping_data;
  };
  await page.goto(`${origin}/dev/hair-lab`, { waitUntil: 'domcontentloaded' });
  await button('Simulación facial').click();
  await button('Simular y marcar').click();
  await page.getByRole('tab', { name: /Revisar/ }).click();
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(JSON.stringify(fixture));
  await button('Importar').click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] li').length === 6);
  const before = await exportRecord();
  await ledger.locator('summary').filter({ hasText: 'Selección y edición en lote' }).click();
  await button('Todo el registro').click();
  assert.equal(await button('Aplicar dosis a cada punto').isDisabled(), true);
  assert.match(await ledger.getByRole('alert').innerText(), /Categorías mezcladas/);
  await button('Deseleccionar todo').click();
  await list.locator('li').filter({ hasText: 'Entrada · Abanico' }).getByRole('checkbox').check();
  await button('Reflejar selección').click();
  const confirmation = ledger.getByRole('form', { name: 'Confirmar copia de marcaciones', exact: true });
  assert.equal(await count(), 6);
  assert.equal(await button('Confirmar reflejo').isDisabled(), true);
  assert.match(await confirmation.getByRole('region', { name: 'Cantidades que se añadirán' }).innerText(), /0.1 ml/);
  await confirmation.getByRole('checkbox', { name: /Confirmo duplicar/ }).check();
  await button('Confirmar reflejo').click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] li').length === 9);
  const after = await exportRecord();
  const copied = Object.entries(after.lab.meta).filter(([, m]) => m.markingCopyIntent);
  assert.equal(copied.length, 3);
  for (const [id, item] of copied) {
    const original = before.lab.meta[item.markingCopyIntent.sourceId];
    assert.ok(original);
    for (const key of ['product', 'mode', 'dose', 'plane', 'tip']) assert.equal(item[key], original[key], key);
    assert.equal(item.markingCopyIntent.confirmedQuantities, true);
    assert.equal(item.markingCopyIntent.operation, 'mirror');
    assert.notEqual(id, item.markingCopyIntent.sourceId);
  }
  for (const [id, item] of Object.entries(before.lab.meta)) assert.deepEqual(after.lab.meta[id], item);
  assert.deepEqual(after.lab.quickRecord, before.lab.quickRecord);
  await button('Deshacer').click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] li').length === 6);
  assert.deepEqual((await exportRecord()).lab.meta, before.lab.meta);
  console.log('PASS copia solo familia seleccionada, metadata individual, intención exportada y undo atómico');

  await button('Deseleccionar todo').click();
  await list.locator('li').filter({ hasText: 'Entrada · Abanico' }).getByRole('checkbox').check();
  await ledger.getByLabel(/Dosis por punto/).fill('0.4');
  await button('Aplicar dosis a cada punto').click();
  await ledger.getByLabel('Producto / vial para el lote', { exact: true }).fill('QA lote');
  await button('Aplicar producto (vacío = sin vial)').click();
  await ledger.getByLabel('Plano para el lote', { exact: true }).selectOption('Subcutáneo');
  await button('Aplicar plano a 2 punto(s)').click();
  const edited = await exportRecord();
  const tips = Object.values(edited.lab.meta).filter(m => m.parent);
  assert.equal(tips.length, 2);
  for (const tip of tips) assert.deepEqual([tip.dose, tip.product, tip.plane], [0.4, 'QA lote', 'Subcutáneo']);
  const graphic = Object.values(edited.lab.meta).find(m => m.graphicOnly);
  assert.equal(graphic.dose, 0); assert.equal(graphic.plane, undefined);
  await ledger.getByLabel('Filtrar por producto', { exact: true }).selectOption(JSON.stringify(['relleno_ha', 'QA lote']));
  assert.equal(await count(), 2);
  const summary = ledger.getByRole('region', { name: 'Totales visibles por producto', exact: true });
  assert.match(await summary.innerText(), /0.8 ml/);
  await button('Limpiar filtros').click();
  await button('Solo pendientes').click();
  assert.equal(await button('Solo pendientes').getAttribute('aria-pressed'), 'true');
  assert.equal(await count(), 1);
  assert.match(await summary.innerText(), /0 U/);
  await button('Limpiar filtros').click();
  console.log('PASS lote plano/producto/dosis, guards mixtos y gráficos, resumen visible y pendientes sin sumar U/ml');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await ledger.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`);
    await button('Duplicar selección').click();
    await confirmation.getByRole('checkbox', { name: /Confirmo duplicar/ }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await confirmation.count(), 0);
    assert.equal(await button('Duplicar selección').evaluate(el => el === document.activeElement), true);
    const filter = ledger.getByLabel('Buscar marcaciones', { exact: true });
    await filter.fill('QA gráfico');
    assert.equal(await count(), 1);
    await button('Limpiar filtros').click();
    console.log(`PASS ${width}px: sin overflow, búsqueda, cancelación Escape y foco restaurado`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS sin errores de página');
} finally {
  await browser.close();
}
