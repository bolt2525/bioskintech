import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/admin/ficha-clinica/components/tabs/InjectablesTab.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('InjectablesTab.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

test('ayuda contextual distingue navegar, añadir, eliminar y dibujar', () => {
  const expression = jsxAttribute('interactionHint', 'Clinical3DViewer');
  for (const [tool, mode, expected] of [
    ['none', 'none', 'Arrastra para rotar'],
    ['none', 'add', 'Clic para añadir punto'],
    ['none', 'delete', 'Clic para eliminar punto'],
    ['freehand-brush', 'none', 'Dibujo activo'],
    ['shape-circle', 'none', 'Dibujo activo'],
    ['ha-grid', 'none', 'Dibujo activo'],
  ]) {
    assert.ok(vm.runInNewContext(expression, { activeTool: tool, pointMode: mode }).startsWith(expected));
  }
});

test('los nuevos trazos usan el token dorado sin recolorear el historial', () => {
  assert.match(source, /useState<string>\(COLORS\.gold\)/);
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
    const names = ['setInjectionPoints', 'setMarkers3D', 'setReferenceLines', 'setEditablePoints',
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
vm.runInNewContext(ts.transpileModule(formSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: formExports, require: createRequire(import.meta.url), Intl });

test('formulario renderiza campos históricos, errores asociados y plegables nativos', () => {
  const html = renderToStaticMarkup(formExports.default({
    value: {
      date: '2026-10-10', product_name: 'QA', brand: 'Marca QA', lot_number: 'LOTE-QA', expiration_date: '',
      units_used: 20, dilution_volume: 2.5, technique: 'Técnica histórica', injection_plane: 'Plano histórico',
      needle_type: 'Aguja histórica', follow_up_date: '', notes: 'Nota QA',
    },
    onChange: () => {}, brands: [], needles: [], dateLocked: false, onUnlockDate: () => {},
    vialUnits: '100', onVialUnitsChange: () => {}, concentration: 40, mappedUnits: 2,
    error: { field: 'units_used', text: 'Revisar total' },
  }));
  assert.match(html, /Técnica histórica/);
  assert.match(html, /Plano histórico/);
  assert.match(html, /Nota QA/);
  assert.match(html, /40 U\/ml/);
  assert.match(html, /aria-describedby="toxina-units-note toxina-units_used-error"/);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]*\sopen[=> ]/);
});

test('usar suma del mapa requiere acción explícita y no cambia dosis por punto', () => {
  let patch = null;
  const tree = formExports.default({
    value: {
      date: '', product_name: '', brand: '', lot_number: '', expiration_date: '', units_used: '',
      dilution_volume: '', technique: '', injection_plane: '', needle_type: '', follow_up_date: '', notes: '',
    },
    onChange: value => { patch = value; }, brands: [], needles: [], dateLocked: false,
    onUnlockDate: () => {}, vialUnits: '', onVialUnitsChange: () => {},
    concentration: null, mappedUnits: 7.5, error: null,
  });
  let action;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes('Usar ')) action = node.props.onClick;
    const children = node.props?.children;
    if (Array.isArray(children)) children.forEach(visit);
    else visit(children);
  }
  visit(tree);
  assert.equal(patch, null);
  assert.ok(action);
  action();
  assert.equal(patch.units_used, 7.5);
  assert.deepEqual(Object.keys(patch), ['units_used']);
});
