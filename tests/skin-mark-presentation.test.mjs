import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySkinFilter, evaluationRow, matchesSkinFilter, facialThird } from '../src/components/admin/ficha-clinica/components/skinMarkPresentation.ts';
import { skinSimulationId, toPersistedSkinReview, skinDisplayPoints, anchorForPhoto } from '../src/components/admin/ficha-clinica/components/skinEvaluation.ts';
import atlas from '../src/lab/faceSim/genericFaceAtlas.json' with {type:'json'};

test('filtros combinados, sin zona y vacío no cambian el modelo ni el payload íntegro',()=>{
  const marks=[{id:'a',sourceId:'frontal',label:'Eritema',category:'other',note:'Observación libre',
    box:{x:.45,y:.45,width:.04,height:.04},status:'validated',reviewedAt:'2026-01-01T00:00:00Z',source:{provider:'manual'}}];
  const original=structuredClone(marks);
  assert.equal(evaluationRow(marks[0]).zone,'','Una observación no se inventa como zona anatómica');
  assert.ok(matchesSkinFilter(evaluationRow(marks[0]),{zone:'Sin zona',lesion:'Eritema'}));
  assert.equal(marks.filter(mark=>matchesSkinFilter(evaluationRow(mark),{zone:'Frente',lesion:''})).length,0);
  assert.ok(matchesSkinFilter(evaluationRow(marks[0]),emptySkinFilter));
  assert.equal(toPersistedSkinReview(marks,{frontal:{id:81,r2Key:'clinics/synthetic/records/12/photos/81.png'}}).annotations.length,1);
  assert.deepEqual(marks,original);
});
test('sesión editable v2: solo identificadores válidos, también desde JSON',()=>{
  assert.equal(skinSimulationId({version:2,simulationId:93}),93);
  assert.equal(skinSimulationId('{"version":2,"simulationId":93}'),93);
  for(const data of [null,'malformed',{version:1,simulationId:93},{version:2,simulationId:-1},{version:2,simulationId:'93'}]) assert.equal(skinSimulationId(data),undefined);
});
test('cache de proyección conserva puntos sin cambios y se invalida por foto/superficie/marca',()=>{
  const surface={positions:Float32Array.from(atlas.positions),indices:Uint32Array.from(atlas.triangles),uvs:new Float32Array(936),projection:{cx:.5,cy:.5,k:.1,aspect:1}};
  const source={id:'frontal',confirmed:true,canvas:{width:600,height:700},mapping:{landmarks:Array.from({length:468},(_,i)=>({x:.5+atlas.positions[i*3]*.1,y:.5-atlas.positions[i*3+1]*.1})),direction:[0,0,1],manual:false}};
  const sources=[source],box={x:.45,y:.45,width:.1,height:.1};
  const mark={id:'a',sourceId:'frontal',box,anchor:anchorForPhoto(box,source,surface),label:'Eritema',status:'validated'};
  const first=skinDisplayPoints([mark],sources,surface);
  assert.equal(skinDisplayPoints([mark],sources,surface)[0],first[0]);
  assert.notEqual(skinDisplayPoints([{...mark,box:{...box,width:.12}}],sources,surface)[0],first[0]);
  assert.notEqual(skinDisplayPoints([mark],[source],surface)[0],first[0]);
  assert.notEqual(skinDisplayPoints([mark],sources,{...surface})[0],first[0]);
  assert.ok(evaluationRow({...mark,source:{provider:'manual'}}).third);
  assert.equal(facialThird({x:2,y:0}),'Zona Lateral');
});
