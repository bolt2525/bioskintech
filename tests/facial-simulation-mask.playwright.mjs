/** Synthetic local fixture; no patient, provider, database or R2 access. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const external = [], errors = [], writes = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(request.url());
      if (url.searchParams.get('action') === 'skinVisualStatus') return route.fulfill({ json: {
        enabled: false, reason: 'Deshabilitada para QA', model: 'gemini-3.5-flash-lite',
        usedUsd: 0, remainingUsd: 5, limitUsd: 5,
      } });
      return route.fulfill({ status: 403, json: { error: 'API real bloqueada por QA.' } });
    }
    if (url.pathname !== '/__facial_mask_fixture__') return route.continue();
    const response = await route.fetch(), html = await response.text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import FaceSimLab from '/src/lab/faceSim/FaceSimLab.tsx';
      import atlas from '/src/lab/faceSim/genericFaceAtlas.json';
      import {personalSurfaceToGlb} from '/src/lab/faceSim/personalSurfaceGlb.ts';
      import {bufferToBase64,storeSurface} from '/src/lab/faceSim/facialSimulationSession.ts';
      import {modelPoint} from '/src/lab/faceSim/faceTransfer.ts';
      import {migrateLegacySkinMarks} from '/src/components/admin/ficha-clinica/components/skinLegacyMigration.ts';
      import {anchorForPhoto,photoForAnchor} from '/src/components/admin/ficha-clinica/components/skinEvaluation.ts';
      import '/src/index.css';
      const onController = value => { window.controller = value; };
      const onDirty = () => { window.dirtyCount = (window.dirtyCount ?? 0) + 1; };
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(FaceSimLab,{integration:{mode:'skin-exam',recordId:12,onController,onDirty}}));
      window.makeFixture = async () => {
        const canvas = document.createElement('canvas');canvas.width=768;canvas.height=1024;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#bd967b';ctx.fillRect(0,0,768,1024);
        ctx.fillStyle='#803f39';ctx.beginPath();ctx.arc(245,490,12,0,Math.PI*2);ctx.fill();
        const positions=Float32Array.from(atlas.positions);
        const landmarks=Array.from({length:468},(_,i)=>({x:.5+positions[i*3]*.16,y:.5-positions[i*3+1]*.16,z:0}));
        const surface={positions,indices:Uint32Array.from(atlas.triangles),
          uvs:Float32Array.from(landmarks.flatMap(p=>[p.x,p.y])),projection:{cx:.5,cy:.5,k:.16,aspect:.75}};
        const source={id:'frontal',label:'Frontal',group:'front',confirmed:true,canvas,
          mapping:{landmarks,direction:[0,0,1],manual:false}};
        let legacy;
        for(let triangle=0;triangle<atlas.triangles.length/3;triangle++){
          const position3D=modelPoint({triangle,weights:[.2,.3,.5]});
          if(!position3D)continue;
          const candidate={id:'historical',is3D:true,position3D,x:0,y:0,category:'Marca histórica sintética'};
          if(migrateLegacySkinMarks([candidate],42,[source],surface,[]).added){legacy=candidate;break;}
        }
        if(!legacy)throw Error('Fixture sin anclaje migrable');
        root.render(React.createElement(FaceSimLab,{integration:{mode:'skin-exam',recordId:12,onController,onDirty,
          legacyMigration:{examId:42,marks:[legacy]}}}));
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const start=performance.now(),glb=await personalSurfaceToGlb(surface,canvas),exportMs=performance.now()-start;
        const photo={id:81,r2Key:'clinics/synthetic/records/12/photos/fixture.png'};
        const state={version:1,atlas:{modelId:atlas.modelId,version:1,glbSha256:atlas.provenance.glbSha256},
          photos:[{slot:'frontal',photo,alignment:{frame:{top:.05,bottom:.95,left:.1,right:.9,
            axisTop:{x:.5,y:.05},axisBottom:{x:.5,y:.95},source:'manual'},landmarks,captureConfirmed:true}}],
          mask:{view:'frontal',surface:storeSurface(surface),renderSurface:storeSurface(surface),
            glbBase64:bufferToBase64(glb),depth:1,depthDetails:'Fixture sintético, no captura clínica.',diagnostics:[],closedHead:false},
          marks:[{id:'manual-fixture',sourceId:'frontal',category:'spot',label:'Área sintética',note:'',
            box:{x:.3,y:.45,width:.05,height:.05},status:'validated',reviewedAt:'2026-11-05T00:00:00.000Z',source:{provider:'manual'}}]};
        window.fixture={state,canvas,refs:{frontal:photo}};
        window.findPhotoSpot=()=>{
          for(let y=.25;y<.8;y+=.025)for(let x=.25;x<.8;x+=.025){
            const box={x:x-.02,y:y-.02,width:.04,height:.04};
            const anchor=anchorForPhoto(box,source,surface);
            if(anchor&&photoForAnchor(anchor,source,surface)&&window.controller.getMarks().every(mark=>
              Math.hypot(mark.box.x+mark.box.width/2-x,mark.box.y+mark.box.height/2-y)>.06))return {x,y};
          }
          throw Error('Sin punto fotográfico observado libre');
        };
        const restoreStart=performance.now();await window.controller.restore(state,{frontal:canvas});
        window.metrics={glbBytes:glb.byteLength,jsonBytes:new Blob([JSON.stringify(state)]).size,
          exportMs,restoreStateMs:performance.now()-restoreStart};
      };
    </script>`;
    return route.fulfill({ contentType: 'text/html',
      body: html.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__facial_mask_fixture__`);
  await page.waitForFunction(() => window.controller && window.makeFixture, null, { timeout: 120000 });
  await page.evaluate(() => window.makeFixture());
  await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(input => input.value === 'Área sintética'),
    null, { timeout: 120000 });
  await page.waitForFunction(() => window.controller.getMarks().length === 2);
  await page.getByText('1 marcaciones trasladadas en el último intento. 0 sin correspondencia.').waitFor();
  await page.getByRole('button', { name: 'Validar región', exact: true }).and(page.locator(':enabled')).click();
  await page.getByText('Revisar traslado', { exact: true }).click();
  await page.getByRole('button', { name: 'Reintentar traslado sin duplicar', exact: true }).click();
  assert.equal(await page.evaluate(() => window.controller.getMarks().length), 2);
  const roundtrip = await page.evaluate(async () => {
    const { state, canvas, refs } = window.fixture;
    const before = window.controller.getMarks();
    const saved = await window.controller.snapshot(refs);
    await window.controller.restore(JSON.parse(JSON.stringify(saved)), { frontal: canvas });
    return { marksBefore: before, marksAfter: saved.marks, geometryEqual: JSON.stringify(saved.mask.surface) === JSON.stringify(state.mask.surface),
      glbEqual: saved.mask.glbBase64 === state.mask.glbBase64, metrics: { ...window.metrics,
        savedStateBytes: new Blob([JSON.stringify(saved)]).size } };
  });
  assert.deepEqual(roundtrip.marksAfter, roundtrip.marksBefore);
  assert.equal(roundtrip.geometryEqual, true); assert.equal(roundtrip.glbEqual, true);
  assert.equal(await page.getByRole('button', { name: 'Buscar asistido', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Morfología', exact: true }).count(), 0);
  const mask = page.getByRole('region', { name: 'Editor de evaluación de piel' });
  const photoViewport = page.getByRole('region', { name: 'Fotografía ampliable' });
  assert.ok((await mask.getByRole('heading', { name: 'Máscara del paciente', exact: true }).boundingBox()).y <
    (await photoViewport.boundingBox()).y, 'La máscara precede a las fotografías');
  await mask.getByRole('button', { name: 'Mostrar zonas', exact: true }).click();
  assert.ok(await photoViewport.locator('svg polygon').count() > 0, 'Las zonas visibles se proyectan en la foto confirmada');
  await photoViewport.getByRole('button', { name: 'Ocultar zonas en foto', exact: true }).click();
  assert.equal(await photoViewport.locator('svg polygon').count(), 0);
  assert.equal(await photoViewport.getByRole('button', { name: 'Alejar foto', exact: true }).isDisabled(), true);
  for (let i=0;i<6;i++) await photoViewport.getByRole('button', { name: 'Acercar foto', exact: true }).click();
  assert.equal(await photoViewport.getByRole('button', { name: 'Acercar foto', exact: true }).isDisabled(), true);
  assert.match(await photoViewport.getByLabel('Zoom de foto', { exact: true }).innerText(), /400/);
  await photoViewport.getByRole('button', { name: 'Restablecer foto', exact: true }).click();
  await photoViewport.getByRole('button', { name: 'Acercar foto', exact: true }).click();
  const spot = await page.evaluate(() => window.findPhotoSpot());
  const target = photoViewport.getByRole('button', { name: /^Añadir marca en la foto/ });
  await target.evaluate((button, point) => {
    const scroll=button.parentElement.parentElement;
    scroll.scrollLeft=point.x*button.offsetWidth-scroll.clientWidth/2;
    scroll.scrollTop=point.y*button.offsetHeight-scroll.clientHeight/2;
    scroll.scrollIntoView({block:'center'});
  }, spot);
  const rect = await target.boundingBox();
  await page.mouse.click(rect.x+rect.width*spot.x,rect.y+rect.height*spot.y);
  await page.waitForFunction(() => window.controller.getMarks().length===3);
  const placed = await page.evaluate(() => window.controller.getMarks().at(-1));
  assert.ok(placed.anchor, 'La marca fotográfica se refleja como un único anclaje en la máscara');
  assert.ok(Math.abs(placed.box.x+placed.box.width/2-spot.x)<.001);
  assert.ok(Math.abs(placed.box.y+placed.box.height/2-spot.y)<.001, 'El zoom conserva la posición original');
  assert.ok(placed.note, 'Se detecta la zona sin volver a elegirla');
  await photoViewport.getByRole('button', { name: 'Desplazar foto', exact: true }).click();
  const viewportBounds = await photoViewport.locator('canvas').evaluate(canvas => {
    const scroll=canvas.parentElement.parentElement;
    scroll.scrollLeft=Number.MAX_SAFE_INTEGER;scroll.scrollTop=Number.MAX_SAFE_INTEGER;
    return {left:scroll.scrollLeft,top:scroll.scrollTop,maxLeft:scroll.scrollWidth-scroll.clientWidth,maxTop:scroll.scrollHeight-scroll.clientHeight};
  });
  assert.ok(viewportBounds.left<=viewportBounds.maxLeft&&viewportBounds.top<=viewportBounds.maxTop);
  assert.equal(await target.isDisabled(), true, 'La mano no añade marcas');
  await photoViewport.getByRole('button', { name: 'Desplazar foto', exact: true }).click();
  await photoViewport.getByRole('button', { name: 'Restablecer foto', exact: true }).click();
  const maskCanvas = mask.locator('canvas').first();
  await maskCanvas.scrollIntoViewIfNeeded();
  const maskBounds = await maskCanvas.boundingBox();
  await maskCanvas.click({position:{x:maskBounds.width*.55,y:maskBounds.height*.55}});
  await page.waitForFunction(() => window.controller.getMarks().length===4, null, {timeout:10000});
  const maskMark = await page.evaluate(() => window.controller.getMarks().at(-1));
  assert.ok(maskMark.anchor, 'El raycast real de la máscara conserva el anclaje anatómico');
  assert.equal(await photoViewport.getByRole('button', {name:'Seleccionar Lesión, pendiente',exact:true}).count(),2,
    'Ambas marcas, de foto y de máscara, se muestran en la fotografía sin duplicar identidades');
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({path:process.env.QA_SCREENSHOT_DIR+'\\mascara-desktop.png',fullPage:true});
  await page.setViewportSize({ width: 390, height: 844 });
  const photos = page.getByRole('button', { name: /Fotografías de referencia/ });
  await photos.click();
  assert.equal(await photos.getAttribute('aria-expanded'), 'false');
  await photos.click();
  assert.equal(await photos.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => window.controller.getMarks().length), 4);
  assert.equal(await page.evaluate(() => window.controller.getMarks()[0].id), 'manual-fixture');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({path:process.env.QA_SCREENSHOT_DIR+'\\mascara-mobile.png',fullPage:true});
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)),
    `Salida externa inesperada, bloqueada: ${external.join(', ')}`);
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], blockedExternalRequests: external.length, ...roundtrip.metrics }));
} finally { await browser.close(); }
