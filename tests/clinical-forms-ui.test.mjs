import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';

const require = createRequire(import.meta.url);
const directory = '../src/components/admin/ficha-clinica/components/';
const item = {
  medicamento: 'Principio QA', nombre_comercial: 'Producto QA', presentacion: 'Crema',
  dosis: 'Dosis QA', cantidad: '1', frecuencia: 'Frecuencia QA', via: 'Vía QA',
  duracion: 'Duración QA', turno: '', indicaciones: 'Indicaciones QA', rutina: 'mañana',
};

function findAll(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => findAll(child, predicate));
  const children = tree.props?.children;
  return [
    ...(predicate(tree) ? [tree] : []),
    ...(Array.isArray(children) ? children : [children]).flatMap(child => findAll(child, predicate)),
  ];
}

function loadComponent(file, mocks = {}, dialog = null) {
  const source = readFileSync(new URL(directory + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const state = [];
  let cursor = 0;
  let focused = false;
  let portalParent = null;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    useEffect() {},
    useId: () => 'qa-select',
    useRef: () => ({ current: { focus() { focused = true; }, closest: () => dialog, getBoundingClientRect: () => ({ top: 100, bottom: 144, left: 20, width: 300 }) } }),
  };
  const exports = {};
  const sandbox = {
    exports, console, Date, setTimeout, clearTimeout, Response,
    window: { innerHeight: 800 },
    document: { body: {}, getElementById: () => ({ scrollIntoView() {} }) },
    require: name => {
      if (name in mocks) return mocks[name];
      if (name === 'react') return hooks;
      if (name === 'react-dom') return { createPortal: (node, parent) => { portalParent = parent; return node; } };
      return require(name);
    },
  };
  vm.runInNewContext(code, sandbox);
  return {
    render: props => { cursor = 0; return exports.default(props); },
    focused: () => focused,
    portalParent: () => portalParent,
  };
}

test('selector dorado: apertura, flechas, Inicio/Fin, selección, Escape y foco', () => {
  const component = loadComponent('ClinicalSelect.tsx');
  const props = {
    label: 'Paquete', value: '', options: [
      { value: '', label: 'Independiente' }, { value: '1', label: 'Paquete QA' }, { value: '2', label: 'Otro paquete' },
    ],
    onChange: value => { props.value = value; },
  };
  const trigger = () => findAll(component.render(props), node => node.props?.role === 'combobox')[0];
  const key = key => trigger().props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
  trigger().props.onClick();
  assert.equal(trigger().props['aria-expanded'], true);
  const options = findAll(component.render(props), node => node.props?.role === 'option');
  assert.equal(options.length, 3);
  assert.match(options[0].props.className, /bg-gold\/15/);
  key('ArrowDown');
  key('Enter');
  assert.equal(props.value, '1');
  assert.equal(trigger().props['aria-expanded'], false);
  assert.equal(component.focused(), true);
  key('End');
  key('Enter');
  assert.equal(props.value, '2');
  key('Home');
  key('Enter');
  assert.equal(props.value, '');
  key('ArrowUp');
  key('Escape');
  assert.equal(trigger().props['aria-expanded'], false);
});

test('selector en modal: el portal permanece en la capa superior del dialog', () => {
  const dialog = {};
  const component = loadComponent('ClinicalSelect.tsx', {}, dialog);
  const props = { label: 'Tipo de tratamiento', value: '', options: [{ value: '', label: 'Manual' }], onChange() {} };
  findAll(component.render(props), node => node.props?.role === 'combobox')[0].props.onClick();
  component.render(props);
  assert.equal(component.portalParent(), dialog);
});

function prescriptionForm(prescriptions = []) {
  const Select = () => null;
  const component = loadComponent('tabs/PrescriptionTab.tsx', {
    '../../../../../utils/recordsFetch': { default: async () => new Response(JSON.stringify({ ...prescriptions[0], items: [item] })) },
    '../../../../../utils/escapeHtml.js': { escapeHtml: value => value, safeImageSrc: value => value },
    'framer-motion': { motion: { div: 'div', button: 'button' }, AnimatePresence: React.Fragment },
    '../CrossConsultHistoryModal': { default: () => null },
    '../data/prescription_options.json': { default: { medications: [], presentations: [], doses: [], frequencies: [], routes: [], durations: [] } },
    '../../../../ui/Tooltip': { Tooltip: () => null },
    '../../../../../hooks/useClinicSettings': { useClinicSettings: () => ({ settings: { general: {} } }) },
    '../../../../../context/AuthContext': { useAuth: () => ({ user: null }) },
    '../FieldHelp': { default: () => null },
    '../ClinicalSelect': { default: Select },
    '../../data/fieldHelpTexts': { HELP: { prescription: {} } },
    '../../../../ui/Dialog': { Dialog: () => null },
  });
  const props = { recordId: 1, consultationId: 1, patientName: 'Paciente ficticio', initialPrescriptions: prescriptions };
  return { render: () => component.render(props), Select };
}

test('guía: exactamente tres campos por producto; receta recupera campos sin borrar datos', async () => {
  const form = prescriptionForm([{ id: 1, consultation_id: 1, mode: 'routine', fecha: '2026-10-13', diagnostico: 'QA', items: [item] }]);
  const history = findAll(form.render(), node => node.type === 'button' && node.props.className?.includes('w-full text-left'));
  await history[0].props.onClick();
  const fields = () => findAll(form.render(), node => node.type === 'input' || node.type === 'textarea' || node.type === form.Select);
  const productFields = fields().filter(node => node.props.id?.startsWith('product-'));
  assert.equal(productFields.length, 3);
  assert.equal(productFields[0].props.value, 'Producto QA');
  assert.equal(productFields[1].props.value, 'mañana');
  assert.equal(productFields[2].props.value, 'Indicaciones QA');
  const medicalMode = findAll(form.render(), node => node.type === 'button' && node.props.children?.[1] === ' Receta médica')[0];
  assert.ok(medicalMode);
  medicalMode.props.onClick();
  assert.ok(fields().some(node => node.props.value === 'Principio QA'));
  assert.ok(fields().some(node => node.props.value === 'Dosis QA'));
  const guideMode = findAll(form.render(), node => node.type === 'button' && node.props.children?.[1] === ' Guía domiciliaria')[0];
  guideMode.props.onClick();
  assert.equal(fields().find(node => node.props.id === 'product-name-0').props.value, 'Producto QA');
  assert.equal(fields().find(node => node.props.id === 'product-instructions-0').props.value, 'Indicaciones QA');
});

test('historial: filtra guías/recetas y reconoce el modo legacy prescription_mode', () => {
  const form = prescriptionForm([
    { id: 1, consultation_id: 1, fecha: '2026-10-13', prescription_mode: 'routine', items: [item] },
    { id: 2, consultation_id: 1, fecha: '2026-10-12', mode: 'prescription', items: [item] },
    { id: 3, consultation_id: 2, fecha: '2026-10-11', mode: 'routine', items: [item] },
  ]);
  const cards = () => findAll(form.render(), node => node.type === 'button' && node.props.className?.includes('w-full text-left'));
  assert.equal(cards().length, 2);
  const group = findAll(form.render(), node => node.props['aria-label'] === 'Filtrar historial por documento')[0];
  group.props.children[1].props.onClick();
  assert.equal(cards().length, 1);
  assert.ok(findAll(cards()[0], node => node.type?.name === 'PrescriptionModeBadge' && node.props.mode === 'routine').length);
  group.props.children[2].props.onClick();
  assert.equal(cards().length, 1);
  assert.ok(findAll(cards()[0], node => node.type?.name === 'PrescriptionModeBadge' && node.props.mode === 'prescription').length);
  const crossHistory = findAll(form.render(), node => node.props.tabLabel === 'Recetas y guías')[0];
  for (const mode of ['routine', 'prescription']) {
    const document = { mode, items: [item] };
    for (const render of [crossHistory.props.renderItem, crossHistory.props.renderDetail]) {
      assert.ok(findAll(render(document), node => node.type?.name === 'PrescriptionModeBadge' && node.props.mode === mode).length);
    }
  }
});
