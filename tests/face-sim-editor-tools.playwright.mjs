/**
 * QA navegador real, atlas sintético; servidor existente, sin pacientes ni autenticación.
 * PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-editor-tools.playwright.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [], failures = [], errors = [], blocked = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => /^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(route.request().url())
    ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const check = async (name, action) => {
    if (process.env.QA_CASE && !new RegExp(process.env.QA_CASE, 'i').test(name)) return;
    try { await action(); checks.push(name); console.log(`PASS ${name}`); }
    catch (error) {
      const status = await page.getByRole('status').allTextContents();
      failures.push({ name, error: error.message, status }); console.log(`FAIL ${name}: ${error.message}; ${JSON.stringify(status)}`);
    }
  };
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await button('Simulación facial').click({ timeout: 120000 });
  await button('Simular y marcar').click({ timeout: 120000 });
  const canvas = page.locator('canvas:visible');
  await canvas.waitFor({ timeout: 120000 });
  await page.waitForTimeout(1400);
  // Observación del render real (sin sustituir geometría ni callbacks de negocio).
  await page.evaluate(async () => {
    const source = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const previous = THREE.Mesh.prototype.onAfterRender;
    let frame = -1;
    window.__qaRender = { frames: 0, signature: '', points: {} };
    THREE.Mesh.prototype.onAfterRender = function(renderer, scene, camera) {
      if (frame !== renderer.info.render.frame) {
        frame = renderer.info.render.frame;
        const materials = [], points = {};
        scene.traverse(object => {
          if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material])
            materials.push([object.name, object.visible, material.opacity, material.clippingPlanes?.map(p => [p.constant, ...p.normal.toArray()])]);
          if (object.userData.editableId) {
            const p = object.getWorldPosition(new THREE.Vector3()).project(camera);
            points[object.userData.editableId] = { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
          }
        });
        window.__qaRender = { frames: window.__qaRender.frames + 1, signature: JSON.stringify(materials), points, meshes: materials.length };
      }
      return previous?.apply(this, arguments);
    };
  });
  await page.waitForFunction(() => window.__qaRender?.meshes > 0, null, { timeout: 120000 });
  console.log('READY atlas render real');
  const count = () => page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count();
  const exported = async () => {
    const activeTab = await page.getByRole('tab', { selected: true }).getAttribute('id');
    await page.getByRole('tab', { name: /Revisar/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), button('Exportar JSON de Inyectables').click()]);
    const stream = await download.createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk;
    const mapping = JSON.parse(text).mapping_data;
    if (activeTab) await page.locator(`[id="${activeTab}"]`).click();
    return { ...mapping, ...mapping.lab };
  };
  const position = async (x, y) => {
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    return { x: box.x + box.width * x, y: box.y + box.height * y };
  };
  const clickAt = async (x, y) => { const p = await position(x, y); await page.mouse.click(p.x, p.y); };
  const drag = async (a = [.46, .55], b = [.48, .57]) => {
    const start = await position(...a), end = await position(...b);
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(250);
  };
  const dialog = page.getByRole('dialog');
  const save = async (recording = true) => {
    await dialog.waitFor();
    const toggle = dialog.getByLabel('Crear puntos de registro', { exact: true });
    if (await toggle.count()) await toggle.setChecked(recording);
    if (recording) {
      await dialog.getByLabel(/Volumen por punto/).fill('2');
      await dialog.getByLabel('Plano de aplicación', { exact: true }).selectOption({ index: 1 });
    }
    await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await check('desktop sin overflow y grupos accesibles', async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const tools = page.getByRole('group', { name: 'Herramientas de marcación', exact: true });
    for (const name of ['Vista', 'Marcar', 'Trazos', 'Figuras', 'Patrones', 'Notas'])
      assert.equal(await tools.getByRole('group', { name, exact: true }).count(), 1);
  });
  await check('cámara no crea marcas', async () => { await clickAt(.5, .5); assert.equal(await count(), 0); });
  await check('punto con dosis y plano', async () => {
    await page.getByLabel('Producto / vial', { exact: true }).fill('QA vial A sintético');
    await button('Punto').click(); await clickAt(.5, .5); await save();
    assert.equal(await count(), 1);
  });
  await check('imán on/off', async () => {
    const magnet = page.getByLabel('Imán sobre puntos y trazos', { exact: true });
    assert.equal(await magnet.isChecked(), true); await magnet.uncheck();
    assert.equal(await magnet.isChecked(), false); await magnet.check(); await magnet.uncheck();
  });
  for (const name of ['Línea', 'Flecha', 'Pincel', 'Polilínea', 'Círculo', 'Rectángulo', 'Óvalo', 'Texto', 'Regla de proporciones', 'Abanico', 'Malla', 'Helecho']) {
    await check(`crear ${name}`, async () => {
      const before = await count();
      await button(name).click();
      if (['Abanico', 'Malla', 'Helecho'].includes(name)) await dialog.getByRole('button', { name: 'Trazar', exact: true }).click();
      if (name === 'Texto') {
        await page.getByLabel('Texto para nuevas notas', { exact: true }).fill('Nota QA sintética');
        await clickAt(.53, .48);
      } else if (name === 'Polilínea') {
        await clickAt(.46, .55); await page.waitForTimeout(400);
        await clickAt(.47, .56); await page.waitForTimeout(400);
        const p = await position(.48, .57); await page.mouse.dblclick(p.x, p.y);
      } else if (name === 'Malla') {
        await clickAt(.46, .52); await clickAt(.54, .52); await clickAt(.54, .6);
      } else if (name === 'Helecho') await drag([.48, .38], [.52, .4]);
      else await drag();
      const graphical = ['Pincel', 'Polilínea', 'Círculo', 'Rectángulo', 'Óvalo', 'Texto', 'Regla de proporciones'].includes(name);
      if (graphical) assert.equal(await dialog.isVisible(), false, `${name} no abre volumen`);
      else await save();
      assert.ok(await count() > before, `${name} debe añadir registro`);
    });
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
  }
  await check('línea sin puntos, dosis ni plano y memoria de sesión', async () => {
    await button('Línea').click(); await drag([.47, .45], [.53, .48]); await save(false);
    let data = await exported();
    assert.ok(Object.values(data.meta).some(meta => meta.graphicOnly && meta.dose === 0 && !meta.plane));
    await button('Flecha').click(); await drag([.47, .47], [.53, .5]);
    assert.equal(await dialog.getByLabel('Crear puntos de registro', { exact: true }).isChecked(), false);
    await save(false);
    data = await exported();
    assert.ok(Object.values(data.meta).filter(meta => meta.graphicOnly).length >= 2);
  });
  if (await dialog.isVisible()) await page.keyboard.press('Escape');
  await check('Escape cancela trazo y vuelve cámara', async () => {
    const before = await count(); await button('Línea').click();
    const p = await position(.46, .52), q = await position(.55, .6);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await button('Mover cámara').getAttribute('aria-pressed'), 'true');
    assert.equal(await count(), before); assert.equal(await dialog.isVisible(), false);
  });
  await check('Escape dentro de input no roba herramienta', async () => {
    await button('Texto').click(); await page.getByLabel('Texto para nuevas notas', { exact: true }).focus();
    await page.keyboard.press('Escape'); assert.equal(await button('Texto').getAttribute('aria-pressed'), 'true');
  });
  await check('color independiente de grosor y registro', async () => {
    await button('Seleccionar marca 1').click();
    const before = await exported();
    await button('Seleccionar marca 1').click();
    const width = page.getByLabel('Grosor de la marca', { exact: true });
    const previous = await width.inputValue();
    await page.getByLabel('Color de la marca', { exact: true }).fill('#12ab78');
    assert.equal(await width.inputValue(), previous);
    await width.fill('2.5');
    assert.equal(await page.getByLabel('Color de la marca', { exact: true }).inputValue(), '#12ab78');
    const after = await exported();
    assert.equal(Object.values(after.meta)[0].dose, Object.values(before.meta)[0].dose);
  });
  await check('mover punto conserva dosis plano vial', async () => {
    await button('Seleccionar marca 1').click();
    const before = await exported(), id = Object.keys(before.meta).find(id => !before.meta[id].graphicOnly && !before.meta[id].parent && !before.meta[id].entry);
    assert.ok(id);
    await button('Seleccionar marca 1').click();
    await button('Seleccionar / editar').click();
    await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    const projected = await page.evaluate(id => window.__qaRender.points[id], id);
    assert.ok(projected, 'punto editable observado en render');
    const point = await position(projected.x, projected.y);
    console.log('MOVE_POINT', JSON.stringify({ id, point, marker: before.injectionPoints.find(p => p.id === id) }));
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 4, point.y + 2, { steps: 8 }); await page.mouse.up();
    const after = await exported();
    assert.notDeepEqual(after.injectionPoints.find(p => p.id === id)?.position,
      before.injectionPoints.find(p => p.id === id)?.position, 'la posición del punto debe cambiar');
    for (const key of ['dose', 'plane', 'product', 'mode']) assert.deepEqual(after.meta[id][key], before.meta[id][key]);
  });
  await check('mover punta adjunta conserva plano dosis vial y mueve extremo', async () => {
    const before = await exported();
    const id = Object.keys(before.meta).find(id => before.meta[id].parent);
    assert.ok(id, 'hay punta adjunta registrada');
    const parent = before.meta[id].parent;
    await button('Seleccionar / editar').click(); await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const projected = await page.evaluate(id => window.__qaRender.points[id], id);
    assert.ok(projected);
    const point = await position(projected.x, projected.y);
    console.log('MOVE_TIP', JSON.stringify({ id, parent, point, marker: before.injectionPoints.find(p => p.id === id) }));
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 4, point.y + 2, { steps: 8 }); await page.mouse.up();
    const after = await exported();
    assert.notDeepEqual(after.injectionPoints.find(p => p.id === id)?.position,
      before.injectionPoints.find(p => p.id === id)?.position, 'la punta debe cambiar de posición');
    assert.notDeepEqual(after.freehandLines, before.freehandLines, `rama ${parent} debe cambiar con la punta`);
    for (const key of ['dose', 'plane', 'product', 'mode', 'parent']) assert.deepEqual(after.meta[id][key], before.meta[id][key]);
  });
  await check('HUD vial activo afecta solo futuras marcas', async () => {
    const before = await exported();
    await page.getByRole('tab', { name: /Inyectable/ }).click();
    await page.getByLabel('Producto / vial', { exact: true }).fill('Vial QA ficticio');
    const hud = page.getByRole('list', { name: 'Volumen acumulado', exact: true }).getByRole('button').first();
    await hud.click(); assert.equal(await hud.getAttribute('aria-pressed'), 'true');
    const after = await exported(); assert.deepEqual(after.meta, before.meta);
    await button('Punto').click(); await clickAt(.5, .35); await save();
    const updated = await exported();
    const newId = Object.keys(updated.meta).find(id => !before.meta[id]);
    assert.ok(newId);
    assert.equal(updated.meta[newId].product, Object.values(before.meta).find(meta => !meta.graphicOnly && !meta.entry).product);
  });
  await check('selección visibles / registro / clear y patrones plegables montados', async () => {
    await page.getByLabel('Seleccionar todos los puntos visibles', { exact: true }).check();
    await button('Todo el registro').click();
    const picks = page.getByLabel(/^Incluir marca \d+ en lote$/);
    for (let i = 0; i < await picks.count(); i++) assert.equal(await picks.nth(i).isChecked(), true);
    await button('Deseleccionar todo').click();
    for (let i = 0; i < await picks.count(); i++) assert.equal(await picks.nth(i).isChecked(), false);
    const fold = page.getByRole('button', { name: /puntas en el filtro/ }).first();
    const n = await count(); await fold.click(); await fold.click(); assert.equal(await count(), n);
  });
  await check('Revisar limpio conserva registro y efectos; selección vuelve a editar', async () => {
    const before = await exported();
    await page.getByRole('tab', { name: /Revisar/ }).click();
    for (const name of ['Mostrar puntos registrados', 'Mostrar trazos y notas', 'Mostrar referencias anatómicas']) {
      const toggle = page.getByLabel(name, { exact: true });
      assert.equal(await toggle.isChecked(), false); await toggle.check(); await toggle.uncheck();
    }
    for (const name of ['Toxina', 'Relleno HA', 'Hidratación', 'Bioestimulador']) {
      assert.equal(await page.getByLabel(`Efecto ${name}`, { exact: true }).isChecked(), true);
      await page.getByLabel(`Cobertura visual ${name}`, { exact: true }).fill('1.5');
      await page.getByLabel(`Intensidad ${name}`, { exact: true }).fill('1.5');
    }
    const after = await exported(); assert.deepEqual(after.meta, before.meta);
    await button('Seleccionar marca 1').click();
    assert.equal(await button('Seleccionar / editar').getAttribute('aria-pressed'), 'true');
  });
  await check('móvil390 sin overflow, herramientas accesibles', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    for (const name of ['Punto', 'Óvalo', 'Texto', 'Regla de proporciones']) assert.equal(await button(name).isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check('profundidad renderiza cambio antes de pointerup', async () => {
    await page.getByRole('tab', { name: /Capas y corte/ }).click();
    await button('Profundidad').click();
    const slider = page.getByLabel('Profundidad del corte', { exact: true });
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2); await page.mouse.down();
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => window.__qaRender);
    await page.mouse.move(box.x + box.width * .72, box.y + box.height / 2, { steps: 8 });
    try {
      await page.waitForFunction(before => window.__qaRender.frames > before.frames && window.__qaRender.signature !== before.signature, before, { timeout: 5000 });
      assert.ok(Number(await slider.inputValue()) > .5);
    } finally { await page.mouse.up(); }
    await button('Sin corte').click();
  });
  await check('sin errores JavaScript', async () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed: checks.length, failed: failures.length, checks, failures, blocked }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await browser.close(); }
