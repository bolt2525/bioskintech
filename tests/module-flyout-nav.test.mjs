import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

function load(path, mocks = {}) {
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console,
    require: (id) => (id in mocks ? mocks[id] : require(id)),
  });
  return module.exports;
}

const nav = load('components/layout/moduleNav.ts');
const { getVisibleModules, MODULE_LIST } = load('constants/features.ts', {
  'lucide-react': new Proxy({}, { get: () => () => null }),
});

test('rutas: fichas clínicas con y sin prefijo de clínica', () => {
  for (const p of [
    '/admin/clinical-records', '/admin/ficha-clinica/paciente/3', '/admin/acme/ana/ficha-clinica/expediente/9',
    '/admin/master/acme/ana/clinical-records/new',
  ]) assert.equal(nav.isClinicalRoute(p), true, p);
  for (const p of ['/admin', '/admin/finance', '/admin/acme/ana/agenda']) assert.equal(nav.isClinicalRoute(p), false, p);
});

test('guard: confirma según estado reportado; sin reporteros avisa solo en pantallas de captura', () => {
  const exp = '/admin/ficha-clinica/expediente/9';
  assert.equal(nav.shouldConfirmLeave('/admin/clinical-records/new', true, true), true);   // sucio
  assert.equal(nav.shouldConfirmLeave('/admin/clinical-records/new', false, true), false); // guardado
  assert.equal(nav.shouldConfirmLeave(exp, false, false), true);   // sin reporteros: aviso conservador
  assert.equal(nav.shouldConfirmLeave('/admin/clinical-records', false, false), false); // lista
  assert.equal(nav.shouldConfirmLeave('/admin/ficha-clinica/paciente/3', false, false), false); // perfil
});

test('módulo activo: rutas de ficha pertenecen a Fichas Clínicas', () => {
  assert.equal(nav.isModuleActive('/admin/ficha-clinica/paciente/3', '/admin/clinical-records', '/admin/clinical-records'), true);
  assert.equal(nav.isModuleActive('/admin/finance', '/admin/clinical-records', '/admin/clinical-records'), false);
  assert.equal(nav.isModuleActive('/admin/finance/x', '/admin/finance', '/admin/finance'), true);
});

test('teclado: flechas circulares, Home y End', () => {
  assert.equal(nav.nextFocusIndex('ArrowDown', 2, 3), 0);
  assert.equal(nav.nextFocusIndex('ArrowUp', 0, 3), 2);
  assert.equal(nav.nextFocusIndex('Home', 2, 3), 0);
  assert.equal(nav.nextFocusIndex('End', 0, 3), 2);
  assert.equal(nav.nextFocusIndex('a', 0, 3), null);
  assert.equal(nav.nextFocusIndex('ArrowDown', -1, 0), null);
});

test('permisos: mismos filtros que el dashboard, sin habilitar módulos ocultos ni ampliar permisos', () => {
  const only = (...feats) => (f) => feats.includes(f);
  const feats = (list) => Array.from(list, m => m.feat); // evita arrays de otro realm de vm
  // Sin features → sin módulos
  assert.deepEqual(feats(getVisibleModules(() => false, true)), []);
  // Los ocultos solo aparecen si la feature está habilitada
  assert.equal(feats(getVisibleModules(only('clinical_records', 'calendar'), false)).includes('ai_consultation'), false);
  assert.equal(feats(getVisibleModules(only('ai_consultation'), false)).includes('ai_consultation'), true);
  // Agenda agrupada: una sola entrada con feat calendar
  const visible = getVisibleModules(only('calendar', 'block_schedule', 'appointment'), false);
  assert.deepEqual(feats(visible), ['calendar']);
  // backup solo administradores
  assert.equal(feats(getVisibleModules(() => true, false)).includes('backup'), false);
  assert.equal(feats(getVisibleModules(() => true, true)).includes('backup'), true);
  // override de usuario
  assert.equal(feats(getVisibleModules(() => true, true, new Set(['finance']))).includes('finance'), false);
  assert.ok(MODULE_LIST.length > 0);
});

