/**
 * QA navegador real: layout 3 columnas, navegación cámara, listado/edición y latencia de morfología.
 * Servidor Vite existente (no inicia otro). Atlas genérico + fixture sintético; sin fotos, pacientes ni APIs; red externa bloqueada.
 * Parte 3 es un smoke AISLADO del componente real FacialSimulationViewer (máscara personal sintética), no el flujo clínico completo.
 * PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-layout-navigation.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const URL_LAB = 'http://127.0.0.1:5173/dev/hair-lab';
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const vertex = id => ({ x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] });
const points = Array.from({ length: 50 }, (_, i) => ({ id: `qa${i}`, position: vertex(i * 9), units: 0 }));
const meta = Object.fromEntries(points.map((p, i) => [p.id, i < 40
  ? { mode: 'toxina', product: 'Vial QA ficticio', zone: 'Auto', dose: 0 }
  : { mode: 'relleno_ha', product: 'Vial HA ficticio', zone: 'Auto', dose: 0 }]));
const encoded = JSON.stringify({ mapping_data: { injectionPoints: points, freehandLines: [], surfaceShapes: [], lab: { version: 1, meta } } });

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [], failures = [], errors = [], blocked = [], metrics = {};
const check = async (name, action) => {
  if (process.env.QA_CASE && !new RegExp(process.env.QA_CASE, 'i').test(name)) return;
  try { await action(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error: error.message.split('\n')[0] }); console.log(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
};
const newPage = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', route => /^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(route.request().url())
    ? route.continue() : (blocked.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(URL_LAB, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return page;
};

// Observa el visor real: onAfterRender de MORPHOLOGY_SKIN_AFTER en [data-simulation-viewport], matrices de cámara en mundo,
// OrbitControls.target y eventos input; no sustituye geometría ni lógica.
const instrument = page => page.evaluate(async () => {
  if (window.__qaSim) return;
  const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
  const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
  const orbitUrl = source.match(/import \{ OrbitControls \} from "([^"]+)"/)?.[1];
  const qa = window.__qaSim = { frames: [], inputs: [], longTasks: [], controls: null, center: null, vertices: 0 };
  if (orbitUrl) {
    const { OrbitControls } = await import(orbitUrl);
    const update = OrbitControls.prototype.update;
    OrbitControls.prototype.update = function (...args) {
      if (this.domElement?.closest?.('[data-simulation-viewport]')) qa.controls = this;
      return update.apply(this, args);
    };
  }
  const previous = THREE.Mesh.prototype.onAfterRender;
  let frame = -1, version = -1, hash = 0;
  THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera, geometry) {
    if (this.name === 'MORPHOLOGY_SKIN_AFTER' && renderer.domElement.closest('[data-simulation-viewport]') && renderer.info.render.frame !== frame) {
      frame = renderer.info.render.frame;
      const attr = geometry.attributes.position;
      if (attr.version !== version) {
        let h = 0; const a = attr.array; for (let i = 0; i < a.length; i++) h += a[i] * ((i % 97) + 1);
        hash = h; version = attr.version;
      }
      if (!qa.center) {
        geometry.computeBoundingBox();
        qa.center = geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(this.matrixWorld).toArray();
        qa.vertices = attr.count;
      }
      const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld);
      const c = new THREE.Vector3(...qa.center).project(camera);
      qa.frames.push({ t: performance.now(), version: attr.version, hash, position: position.toArray(), quaternion: quaternion.toArray(),
        zoom: camera.zoom, center: [c.x, c.y], target: qa.controls ? qa.controls.target.toArray() : null });
      if (qa.frames.length > 3000) qa.frames.splice(0, 1500);
    }
    return previous?.apply(this, arguments);
  };
  document.addEventListener('input', event => {
    if (event.target.closest?.('[data-simulation-inspector]')) qa.inputs.push({ t: performance.now(), value: event.target.value });
  }, true);
  try { new PerformanceObserver(list => list.getEntries().forEach(e => qa.longTasks.push({ t: e.startTime, d: e.duration })))
    .observe({ type: 'longtask', buffered: false }); } catch { /* sin longtask */ }
  window.__qaLatency = since => qa.inputs.filter(input => input.t >= since).map(input => {
    const before = [...qa.frames].reverse().find(f => f.t <= input.t);
    const after = before && qa.frames.find(f => f.t > input.t && f.hash !== before.hash);
    return { value: input.value, latency: after ? Math.round(after.t - input.t) : null };
  });
});
const last = page => page.evaluate(() => window.__qaSim.frames.at(-1));
const now = page => page.evaluate(() => performance.now());
const waitFrame = async (page, since, predicate = 'true') => {
  await page.waitForFunction(([since, predicate]) => window.__qaSim.frames.some(f => f.t > since && new Function('f', `return ${predicate}`)(f)),
    [since, predicate], { timeout: 10000 });
  return last(page);
};
const quatEqual = (a, b) => Math.abs(Math.abs(a.reduce((s, v, i) => s + v * b[i], 0)) - 1) < 1e-6;
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const stats = list => {
  const values = list.map(x => x.latency).filter(x => x !== null).sort((a, b) => a - b);
  return { inputs: list.length, measured: values.length, unrendered: list.length - values.length,
    medianMs: values[Math.floor(values.length / 2)] ?? null, p90Ms: values[Math.floor(values.length * 0.9)] ?? null, maxMs: values.at(-1) ?? null };
};
// Arrastre real del range; exige geometría renderizada distinta ANTES de pointerup y mide latencia input→frame.
const dragSlider = async (page, slider, from, to, label) => {
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox(), y = box.y + box.height / 2, x = r => box.x + 8 + (box.width - 16) * r;
  const base = await last(page), since = await now(page);
  await page.mouse.move(x(from), y); await page.mouse.down();
  try {
    for (let s = 1; s <= 8; s++) { await page.mouse.move(x(from + (to - from) * s / 8), y); await page.waitForTimeout(300); }
    await page.waitForFunction(([since, hash]) => window.__qaSim.frames.some(f => f.t > since && f.hash !== hash), [since, base.hash], { timeout: 8000 })
      .catch(() => { throw new Error(`${label}: la geometría no cambió antes de pointerup`); });
    const report = await page.evaluate(since => ({ latency: window.__qaLatency(since),
      longTasks: window.__qaSim.longTasks.filter(t => t.t >= since).map(t => Math.round(t.d)) }), since);
    metrics[label] = { ...stats(report.latency), rawMs: report.latency.map(x => x.latency), value: await slider.inputValue(), longTasksMs: report.longTasks, vertices: await page.evaluate(() => window.__qaSim.vertices) };
    console.log(`METRIC ${label} ${JSON.stringify(metrics[label])}`);
    assert.ok(metrics[label].measured > 0, `${label}: sin latencia medida`);
  } finally { await page.mouse.up(); }
};

