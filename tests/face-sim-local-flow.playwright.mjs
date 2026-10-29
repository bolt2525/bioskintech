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
    if (request.url().includes('/api/')) remote.push(request.url());
  });
  page.on('response', response => {
    if (!response.url().startsWith('http://127.0.0.1:5173/') && !/^(data:|blob:)/.test(response.url())) remote.push(response.url());
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
  let bounds = await canvas.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100);
  const at = (x, y) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  // Cámara no registra ni al hacer clic ni al arrastrar.
  await page.mouse.click(at(0.5, 0.5).x, at(0.5, 0.5).y);
  assert.equal(await count(), 0);
  await page.getByRole('button', { name: 'Punto', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Antes', exact: true }).getAttribute('aria-pressed'), 'true');
  await canvas.waitFor({ state: 'visible' }); await page.waitForTimeout(700);
  await canvas.scrollIntoViewIfNeeded();
  bounds = await canvas.boundingBox();
  // Varias posiciones interiores, sin asumir la proyección exacta del visor compartido.
  for (const [x, y] of [[0.5, 0.5], [0.45, 0.6], [0.55, 0.6]]) {
    const p = at(x, y); await page.mouse.click(p.x, p.y); await page.waitForTimeout(600);
    if (await count()) break;
  }
  assert.ok(await count() > 0, `El raycast no creó una marca. Estado: ${await page.getByRole('status').allTextContents()}`);
  // Cada marca abre el modal de volumen: dosis y plano opcional en un solo paso.
  const volumeDialog = page.getByRole('dialog');
  await volumeDialog.getByLabel('Volumen por punto (U)', { exact: true }).fill('7.5');
  await volumeDialog.getByLabel('Plano de aplicación', { exact: true }).selectOption({ index: 1 });
  await volumeDialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  await volumeDialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => /7\.5\s*U/.test(document.querySelector('[aria-label="Volumen acumulado"]')?.textContent ?? ''));
  const initialCount = await count();
  const dose = page.getByLabel('Dosis marca 1', { exact: true });
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  const divided = page.getByLabel('Visor dividido · genérico y máscara', { exact: true });
  await divided.check();
  const generic = page.getByRole('region', { name: 'Modelo genérico 3D', exact: true });
  const personal = page.getByRole('region', { name: 'Foto personal en 3D', exact: true });
  assert.equal(await generic.locator('canvas').count(), 1);
  assert.equal(await personal.getByRole('status').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Preparar máscara personal', exact: true }).isDisabled(), true);
  // Foto ficticia: render del mismo GLB público empleado por el atlas, sin datos de pacientes.
  const synthetic = await page.evaluate(async () => {
    const source = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const { GLTFLoader } = await import(source.match(/import \{ GLTFLoader \} from "([^"]+)"/)[1]);
    const model = (await new GLTFLoader().loadAsync('/models/clinical/male_head.glb')).scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse(mesh => {
      if (!mesh.isMesh || mesh.name === 'SCALP_HAIR_SOURCE') return;
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    });
    const scale = 5 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
    model.scale.setScalar(scale); model.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#d9dce1');
    scene.add(model, new THREE.HemisphereLight(0xffffff, 0x645344, 2));
    for (const [intensity, x, y, z] of [[3, -3, 5, 8], [1, 3, 1, 5]]) {
      const light = new THREE.DirectionalLight(0xffffff, intensity); light.position.set(x, y, z); scene.add(light);
    }
    const material = new THREE.MeshStandardMaterial({ color: '#cda48c', roughness: 0.8 });
    model.traverse(mesh => { if (mesh.isMesh) mesh.material = material; });
    const camera = new THREE.OrthographicCamera(-2.65, 2.65, 2.65, -2.65, 0.1, 30);
    camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1400, 1400); renderer.render(scene, camera);
    const image = renderer.domElement.toDataURL('image/png');
    renderer.dispose(); model.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); }); material.dispose();
    window.__splitRendered = {};
    const previous = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene) {
      const label = renderer.domElement.closest('section[aria-label="Modelo genérico 3D"], section[aria-label="Foto personal en 3D"]')?.getAttribute('aria-label');
      if (label) {
        const ids = new Set();
        scene.traverse(object => { if (object.userData.editableId) ids.add(object.userData.editableId); });
        window.__splitRendered[label] = [...ids].sort();
      }
      return previous?.apply(this, arguments);
    };
    return image;
  });
  await space.getByRole('button', { name: 'Capturas', exact: true }).click();
  await page.getByLabel('Cargar Frontal', { exact: true }).setInputFiles({
    name: 'rostro-sintetico.png', mimeType: 'image/png', buffer: Buffer.from(synthetic.split(',')[1], 'base64'),
  });
  const review = page.getByRole('dialog');
  await review.waitFor({ timeout: 90000 });
  await review.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
  await page.getByLabel('Confirmar captura Frontal', { exact: true }).check();
  await space.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.getByRole('button', { name: 'Preparar máscara personal', exact: true }).click();
  await personal.locator('canvas').waitFor({ timeout: 90000 });
  assert.equal(await page.locator('canvas:visible').count(), 2);
  await page.waitForFunction(count => {
    const a = window.__splitRendered['Modelo genérico 3D'], b = window.__splitRendered['Foto personal en 3D'];
    return a?.length === count && JSON.stringify(a) === JSON.stringify(b);
  }, initialCount);
  await page.getByRole('button', { name: 'Punto', exact: true }).click();
  await personal.locator('canvas').scrollIntoViewIfNeeded();
  const personalBox = await personal.locator('canvas').boundingBox();
  for (const [x, y] of [[0.45, 0.55], [0.55, 0.6], [0.5, 0.4]]) {
    await page.mouse.click(personalBox.x + personalBox.width * x, personalBox.y + personalBox.height * y);
    await page.waitForTimeout(500);
    if (await count() > initialCount) break;
  }
  assert.equal(await count(), initialCount + 1, 'Marcar en la máscara añade un único registro compartido.');
  await page.waitForFunction(count => {
    const a = window.__splitRendered['Modelo genérico 3D'], b = window.__splitRendered['Foto personal en 3D'];
    return a?.length === count && JSON.stringify(a) === JSON.stringify(b);
  }, initialCount + 1);
  if (await volumeDialog.isVisible()) {
    await volumeDialog.getByLabel('Volumen por punto (U)', { exact: true }).fill('2');
    await volumeDialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.equal(await count(), initialCount);
  await page.setViewportSize({ width: 390, height: 844 });
  const genericBox = await generic.boundingBox(), stackedBox = await personal.boundingBox();
  assert.ok(stackedBox.y >= genericBox.y + genericBox.height, 'En móvil los visores se apilan.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await divided.uncheck();
  assert.equal(await page.locator('canvas:visible').count(), 1);
  assert.equal(await count(), initialCount);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log(JSON.stringify({ passed: true, marks: initialCount, desktop: '1440×1000', mobile: '390×844',
    externalResourcesBlocked: blocked.length,
    checks: ['dos espacios', 'cámara sin marcas', 'raycast punto', 'edición', 'dosis independiente', '4 efectos',
      'antes/después', 'export/import', 'quitar/undo', 'registro persistente entre espacios',
      'grupos internos', 'morfología/piel/capas/corte', 'estado avanzado conservado', 'un viewport visible',
      'visor dividido', 'transferencia visible genérico/máscara', 'registro único desde máscara', 'apilado móvil',
      'sin red externa', 'sin overflow móvil'] }, null, 2));
} finally {
  await browser.close();
}
