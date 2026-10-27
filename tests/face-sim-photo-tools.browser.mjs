/** Integración WebGL sobre capturas sintéticas, nunca fotografías de pacientes. */
export async function verifyPhotoTools() {
  if (location.pathname !== '/dev/hair-lab' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('QA restringida al laboratorio local.');
  const canvas = document.querySelector('canvas[aria-label^="Simulación facial 3D"]'), root = canvas?.closest('section');
  if (!root) throw new Error('Abre Simular con una captura sintética.');
  const details = root.querySelectorAll('details'), input = root.querySelector('input[type="file"]');
  if (!input || input.files.length) throw new Error('No reemplazar una referencia cargada.');
  const button = text => [...root.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const until = async predicate => {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await wait(); }
    throw new Error('Tiempo agotado validando herramientas fotográficas.');
  };
  const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
  const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
  const original = THREE.Mesh.prototype.onAfterRender, rendered = {};
  THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera, geometry, material) {
    if (renderer.domElement === canvas) {
      if (this.name === 'ALIGNED_ANATOMICAL_REFERENCE') {
        const gl = renderer.getContext(), pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let visible = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.abs(pixels[i] - 15) + Math.abs(pixels[i + 1] - 23) + Math.abs(pixels[i + 2] - 42) > 30) visible++;
        }
        rendered.reference = { pixels: visible, positions: Array.from(geometry.getAttribute('position').array), indices: geometry.index.count };
      }
      if (this.renderOrder === 5 && material.map) rendered.skinImage = material.map.image;
    }
    return original?.apply(this, arguments);
  };
  try {
    details[0].open = details[1].open = true;
    const fixture = document.createElement('canvas'); fixture.width = fixture.height = 512;
    const context = fixture.getContext('2d'); context.fillStyle = '#edb5a8'; context.fillRect(0, 0, 512, 512);
    context.strokeStyle = '#b42345'; context.lineWidth = 8;
    for (let i = 0; i < 20; i++) { context.beginPath(); context.moveTo(i * 25, 0); context.lineTo(i * 25 + 100, 512); context.stroke(); }
    const blob = await new Promise(resolve => fixture.toBlob(resolve)), data = new DataTransfer();
    data.items.add(new File([blob], 'referencia-sintetica.png', { type: 'image/png' }));
    input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => root.querySelector('button[aria-label^="Colocar"]'));
    for (const [x, y] of [[0.28, 0.35], [0.72, 0.35], [0.5, 0.85]]) {
      const target = root.querySelector('button[aria-label^="Colocar"]'), rect = target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + rect.width * x,
        clientY: rect.top + rect.height * y, pointerId: 1, button: 0 }));
      await wait();
    }
    button('Frontal').click(); await until(() => rendered.reference?.pixels > 50);
    const before = rendered.reference.positions;
    const slider = root.querySelector('input[id$="-noseTip"]'), initial = slider.value;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.8');
    slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => rendered.reference.positions.some((value, i) => Math.abs(value - before[i]) > 1e-5));
    const maximumChange = Math.max(...rendered.reference.positions.map((value, i) => Math.abs(value - before[i])));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, initial);
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    const select = details[0].querySelector('select'), skinBefore = rendered.skinImage;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'redness');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => rendered.skinImage && rendered.skinImage !== skinBefore);
    if (root.querySelector('[role="alert"]')) throw new Error('Error visible en filtros o capa.');
    return { referencePixels: rendered.reference.pixels, referenceTriangles: rendered.reference.indices / 3,
      referenceDeformation: maximumChange, rgbTextureReplaced: true };
  } finally {
    THREE.Mesh.prototype.onAfterRender = original;
    button('Limpiar referencia')?.click();
  }
}
