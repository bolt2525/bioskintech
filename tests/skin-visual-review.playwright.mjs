/** Local synthetic UI only. All clinical/Gemini/storage HTTP is mocked; no real records or photos. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin), 'Solo Vite local');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const usage = { usedUsd: 0.02, limitUsd: 5, remainingUsd: 4.98 };
const proposals = [
  { id: 'p1', category: 'spot', label: 'Área ilustrativa', box: { x: 0.15, y: 0.2, width: 0.2, height: 0.25 }, note: 'Verificar' },
  { id: 'p2', category: 'scar', label: 'Otra región ilustrativa', box: { x: 0.5, y: 0.5, width: 0.15, height: 0.1 }, note: 'Verificar' },
];
let statusEnabled = true, mode = 'success', release, hold, png, libraryHold, releaseLibrary, libraryRequests = 0;
const posts = [], uploads = [], saves = [], external = [], errors = [], storageReads = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://synthetic-storage.invalid') {
      storageReads.push(await request.allHeaders());
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname === '/api/ai-consultation') {
      if (request.method() === 'GET') return route.fulfill({ json: {
        enabled: statusEnabled, reason: statusEnabled ? undefined : 'Permiso revocado por servidor',
        model: 'modelo-mock', ...usage,
      } });
      posts.push(request.postDataJSON());
      const currentMode = mode;
      if (currentMode === 'hold') await hold;
      if (currentMode === 'error') return route.fulfill({ status: 403, json: { error: 'Permiso revocado por servidor' } });
      return route.fulfill({ json: {
        analysisId: `mock-${posts.length}`, model: 'modelo-mock', proposals: currentMode === 'empty' ? [] : proposals,
        summary: 'Propuestas sintéticas ilustrativas, no diagnóstico', limitations: ['Cajas aproximadas, no máscaras'], usage,
      } }).catch(() => {}); // Canceled requests may close their route before the mock is released.
    }
    if (url.pathname === '/api/records') {
      if (url.searchParams.get('action') === 'listPhotos') {
        libraryRequests++;
        if (libraryHold) await libraryHold;
        return route.fulfill({ json: {
        photos: [{ id: 8, r2_key: 'clinics/ficticia/records/12/photos/sintetica.jpg',
          r2_url: 'https://synthetic-storage.invalid/synthetic.png?signature=mock', session_label: 'Sintética' },
        ...(uploads.length ? [{ id: 9, r2_key: 'clinics/ficticia/records/12/photos/copia.jpg',
          r2_url: 'https://synthetic-storage.invalid/copia.png?signature=mock-renewed', session_label: 'Copia sintética' }] : [])], hasMore: false,
        } }).catch(() => {});
      }
      const body = request.postDataJSON();
      if (body.action === 'uploadPhotoProxy') {
        uploads.push(body);
        return route.fulfill({ status: 201, json: { id: 9, r2_key: 'clinics/ficticia/records/12/photos/copia.jpg' } });
      }
      if (url.searchParams.get('action') === 'savePhysicalExam') {
        saves.push(body); return route.fulfill({ json: { id: 41 } });
      }
      throw new Error(`API no esperada en prueba: ${request.method()} ${url.pathname}`);
    }
    if (url.pathname.endsWith('/Clinical3DViewer.tsx')) return route.fulfill({
      contentType: 'application/javascript', body: `import React from '/node_modules/.vite/deps/react.js';
        export default function Viewer() { return React.createElement('div', null, 'Visor legacy aislado para prueba'); }`,
    });
    if (url.pathname.endsWith('/useClinicSettings.ts')) return route.fulfill({
      contentType: 'application/javascript', body: `export function useClinicSettings() {
        return {settings:{general:{name:'Clínica QA sintética'},email:{}}}; }`,
    });
    if (url.pathname.endsWith('/AuthContext.tsx')) return route.fulfill({
      contentType: 'application/javascript', body: `export function useAuth() {
        return {user:{full_name:'Profesional QA',matricula_senescyt:'QA',especialidad:'QA'},checkAuth:async()=>{}}; }`,
    });
    if (url.pathname !== '/__skin_review_test__') return route.continue();
    const response = await route.fetch(), html = await response.text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Review from '/src/components/admin/ficha-clinica/components/SkinVisualAIReview.tsx';
      import '/src/index.css';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.created = []; window.revoked = [];
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); window.created.push(url); return url; };
      URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
      function Harness({recordId,consultationId,examIdentity}) {
        const [reviewed, setReviewed] = React.useState([]);
        window.reviewed = reviewed;
        return React.createElement(Review, {recordId, consultationId, examIdentity, reviewed, onChange: setReviewed,
          context: {skinType: 'Manual', phototype: 'III', hydration: 'Manual'}});
      }
      window.mount = recordId => root.render(React.createElement(Harness, {recordId, key: recordId}));
      window.reuse = (recordId,consultationId,examIdentity) => root.render(React.createElement(Harness, {recordId,consultationId,examIdentity}));
      window.mountPhysical = async (annotations=[],consultationId=4) => {
        const {default: Physical} = await import('/src/components/admin/ficha-clinica/components/tabs/PhysicalExamTab.tsx');
        const exam = {id:41,record_id:12,consultation_id:4,skin_type:'Manual',phototype:'III',glogau_scale:'II',
            hydration:'Manual',elasticity:'',lesions_description:'',
            face_map_data:JSON.stringify([{id:'legacy',x:0,y:0,category:'Manual',is3D:true,position3D:{x:1,y:1,z:1}}]),
            skin_visual_review:{version:1,annotations}};
        window.physicalData = [exam, {...exam,id:42,consultation_id:5,skin_type:'Histórica QA',
          skin_visual_review:JSON.stringify({version:1,annotations})}];
        root.render(React.createElement(Physical, {recordId:12, consultationId, patientName:'QA Sintética', onSave:()=>{},
          consultations:[{id:4,reason:'Consulta actual QA',created_at:'2026-11-05'},{id:5,reason:'Consulta anterior QA',created_at:'2026-11-04'}],
          physicalExams:window.physicalData}));
      };
      window.mountPrint = async () => {
        const {default: Print} = await import('/src/components/admin/ficha-clinica/components/PrintModal.tsx');
        const originalCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { if(blob.type.startsWith('text/html')) window.printHTML = blob.text(); return originalCreate(blob); };
        window.open = () => null;
        root.render(React.createElement(Print, {patient:{first_name:'Sintética',last_name:'QA'},
          recordId:12,recordData:{physicalExams:window.physicalData},activeConsultation:null,onClose:()=>{}}));
      };
      window.mountLegacyNew = async () => {
        const {default: Physical} = await import('/src/components/admin/ficha-clinica/components/tabs/PhysicalExamTab.tsx');
        root.render(React.createElement(Physical, {key:'legacy-new',recordId:12,consultationId:6,
          patientName:'QA Sintética',physicalExams:[],onSave:()=>{}}));
      };
      window.mount(12);
    </script>`;
    const body = html.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script)
      .replace(/<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
    assert.notEqual(body, html);
    return route.fulfill({ response, body });
  });
  await page.goto(origin + '/__skin_review_test__');
  await page.getByText('Disponible según el servidor.', { exact: true }).waitFor();
  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1200;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d1b3a5'; ctx.fillRect(0, 0, 1800, 1200);
    ctx.fillStyle = '#835746'; ctx.fillRect(300, 240, 150, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const enable = () => page.getByRole('checkbox', { name: /Habilitar propuestas IA/ }).check();
  const file = () => page.getByLabel('Subir foto para revisión', { exact: true }).setInputFiles({
    name: 'solo-sintetica.png', mimeType: 'image/png', buffer: png,
  });
  const consent = () => page.getByRole('checkbox', { name: /Autorizo este envío/ }).check();
  const analyze = () => page.getByRole('button', { name: 'Solicitar propuestas para esta foto', exact: true });
  const untilPhoto = () => page.getByRole('img', { name: 'Foto seleccionada para revisión visual 2D' }).waitFor();
  await enable(); await file(); await untilPhoto();
  assert.equal(posts.length, 0, 'sin análisis automático al seleccionar');
  assert.equal(await analyze().isEnabled(), false, 'consentimiento explícito por envío');
  await page.getByRole('button', { name: 'Guardar copia de referencia en Fotos' }).click();
  await page.getByText(/Referencia guardada #9/).waitFor();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].content_type, 'image/jpeg');
  assert.ok(!uploads[0].fileBase64.startsWith('data:'));
  await consent(); await analyze().click();
  await page.getByText('2 propuestas; ninguna se acepta automáticamente.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.reviewed)).length, 0);
  assert.equal(posts[0].recordId, 12); assert.equal(posts[0].consent, true);
  assert.deepEqual(posts[0].context, { skinType: 'Manual', phototype: 'III', hydration: 'Manual' });
  assert.ok(!posts[0].imageBase64.startsWith('data:'));
  assert.ok(Buffer.from(posts[0].imageBase64, 'base64').length <= 1_500_000);
  assert.match(posts[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(await page.getByRole('checkbox', { name: /Autorizo este envío/ }).isChecked(), false);
  await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).fill('Verificada sintética');
  await page.getByRole('button', { name: 'Verificar y validar esta región', exact: true }).click();
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  let annotations = await page.evaluate(() => window.reviewed);
  assert.equal(annotations[0].photo.id, 9); assert.equal(annotations[0].label, 'Verificada sintética');
  assert.equal(annotations[0].source.imageWidth, 1280); assert.equal(annotations[0].source.imageHeight, 853);
  assert.equal(annotations[0].source.proposal.label, proposals[0].label);
  await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).fill('Cambio exige revisión');
  await page.getByText('Regiones verificadas del examen (0)', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Verificar y validar esta región', exact: true }).click();
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  annotations = await page.evaluate(() => window.reviewed);
  await page.getByRole('combobox', { name: 'Capa por categoría' }).selectOption('scar');
  await page.getByRole('button', { name: 'Descartar esta región', exact: true }).click();
  assert.equal((await page.evaluate(() => window.reviewed)).length, 1);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `sin overflow ${width}`);
    await page.getByRole('slider', { name: 'Zoom de foto' }).fill('2');
    assert.equal(await page.getByRole('img').isVisible(), true);
  }
  // Photo switch must revoke the blob, reset consent and pending proposals, preserve reviewed regions.
  await page.getByRole('button', { name: 'Cargar / actualizar fotos de esta ficha' }).click();
  await page.getByRole('combobox', { name: 'Foto disponible de esta ficha' }).selectOption('8');
  await page.getByText(/Referencia guardada #8/).waitFor();
  assert.ok((await page.evaluate(() => window.revoked)).length >= 1);
  assert.equal(await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.reviewed)).length, 1);
  mode = 'empty'; await consent(); await analyze().click();
  await page.getByText('Sin propuestas. Esto no descarta lesiones; continúa el examen manual.', { exact: true }).waitFor();
  // Cancellation ignores late proposals even when transport cancellation cannot stop the remote computation.
  mode = 'hold'; hold = new Promise(resolve => { release = resolve; });
  await consent(); await analyze().click();
  await page.getByText('Solicitando propuestas a Gemini…', { exact: false }).waitFor();
  await page.getByText('Cancelar la espera en el navegador no garantiza detener un envío ya iniciado ni evitar su coste. El servidor conserva la reserva de presupuesto ante incertidumbre.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancelar espera', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Espera cancelada en este navegador' }).waitFor();
  release(); await page.waitForTimeout(100);
  assert.equal(await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).count(), 0);
  mode = 'hold'; hold = new Promise(resolve => { release = resolve; });
  await consent(); await analyze().click();
  await page.getByText('Solicitando propuestas a Gemini…', { exact: false }).waitFor();
  await file(); await untilPhoto(); release(); await page.waitForTimeout(100);
  assert.equal(await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /Autorizo este envío/ }).isChecked(), false);
  mode = 'error'; statusEnabled = false;
  await consent(); await analyze().click();
  await page.getByRole('alert').filter({ hasText: 'Permiso revocado' }).waitFor();
  await page.getByText('Deshabilitado: Permiso revocado por servidor', { exact: true }).waitFor();
  assert.equal(await analyze().isEnabled(), false);
  // Patient switch cleans resources and rejects late work.
  statusEnabled = true;
  await page.getByRole('button', { name: 'Actualizar permiso' }).click();
  await page.getByText('Disponible según el servidor.', { exact: true }).waitFor();
  mode = 'hold'; hold = new Promise(resolve => { release = resolve; });
  await consent(); await analyze().click();
  await page.getByText('Solicitando propuestas a Gemini…', { exact: false }).waitFor();
  await page.evaluate(() => window.mount(13)); release();
  await page.getByText('Disponible según el servidor.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.reviewed)).length, 0);
  assert.equal(await page.getByRole('img').count(), 0);
  assert.deepEqual(await page.evaluate(() => [...window.created].sort()), await page.evaluate(() => [...window.revoked].sort()));
  // HIGH regression: same component instance, no parent key/remount, analysis AND library held for A.
  await page.evaluate(() => window.reuse(12, 4, 'exam-A'));
  await page.getByText('Disponible según el servidor.', { exact: true }).waitFor();
  await enable(); await file(); await untilPhoto();
  mode = 'hold'; hold = new Promise(resolve => { release = resolve; });
  libraryHold = new Promise(resolve => { releaseLibrary = resolve; });
  const previousPosts = posts.length, previousLibrary = libraryRequests;
  await consent(); await analyze().click();
  await page.getByRole('button', { name: 'Cargar / actualizar fotos de esta ficha' }).click();
  for (let i = 0; i < 100 && (posts.length === previousPosts || libraryRequests === previousLibrary); i++) {
    await page.waitForTimeout(20);
  }
  assert.equal(posts.length, previousPosts + 1); assert.equal(libraryRequests, previousLibrary + 1);
  await page.evaluate(() => window.reuse(13, 4, 'exam-B'));
  release(); releaseLibrary(); libraryHold = undefined;
  await page.getByText('Disponible según el servidor.', { exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('checkbox', { name: /Habilitar propuestas IA/ }).isChecked(), false);
  await enable();
  assert.equal(await page.getByRole('img').count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /Autorizo este envío/ }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Etiqueta', exact: true }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Foto disponible de esta ficha' }).count(), 0);
  assert.equal(await analyze().count(), 0, 'no se puede enviar la foto A con record B');
  assert.equal(posts.length, previousPosts + 1);
  await file(); await untilPhoto();
  await page.evaluate(() => window.reuse(13, 5, 'exam-C'));
  await page.waitForFunction(() => !document.querySelector('input[type="checkbox"]').checked);
  assert.equal(await page.getByRole('img').count(), 0, 'cambiar consulta también limpia la foto');
  await enable(); await file(); await untilPhoto();
  await page.evaluate(() => window.reuse(13, 5, 'exam-D'));
  await page.waitForFunction(() => !document.querySelector('input[type="checkbox"]').checked);
  assert.equal(await page.getByRole('img').count(), 0, 'cambiar examen también limpia la foto');
  // Actual examination Save carries only validated photo annotations, preserves legacy 3D byte-for-byte.
  await page.evaluate(annotations => window.mountPhysical(annotations), annotations);
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await enable(); await file(); await untilPhoto();
  mode = 'success'; await consent(); await analyze().click();
  await page.getByText(/2 propuestas; ninguna se acepta automáticamente/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Guardar examen físico', exact: true }).click();
  await page.getByText('Examen físico guardado correctamente', { exact: true }).waitFor();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].skin_visual_review, { version: 1, annotations });
  assert.deepEqual(JSON.parse(saves[0].face_map_data), [
    { id: 'legacy', x: 0, y: 0, category: 'Manual', is3D: true, position3D: { x: 1, y: 1, z: 1 } },
  ]);
  assert.ok(!/base64|blob:|https:/.test(JSON.stringify(saves[0].skin_visual_review)));
  // Reopen persisted object/string JSON; pending/rejected payload entries must not appear.
  const filteredFixture = [...annotations,
    { ...annotations[0], id: 'pending', label: 'PENDIENTE_NO_MOSTRAR', reviewStatus: 'pending' },
    { ...annotations[0], id: 'rejected', label: 'RECHAZADA_NO_MOSTRAR', reviewStatus: 'rejected' }];
  await page.evaluate(() => window.mount(20));
  await page.getByText('Regiones verificadas del examen (0)', { exact: true }).waitFor();
  await page.evaluate(data => window.mountPhysical(data), filteredFixture);
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  assert.equal(await page.getByText(/PENDIENTE_NO_MOSTRAR|RECHAZADA_NO_MOSTRAR/).count(), 0);
  await enable();
  await page.getByRole('button', { name: 'Cargar / actualizar fotos de esta ficha' }).click();
  await page.getByRole('combobox', { name: 'Foto disponible de esta ficha' }).selectOption('9');
  await page.getByText(/Referencia guardada #9/).waitFor();
  await page.getByRole('combobox', { name: 'Capa por categoría' }).selectOption('spot');
  await page.locator('[title="Cambio exige revisión"]').waitFor();
  assert.ok(storageReads.every(headers => !headers.authorization && !headers.cookie && !headers.referer));
  await page.evaluate(data => window.mountPhysical(data, 5), filteredFixture);
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('input[type="checkbox"]').checked);
  assert.equal(await page.getByRole('img', { name: 'Foto seleccionada para revisión visual 2D' }).count(), 0);
  await page.evaluate(data => window.mountPhysical(data, 4), filteredFixture);
  await page.getByText('Regiones verificadas del examen (1)', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ver historial de exámenes de otras consultas' }).click();
  const history = page.getByRole('dialog');
  await history.getByRole('button', { name: /Consulta anterior QA/ }).click();
  await history.getByRole('button', { name: /Histórica QA/ }).click();
  await history.getByText('Revisión visual 2D validada', { exact: true }).waitFor();
  await history.getByText(/Mancha · Cambio exige revisión.*Foto clínica #9/).waitFor();
  assert.equal(await history.getByText(/PENDIENTE_NO_MOSTRAR|RECHAZADA_NO_MOSTRAR/).count(), 0);
  await history.getByRole('button', { name: 'Cerrar historial completo' }).click();
  await page.evaluate(() => window.mountPrint());
  await page.getByRole('button', { name: 'Imprimir / PDF' }).click();
  const printHTML = await page.evaluate(() => window.printHTML);
  assert.equal((printHTML.match(/Revisión visual 2D validada \(1\)/g) || []).length, 2);
  assert.match(printHTML, /Mancha · Cambio exige revisión.*Foto clínica #9/);
  assert.ok(!/PENDIENTE_NO_MOSTRAR|RECHAZADA_NO_MOSTRAR|r2_key|signature=|clinics\/ficticia/.test(printHTML));
  // Optional service/schema not available must not affect a brand-new ordinary exam.
  statusEnabled = false;
  await page.evaluate(() => window.mountLegacyNew());
  await page.getByText('Deshabilitado: Permiso revocado por servidor', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Guardar examen físico', exact: true }).click();
  await page.getByRole('button', { name: 'Guardar de todos modos', exact: true }).click();
  await page.getByText('Examen físico guardado correctamente', { exact: true }).waitFor();
  assert.equal(saves.length, 2);
  assert.equal(Object.hasOwn(saves[1], 'skin_visual_review'), false, 'nuevo legacy no exige columna JSONB opcional');
  assert.equal(saves[1].record_id, 12);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, consentPerSend: true, serverRevocation: true,
    manualReviewAndEditInvalidation: true, cancelAndPatientSwitch: true, blobCleanup: true,
    durablePhotoReference: true, actualExamSave: true, pendingExcludedFromSave: true,
    stalePhotoResponseIgnored: true, legacy3DIntact: true, validatedOnlyReopenHistoryPrint: true,
    consultationSwitch: true, sameInstanceRecordConsultationExamReset: true,
    legacyNewOmitsOptionalColumn: true, safeLibraryAndUploadContracts: true,
    viewports: [1440, 390], realExternalCalls: 0 }));
} finally { await browser.close(); }
