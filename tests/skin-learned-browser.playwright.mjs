import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url)));
const configuration = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
const csp = configuration.headers.find(item => item.source === '/(.*)').headers.find(item => item.key === 'Content-Security-Policy').value;
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(90000);
  const errors = [], remote = [], modelRequests = [], downloads = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(origin + '/') && !/^(data:|blob:)/.test(url)) {
      remote.push(url); return route.abort();
    }
    if (url.includes('/models/skin/memi-v1-')) modelRequests.push(url);
    if (!url.includes('/__skin_app_test__')) return route.continue();
    const response = await route.fetch(), html = await response.text();
    const harness = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import SkinMultiViewReview from '/src/lab/faceSim/SkinMultiViewReview.tsx';
      import '/src/index.css';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.mountSkin = sources => root.render(React.createElement(SkinMultiViewReview, {sources}));
      </script>`;
    const replaced = html.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, harness);
    assert.ok(replaced !== html, 'se sustituye solo el arranque de la app para aislar el componente real');
    const modified = replaced.replace(/<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
    return route.fulfill({ response, body: modified, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__skinWorkerResults = [];
    window.Worker = class extends NativeWorker {
      set onmessage(callback) {
        super.onmessage = event => {
          if (window.__holdSkinResults && event.data.kind === 'result') setTimeout(() => callback?.(event), 500);
          else callback?.(event);
        };
      }
      get onmessage() { return super.onmessage; }
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data.kind === 'result') {
            const result = event.data.result;
            window.__skinWorkerResults.push({ width: result.width, height: result.height,
              length: result.probability.length, finite: result.probability.every(Number.isFinite) });
          }
        });
      }
    };
  });
  await page.goto(origin + '/__skin_app_test__');
  await page.waitForFunction(() => window.mountSkin, undefined, { timeout: 20000 });
  await page.evaluate(({ landmarks }) => {
    const sources = ['Frontal', 'Ángulo A', 'Ángulo B'].map((label, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 450;
      const context = canvas.getContext('2d'), pixels = context.createImageData(300, 450);
      for (let y = 0; y < 450; y++) for (let x = 0; x < 300; x++) {
        pixels.data.set([170 + (x % 41), 110 + (y % 51), 95 + (x + y) % 31, 255], (y * 300 + x) * 4);
      }
      context.putImageData(pixels, 0, 0);
      return { id: String(index), label, canvas, group: index === 0 ? 'front' : index === 1 ? 'a' : 'b',
        confirmed: index < 2, landmarks: index === 0 ? landmarks.map(([x, y]) => ({ x, y })) : undefined };
    });
    window.__skinSources = sources;
    window.__skinOriginals = sources.map(source => source.canvas.toDataURL());
    window.mountSkin(sources);
  }, fixture);
  const panel = page.getByRole('region', { name: 'Análisis local de piel', exact: true });
  await panel.waitFor();
  assert.equal(modelRequests.length, 0, 'no cargar pesos antes de pulsar analizar');
  assert.equal(await panel.locator('[type="file"],a[download]').count(), 0);
  assert.equal(await panel.getByText('No evaluable con este motor', { exact: true }).count(), 7);
  assert.equal(await page.getByRole('slider', { name: /Sensibilidad/ }).count(), 0, 'RGB fuera del flujo principal');
  await panel.getByRole('button', { name: 'Ángulo A · área requerida', exact: true }).click();
  await panel.getByRole('checkbox', { name: /^Confirmo que el rectángulo/ }).check();
  await panel.getByRole('button', { name: 'Confirmar área manual de piel', exact: true }).click();
  const started = Date.now();
  await panel.getByRole('button', { name: 'Analizar piel', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Análisis local de piel"] [role="status"]').getAttribute('aria-busy') === 'false');
  assert.match(await panel.getByRole('status').innerText(), /^2\/2 fotos procesadas/,
    await panel.innerText());
  const elapsed = Date.now() - started;
  assert.equal(modelRequests.length, 1, 'una carga de modelo compartida por fotos del mismo análisis');
  assert.equal(downloads.length, 0, 'no hay diálogo ni archivo de descarga del usuario');
  assert.deepEqual(await page.evaluate(() => window.__skinWorkerResults), [
    { width: 171, height: 256, length: 171 * 256, finite: true },
    { width: 171, height: 256, length: 171 * 256, finite: true },
  ]);
  assert.equal(await panel.locator('canvas[aria-label="Capa experimental de segmentación"]').count(), 1);
  let photoParity;
  if (process.env.SKIN_PARITY_DIR) {
    const root = process.env.SKIN_PARITY_DIR;
    const references = JSON.parse(readFileSync(join(root, 'references.json'), 'utf8'));
    const measured = [];
    for (const reference of references.cases) {
      const result = await page.evaluate(async ({ png, expected, width, height }) => {
        const { SkinLearnedClient } = await import('/src/lab/faceSim/skinLearnedClient.ts');
        const client = new SkinLearnedClient();
        try {
          const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), value => value.charCodeAt(0))], { type: 'image/png' }));
          const result = await client.analyze(bitmap, () => {});
          const bytes = Uint8Array.from(atob(expected), value => value.charCodeAt(0));
          const truth = new Float32Array(bytes.buffer);
          if (result.width !== width || result.height !== height || result.probability.length !== truth.length) throw new Error('Geometría no equivalente.');
          let error = 0, same = 0;
          for (let i = 0; i < truth.length; i++) {
            error = Math.max(error, Math.abs(result.probability[i] - truth[i]));
            if ((result.probability[i] >= .35) === (truth[i] >= .35)) same++;
          }
          return { error, agreement: same / truth.length };
        } finally { client.dispose(); }
      }, { png: readFileSync(join(root, reference.image)).toString('base64'),
        expected: readFileSync(join(root, reference.expected)).toString('base64'),
        width: reference.width, height: reference.height });
      measured.push(result);
    }
    photoParity = { cases: measured.length, maxAbsoluteError: Math.max(...measured.map(item => item.error)),
      minimumMaskAgreement: Math.min(...measured.map(item => item.agreement)) };
    assert.ok(photoParity.cases > 0 && photoParity.maxAbsoluteError <= .0001 && photoParity.minimumMaskAgreement >= .999,
      JSON.stringify(photoParity));
  }
  assert.equal(await page.evaluate(() => window.__skinSources.every((source, i) => source.canvas.toDataURL() === window.__skinOriginals[i])), true);
  const originalLayer = await panel.getByLabel('Capa experimental de segmentación', { exact: true }).evaluate(canvas => canvas.toDataURL());
  await page.evaluate(() => { window.__holdSkinResults = true; });
  await panel.getByRole('button', { name: 'Analizar piel', exact: true }).click();
  await panel.getByRole('button', { name: 'Cancelar análisis local', exact: true }).click();
  await panel.getByText('Análisis cancelado. Se conservan las capas anteriores.', { exact: true }).waitFor();
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__holdSkinResults = false; });
  assert.equal(await panel.getByLabel('Capa experimental de segmentación', { exact: true }).evaluate(canvas => canvas.toDataURL()), originalLayer);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'sin desbordamiento horizontal');
    await panel.getByRole('button', { name: 'Acercar foto', exact: true }).click();
    await panel.getByRole('button', { name: 'Reencuadrar foto', exact: true }).click();
    const toggle = panel.getByRole('button', { name: /Melasma · experimental/ });
    await toggle.click();
    assert.equal(await panel.getByLabel('Capa experimental de segmentación', { exact: true }).evaluate(canvas => Number(canvas.style.opacity)), 0);
    await toggle.click();
    if (process.env.SKIN_SCREENSHOT_DIR) {
      mkdirSync(process.env.SKIN_SCREENSHOT_DIR, { recursive: true });
      await panel.screenshot({ path: join(process.env.SKIN_SCREENSHOT_DIR, `skin-panel-${width}.png`) });
    }
  }
  await page.getByText('Explorador técnico RGB · no clasifica lesiones', { exact: true }).click();
  await page.getByRole('region', { name: 'Revisión de piel · fotos y máscara' }).waitFor();
  await page.getByText('Explorador técnico RGB · no clasifica lesiones', { exact: true }).click();
  await page.route('**/models/skin/memi-v1-*.onnx', route => route.fulfill({ status: 200, body: 'alterado' }));
  await panel.getByRole('button', { name: 'Analizar piel', exact: true }).click();
  await panel.getByText(/^0\/2 fotos procesadas/).waitFor();
  assert.match(await panel.getByRole('alert').innerText(), /modelo descargado no coincide/);
  assert.equal(await panel.getByLabel('Capa experimental de segmentación', { exact: true }).evaluate(canvas => canvas.toDataURL()), originalLayer);
  assert.equal(remote.length, 0, 'no se envían fotos ni solicitudes fuera del origen');
  assert.deepEqual(errors, [], 'sin errores JavaScript');
  console.log(JSON.stringify({ passed: true, realModel: true, elapsedMilliseconds: elapsed, photoParity,
    viewports: [1440, 390], automaticDownloadDialogs: downloads.length, remoteRequests: remote.length,
    checked: ['modelo real en worker', 'área manual', 'sin confirmar excluida', 'categorías honestas',
      'cancelación sin resultado tardío', 'original intacto', 'máscara única', 'RGB avanzado',
      'rechazo de modelo alterado y conservación de capa'] }, null, 2));
} finally {
  await browser.close();
}
