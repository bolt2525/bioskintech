/** Editor real con originales sintéticos; todas las APIs y la salida externa quedan interceptadas. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let enabled = false;
const sent = [], errors = [], external = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      if (url.searchParams.get('action') === 'skinVisualStatus') return route.fulfill({ json: {
        enabled, reason: 'Permiso sintético', model: 'gemini-3.5-flash-lite', usedUsd: 0, remainingUsd: 5, limitUsd: 5,
      } });
      if (url.searchParams.get('action') === 'analyzeSkinVisual') {
        sent.push(request.postDataJSON());
        return route.fulfill({ json: { analysisId: '00000000-0000-4000-8000-000000000001', model: 'gemini-3.5-flash-lite',
          proposals: ['Uno', 'Dos'].map((label, index) => ({ id: String(index), category: 'spot', label, note: '',
            box: { x: .1 + index * .3, y: .2, width: .1, height: .1 } })),
          summary: 'Fixture, no evaluación clínica', limitations: ['Sintético'], usage: { usedUsd: .01, remainingUsd: 4.99, limitUsd: 5 } } });
      }
      throw new Error(`API no esperada: ${url.pathname}`);
    }
    if (url.pathname !== '/__skin_editor_fixture__') return route.continue();
    const html = await (await route.fetch()).text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Editor from '/src/components/admin/ficha-clinica/components/SkinEvaluationEditor.tsx';
      import {toPersistedSkinReview,fromPersistedSkinReview} from '/src/components/admin/ficha-clinica/components/skinEvaluation.ts';
      import '/src/index.css';
      const original=document.createElement('canvas');original.width=1200;original.height=900;
      original.getContext('2d').fillStyle='#bd3322';original.getContext('2d').fillRect(0,0,1200,900);
      const blob=await new Promise(resolve=>original.toBlob(resolve,'image/png'));
      const decode=window.createImageBitmap.bind(window);window.originalDecodes=0;
      window.createImageBitmap=(input,...args)=>{if(input===blob)window.originalDecodes++;return decode(input,...args);};
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=120;
      canvas.getContext('2d').fillStyle='#00ff00';canvas.getContext('2d').fillRect(0,0,160,120);
      const sources=['frontal','izquierda'].map((id,index)=>({id,label:index?'Oblicua':'Frontal',group:index?'left':'front',
        confirmed:false,canvas,original:blob}));
      function App(){
        const [marks,setMarks]=React.useState([]);
        const [allow,setAllow]=React.useState(true);
        const [presentation,setPresentation]=React.useState('comparison');
        window.setPresentation=setPresentation;
        window.setAssistanceAllowed=setAllow;
        window.marks=marks;
        window.roundtrip=()=>{
          const refs={frontal:{id:1,r2Key:'clinics/fixture/records/12/photos/1.png'},
            izquierda:{id:2,r2Key:'clinics/fixture/records/12/photos/2.png'}};
          const persisted=toPersistedSkinReview(marks,refs);
          setMarks(fromPersistedSkinReview(JSON.parse(JSON.stringify(persisted)),refs));
          return persisted;
        };
        return React.createElement(Editor,{sources,value:marks,onChange:setMarks,context:{},aiAllowed:allow,presentation});
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__skin_editor_fixture__`);
  await page.getByRole('button', { name: 'Añadir marca en el centro', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Buscar asistido', exact: true }).count(), 0);
  assert.equal(await page.evaluate(()=>window.originalDecodes),0,'Sin recorte no se decodifica el original completo');
  await page.getByRole('button', { name: 'Añadir marca en el centro', exact: true }).click();
  await page.getByText('Selecciona o escribe una lesión antes de marcar.', {exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog',{name:'Revisar marca',exact:true}).count(),0);
  await page.getByLabel('Lesión a marcar', {exact:true}).fill('Lesión');
  await page.getByRole('button', { name: 'Añadir marca en el centro', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  const identity = await page.evaluate(() => window.marks[0].id);
  const validatedDot=page.getByRole('button',{name:'Seleccionar Lesión, validada',exact:true});
  assert.equal(await validatedDot.evaluate(node=>getComputedStyle(node).borderColor),'rgb(34, 211, 238)');
  assert.match(await validatedDot.evaluate(node=>getComputedStyle(node).boxShadow),/rgb\(15, 23, 42\)/,'Borde oscuro sobre cualquier tono de foto');
  await page.getByRole('button', { name: 'Seleccionar Lesión, validada', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.getByRole('button', { name: /Oblicua.*sin confirmar/ }).click();
  await page.getByText(/no tiene correspondencia fiable/).waitFor();
  await page.getByRole('button', { name: 'Vincular observación a la región seleccionada', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular observación central', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ id: window.marks[0].id, length: window.marks.length, observations: window.marks[0].observations.length })),
    { id: identity, length: 1, observations: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByText(/Máscara 3D no disponible/).waitFor();
  await page.getByRole('button', { name: 'Foto', exact: true }).click();
  assert.equal(await page.evaluate(() => window.roundtrip().annotations[0].observations.length), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  enabled = true;
  await page.reload();
  await page.waitForFunction(()=>window.setPresentation);
  await page.evaluate(()=>window.setPresentation('mask-first'));
  await page.getByRole('button',{name:'Máscara 3D',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Lesión a marcar',exact:true}).isVisible(),true);
  await page.getByRole('button', { name: 'Buscar asistido', exact: true }).click();
  await page.getByRole('button',{name:/^Fotografías \(/}).click();
  await page.getByRole('button', { name: 'Seleccionar zona central', exact: true }).click();
  const preview = page.getByRole('img', { name: 'Vista previa del recorte original', exact: true });
  await preview.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Vista previa del recorte original"]')?.width > 1);
  assert.equal(await page.evaluate(()=>window.originalDecodes),1,'El original solo se abre al encuadrar');
  const before = await preview.evaluate(canvas => canvas.width);
  await page.getByLabel(/^Ancho:/).press('ArrowRight');
  await page.waitForFunction(width => document.querySelector('[aria-label="Vista previa del recorte original"]').width !== width, before);
  await page.getByRole('checkbox', { name: 'Confirmo el envío de este recorte a Gemini.' }).check();
  await page.getByRole('button', { name: 'Confirmar y buscar', exact: true }).click();
  await page.getByText('Revisión del último grupo de propuestas', { exact: true }).waitFor();
  const pendingDot=page.getByRole('button',{name:'Seleccionar Uno, pendiente',exact:true});
  assert.equal(await pendingDot.evaluate(node=>getComputedStyle(node).borderColor),'rgb(192, 132, 252)');
  assert.equal(await pendingDot.innerText(),'Uno','Nombre compacto sin repetir el estado');
  assert.match(await pendingDot.getAttribute('aria-label'),/pendiente/,'Estado íntegro en nombre accesible');
  assert.ok(await page.getByLabel('Estado de las marcas', {exact:true}).filter({hasText:'Por revisar'}).count(), 'Leyenda textual accesible');
  assert.equal(sent.length, 1); assert.equal(sent[0].temporary, true); assert.equal('recordId' in sent[0], false);
  assert.equal(sent[0].consent, true);
  const pixel = await page.evaluate(async base64 => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${base64}`)).blob());
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 1, 1); bitmap.close();
    return Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data);
  }, sent[0].imageBase64);
  assert.ok(pixel[0] > 150 && pixel[1] < 100, 'Se envía el original rojo, nunca el canvas verde');
  await page.getByRole('checkbox', { name: 'Incluir Dos', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Validar grupo seleccionado', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks.map(m => m.status)), ['validated', 'pending']);
  await page.getByRole('button', { name: 'Descartar pendientes del grupo', exact: true }).click();
  await page.getByRole('button', { name: /Uno.*Confirmada/ }).click();
  await page.getByLabel('Lesión o descripción', { exact: true }).fill('Descripción libre revisada');
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  const persisted = await page.evaluate(() => window.roundtrip());
  assert.equal(persisted.annotations.length, 1);
  assert.equal(persisted.annotations[0].source.provider, 'edited');
  assert.equal(persisted.annotations[0].crop.sourceWidth, 1200);
  assert.equal(persisted.annotations[0].crop.sourceHeight, 900);
  const originalCrop=persisted.annotations[0].crop;
  await page.getByRole('button',{name:/Descripción libre revisada.*Confirmada/}).click();
  await page.getByRole('button',{name:'Reubicar marca',exact:true}).click();
  await page.getByRole('button',{name:/Oblicua.*sin confirmar/}).click();
  const photoTarget=page.getByRole('button',{name:/^Añadir marca en la foto/});
  await photoTarget.click({position:{x:50,y:50}});
  await page.getByText('Reubica esta marca desde su foto original para conservar la evidencia del análisis.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.marks.length),1);
  await page.getByRole('button',{name:/Frontal.*sin confirmar/}).click();
  await photoTarget.click({position:{x:70,y:70}});
  await page.getByRole('button',{name:/Descripción libre revisada.*Confirmada/}).click();
  await page.getByRole('button',{name:'Confirmar',exact:true}).click();
  const moved=await page.evaluate(()=>window.roundtrip());
  assert.deepEqual(moved.annotations[0].crop,originalCrop,'Reubicar conserva evidencia del recorte original');
  await page.getByRole('button',{name:'Buscar asistido',exact:true}).click();
  await page.evaluate(()=>window.setAssistanceAllowed(false));
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(button=>button.textContent==='Buscar asistido'));
  await page.getByLabel('Lesión a marcar',{exact:true}).fill('Lesión');
  await page.getByRole('button',{name:'Añadir marca en el centro',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.marks.length),2,'Revocar asistencia devuelve la interacción al marcado manual');
  assert.equal(sent.length,1,'Revocar no permite más análisis');
  await page.getByRole('dialog',{name:'Revisar marca',exact:true}).getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.getByRole('combobox',{name:'Lesión a marcar',exact:true}).fill('Zona manual sintética');
  await page.getByRole('group',{name:'Tipo de marcación',exact:true}).getByRole('button',{name:'Zonal',exact:true}).click();
  await page.getByRole('button',{name:'Añadir marca en el centro',exact:true}).click();
  const detail=page.getByRole('dialog',{name:'Revisar marca',exact:true});
  assert.equal(await detail.getByRole('combobox',{name:'Lesión o descripción',exact:true}).inputValue(),'Zona manual sintética');
  const oldWidth=await page.evaluate(()=>window.marks.at(-1).box.width);
  await detail.getByRole('slider',{name:'Tamaño de la marca',exact:true}).press('ArrowRight');
  assert.ok(await page.evaluate(()=>window.marks.at(-1).box.width)>oldWidth);
  await detail.getByRole('button',{name:'Eliminar marca',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.marks.length),2);
  await page.getByRole('button',{name:'Deshacer eliminación',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.marks.length),3);
  assert.equal(await page.evaluate(()=>window.marks.at(-1).label),'Zona manual sintética');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], syntheticAnalyses: sent.length, sameIdentityMultiview: true }));
} finally { await browser.close(); }
