import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(url)) return route.abort();
    if (!url.includes('/src/lab/faceSim/FaceSimLab.tsx')) return route.continue();
    const response = await route.fetch(), source = await response.text();
    return route.fulfill({ response, body: source.replace(/async function detectFrame\([^]*?\n\}/, `async function detectFrame(img) {
      const marker=img.getContext('2d').getImageData(0,0,1,1).data[0];
      if(marker!==1) return {frame:null, reason:'Perfil sintético sin detección: revisión 2D disponible.'};
      const landmarks=${JSON.stringify(fixture.landmarks)}.map(([x,y,z])=>({x,y,z}));
      return {frame:frameFromLandmarks(landmarks),landmarks,detectedLandmarks:landmarks,
        regionMap:buildFaceRegionMap(landmarks,${JSON.stringify(atlas.triangles)},img.width/img.height,genericFaceAtlas.positions),
        contourAdjusted:0,reason:''};
    }`) });
  });
  await page.goto(`${origin}/dev/hair-lab`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  await page.evaluate(async () => {
    const code = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(code.match(/import \* as THREE from "([^"]+)"/)[1]);
    const original = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function () {
      if (this.name === 'PERSONAL_FACE_SURFACE' && !window.__skinBasePositions) window.__skinBasePositions = Array.from(this.geometry.attributes.position.array);
      return original?.apply(this, arguments);
    };
  });
  const payloads = await page.evaluate(() => [1, 2, 3].map(marker => {
    const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 600;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(500, 600);
    for (let y = 0; y < 600; y++) for (let x = 0; x < 500; x++) {
      const signal = Math.exp(-((x - (marker === 1 ? 189 : marker === 3 ? 340 : 160)) ** 2 + (y - (marker === 1 ? 287 : 365)) ** 2) / 75);
      image.data.set([180 + 45 * signal, 130 - 30 * signal, 110 - 10 * signal, 255], (y * 500 + x) * 4);
    }
    image.data.set([marker, 0, 0, 255], 0); ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  for (const [i, label] of ['Frontal', 'Ángulo A', 'Ángulo B'].entries()) {
    await page.getByLabel(`Cargar ${label}`, { exact: true }).setInputFiles({
      name: `synthetic-skin-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(payloads[i], 'base64'),
    });
    if (i === 0) {
      const boundary = page.getByRole('dialog');
      await boundary.waitFor();
      await boundary.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
      await boundary.getByLabel('Bordes sobre piel visible; sin cabello ni fondo.').check();
      await boundary.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
    }
    await page.getByLabel(`Confirmar captura ${label}`, { exact: true }).check();
  }
  await page.getByRole('button', { name: '2. Generar y revisar máscara', exact: true }).click();
  await page.getByRole('button', { name: 'Usar generada sin ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.waitForFunction(() => window.__skinBasePositions);
  await page.getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  await page.locator('[data-face-editor]').getByRole('button', { name: 'Piel', exact: true }).click();
  const dialog = page.getByRole('region', { name: 'Revisión de piel · fotos y máscara' });
  await dialog.waitFor();
  const flow = page.locator('[data-face-editor]').getByRole('group', { name: 'Flujo de piel' });
  assert.ok(await flow.evaluate(node => node.parentElement.querySelector('button').textContent === 'Piel'),
    'el subflujo debe pertenecer al mismo grupo que Piel');
  assert.ok(await dialog.locator('[data-skin-analysis-toolbar]').getByRole('slider', { name: 'Sensibilidad de candidatos de piel' }).isVisible(),
    'sensibilidad junto al análisis, no al final');
  assert.equal(await page.getByRole('dialog').count(), 0, 'la revisión pertenece a Piel, no a otro modal');
  await dialog.getByText('Avanzados · áreas y alineación', { exact: true }).click();
  const source = label => dialog.getByRole('group', { name: 'Fotos de piel' }).getByRole('button', { name: new RegExp(`^${label}`) });
  const coordinates = async point => {
    if (!await dialog.getByLabel('X (%)', { exact: true }).isVisible()) await dialog.getByText('Introducir punto con teclado', { exact: true }).click();
    await dialog.getByLabel('X (%)', { exact: true }).fill(`${point.x * 100}`);
    await dialog.getByLabel('Y (%)', { exact: true }).fill(`${point.y * 100}`);
    await dialog.getByRole('button', { name: 'Añadir punto', exact: true }).click();
  };
  for (const label of ['Ángulo A', 'Ángulo B']) {
    await source(label).click();
    await dialog.getByRole('button', { name: 'Delimitar piel', exact: true }).click();
    for (const point of [{ x: .15, y: .25 }, { x: .85, y: .25 }, { x: .85, y: .8 }, { x: .15, y: .8 }]) await coordinates(point);
    await dialog.getByRole('button', { name: 'Cerrar área', exact: true }).click();
    await dialog.getByLabel('Las áreas contienen solo piel visible, sin ojos, labios, pelo ni fondo.').check();
  }
  const analyze = dialog.getByRole('button', { name: 'Analizar fotos', exact: true });
  const contrast = await analyze.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const light = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (light[0] + .05) / (light[1] + .05);
  });
  assert.ok(contrast >= 4.5, 'el botón de análisis debe seguir legible');
  const run = async () => {
    const started = Date.now(); await analyze.click();
    await dialog.getByRole('button', { name: 'Cancelar análisis', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cancelar análisis', exact: true }).waitFor({ state: 'hidden' });
    await dialog.getByText('3 fotos analizadas; revisa los candidatos. No son lesiones confirmadas.', { exact: true }).waitFor();
    return Date.now() - started;
  };
  const duration = await run();
  assert.ok(duration < 15000);
  assert.equal(await dialog.getByRole('group', { name: 'Fotos de piel' }).getByRole('button', { name: /analizada/ }).count(), 3);
  await source('Ángulo A').click();
  assert.ok(await dialog.getByRole('list', { name: 'Candidatos multivista' }).getByRole('listitem').count() > 0);
  await dialog.getByRole('button', { name: 'Aceptar candidato 1', exact: true }).click();
  await dialog.getByLabel('Estado de revisión', { exact: true }).selectOption('all');
  await dialog.getByText(/1\..* · revisado/).waitFor();
  const sensitivity = dialog.getByRole('slider', { name: 'Sensibilidad de candidatos de piel' });
  await sensitivity.focus(); await page.keyboard.press('ArrowRight');
  await dialog.getByText(/^Sensibilidad pendiente de aplicar/).waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'Aceptar y siguiente · A', exact: true }).isDisabled());
  await analyze.focus(); await page.keyboard.press('d');
  await dialog.getByText(/1\..* · revisado/).waitFor();
  const beforeCancel = await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText();
  await analyze.click();
  await dialog.getByRole('button', { name: 'Conservar revisión', exact: true }).click();
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText(), beforeCancel, 'cancelar conserva candidatos y decisiones');
  await analyze.click();
  // Hace reproducible cancelar entre etapas, sin cambiar el detector ni sus resultados.
  await page.evaluate(() => {
    window.__skinOriginalTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => window.__skinOriginalTimeout(callback, delay === 0 ? 300 : delay, ...args);
  });
  await dialog.getByRole('button', { name: 'Reanalizar y reemplazar revisión', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancelar análisis', exact: true }).focus();
  await page.keyboard.press('d');
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText(), beforeCancel, 'el atajo no decide durante el análisis');
  await dialog.getByRole('button', { name: 'Cancelar análisis', exact: true }).click();
  await page.evaluate(() => { window.setTimeout = window.__skinOriginalTimeout; });
  await dialog.getByText('Análisis cancelado. No se aplicaron cambios.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText(), beforeCancel, 'cancelar el análisis conserva candidatos y decisiones');
  await sensitivity.focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(await dialog.getByText(/^Sensibilidad pendiente de aplicar/).count(), 0);
  await dialog.getByRole('button', { name: 'Descartar candidato 1', exact: true }).click();
  await dialog.getByText(/1\..* · descartado/).waitFor();
  await dialog.getByRole('button', { name: 'Restablecer revisión', exact: true }).click();
  await dialog.getByLabel('Estado de revisión', { exact: true }).selectOption('pending');
  await dialog.getByRole('button', { name: 'Buscar en zona', exact: true }).click();
  for (const point of [{ x: .25, y: .52 }, { x: .40, y: .70 }]) await coordinates(point);
  await dialog.getByRole('button', { name: 'Buscar aquí con más detalle', exact: true }).click();
  await dialog.getByText('Zona revisada con más detalle. Los candidatos anteriores fuera de ella se conservan.', { exact: true }).waitFor();
  assert.ok(await dialog.locator('svg rect').evaluateAll(nodes => nodes.some(node => {
    const x = Number(node.getAttribute('x')) + Number(node.getAttribute('width')) / 2;
    const y = Number(node.getAttribute('y')) + Number(node.getAttribute('height')) / 2;
    return x >= .25 && x <= .40 && y >= .52 && y <= .70;
  })), 'buscar aquí debe encontrar el estímulo sintético dentro de la zona');
  const pending = await dialog.getByRole('listitem').count();
  await dialog.getByRole('button', { name: 'Aceptar y siguiente · A', exact: true }).click();
  assert.equal(await dialog.getByRole('listitem').count(), pending - 1);
  await dialog.getByRole('button', { name: 'Deshacer revisión', exact: true }).click();
  assert.equal(await dialog.getByRole('listitem').count(), pending);
  await source('Frontal').click();
  assert.ok(await dialog.getByText(/^Indicador en máscara:/).count() > 0);
  await dialog.getByRole('region', { name: 'Candidatos sobre máscara' }).locator('canvas').waitFor();
  const indicator = dialog.getByRole('button', { name: /^Seleccionar en máscara / }).first();
  await indicator.waitFor();
  const maskTarget = Number((await indicator.getAttribute('aria-label')).match(/ (\d+)$/)[1]);
  await indicator.click();
  assert.equal(await indicator.getAttribute('aria-pressed'), 'true', 'el indicador 3D selecciona su candidato en foto');
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).getByRole('listitem').nth(maskTarget - 1).getByRole('button').first().getAttribute('aria-pressed'),
    'true', 'la selección 3D corresponde al número de su observación fotográfica');
  const candidateBox = dialog.locator('svg rect').first();
  const firstItem = dialog.getByRole('list', { name: 'Candidatos multivista' }).getByRole('listitem').first().getByRole('button').first();
  await dialog.getByRole('button', { name: 'Acercar foto', exact: true }).click();
  await candidateBox.scrollIntoViewIfNeeded();
  const zoomedBox = await candidateBox.boundingBox();
  await page.mouse.click(zoomedBox.x + zoomedBox.width / 2, zoomedBox.y + zoomedBox.height / 2);
  assert.equal(await firstItem.getAttribute('aria-pressed'), 'true', 'el zoom mantiene las coordenadas del candidato');
  await dialog.getByRole('button', { name: 'Reencuadrar foto', exact: true }).click();
  if (process.env.QA_SCREENSHOT_DIR) {
    await dialog.locator('header').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.QA_SCREENSHOT_DIR, 'skin-review-desktop.png') });
  }
  const anchors = await page.evaluate(() => {
    const p = window.__skinBasePositions, h = Math.abs(p[31] - p[457]);
    return [168, 1, 2, 0, 17, 152].map(id => ({ x: .3 + p[id * 3 + 2] / h * .65, y: .5 - p[id * 3 + 1] / h * .65 }));
  });
  await source('Ángulo A').click();
  await dialog.getByText('Alinear perfil puro con la máscara', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Marcar seis referencias', exact: true }).click();
  for (const point of anchors) await coordinates(point);
  await dialog.getByRole('button', { name: 'Validar alineación', exact: true }).click();
  await dialog.getByText('Alineación manual aceptada. Vuelve a analizar y comprueba los indicadores en la máscara.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).getByRole('listitem').count(), 0, 'alinear invalida análisis anterior');
  await run();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await page.evaluate(() => performance.memory?.usedJSHeapSize);
  for (let i = 0; i < 2; i++) await run();
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await page.evaluate(() => performance.memory?.usedJSHeapSize);
  if (before && after) assert.ok(after - before < 30 * 1024 * 1024, 'reanalizar no retiene mapas completos de cada ejecución');
  await cdp.detach();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileViews = dialog.getByRole('group', { name: 'Visor de piel en móvil' });
  const selectedBeforeTab = await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText();
  await mobileViews.getByRole('button', { name: 'Máscara 3D', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: 'Acercar foto', exact: true }).isVisible(), false);
  assert.ok(await dialog.getByRole('region', { name: 'Candidatos sobre máscara' }).isVisible());
  await mobileViews.getByRole('button', { name: 'Foto', exact: true }).click();
  assert.equal(await dialog.getByRole('region', { name: 'Candidatos sobre máscara' }).isVisible(), false);
  assert.equal(await dialog.getByRole('list', { name: 'Candidatos multivista' }).innerText(), selectedBeforeTab);
  if (process.env.QA_SCREENSHOT_DIR) {
    await dialog.locator('header').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.QA_SCREENSHOT_DIR, 'skin-review-mobile.png') });
  }
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const count = await dialog.getByRole('listitem').count();
  await page.locator('[data-face-editor]').getByRole('button', { name: 'Morfología', exact: true }).click();
  const appearance = page.locator('[data-face-editor]');
  assert.equal(await appearance.getByRole('slider', { name: 'Margen suave', exact: true }).count(), 0);
  await appearance.getByText('Avanzados de simetría', { exact: true }).click();
  await appearance.getByRole('slider', { name: 'Margen suave', exact: true }).waitFor();
  await page.locator('[data-face-editor]').getByRole('button', { name: 'Piel', exact: true }).click();
  assert.equal(await dialog.getByRole('listitem').count(), count, 'cambiar de herramienta conserva la revisión');
  await appearance.getByRole('group', { name: 'Flujo de piel' }).getByText('Avanzados', { exact: true }).click();
  await appearance.getByRole('button', { name: 'Retoque y zonas', exact: true }).click();
  await appearance.getByRole('region', { name: 'Revisión visual manual por zonas', exact: true }).waitFor();
  await appearance.getByRole('button', { name: 'Buscar y revisar', exact: true }).click();
  assert.equal(await dialog.getByRole('listitem').count(), count, 'retoque no pierde decisiones ni candidatos');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cases: 26, synthetic: true, contrast, durationMs: duration, repeatHeapDeltaMB: before && after ? (after - before) / 1048576 : null,
    manualProfile: true, photoAndMask: true, desktop: 1440, mobile: 390, errors }));
} finally { await browser.close(); }
