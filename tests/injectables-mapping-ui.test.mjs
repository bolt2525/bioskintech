import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/admin/ficha-clinica/components/tabs/InjectablesTab.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('InjectablesTab.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const viewerSource = readFileSync(new URL('../src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx', import.meta.url), 'utf8');
const viewerAst = ts.createSourceFile('Clinical3DViewer.tsx', viewerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const THREE = createRequire(import.meta.url)('three');
function loadOcclusionFunction(name) {
  const declaration = viewerAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  const code = ts.transpileModule(`${declaration.getText(viewerAst)}\nglobalThis.result = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = vm.createContext({ THREE });
  vm.runInContext(code, sandbox);
  return sandbox.result;
}

test('carga 3D: ignora éxitos y errores tardíos de fuentes reemplazadas o desmontadas', () => {
  let loadingEffect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(viewerAst) === 'useEffect'
      && node.arguments[1]?.getText(viewerAst) === '[modelSource, cameraPreset]') loadingEffect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(viewerAst);
  assert.ok(loadingEffect);
  const code = ts.transpileModule(`globalThis.effect = ${loadingEffect.getText(viewerAst)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const type of ['url', 'buffer']) {
    let success, failure, loaded = 0, errors = 0;
    const disposed = [];
    const scene = new THREE.Scene();
    const sandbox = vm.createContext({
      THREE, ArrayBuffer,
      GLTFLoader: class {
        load(_data, done, _progress, error) { success = done; failure = error; }
        parse(_data, _path, done, error) { success = done; failure = error; }
      },
      sceneRef: { current: scene }, faceMeshRef: { current: null }, scalpHairGroupRef: { current: null },
      modelSource: { type, data: type === 'url' ? '/fake.glb' : new ArrayBuffer(8) },
      disposeObject3D: o => disposed.push(o),
      callbacks: { current: { onLoaded: () => loaded++, onError: () => errors++ } },
    });
    vm.runInContext(code, sandbox);
    const cleanup = sandbox.effect();
    assert.equal(typeof success, 'function');
    assert.equal(typeof failure, 'function');
    cleanup();
    const obsolete = new THREE.Group();
    success({ scene: obsolete });
    failure(new Error('respuesta obsoleta'));
    assert.deepEqual(disposed, [obsolete]);
    assert.equal(scene.children.length, 0);
    assert.equal(loaded, 0);
    assert.equal(errors, 0);
  }
});

test('oclusión real: el rostro bloquea puntos del lado opuesto y conserva los del lado visible', () => {
  const visible = loadOcclusionFunction('isSurfacePositionVisible');
  const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), new THREE.MeshBasicMaterial());
  surface.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  assert.equal(visible(new THREE.Vector3(0, 0, 1.03), camera, surface), true);
  assert.equal(visible(new THREE.Vector3(0, 0, -1.03), camera, surface), false);
  assert.equal(visible(new THREE.Vector3(0, 0, 6), camera, surface), false);
  assert.equal(visible(new THREE.Vector3(20, 0, 0), camera, surface), false);
  camera.position.set(0, 0, -5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  assert.equal(visible(new THREE.Vector3(0, 0, -1.03), camera, surface), true);
  assert.equal(visible(new THREE.Vector3(0, 0, 1.03), camera, surface), false);
  assert.equal(visible(new THREE.Vector3(0, 0, 1.03), camera, null), false);
});

test('raycast no selecciona hitboxes ocultos por el modelo ni grupos invisibles', () => {
  const filter = loadOcclusionFunction('visibleSurfaceHits');
  const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), new THREE.MeshBasicMaterial());
  const makeHitbox = z => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.06), new THREE.MeshBasicMaterial({ visible: false }));
    mesh.position.z = z;
    mesh.updateMatrixWorld(true);
    return mesh;
  };
  const front = makeHitbox(1.03), back = makeHitbox(-1.03);
  surface.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(filter(ray, [back], surface, true).length, 0);
  assert.equal(filter(ray, [back], surface, false).length, 1, 'Otros consumidores mantienen el comportamiento anterior');
  assert.equal(filter(ray, [front, back], surface, true)[0].object, front);
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(front);
  hidden.updateMatrixWorld(true);
  assert.equal(filter(ray, [front], surface, true).length, 0);
  assert.equal(filter(ray, [back], null, true).length, 0);
});

test('trazos, halos y labels respetan profundidad sin perder colores y restauran modo anterior', () => {
  const apply = loadOcclusionFunction('applyAnnotationDepth');
  const defaults = new WeakMap();
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: 'red', depthTest: false, depthWrite: true });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.03), material);
  const spriteMaterial = new THREE.SpriteMaterial({ depthTest: false });
  group.add(mesh, new THREE.Sprite(spriteMaterial));
  apply(group, true, defaults);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, false);
  assert.equal(spriteMaterial.depthTest, true);
  assert.equal(material.color.getHexString(), 'ff0000');
  apply(group, true, defaults);
  apply(group, false, defaults);
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, true);
  assert.equal(spriteMaterial.depthTest, false);
});

