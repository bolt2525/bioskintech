/** Tab y workspace reales; visor genérico sustituido para aislar navegación de WebGL. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], writes = [], external = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.endsWith('/Clinical3DViewer.tsx')) return route.fulfill({ contentType: 'application/javascript', body: `
      import React from '/node_modules/.vite/deps/react.js';
      export default function Viewer({markers=[]}){return React.createElement('output',{'data-testid':'generic-mark-count'},String(markers.length))}
    ` });
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(request.postDataJSON());
      if (url.searchParams.get('action') === 'listPhotos') return route.fulfill({ json: { photos: [], total: 0, hasMore: false } });
      if (url.searchParams.get('action') === 'skinVisualStatus') return route.fulfill({ json: {
        enabled: false, reason: 'Deshabilitada', model: 'gemini-3.5-flash-lite', usedUsd: 0, remainingUsd: 5, limitUsd: 5,
      } });
      return route.fulfill({ status: 403, json: { error: 'API real bloqueada' } });
    }
    if (url.pathname !== '/__physical_workspace_fixture__') return route.continue();
    const html = await (await route.fetch()).text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Tab from '/src/components/admin/ficha-clinica/components/tabs/PhysicalExamTab.tsx';
      import '/src/index.css';
      window.originalLegacy=[{id:'old-face',x:0,y:0,is3D:true,category:'Lesión antigua',
        position3D:{x:0,y:0,z:1},normal3D:{x:0,y:0,z:1}}];
      const exams=[{id:42,record_id:12,consultation_id:7,skin_type:'Normal',phototype:'II',glogau_scale:'I',
        hydration:'',elasticity:'',lesions_description:'',face_map_data:JSON.stringify(window.originalLegacy),body_map_data:'[]'}];
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Tab,{
        recordId:12,consultationId:7,physicalExams:exams,patientName:'Paciente sintético',onSave:()=>{}}));
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__physical_workspace_fixture__`);
  await page.getByRole('button', { name: 'Migrar marcaciones a máscara', exact: true }).click();
  await page.getByText(/Migración del examen #42:/).waitFor();
  const workspace = page.getByRole('region', { name: 'Evaluación compartida de piel' });
  await workspace.getByText('Capturas', { exact: true }).first().waitFor();
  assert.equal(await page.getByTestId('generic-mark-count').innerText(), '1');
  await page.getByRole('button', { name: 'Solo máscara', exact: true }).click();
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), false);
  assert.equal(await workspace.isVisible(), true);
  await page.getByRole('button', { name: 'Solo genérico', exact: true }).click();
  assert.equal(await workspace.isVisible(), false);
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), true);
  await page.getByRole('button', { name: 'Visor dividido', exact: true }).click();
  await workspace.getByRole('button', { name: 'Usar foto del expediente', exact: true }).click();
  await workspace.getByText('Este expediente todavía no tiene fotos.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await workspace.isVisible(), true);
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.getByRole('button', { name: 'Nuevo Examen', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Migrar marcaciones a máscara', exact: true }).count(), 0);
  assert.equal(await page.getByTestId('generic-mark-count').innerText(), '0');
  await page.getByRole('button', { name: 'Abrir evaluación de piel', exact: true }).click();
  await page.getByRole('region', { name: 'Evaluación compartida de piel' }).waitFor();
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)));
  assert.equal(await page.evaluate(() => window.originalLegacy[0].id), 'old-face');
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], legacyPreserved: true, examWithoutModuleOptIn: true }));
} finally { await browser.close(); }
