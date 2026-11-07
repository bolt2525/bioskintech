/** Biblioteca real + workspace real; imagen procedural y endpoints interceptados, nunca IA/DB/R2. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const origin=process.env.LAB_URL??'http://127.0.0.1:5187';
assert.match(origin,/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/);
const browser=await chromium.launch({channel:'chrome',headless:true});
const writes=[],errors=[],downloads=[];
let bytes,fail=true;
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.hostname==='photos.synthetic.invalid'){if(req.resourceType()!=='image')downloads.push(req.url());return route.fulfill({contentType:'image/png',body:bytes});}
    if(url.origin!==origin)return route.abort();
    if(url.pathname.endsWith('/FaceSimLab.tsx')){
      const response=await route.fetch(),code=await response.text();
      return route.fulfill({response,body:code
        .replace(/async function detectFrame\(img\) \{/, `async function detectFrame(img) { return {frame:null,reason:'Fixture sin rostro: revisión manual 2D'};`)
        .replace('onController?.(controller)','(window.editorController=controller,onController?.(controller))')});
    }
    if(url.pathname.startsWith('/api/')){
      const action=req.method()==='POST'?req.postDataJSON().action:url.searchParams.get('action');
      if(action==='listPhotos')return route.fulfill({json:{photos:[{id:81,r2_key:'clinics/synthetic/records/12/photos/81.png',r2_url:'https://photos.synthetic.invalid/81.png'}],hasMore:false}});
      assert.equal(action,'saveFacialSimulation','La biblioteca no se vuelve a subir');
      writes.push(req.postDataJSON());
      if(fail){fail=false;return route.fulfill({status:503,json:{error:'Fallo de guardado sintético'}});}
      return route.fulfill({json:{id:93}});
    }
    if(url.pathname!=='/__library_save_fixture__')return route.continue();
    const html=await(await route.fetch()).text();
    return route.fulfill({contentType:'text/html',body:html.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/,`<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Workspace from '/src/components/admin/ficha-clinica/components/SkinExamWorkspace.tsx';
      import '/src/index.css';
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=900;
      const ctx=canvas.getContext('2d'),image=ctx.createImageData(1200,900);let seed=42;
      for(let i=0;i<image.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        image.data[i]=seed&255;image.data[i+1]=(seed>>>8)&255;image.data[i+2]=(seed>>>16)&255;image.data[i+3]=255;}
      ctx.putImageData(image,0,0);window.syntheticImage=canvas.toDataURL('image/png').split(',')[1];
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Workspace,{recordId:12,context:{},
        aiAllowed:false,onPrepared:r=>window.prepared=r,onDirty:()=>{}}));
    </script>`)});
  });
  await page.goto(origin+'/__library_save_fixture__');
  await page.waitForFunction(()=>window.syntheticImage);
  bytes=Buffer.from(await page.evaluate(()=>window.syntheticImage),'base64');
  await page.getByRole('button',{name:'Fotos del expediente',exact:true}).click();
  const library=page.getByRole('region',{name:'Biblioteca de fotos del expediente'});
  await library.getByRole('checkbox',{name:'Seleccionar foto 81',exact:true}).check();
  await library.getByRole('button',{name:'Usar fotos seleccionadas (1)',exact:true}).click();
  await page.waitForFunction(()=>window.editorController?.getPhotos().length===1);
  await page.getByRole('button',{name:'Cerrar selección de fotos',exact:true}).click();
  const editor=page.getByRole('region',{name:'Editor de evaluación de piel'});
  await editor.getByLabel('Lesión a marcar',{exact:true}).fill('Eritema');
  await editor.getByRole('button',{name:/^Fotografías/}).click();
  await editor.getByRole('button',{name:'Añadir marca en el centro',exact:true}).click();
  await editor.getByRole('button',{name:'Confirmar',exact:true}).click();
  const before=await page.evaluate(()=>window.editorController.getMarks());
  const save=page.getByRole('button',{name:'Preparar para guardar',exact:true});
  const times=[];
  let start=performance.now();await save.click();
  await page.getByText('Fallo de guardado sintético',{exact:true}).waitFor();times.push(performance.now()-start);
  start=performance.now();await save.click();
  await page.waitForFunction(()=>window.prepared?.simulationId===93);times.push(performance.now()-start);
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1],'Reintento reutiliza exactamente solicitud idempotente');
  assert.deepEqual(writes[1].state.marks,before);
  assert.equal(writes[1].state.photos[0].photo.id,81);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({librarySave:{image:{width:1200,height:900,bytes:bytes.length},downloads:downloads.length,
    uploads:0,saveRequests:writes.length,payloadBytes:Buffer.byteLength(JSON.stringify(writes[0])),clickToFixtureResultMs:times}}));
}finally{await browser.close();}