test('oclusión está conectada a hover, arrastre, borrar, selección, snap, cantidades y capturas', () => {
  for (const meshes of ['handleMeshes', 'zonalMeshes', 'epMeshes', 'fhMeshes', 'shMeshes', 'lineMeshes', 'hoverMeshes']) {
    assert.ok(viewerSource.includes(`visibleSurfaceHits(${meshes === 'hoverMeshes' ? 'hoverRc' : 'raycaster'}, ${meshes}, faceMeshRef.current, callbacks.current.occludeAnnotations)`));
  }
  assert.match(viewerSource, /visibleSurfaceHits\(hoverRc, epMeshes/);
  assert.match(viewerSource, /visibleSurfaceHits\(raycaster, \[editablePointsGroupRef\.current\]/);
  assert.match(viewerSource, /const snapVisible = currentSnapPt &&/);
  assert.match(viewerSource, /isSurfacePositionVisible\(wp, cam, faceMeshRef\.current\)/);
  assert.match(viewerSource, /occludeAnnotations = false/);
  assert.match(source, /<Clinical3DViewer\s+occludeAnnotations/);
  const capture = readFileSync(new URL('../src/components/admin/ficha-clinica/components/InjectableCaptureModal.tsx', import.meta.url), 'utf8');
  assert.match(capture, /<Clinical3DViewer\s+occludeAnnotations/);
  for (const contents of [source, capture]) assert.match(contents, /el\.style\.visibility = visible === false \? 'hidden' : 'visible'/);
});
const gridLayoutDeclaration = viewerAst.statements
  .flatMap(statement => ts.isVariableStatement(statement) ? statement.declarationList.declarations : [])
  .find(item => ts.isIdentifier(item.name) && item.name.text === 'createScreenGridLayout');
assert.ok(gridLayoutDeclaration, 'El diseño de Malla debe existir');
const gridLayoutScript = ts.transpileModule(`${gridLayoutDeclaration.getText(viewerAst)}\nglobalThis.createScreenGridLayout = createScreenGridLayout;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const gridLayoutContext = vm.createContext({});
vm.runInContext(gridLayoutScript, gridLayoutContext);
const createScreenGridLayout = (...args) => JSON.parse(JSON.stringify(gridLayoutContext.createScreenGridLayout(...args)));
const themeSource = readFileSync(new URL('../src/constants/theme.ts', import.meta.url), 'utf8');
const fieldHelpSource = readFileSync(new URL('../src/components/admin/ficha-clinica/data/fieldHelpTexts.ts', import.meta.url), 'utf8');
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reconcileEditablePoints');
assert.ok(declaration, 'La conciliación de puntos debe existir');
const script = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const context = vm.createContext({});
vm.runInContext(script, context);
const reconcile = (...args) => JSON.parse(JSON.stringify(context.reconcileEditablePoints(...args)));
const point = (id, x = 1) => ({ id, type: 'free', x, y: 2, z: 3, lineIds: [], name: id });
const applied = (id, x = 1) => ({ editablePointId: id, units: 2, label: 'Frente', position: { x, y: 2, z: 3 } });

test('cargar trazado conserva la posición de puntos libres ya aplicados', () => {
  assert.deepEqual(reconcile([point('line-guide')], [point('free-1', 4)], [applied('free-1', 4)]), [
    point('line-guide'), point('free-1', 4),
  ]);
});

test('recargar trazado conserva puntos asignados y actualiza guías sin dosis', () => {
  assert.deepEqual(reconcile([point('guide-1', 9), point('guide-2', 9)],
    [point('guide-1', 4), point('guide-2', 4)], [applied('guide-1', 4)]), [
    point('guide-1', 4), point('guide-2', 9),
  ]);
});

test('abrir un registro afectado reconstruye esfera desde la posición guardada', () => {
  assert.deepEqual(reconcile([], [point('guide')], [applied('free-1', 4)]), [
    point('guide'),
    { id: 'free-1', type: 'free', x: 4, y: 2, z: 3, lineIds: [], name: 'Frente' },
  ]);
});

test('conserva puntos personalizados sin dosis y no duplica los asignados', () => {
  const existing = [point('free-1', 4), point('custom')];
  assert.deepEqual(reconcile([], existing, [applied('free-1', 9)]), existing);
});

test('marcadores legacy sin editablePointId no se convierten ni se duplican', () => {
  assert.deepEqual(reconcile([], [], [{ id: 'legacy', units: 2 }]), []);
});

test('recuperación es idempotente y no altera los datos de dosis', () => {
  const original = [applied('free-1', 4)];
  const before = structuredClone(original);
  const recovered = reconcile([], [], original);
  assert.deepEqual(reconcile([], recovered, original), recovered);
  assert.deepEqual(original, before);
});

test('la conciliación cubre carga del registro y carga del trazado', () => {
  assert.match(source, /setEditablePoints\(reconcileEditablePoints\(\[\], rawEditablePoints, points\)\)/);
  assert.match(source, /setEditablePoints\(prev => reconcileEditablePoints\(points, prev, injectionPoints\)\)/);
});

function jsxAttribute(name, containingText) {
  let result;
  function visit(node) {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && node.getText(ast).includes(containingText)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const attribute = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
      if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) result = attribute.initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, `Atributo ${name}: ${containingText}`);
  return result.getText(ast);
}

test('Navegar y dibujar no habilitan la creación de puntos al pulsar la piel', () => {
  const callback = jsxAttribute('onMarkerPlaced', 'interactionHint');
  const handler = () => 'point';
  for (const mode of ['none', 'delete']) {
    assert.equal(vm.runInNewContext(callback, { pointMode: mode, handleMarkerPlaced: handler }), undefined);
  }
  assert.equal(vm.runInNewContext(callback, { pointMode: 'add', handleMarkerPlaced: handler }), handler);
});

test('Navegar desactiva herramientas, selección y menús de dibujo', () => {
  const changes = {};
  const names = ['setActiveTool', 'setPointMode', 'setActiveLineType', 'setSelectedElement', 'setShowShapesDropdown', 'setShowHaShapesDropdown'];
  const environment = Object.fromEntries(names.map(name => [name, value => { changes[name] = value; }]));
  const handler = jsxAttribute('onClick', 'Navegar / Rotar');
  vm.runInNewContext(`(${handler})()`, environment);
  assert.deepEqual(changes, {
    setActiveTool: 'none', setPointMode: 'none', setActiveLineType: null,
    setSelectedElement: null, setShowShapesDropdown: false, setShowHaShapesDropdown: false,
  });
});

test('ayuda contextual distingue navegar, añadir con y sin trazos, eliminar y dibujar', () => {
  const expression = jsxAttribute('interactionHint', 'Clinical3DViewer');
  for (const [tool, mode, expected] of [
    ['none', 'none', 'Arrastra para rotar'],
    ['none', 'add', 'Pasa sobre un trazo'],
    ['none', 'delete', 'Clic para eliminar punto'],
    ['freehand-brush', 'none', 'Dibujo activo'],
    ['shape-circle', 'none', 'Dibujo activo'],
    ['ha-grid', 'none', 'Dibujo activo'],
  ]) {
    assert.ok(vm.runInNewContext(expression, {
      activeTool: tool, pointMode: mode, freehandLines: [{ id: 'qa' }],
    }).startsWith(expected));
  }
  assert.ok(vm.runInNewContext(expression, {
    activeTool: 'none', pointMode: 'add', freehandLines: [],
  }).startsWith('Clic en la piel para añadir punto'));
});

test('los nuevos trazos usan el token de alto contraste sin recolorear el historial', () => {
  assert.match(themeSource, /annotation:\s*'#c62828'/);
  assert.match(source, /useState<string>\(COLORS\.annotation\)/);
  assert.equal((viewerSource.match(/pendingBrushColor = COLORS\.annotation/g) || []).length, 2);
  assert.match(source, /setFreehandLines\(rawFreehand\)/);
});

function loadFunction(name, environment = {}) {
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(ast);
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
      expression = `const ${name} = ${node.initializer.getText(ast)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, `Función ${name}`);
  const code = ts.transpileModule(`${expression}\nglobalThis.result = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = vm.createContext(environment);
  vm.runInContext(code, sandbox);
  return sandbox.result;
}

function loadViewerFunction(name) {
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(viewerAst) === name) {
      expression = `const ${name} = ${node.initializer.getText(viewerAst)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(viewerAst);
  assert.ok(expression, `Función del visor ${name}`);
  const code = ts.transpileModule(`${expression}\nglobalThis.result = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = vm.createContext({});
  vm.runInContext(code, sandbox);
  return sandbox.result;
}

test('el ajuste de trazos compuestos incluye los extremos de cada línea del Abanico', () => {
  const closest = loadViewerFunction('closestPointOnFreehandLine');
  const fan = {
    points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
    segments: [
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }],
    ],
  };
  const result = JSON.parse(JSON.stringify(closest(fan, { x: 0, y: 0.98, z: 0 }, 0.25, 0.18)));
  assert.deepEqual(result, { pt: { x: 0, y: 1, z: 0 }, isVertex: true });
});

test('concentración usa unidades originales del vial, no el total de sesión', () => {
  const concentration = loadFunction('getToxinaConcentration');
  assert.equal(concentration('100', '2.5'), 40);
  assert.equal(concentration('50', 1.25), 40);
  for (const [units, dilution] of [['', 2], ['100', ''], ['0', 2], ['-1', 2], ['100', 0], ['x', 2], ['100', 'x'], ['Infinity', 2], ['1e308', '1e-308']]) {
    assert.equal(concentration(units, dilution), null);
  }
});

test('mapa de toxina permite registro punto a punto sin total previo; relleno conserva su validación', () => {
  assert.equal(loadFunction('canMark', { current: { product_type: 'toxina', product_name: 'QA', units_used: '' } }), true);
  assert.equal(loadFunction('canMark', { current: { product_type: 'toxina', product_name: ' ', units_used: 20 } }), false);
  assert.equal(loadFunction('canMark', { current: { product_type: 'relleno', product_name: 'QA', volume_used: '' } }), false);
  assert.equal(loadFunction('canMark', { current: { product_type: 'relleno', product_name: 'QA', volume_used: 1 } }), true);
});

function saveFixture(overrides = {}, response = { ok: true, json: async () => ({ id: 101 }) }) {
  const result = { calls: 0, saved: null, message: null, focused: null, open: false };
  const details = { open: false };
  const environment = {
    current: { product_name: 'QA', product_type: 'toxina', date: '2026-10-10', units_used: 20, dilution_volume: 2.5, ...overrides },
    sessionUnits: overrides.units_used ?? 20, unitsFromMap: false,
    toxinaVialUnits: '100', recordId: 19, consultationId: 51,
    injectionPoints: [applied('free-1')], referenceLines: [], editablePoints: [point('free-1')],
    freehandLines: [], surfaceShapes: [], haVials: [],
    setFormError: value => { result.error = value; },
    setMessage: value => { result.message = value; },
    setSaving: value => { result.saving = value; },
    setCurrent: callback => { result.saved = callback(environment.current); },
    setDateLocked: value => { result.locked = value; },
    setIsPendingDuplicate: value => { result.duplicate = value; },
    setHighlightedId: () => {}, setTimeout: () => {}, onSave: () => { result.refreshed = true; },
    recordsFetch: async (_url, request) => { result.calls++; result.payload = JSON.parse(request.body); return response; },
    document: { getElementById: id => ({ closest: () => details, focus: () => { result.focused = id; } }) },
    console: { error: () => {} },
  };
  return { result, environment, details };
}

test('guardar conserva ID, mapa y preparación; la concentración no sustituye unidades aplicadas', async () => {
  const fixture = saveFixture();
  assert.equal(await loadFunction('handleSave', fixture.environment)(), true);
  assert.equal(fixture.result.saved.id, 101);
  assert.equal(fixture.result.payload.units_used, 20);
  assert.equal(fixture.result.saved.mapping_data.toxinaPreparation.vial_units, 100);
  assert.equal(fixture.result.saved.mapping_data.injectionPoints.length, 1);
  assert.equal(fixture.result.locked, true);
  assert.equal(fixture.result.saving, false);
});

test('guardar sin preparación no infiere capacidad del vial para registros históricos', async () => {
  const fixture = saveFixture({ id: 7 });
  fixture.environment.toxinaVialUnits = '';
  assert.equal(await loadFunction('handleSave', fixture.environment)(), true);
  assert.equal(fixture.result.saved.id, 7);
  assert.equal(fixture.result.payload.mapping_data.toxinaPreparation, undefined);
});

test('reabrir recupera preparación del JSON y carga legacy sin inventar unidades del vial', () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('mapping.toxinaPreparation')) effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const code = ts.transpileModule(`globalThis.load = ${effect};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const [mapping, expected] of [
    [{ injectionPoints: [], toxinaPreparation: { vial_units: 100 } }, '100'],
    [{ injectionPoints: [] }, ''],
    [[], ''],
    [null, ''],
  ]) {
    let units;
    const names = ['setToxinaUnitsFromMap', 'setInjectionPoints', 'setMarkers3D', 'setReferenceLines', 'setEditablePoints',
      'setRefJsonLoaded', 'setFreehandLines', 'setSurfaceShapes', 'setHaVials', 'setActiveVialId', 'setShow3D'];
    const environment = {
      current: { mapping_data: mapping == null ? null : JSON.stringify(mapping) },
      setToxinaVialUnits: value => { units = value; },
      reconcileEditablePoints: context.reconcileEditablePoints,
      ...Object.fromEntries(names.map(name => [name, () => {}])),
    };
    const sandbox = vm.createContext(environment);
    vm.runInContext(code, sandbox);
    sandbox.load();
    assert.equal(units, expected);
  }
});

test('guardar bloquea producto vacío y valores inválidos, con foco y error persistente', async () => {
  for (const [patch, field] of [[{ product_name: ' ' }, 'product_name'], [{ units_used: -1 }, 'units_used'], [{ dilution_volume: 'x' }, 'dilution_volume']]) {
    const fixture = saveFixture(patch);
    assert.equal(await loadFunction('handleSave', fixture.environment)(), false);
    assert.equal(fixture.result.calls, 0);
    assert.equal(fixture.result.focused, `toxina-${field}`);
    assert.equal(fixture.details.open, true);
    assert.equal(fixture.result.message.type, 'error');
  }
});

test('fallo de API no borra el registro ni comunica éxito', async () => {
  const fixture = saveFixture({}, { ok: false });
  assert.equal(await loadFunction('handleSave', fixture.environment)(), false);
  assert.equal(fixture.result.saved, null);
  assert.equal(fixture.result.message.type, 'error');
  assert.equal(fixture.result.saving, false);
});

test('guardar y cambiar no abandona el modo cuando falla el guardado', async () => {
  let switched = false;
  const confirm = loadFunction('confirmTabSwitch', {
    pendingTabSwitch: 'relleno', setPendingTabSwitch: () => {},
    handleSave: async () => false, setActiveType: () => { switched = true; },
  });
  await confirm(true);
  assert.equal(switched, false);
});

test('guardar y capturar no abre el modal si falla el guardado', async () => {
  for (const success of [false, true]) {
    let opened = false;
    const code = jsxAttribute('onClick', 'Guardar y abrir capturas');
    await vm.runInNewContext(`(${code})()`, {
      setCaptureAlert: () => {}, handleSave: async () => success, setCaptureModalOpen: () => { opened = true; },
    });
    assert.equal(opened, success);
  }
});

test('duplicar preserva anotaciones y preparación, sin conservar el ID original', () => {
  const fixture = saveFixture({ id: 7 });
  fixture.environment.freehandLines = [{ id: 'line-1' }];
  Object.assign(fixture.environment, {
    getLocalDate: () => '2026-10-10', setUndoStack: () => {}, setShowClearConfirm: () => {},
    setCurrent: value => { fixture.result.saved = value; },
  });
  loadFunction('handleDuplicate', fixture.environment)();
  assert.equal(fixture.result.saved.id, undefined);
  assert.equal(fixture.result.saved.mapping_data.toxinaPreparation.vial_units, 100);
  assert.equal(fixture.result.saved.mapping_data.freehandLines[0].id, 'line-1');
});

test('ocultar guías conserva esferas de puntos aplicados', () => {
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'visibleEditablePoints') expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const points = [point('guide'), point('free-1')];
  const visible = vm.runInNewContext(expression, { showEditablePoints: false, editablePoints: points, appliedPointIds: new Set(['free-1']) });
  assert.deepEqual(visible, [points[1]]);
});

const formSource = readFileSync(new URL('../src/components/admin/ficha-clinica/components/ToxinaSessionForm.tsx', import.meta.url), 'utf8');
const formExports = {};
const formCode = ts.transpileModule(formSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
vm.runInNewContext(formCode, { exports: formExports, require: createRequire(import.meta.url), Intl });

function renderFormSections(props) {
  return renderToStaticMarkup(formExports.default(props))
    + renderToStaticMarkup(formExports.ToxinaApplicationTotal({
      units: props.value.units_used, unitsFromMap: props.unitsFromMap, mappedUnits: props.mappedUnits,
      onChange: () => {}, onManualUnits: () => {}, error: props.error,
    }))
    + renderToStaticMarkup(formExports.ToxinaFollowUpForm(props));
}

test('formulario renderiza campos históricos, errores asociados y plegables nativos', () => {
  const html = renderFormSections({
    value: {
      date: '2026-10-10', product_name: 'QA', brand: 'Marca QA', lot_number: 'LOTE-QA', expiration_date: '',
      units_used: 20, dilution_volume: 2.5, technique: 'Técnica histórica', injection_plane: 'Plano histórico',
      needle_type: 'Aguja histórica', follow_up_date: '', notes: 'Nota QA',
    },
    onChange: () => {}, brands: [], needles: [], dateLocked: false, onUnlockDate: () => {},
    vialUnits: '100', onVialUnitsChange: () => {}, concentration: 40, mappedUnits: 2, unitsFromMap: false, onManualUnits: () => {},
    error: { field: 'units_used', text: 'Revisar total' },
  });
  assert.match(html, /Técnica histórica/);
  assert.match(html, /Plano histórico/);
  assert.match(html, /Nota QA/);
  assert.match(html, /40 U\/ml/);
  assert.match(html, /aria-describedby="toxina-units-note toxina-units_used-error"/);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]*\sopen[=> ]/);
});

test('formulario presenta total automático de solo lectura y desplegables con opciones y ayuda', () => {
  const html = renderFormSections({
    value: {
      date: '', product_name: '', brand: '', lot_number: '', expiration_date: '', units_used: '',
      dilution_volume: '', technique: '', injection_plane: '', needle_type: '', follow_up_date: '', notes: '',
    },
    onChange: () => {}, brands: [], needles: ['30G x 13mm'], dateLocked: false,
    onUnlockDate: () => {}, vialUnits: '', onVialUnitsChange: () => {},
    concentration: null, mappedUnits: 7.5, unitsFromMap: true, onManualUnits: () => {}, error: null,
  });
  assert.match(html, /readonly=""/i);
  assert.match(html, /Suma automática/);
  assert.equal((html.match(/role="combobox"/g) || []).length, 3);
  assert.doesNotMatch(html, /<select /);
  assert.ok(html.indexOf('Preparación del vial') < html.indexOf('Técnica de aplicación'));
  assert.ok(html.indexOf('Técnica de aplicación') < html.indexOf('Total aplicado en sesión'));
  assert.ok(html.indexOf('Total aplicado en sesión') < html.indexOf('Seguimiento y observaciones'));
  for (const field of ['product', 'date', 'brand', 'lot', 'expiration', 'injection_plane', 'technique', 'needle_type', 'follow-up', 'notes']) {
    assert.match(html, new RegExp(`toxina-${field}-help`));
  }
});

function findElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (predicate(tree)) return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
}