try {
  // ---------- Parte 1: Listado / edición (flujo lab, 1440x1000) ----------
  const page = await newPage({ width: 1440, height: 1000 });
  await instrument(page);
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click({ timeout: 120000 });
  await page.getByRole('button', { name: 'Simular y marcar', exact: true }).click({ timeout: 120000 });
  await page.getByRole('tab', { name: /Revisar/ }).click({ timeout: 120000 });
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(encoded);
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Elementos marcados"] li').length >= 50, null, { timeout: 30000 });
  const ledger = page.getByRole('region', { name: 'Listado de puntos', exact: true });
  const list = ledger.getByRole('list', { name: 'Elementos marcados' });
  const count = () => list.locator('li').count();
  await ledger.scrollIntoViewIfNeeded();
  await check('ledger: filtros y selección/plano en acordeones cerrados', async () => {
    const open = await ledger.locator('details').evaluateAll(d => d.map(x => [x.querySelector('summary').textContent, x.open]));
    assert.ok(open.length >= 2, `details: ${JSON.stringify(open)}`);
    assert.ok(open.every(([, o]) => !o), JSON.stringify(open));
  });
  let scrollBefore = 0, filtered = 0;
  await check('ledger: seleccionar marca no oculta listado y listado >= 50% del panel', async () => {
    await page.getByRole('button', { name: 'Seleccionar marca 3', exact: true }).click();
    assert.equal(await list.isVisible(), true);
    assert.equal(await ledger.getByRole('button', { name: 'Listado', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await ledger.getByRole('button', { name: 'Editar marca seleccionada · #3', exact: true }).isVisible(), true);
    const [l, s] = [await list.boundingBox(), await ledger.boundingBox()];
    metrics.ledgerListRatio = +(l.height / s.height).toFixed(3);
    assert.ok(l.height >= s.height * 0.5, `lista ${l.height}px / panel ${s.height}px`);
  });
  await check('ledger: edición explícita no cubre lista y al volver preserva filtro y scroll', async () => {
    await ledger.getByRole('group', { name: 'Filtrar por inyectable' }).getByRole('button', { name: /toxina/i }).click();
    filtered = await count();
    assert.ok(filtered === 40, `filtro toxina: ${filtered}`);
    const scrollable = await list.evaluate(e => e.scrollHeight > e.clientHeight + 20);
    assert.ok(scrollable, 'listado sin desbordamiento vertical para medir scroll');
    await list.evaluate(e => { e.scrollTop = Math.min(300, e.scrollHeight - e.clientHeight); });
    scrollBefore = await list.evaluate(e => e.scrollTop);
    await ledger.getByRole('button', { name: 'Editar marca seleccionada · #3', exact: true }).click();
    const inspector = ledger.getByRole('region', { name: 'Marca seleccionada' });
    assert.equal(await inspector.isVisible(), true);
    assert.equal(await list.isVisible(), false, 'la lista debe quedar en panel excluyente');
    assert.equal(await ledger.getByRole('button', { name: 'Editar selección', exact: true }).getAttribute('aria-pressed'), 'true');
    const [i, s] = [await inspector.boundingBox(), await ledger.boundingBox()];
    assert.ok(i.y >= s.y - 1 && i.y + Math.min(i.height, s.height) <= s.y + s.height + 1, 'edición contenida en el panel');
    await ledger.getByRole('button', { name: 'Listado', exact: true }).click();
    assert.equal(await list.isVisible(), true);
    assert.equal(await count(), filtered, 'filtro preservado');
    assert.equal(await ledger.getByRole('group', { name: 'Filtrar por inyectable' }).getByRole('button', { name: /toxina/i }).getAttribute('aria-pressed'), 'true');
    const scrollAfter = await list.evaluate(e => e.scrollTop);
    metrics.ledgerScroll = { before: scrollBefore, after: scrollAfter };
    assert.ok(Math.abs(scrollAfter - scrollBefore) <= 2, `scroll ${scrollBefore} → ${scrollAfter}`);
  });

  // ---------- Parte 2: visor morfológico genérico (flujo lab) ----------
  await page.getByRole('navigation', { name: 'Grupos del editor' }).getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  const sim = page.locator('[data-face-appearance-group]');
  await sim.locator('[data-simulation-viewport][data-ready="true"]').waitFor({ timeout: 120000 });
  const canvas = sim.locator('[data-simulation-viewport] canvas');
  const btn = name => sim.getByRole('button', { name, exact: true });
  let t = await now(page);
  await btn('Frontal').click();
  await canvas.focus(); await page.keyboard.press('0');
  let baseline = await waitFrame(page, t);
  await page.waitForTimeout(900);
  baseline = await last(page);
  await check('layout desktop 1440: Herramientas | centro visor | Inspector, visor centrado', async () => {
    const [left, center, right] = [await sim.getByRole('complementary', { name: 'Herramientas de simulación' }).boundingBox(),
      await sim.locator('[data-simulation-center]').boundingBox(), await sim.getByRole('complementary', { name: 'Inspector de simulación' }).boundingBox()];
    metrics.desktopColumns = { left, center, right };
    assert.ok(left.x + left.width <= center.x + 1 && center.x + center.width <= right.x + 1, 'orden de columnas');
    assert.ok(Math.abs(left.y - center.y) < 4 && Math.abs(center.y - right.y) < 4, 'misma fila');
    assert.ok(center.width > left.width && center.width > right.width, 'centro dominante');
    const v = await canvas.boundingBox();
    assert.ok(v.y >= -1 && v.y + v.height <= 1001 && v.height >= 300, `visor dentro de pantalla ${JSON.stringify(v)}`);
    assert.ok(Math.abs(baseline.center[0]) < 0.15 && Math.abs(baseline.center[1]) < 0.15, `modelo centrado ${baseline.center}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  });
  await check('región morfológica: subgrupos y restablecer por región', async () => {
    const groups = sim.getByRole('group', { name: 'Región morfológica' }).getByRole('button');
    const names = await groups.allTextContents();
    assert.ok(names.length >= 4, JSON.stringify(names));
    for (const name of names) {
      await groups.filter({ hasText: name }).first().click();
      assert.equal(await sim.getByRole('heading', { name: `Morfología · ${name}` }).isVisible(), true);
      assert.equal(await sim.locator('[data-simulation-inspector] fieldset:visible legend').textContent(), name);
    }
    await groups.filter({ hasText: 'Labios' }).click();
    await sim.locator('input[id$="-lipUpper"]').fill('0.5');
    await groups.filter({ hasText: 'Nariz' }).click();
    await sim.locator('input[id$="-noseBridge"]').fill('0.6');
    await btn('Restablecer nariz').click();
    assert.equal(await sim.locator('input[id$="-noseBridge"]').inputValue(), '0');
    assert.equal(await sim.locator('input[id$="-lipUpper"]').inputValue(), '0.5', 'otra región intacta');
  });
  t = await now(page);
  await sim.locator('input[id$="-noseBridge"]').fill('0.6');
  const deformed = await waitFrame(page, t, `f.hash !== ${baseline.hash}`);
  let panned;
  await check('pan por arrastre: cámara y target se trasladan sin rotar', async () => {
    await btn('Desplazar').click();
    assert.equal(await btn('Desplazar').getAttribute('aria-pressed'), 'true');
    const before = await last(page), box = await canvas.boundingBox();
    t = await now(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 45, { steps: 10 }); await page.mouse.up();
    await waitFrame(page, t); await page.waitForTimeout(200);
    panned = await last(page);
    metrics.pan = { cameraDelta: dist(panned.position, before.position), targetObserved: !!panned.target, centerBefore: before.center, centerAfter: panned.center };
    assert.ok(quatEqual(panned.quaternion, before.quaternion), 'el pan no debe rotar la cámara');
    assert.ok(metrics.pan.cameraDelta > 1e-4, 'la cámara debe trasladarse');
    assert.ok(panned.target && before.target, 'OrbitControls.target observado');
    const dp = panned.position.map((v, i) => v - before.position[i]), dt = panned.target.map((v, i) => v - before.target[i]);
    assert.ok(dist(dp, dt) < 1e-6 * Math.max(1, metrics.pan.cameraDelta) + 1e-9, `target sigue a la cámara ${dp} vs ${dt}`);
    assert.ok(panned.center[0] > before.center[0] + 0.02 && panned.center[1] < before.center[1] - 0.01, 'el modelo sigue al cursor');
    assert.equal(panned.hash, deformed.hash, 'pan no altera geometría');
  });
  await check('zoom con botones Acercar/Alejar', async () => {
    let before = await last(page); t = await now(page);
    await sim.getByRole('button', { name: 'Acercar modelo' }).click();
    let after = await waitFrame(page, t, `f.zoom !== ${before.zoom}`);
    assert.ok(Math.abs(after.zoom / before.zoom - 1.25) < 1e-6, `acercar ${before.zoom}→${after.zoom}`);
    before = after; t = await now(page);
    await sim.getByRole('button', { name: 'Alejar modelo' }).click();
    after = await waitFrame(page, t, `f.zoom !== ${before.zoom}`);
    assert.ok(Math.abs(after.zoom / before.zoom - 0.8) < 1e-6);
    t = await now(page); await sim.getByRole('button', { name: 'Acercar modelo' }).click(); await waitFrame(page, t);
  });
  await check('Reencuadrar centra, zoom 1, conserva orientación y deformación', async () => {
    const before = await last(page); t = await now(page);
    await btn('Reencuadrar').click();
    const after = await waitFrame(page, t, 'f.zoom === 1');
    assert.ok(quatEqual(after.quaternion, before.quaternion), 'orientación conservada');
    assert.ok(dist(after.center, baseline.center) < 0.02, `centro ${after.center} vs ${baseline.center}`);
    assert.equal(after.hash, deformed.hash, 'deformación conservada');
    assert.notEqual(after.hash, baseline.hash);
  });
  await check('teclado: Mayús+flechas desplaza sin rotar, +/− zoom, 0 reencuadra', async () => {
    await canvas.focus();
    let before = await last(page); t = await now(page);
    await page.keyboard.press('Shift+ArrowRight');
    let after = await waitFrame(page, t);
    assert.ok(quatEqual(after.quaternion, before.quaternion) && dist(after.position, before.position) > 1e-4, 'Mayús+→ traslada');
    assert.ok(after.center[0] < before.center[0], 'cámara a la derecha mueve modelo a la izquierda');
    t = await now(page); await page.keyboard.press('Shift+ArrowUp'); after = await waitFrame(page, t);
    before = after; t = await now(page);
    await page.keyboard.press('+');
    after = await waitFrame(page, t, `f.zoom > ${before.zoom}`);
    t = await now(page); await page.keyboard.press('-');
    after = await waitFrame(page, t, `f.zoom < ${after.zoom}`);
    t = await now(page); await page.keyboard.press('0');
    after = await waitFrame(page, t, 'f.zoom === 1');
    assert.ok(dist(after.center, baseline.center) < 0.02, `0 reencuadra ${after.center}`);
    assert.equal(after.hash, deformed.hash);
  });
  await check('Girar sigue rotando (regresión)', async () => {
    await btn('Girar').click();
    const before = await last(page), box = await canvas.boundingBox(); t = await now(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    const after = await waitFrame(page, t);
    assert.ok(!quatEqual(after.quaternion, before.quaternion), 'orbit debe rotar');
    t = await now(page); await btn('Frontal').click(); await btn('Orbitar').click().catch(() => {});
    await canvas.focus(); await page.keyboard.press('0');
  });
  await sim.locator('input[id$="-noseBridge"]').fill('0');
  await page.waitForTimeout(500);
  await check('genérico: slider Dorso·proyección deforma antes de pointerup (latencia)', async () =>
    dragSlider(page, sim.locator('input[id$="-noseBridge"]'), 0.5, 0.85, 'generic.noseBridge'));
  await check('genérico: slider simetría nasal deforma antes de pointerup (latencia)', async () =>
    dragSlider(page, sim.getByLabel(/^Intensidad de simetría nasal/), 0, 0.9, 'generic.noseSymmetry'));
  await check('móvil 390: visor sin overflow horizontal', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'overflow horizontal');
    for (const region of [sim.getByRole('complementary', { name: 'Herramientas de simulación' }), sim.locator('[data-simulation-center]'),
      sim.getByRole('complementary', { name: 'Inspector de simulación' }), canvas]) {
      const b = await region.boundingBox();
      assert.ok(b && b.x >= -1 && b.x + b.width <= 391 && b.width > 100, `región fuera ${JSON.stringify(b)}`);
    }
    for (const name of ['Girar', 'Desplazar', 'Reencuadrar']) assert.equal(await btn(name).isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await page.context().close();

  // ---------- Parte 3: smoke AISLADO del componente real con máscara personal sintética ----------
  const isolated = await newPage({ width: 1440, height: 1000 });
  await instrument(isolated);
  await check('aislado: monta FacialSimulationViewer real con superficie personal sintética', async () => {
    await isolated.evaluate(async ({ fixture, triangles }) => {
      const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
      const reactUrl = source.match(/"(\/node_modules\/\.vite\/deps\/react\.js\?v=[^"]+)"/)[1];
      const reactModule = await import(reactUrl), React = reactModule.default ?? reactModule;
      const client = await import(`/node_modules/.vite/deps/react-dom_client.js?v=${reactUrl.split('?v=')[1]}`);
      const createRoot = client.createRoot ?? client.default.createRoot;
      const { buildPersonalSurface } = await import('/src/lab/faceSim/engine.ts');
      const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
      const surface = buildPersonalSurface(fixture.landmarks.map(([x, y, z]) => ({ x, y, z })), fixture.aspect, triangles);
      if (!surface) throw new Error('superficie sintética nula');
      const photo = document.createElement('canvas');
      photo.width = 480; photo.height = Math.round(480 / fixture.aspect);
      const g = photo.getContext('2d'), grad = g.createLinearGradient(0, 0, photo.width, photo.height);
      grad.addColorStop(0, 'rgb(214,170,140)'); grad.addColorStop(1, 'rgb(150,110,90)');
      g.fillStyle = grad; g.fillRect(0, 0, photo.width, photo.height);
      document.getElementById('root').style.display = 'none';
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:8px;background:#0c0a09;z-index:2147483000';
      document.body.append(host);
      createRoot(host).render(React.createElement(FacialSimulationViewer, { surface, photo }));
    }, { fixture, triangles: atlas.triangles });
    await isolated.locator('[data-simulation-viewport][data-ready="true"]').waitFor({ timeout: 120000 });
    await isolated.waitForFunction(() => window.__qaSim.frames.length > 0, null, { timeout: 30000 });
    metrics.personalVertices = await isolated.evaluate(() => window.__qaSim.vertices);
    assert.ok(metrics.personalVertices > 468, `malla refinada ${metrics.personalVertices}`);
  });
  await check('personal: slider Dorso·proyección deforma antes de pointerup (latencia)', async () =>
    dragSlider(isolated, isolated.locator('input[id$="-noseBridge"]'), 0.5, 0.85, 'personal.noseBridge'));
  await check('personal: slider simetría nasal deforma antes de pointerup (latencia)', async () =>
    dragSlider(isolated, isolated.getByLabel(/^Intensidad de simetría nasal/), 0, 0.9, 'personal.noseSymmetry'));
  await isolated.context().close();
  // Peticiones externas (p. ej. Google Fonts de index.html) quedan abortadas y se reportan en locked.
  await check('sin errores JavaScript (red externa abortada)', async () => assert.deepEqual(errors, []));
} catch (error) {
  failures.push({ name: 'setup', error: error.message.split('\n')[0] });
  console.log(`FAIL setup: ${error.message}`);
} finally {
  console.log(JSON.stringify({ passed: checks.length, failed: failures.length, checks, failures, metrics, errors, blocked }, null, 2));
  if (failures.length) process.exitCode = 1;
  await browser.close();
}
