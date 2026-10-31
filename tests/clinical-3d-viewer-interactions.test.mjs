import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx', import.meta.url), 'utf8');
const instrumented = source.replace('// 1. Initialize scene once', `
  globalThis.engineRefs = { faceMeshRef, cameraRef, controlsRef, editablePointsGroupRef, handlesGroupRef,
    freehandGroupRef, brushPreviewGroupRef, annotationLabelsGroupRef, cancelInteractionRef, callbacks, clipPlane, referenceVisuals, rendererRef };
  // 1. Initialize scene once
`) + '\nexports.helpers = { screenAnnotationSnap, projectNearbySurface, projectedShapeSegments, projectedShapeOutline, annotationSurfaceHit, shouldCancelAnnotation, ThreeEngine };';
const code = ts.transpileModule(instrumented, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

class EventSurface {
  listeners = new Map();
  style = {};
  clientWidth = 800;
  clientHeight = 600;
  addEventListener(type, handler) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(handler);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, data = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({
      clientX: 400, clientY: 300, button: 0, buttons: 1, pointerId: 1, target: this, ...data,
    });
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  appendChild() {}
  removeChild() {}
}

function camera(orthographic = true) {
  const result = orthographic ? new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100) : new THREE.PerspectiveCamera(35, 4 / 3, 0.1, 100);
  result.position.z = 12;
  result.updateMatrixWorld();
  return result;
}

function plane(width = 8, x = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 6), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(x, 0, z);
  mesh.updateMatrixWorld();
  return mesh;
}

function load() {
  let effects = [];
  const refs = [];
  let cursor = 0;
  const dom = new EventSurface(), window = new EventSurface(), mount = new EventSurface();
  const animationFrames = new Map();
  let frameId = 0;
  const hooks = {
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect, deps) => effects.push({ effect, deps }),
    useRef(initial) {
      const index = cursor++;
      refs[index] ??= { current: index === 0 ? mount : initial };
      return refs[index];
    },
  };
  class Renderer {
    domElement = dom;
    shadowMap = {};
    renderLists = { dispose() {} };
    contextsReleased = 0;
    setSize() {}
    setPixelRatio() {}
    render(scene, cam) { scene.updateMatrixWorld(); cam.updateMatrixWorld(); }
    dispose() {}
    forceContextLoss() { this.contextsReleased++; }
  }
  class Controls {
    target = new THREE.Vector3();
    enabled = true;
    update() {}
    dispose() {}
  }
  class Element {
    constructor(selector = '') { this.selector = selector; }
    closest() { return this.selector ? this : null; }
    getClientRects() { return [1]; }
  }
  const document = {
    activeElement: null,
    dialogs: [],
    querySelectorAll() { return this.dialogs; },
    createElement() {
      return { width: 0, height: 0, getContext: () => ({ measureText: text => ({ width: text.length * 15 }), fillRect() {}, fillText() {} }) };
    },
  };
  const sandbox = {
    exports: {}, console, window, document, Element, performance,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { animationFrames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => animationFrames.delete(id),
    require: name => {
      if (name === 'react') return { ...require('react'), ...hooks };
      if (name === 'three') return { ...THREE, WebGLRenderer: Renderer };
      if (name.includes('OrbitControls')) return { OrbitControls: Controls };
      if (name.includes('GLTFLoader')) return { GLTFLoader: class {} };
      if (name === './clinicalCamera') return {
        worldUnitsPerPixel: (cam, point, height) => cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / height
          : 2 * cam.position.distanceTo(point) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / cam.zoom / height,
      };
      if (name === './scalpGroom') return {};
      if (name.endsWith('/theme')) return { COLORS: { annotation: '#00ffff' } };
      return require(name);
    },
  };
  // Solo instrumentación del test: helpers privados y refs, sin ampliar la API de producción.
  vm.runInNewContext(code, sandbox);
  let props;
  const render = changes => {
    props = { modelSource: { type: 'url', data: 'test.glb' }, markers: [], zones: [], onMeshClick() {}, onLoaded() {}, onError() {},
      readOnly: false, cameraPreset: 'face-surface', ...props, ...changes };
    effects = [];
    cursor = 0;
    sandbox.exports.helpers.ThreeEngine(props);
    return effects;
  };
  return { ...sandbox.exports.helpers, dom, window, document, Element, sandbox, render,
    get effects() { return effects; }, get refs() { return sandbox.engineRefs; } };
}