test('menú dorado abre opciones, selecciona con teclado y conserva valores personalizados', () => {
  const require = createRequire(import.meta.url);
  const state = [];
  let cursor = 0;
  let focused = false;
  let scrolled = false;
  const exports = {};
  vm.runInNewContext(formCode + '\nexports.DocumentedSelect = DocumentedSelect;', {
    exports, Intl, document: { getElementById: () => ({ scrollIntoView: () => { scrolled = true; } }) },
    require: name => name === 'react' ? {
      useState: initial => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
      },
      useRef: () => ({ current: { focus: () => { focused = true; } } }),
    } : require(name),
  });
  const props = { id: 'qa-select', label: 'Técnica', value: '', options: ['Puntual', 'Microinyecciones'], help: 'Documentar', onChange: next => { props.value = next; } };
  const render = () => { cursor = 0; return exports.DocumentedSelect(props); };
  let tree = render();
  findElement(tree, node => node.props?.role === 'combobox').props.onClick();
  tree = render();
  const list = findElement(tree, node => node.props?.role === 'listbox');
  assert.ok(list);
  assert.match(list.props.className, /bg-white/);
  assert.match(renderToStaticMarkup(tree), /bg-gold-light/);
  const key = key => findElement(render(), node => node.props?.role === 'combobox').props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
  key('ArrowDown');
  key('Enter');
  assert.equal(props.value, 'Puntual');
  assert.equal(findElement(render(), node => node.props?.role === 'combobox').props['aria-expanded'], false);
  assert.equal(focused, true);
  assert.equal(scrolled, true);
  findElement(render(), node => node.props?.role === 'combobox').props.onClick();
  key('End');
  key('Enter');
  assert.equal(props.value, 'Puntual', 'Elegir entrada personalizada no borra lo previamente documentado');
  const input = findElement(render(), node => node.type === 'input');
  input.props.onChange({ target: { value: 'Técnica histórica QA' } });
  assert.equal(props.value, 'Técnica histórica QA');
  findElement(render(), node => node.props?.role === 'combobox').props.onClick();
  key('Escape');
  assert.equal(findElement(render(), node => node.props?.role === 'combobox').props['aria-expanded'], false);
});

