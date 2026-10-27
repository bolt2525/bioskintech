/**
 * Regresión WebGL local: ejecutar desde /dev/hair-lab, pestaña Simular.
 * await (await import('/tests/face-sim-render.browser.mjs')).verifySimulationRender()
 * Usar exclusivamente el atlas genérico o capturas sintéticas.
 */
export async function verifySimulationRender() {
  if (location.pathname !== '/dev/hair-lab' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('QA restringida al laboratorio local.');
  const canvas = document.querySelector('canvas[aria-label^="Simulación facial 3D"]');
  if (!canvas) throw new Error('Abre Simular antes de ejecutar la regresión.');
  const root = canvas.closest('section'), saved = [], results = [];
  const wait = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const button = text => [...root.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  const check = text => [...root.querySelectorAll('label')].find(e => e.textContent.trim() === text)?.querySelector('input[type="checkbox"]');
  const expect = (condition, text) => { if (!condition) throw new Error(text); };
  const names = ['Piel', 'Grasa genérica', 'Músculos esquemáticos', 'Nervios · trayectos genéricos', 'Vasos · trayectos genéricos'];
  const mesh = check('Mostrar mallado de zonas');
  const plane = root.querySelector('select[aria-label="Plano visual de simulación"]');
  const initial = { mesh: mesh.checked, plane: plane.value, checks: names.map(name => check(name).checked) };
  let draws = [], capturePending = false;
  for (const Constructor of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const method of ['drawElements', 'drawArrays']) {
      const original = Constructor.prototype[method];
      saved.push(() => { Constructor.prototype[method] = original; });
      Constructor.prototype[method] = function (...args) {
        const result = original.apply(this, args);
        if (this.canvas === canvas) {
          const draw = { mode: args[0], visible: 0, width: this.drawingBufferWidth, height: this.drawingBufferHeight };
          draws.push(draw);
          if (!capturePending) {
            capturePending = true;
            queueMicrotask(() => {
              capturePending = false;
              const { width: w, height: h } = draw, pixels = new Uint8Array(w * h * 4);
              this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, pixels);
              let visible = 0;
              for (let i = 0; i < pixels.length; i += 4) {
                if (Math.abs(pixels[i] - 15) + Math.abs(pixels[i + 1] - 23) + Math.abs(pixels[i + 2] - 42) > 30) visible++;
              }
              for (const item of draws) item.visible = visible;
            });
          }
        }
        return result;
      };
    }
  }
  const setChecked = (input, value) => { if (input.checked !== value) input.click(); };
  const forceRender = async () => {
    button('Perfil lado A').click(); await wait();
    draws = []; button('Frontal').click(); await wait();
  };
  const verifyPixels = name => {
    const count = Math.max(0, ...draws.filter(draw => draw.mode === 4).map(draw => draw.visible));
    expect(count > 50, `${name}: superficie vacía (${count} píxeles).`);
    results.push({ name, pixels: count });
  };
  const setPlane = async value => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(plane, value); plane.dispatchEvent(new Event('change', { bubbles: true })); await wait();
  };
  try {
    button('Después').click(); setChecked(mesh, false); await wait();
    for (const name of names) {
      for (const candidate of names) setChecked(check(candidate), candidate === name);
      await wait(); await forceRender(); verifyPixels(name);
      expect(!draws.some(draw => draw.mode === 1), 'Ocultar mallado debe retirar todos los alambres.');
    }
    button('Morfología').click(); await wait();
    for (const comparison of ['Antes', 'Después', 'Comparar 3D']) {
      button(comparison).click(); await wait(); await forceRender(); verifyPixels(comparison);
    }
    button('Después').click(); await wait();
    for (const value of ['middle', 'deep', 'superficial']) {
      await setPlane(value);
      expect(check(value === 'middle' ? 'Grasa genérica' : value === 'deep' ? 'Músculos esquemáticos' : 'Piel').checked, 'El plano debe mostrar su capa.');
      if (value !== 'superficial') expect(!check('Piel').checked, 'La piel opaca no debe ocultar planos interiores.');
      await forceRender(); verifyPixels(`Plano ${value}`);
    }
    setChecked(mesh, true); await wait(); await forceRender();
    expect(draws.some(draw => draw.mode === 1 && draw.visible > 50), 'Mostrar mallado debe volver a dibujar aristas.');
    return results;
  } finally {
    saved.forEach(restore => restore());
    await setPlane(initial.plane);
    names.forEach((name, i) => setChecked(check(name), initial.checks[i]));
    setChecked(mesh, initial.mesh); button('Después').click();
  }
}