function engine(changes = {}) {
  const app = load();
  app.render(changes);
  const init = app.effects.find(({ effect }) => effect.toString().includes('new THREE.Scene()'));
  app.cleanup = init.effect();
  app.refs.faceMeshRef.current = plane();
  app.refs.cameraRef.current.left = -4;
  app.refs.cameraRef.current.right = 4;
  app.refs.cameraRef.current.updateProjectionMatrix();
  app.refs.cameraRef.current.updateMatrixWorld();
  return app;
}

test('desmontar libera el contexto WebGL y retira la referencia al renderer', () => {
  const app = engine(), renderer = app.refs.rendererRef.current;
  assert.equal(renderer.contextsReleased, 0);
  app.cleanup();
  assert.equal(renderer.contextsReleased, 1);
  assert.equal(app.refs.rendererRef.current, null);
});

test('imán de 12 CSS px constante con zoom, ortográfica/perspectiva y extremos antes que segmentos', () => {
  const { screenAnnotationSnap } = load();
  for (const orthographic of [true, false]) for (const zoom of [0.5, 1, 3]) {
    const cam = camera(orthographic);
    cam.zoom = zoom;
    cam.updateProjectionMatrix();
    const origin = { x: 0, y: 0, z: 0 };
    const segment = [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }];
    const hit = screenAnnotationSnap({ x: 411, y: 300 }, cam, 800, 600, [origin], [segment], () => true);
    assert.equal(hit.isVertex, true);
    assert.equal(hit.point.x, 0);
    assert.equal(screenAnnotationSnap({ x: 413, y: 300 }, cam, 800, 600, [origin], [], () => true), null);
    assert.equal(screenAnnotationSnap({ x: 400, y: 309 }, cam, 800, 600, [], [segment], () => true).isVertex, false);
    assert.equal(screenAnnotationSnap({ x: 400, y: 300 }, cam, 800, 600, [origin], [segment], () => false), null);
  }
});

test('no ajustar detrás de piel, backing, plano de corte ni fuera de surfaceConstraint', () => {
  const { annotationSurfaceHit } = load();
  const cam = camera(), mesh = plane();
  assert.ok(annotationSurfaceHit(new THREE.Vector3(0, 0, 0), cam, mesh));
  assert.equal(annotationSurfaceHit(new THREE.Vector3(0, 0, -2), cam, mesh), null);
  assert.equal(annotationSurfaceHit(new THREE.Vector3(), cam, mesh, { accepts: () => false }), null);
  mesh.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -1)];
  assert.equal(annotationSurfaceHit(new THREE.Vector3(), cam, mesh), null);
  mesh.material.clippingPlanes = null;
  mesh.name = 'MASK_NEUTRAL_BACKING';
  assert.equal(annotationSurfaceHit(new THREE.Vector3(), cam, mesh), null);
});

test('elipse mantiene semiejes independientes y separa huecos sin raycast a otra cara', () => {
  const { projectedShapeSegments, projectNearbySurface } = load();
  const shape = { shapeType: 'ellipse', center: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    tangent: { x: 1, y: 0, z: 0 }, width: 2, height: 1 };
  const full = projectedShapeSegments(shape, plane(), camera()).flat();
  assert.ok(full.length > 90);
  assert.ok(Math.abs(Math.max(...full.map(point => point.x)) - 1) < 1e-6);
  assert.ok(Math.abs(Math.max(...full.map(point => point.y)) - 0.5) < 1e-6);
  const surface = new THREE.Group();
  surface.add(plane(1, -0.75), plane(1, 0.75), plane(8, 0, -2));
  surface.updateMatrixWorld(true);
  const segments = projectedShapeSegments(shape, surface, camera());
  assert.ok(segments.length >= 2);
  for (const segment of segments) for (let i = 1; i < segment.length; i++) {
    assert.equal(Math.sign(segment[i].x), Math.sign(segment[i - 1].x), 'no unir a través del hueco');
    assert.ok(Math.abs(segment[i].z) < 1e-6);
  }
  assert.equal(projectNearbySurface(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), surface, camera()), null);
});

