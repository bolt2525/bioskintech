/** Tab y workspace reales; visor genérico sustituido para aislar navegación de WebGL. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const errors = [], writes = [], external = [], aiRequests=[];
let failMask = true, failExam = true;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.endsWith('/context/AuthContext.tsx')) return route.fulfill({ contentType: 'application/javascript',
      body: `export const useAuth=()=>({hasFeature:()=>false});` });
    if (url.pathname.endsWith('/Clinical3DViewer.tsx') && !url.searchParams.has('qa-original')) return route.fulfill({ contentType: 'application/javascript', body: `
      import React from '/node_modules/.vite/deps/react.js';
      ${process.env.QA_REAL_VIEWERS ? "import ActualViewer from '/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx?qa-original';" : ''}
      export default function Viewer(props){const {markers=[],modelData}=props;return React.createElement(React.Fragment,null,
        React.createElement('output',{'data-testid':modelData?'mask-preview':'generic-mark-count','data-readonly':!!props.readOnly},String(markers.length)),
        React.createElement('output',{'data-testid':modelData?'mask-point-count':'reference-point-count',
          'data-highlighted':props.highlightedPointIds?.join(',')??'','data-showmarks':props.showEditablePoints!==false,
          'data-labels':props.annotationLabels?.length??0},String(props.editablePoints?.length??0)),
        ${process.env.QA_REAL_VIEWERS ? 'React.createElement(ActualViewer,props)' : 'null'})}
    ` });
    if (url.pathname.endsWith('/FaceSimLab.tsx')) return route.fulfill({ contentType: 'application/javascript',
      body: (await (await route.fetch()).text()).replace('onController?.(controller)', '(window.captureController = controller, onController?.(controller))') });
    if (url.pathname.startsWith('/api/')) {
      if(['skinVisualStatus','analyzeSkinVisual'].includes(url.searchParams.get('action')))aiRequests.push(request.url());
      if (request.method() !== 'GET') writes.push(request.postDataJSON());
      const action=request.method()==='POST'?request.postDataJSON().action??url.searchParams.get('action'):url.searchParams.get('action');
      if(action==='uploadPhotoProxy')return route.fulfill({json:{id:81,r2_key:'clinics/synthetic/records/12/photos/81.png'}});
      if(action==='saveFacialSimulation'){
        if(failMask){failMask=false;return route.fulfill({status:503,json:{error:'Almacenamiento temporalmente no disponible (fixture).'}});}
        return route.fulfill({json:{id:93}});
      }
      if(action==='savePhysicalExam'){
        if(failExam){failExam=false;return route.fulfill({status:503,json:{error:'Examen no confirmado (fixture).'}});}
        return route.fulfill({json:{id:42}});
      }
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
      import {anchorForPhoto} from '/src/components/admin/ficha-clinica/components/skinEvaluation.ts';
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
        const box={x:.48,y:.48,width:.04,height:.04};
        const anchor=anchorForPhoto(box,{id:'frontal',label:'Frontal',group:'front',confirmed:true,canvas,
          mapping:{landmarks,direction:[0,0,1],manual:false}},surface);
        if(!anchor)throw Error('Fixture sin correspondencia');
        const marks=[{id:'new-skin',sourceId:'frontal',category:'other',label:'Punto sincronizado',note:'',box,anchor,
          status:'validated',reviewedAt:'2026-11-06T00:00:00.000Z',source:{provider:'manual'}}];
        await window.captureController.restore({version:1,atlas:{modelId:atlas.modelId,version:1,glbSha256:atlas.provenance.glbSha256},
          photos:[{slot:'frontal',photo:{id:81,r2Key:'clinics/synthetic/records/12/photos/81.png'},alignment:{
            frame:{top:.05,bottom:.95,left:.1,right:.9,axisTop:{x:.5,y:.05},axisBottom:{x:.5,y:.95},source:'manual'},landmarks,captureConfirmed:true}}],
          mask:{view:'frontal',surface:storeSurface(surface),renderSurface:storeSurface(surface),glbBase64:bufferToBase64(glb),
            depth:1,depthDetails:'Sintético',diagnostics:[],closedHead:false},marks},{frontal:canvas},
          {frontal:await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))});
      };
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__physical_workspace_fixture__`);
  await page.getByTestId('generic-mark-count').waitFor();
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), true, 'El modelo aparece al entrar');
  const viewerBounds = await page.getByRole('region', {name:'Visor de evaluación facial'}).boundingBox();
  assert.ok(viewerBounds.height > 100, 'El contenedor no comprime el visor');
  await page.getByRole('button', {name:'Evaluar parámetros',exact:true}).click();
  const parameters = page.getByRole('dialog',{name:'Evaluación clínica de la piel',exact:true});
  await parameters.getByRole('button',{name:'Seca',exact:true}).click();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:process.env.QA_SCREENSHOT_DIR+'\\parametros-modal.png'});
  await parameters.getByRole('button',{name:'Cancelar',exact:true}).click();
  assert.match(await page.getByRole('region',{name:'Resumen clínico'}).innerText(),/Normal/);
  await page.getByRole('button', {name:'Evaluar parámetros',exact:true}).click();
  await parameters.getByRole('button',{name:'Seca',exact:true}).click();
  await parameters.getByRole('button',{name:'Aplicar evaluación',exact:true}).click();
  assert.match(await page.getByRole('region',{name:'Resumen clínico'}).innerText(),/Seca/);
  await page.getByRole('button',{name:'Editar Lesión antigua',exact:true}).click();
  const legacyDetail=page.getByRole('dialog',{name:'Detalles de la Lesión',exact:false});
  await legacyDetail.getByRole('slider',{name:'Tamaño de la marca anatómica',exact:true}).press('ArrowRight');
  await legacyDetail.getByRole('button',{name:'Reubicar marca',exact:true}).click();
  await page.getByRole('button',{name:'Cancelar reubicación anatómica',exact:true}).click();
  await page.getByRole('button', { name: /Continuar en modelo genérico/ }).click();
  assert.equal(await page.getByRole('region', { name: 'Evaluación compartida de piel' }).count(), 0);
  await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Elegir fotografías', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('region',{name:'Guía de fotografías'}).waitFor();
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:process.env.QA_SCREENSHOT_DIR+'\\guia-fotos.png'});
  assert.equal(await dialog.getByRole('button',{name:'Ahora no',exact:true}).isVisible(),true);
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
  assert.equal(await page.getByTestId('generic-mark-count').getAttribute('data-readonly'),'false','Cancelar fotos deja disponible el marcado original');
  await page.getByRole('button', { name: /Continuar en modelo genérico/ }).click();
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(), true);
  assert.equal(await workspace.isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).click();
  await page.getByRole('dialog', { name: 'Elegir fotografías', exact: true }).waitFor();
  await page.evaluate(() => window.restoreSyntheticMask());
  await page.getByRole('group', { name: 'Modo de visor facial' }).waitFor();
  await page.getByRole('button', { name: 'Máscara del paciente', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Máscara del paciente', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('generic-mark-count').count(), 0);
  await page.getByRole('button', { name: 'Modelo anatómico', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Máscara del paciente', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await workspace.isVisible(), false);
  await page.getByTestId('reference-point-count').filter({hasText:'1'}).waitFor();
  assert.equal(await page.getByRole('region',{name:'Editor de evaluación de piel'}).count(),0,'No se monta la máscara oculta');
  if(process.env.QA_REAL_VIEWERS)assert.equal(await page.locator('canvas').count(),1,JSON.stringify(await page.locator('canvas').evaluateAll(nodes=>nodes.map(node=>({
    label:node.getAttribute('aria-label'),parents:[node.parentElement,node.parentElement?.parentElement,node.closest('section')].map(item=>item?.outerHTML.slice(0,250))
  })))));
  await page.getByRole('button', { name: 'Comparar ambos', exact: true }).click();
  assert.equal(await page.getByTestId('generic-mark-count').first().innerText(), '1', 'La migración conserva el modelo y sus marcas originales');
  const genericZones = page.getByRole('button', { name: 'Mostrar zonas', exact: true }).last();
  await genericZones.click();
  assert.equal(await page.getByRole('button', { name: 'Ocultar zonas', exact: true }).last().getAttribute('aria-pressed'), 'true');
  assert.equal(await workspace.isVisible(), true);
  assert.equal(await page.getByTestId('generic-mark-count').first().isVisible(), true);
  assert.equal(await page.getByText(/asistencia IA|IA no disponible|Consultando herramientas/).count(),0);
  assert.equal(writes.length,0);
  assert.equal(aiRequests.length,0,'Sin permiso no se consulta ni se menciona la asistencia');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if(process.env.QA_REAL_VIEWERS){
    await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].filter(canvas=>canvas.checkVisibility()&&canvas.width>0).length===2);
    const canvases=page.locator('canvas:visible');
    const a=await canvases.nth(0).boundingBox(),b=await canvases.nth(1).boundingBox();
    assert.ok(Math.abs(a.y-b.y)<2 && Math.abs(a.height-b.height)<2,'Ambos visores reales quedan alineados');
  }
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\examen-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileComparison=page.getByRole('group',{name:'Vista de comparación móvil'});
  await mobileComparison.getByRole('button',{name:'Referencia',exact:true}).click();
  assert.equal(await page.getByTestId('generic-mark-count').isVisible(),true);
  await mobileComparison.getByRole('button',{name:'Máscara',exact:true}).click();
  assert.equal(await page.getByTestId('generic-mark-count').count(),0,'En móvil no se monta la referencia oculta');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\examen-mobile.png`, fullPage: true });
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Máscara del paciente',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Preparar para guardar',exact:true}).count(),0,'Un solo guardado evidente');
  const editor=page.getByRole('region',{name:'Editor de evaluación de piel'});
  await editor.getByLabel('Lesión a marcar',{exact:true}).fill('Lesión nueva sintética');
  await editor.getByRole('button',{name:/^Fotografías \(/}).click();
  await editor.getByRole('button',{name:'Añadir marca en el centro',exact:true}).click();
  const markDialog=page.getByRole('dialog',{name:'Revisar marca',exact:true});
  await markDialog.getByRole('button',{name:'Cerrar',exact:true}).click();
  const save=page.getByRole('button',{name:'Guardar examen físico',exact:true});
  await save.click();
  await page.getByText('Confirma o descarta las marcas pendientes antes de guardar.',{exact:true}).waitFor();
  assert.equal(writes.length,0,'No se sube ni crea examen con pendientes');
  await editor.getByRole('button',{name:/Lesión nueva sintética.*Por revisar/}).click();
  await markDialog.getByRole('textbox',{name:'Zona y observaciones',exact:true}).waitFor();
  assert.equal(await markDialog.getByRole('button',{name:/Validar región|Validar ubicación/}).count(),0);
  await markDialog.getByRole('button',{name:'Confirmar',exact:true}).click();
  const rows=page.locator('div.max-h-48');
  await rows.getByRole('button',{name:'Editar Lesión nueva sintética en la máscara',exact:true}).waitFor();
  await editor.getByRole('button',{name:/Lesión nueva sintética.*Confirmada/}).hover();
  await page.waitForFunction(()=>document.querySelector('[data-testid=mask-point-count]')?.dataset.highlighted);
  await page.getByRole('button',{name:'Ocultar nombres',exact:true}).click();
  assert.equal(await page.getByTestId('mask-point-count').getAttribute('data-labels'),'0');
  await page.getByRole('button',{name:'Mostrar nombres',exact:true}).click();
  await page.getByRole('button',{name:'Ocultar marcas',exact:true}).click();
  assert.equal(await page.getByTestId('mask-point-count').getAttribute('data-showmarks'),'false');
  await page.getByRole('button',{name:'Mostrar marcas',exact:true}).click();
  await save.click();
  await page.getByText('Almacenamiento temporalmente no disponible (fixture).',{exact:true}).first().waitFor();
  assert.equal(writes.filter(write=>write.record_id&&write.face_map_data).length,0,'No guardar examen si falla la máscara');
  await save.evaluate(button=>{button.click();button.click();});
  await page.getByText('Examen no confirmado (fixture).',{exact:true}).waitFor();
  assert.equal(writes.filter(write=>write.face_map_data).length,1,'Doble clic no duplica el examen');
  const savesBeforeRetry=writes.filter(write=>write.action==='saveFacialSimulation').length;
  await save.click();
  await page.getByText('Examen físico guardado correctamente',{exact:true}).waitFor();
  assert.equal(writes.filter(write=>write.action==='saveFacialSimulation').length,savesBeforeRetry,'Reintentar examen reutiliza máscara preparada');
  const maskWrites=writes.filter(write=>write.action==='saveFacialSimulation');
  assert.equal(maskWrites.length,2);
  assert.equal(maskWrites[0].requestId,maskWrites[1].requestId,'Reintento mantiene UUID idempotente');
  assert.equal(writes.filter(write=>write.action==='uploadPhotoProxy').length,1,'No vuelve a subir la foto');
  const payload=writes.filter(write=>write.face_map_data).at(-1);
  assert.equal(payload.skin_visual_review.simulationId,93);
  assert.equal(payload.skin_visual_review.annotations.length,2);
  const savedLegacy=JSON.parse(payload.face_map_data);
  const originalLegacy=await page.evaluate(()=>window.originalLegacy);
  assert.equal(savedLegacy.length,1);
  assert.equal(savedLegacy[0].id,originalLegacy[0].id);
  assert.deepEqual(savedLegacy[0].position3D,originalLegacy[0].position3D,'La máscara no modifica la ubicación original');
  assert.equal(maskWrites.at(-1).state.marks.length,2);
  assert.ok(maskWrites.at(-1).state.mask.surface.positions.length>0);
  assert.equal(aiRequests.length,0);
  await page.getByRole('button', { name: 'Nuevo examen', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Migrar marcaciones a máscara/ }).count(), 0);
  assert.equal(await page.getByTestId('generic-mark-count').first().innerText(), '0');
  await page.getByRole('button', { name: /^Crear máscara facial/ }).click();
  await page.getByRole('region', { name: 'Evaluación compartida de piel' }).waitFor();
  await page.getByRole('dialog', { name: 'Elegir fotografías', exact: true }).waitFor();
  assert.equal(writes.length,5); assert.deepEqual(errors, []);
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)));
  assert.equal(await page.evaluate(() => window.originalLegacy[0].id), 'old-face');
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], legacyPreserved: true, examWithoutModuleOptIn: true }));
} finally { await browser.close(); }
