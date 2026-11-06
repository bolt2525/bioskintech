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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Foto', exact: true }).click();
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.getByRole('button', { name: 'Foto', exact: true }).click();
  assert.equal(await page.evaluate(() => window.controller.getMarks()[0].id), 'manual-fixture');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(external.every(url => /^https:\/\/(?:fonts\.googleapis\.com\/css2|odml\.pa\.googleapis\.com\/v1\/log)/.test(url)),
    `Salida externa inesperada, bloqueada: ${external.join(', ')}`);
  assert.deepEqual(writes, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], blockedExternalRequests: external.length, ...roundtrip.metrics }));
} finally { await browser.close(); }
