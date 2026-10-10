import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