test('selección Lab prioriza editablePoint sobre resize; por defecto conserva prioridad histórica', () => {
  for (const labInteraction of [false, true]) for (const annotationSnap of [false, true]) {
    let moved = 0, resized = 0;
    const app = engine({ labInteraction, annotationSnap, editablePoints: [{ id: 'tip', x: 0, y: 0, z: 0, type: 'free', lineIds: ['arrow'] }],
      freehandLines: [{ id: 'arrow', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: '#ffffff' }],
      onEditablePointMoved: () => moved++, onFreehandLineUpdated: () => resized++ });
    const point = new THREE.Group();
    point.userData = { editableId: 'tip', isEditablePoint: true };
    point.add(new THREE.Mesh(new THREE.SphereGeometry(0.04), new THREE.MeshBasicMaterial()));
    app.refs.editablePointsGroupRef.current.add(point);
    const handle = new THREE.Group();
    handle.userData = { handleRole: 'start', handleLineId: 'arrow' };
    handle.add(new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial()));
    app.refs.handlesGroupRef.current.add(handle);
    app.refs.handlesGroupRef.current.updateMatrixWorld(true);
    app.refs.editablePointsGroupRef.current.updateMatrixWorld(true);
    app.dom.dispatch('pointerdown');
    app.dom.dispatch('pointermove', { clientX: 420 });
    app.window.dispatch('pointerup', { clientX: 420 });
    assert.equal(moved, labInteraction ? 1 : 0);
    assert.equal(resized, labInteraction ? 0 : 1);
    assert.equal(app.refs.controlsRef.current.enabled, true);
    app.cleanup();
  }
});

test('drag Lab emite superficie sin offset y revierte previews rechazados; ficha conserva offset', () => {
  for (const labInteraction of [false, true]) for (const attached of [false, true]) {
    let moved;
    const point = { id: 'anchor', x: 0, y: 0, z: 0, type: 'free', lineIds: attached ? ['line'] : [] };
    const app = engine({ labInteraction, editablePoints: [point],
      onEditablePointMoved: (id, position) => { moved = { id, position }; } });
    const renderPoints = () => app.effects.find(({ effect }) => effect.toString().includes('ptGroup.userData.pointName')).effect();
    renderPoints();
    const group = app.refs.editablePointsGroupRef.current.children[0];
    app.refs.editablePointsGroupRef.current.updateMatrixWorld(true);
    app.dom.dispatch('pointerdown');
    app.dom.dispatch('pointermove', { clientX: 404, clientY: 302 });
    assert.ok(group.position.x > 0);
    assert.ok(Math.abs(group.position.z - 0.03) < 1e-6, 'offset solo para preview');
    app.window.dispatch('pointerup', { clientX: 404, clientY: 302 });
    assert.equal(moved.id, point.id);
    assert.ok(Math.abs(moved.position.x - 0.04) < 1e-6);
    assert.ok(Math.abs(moved.position.z - (labInteraction ? 0 : 0.03)) < 1e-6);
    if (labInteraction) {
      assert.equal(group.position.length(), 0, 'rechazo sin cambiar props no deja ghost');
      app.render({ editablePoints: [{ ...point, ...moved.position }] });
      renderPoints();
      const accepted = app.refs.editablePointsGroupRef.current.children[0];
      assert.ok(Math.abs(accepted.position.x - moved.position.x) < 1e-6, 'padre confirma por props');
    }
    assert.equal(app.refs.controlsRef.current.enabled, true);
    app.cleanup();
  }
});

