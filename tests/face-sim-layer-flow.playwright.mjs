/**
 * Visor real aislado: capas, recorrido bidireccional, corte e independencia.
 * Solo modelo genérico y recursos locales; sin fotos clínicas ni APIs.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://127.0.0.1:5173/dev/hair-lab') return route.fulfill({
      contentType: 'text/html', body: `<html><head><link rel="stylesheet" href="/src/index.css">
        <script type="module">import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script>
        </head><body><div id="root"></div></body></html>`,
    });
    return /^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(route.request().url())
      ? route.continue() : route.abort();
  });
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
    const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
    const original = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene) {
      if (renderer.domElement.closest('[data-simulation-viewport]')) {
        const refs = {};
        let skin;
        scene.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          if (object.name === 'MORPHOLOGY_SKIN_AFTER') skin = object;
          if (object.name === 'ALIGNED_ANATOMICAL_REFERENCE') refs[object.userData.kind] = {
            visible: object.visible, opacity: object.material.opacity,
            clips: object.material.clippingPlanes.map(plane => [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant]),
          };
        });
        if (skin) window.__layerFrame = {
          time: performance.now(), refs, skin: {
            visible: skin.visible, opacity: skin.material[0].opacity,
            clips: skin.material[0].clippingPlanes.map(plane => [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant]),
          },
        };
      }
      return original?.apply(this, arguments);
    };
    const reactUrl = source.match(/"(\/node_modules\/\.vite\/deps\/react\.js\?v=[^"]+)"/)[1];
    const reactModule = await import(reactUrl), React = reactModule.default ?? reactModule;
    const client = await import(`/node_modules/.vite/deps/react-dom_client.js?v=${reactUrl.split('?v=')[1]}`);
    const { FacialSimulationViewer } = await import('/src/lab/faceSim/FacialSimulationViewer.tsx');
    document.getElementById('root').style.display = 'none';
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:8px;background:#0c0a09;z-index:2147483000';
    document.body.append(host);
    (client.createRoot ?? client.default.createRoot)(host).render(React.createElement(FacialSimulationViewer));
  });
  const sim = page.locator('[data-face-editor]');
  await sim.locator('[data-simulation-viewport][data-ready="true"]').waitFor();
  await page.waitForFunction(() => window.__layerFrame?.skin.opacity === 1);
  const button = name => sim.getByRole('button', { name, exact: true });
  await button('Capas').click();
  await button('Músculo').click();
  await page.waitForFunction(() => window.__layerFrame.refs.muscle?.visible && window.__layerFrame.refs.muscle.opacity > 0.5
    && window.__layerFrame.refs.vessels?.visible && window.__layerFrame.refs.vessels.opacity > 0.1);
  assert.equal(await sim.getByLabel('Mostrar mallado de zonas', { exact: true }).isChecked(), false);
  checks.push('Músculo visible con arterias por defecto, sin activar mallado');
  await sim.getByText('Visibilidad y opacidades', { exact: true }).click();
  await sim.getByLabel('Opacidad: Músculo', { exact: true }).fill('0');
  await page.waitForFunction(() => window.__layerFrame.refs.muscle.opacity < 0.01);
  await button('Músculo').click();
  await page.waitForFunction(() => window.__layerFrame.refs.muscle.opacity > 0.5);
  checks.push('Elegir capa restaura opacidad cero; no requiere activar visibilidad manual');
  await button('Antes').click();
  await button('Óseo').click();
  await page.waitForFunction(() => window.__layerFrame.refs.bone?.visible && window.__layerFrame.refs.bone.opacity > 0.5);
  assert.equal(await button('Después').getAttribute('aria-pressed'), 'true');
  checks.push('Elegir una capa desde Antes activa su render Después');
  await button('Corte').click();
  await sim.getByLabel('Capa inicial', { exact: true }).selectOption('bone');
  await sim.getByLabel('Capa final', { exact: true }).selectOption('muscle');
  await sim.getByText('Corte libre avanzado', { exact: true }).click();
  await sim.getByLabel(/^Aplicar a/).selectOption('all');
  await page.waitForFunction(() => window.__layerFrame.refs.bone.clips.length === 1);
  const initialClip = await page.evaluate(() => window.__layerFrame.refs.bone.clips[0][3]);
  await sim.getByLabel(/^Posición ·/).fill('0.32');
  await page.waitForFunction(constant => window.__layerFrame.refs.bone.clips[0][3] !== constant, initialClip);
  const clip = await page.evaluate(() => window.__layerFrame.refs.bone.clips[0]);
  const depth = sim.getByLabel('Recorrido entre capas', { exact: true });
  await depth.fill('0.5');
  await page.waitForFunction(() => window.__layerFrame.refs.vessels.visible && window.__layerFrame.refs.vessels.opacity > 0.1
    && window.__layerFrame.refs.bone.opacity === 0);
  assert.deepEqual(await page.evaluate(() => window.__layerFrame.refs.vessels.clips[0]), clip);
  await depth.fill('1');
  await page.waitForFunction(() => window.__layerFrame.refs.muscle.visible && window.__layerFrame.refs.muscle.opacity > 0.5);
  assert.equal(await sim.getByLabel(/^Aplicar a/).inputValue(), 'all');
  assert.equal(await sim.getByLabel(/^Posición ·/).inputValue(), '0.32');
  await depth.fill('0');
  await page.waitForFunction(() => window.__layerFrame.refs.bone.visible && window.__layerFrame.refs.bone.opacity > 0.5);
  checks.push('Óseo → vascular → músculo y reverso conservan el plano espacial');
  await depth.scrollIntoViewIfNeeded();
  const bounds = await depth.boundingBox();
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const started = await page.evaluate(() => performance.now());
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height / 2, { steps: 4 });
  await page.waitForFunction(time => window.__layerFrame.time > time
    && window.__layerFrame.refs.vessels.opacity > 0.1, started);
  await page.mouse.up();
  checks.push('Recorrido cambia referencias antes de soltar el slider');
  await button('Morfología').click();
  await page.waitForFunction(() => window.__layerFrame.skin.visible && window.__layerFrame.skin.opacity === 1
    && window.__layerFrame.skin.clips.length === 0 && Object.values(window.__layerFrame.refs).every(ref => ref.opacity < 0.01));
  checks.push('Morfología recupera piel original sin capas ni cortes heredados');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await button('Capas').click();
  await button('Músculo').click();
  await page.waitForFunction(() => window.__layerFrame.refs.muscle.visible && window.__layerFrame.refs.muscle.opacity > 0.1
    && window.__layerFrame.refs.vessels.visible && window.__layerFrame.skin.opacity === 0);
  assert.equal(await sim.getByLabel('Mostrar mallado de zonas', { exact: true }).isChecked(), false);
  assert.deepEqual(errors, []);
  checks.push('Escritorio/móvil sin desbordamiento ni errores JavaScript');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