test('orden real sitúa total junto al mapa y seguimiento después del visor', () => {
  assert.ok(source.indexOf('<ToxinaSessionForm') < source.indexOf('<ToxinaApplicationTotal'));
  assert.ok(source.indexOf('<ToxinaApplicationTotal') < source.indexOf('<Clinical3DViewer'));
  assert.ok(source.indexOf('<Clinical3DViewer') < source.indexOf('<ToxinaFollowUpForm'));
});

test('total del mapa deriva de puntos actuales, incluido borrado final y deshacer', () => {
  const unitsFromMap = current => loadFunction('unitsFromMap', current);
  for (const points of [[{ units: 2 }, { units: 3.5 }], [{ units: 4 }], [], [{ units: 2 }]]) {
    const environment = { current: { product_type: 'toxina', units_used: 20 }, toxinaUnitsFromMap: true, injectionPoints: points };
    environment.totalUsed = loadFunction('totalUsed', environment);
    environment.unitsFromMap = unitsFromMap(environment);
    assert.equal(loadFunction('sessionUnits', environment), points.reduce((sum, point) => sum + point.units, 0));
  }
  assert.equal(loadFunction('sessionUnits', { current: { units_used: 20 }, unitsFromMap: false, totalUsed: 0 }), 20);
});

test('guardar usa el total automático y mantiene origen mapa aunque se elimine el último punto', async () => {
  for (const total of [2, 0]) {
    const fixture = saveFixture();
    fixture.environment.unitsFromMap = true;
    fixture.environment.sessionUnits = total;
    if (total === 0) fixture.environment.injectionPoints = [];
    assert.equal(await loadFunction('handleSave', fixture.environment)(), true);
    assert.equal(fixture.result.payload.units_used, total);
    assert.equal(fixture.result.saved.units_used, total);
    assert.equal(fixture.result.payload.mapping_data.toxinaUnitsSource, 'map');
  }
});