test('Lab crea sobre handles existentes sin editar el trazo seleccionado', () => {
  for (const activeTool of ['straight-line', 'shape-arrow', 'freehand-brush', 'shape-circle', 'shape-rect', 'shape-ellipse', 'ha-fan', 'ha-fern']) {
    let created = 0, updated = 0;
    const app = engine({ labInteraction: true, annotationSnap: false, activeTool,
      freehandLines: [{ id: 'existing', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: '#ffffff' }],
      onFreehandLineComplete: () => created++, onShapeComplete: () => created++, onFreehandLineUpdated: () => updated++ });
    const handle = new THREE.Group();
    handle.userData = { handleRole: 'start', handleLineId: 'existing' };
    handle.add(new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial()));
    app.refs.handlesGroupRef.current.add(handle);
    app.refs.handlesGroupRef.current.updateMatrixWorld(true);
    app.dom.dispatch('pointerdown');
    app.dom.dispatch('pointermove', { clientX: 440, clientY: 330 });
    app.window.dispatch('pointerup', { clientX: 440, clientY: 330 });
    assert.equal(created, 1, activeTool);
    assert.equal(updated, 0, activeTool);
    assert.equal(app.refs.controlsRef.current.enabled, true);
    app.cleanup();
  }
});

test('Escape, token y pointercancel descartan trazos sin guardar y liberan órbita', () => {
  for (const tool of ['freehand-brush', 'straight-line', 'shape-arrow', 'shape-circle', 'shape-ellipse', 'ha-fan', 'ha-fern', 'freehand-poly', 'ha-grid']) {
    for (const cancel of ['escape', 'token', 'pointercancel']) {
      let saved = 0;
      const app = engine({ labInteraction: true, annotationSnap: false, activeTool: tool, onFreehandLineComplete: () => saved++, onShapeComplete: () => saved++ });
      app.dom.dispatch('pointerdown');
      app.dom.dispatch('click');
      app.dom.dispatch('pointermove', { clientX: 440, clientY: 330 });
      if (cancel === 'escape') app.window.dispatch('keydown', { key: 'Escape' });
      else if (cancel === 'pointercancel') app.dom.dispatch('pointercancel');
      else {
        const effects = app.render({ cancellationToken: 1 });
        effects.find(({ deps }) => deps?.length === 1 && deps[0] === 1).effect();
      }
      app.window.dispatch('pointerup', { clientX: 440, clientY: 330 });
      assert.equal(saved, 0, `${tool}: ${cancel}`);
      assert.equal(app.refs.controlsRef.current.enabled, true);
      assert.equal(app.refs.brushPreviewGroupRef.current.children.length, 0);
      if (!['ha-grid', 'freehand-poly'].includes(tool)) {
        app.dom.dispatch('pointerdown');
        app.dom.dispatch('pointermove', { clientX: 440, clientY: 330 });
        app.window.dispatch('pointerup', { clientX: 440, clientY: 330 });
        assert.equal(saved, 1, `${tool}: permite dibujar después de ${cancel}`);
      }
      app.cleanup();
    }
  }
});

test('Escape no invade inputs, edición de texto, IME ni diálogos visibles', () => {
  const { shouldCancelAnnotation, document, Element } = load();
  assert.equal(shouldCancelAnnotation({ key: 'Escape' }, document), true);
  for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'dialog']) {
    assert.equal(shouldCancelAnnotation({ key: 'Escape', target: new Element(selector) }, document), false);
  }
  assert.equal(shouldCancelAnnotation({ key: 'Escape', isComposing: true }, document), false);
  document.dialogs = [new Element('dialog')];
  assert.equal(shouldCancelAnnotation({ key: 'Escape' }, document), false);
});

test('elipse por drag guarda ancho/alto independientes aun sin annotationSnap', () => {
  let shape;
  const app = engine({ activeTool: 'shape-ellipse', onShapeComplete: value => { shape = value; } });
  app.dom.dispatch('pointerdown');
  app.dom.dispatch('pointermove', { clientX: 450, clientY: 320 });
  app.window.dispatch('pointerup', { clientX: 450, clientY: 320 });
  assert.equal(shape.shapeType, 'ellipse');
  assert.equal(shape.outline.length, 97);
  assert.ok(Math.abs(shape.width - 1) < 1e-6);
  assert.ok(Math.abs(shape.height - 0.4) < 1e-6);
  assert.equal(app.refs.controlsRef.current.enabled, true);
  app.cleanup();
});

