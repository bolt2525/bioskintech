import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const simulation = {};
vm.runInNewContext(compile(readFileSync(new URL('../src/lab/faceSim/simulation.ts', import.meta.url), 'utf8')), {
  exports: simulation, require: () => ({ default: atlas }),
});
const source = readFileSync(new URL('../src/lab/faceSim/FacialSimulationViewer.tsx', import.meta.url), 'utf8');
const skin = await import('../src/lab/faceSim/skinAppearance.ts');
const reveal = await import('../src/lab/faceSim/maskAnatomy.ts');
const displaySurface = await import('../src/lab/faceSim/displaySurface.ts');
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(child => find(child, predicate))
  : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
const displayAPI = {};
const defaultLayers = {};
vm.runInNewContext(compile(readFileSync(new URL('../src/lab/faceSim/defaultLayers.ts', import.meta.url), 'utf8')), {
  exports: defaultLayers, require: () => ({}),
});
vm.runInNewContext(compile(readFileSync(new URL('../src/lab/faceSim/anatomyDisplay.tsx', import.meta.url), 'utf8')), {
  exports: displayAPI, require: name => name === './defaultLayers' ? { ANATOMY_PLANES: [
    { id: 'skin', label: 'Piel' }, { id: 'muscle', label: 'Músculo' },
    { id: 'vessels', label: 'Vascular' }, { id: 'bone', label: 'Óseo' },
  ] } : require(name),
});
const expandShared = tree => !tree || typeof tree !== 'object' ? tree : Array.isArray(tree) ? tree.map(expandShared)
  : tree.type === displayAPI.AnatomyLayerControls ? expandShared(tree.type(tree.props))
    : { ...tree, props: { ...tree.props, children: expandShared(tree.props?.children) } };

function editor() {
  const states = [];
  let cursor = 0;
  const exports = {};
  vm.runInNewContext(compile(source), {
    exports, console,
    require: name => {
      if (name === 'react') return { ...React, useId: () => 'editor',
        useRef: () => ({ current: null }), useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
        useState(initial) {
          const i = cursor++;
          if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
          return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
        } };
      if (name === './genericFaceAtlas.json') return { default: atlas };
      if (name === './simulation') return simulation;
      if (name === './displaySurface') return displaySurface;
      if (name === './skinAppearance') return skin;
      if (name === './MarkingPanels') return { editorPanel: 'editor-panel' };
      if (name === './skinRegionReview') return {};
      if (name === './maskAnatomy') return reveal;
      if (name === './anatomicalZones') return {};
      if (name === './anatomyDisplay') return displayAPI;
      if (name === './referenceGeometry') return {};
      if (name === './faceRegions') return { buildFaceRegionMap: () => ({}), buildFaceTriangleRegions: () => [] };
      if (name === './regionMesh') return { buildRegionCells: () => [], REGION_PLANES: [] };
      if (name === './estimatedHair') return { DEFAULT_HAIR: { enabled: false } };
      if (name === './defaultLayers') return { ...defaultLayers, ANATOMY_PLANES: [
        { id: 'skin', label: 'Piel' }, { id: 'muscle', label: 'Músculo' }, { id: 'vessels', label: 'Vascular' }, { id: 'bone', label: 'Óseo' },
      ] };
      if (name === './skinSignalTexture' || name.endsWith('/clinicalCamera')) return {};
      if (name.startsWith('three/')) return {};
      return require(name);
    },
  });
  return { render() { cursor = 0; return expandShared(exports.FacialSimulationViewer({})); } };
}