test('rellenos presentan producto, volumen, mapa y seguimiento en orden', () => {
  const steps = [
    'title="Producto y sesión"',
    'title="Volumen y presentaciones"',
    'title="Mapeo y registro"',
    'title="Seguimiento y observaciones"',
  ].map(title => source.indexOf(title));
  assert.ok(steps.every(index => index >= 0), 'Secciones numeradas de relleno');
  assert.deepEqual(steps, [...steps].sort((left, right) => left - right));
  assert.match(source, /title="Añadir presentación|Añadir presentación/);
  assert.match(source, /Presentaciones adicionales/);
  assert.match(source, /mappingPrerequisiteAttempted && !canMark/);
  assert.match(source, /Completa el nombre del producto y registra el volumen en ml para abrir el mapeo/);
  assert.doesNotMatch(source, /placeholder="Ej: Juvederm Ultra"/);
});

test('edición por punto usa selectores accesibles dorados y aclara la copia masiva', () => {
  for (const field of ['technique', 'needle', 'plane']) {
    assert.ok(source.includes(`<PointFieldSelect id={\`point-${field}-\${index}\`}`));
  }
  const selector = source.slice(source.indexOf('function PointFieldSelect'), source.indexOf('const DRAWING_GUIDE'));
  assert.match(selector, /role="combobox"/);
  assert.match(selector, /role="listbox"/);
  assert.match(selector, /role="option"/);
  assert.match(selector, /type="text"/);
  assert.match(selector, /placeholder="Escribe o selecciona…"/);
  assert.match(selector, /onChange\(nextQuery\)/);
  assert.match(selector, /setShowAllOptions\(true\)/);
  assert.match(selector, /listbox\.contains\(event\.target\)\) return/);
  assert.match(selector, /bg-\[#deb887\]\/20/);
  assert.match(selector, /focus-visible:ring-\[#b8944d\]/);
  assert.match(selector, /event\.key === 'ArrowDown'/);
  assert.match(source, /focus-visible:ring-2 focus-visible:ring-gold/);
  assert.match(source, /Sin detalles/);
  assert.match(source, /aria-pressed=\{bulkApplyMode \? isBulkSelected : isSelected\}/);
  assert.match(source, /Copiar a todos/);
  assert.match(source, /Elegir puntos/);
  assert.match(source, /Un campo vacío también puede borrar el valor existente/);
  assert.match(source, /aria-label=\{`Eliminar punto \$\{globalIndex \+ 1\}`\}/);
});

test('hover de opciones desplaza solamente la lista, sin scroll de ancestros', () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('const bottom = top + option.offsetHeight')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  assert.doesNotMatch(effect.getText(ast), /scrollIntoView/);
  const listbox = { scrollTop: 40, clientHeight: 100 };
  const option = { offsetTop: 160, offsetHeight: 36 };
  const sandbox = vm.createContext({
    open: true, id: 'point-technique-0', optionsId: 'point-technique-0-options', activeIndex: 5,
    document: { getElementById: id => id.endsWith('options') ? listbox : option },
  });
  vm.runInContext(`globalThis.adjust = ${effect.getText(ast)};`, sandbox);
  sandbox.adjust();
  assert.equal(listbox.scrollTop, 96);
  option.offsetTop = 20;
  sandbox.adjust();
  assert.equal(listbox.scrollTop, 20);
  option.offsetTop = 30;
  sandbox.adjust();
  assert.equal(listbox.scrollTop, 20);
  assert.match(source, /Math\.max\(240, rect\.width\)/);
  assert.match(source, /overflow-x-hidden overflow-y-auto overscroll-contain/);
  assert.match(source, /document\.fullscreenElement \?\? document\.body/);
});

test('editor compartido muestra tres campos completos y mantiene nota y copia plegadas', () => {
  const editor = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'PointDetailsEditor');
  const require = createRequire(import.meta.url);
  const sandbox = vm.createContext({
    require, exports: {}, techniques: [], needles: [],
    PointFieldSelect: ({ id }) => require('react').createElement('input', { id }),
  });
  const code = ts.transpileModule(`${editor.getText(ast)}\nglobalThis.editor = PointDetailsEditor;`, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(code, sandbox);
  const props = { point: {}, index: 0, planes: [], canCopy: true, onChange() {}, onCopyAll() {}, onChoosePoints() {}, onEditEnd() {} };
  const html = renderToStaticMarkup(sandbox.editor(props));
  assert.equal((html.match(/<input id="point-(technique|needle|plane)-0"/g) || []).length, 3);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|grid-cols-2/);
  assert.match(html, /Copiar campos/);
  const singleHtml = renderToStaticMarkup(sandbox.editor({ ...props, canCopy: false }));
  assert.doesNotMatch(singleHtml, /Copiar campos|Reemplaza técnica/);
  assert.equal((source.match(/<PointDetailsEditor point=\{p\}/g) || []).length, 2);
});

test('copiar a todos o a selección registra undo y preserva cantidades, notas y vial', () => {
  for (const selected of [false, true]) {
    let points = [
      { editablePointId: 'a', units: 0.3, vial_id: 'v1', notes_at_point: 'Origen', technique_at_point: '', needle_at_point: '25G', injection_plane: 'Medio' },
      { editablePointId: 'b', units: 0.5, vial_id: 'v2', notes_at_point: 'Destino', technique_at_point: 'Lineal', needle_at_point: '', injection_plane: 'Profundo' },
      { editablePointId: 'c', units: 0.7, vial_id: 'v3', notes_at_point: 'Otro', technique_at_point: 'Puntual' },
    ];
    const original = structuredClone(points);
    let snapshots = 0;
    const handler = loadFunction(selected ? 'handleApplyBulkSelected' : 'handleBulkApply', {
      injectionPoints: points, bulkApplySourceIdx: 0, bulkApplySelected: new Set(['b']),
      pushUndo: () => snapshots++, setInjectionPoints: fn => { points = fn(points); },
      setBulkApplyMode() {}, setBulkApplySourceIdx() {}, setBulkApplySelected() {},
    });
    handler(0);
    assert.equal(snapshots, 1);
    assert.equal(points[1].technique_at_point, '');
    assert.equal(points[1].needle_at_point, '25G');
    for (let i = 0; i < points.length; i++) {
      for (const field of ['units', 'notes_at_point', 'vial_id']) assert.equal(points[i][field], original[i][field]);
    }
    if (selected) assert.deepEqual(JSON.parse(JSON.stringify(points[2])), original[2]);
  }
});

test('terminar patrones cambia a registro manual solamente con la opción activada', () => {
  for (const enabled of [false, true]) {
    for (const preset of ['Abanico', 'Malla', 'Helecho', 'Pincel', undefined]) {
      let lines = [], tool = 'drawing', pointMode = 'none', snapshots = 0;
      const handler = loadFunction('handleFreehandComplete', {
        useCallback: fn => fn, markAfterPattern: enabled, pushUndo: () => snapshots++,
        setFreehandLines: fn => { lines = fn(lines); }, setActiveTool: next => { tool = next; },
        setPointMode: next => { pointMode = next; }, setSelectedElement() {},
      });
      const line = { id: 'pattern', technique_preset: preset, segments: [[{ x: 0, y: 0, z: 1 }]] };
      handler(line);
      assert.equal(snapshots, 1);
      assert.equal(lines.length, 1);
      assert.equal(lines[0], line);
      const shouldSwitch = enabled && ['Abanico', 'Malla', 'Helecho'].includes(preset);
      assert.equal(pointMode, shouldSwitch ? 'add' : 'none');
      assert.equal(tool, shouldSwitch ? 'none' : 'drawing');
    }
  }
});

test('guías flotan sin expandir el grid y viales no ocultan puntos sin asignación', () => {
  const panel = findElementNode('injectable-visibility-panel');
  assert.match(panel.getText(ast), /className="fixed z-\[9999\]/);
  assert.match(source, /showVisibilityDropdown && createPortal/);
  assert.match(source, /!visibilityPopupRef\.current\?\.contains\(event\.target\)/);
  assert.doesNotMatch(source, /<summary[^>]*>Guías y visibilidad/);
  assert.match(source, /Sin presentación asignada/);
  assert.match(source, /!haVials\.some\(item => item\.id === p\.vial_id\)/);
  assert.match(source, /Apertura total/);
  assert.match(source, /fanAngle: Number\(e\.target\.value\) \/ 2/);
});

function findElementNode(id) {
  let result;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'id' && attribute.initializer?.text === id)) result = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result);
  return result;
}

