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
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : String(tree ?? '');
const find = (tree, predicate) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(child => find(child, predicate))
  : [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];

function editor() {
  const states = [];
  let cursor = 0;
  const exports = {};
  vm.runInNewContext(compile(source), {
    exports, console,
    require: name => {
      if (name === 'react') return { ...React, useId: () => 'editor',
        useRef: () => ({ current: null }), useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn(),
        useState(initial) {
          const i = cursor++;
          if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
          return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
        } };
      if (name === './genericFaceAtlas.json') return { default: atlas };
      if (name === './simulation') return simulation;
      if (name === './skinAppearance') return skin;
      if (name === './maskAnatomy') return reveal;
      if (name === './anatomicalZones') return {};
      if (name === './faceRegions') return { buildFaceRegionMap: () => ({}), buildFaceTriangleRegions: () => [] };
      if (name === './regionMesh') return { buildRegionCells: () => [], REGION_PLANES: [] };
      if (name === './estimatedHair') return { DEFAULT_HAIR: { enabled: false } };
      if (name === './defaultLayers') return { ANATOMY_PLANES: [
        { id: 'skin', label: 'Piel' }, { id: 'muscle', label: 'Músculo' }, { id: 'vessels', label: 'Vascular' }, { id: 'bone', label: 'Óseo' },
      ] };
      if (name === './skinSignalTexture' || name.endsWith('/clinicalCamera')) return {};
      if (name.startsWith('three/')) return {};
      return require(name);
    },
  });
  return { render() { cursor = 0; return exports.FacialSimulationViewer({}); } };
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

test('editor: imágenes independientes, opacidad no forzada y dos modos de corte', () => {
  const app = editor();
  let tree = app.render();
  const label = prefix => find(tree, node => node.type === 'label' && text(node).startsWith(prefix))[0];
  const control = (prefix, type) => prefix === 'Opacidad Piel'
    ? find(tree, node => node.props?.['aria-label'] === 'Opacidad: Piel')[0]
    : find(label(prefix), node => node.type === type)[0];
  assert.equal(find(tree, node => node.type === 'button' && text(node) === 'Ver volúmenes genéricos').length, 0);
  assert.doesNotMatch(text(tree), /Grasa genérica|Músculos esquemáticos|Nervios · trayectos/);
  control('Opacidad Piel', 'input').props.onChange({ target: { value: '0.25' } });
  control('Superponer anatomía', 'input').props.onChange({ target: { checked: true } });
  tree = app.render();
  assert.equal(control('Opacidad Piel', 'input').props.value, 0.25);
  assert.equal(control('Superponer anatomía', 'input').props.checked, true);
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
