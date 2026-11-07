import assert from 'node:assert/strict';

/** Medir frames reales de WebGL, no solo el valor DOM del range. Fixture sin fotos clínicas. */
export async function probeSkinSlider(page, prefix) {
  await page.waitForFunction(() => window.skinEngines?.some(e => e.rendererRef.current && e.editablePointsGroupRef.current?.children.length));
  await page.evaluate(() => {
    const base = window.marks[0];
    window.setSyntheticMarks(Array.from({length: 12}, (_, i) => ({...base, id: i ? `synthetic-${i}` : base.id})));
  });
  await page.getByLabel('Marcas de la evaluación', {exact:true}).getByRole('button', {name:/^Eritema/}).first().click();
  if (await page.locator('[data-skin-card]').count()) {
    await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  }
  const slider = page.getByRole('slider', {name:'Tamaño de la marca',exact:true});
  await slider.waitFor();
  // Zonal fixture: radios distintos, misma superficie y fidelidad.
  await slider.evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'.12');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  const measurements = [];
  for (const size of [.11, .12, .13, .14, .15]) {
    measurements.push(await slider.evaluate(async (input, size) => {
      const engine = window.skinEngines.find(e => e.rendererRef.current);
      const renderer = engine.rendererRef.current, group = engine.editablePointsGroupRef.current;
      const beforeGroup = group.children.find(g => g.userData.editableId === 'base');
      const before = beforeGroup.children.find(c => c.geometry?.type === 'RingGeometry')?.geometry.parameters.outerRadius;
      const disposed = window.disposed;
      const started = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(size));
      input.dispatchEvent(new Event('input', {bubbles:true}));
      return await new Promise((resolve, reject) => {
        const old = renderer.render;
        const timeout = setTimeout(() => { renderer.render = old; reject(Error('Sin cambio WebGL real: '+JSON.stringify({before,marks:window.marks[0],children:group.children.map(g=>({id:g.userData.editableId,types:g.children.map(c=>c.geometry?.type)}))}))); }, 15000);
        renderer.render = function(...args) {
          const current = group.children.find(g => g.userData.editableId === 'base');
          const after = current?.children.find(c => c.geometry?.type === 'RingGeometry')?.geometry.parameters.outerRadius;
          old.apply(this, args);
          if (after !== before) {
            // readPixels sincroniza la GPU: frame con la nueva geometría, no solo React/DOM.
            const gl = renderer.getContext(), pixel = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            clearTimeout(timeout); renderer.render = old;
            resolve({size, inputToWebGLMs: performance.now()-started, geometriesDisposed:window.disposed-disposed});
          }
        };
      });
    }, size));
  }
  assert.equal(await page.evaluate(() => window.marks[0].box.width), .15);
  if (prefix) await page.screenshot({path: `${prefix}-slider.png`,fullPage:true});
  console.log(JSON.stringify({fixture:'12 marcas zonales, atlas sintético, SwiftShader',slider:measurements}));
}
