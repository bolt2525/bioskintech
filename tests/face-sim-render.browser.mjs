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
  const control = (prefix, selector) => [...root.querySelectorAll('label')]
    .find(label => label.textContent.trim().startsWith(prefix))?.querySelector(selector);
  const skin = check('Piel'), mesh = check('Mostrar mallado de zonas');
  const overlay = check('Superponer anatomía sobre piel opaca');
  const skinOpacity = root.querySelector('input[aria-label="Opacidad: Piel"]');
  const mode = control('Modo de corte', 'select');
  const progress = control('Avance desde punta nasal', 'input');
  const scope = control('Aplicar a', 'select');
  const inspect = control('Inspeccionar', 'select');
  const selection = control('Seleccionar zona ilustrativa', 'select');
  const references = ['Músculo', 'Vascular', 'Óseo'].map(name => ({
    name, visible: check(`Mostrar imagen ${name}`), opacity: control(`Opacidad imagen ${name}`, 'input'),
  }));
  expect(skin && mesh && overlay && skinOpacity && mode && progress && scope && inspect && selection
    && references.every(item => item.visible && item.opacity), 'Faltan controles del contrato actual del visor.');
  const pressed = selector => root.querySelector(`${selector} button[aria-pressed="true"]`)?.textContent.trim();
  const initial = {
    view: pressed('[aria-label="Orientación del modelo"]'),
    comparison: pressed('[aria-label="Comparación morfológica"]'),
    tool: pressed('[aria-label="Herramientas de simulación"]'),
    mode: mode.value, scope: scope.value, progress: progress.value,
    inspect: inspect.value, selection: selection.value,
    controls: [...root.querySelectorAll('[id$="-tool-layers"] input, [id$="-tool-cut"] input, [id$="-tool-cut"] select')]
      .filter(input => ![mode, progress, scope].includes(input))
      .map(input => ({ input, value: input.type === 'checkbox' ? input.checked : input.value })),
  };
  expect(initial.view && initial.comparison && initial.tool, 'No se pudo guardar orientación, comparación o herramienta.');
  let draws = [], capturePending = false;
  const setChecked = (input, value) => {
    if (input.checked === value) return;
    expect(!input.disabled, 'No se puede cambiar un checkbox deshabilitado.');
    input.click();
    expect(input.checked === value, 'El checkbox no reflejó el cambio.');
  };
  const setValue = async (input, value) => {
    if (input.value === String(value)) return;
    expect(!input.disabled, 'No se puede cambiar un control deshabilitado.');
    const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    await wait();
    expect(input.value === String(value), 'El control no reflejó el cambio.');
  };
  const forceRender = async () => {
    button('Perfil lado A').click(); await wait();
    draws = []; button('Frontal').click(); await wait();
    expect(!canvas.parentElement.parentElement.querySelector('[role="alert"]'), 'El visor informó un error WebGL.');
  };
  const verifyPixels = name => {
    const count = Math.max(0, ...draws.filter(draw => draw.mode === 4).map(draw => draw.visible));
    expect(count > 50, `${name}: superficie vacía (${count} píxeles).`);
    results.push({ name, pixels: count });
    return draws.at(-1)?.fingerprint;
  };
  try {
    for (const Constructor of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext].filter(Boolean)) {
      for (const method of ['drawElements', 'drawArrays']) {
        const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, method);
        const original = Constructor.prototype[method];
        saved.push(() => {
          if (descriptor) Object.defineProperty(Constructor.prototype, method, descriptor);
          else delete Constructor.prototype[method];
        });
        Constructor.prototype[method] = function (...args) {
          const result = original.apply(this, args);
          if (this.canvas === canvas) {
            const draw = { mode: args[0], visible: 0 };
            draws.push(draw);
            if (!capturePending) {
              capturePending = true;
              queueMicrotask(() => {
                capturePending = false;
                const frameDraws = draws.slice();
                const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
                this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels);
                let visible = 0, fingerprint = 2166136261;
                for (let i = 0; i < pixels.length; i += 4) {
                  if (Math.abs(pixels[i] - 15) + Math.abs(pixels[i + 1] - 23) + Math.abs(pixels[i + 2] - 42) > 30) visible++;
                  fingerprint = Math.imul(fingerprint ^ pixels[i], 16777619);
                  fingerprint = Math.imul(fingerprint ^ pixels[i + 1], 16777619);
                  fingerprint = Math.imul(fingerprint ^ pixels[i + 2], 16777619);
                }
                for (const item of frameDraws) Object.assign(item, { visible, fingerprint });
              });
            }
          }
          return result;
        };
      }
    }
    button('Capas').click(); await wait();
    button('Después').click(); await wait();
    await setValue(mode, 'none'); await setValue(scope, 'none');
    await setValue(inspect, 'skin'); await setValue(selection, '');
    setChecked(overlay, false);
    for (const reference of references) if (!reference.visible.disabled) setChecked(reference.visible, false);
    setChecked(skin, true); await setValue(skinOpacity, '1');
    setChecked(mesh, false); await wait();
    await forceRender(); const surface = verifyPixels('Piel sin mallado');
    expect(!draws.some(draw => [1, 2, 3].includes(draw.mode)), 'Ocultar mallado debe retirar todos los alambres.');
    setChecked(skin, false); await wait(); await forceRender();
    expect(draws.at(-1)?.fingerprint !== surface, 'Ocultar piel no cambia los píxeles.');
    setChecked(skin, true); await wait();
    setChecked(mesh, true); await wait(); await forceRender();
    verifyPixels('Piel con mallado');
    expect(draws.some(draw => [1, 2, 3].includes(draw.mode) && draw.visible > 50), 'Mostrar mallado debe volver a dibujar aristas.');
    setChecked(mesh, false); await wait();
    button('Morfología').click(); await wait();
    for (const comparison of ['Antes', 'Después', 'Comparar 3D']) {
      button(comparison).click(); await wait(); await forceRender(); verifyPixels(comparison);
    }
    button('Después').click(); await wait();
    button('Capas').click(); await wait();
    for (const reference of references) {
      if (reference.visible.disabled) {
        results.push({ name: `Imagen ${reference.name}`, skipped: 'Referencia no cargada; no se valida su renderizado.' });
        continue;
      }
      setChecked(skin, false); setChecked(reference.visible, true);
      await setValue(reference.opacity, '0'); await wait(); await forceRender();
      const hidden = draws.at(-1)?.fingerprint;
      await setValue(reference.opacity, '1'); await forceRender();
      const opaque = verifyPixels(`Imagen ${reference.name} sin piel`);
      expect(hidden !== opaque, `${reference.name}: la opacidad no cambia los píxeles.`);
      await setValue(reference.opacity, '0.5'); await forceRender();
      expect(verifyPixels(`Imagen ${reference.name} al 50 %`) !== opaque, `${reference.name}: la opacidad intermedia no se renderiza.`);
      await setValue(reference.opacity, '1'); setChecked(skin, true); await wait(); await forceRender();
      const covered = verifyPixels(`Imagen ${reference.name} bajo piel opaca`);
      setChecked(overlay, true); await wait(); await forceRender();
      expect(verifyPixels(`Overlay ${reference.name}`) !== covered, `${reference.name}: superponer no cambia los píxeles.`);
      setChecked(overlay, false); setChecked(reference.visible, false); await wait();
    }
    button('Corte').click(); await wait();
    if (!mode.disabled) {
      for (const value of ['progressive', 'compare']) {
        await setValue(mode, value);
        const frames = new Set();
        for (const fraction of ['0', '0.3', '0.7', '1']) {
          await setValue(progress, fraction); await forceRender();
          frames.add(verifyPixels(`Corte ${value} · ${fraction}`));
        }
        expect(frames.size > 1, `Corte ${value}: avanzar no cambia los píxeles.`);
      }
    } else {
      results.push({ name: 'Corte desde punta nasal', skipped: 'Requiere imágenes muscular y ósea cargadas.' });
    }
    return results;
  } finally {
    // Restaurar primero los prototipos, incluso si falla después la restauración de React.
    saved.reverse().forEach(restore => restore());
    await setValue(mode, initial.mode);
    await setValue(scope, initial.scope);
    await setValue(progress, initial.progress);
    await setValue(inspect, initial.inspect);
    await setValue(selection, initial.selection);
    for (const { input, value } of initial.controls) {
      if (!input.isConnected) continue; // Selects condicionales de «Comparar dos capas».
      if (input.type === 'checkbox') { setChecked(input, value); await wait(); }
      else await setValue(input, value);
    }
    button(initial.comparison).click();
    button(initial.view).click();
    button(initial.tool).click();
    await wait();
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