test('coverage se dibuja, pero no selecciona, no ajusta imán ni crea handles', () => {
  let selected = 0, snap;
  const app = engine({ annotationSnap: true, pointMode: 'add', selectedElementId: 'coverage:anchor',
    freehandLines: [{ id: 'coverage:anchor', points: [{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: '#ffffff' }],
    onElementSelected: id => { if (id) selected++; }, onAnnotationSnap: value => { snap = value; } });
  app.effects.find(({ effect }) => effect.toString().includes('freehandLines.forEach(line')).effect();
  app.effects.find(({ effect }) => effect.toString().includes('const makeHandle')).effect();
  assert.ok(app.refs.freehandGroupRef.current.children.length > 0);
  assert.equal(app.refs.handlesGroupRef.current.children.length, 0);
  app.refs.freehandGroupRef.current.updateMatrixWorld(true);
  app.dom.dispatch('pointermove');
  assert.equal(snap, undefined);
  app.render({ pointMode: 'none' });
  app.effects.find(({ effect }) => effect.toString().includes('callbacks.current =')).effect();
  app.dom.dispatch('click');
  assert.equal(selected, 0);
  app.cleanup();
});

test('contorno proyectado no se guarda si atraviesa huecos', () => {
  let saved = 0;
  const app = engine({ activeTool: 'shape-ellipse', onShapeComplete: () => saved++ });
  const surface = new THREE.Group();
  surface.add(plane(0.4, 0), plane(0.4, 0.8), plane(8, 0, -2));
  surface.updateMatrixWorld(true);
  app.refs.faceMeshRef.current = surface;
  app.dom.dispatch('pointerdown');
  app.dom.dispatch('pointermove', { clientX: 480, clientY: 340 });
  app.window.dispatch('pointerup', { clientX: 480, clientY: 340 });
  assert.equal(saved, 0);
  assert.equal(app.refs.controlsRef.current.enabled, true);
  app.cleanup();
});

test('proyección conservadora depende de labInteraction, no del imán; ficha conserva forma por defecto', () => {
  for (const labInteraction of [false, true]) for (const annotationSnap of [false, true]) {
    let saved = 0;
    const app = engine({ labInteraction, annotationSnap, activeTool: 'shape-circle', onShapeComplete: () => saved++ });
    const surface = new THREE.Group();
    surface.add(plane(0.4, 0), plane(0.4, 0.8), plane(8, 0, -2));
    surface.updateMatrixWorld(true);
    app.refs.faceMeshRef.current = surface;
    app.dom.dispatch('pointerdown');
    app.dom.dispatch('pointermove', { clientX: 480, clientY: 340 });
    app.window.dispatch('pointerup', { clientX: 480, clientY: 340 });
    assert.equal(saved, labInteraction ? 0 : 1);
    assert.equal(app.refs.controlsRef.current.enabled, true);
    app.cleanup();
  }
});

test('sliders piel y capas aplican opacidad inmediatamente; corte no recompila por posición/opacidad', () => {
  const app = engine({ labInteraction: true, annotationSnap: false, anatomicalOverlay: { skin: { visible: true, opacity: 0.3 } },
    clipping: { scope: 'skin', axis: 'x', position: 0.5, reverse: false } });
  const find = fragment => app.effects.find(({ effect }) => effect.toString().includes(fragment));
  const reference = {
    positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    canvas: app.document.createElement('canvas'), opacity: 0.2,
  };
  app.render({ anatomicalOverlay: { skin: { visible: true, opacity: 0.3 }, references: [reference] } });
  find('const reduce =').effect();
  assert.ok(Math.abs(app.refs.faceMeshRef.current.material.opacity - 0.3) < 1e-6);
  const visual = app.refs.referenceVisuals.current.get(reference.canvas);
  assert.equal(visual.material.opacity, 0.2);
  find('const touched = new Set').effect();
  find('clipPlane.current.set').effect();
  const material = app.refs.faceMeshRef.current.material, version = material.version, clip = material.clippingPlanes[0];
  app.render({ anatomicalOverlay: { skin: { visible: true, opacity: 0.7 }, references: [{ ...reference, opacity: 0.6 }] },
    clipping: { scope: 'skin', axis: 'x', position: 0.8, reverse: true } });
  find('const reduce =').effect();
  find('const touched = new Set').effect();
  find('clipPlane.current.set').effect();
  assert.ok(Math.abs(material.opacity - 0.7) < 1e-6);
  assert.equal(visual.material.opacity, 0.6);
  assert.equal(material.version, version);
  assert.equal(material.clippingPlanes[0], clip);
  assert.equal(clip.normal.x, -1);
  assert.ok(clip.constant > 0);
  app.cleanup();
});

test('clic sin hover ajusta al extremo visible y comunica target/null sin depender de hitbox del tubo', () => {
  let marker, target;
  const app = engine({ annotationSnap: true, pointMode: 'add',
    freehandLines: [{ id: 'arrow', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: '#ffffff' }],
    onMeshClick: value => { marker = value; }, onAnnotationSnap: value => { target = value; } });
  app.dom.dispatch('click', { clientX: 411 });
  assert.ok(marker.snappedToLine);
  assert.equal(marker.position.x, 0);
  assert.equal(marker.position.z, 0);
  assert.equal(target.x, 0);
  app.dom.dispatch('pointermove', { clientX: 700, clientY: 500 });
  assert.equal(target, null);
  app.cleanup();
});

test('Lab sin imán marca posición libre aunque exista un extremo cercano', () => {
  let marker, target;
  const app = engine({ labInteraction: true, annotationSnap: false, pointMode: 'add',
    freehandLines: [{ id: 'arrow', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], color: '#ffffff' }],
    onMeshClick: value => { marker = value; }, onAnnotationSnap: value => { target = value; } });
  app.dom.dispatch('pointerdown', { clientX: 411 });
  app.dom.dispatch('pointermove', { clientX: 411 });
  app.window.dispatch('pointerup', { clientX: 411 });
  app.dom.dispatch('click', { clientX: 411 });
  assert.equal(marker.snappedToLine, false);
  assert.ok(marker.position.x > 0.1);
  assert.equal(target, undefined);
  app.cleanup();
});

test('sprites seleccionan/mueven el ancla sin esfera visible; array vacío oculta etiquetas', () => {
  let selected, moved;
  const label = { id: 'text', position: { x: 0, y: 0, z: 0 }, text: 'Regla: 20 % del ancho facial', color: '#ffffff' };
  const app = engine({ labInteraction: true, annotationLabels: [label], editablePoints: [{ id: 'text', ...label.position, type: 'free', lineIds: [] }],
    onEditablePointClicked: id => { selected = id; }, onEditablePointMoved: (id, position) => { moved = { id, position }; } });
  const labelsEffect = app.effects.find(({ effect }) => effect.toString().includes('new THREE.CanvasTexture(canvas)'));
  const dispose = labelsEffect.effect();
  app.effects.find(({ effect }) => effect.toString().includes("ptGroup.userData.pointName")).effect();
  assert.equal(app.refs.editablePointsGroupRef.current.children[0].children.length, 0);
  // Ejecutar un frame para tamaño constante en pantalla y matrices de sprites.
  app.refs.annotationLabelsGroupRef.current.children[0].scale.set(2, 0.3, 1);
  app.refs.annotationLabelsGroupRef.current.updateMatrixWorld(true);
  app.dom.dispatch('pointerdown', { clientX: 410, clientY: 290 });
  app.window.dispatch('pointerup', { clientX: 410, clientY: 290 });
  assert.equal(selected, 'text');
  app.dom.dispatch('pointerdown', { clientX: 410, clientY: 290 });
  app.dom.dispatch('pointermove', { clientX: 440, clientY: 290 });
  app.window.dispatch('pointerup', { clientX: 440, clientY: 290 });
  assert.equal(moved.id, 'text');
  assert.ok(moved.position.x > 0);
  assert.equal(moved.position.z, 0, 'sprite entrega superficie sin offset');
  assert.equal(app.refs.annotationLabelsGroupRef.current.children[0].position.length(), 0, 'sprite rechazado vuelve al ancla');
  let disposed = false;
  app.refs.annotationLabelsGroupRef.current.children[0].material.map.addEventListener('dispose', () => { disposed = true; });
  dispose();
  assert.equal(disposed, true);
  app.render({ annotationLabels: [] }).find(({ effect }) => effect.toString().includes('new THREE.CanvasTexture(canvas)')).effect();
  assert.equal(app.refs.annotationLabelsGroupRef.current.children.length, 0);
  app.cleanup();
});
