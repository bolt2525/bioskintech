import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const modes = {
  toxina: { label: 'Toxina', unit: 'U', color: '#aabbcc' },
  relleno_ha: { label: 'Relleno HA', unit: 'ml', color: '#bbccdd' },
  hidratacion: { label: 'Hidratación', unit: 'ml', color: '#ccddee' },
  bioestimulador: { label: 'Bioestimulador', unit: 'ml', color: '#ddeeff' },
};
const sources = Object.fromEntries(['markingModel.ts', 'MarkingPanels.tsx'].map(file => [file,
  ts.transpileModule(readFileSync(new URL(`../src/lab/faceSim/${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText]));
const model = {};
vm.runInNewContext(sources['markingModel.ts'], { exports: model, require: () => ({
  addressPlacement: () => ({ zone: 'Mejilla', third: 'medio', side: 'derecho' }),
}) });

const find = (tree, predicate) => Array.isArray(tree) ? tree.flatMap(node => find(node, predicate))
  : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const labeled = (tree, label) => find(tree, node => node.props?.['aria-label'] === label)[0];
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label)[0];
const change = (node, value) => node.props.onChange({ target: { value, checked: value } });
const submit = tree => find(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });

// Harness de hooks como los tests existentes: ejecuta handlers reales y efectos de apertura.
function mount(name, initialProps) {
  const slots = [], effects = [];
  let cursor = 0, dirty = false, props = initialProps;
  const dialog = { open: false, shows: 0, showModal() { this.open = true; this.shows++; }, close() { this.open = false; } };
  const api = {};
  const hooks = { ...React,
    useId: () => 'marking-panel-test',
    useMemo: fn => fn(),
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => {
        const value = typeof next === 'function' ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        slots[index] = deps;
        effects.push(effect);
      }
    },
  };
  vm.runInNewContext(sources['MarkingPanels.tsx'], {
    exports: api,
    require: name => name === 'react' ? hooks
      : name === './engine' ? { SIM_MODES: modes }
        : name === './markingModel' ? model
          : name === '../../constants/theme' ? { COLORS: { gold: '#ddbb88' } }
            : name === './injectablePreview' ? { MAX_LEVEL: 2, PREVIEW_DESCRIPTIONS: {}, PREVIEW_FILTERS: {} }
              : require(name),
  });
  const expand = tree => Array.isArray(tree) ? tree.map(expand) : !tree || typeof tree !== 'object' ? tree
    : typeof tree.type === 'function' ? expand(tree.type(tree.props))
      : { ...tree, props: { ...tree.props, children: expand(tree.props?.children) } };
  return {
    dialog,
    render(next) {
      if (next) props = { ...props, ...next };
      let tree;
      do {
        dirty = false; cursor = 0;
        tree = expand(api[name](props));
        for (const node of find(tree, node => node.type === 'dialog')) node.ref.current = dialog;
        effects.splice(0).forEach(effect => effect());
      } while (dirty);
      return tree;
    },
  };
}

const row = (id, index, extra = {}) => ({ id, index, mode: 'toxina', product: 'Vial A', dose: 4, plane: 'Intramuscular',
  zone: 'Mejilla', third: 'medio', side: 'derecho', kind: 'point', extended: false, entry: false, label: 'Punto', tips: 0, ...extra });
const rows = [
  row('fan', 1, { kind: 'pattern', entry: true, dose: 0, plane: '', tips: 2, label: 'Abanico' }),
  row('t1', 2, { parent: 'fan', label: 'Punta 1' }),
  row('t2', 3, { parent: 'fan', label: 'Punta 2', plane: 'Subcutáneo', dose: 2 }),
  row('loose', 4, { product: 'Vial B', zone: 'Frente' }),
  row('graphic', 5, { graphicOnly: true, annotationKind: 'text', annotationText: 'Referencia' }),
];
const ledgerProps = { rows, selectedId: null, onSelect() {}, onHover() {}, onDose() {}, onDelete() {}, onPlane() {} };
const dialogProps = { open: true, mode: 'toxina', count: 2, place: 'Mejilla', initialDose: 4,
  technique: 'Abanico', targets: [{ id: 'a', label: 'Punta 1' }, { id: 'b', label: 'Punta 2' }],
  allowWithoutPoints: true, onSave() {}, onDiscard() {} };

test('gráficos: ledger deriva campos, elimina dosis/plano y no suma ni queda pendiente', () => {
  const graphic = { mode: 'toxina', dose: 99, plane: 'Intramuscular', zone: 'Manual', graphicOnly: true,
    strokeColor: '#123456', strokeWidth: 3, annotationText: 'Nota', annotationKind: 'text', entry: true };
  const result = model.ledgerRows({ g: graphic, p: { ...graphic, graphicOnly: false, entry: false, dose: 4 } },
    { g: { kind: 'free', paths: [] } }, ['g', 'p']);
  const g = result[0];
  assert.deepEqual([g.graphicOnly, g.dose, g.plane, g.entry, g.strokeColor, g.strokeWidth, g.annotationText, g.annotationKind],
    [true, 0, '', false, '#123456', 3, 'Nota', 'text']);
  assert.deepEqual(Array.from(model.volumeTotals(result), t => [t.total, t.points, t.pending]), [[4, 1, 0]]);
  assert.equal(model.volumeTotals([g]).length, 0);
  for (const volume of ['with', 'without']) assert.equal(model.filterRows([g], { ...model.ALL_ROWS, volume }).length, 0);
  assert.equal(model.filterRows([g], model.ALL_ROWS).length, 1);
});

test('contornos históricos circle/rect son gráficos siempre y no mutan las dosis de Meta', () => {
  const meta = {
    circle: { mode: 'toxina', dose: 12, plane: 'Intramuscular', zone: 'Manual', graphicOnly: false },
    rect: { mode: 'relleno_ha', dose: 0.5, plane: 'Subcutáneo', zone: 'Manual' },
  };
  const result = model.ledgerRows(meta, {
    circle: { kind: 'circle', paths: [] }, rect: { kind: 'rect', paths: [] },
  });
  assert.deepEqual(Array.from(result, r => [r.kind, r.graphicOnly, r.dose, r.plane]),
    [['circle', true, 0, ''], ['rect', true, 0, '']]);
  assert.equal(model.volumeTotals(result).length, 0);
  assert.equal(meta.circle.dose, 12);
  assert.equal(meta.rect.dose, 0.5);
  assert.equal(meta.circle.plane, 'Intramuscular');
  for (const r of result) {
    const ui = mount('SelectionInspector', { row: r, onDose() { assert.fail('Contorno con dosis'); }, onDelete() {}, onMirror() {} });
    assert.equal(labeled(ui.render(), 'Volúmenes rápidos'), undefined);
  }
});

test('HUD: selección explícita de categoría/vial para nuevas marcas, con estado Activo', () => {
  const calls = [];
  const totals = [
    { key: 'a', mode: 'toxina', product: 'Vial A', total: 4, points: 1, pending: 0 },
    { key: 'b', mode: 'relleno_ha', product: 'Vial A', total: 0.1, points: 1, pending: 0 },
  ];
  const ui = mount('VolumeHud', { totals, activeMode: 'toxina', activeProduct: 'Vial A', onSelect: (...args) => calls.push(args) });
  const tree = ui.render(), buttons = find(tree, n => n.type === 'button');
  assert.deepEqual(buttons.map(b => b.props['aria-pressed']), [true, false]);
  assert.match(text(buttons[0]), /Activo/);
  assert.match(buttons[1].props.title, /solo para nuevas marcas/);
  buttons[1].props.onClick();
  assert.deepEqual(calls, [['relleno_ha', 'Vial A']]);
  assert.equal(find(ui.render({ onSelect: undefined }), n => n.type === 'button').length, 0);
});

test('listado: agrupado por vial, patrón plegable, una li por fila y plano en puntas', () => {
  const selected = [];
  const ui = mount('PointLedger', { ...ledgerProps, onSelect: r => selected.push(r.id) });
  let tree = ui.render();
  assert.equal(find(tree, n => n.type === 'li').length, rows.length);
  assert.equal(find(tree, n => n.type === 'ul' && n.props.hidden === true).length, 1);
  assert.equal(find(tree, n => n.type === 'ul' && n.props.hidden === true && find(n, x => x.type === 'li').length === 2).length, 1);
  assert.equal(find(tree, n => n.type === 'ul' && n.props.hidden === true && labeled(n, 'Seleccionar marca 1')).length, 0);
  assert.equal(find(tree, n => n.type === 'h3').length, 2);
  assert.equal(find(tree, n => n.type === 'li' && find(n, x => typeof x.type === 'string' && /^h[1-6]$/.test(x.type)).length > 0).length, 0);
  assert.equal(find(tree, n => n.props?.['aria-label']?.startsWith('Seleccionar marca ')).length, rows.length);
  assert.equal(find(tree, n => n.type === 'li' && /Plano: Subcutáneo/.test(text(n))).length, 1);
  assert.equal(labeled(tree, 'Dosis marca 5'), undefined);
  labeled(tree, 'Seleccionar marca 2').props.onClick();
  assert.deepEqual(selected, ['t1']);
  const html = renderToStaticMarkup(tree);
  assert.equal((html.match(/<li\b/g) ?? []).length, rows.length);
  assert.match(html, /hidden=""/);
  find(tree, n => n.type === 'button' && n.props['aria-expanded'] === false)[0].props.onClick();
  tree = ui.render();
  assert.equal(find(tree, n => n.type === 'ul' && n.props.hidden === true).length, 0);
  assert.equal(find(tree, n => n.type === 'li').length, rows.length);
});

test('listado: selección no expande inspector; edición explícita conserva lista y filtros', () => {
  const inspector = React.createElement('div', { 'data-selection-editor': true }, 'Inspector');
  const ui = mount('PointLedger', { ...ledgerProps, selectedId: rows[0].id, header: inspector });
  let tree = ui.render();
  const editorPane = () => find(tree, node => node.type === 'div' && find(node, n => n.props?.['data-selection-editor']).length
    && node.props.hidden !== undefined)[0];
  assert.equal(button(tree, 'Listado').props['aria-pressed'], true);
  assert.equal(editorPane().props.hidden, true);
  assert.equal(find(tree, node => node.type === 'details' && text(node).startsWith('Filtros de zona'))[0].props.open, undefined);
  change(labeled(tree, 'Filtrar por zona'), rows[0].zone); tree = ui.render();
  button(tree, 'Editar selección').props.onClick(); tree = ui.render();
  assert.equal(editorPane().props.hidden, false);
  assert.equal(find(tree, node => node.props?.['data-active'] === false)[0].props.hidden, true);
  button(tree, 'Listado').props.onClick(); tree = ui.render();
  assert.equal(labeled(tree, 'Filtrar por zona').props.value, rows[0].zone);
  assert.equal(editorPane().props.hidden, true);
  assert.equal(labeled(tree, 'Elementos marcados').props.className.includes('flex-1'), true);
});

test('lote: vacío no aplica a visibles; seleccionar entrada incluye puntas sin gráficos ni duplicados', () => {
  const applied = [], ui = mount('PointLedger', { ...ledgerProps, onPlane: (...args) => applied.push(args) });
  let tree = ui.render();
  let apply = find(tree, n => n.type === 'button' && text(n).startsWith('Aplicar plano'))[0];
  assert.equal(apply.props.disabled, true);
  apply.props.onClick();
  assert.equal(applied.length, 0);
  change(labeled(tree, 'Incluir marca 1 en lote'), true);
  tree = ui.render();
  change(labeled(tree, 'Incluir marca 2 en lote'), true);
  change(labeled(tree, 'Plano para el lote'), 'Subcutáneo');
  tree = ui.render();
  button(tree, 'Aplicar plano a 2 punto(s)').props.onClick();
  assert.deepEqual(Array.from(applied[0][0]), ['t1', 't2']);
  assert.equal(applied[0][1], 'Subcutáneo');
  button(tree, 'Deseleccionar todo').props.onClick();
  tree = ui.render();
  assert.equal(button(tree, 'Aplicar plano a 0 punto(s)').props.disabled, true);
  change(labeled(tree, 'Incluir marca 5 en lote'), true);
  assert.equal(button(ui.render(), 'Aplicar plano a 0 punto(s)').props.disabled, true);
});

test('lote: selección de visibles respeta filtros, todo registro incluye ocultas y deseleccionar limpia', () => {
  const applied = [], ui = mount('PointLedger', { ...ledgerProps, onPlane: ids => applied.push(Array.from(ids)) });
  let tree = ui.render();
  change(labeled(tree, 'Filtrar por zona'), 'Frente');
  tree = ui.render();
  change(labeled(tree, 'Seleccionar todos los puntos visibles'), true);
  tree = ui.render();
  button(tree, 'Aplicar plano a 1 punto(s)').props.onClick();
  assert.deepEqual(applied.at(-1), ['loose']);
  button(tree, 'Todo el registro').props.onClick();
  tree = ui.render();
  button(tree, 'Aplicar plano a 3 punto(s)').props.onClick();
  assert.deepEqual(applied.at(-1), ['t1', 't2', 'loose']);
  button(tree, 'Deseleccionar todo').props.onClick();
  assert.equal(button(ui.render(), 'Aplicar plano a 0 punto(s)').props.disabled, true);
});

test('diálogo: checkbox por defecto, sin registro deshabilita fieldset y guarda sin dosis/plano', () => {
  const saved = [], ui = mount('VolumeDialog', { ...dialogProps, initialDose: 0, onSave: (...args) => saved.push(args) });
  let tree = ui.render();
  const checkbox = () => find(tree, n => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.equal(checkbox().props.checked, true);
  assert.equal(button(tree, 'Guardar').props.disabled, true);
  change(checkbox(), false);
  tree = ui.render();
  assert.equal(find(tree, n => n.type === 'fieldset')[0].props.disabled, true);
  assert.equal(button(tree, 'Guardar').props.disabled, false);
  submit(tree);
  assert.deepEqual(saved, [[0, '', undefined, false]]);
});

test('diálogo: no reset al cambiar initialDose abierto; conserva dosis, plano e individuales', () => {
  const saved = [], ui = mount('VolumeDialog', { ...dialogProps, onSave: (...args) => saved.push(args) });
  let tree = ui.render();
  change(labeled(tree, 'Volumen por punto (U)'), '5');
  change(labeled(tree, 'Plano de aplicación'), 'Subcutáneo');
  tree = ui.render();
  button(tree, 'Individual').props.onClick();
  tree = ui.render();
  change(labeled(tree, 'Dosis Punta 1'), '2');
  tree = ui.render({ initialDose: 10, initialWithPoints: false });
  assert.equal(labeled(tree, 'Volumen por punto (U)').props.value, '5');
  assert.equal(labeled(tree, 'Plano de aplicación').props.value, 'Subcutáneo');
  assert.equal(labeled(tree, 'Dosis Punta 1').props.value, '2');
  submit(tree);
  assert.deepEqual([saved[0][0], saved[0][1], { ...saved[0][2] }, saved[0][3]], [5, 'Subcutáneo', { a: 2, b: 5 }, true]);
  assert.equal(ui.dialog.shows, 1);
  ui.render({ open: false });
  tree = ui.render({ open: true, initialDose: 2 });
  assert.equal(ui.dialog.shows, 2);
  assert.equal(labeled(tree, 'Volumen por punto (U)').props.value, '2');
  assert.equal(find(tree, n => n.type === 'fieldset')[0].props.disabled, true);
});

test('diálogo: puntos no ofrecen modo gráfico si allowWithoutPoints no está activo', () => {
  const saved = [], ui = mount('VolumeDialog', { ...dialogProps, allowWithoutPoints: false, initialWithPoints: false, onSave: (...args) => saved.push(args) });
  const tree = ui.render();
  assert.equal(find(tree, n => n.type === 'input' && n.props.type === 'checkbox').length, 0);
  assert.equal(find(tree, n => n.type === 'fieldset')[0].props.disabled, false);
  submit(tree);
  assert.equal(saved[0][3], true);
});

test('inspector: gráficos sin dosis; texto/estilo independientes no cambian transformaciones', () => {
  const styles = [], texts = [], transforms = [];
  const ui = mount('SelectionInspector', { row: rows[4], onDose() { assert.fail('Gráfico con dosis'); },
    onDelete() {}, onMirror() {}, onStyle: s => styles.push(s), onText: t => texts.push(t),
    strokeColor: '#123456', strokeWidth: 3, onTransform: t => transforms.push(t) });
  const tree = ui.render();
  assert.equal(labeled(tree, 'Volúmenes rápidos'), undefined);
  assert.match(text(tree), /sin dosis ni plano/);
  change(find(tree, n => n.type === 'input' && n.props.type === 'text')[0], 'Nota nueva');
  change(labeled(tree, 'Color de la marca'), '#abcdef');
  change(labeled(tree, 'Grosor de la marca'), '4');
  assert.deepEqual(texts, ['Nota nueva']);
  assert.deepEqual(styles.map(s => ({ ...s })), [{ color: '#abcdef' }, { thickness: 4 }]);
  assert.deepEqual(transforms, []);
});

test('inspector: dosis aplicada del punto y dosis común de puntas; mixtas no activan chips', () => {
  const doses = [], ui = mount('SelectionInspector', { row: rows[0], tipDose: 2, onDose: (...args) => doses.push(args), onDelete() {}, onMirror() {} });
  let tree = ui.render();
  const active = () => find(labeled(tree, 'Volúmenes rápidos'), n => n.type === 'button' && n.props['aria-pressed']);
  assert.equal(active().length, 1);
  assert.equal(active()[0].props.title, '2 U');
  active()[0].props.onClick();
  assert.deepEqual(doses, [['fan', 2]]);
  tree = ui.render({ tipDose: null });
  assert.equal(active().length, 0);
  tree = ui.render({ row: rows[1] });
  assert.equal(active()[0].props.title, '4 U');
  assert.match(text(tree), /Dosis aplicada: 4 U/);
});

test('mezclador: cobertura por categoría 0.5–2 y visibilidad conservan ajustes independientes', () => {
  const changes = [], value = { enabled: { toxina: true, relleno_ha: false, hidratacion: false, bioestimulador: false },
    levels: { toxina: 0.75 }, intensity: 0.8, coverage: { toxina: 1.2, relleno_ha: 0.7 }, showCoverage: false };
  const ui = mount('EffectMixer', { value, onChange: next => changes.push(next) });
  let tree = ui.render(), coverage = labeled(tree, 'Cobertura visual Toxina');
  assert.deepEqual([coverage.props.min, coverage.props.max, coverage.props.value, coverage.props.disabled], [0.5, 2, 1.2, false]);
  assert.equal(labeled(tree, 'Cobertura visual Relleno HA').props.disabled, true);
  change(coverage, '1.5');
  assert.equal(changes[0].coverage.toxina, 1.5);
  assert.equal(changes[0].coverage.relleno_ha, 0.7);
  assert.equal(changes[0].levels.toxina, 0.75);
  tree = ui.render({ value: changes[0] });
  const show = find(tree, n => n.type === 'label' && text(n) === 'Mostrar cobertura visual')[0];
  change(find(show, n => n.type === 'input')[0], true);
  assert.equal(changes[1].showCoverage, true);
  assert.equal(changes[1].coverage.toxina, 1.5);
  assert.doesNotMatch(text(tree), /milímetros|efecto clínico/);
});
