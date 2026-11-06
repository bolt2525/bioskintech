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
      export default function Viewer({markers=[],modelData}){return React.createElement('output',{'data-testid':modelData?'mask-preview':'generic-mark-count'},String(markers.length))}
    ` });
    if (url.pathname.endsWith('/FaceSimLab.tsx')) return route.fulfill({ contentType: 'application/javascript',
      body: (await (await route.fetch()).text()).replace('onController?.(controller)', '(window.captureController = controller, onController?.(controller))') });
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
      import atlas from '/src/lab/faceSim/genericFaceAtlas.json';
      import {personalSurfaceToGlb} from '/src/lab/faceSim/personalSurfaceGlb.ts';
      import {storeSurface,bufferToBase64} from '/src/lab/faceSim/facialSimulationSession.ts';
      import '/src/index.css';
      window.originalLegacy=[{id:'old-face',x:0,y:0,is3D:true,category:'Lesión antigua',
        position3D:{x:0,y:0,z:1},normal3D:{x:0,y:0,z:1}}];
      const exams=[{id:42,record_id:12,consultation_id:7,skin_type:'Normal',phototype:'II',glogau_scale:'I',
        hydration:'',elasticity:'',lesions_description:'',face_map_data:JSON.stringify(window.originalLegacy),body_map_data:'[]'}];
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Tab,{
        recordId:12,consultationId:7,physicalExams:exams,patientName:'Paciente sintético',onSave:()=>{}}));
      window.restoreSyntheticMask=async () => {
        const canvas=document.createElement('canvas');canvas.width=360;canvas.height=480;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#bd967b';ctx.fillRect(0,0,360,480);
        const landmarks=Array.from({length:468},(_,i)=>({x:.5+atlas.positions[i*3]*.16,y:.5-atlas.positions[i*3+1]*.16,z:0}));
        const surface={positions:Float32Array.from(atlas.positions),indices:Uint32Array.from(atlas.triangles),
          uvs:Float32Array.from(landmarks.flatMap(p=>[p.x,p.y])),projection:{cx:.5,cy:.5,k:.16,aspect:.75}};
        const glb=await personalSurfaceToGlb(surface,canvas);
        await window.captureController.restore({version:1,atlas:{modelId:atlas.modelId,version:1,glbSha256:atlas.provenance.glbSha256},
          photos:[{slot:'frontal',photo:{id:81,r2Key:'clinics/synthetic/records/12/photos/81.png'},alignment:{
            frame:{top:.05,bottom:.95,left:.1,right:.9,axisTop:{x:.5,y:.05},axisBottom:{x:.5,y:.95},source:'manual'},landmarks,captureConfirmed:true}}],
          mask:{view:'frontal',surface:storeSurface(surface),renderSurface:storeSurface(surface),glbBase64:bufferToBase64(glb),
            depth:1,depthDetails:'Sintético',diagnostics:[],closedHead:false},marks:[]},{frontal:canvas});
      };
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__physical_workspace_fixture__`);
  await page.getByRole('button', { name: /Continuar en modelo genérico/ }).click();
  assert.equal(await page.getByRole('region', { name: 'Evaluación compartida de piel' }).count(), 0);
  await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Elegir fotografías', exact: true });
  await dialog.waitFor();
  const workspace = page.getByRole('region', { name: 'Evaluación compartida de piel' });
  assert.equal(await page.getByTestId('generic-mark-count').innerText(), '1');
  assert.equal(await page.getByRole('group', { name: 'Modo de visor facial' }).count(), 0);
  assert.equal(await dialog.getByText('Herramientas avanzadas y ayuda', { exact: true }).count(), 0);
  assert.equal(await dialog.getByText('Diagnóstico estadístico opcional', { exact: true }).count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Confirmar fotos y generar máscara', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Fotos del expediente', exact: true }).click();
  await dialog.getByText('Este expediente todavía no tiene fotos.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.isVisible(), true);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.width <= 390 && bounds.x >= 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await dialog.getByRole('button', { name: 'Cerrar selección de fotos', exact: true }).click();
  await page.getByRole('button', { name: /Continuar en modelo genérico/ }).click();
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), true);
  assert.equal(await workspace.isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).click();
  await page.getByRole('dialog', { name: 'Elegir fotografías', exact: true }).waitFor();
  await page.evaluate(() => window.restoreSyntheticMask());
  await page.getByRole('group', { name: 'Modo de visor facial' }).waitFor();
  await page.getByRole('button', { name: 'Solo máscara', exact: true }).click();
  assert.equal(await page.getByTestId('generic-mark-count').first().isVisible(), false);
  await page.getByRole('button', { name: 'Solo genérico', exact: true }).click();
  assert.equal(await workspace.isVisible(), false);
  await page.getByRole('button', { name: 'Visor dividido', exact: true }).click();
  assert.equal(await workspace.isVisible(), true);
  assert.equal(await page.getByTestId('generic-mark-count').first().isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\examen-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\examen-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Nuevo Examen', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).count(), 0);
  assert.equal(await page.getByTestId('generic-mark-count').first().innerText(), '0');
  await page.getByRole('button', { name: /^Crear máscara facial/ }).click();
  await page.getByRole('region', { name: 'Evaluación compartida de piel' }).waitFor();
  await page.getByRole('dialog', { name: 'Elegir fotografías', exact: true }).waitFor();
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)));
  assert.equal(await page.evaluate(() => window.originalLegacy[0].id), 'old-face');
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], legacyPreserved: true, examWithoutModuleOptIn: true }));
} finally { await browser.close(); }
