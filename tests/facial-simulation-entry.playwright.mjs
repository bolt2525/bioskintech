/** Fixture sintético aislado. Ejecutar solo con Vite local; no utiliza API, pacientes ni R2 reales. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const transformedPage = await (await fetch(`${origin}/src/hooks/useAdminNav.ts`)).text();
const routerModule = transformedPage.match(/from ["']([^"']*react-router-dom[^"']*)["']/)?.[1];
assert.ok(routerModule, 'Usar la misma instancia de React Router transformada por Vite');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const writes = [], errors = [], external = [];
let enabled = false, examAttempts = 0;
const patients = [
  { id: 1, first_name: 'Paciente', last_name: 'Prueba', identification_number: '0000000001' },
  { id: 2, first_name: 'Otro', last_name: 'Prueba', identification_number: '0000000002' },
];
const fakeLab = `
  import React from '/node_modules/.vite/deps/react.js';
  const {useEffect,useMemo,useState}=React;
  export default function FakeLab({integration}) {
    const [photos,setPhotos]=useState([]),[marks]=useState([]);
    const makeCanvas=()=>{const c=document.createElement('canvas');c.width=2;c.height=2;return c};
    const controller=useMemo(()=>({
      getPhotos:()=>photos,getMarks:()=>marks,
      importPhoto:async(file,slot)=>{if(photos.some(p=>p.id===slot))throw Error('Esta vista ya está ocupada.');
        setPhotos(p=>[...p,{id:slot,canvas:makeCanvas(),original:file}]);integration.onDirty()},
      snapshot:async(refs)=>({version:1,atlas:{modelId:'fixture',version:1,glbSha256:'fixture'},
        photos:photos.map(p=>({slot:p.id,photo:refs[p.id],alignment:{}})),marks}),
      restore:async(state,canvases,originals)=>setPhotos(state.photos.map(p=>({id:p.slot,canvas:canvases[p.slot],
        original:new File([originals[p.slot]],'fixture.png',{type:'image/png'})}))),
      reset:()=>{window.fakeResets=(window.fakeResets||0)+1;setPhotos([])}
    }),[photos,marks,integration.onDirty]);
    useEffect(()=>{integration.onController(controller)},[controller,integration.onController]);
    useEffect(()=>()=>integration.onController(null),[integration.onController]);
    return React.createElement('div',null,
      React.createElement('p',{'data-testid':'fake-photo-count'},String(photos.length)),
      React.createElement('button',{type:'button',onClick:()=>{const file=new File(['fixture'],'fixture.png',{type:'image/png'});
        setPhotos(p=>[...p,{id:'frontal',canvas:makeCanvas(),original:file}]);integration.onDirty()}},'Agregar foto temporal'));
  }`;
const fakeLayout = `
  import React from '/node_modules/.vite/deps/react.js';
  export default function AdminLayout({children,title,onBack}) {
    return React.createElement('main',null,React.createElement('h1',null,title),
      React.createElement('button',{type:'button',onClick:onBack,'aria-label':'Volver'},'Volver'),children);
  }`;

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE:', error.message); });
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => sessionStorage.setItem('adminSessionToken', 'synthetic-only'));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === 'synthetic.invalid') return route.fulfill({
      status: 200, contentType: 'image/png', body: png, headers: { 'Access-Control-Allow-Origin': '*' },
    });
    if (url.origin !== origin) { external.push(req.url()); return route.abort(); }
    if (url.pathname === '/src/lab/faceSim/FaceSimLab.tsx') return route.fulfill({ contentType: 'application/javascript', body: fakeLab });
    if (url.pathname === '/src/components/layout/AdminLayout.tsx') return route.fulfill({ contentType: 'application/javascript', body: fakeLayout });
    if (url.pathname === '/api/admin-auth') return route.fulfill({ json: {
      success: true, valid: true, user: { role: 'clinic_admin', username: 'medico', clinic_slug: 'demo' },
      features: enabled ? ['clinical_records', 'facial_simulation'] : ['clinical_records'], user_module_overrides: [],
    } });
    if (url.pathname === '/api/records') {
      const body = req.postDataJSON() ?? {}, action = body.action ?? url.searchParams.get('action');
      if (req.method() !== 'GET') writes.push({ action, body });
      if (action === 'listPatients') return route.fulfill({ json: patients });
      if (action === 'createPatient') return route.fulfill({ json: { id: 1 } });
      if (action === 'getPatient') return route.fulfill({ json: patients.find(p => p.id === Number(url.searchParams.get('id'))) });
      if (action === 'listRecords') return route.fulfill({ json: Number(url.searchParams.get('patient_id')) === 2 ?
        [{ id: 20, status: 'active', created_at: '2026-01-01' }] : [] });
      if (action === 'getRecordData') return route.fulfill({ json: { physicalExams: [{
        skin_type: 'Normal', phototype: 'II', glogau_scale: 'I', created_at: '2026-01-01',
      }] } });
      if (action === 'createRecord') return route.fulfill({ json: { id: 10, status: 'active', created_at: '2026-01-01' } });
      if (action === 'listPhotos') return route.fulfill({ json: { photos: [{
        id: 81, r2_key: 'clinics/synthetic/records/10/photos/fixture.png',
        r2_url: 'https://synthetic.invalid/photo.png', session_label: 'Fixture',
      }], total: 1, hasMore: false } });
      if (action === 'uploadPhotoProxy') return route.fulfill({ json: {
        id: 82, r2_key: `clinics/synthetic/records/${body.record_id}/photos/original.png`,
      } });
      if (action === 'saveFacialSimulation') return route.fulfill({ json: { success: true, id: 91, record_id: body.record_id, state_version: 1 } });
      if (action === 'saveSimulationExam') {
        examAttempts++;
        if (examAttempts === 1) return route.fulfill({ status: 503, json: { error: 'Respuesta incierta sintética' } });
        return route.fulfill({ json: { success: true, consultation_id: 100, exam_id: 101 } });
      }
      return route.fulfill({ status: 403, json: { error: 'Acción bloqueada por la prueba.' } });
    }
    if (url.pathname !== '/__facial_entry_fixture__') return route.continue();
    const response = await route.fetch(), html = await response.text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import {createMemoryRouter,RouterProvider} from '${routerModule}';
      import {AuthProvider} from '/src/context/AuthContext.tsx';
      import {MasterViewProvider} from '/src/context/MasterViewContext.tsx';
      import FacialSimulation from '/src/pages/FacialSimulation.tsx';
      import '/src/index.css';
      const e=React.createElement;
      window.fixtureRouter=createMemoryRouter([
        {path:'/admin/demo/medico/facial-simulation',element:e(AuthProvider,null,e(MasterViewProvider,null,e(FacialSimulation)))},
        {path:'/admin/demo/medico',element:e('p',null,'Inicio de prueba')}
      ],{initialEntries:['/admin/demo/medico','/admin/demo/medico/facial-simulation']});
      ReactDOM.createRoot(document.getElementById('root')).render(e(RouterProvider,{router:window.fixtureRouter}));
    </script>`;
    const isolatedHtml = html.replace(/<link[^>]+fonts\.googleapis\.com[^>]*>/g, '')
      .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>/g, '');
    return route.fulfill({ contentType: 'text/html', body: isolatedHtml.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });

  await page.goto(`${origin}/__facial_entry_fixture__`);
  await page.getByText('Este módulo no está habilitado para la clínica o el usuario.').waitFor().catch(async error => {
    throw new Error(JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 1000) }), { cause: error });
  });
  assert.equal(await page.getByText('Agregar foto temporal').count(), 0);
  enabled = true;
  await page.reload();
  await page.getByRole('button', { name: 'Continuar sin paciente' }).click();
  await page.getByRole('button', { name: 'Agregar foto temporal' }).click();
  assert.equal(await page.getByTestId('fake-photo-count').innerText(), '1');
  assert.equal(writes.length, 0);
  await page.evaluate(() => { void window.fixtureRouter.navigate(-1); });
  await page.getByRole('button', { name: 'Seguir trabajando' }).click();
  assert.equal(await page.getByTestId('fake-photo-count').innerText(), '1');

  await page.getByRole('button', { name: 'Vincular paciente' }).click();
  await page.getByRole('button', { name: 'Crear paciente', exact: true }).click();
  await page.locator('#first_name').fill('Paciente');
  await page.locator('#last_name').fill('Prueba');
  await page.locator('#identification_type').selectOption('cedula');
  await page.locator('#identification_number').fill('0000000001');
  await page.getByRole('button', { name: 'Crear Paciente', exact: true }).click();
  await page.getByRole('button', { name: 'Crear expediente' }).click();
  await page.getByText('Paciente Prueba · Expediente #10').waitFor();
  assert.equal(writes.filter(w => w.action === 'saveSimulationExam').length, 0);
  assert.equal(await page.getByTestId('fake-photo-count').innerText(), '1');

  await page.getByRole('button', { name: 'Biblioteca de fotos' }).click();
  await page.getByLabel('Vista de destino').selectOption('izquierda');
  await page.getByRole('button', { name: 'Usar foto 81' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="fake-photo-count"]')?.textContent === '2');
  await page.getByRole('button', { name: 'Guardar en examen' }).click();
  const examDialog = page.getByRole('dialog', { name: 'Guardar en examen' });
  await examDialog.getByText(/pendiente de confirmar hoy/).waitFor();
  assert.equal(await examDialog.locator('select').nth(0).inputValue(), '');
  await examDialog.getByRole('button', { name: 'Confirmar estos parámetros manualmente hoy', exact: true }).click();
  assert.equal(await examDialog.locator('select').nth(0).inputValue(), 'Normal');
  await examDialog.getByLabel('Motivo de consulta').fill('Consulta sintética');
  await examDialog.getByLabel('Tipo de piel').selectOption('No determinado');
  await examDialog.getByLabel('Fototipo').selectOption('No determinado');
  await examDialog.getByRole('button', { name: 'Guardar examen' }).evaluate(button => { button.click(); button.click(); });
  await examDialog.getByText('Respuesta incierta sintética').waitFor();
  await examDialog.getByRole('button', { name: 'Guardar examen' }).click();
  await page.getByText(/Se creó una consulta nueva/).waitFor();
  const exams = writes.filter(w => w.action === 'saveSimulationExam');
  assert.equal(exams.length, 2);
  assert.equal(exams[0].body.requestId, exams[1].body.requestId);
  assert.equal(exams[1].body.exam.skin_visual_review.simulationId, 91);
  assert.equal(writes.filter(w => w.action === 'saveFacialSimulation').length, 1);
  assert.equal(writes.filter(w => w.action === 'uploadPhotoProxy').length, 1);

  await page.getByRole('button', { name: 'Cambiar expediente' }).click();
  await page.getByRole('button', { name: 'Buscar paciente' }).click();
  await page.getByRole('button', { name: /Otro Prueba/ }).click();
  await page.getByRole('button', { name: /Expediente #20/ }).click();
  await page.getByText('Otro Prueba · Expediente #20').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="fake-photo-count"]')?.textContent === '0');
  assert.equal(await page.evaluate(() => window.fakeResets), 1);
  await page.getByRole('button', { name: 'Agregar foto temporal' }).click();
  await page.getByRole('button', { name: 'Volver' }).click();
  await page.getByRole('button', { name: 'Seguir trabajando' }).click();
  assert.equal(await page.getByTestId('fake-photo-count').innerText(), '1');
  await page.evaluate(() => { void window.fixtureRouter.navigate(-1); });
  await page.getByRole('button', { name: 'Descartar y salir' }).click();
  await page.getByText('Inicio de prueba').waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, examAttempts, writes: writes.map(w => w.action) }));
} finally { await browser.close(); }