test('editor: un solo retoque de piel; herramientas independientes conservan morfología', () => {
  const app = editor();
  let tree = app.render();
  const controls = label => find(tree, node => node.type === 'button' && text(node) === label);
  const panels = () => find(tree, node => node.props?.id?.startsWith('editor-tool-'));
  assert.equal(find(tree, node => node.type === 'legend' && text(node) === 'Retoque cosmético visual · piel').length, 1);
  assert.equal(panels().filter(node => !node.props.hidden)[0].props.id, 'editor-tool-morphology');
  const nose = find(tree, node => node.props?.id === 'editor-noseTip')[0];
  nose.props.onChange({ target: { value: '0.42' } });
  controls('Piel')[0].props.onClick();
  tree = app.render();
  assert.equal(panels().filter(node => !node.props.hidden)[0].props.id, 'editor-tool-skin');
  controls('Capas')[0].props.onClick();
  tree = app.render();
  assert.equal(panels().filter(node => !node.props.hidden)[0].props.id, 'editor-tool-layers');
  controls('Corte')[0].props.onClick();
  tree = app.render();
  assert.equal(panels().filter(node => !node.props.hidden)[0].props.id, 'editor-tool-cut');
  controls('Morfología')[0].props.onClick();
  tree = app.render();
  assert.equal(find(tree, node => node.props?.id === 'editor-noseTip')[0].props.value, 0.42);
  assert.equal(find(tree, node => node.props?.['data-simulation-viewport'] !== undefined).length, 1);
  assert.match(find(tree, node => node.props?.['data-simulation-inspector'] !== undefined)[0].props.className, /overflow-y-auto/);
});

test('editor: región independiente, navegación explícita y restauración localizada', () => {
  const app = editor();
  let tree = app.render();
  const click = label => find(tree, node => node.type === 'button' && text(node) === label)[0].props.onClick();
  const control = key => find(tree, node => node.props?.id === `editor-${key}`)[0];
  control('noseBridge').props.onChange({ target: { value: '0.5' } });
  click('Desplazar'); tree = app.render();
  assert.equal(find(tree, node => node.type === 'button' && text(node) === 'Desplazar')[0].props['aria-pressed'], true);
  assert.equal(control('noseBridge').props.value, 0.5);
  const region = find(tree, node => node.type === 'legend' && text(node) !== 'Nariz' && /Labios/.test(text(node)))[0];
  assert.ok(region);
  click('Labios'); tree = app.render();
  const morphology = find(tree, node => node.props?.id === 'editor-tool-morphology')[0];
  const fields = find(morphology, node => node.type === 'fieldset');
  assert.equal(fields.filter(node => !node.props.hidden).length, 1);
  assert.equal(text(fields.find(node => !node.props.hidden).props.children[0]), 'Labios');
  control('lipUpper').props.onChange({ target: { value: '0.4' } });
  click('Restablecer labios'); tree = app.render();
  assert.equal(control('lipUpper').props.value, 0);
  assert.equal(control('noseBridge').props.value, 0.5);
  click('Nariz'); tree = app.render();
  click('Restablecer nariz'); tree = app.render();
  assert.equal(control('noseBridge').props.value, 0);
});

test('editor: imágenes independientes, opacidad no forzada y dos modos de corte', () => {
  const app = editor();
  let tree = app.render();
  find(tree, node => node.type === 'button' && text(node) === 'Capas')[0].props.onClick();
  tree = app.render();
  const label = prefix => find(tree, node => node.type === 'label' && text(node).startsWith(prefix))[0];
  const control = (prefix, type) => prefix === 'Opacidad Piel'
    ? find(tree, node => node.props?.['aria-label'] === 'Opacidad: Piel')[0]
    : find(label(prefix), node => node.type === type)[0];
  assert.equal(find(tree, node => node.type === 'button' && text(node) === 'Ver volúmenes genéricos').length, 0);
  assert.doesNotMatch(text(tree), /Grasa genérica|Músculos esquemáticos|Nervios · trayectos/);
  control('Opacidad Piel', 'input').props.onChange({ target: { value: '0.25' } });
  tree = app.render();
  control('Superponer anatomía', 'input').props.onChange({ target: { checked: true } });
  tree = app.render();
  assert.equal(control('Opacidad Piel', 'input').props.value, 0.25);
  assert.equal(control('Superponer anatomía', 'input').props.checked, true);
  find(tree, node => node.type === 'button' && text(node) === 'Corte')[0].props.onClick();
  tree = app.render();
  control('Modo de corte', 'select').props.onChange({ target: { value: 'progressive' } });
  tree = app.render();
  assert.equal(control('Opacidad Piel', 'input').props.value, 1, 'el desvelado parte de una piel íntegra');
  assert.equal(control('Superponer anatomía', 'input').props.checked, false);
  control('Avance desde punta nasal', 'input').props.onChange({ target: { value: '0.75' } });
  tree = app.render();
  assert.match(text(tree), /Músculo → Óseo/);
  control('Modo de corte', 'select').props.onChange({ target: { value: 'compare' } });
  tree = app.render();
  control('Retirar', 'select').props.onChange({ target: { value: 'muscle' } });
  tree = app.render();
  assert.equal(control('Revelar', 'select').props.value, 'bone');
  assert.equal(find(control('Revelar', 'select'), node => node.type === 'option').length, 1);
});

