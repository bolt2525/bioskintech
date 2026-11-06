/** Flujo real de capturas, detector sustituido por landmarks sintéticos; sin datos clínicos ni proveedor. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], writes = [], external = [];
let libraryImages = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'synthetic.invalid') {
      const index = Number(url.pathname.match(/skin-(\d+)/)?.[1]) - 81;
      assert.ok(libraryImages[index], 'Solo fotos sintéticas conocidas');
      return route.fulfill({ contentType: 'image/png', body: libraryImages[index] });
    }
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(request.postData());
      if (url.searchParams.get('action') === 'skinVisualStatus') return route.fulfill({ json: {
        enabled: false, reason: 'Deshabilitada', model: 'gemini-3.5-flash-lite', usedUsd: 0, remainingUsd: 5, limitUsd: 5,
      } });
      if (url.searchParams.get('action') === 'listPhotos') return route.fulfill({ json: { photos: [81, 82, 83].map(id => ({
        id, r2_key: `clinics/synthetic/records/12/photos/${id}.png`, r2_url: `https://synthetic.invalid/skin-${id}.png`,
      })), hasMore: false } });
      if (request.method() === 'POST' && request.postDataJSON().action === 'saveFacialSimulation') return route.fulfill({ json: { id: 90 } });
      return route.fulfill({ status: 403, json: { error: 'API real bloqueada' } });
    }
    if (url.pathname.endsWith('/FaceSimLab.tsx')) {
      const source = await (await route.fetch()).text();
      const start = source.indexOf('async function detectFrame(img)'), end = source.indexOf('let landmarkerPromise', start);
      assert.ok(start > 0 && end > start, 'Interceptar únicamente el detector del fixture');
      return route.fulfill({ contentType: 'application/javascript', body: source.slice(0, start) + `
        async function detectFrame(img) {
          if (img.getContext('2d').getImageData(0,0,1,1).data[0]===255) return {frame:null,reason:'Sin rostro fiable en el fixture'};
          const landmarks=window.syntheticLandmarks.map(p=>({...p}));
          if(window.singleBorderFixture)landmarks[152].y=.998;
          const quality=assessFaceCapture(img.getContext('2d').getImageData(0,0,img.width,img.height),landmarks,1);
          if(!quality.accepted)return {frame:null,reason:quality.reasons.join(' ')};
          return {frame:frameFromLandmarks(landmarks),landmarks,detectedLandmarks:landmarks,reason:'',captureWarnings:quality.warnings};
        }
      ` + source.slice(end).replace('onController?.(controller)', '(window.controller = controller, onController?.(controller))') });
    }
    if (!['/__clinical_capture_fixture__', '/__clinical_library_fixture__'].includes(url.pathname)) return route.continue();
    const html = await (await route.fetch()).text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Lab from '/src/lab/faceSim/FaceSimLab.tsx';
      import Workspace from '/src/components/admin/ficha-clinica/components/SkinExamWorkspace.tsx';
      import atlas from '/src/lab/faceSim/genericFaceAtlas.json';
      import '/src/index.css';
      window.syntheticLandmarks=Array.from({length:468},(_,i)=>({x:.5+atlas.positions[i*3]*.16,y:.5-atlas.positions[i*3+1]*.16,z:atlas.positions[i*3+2]*.16}));
      window.createFiles=async (invalid=false) => {
        const files=[];
        for(let i=0;i<(invalid?1:3);i++){
          const canvas=document.createElement('canvas');canvas.width=360;canvas.height=480;
          const ctx=canvas.getContext('2d');ctx.fillStyle=invalid?'rgb(255,255,255)':'rgb('+(150+i*12)+',120,100)';ctx.fillRect(0,0,360,480);
          if(!invalid)for(let y=1;y<480;y+=4)for(let x=1;x<360;x+=4){ctx.fillStyle='rgb(175,145,125)';ctx.fillRect(x,y,2,2);}
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          files.push(new File([blob],'sintetica-'+i+'.png',{type:'image/png'}));
        }
        return files;
      };
      window.makeFiles=async invalid=>window.controller.importPhotos(await window.createFiles(invalid));
      ReactDOM.createRoot(document.getElementById('root')).render(${url.pathname === '/__clinical_library_fixture__'
        ? `React.createElement(Workspace,{recordId:12,context:{},onPrepared:value=>window.prepared=value,onDirty:()=>{}})`
        : `React.createElement(Lab,{integration:{mode:'skin-exam',recordId:12,onController:value=>window.controller=value,onDirty:()=>{}}})`});
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__clinical_capture_fixture__`);
  await page.waitForFunction(() => window.controller && window.makeFiles);
  const guide=page.getByRole('dialog',{name:'Elegir fotografías',exact:true});
  await guide.getByRole('button',{name:'Ahora no',exact:true}).click();
  await page.getByRole('button',{name:'Elegir fotografías',exact:true}).click();
  const files=(await page.evaluate(async()=>Promise.all((await window.createFiles()).map(async file=>({
    name:file.name,mimeType:file.type,base64:btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
  }))))).map(({base64,...file})=>({...file,buffer:Buffer.from(base64,'base64')}));
  const upload=page.locator('dialog[open] input[type=file]');
  assert.equal(await upload.getAttribute('multiple'),'');
  await page.evaluate(()=>window.singleBorderFixture=true);
  await upload.setInputFiles(files[0]);
  await page.waitForFunction(()=>window.controller.getPhotos().length===1);
  await page.waitForFunction(()=>!document.querySelector('dialog[open] input[type=file]').disabled);
  const single=page.getByRole('dialog',{name:'Revisar fotos juntas',exact:true});
  await single.getByText(/Una frontal es suficiente\. Añade una oblicua/).waitFor();
  await single.getByText(/Rostro cerca del borde:/).waitFor();
  assert.equal(await single.getByRole('checkbox').isDisabled(),false,'Aviso de borde no bloquea la selección');
  assert.equal(await single.getByRole('checkbox').isChecked(),true);
  await single.getByRole('button',{name:'Ajustar borde',exact:true}).click();
  const topBefore=await single.locator('polygon').getAttribute('points');
  const top=single.locator('circle').first();
  const box=await top.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2-16,{steps:6});
  await page.mouse.up();
  const topAfter=await single.locator('polygon').getAttribute('points');
  assert.notEqual(topAfter,topBefore);
  const beforeCoords=topBefore.split(' ').map(point=>point.split(',').map(Number));
  const afterCoords=topAfter.split(' ').map(point=>point.split(',').map(Number));
  assert.ok(afterCoords[0][1]<beforeCoords[0][1]-8,'El punto frontal sigue el arrastre');
  assert.ok(afterCoords[1][1]<beforeCoords[1][1]-2 && afterCoords.at(-1)[1]<beforeCoords.at(-1)[1]-2,'Ambos lados de la frente se recalculan');
  await single.getByRole('button',{name:'Listo',exact:true}).click();
  await single.getByRole('checkbox').uncheck();
  assert.equal(await single.getByRole('button',{name:'Confirmar fotos y generar máscara',exact:true}).isDisabled(),true);
  await single.getByRole('checkbox').check();
  await single.getByRole('button',{name:'Confirmar fotos y generar máscara',exact:true}).click();
  const singleCandidate=page.getByRole('dialog',{name:'Confirmar máscara',exact:true});
  await singleCandidate.waitFor({timeout:120000});
  await singleCandidate.getByText(/Solo base frontal: cobertura y profundidad limitadas/).waitFor();
  await singleCandidate.getByRole('button',{name:'Usar máscara',exact:true}).click();
  await page.getByRole('region',{name:'Editor de evaluación de piel'}).waitFor();
  const singleMask=await page.evaluate(()=>window.controller.snapshot({
    frontal:{id:81,r2Key:'clinics/synthetic/records/12/photos/81.png'}
  }));
  assert.equal(singleMask.photos.length,1);
  assert.equal(singleMask.photos[0].slot,'frontal');
  assert.ok(singleMask.mask?.glbBase64.length>0,'Se construyó GLB real con una frontal, sin IA');
  assert.ok(singleMask.photos[0].alignment.landmarks[10].y<beforeCoords[0][1]/480-.01,'El límite corregido se conserva en la sesión editable');
  assert.equal(writes.length,0,'Generar una máscara no requiere escrituras de API');
  await page.reload();
  await page.waitForFunction(()=>window.controller&&window.makeFiles);
  await upload.setInputFiles(files[0]);
  await page.waitForFunction(()=>window.controller.getPhotos().length===1);
  await page.waitForFunction(()=>!document.querySelector('dialog[open] input[type=file]').disabled);
  await upload.setInputFiles(files.slice(1));
  const dialog = page.getByRole('dialog', { name: 'Revisar fotos juntas', exact: true });
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('dialog input[type=checkbox]:checked').length === 3);
  assert.equal(await page.locator('dialog[open]').count(), 1);
  assert.equal(await dialog.locator('polygon').count(), 3);
  assert.equal(await dialog.getByText('Diagnóstico estadístico opcional', { exact: true }).count(), 0);
  assert.equal(await dialog.getByText('Herramientas avanzadas y ayuda', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('Posición X (%)', { exact: true }).count(), 0);
  const checks = dialog.getByRole('checkbox');
  await checks.nth(1).uncheck(); assert.equal(await checks.nth(1).isChecked(), false);
  await checks.nth(1).check();
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\capturas-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  const confirm = dialog.getByRole('button', { name: 'Confirmar fotos y generar máscara', exact: true });
  const bounds = await confirm.boundingBox(); assert.ok(bounds.y + bounds.height <= 844 && bounds.x >= 0);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}\\capturas-mobile.png` });
  await confirm.click();
  const candidate = page.getByRole('dialog', { name: 'Confirmar máscara', exact: true });
  await candidate.waitFor({ timeout: 120000 });
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await candidate.getByRole('button', { name: 'Usar máscara', exact: true }).click();
  await page.getByRole('region', { name: 'Editor de evaluación de piel' }).waitFor();
  assert.equal(await page.evaluate(() => window.controller.getPhotos().length), 3);
  assert.equal(await page.evaluate(() => window.controller.getMarks().length), 0);
  assert.equal(await page.getByRole('button', { name: 'Buscar asistido', exact: true }).count(), 0);
  await page.reload();
  await page.waitForFunction(() => window.controller && window.makeFiles);
  await page.locator('dialog[open] input[type=file]').setInputFiles(files);
  await page.waitForFunction(()=>window.controller.getPhotos().length===3);
  await page.reload();
  await page.waitForFunction(() => window.controller && window.makeFiles);
  await page.evaluate(() => window.makeFiles(true));
  const invalid = page.getByRole('dialog', { name: 'Revisar fotos juntas', exact: true });
  await invalid.getByText('Sin rostro fiable en el fixture', { exact: true }).waitFor();
  assert.equal(await invalid.getByRole('checkbox').isChecked(), false);
  assert.equal(await invalid.getByRole('checkbox').isDisabled(), true);
  assert.equal(await invalid.getByRole('button', { name: 'Confirmar fotos y generar máscara', exact: true }).isDisabled(), true);
  await invalid.getByRole('button', { name: 'Continuar solo en foto', exact: true }).click();
  await page.getByRole('region', { name: 'Editor de evaluación de piel' }).waitFor();
  assert.equal(await page.evaluate(() => window.controller.getPhotos().length), 1);
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  await page.goto(`${origin}/__clinical_library_fixture__`);
  await page.waitForFunction(() => window.controller && window.createFiles);
  libraryImages = (await page.evaluate(async () => Promise.all((await window.createFiles()).map(async file =>
    btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))))))).map(encoded => Buffer.from(encoded, 'base64'));
  const libraryDialog = page.getByRole('dialog', { name: 'Elegir fotografías', exact: true });
  await libraryDialog.getByRole('button', { name: 'Fotos del expediente', exact: true }).click();
  for (const id of [81, 82, 83]) await libraryDialog.getByRole('checkbox', { name: `Seleccionar foto ${id}`, exact: true }).check();
  await libraryDialog.getByRole('button', { name: 'Usar fotos seleccionadas (3)', exact: true }).click();
  await page.waitForFunction(() => window.controller.getPhotos().length === 3);
  await page.waitForFunction(() => document.querySelectorAll('dialog input[type=checkbox]:checked').length === 3);
  const groupedLibrary = page.getByRole('dialog', { name: 'Revisar fotos juntas', exact: true });
  await groupedLibrary.getByRole('button', { name: 'Continuar solo en foto', exact: true }).click();
  await page.getByRole('button', { name: 'Preparar para guardar', exact: true }).click();
  await page.waitForFunction(() => window.prepared?.simulationId === 90);
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0]);
  assert.equal(saved.action, 'saveFacialSimulation'); assert.equal(saved.scope, 'physical-exam');
  assert.deepEqual(saved.state.photos.map(item => item.photo.id).sort(), [81, 82, 83]);
  assert.deepEqual(errors, []);
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)));
  console.log(JSON.stringify({ passed: true, groupedPhotos: 3, preselected: true, oneDialog: true, generatedMask: true,
    singleFrontalMask:true, nearBorderWarningSelectable:true, foreheadDragRecalculatesBand:true,
    singleAndBatchUpload:true, libraryBatch: 3, libraryWithoutReupload: true, failedDetectionKeeps2D: true, viewports: [1440, 390] }));
} finally { await browser.close(); }