/** Crea tres capturas del atlas en memoria; no lee fotografías del disco. */
export async function prepareSyntheticHead({ withHair = false } = {}) {
  if (location.pathname !== '/dev/hair-lab' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('QA restringida al laboratorio local.');
  const button = text => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  const wait = () => new Promise(resolve => setTimeout(resolve, 50));
  const until = async predicate => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await wait(); }
    throw new Error('Tiempo agotado esperando el laboratorio.');
  };
  await until(() => button('Simulación facial'));
  button('Simulación facial').click(); await until(() => button('Capturas'));
  button('Capturas').click(); await wait();
  if (document.querySelector('input[aria-label^="Confirmar captura"]')) throw new Error('No reemplazar capturas existentes. Restablece el laboratorio antes del QA sintético.');
  const source = await (await fetch('/src/lab/faceSim/FacialSimulationViewer.tsx')).text();
  const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
  const atlas = await (await fetch('/src/lab/faceSim/genericFaceAtlas.json')).json();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(1400, 1400); renderer.setClearColor('#b8c2ca');
  const scene = new THREE.Scene(), geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(atlas.surface.positions, 3));
  geometry.setIndex(atlas.surface.triangles); geometry.computeVertexNormals();
  if (withHair) {
    const color = new THREE.Color(), skin = new THREE.Color('#c6a08b'), dark = new THREE.Color('#29211c'), colors = [];
    for (let i = 0; i < atlas.surface.positions.length; i += 3) {
      const [x, y, z] = atlas.surface.positions.slice(i, i + 3);
      const edge = 1.55 - 0.35 * Math.max(0, Math.min(1, (1.45 - z) / 1.5));
      color.copy(y > edge ? dark : skin);
      if (y > edge) color.multiplyScalar(0.9 + 0.18 * Math.sin(x * 95 + z * 30));
      colors.push(color.r, color.g, color.b);
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  const material = new THREE.MeshStandardMaterial({ color: withHair ? '#ffffff' : '#c6a08b', vertexColors: withHair, roughness: 0.85, side: THREE.DoubleSide });
  const head = new THREE.Mesh(geometry, material);
  scene.add(head, new THREE.HemisphereLight('#ffffff', '#71605b', 2.2));
  const light = new THREE.DirectionalLight('#ffffff', 2.3); light.position.set(-4, 6, 9); scene.add(light);
  const camera = new THREE.OrthographicCamera(-2.65, 2.65, 2.65, -2.65, 0.01, 100);
  camera.position.z = 10; camera.lookAt(0, 0, 0);
  try {
    for (const [label, angle] of [['Frontal', 0], ['Ángulo A', -0.65], ['Ángulo B', 0.65]]) {
      head.rotation.y = angle; renderer.render(scene, camera);
      const blob = await new Promise(resolve => renderer.domElement.toBlob(resolve));
      const data = new DataTransfer(); data.items.add(new File([blob], `atlas-sintetico-${angle}.png`, { type: 'image/png' }));
      const input = document.querySelector(`input[aria-label="Cargar ${label}"]`);
      input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => document.querySelector(`input[aria-label="Confirmar captura ${label}"]`));
      if (label === 'Frontal') {
        await until(() => document.querySelector('dialog[open]'));
        button('Conservar detección original').click(); await wait();
        document.querySelector('dialog input[type="checkbox"]').click(); await wait();
        button('Confirmar límites').click(); await until(() => !document.querySelector('dialog[open]'));
      }
      const confirm = document.querySelector(`input[aria-label="Confirmar captura ${label}"]`);
      if (!confirm.checked) confirm.click();
      await wait();
    }
    button('Cabeza estimada · 3+ fotos').click();
    await until(() => [...document.querySelectorAll('[role="status"]')].some(e => e.textContent === 'Vista activa: cabeza estimada'));
    button('Simular').click();
    await until(() => document.querySelector('canvas[aria-label^="Simulación facial 3D"]')?.dataset.renderedTriangles);
    return { syntheticCaptures: 3, triangles: Number(document.querySelector('canvas[aria-label^="Simulación facial 3D"]').dataset.renderedTriangles) };
  } finally {
    geometry.dispose(); material.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
}