test('corte en profundidad pela piel → músculo → vascular → óseo con capa dominante', () => {
  const start = displayAPI.initialAnatomyDisplay();
  const at = p => displayAPI.depthPeelDisplay(start, p);
  const op = d => [d.skin.opacity, d.references.muscle.opacity, d.references.vessels.opacity, d.references.bone.opacity];
  assert.deepEqual([at(0).anatomy, ...op(at(0))], ['skin', 1, 0, 0, 0]);
  assert.deepEqual([at(1 / 3).anatomy, ...op(at(1 / 3))], ['muscle', 0, 1, 0, 0]);
  assert.deepEqual([at(2 / 3).anatomy, ...op(at(2 / 3))], ['vessels', 0, 0.35, 1, 0]);
  assert.deepEqual([at(1).anatomy, ...op(at(1))], ['bone', 0, 0, 0, 1]);
  const mid = at(1 / 6);
  assert.ok(mid.skin.opacity > 0 && mid.references.muscle.opacity > 0 && mid.references.muscle.visible, 'transición cruzada');
  assert.throws(() => at(Number.NaN));
});

test('recorrido configurable: extremos, reverso, arterias y controles conservan corte espacial', () => {
  const start = displayAPI.initialAnatomyDisplay();
  for (const from of displayAPI.DEPTH_STOPS) for (const to of displayAPI.DEPTH_STOPS) {
    if (from === to) {
      assert.throws(() => displayAPI.depthPeelDisplay(start, 0.5, from, to));
      continue;
    }
    assert.equal(displayAPI.depthPeelDisplay(start, 0, from, to).anatomy, from);
    assert.equal(displayAPI.depthPeelDisplay(start, 1, from, to).anatomy, to);
    const middle = displayAPI.depthPeelDisplay(start, 0.5, from, to);
    assert.ok([middle.skin, ...Object.values(middle.references)].every(layer =>
      layer.opacity >= 0 && layer.opacity <= 1));
  }
  const app = editor();
  let tree = app.render();
  const button = label => find(tree, n => n.type === 'button' && text(n) === label)[0];
  button('Corte').props.onClick(); tree = app.render();
  const label = prefix => find(tree, n => n.type === 'label' && text(n).startsWith(prefix))[0];
  find(label('Aplicar a'), n => n.type === 'select')[0].props.onChange({ target: { value: 'all' } });
  tree = app.render();
  find(label('Posición'), n => n.type === 'input')[0].props.onChange({ target: { value: '0.32' } });
  tree = app.render();
  find(tree, n => n.props?.['aria-label'] === 'Recorrido entre capas')[0].props.onChange({ target: { value: '0.6' } });
  tree = app.render();
  assert.equal(find(label('Aplicar a'), n => n.type === 'select')[0].props.value, 'all');
  assert.equal(find(label('Posición'), n => n.type === 'input')[0].props.value, 0.32);
});
