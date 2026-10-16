import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/ui/Select.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function mountSelect(dialog = null, fullscreenElement = null) {
  const body = {};
  const state = [];
  let cursor = 0;
  let portalParent;
  const trigger = {
    closest: selector => selector === 'dialog' ? dialog : null,
    getBoundingClientRect: () => ({ top: 100, bottom: 144, left: 24, width: 280 }),
  };
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    useRef: () => ({ current: trigger }),
    useEffect() {},
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    document: { body, fullscreenElement },
    require: name => {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return { createPortal: (node, parent) => { portalParent = parent; return node; } };
      return require(name);
    },
  });
  const props = {
    value: 'leve',
    options: [
      { value: 'leve', label: 'Leve' },
      { value: 'moderado', label: 'Moderado' },
      { value: 'severo', label: 'Severo' },
      { value: 'profundo', label: 'Profundo' },
    ],
    onChange: value => { props.value = value; },
  };
  return {
    render() { cursor = 0; return exports.Select(props); },
    props, body, parent: () => portalParent,
  };
}

for (const context of ['modal', 'pantalla completa', 'página']) {
  test(`Select en ${context}: el menú permanece en la capa interactiva y permite elegir severidad`, () => {
    const dialog = context === 'modal' ? {} : null;
    const fullscreen = context === 'pantalla completa' ? {} : null;
    const component = mountSelect(dialog, fullscreen);
    component.render().props.children[0].props.onClick({ stopPropagation() {} });
    const menu = component.render().props.children[1];
    assert.equal(component.parent(), dialog || fullscreen || component.body);
    const options = menu.props.children.props.children[0];
    assert.equal(options.length, 4);
    for (let index = 0; index < options.length; index++) {
      options[index].props.onClick();
      assert.equal(component.props.value, component.props.options[index].value);
      assert.equal(component.render().props.children[1], false);
    }
  });
}

test('Select deshabilitado no abre opciones', () => {
  const component = mountSelect({});
  component.props.disabled = true;
  component.render().props.children[0].props.onClick({ stopPropagation() {} });
  assert.equal(component.render().props.children[1], false);
  assert.equal(component.parent(), undefined);
});

test('Select prioriza el diálogo sobre el contenedor de pantalla completa', () => {
  const dialog = {};
  const component = mountSelect(dialog, {});
  component.render().props.children[0].props.onClick({ stopPropagation() {} });
  component.render();
  assert.equal(component.parent(), dialog);
});
