/** Una instancia Chrome; solo fotos dibujadas/atlas anatómico público del workspace, cero APIs. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { probeSkinSlider } from './helpers/skin-slider-probe.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5187';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], forbidden = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !['blob:', 'data:'].includes(url.protocol)) { forbidden.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/')) { forbidden.push(url.pathname); return route.abort(); }
    if (url.pathname.endsWith('/Clinical3DViewer.tsx')) {
      const response = await route.fetch(), code = await response.text();
      assert.match(code, /const callbacks = useRef\(\{/);
      return route.fulfill({ response, body: code.replace(/(const callbacks = useRef\(\{[\s\S]*?\n  \}\);)/, `$1
        window.skinEngines ??= [];
        if (!window.skinEngines.some(e => e.callbacks === callbacks)) window.skinEngines.push({callbacks, rendererRef, cameraRef, annotationLabelsGroupRef, editablePointsGroupRef, markersGroupRef});
        `) });
    }
    if (url.pathname !== '/__skin_undo_fixture__') return route.continue();
    const html = await (await route.fetch()).text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Editor from '/src/components/admin/ficha-clinica/components/SkinEvaluationEditor.tsx';
      import Viewer from '/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx';
      import {SkinMarkLegend} from '/src/components/admin/ficha-clinica/components/SkinMarkControls.tsx';
      import {anchorForPhoto, skinDisplayPoints} from '/src/components/admin/ficha-clinica/components/skinEvaluation.ts';
      import {migrateLegacySkinMarks} from '/src/components/admin/ficha-clinica/components/skinLegacyMigration.ts';
      import {modelPoint, genericFaceAtlas as atlas} from '/src/lab/faceSim/faceTransfer.ts';
      import '/src/index.css';
      const code = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
      const THREE = await import(code.match(/import \\* as THREE from "([^"]+)"/)[1]);
      const {GLTFExporter} = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
      const pending = new Set(), raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {let id=raf(time=>{pending.delete(id);callback(time)});pending.add(id);return id;};
      window.cancelAnimationFrame = id => {pending.delete(id);cancel(id)};
      window.pendingFrames = ()=>pending.size;
      window.released = 0;window.disposed = 0;
      const dispose=THREE.BufferGeometry.prototype.dispose;
      THREE.BufferGeometry.prototype.dispose=function(){window.disposed++;return dispose.apply(this,arguments)};
      const rendered=THREE.Mesh.prototype.onAfterRender;
      THREE.Mesh.prototype.onAfterRender=function(renderer){
        if(!renderer.__tracked){renderer.__tracked=true;const lose=renderer.forceContextLoss;renderer.forceContextLoss=()=>{window.released++;lose();};}
        return rendered?.apply(this,arguments);
      };
      const surface={positions:Float32Array.from(atlas.positions),indices:Uint32Array.from(atlas.triangles),
        uvs:new Float32Array(936),projection:{cx:.5,cy:.5,k:.1,aspect:1}};
      async function glb(positions,indices){
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(Float32Array.from(positions),3));
        geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices),1));geometry.computeVertexNormals();
        const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:'#b9a48c',side:THREE.DoubleSide}));
        mesh.name='PERSONAL_FACE_SURFACE';const scene=new THREE.Scene();scene.add(mesh);
        const result=await new GLTFExporter().parseAsync(scene,{binary:true});geometry.dispose();mesh.material.dispose();return result;
      }
      const mask=await glb(atlas.positions,atlas.triangles), reference=await glb(atlas.surface.positions,atlas.surface.triangles);
      const canvas=document.createElement('canvas');canvas.width=600;canvas.height=700;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#c6ac91';ctx.fillRect(0,0,600,700);
      ctx.fillStyle='#8b6f50';ctx.fillRect(240,300,120,60);
      const sources=[{id:'frontal',label:'Frontal sintética',group:'front',canvas,confirmed:true,
        mapping:{landmarks:Array.from({length:468},(_,i)=>({x:.5+atlas.positions[i*3]*.1,y:.5-atlas.positions[i*3+1]*.1})),direction:[0,0,1],manual:false}}];
      const box={x:.45,y:.45,width:.1,height:.1};
      const initial=[{id:'base',label:'Eritema',category:'other',note:'Zona sintética',sourceId:'frontal',box,
        anchor:anchorForPhoto(box,sources[0],surface),status:'validated',reviewedAt:'2026-01-01T00:00:00Z',
        observations:[{sourceId:'otra',box:{x:.2,y:.3,width:.1,height:.1}}],source:{provider:'manual'}}];
      const high=Array.from({length:atlas.surface.positions.length/3},(_,i)=>({x:atlas.surface.positions[i*3],
        y:atlas.surface.positions[i*3+1],z:atlas.surface.positions[i*3+2]}))
        .filter(p=>p.y>1.7&&Math.abs(p.x)<.3).sort((a,b)=>b.z-a.z)[0];
      const original={id:'frente-alta',category:'Eritema frontal',notes:'Original sintético',is3D:true,x:0,y:0,
        position3D:high,normal3D:{x:0,y:0,z:1}};
      const originals=JSON.stringify(original);
      function App(){
        const [marks,setMarks]=React.useState(initial), [show,setShow]=React.useState(true),[record,setRecord]=React.useState(42);
        const [review,setReview]=React.useState(false),[visibility,setVisibility]=React.useState({marks:true,names:true});
        const [hover,setHover]=React.useState(null);
        window.marks=marks;window.setRecord=setRecord;window.setShow=setShow;window.startReview=()=>setReview(true);
        window.setSyntheticMarks=setMarks;window.setMarkVisibility=setVisibility;
        window.initial=initial;window.originalIntact=()=>JSON.stringify(original)===originals;
        window.syntheticAnchor=box=>anchorForPhoto(box,sources[0],surface);
        const skipped=migrateLegacySkinMarks([original],42,sources,surface,[]).skipped;
        const referenceView=React.createElement('section',{'aria-label':'Referencia sintética',className:'overflow-hidden rounded-xl border border-slate-700 bg-slate-900 text-white'},
          React.createElement('div',{'data-skin-viewer-header':true,className:'grid h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2'},
            React.createElement('div',null,React.createElement('h3',{className:'text-sm font-semibold'},'Modelo anatómico de referencia'),
              React.createElement('p',{className:'text-xs text-slate-300'},'Las marcas originales se conservan'))),
          React.createElement(Viewer,{modelData:reference,markers:[{id:original.id,pathologyId:'lesion',type:'Puntual',color:'#22d3ee',position:original.position3D,normal:original.normal3D,
            rotation:{x:0,y:0,z:0},zone:'Frente',label:original.category,radius:.06}],
            highlightedPointIds:hover?[hover]:[],showMarkerLabels:visibility.names,height:'min(62dvh,560px)',occludeAnnotations:true,labInteraction:true,readOnly:true}),
          React.createElement(SkinMarkLegend));
        return show?React.createElement(Editor,{sources,surface,modelData:mask,value:marks,onChange:setMarks,recordId:record,context:{},
          presentation:'mask-first',referenceView:review?referenceView:undefined,referenceVisible:review,
          visibility,onVisibilityChange:setVisibility,hoveredMarkId:hover,onHoverMark:setHover,aiAllowed:false,
          migration:review?{ids:[],skipped:1,examId:42,unresolved:skipped}:undefined}):React.createElement('p',null,'Visores desmontados');
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html.replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  await page.goto(`${origin}/__skin_undo_fixture__`);
  if (process.env.SKIN_SLIDER_PROBE) {
    await probeSkinSlider(page, process.env.SKIN_QA_ARTIFACT_PREFIX);
    await browser.close();
    process.exit(0);
  }
  await page.getByRole('heading', { name: 'Máscara del paciente', exact: true }).waitFor();
  await page.waitForFunction(() => window.skinEngines?.some(e => e.rendererRef.current && e.annotationLabelsGroupRef.current?.children.length));
  assert.equal(await page.getByRole('button', { name: 'Deshacer', exact: true }).isEnabled(), false);
  const baseline = await page.evaluate(() => window.marks);
  await page.getByRole('button', { name: 'Ocultar nombres', exact: true }).click();
  await page.waitForFunction(() => window.skinEngines[0].annotationLabelsGroupRef.current?.children.length === 0);
  await page.getByRole('button', { name: 'Mostrar nombres', exact: true }).click();
  await page.getByRole('button', { name: 'Ocultar marcas', exact: true }).click();
  await page.waitForFunction(() => window.skinEngines[0].callbacks.current.showEditablePoints === false);
  await page.getByRole('button', { name: 'Mostrar marcas', exact: true }).click();
  // Drag real de una marca: proyectar coordenadas derivadas, no inventar puntos de clic.
  const start = await page.evaluate(() => {
    const e=window.skinEngines[0], group=e.editablePointsGroupRef.current.children[0];
    const camera=e.cameraRef.current, r=e.rendererRef.current.domElement.getBoundingClientRect();
    const p=group.position.clone().project(camera);
    return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down(); await page.mouse.move(start.x + 18, start.y + 8, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(before => JSON.stringify(window.marks) !== JSON.stringify(before), baseline);
  const moved = await page.evaluate(() => window.marks);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), baseline, 'Drag restaura anclaje/área/evidencia exactos');
  await page.getByRole('button', { name: 'Rehacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), moved);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).focus();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await page.evaluate(() => window.marks), baseline);
  await page.getByRole('button', { name: 'Rehacer', exact: true }).focus();
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await page.evaluate(() => window.marks), moved);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).focus();
  await page.keyboard.press('Meta+z');
  assert.deepEqual(await page.evaluate(() => window.marks), baseline);
  await page.evaluate(() => {const button=document.createElement('button');button.textContent='Fuera del editor';document.body.append(button);button.focus();});
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await page.evaluate(() => window.marks), baseline, 'Atajos no contaminan otros visores o controles');
  await page.getByRole('button',{name:'Fuera del editor',exact:true}).evaluate(button=>button.remove());
  await page.getByRole('button', { name: /^Fotografías/ }).click();
  const photo = page.getByRole('region', { name: 'Fotografía ampliable' });
  await photo.getByRole('button', { name: 'Seleccionar Eritema, validada', exact: true }).click();
  assert.equal(await page.getByRole('dialog', {name:'Revisar marca',exact:true}).count(),0,'Seleccionar no abre modal');
  await page.getByRole('button',{name:'Ver detalle',exact:true}).click();
  const dialog = page.getByRole('dialog', { name: 'Revisar marca', exact: true });
  await dialog.getByLabel('Lesión o descripción', { exact: true }).fill('Corrección sintética');
  const corrected = await page.evaluate(() => window.marks);
  assert.equal(await dialog.getByLabel('Lesión o descripción', {exact:true}).evaluate(input => {
    const event = new KeyboardEvent('keydown', {key:'z',ctrlKey:true,bubbles:true,cancelable:true});
    input.dispatchEvent(event);return event.defaultPrevented;
  }), false, 'No interceptar escritura ni diálogos');
  await dialog.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), baseline);
  await dialog.getByRole('button', { name: 'Rehacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), corrected);
  await dialog.getByRole('button', { name: 'Deshacer', exact: true }).click();
  await dialog.getByRole('button', { name: 'Reubicar marca', exact: true }).click();
  await photo.getByRole('button', { name: /^Añadir marca en la foto/ }).click({ position: { x: 220, y: 200 } });
  const photoMoved = await page.evaluate(() => window.marks);
  await photo.getByRole('button', { name: 'Deshacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), baseline, 'Mover en foto restaura observaciones y estado');
  await photo.getByRole('button', { name: 'Rehacer', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.marks), photoMoved);
  await photo.getByRole('button', { name: 'Deshacer', exact: true }).click();
  const label = photo.getByRole('button', { name: 'Seleccionar Eritema, validada', exact: true }).locator('span');
  assert.equal(await label.evaluate(el => getComputedStyle(el).fontSize), '11px');
  assert.ok(parseFloat(await label.evaluate(el => getComputedStyle(el).borderRadius)) >= 10);
  await photo.getByRole('button', {name:'Seleccionar Eritema, validada',exact:true}).click();
  await page.getByRole('button',{name:'Ver detalle',exact:true}).click();
  await dialog.getByRole('button', {name:'Eliminar marca',exact:true}).click();
  await photo.getByRole('status').filter({hasText:'eliminada'}).waitFor();
  assert.equal(await page.evaluate(() => window.marks.length),0);
  await photo.getByRole('button', {name:'Deshacer eliminación',exact:true}).click();
  assert.deepEqual(await page.evaluate(() => window.marks),baseline);
  await photo.getByRole('button', {name:'Rehacer',exact:true}).click();
  assert.equal(await page.evaluate(() => window.marks.length),0);
  await photo.getByRole('status').filter({hasText:'eliminada'}).waitFor();
  await page.waitForTimeout(4300);
  assert.equal(await photo.getByRole('button', {name:'Deshacer eliminación',exact:true}).count(),0);
  await photo.getByRole('button', {name:'Deshacer',exact:true}).click();
  await page.evaluate(() => window.startReview());
  const review = page.getByRole('dialog', { name: 'Compara y confirma las ubicaciones', exact: true });
  await review.waitFor();
  await page.waitForFunction(()=>window.skinEngines.filter(e=>e.rendererRef.current).length===2);
  const aligned = async () => {
    const canvases=review.locator('canvas').filter({visible:true});
    const a=await canvases.nth(0).boundingBox(),b=await canvases.nth(1).boundingBox();
    assert.ok(Math.abs(a.y-b.y)<=2&&Math.abs(a.height-b.height)<=2,JSON.stringify({a,b}));
    const headers=await review.locator('[data-skin-viewer-header]').evaluateAll(nodes=>nodes.map(node=>({y:node.getBoundingClientRect().y,height:node.getBoundingClientRect().height})));
    assert.equal(headers.length,2);assert.ok(Math.abs(headers[0].y-headers[1].y)<=2&&Math.abs(headers[0].height-headers[1].height)<=2);
    assert.equal(await review.locator('footer').getByRole('button',{name:/^(Deshacer|Rehacer)$/}).count(),0);
    assert.equal(await review.getByLabel('Barra compartida de visores',{exact:true}).getByRole('button',{name:'Deshacer',exact:true}).count(),1);
    return {canvasHeight:a.height,canvasYDifference:Math.abs(a.y-b.y),headerHeight:headers[0].height,headerYDifference:Math.abs(headers[0].y-headers[1].y)};
  };
  const alignment=await aligned();
  await review.getByRole('button', { name: 'Seleccionar original frente-alta', exact: true }).click();
  assert.equal(await page.evaluate(() => window.skinEngines.some(e => e.callbacks.current.highlightedPointIds.includes('frente-alta'))), true);
  await page.waitForFunction(() => window.skinEngines.some(e=>e.markersGroupRef.current?.children.some(group=>group.userData.markerId==='frente-alta'&&group.scale.x===1.4)));
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-desktop.png',fullPage:true});
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) {
    await review.locator('div.min-h-0.overflow-auto').first().evaluate(node=>node.scrollTop=0);
    await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-desktop-viewers.png',fullPage:true});
  }
  await review.getByRole('button', { name: 'Ubicar original en máscara', exact: true }).click();
  await review.getByText('Fotografías para revisar correspondencia', { exact: true }).click();
  await review.getByRole('button', { name: /^Añadir marca en la foto/ }).focus();
  await page.keyboard.press('Enter'); // centro observado, colocación manual por teclado
  await review.getByRole('button', { name: /Eritema frontal · frente-alta/ }).count(); // lista conserva identidad
  assert.equal(await page.evaluate(() => window.marks.length), 1, 'El borrador no altera aún el examen');
  await review.getByRole('button', { name: 'Deshacer', exact: true }).last().click();
  await review.getByRole('button', { name: 'Rehacer', exact: true }).last().click();
  await review.getByRole('button', { name: 'Eliminar marca de máscara', exact: true }).click();
  await review.getByRole('button', { name: 'Deshacer', exact: true }).last().click();
  await review.getByRole('button', { name: 'Rehacer', exact: true }).last().click();
  await review.getByRole('button', { name: 'Seleccionar original frente-alta', exact: true }).click();
  await review.getByRole('button', { name: 'Ubicar original en máscara', exact: true }).click();
  await review.getByRole('button', { name: /^Añadir marca en la foto/ }).focus();
  await page.keyboard.press('Enter');
  await review.getByRole('button', { name: 'Confirmar ubicaciones', exact: true }).click();
  await page.waitForFunction(() => window.marks.length === 2);
  assert.equal(await page.evaluate(() => window.marks[1].id), 'legacy-exam:42:frente-alta');
  assert.equal(await page.evaluate(() => window.originalIntact()), true);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).first().click();
  assert.deepEqual(await page.evaluate(() => window.marks), baseline, 'Confirmar traslado también se puede deshacer');
  await page.getByRole('button', { name: 'Rehacer', exact: true }).first().click();
  assert.equal(await page.evaluate(() => window.marks.length),2);
  await page.getByRole('button', { name: 'Deshacer', exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Revisar traslado',exact:true}).click();
  const mobileViews=review.getByRole('group',{name:'Vista de comparación móvil'});
  await mobileViews.getByRole('button',{name:'Referencia',exact:true}).click();
  await review.getByRole('button',{name:'Seleccionar original frente-alta',exact:true}).click();
  await review.getByRole('button',{name:'Ubicar original en máscara',exact:true}).click();
  await review.getByText('Fotografías para revisar correspondencia',{exact:true}).click();
  await review.getByRole('button',{name:/^Añadir marca en la foto/}).focus();await page.keyboard.press('Enter');
  await review.getByRole('button',{name:'Eliminar marca de máscara',exact:true}).click();
  await review.getByRole('button',{name:'Deshacer',exact:true}).last().click();
  await review.getByRole('button',{name:'Rehacer',exact:true}).last().click();
  assert.equal(await review.getByRole('button',{name:'Rehacer',exact:true}).last().evaluate(button=>{
    const event=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});button.dispatchEvent(event);return event.defaultPrevented;
  }),false,'No interceptar teclas de los diálogos');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-mobile-review.png',fullPage:true});
  await review.getByRole('button',{name:'Cancelar revisión',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.marks),baseline,'Cancelar revisión móvil conserva examen y original');
  await photo.getByRole('button', { name: 'Ocultar nombres', exact: true }).click();
  assert.equal(await photo.getByRole('button', { name: 'Seleccionar Eritema, validada', exact: true }).locator('span').count(), 0);
  await page.evaluate(()=>{
    window.setMarkVisibility({marks:false,names:false});
    window.setSyntheticMarks(Array.from({length:45},(_,i)=>({...window.initial[0],id:'synthetic-list-'+i,
      label:'Lesión sintética '+i+' '+('Descripción extensa sin espacios_').repeat(7)})));
  });
  const list=page.getByLabel('Marcas de la evaluación',{exact:true});
  await page.waitForFunction(()=>window.marks.length===45);
  await list.locator('[data-skin-card]').first().waitFor();
  assert.equal(await list.locator('[data-skin-card]').count(),45);
  assert.ok(await list.locator('div.overflow-auto').evaluate(node=>node.scrollHeight>node.clientHeight&&node.clientHeight<=289),'Lista acotada con scroll');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Texto largo no expande móvil');
  await list.locator('[data-skin-card]').first().getByRole('button').first().click();
  assert.ok((await dialog.getByLabel('Lesión o descripción',{exact:true}).inputValue()).length>200,'Detalle conserva nombre completo');
  await dialog.getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.evaluate(()=>{
    window.setMarkVisibility({marks:true,names:true});
    window.setSyntheticMarks([window.initial[0],{...window.initial[0],id:'pending-long',
      label:'Eritema inflamatorio superficial · descripción extensa sintética para revisión',status:'pending',reviewedAt:undefined,
      box:{x:.57,y:.42,width:.04,height:.04},anchor:window.syntheticAnchor({x:.57,y:.42,width:.04,height:.04})}]);
  });
  await page.waitForFunction(()=>window.marks.length===2);
  await photo.getByRole('button',{name:/Seleccionar Eritema inflamatorio.*pendiente/}).waitFor();
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-mobile-photo-pending.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Revisar traslado',exact:true}).click();
  await review.waitFor();
  await review.locator('div.min-h-0.overflow-auto').first().evaluate(node=>node.scrollTop=0);
  await aligned();
  if (process.env.SKIN_QA_ARTIFACT_PREFIX) await page.screenshot({path:process.env.SKIN_QA_ARTIFACT_PREFIX+'-desktop-aligned-pending.png',fullPage:true});
  await review.getByRole('button',{name:'Cancelar revisión',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.marks[1].status),'pending','Revisión/undo no validan pendientes por presentación');
  await page.evaluate(() => window.setRecord(99));
  assert.equal(await page.getByRole('button', { name: 'Deshacer', exact: true }).first().isEnabled(), false);
  assert.deepEqual(await page.evaluate(() => ({local:localStorage.length,session:sessionStorage.length})), {local:0,session:0});
  await page.evaluate(() => window.setShow(false));
  await page.getByText('Visores desmontados', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  const cleanup = await page.evaluate(() => ({frames:window.pendingFrames(),released:window.released,disposed:window.disposed,canvases:document.querySelectorAll('canvas').length}));
  assert.equal(cleanup.frames, 0); assert.equal(cleanup.canvases, 0); assert.ok(cleanup.released >= 2); assert.ok(cleanup.disposed > 0);
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({result:'PASS',desktop:'1440x1000',mobile:'390x844',alignment,undo:'drag/foto/corrección/traslado',cleanup,external:forbidden.length}));
} finally { await browser.close(); }