test('ModuleFlyout: render aislado con props (cerrado, accesible, enlaces reales)', () => {
  const noop = () => null;
  const { ModuleFlyout } = load('components/layout/ModuleFlyoutNav.tsx', {
    'react-router-dom': {}, 'lucide-react': new Proxy({}, { get: () => noop }),
    '../ui/Dialog': { Dialog: noop }, '../../context/AuthContext': {}, '../../context/MasterViewContext': {},
    '../../hooks/useAdminNav': {}, '../../hooks/useUnsavedChangesGuard': {}, '../../constants/features': {},
    './moduleNav': nav,
  });
  const html = renderToStaticMarkup(React.createElement(ModuleFlyout, {
    items: [
      { key: 'home', label: 'Inicio', href: '/admin', icon: noop },
      { key: 'clinical_records', label: 'Fichas Clínicas', href: '/admin/clinical-records', icon: noop, active: true },
    ],
    onNavigate: () => {},
  }));
  assert.match(html, /aria-label="Menú de módulos"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="module-flyout-panel"/);
  assert.match(html, /<nav[^>]+aria-label="Módulos de BIOSKIN"/);
  assert.match(html, /invisible/);
  assert.match(html, /href="\/admin\/clinical-records"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/admin\/clinical-records"/);
});

test('regresión QA: hover abre y el clic posterior NO cierra el menú (cierre prematuro)', () => {
  // hover abre (sin fijar) → clic fija y mantiene abierto
  let s = { open: true, pinned: false };
  s = nav.onTriggerClick(s);
  assert.deepEqual({ ...s }, { open: true, pinned: true });
  // fijado: salir con el mouse no cierra
  assert.equal(nav.shouldCloseOnPointerLeave(s), false);
  // segundo clic sí cierra
  assert.deepEqual({ ...nav.onTriggerClick(s) }, { open: false, pinned: false });
  // clic sin hover previo: abre fijado
  assert.deepEqual({ ...nav.onTriggerClick({ open: false, pinned: false }) }, { open: true, pinned: true });
  // abierto solo por hover: salir cierra; cerrado: nada que cerrar
  assert.equal(nav.shouldCloseOnPointerLeave({ open: true, pinned: false }), true);
  assert.equal(nav.shouldCloseOnPointerLeave({ open: false, pinned: false }), false);
});

test('contrato: el panel abre con visibilidad inmediata (foco por teclado) y el botón usa onTriggerClick', () => {
  const src = read('components/layout/ModuleFlyoutNav.tsx');
  assert.match(src, /'visible translate-x-1 opacity-100 transition-\[opacity,transform\]'/);
  assert.match(src, /onTriggerClick\(\{ open, pinned: pinned\.current \}\)/);
  assert.doesNotMatch(src, /onClick=\{\(\) => \(open \? close\(\) : openMenu/);
});

test('contrato de fuente: Escape, hover fino, reduced motion, diálogos, sin dependencias nuevas', () => {
  const src = read('components/layout/ModuleFlyoutNav.tsx');
  assert.match(src, /Escape/);
  assert.match(src, /\(hover: hover\) and \(pointer: fine\)/);
  assert.match(src, /motion-reduce:transition-none/);
  assert.match(src, /dialog\[open\]/);
  assert.match(src, /pointerdown/);
  assert.match(src, /BIOSKIN no guarda automáticamente/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['react-router-dom']);
  // AdminLayout monta el flyout solo en rutas clínicas por defecto
  const layout = read('components/layout/AdminLayout.tsx');
  assert.match(layout, /moduleNav \?\? isClinicalRoute\(pathname\)/);
  // Dashboard consume la petición de Ajustes y reutiliza la regla de módulos
  const dash = read('pages/AdminDashboard.tsx');
  assert.match(dash, /openSettings\?: string/);
  assert.match(dash, /getVisibleModules\(effectiveHasFeature, canManage, disabledByOverride\)/);
});