function magnetHarness({ reduced = false } = {}) {
  const windowListeners = new Map(), documentListeners = new Map(), timers = new Map(), moves = [];
  let timerId = 0, areaTop = 1000;
  class Element {
    constructor(kind = '') { this.kind = kind; }
    closest() { return ['canvas', 'input', 'list', 'tools'].includes(this.kind) ? this : null; }
    contains(element) { return this === workspace || this.kind === 'scroller' ? element !== header : this === element; }
    matches() { return this.kind === 'input'; }
    getBoundingClientRect() {
      if (this.kind === 'header') return { top: 0, bottom: 96 };
      if (this.kind === 'scroller') return { top: 96, bottom: 900 };
      return { top: areaTop, bottom: areaTop + 620 };
    }
  }
  class WheelEvent { constructor(target, deltaY = 40) { this.target = target; this.deltaY = deltaY; } }
  class KeyboardEvent { constructor(key, target) { this.key = key; this.target = target; } }
  const header = new Element('header'), workspace = new Element('workspace'), scroller = new Element('scroller');
  workspace.querySelector = () => null;
  const css = new Map();
  workspace.style = { setProperty: (key, value) => css.set(key, value), removeProperty: key => css.delete(key) };
  const window = {
    innerHeight: 900, innerWidth: 1366, scrollY: 0, matchMedia: () => ({ matches: reduced }),
    addEventListener: (name, callback) => windowListeners.set(name, callback),
    removeEventListener: name => windowListeners.delete(name),
    scrollBy: options => moves.push({ ...options }),
  };
  scroller.scrollBy = options => moves.push({ ...options, nested: true });
  const document = {
    querySelectorAll: () => [header], querySelector: () => null, activeElement: null, fullscreenElement: null,
    addEventListener: (name, callback) => documentListeners.set(name, callback),
    removeEventListener: name => documentListeners.delete(name),
  };
  const setup = loadFunction('enableWorkspaceMagnet', {
    window, document, Element, HTMLElement: Element, WheelEvent, KeyboardEvent,
    getComputedStyle: element => ({ position: element === header ? 'sticky' : 'static', top: '0px' }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const cleanup = setup(workspace);
  const scroll = (top, target = document) => { areaTop = top; windowListeners.get('scroll')?.({ target }); };
  const wheel = (target = document, deltaY = 40) => windowListeners.get('wheel')?.(new WheelEvent(target, deltaY));
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  return { workspace, scroller, window, document, windowListeners, documentListeners, timers, moves, css, cleanup, scroll, wheel, flush, Element, KeyboardEvent };
}

test('imán ajusta una vez tras pausa, respeta encabezado y permite continuar libremente', () => {
  const h = magnetHarness();
  h.scroll(300);
  h.flush();
  assert.equal(h.moves.length, 0, 'El scroll programático no activa el imán');
  h.wheel();
  h.scroll(240);
  assert.equal(h.moves.length, 0, 'No ajustar mientras el usuario sigue desplazándose');
  h.flush();
  assert.deepEqual(h.moves, [{ top: 132, behavior: 'smooth' }]);
  assert.equal(h.css.get('--injectables-workspace-height'), '756px');
  assert.equal(h.css.get('--injectables-viewer-height'), '560px');
  h.wheel(); h.scroll(108); h.flush();
  h.wheel(); h.scroll(48); h.flush();
  assert.equal(h.moves.length, 1, 'No volver a atraer durante la misma visita');
  h.scroll(1200);
  h.wheel(); h.scroll(240); h.flush();
  assert.equal(h.moves.length, 2, 'Una nueva visita desde fuera permite encuadrar');
  h.cleanup();
  assert.equal(h.windowListeners.size, 0);
  assert.equal(h.documentListeners.size, 0);
  assert.equal(h.css.size, 0);
});

test('imán no interrumpe edición, modelo, listas, diálogos ni desplazamiento ascendente', () => {
  for (const kind of ['input', 'canvas', 'list', 'tools']) {
    const h = magnetHarness();
    h.scroll(300);
    h.wheel(new h.Element(kind)); h.scroll(240); h.flush();
    assert.equal(h.moves.length, 0, kind);
  }
  for (const blocked of ['dialog', 'focus', 'fullscreen', 'menu']) {
    const h = magnetHarness();
    h.scroll(300);
    if (blocked === 'dialog') h.document.querySelector = () => ({});
    if (blocked === 'focus') h.document.activeElement = new h.Element('input');
    if (blocked === 'fullscreen') h.document.fullscreenElement = {};
    if (blocked === 'menu') h.workspace.querySelector = () => ({});
    h.wheel(); h.scroll(240); h.flush();
    assert.equal(h.moves.length, 0, blocked);
  }
  const h = magnetHarness();
  h.scroll(200);
  h.wheel(h.document, -40); h.scroll(240); h.flush();
  assert.equal(h.moves.length, 0);
  h.wheel(); h.scroll(200);
  h.documentListeners.get('pointerdown')();
  h.flush();
  assert.equal(h.moves.length, 0, 'Interactuar cancela el ajuste pendiente');
});

test('imán funciona en scroll anidado, teclado y movimiento reducido sin afectar listas internas', () => {
  const h = magnetHarness({ reduced: true });
  h.scroll(300, h.scroller);
  h.documentListeners.get('keydown')(new h.KeyboardEvent('PageDown', h.document));
  h.scroll(240, h.scroller); h.flush();
  assert.deepEqual(h.moves, [{ top: 132, behavior: 'instant', nested: true }]);
  const list = new h.Element('list');
  list.contains = () => false;
  h.scroll(1000, list);
  h.wheel(); h.scroll(200, h.scroller); h.flush();
  assert.equal(h.moves.length, 1);
  h.cleanup();
});

test('encuadre reserva espacio para herramientas y desglose en tablet y móvil', () => {
  const h = magnetHarness();
  h.window.innerWidth = 900;
  h.windowListeners.get('resize')();
  assert.equal(h.css.get('--injectables-viewer-height'), '496px');
  h.window.innerWidth = 390;
  h.window.innerHeight = 844;
  h.windowListeners.get('resize')();
  assert.equal(h.css.get('--injectables-workspace-height'), '700px');
  assert.equal(h.css.get('--injectables-viewer-height'), '250px');
  h.scroll(200);
  h.windowListeners.get('touchmove')({ target: h.document });
  h.scroll(260); h.flush();
  h.scroll(240); h.flush();
  assert.equal(h.moves.length, 0, 'Un gesto ascendente no deja armado un scroll programático posterior');
  h.cleanup();
});

test('subtotal visible evita ruido decimal sin modificar cantidades guardadas', () => {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'tercioTotal') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const pts = [{ units: 0.3 }, { units: 0.3 }, { units: 0.3 }];
  const sandbox = vm.createContext({ pts });
  vm.runInContext(`globalThis.total = ${initializer.getText(ast)};`, sandbox);
  assert.equal(sandbox.total, 0.9);
  assert.deepEqual(pts.map(p => p.units), [0.3, 0.3, 0.3]);
});

test('ayudas de relleno describen registro sin indicar cantidades, zonas ni protocolos', () => {
  assert.match(fieldHelpSource, /volume_used: 'Sin mapa, registra el volumen documentado para la sesión/);
  assert.match(fieldHelpSource, /follow_up_date: 'Fecha de control registrada para esta sesión/);
  assert.doesNotMatch(fieldHelpSource, /relleno labial suele requerir|Algunos rellenos requieren|Zonas de relleno:/);
});

test('Malla explica sus tres clics y el recuento de líneas coincide con la forma generada', () => {
  assert.match(source, /Tres clics: punto inicial → ancho → largo/);
  assert.match(source, /Haz clic en una esquina inicial/);
  assert.match(source, /líneas por dirección · \{\(haShapeConfig\.gridCells \+ 1\) \* 2\} en total/);
  assert.doesNotMatch(source, /Clic en esquina → arrastrar para definir la diagonal opuesta/);
  assert.match(viewerSource, /ha-grid: flujo de tres clics/);
  assert.match(viewerSource, /if \(gridStep === 0\)[^]*?gridAnchorScreen = clickPt;[^]*?gridStep = 1/);
  assert.match(viewerSource, /else if \(gridStep === 1 && gridAnchorScreen\)[^]*?gridWidthEndScreen = clickPt;[^]*?gridStep = 2/);
  assert.match(viewerSource, /else if \(gridStep === 2 && gridAnchorScreen && gridWidthEndScreen\)[^]*?createScreenGridLayout/);
  assert.match(viewerSource, /screenSurfaceLine\(line\.start, line\.end, 12\)/);
});

test('geometría de Malla conserva ancho, largo, perpendicularidad y divisiones', () => {
  const layout = createScreenGridLayout({ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 120 }, 4);
  assert.equal(layout.lines.length, 10);
  assert.deepEqual(layout.end, { x: 10, y: 120 });
  assert.deepEqual(layout.lines[0], { start: { x: 10, y: 20 }, end: { x: 10, y: 120 } });
  assert.deepEqual(layout.lines[5], { start: { x: 10, y: 20 }, end: { x: 110, y: 20 } });
  assert.equal(createScreenGridLayout({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 30 }, 4), null);
  assert.equal(createScreenGridLayout({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 5 }, 4), null);
});

test('cambiar de herramienta cancela el estado y la previsualización de Malla', () => {
  assert.match(viewerSource, /const resetGridDrawing = \(\) => \{\s*gridStep = 0;\s*gridAnchorScreen = null;\s*gridWidthEndScreen = null;/);
  assert.match(viewerSource, /if \(gridStep > 0 && tool !== 'ha-grid'\) resetGridDrawing\(\)/);
  assert.match(viewerSource, /if \(gridStep > 0 && callbacks\.current\.activeTool !== 'ha-grid'\) resetGridDrawing\(\)/);
  assert.match(viewerSource, /if \(controlsRef\.current\) controlsRef\.current\.enabled = true;\s*callbacks\.current\.onGridStepChange\?\.\(0\)/);
});

test('edición y limpieza de anotaciones del visor se pueden deshacer', () => {
  assert.match(source, /handleFreehandLineUpdated = useCallback\([^]*?\{\s*pushUndo\(\);/);
  assert.match(source, /handleSelectedColor = \(color: string\) => \{\s*if \(!selectedElement\) return;\s*beginSelectedPropertyUndo\(\)/);
  assert.match(source, /handleSelectedThickness = \(thickness: number\) => \{\s*if \(!selectedElement\) return;\s*beginSelectedPropertyUndo\(\)/);
  assert.match(source, /onClick=\{\(\) => \{ pushUndo\(\); setFreehandLines\(\[\]\); setSurfaceShapes\(\[\]\); setSelectedElement\(null\); \}\}/);
  assert.match(source, /referenceLines: referenceLinesRef\.current/);
  assert.match(source, /setReferenceLines\(last\.referenceLines\)/);
});

test('editar puntos sin zona comienza por cantidad y recupera la técnica del punto', () => {
  for (const product_type of ['toxina', 'relleno']) {
    const changes = {};
    const setters = ['setSelectedPointId', 'setUnitsModal', 'setUnitsModalInput', 'setUnitsModalTercio',
      'setUnitsModalZone', 'setUnitsModalPlane', 'setUnitsModalTecnica', 'setUnitsModalZoneFilter', 'setUnitsModalStep'];
    const environment = {
      current: { product_type }, editablePoints: [point('qa')],
      injectionPoints: [{ editablePointId: 'qa', units: 0.3, label: '', tercio: 'medio', technique_at_point: 'Puntual' }],
      tercioBoundaries: null,
      ...Object.fromEntries(setters.map(name => [name, value => { changes[name] = value; }])),
    };
    loadFunction('handleEditablePointClicked', environment)('qa');
    assert.equal(changes.setUnitsModalStep, 1);
    assert.equal(changes.setUnitsModalInput, '0.3');
    assert.equal(changes.setUnitsModalTecnica, 'Puntual');
    assert.equal(changes.setUnitsModal.isNewPoint, false);
  }
});

test('guardar solamente cantidad conserva zona, técnica, aguja, plano y vial en todos los modos', () => {
  for (const [product_type, relleno_subtype] of [
    ['toxina', undefined], ['relleno', 'relleno_ha'], ['relleno', 'hidratacion'], ['relleno', 'bioestimulador'],
  ]) {
    const original = {
      ...applied('qa'), technique_at_point: 'Puntual', needle_at_point: 'QA',
      injection_plane: 'Medio', vial_id: 'vial-qa', notes_at_point: 'Anotación QA', tercio: 'medio',
    };
    let updated;
    const environment = {
      current: { product_type, relleno_subtype }, unitsModal: { pointId: 'qa', isNewPoint: false },
      unitsModalInput: '0.35', unitsModalTercio: '', unitsModalZone: '', unitsModalPlane: '',
      unitsModalTecnica: '', injectionPoints: [original], editablePoints: [point('qa')], markers3D: [],
      pushUndo() {}, setToxinaUnitsFromMap() {},
      setInjectionPoints: fn => { updated = fn([original])[0]; },
      ...Object.fromEntries(['setUnitsModal', 'setUnitsModalInput', 'setUnitsModalStep', 'setUnitsModalTercio',
        'setUnitsModalZone', 'setUnitsModalZoneFilter', 'setUnitsModalPlane', 'setUnitsModalTecnica',
        'setSelectedPointId'].map(name => [name, () => {}])),
    };
    loadFunction('handleUnitsModalConfirm', environment)();
    assert.equal(updated.units, 0.35);
    for (const key of ['label', 'tercio', 'technique_at_point', 'needle_at_point', 'injection_plane', 'vial_id', 'notes_at_point']) {
      assert.equal(updated[key], original[key], `${product_type}/${relleno_subtype}: ${key}`);
    }
  }
});

test('cantidad inválida mantiene el modal, muestra error y devuelve foco al campo', () => {
  for (const input of ['', '0', '-1', 'Infinity', 'NaN']) {
    let error;
    let focused = false;
    const environment = {
      unitsModal: { pointId: 'qa' }, unitsModalInput: input,
      setPointAmountError: value => { error = value; },
      setUnitsModalStep: step => { assert.equal(step, 1); },
      pointAmountRef: { current: { focus() { focused = true; } } },
    };
    loadFunction('handleUnitsModalConfirm', environment)();
    assert.match(error, /mayor que cero/);
    assert.equal(focused, true);
  }
});

test('Enter tiene un único submit y clasificar no envía el formulario', () => {
  let form;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'form'
      && node.getText(ast).includes('injectable-point-volume')) form = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(form);
  assert.match(form.getText(ast), /onSubmit=\{event => \{ event\.preventDefault\(\); handleUnitsModalConfirm\(\); \}\}/);
  assert.doesNotMatch(form.getText(ast), /onKeyDown=[^\n]*handleUnitsModalConfirm/);
  let submitButtons = 0;
  function checkButtons(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button') {
      const type = node.openingElement.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === 'type');
      assert.ok(type, 'Cada botón del modal debe declarar type');
      if (type.initializer.text === 'submit') submitButtons++;
    }
    ts.forEachChild(node, checkButtons);
  }
  checkButtons(form);
  assert.equal(submitButtons, 1);
  assert.match(source, /pointAmountRef\.current\?\.focus\(\);\s*pointAmountRef\.current\?\.select\(\)/);
});

test('Escape captura el evento y respeta los diálogos abiertos', () => {
  const changes = {};
  const setters = ['setActiveTool', 'setPointMode', 'setActiveLineType', 'setPendingLineMeta',
    'setFirstLineAnchor', 'setTwoPointStep', 'setSelectedElement', 'setHoveredPointId', 'setSnapPoint',
    'setGridDrawStep', 'setGridDrawMessage', 'setShowShapesDropdown', 'setShowHaShapesDropdown',
    'setShowVisibilityDropdown', 'setBulkApplyMode', 'setBulkApplySelected'];
  let dialogOpen = false;
  let focusOptions;
  const environment = {
    show3D: true, document: { querySelector: () => dialogOpen },
    visibilityPopupRef: { current: { contains: () => true } },
    visibilityPanelRef: { current: { querySelector: () => ({ focus: options => { focusOptions = options; } }) } },
    ...Object.fromEntries(setters.map(name => [name, value => { changes[name] = value; }])),
  };
  const handler = loadFunction('onKeyDown', environment);
  handler({ key: 'Escape' });
  assert.equal(changes.setActiveTool, 'none');
  assert.equal(changes.setPointMode, 'none');
  assert.equal(changes.setSelectedElement, null);
  assert.equal(changes.setSnapPoint, null);
  assert.equal(changes.setGridDrawStep, 0);
  assert.equal(focusOptions.preventScroll, true);
  for (const key of Object.keys(changes)) delete changes[key];
  dialogOpen = true;
  handler({ key: 'Escape' });
  assert.deepEqual(changes, {});
  assert.match(source, /addEventListener\('keydown', onKeyDown, true\)/);
});

test('cambiar de herramienta descarta borradores de pincel, polilínea, formas y malla', () => {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(viewerAst) === 'syncDrawingTool') declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(viewerAst);
  assert.ok(declaration);
  for (const tool of ['freehand-brush', 'freehand-poly', 'shape-circle', 'shape-rect', 'ha-fan', 'ha-grid', 'ha-fern']) {
    const state = {
      drawingTool: tool, callbacks: { current: { activeTool: 'none' } },
      brushActive: true, brushPoints: [1], polyPoints: [1, 2], polyLastClickTime: 100,
      shapeAnchor: {}, shapeCurrentRadius: 2, shapeCurrentW: 3, shapeCurrentH: 4,
      resetGridDrawing() { state.gridCleared = true; }, clearSnap() { state.snapCleared = true; },
    };
    vm.runInNewContext(`(${declaration.initializer.getText(viewerAst)})()`, state);
    assert.equal(state.brushActive, false);
    assert.equal(state.brushPoints.length, 0);
    assert.equal(state.polyPoints.length, 0);
    assert.equal(state.shapeAnchor, null);
    assert.equal(state.gridCleared, true);
    assert.equal(state.snapCleared, true);
  }
});

test('ampliar usa pantalla completa nativa y comunica rechazos del navegador', async () => {
  const element = { requestFullscreen: async () => { entered = true; } };
  let entered = false;
  let exited = false;
  let message;
  const environment = {
    viewerRef: { current: element }, document: { fullscreenElement: null, exitFullscreen: async () => { exited = true; } },
    setMessage: value => { message = value; }, console: { error() {} },
  };
  const toggle = loadFunction('toggleWorkspaceFullscreen', environment);
  await toggle();
  assert.equal(entered, true);
  environment.document.fullscreenElement = element;
  await toggle();
  assert.equal(exited, true);
  environment.document.fullscreenElement = null;
  element.requestFullscreen = async () => { throw new Error('Bloqueado para QA'); };
  await toggle();
  assert.equal(message.type, 'error');
  assert.match(message.text, /no permitió ampliar/);
});

test('Añadir edita puntos visibles sin duplicarlos ni seleccionar puntos ocultos', () => {
  let branch;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(viewerAst)
      === 'editablePointsGroupRef.current && callbacks.current.onEditablePointClicked && !callbacks.current.readOnly') branch = node;
    ts.forEachChild(node, visit);
  }
  visit(viewerAst);
  assert.ok(branch);
  const code = ts.transpileModule(`globalThis.run = () => { ${branch.getText(viewerAst)} return 'add'; };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const [distance, readOnly, expected] of [[1, false, 'qa'], [2, false, undefined], [1, true, undefined]]) {
    let edited;
    const object = { visible: true, userData: { isEditablePoint: true, editableId: 'qa' } };
    const environment = {
      editablePointsGroupRef: { current: {} },
      faceMeshRef: { current: {} },
      visibleSurfaceHits: loadOcclusionFunction('visibleSurfaceHits'),
      callbacks: { current: { readOnly, occludeAnnotations: true, onEditablePointClicked: id => { edited = id; } } },
      raycaster: {
        intersectObjects: () => [{ distance, object }],
        intersectObject: () => [{ distance: 1 }],
      }, intersect: { distance: 1 },
    };
    const sandbox = vm.createContext(environment);
    vm.runInContext(code, sandbox);
    const result = sandbox.run();
    assert.equal(edited, expected);
    assert.equal(result, expected ? undefined : 'add');
  }
});

test('visor desmontado no se confunde con pantalla completa al salir', () => {
  let fullscreen;
  const environment = {
    document: { fullscreenElement: null }, viewerRef: { current: null },
    setWorkspaceFullscreen: value => { fullscreen = value; },
  };
  const update = loadFunction('updateFullscreen', environment);
  update();
  assert.equal(fullscreen, false);
  environment.viewerRef.current = {};
  environment.document.fullscreenElement = environment.viewerRef.current;
  update();
  assert.equal(fullscreen, true);
  environment.document.fullscreenElement = null;
  update();
  assert.equal(fullscreen, false);
});
