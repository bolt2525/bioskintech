import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const backupPath = '../src/pages/AdminBackup.tsx';
const annualPath = '../src/components/admin/AnnualPhotoBackupPanel.tsx';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

// Harness sin dependencias nuevas: ejecuta componentes y efectos con hooks controlados.
// No sustituye una prueba de foco/teclado en un navegador real.
function componentHarness(path, role, request) {
  const states = [];
  let cursor = 0;
  let effects = [];
  const hooks = {
    ...require('react'),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
    useCallback(callback) { return callback; },
    useRef() { return { current: null }; },
    useId() { return 'dialog-test-title'; },
  };
  const exports = {};
  const context = {
    exports,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name.endsWith('/useAuth')) return { useAuth: () => ({ user: role ? { role } : null }) };
      if (name.endsWith('/recordsFetch')) return { __esModule: true, default: request };
      return new Proxy({}, { get: () => () => null });
    },
    window: { setInterval: () => 1, clearInterval() {} },
    console,
  };
  vm.runInNewContext(compile(source(path)), context);
  return {
    render(props = {}) {
      cursor = 0;
      effects = [];
      return exports.default(props);
    },
    async mount(props = {}) {
      this.render(props);
      for (const effect of effects) effect();
      await new Promise(resolve => setImmediate(resolve));
      return this.render(props);
    },
  };
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object') return [];
  return [node, ...elements(node.props?.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}
function button(tree, label) {
  const result = elements(tree).find(node => node.type === 'button' && text(node) === label);
  assert.ok(result, `Botón no encontrado: ${label}`);
  return result;
}
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });

for (const role of [null, 'clinic_user']) {
  test(`backup y anual no consultan APIs sin permiso: ${role}`, async () => {
    const calls = [];
    const request = async url => { calls.push(url); return json({}); };
    await componentHarness(backupPath, role, request).mount();
    assert.equal(await componentHarness(annualPath, role, request).mount(), null);
    assert.deepEqual(calls, []);
  });
}

for (const state of ['loading', 'error', 'notready', 'ready']) {
  test(`crear copia exige cifrado verificado: ${state}`, async () => {
    const harness = componentHarness(backupPath, 'clinic_admin', async url => {
      if (url.includes('snapshots')) return json({ snapshots: [] });
      if (state === 'loading') return new Promise(() => {});
      if (state === 'error') return json({ error: 'Servicio no disponible' }, false);
      return json({ stats: {}, encryption_ready: state === 'ready' });
    });
    let tree = await harness.mount();
    button(tree, 'Nube').props.onClick();
    tree = harness.render();
    assert.equal(button(tree, 'Crear respaldo en la nube ahora').props.disabled, state !== 'ready');
  });
}

test('backup distingue ausencia, error y copia automática antigua (>48 h)', async () => {
  const cases = [
    { response: json({ snapshots: [] }), expected: /No hay una copia automática registrada/ },
    { response: json({ error: 'Error de consulta' }, false), expected: /No se pudo verificar la última copia automática/ },
    { response: json({ snapshots: [
      { key: 'old', kind: 'auto', created_at: new Date(Date.now() - 72 * 3600000).toISOString() },
      { key: 'latest', kind: 'auto', created_at: new Date(Date.now() - 49 * 3600000).toISOString() },
    ] }), expected: /Tiene más de 48 horas/ },
  ];
  for (const item of cases) {
    const harness = componentHarness(backupPath, 'master_admin', async url =>
      url.includes('snapshots') ? item.response : json({ stats: {}, encryption_ready: true }));
    assert.match(text(await harness.mount()), item.expected);
  }
  const harness = componentHarness(backupPath, 'clinic_admin', async url => json(url.includes('snapshots') ? {
    snapshots: [
      { key: 'old', kind: 'auto', created_at: new Date(Date.now() - 72 * 3600000).toISOString() },
      { key: 'new', kind: 'auto', created_at: new Date(Date.now() - 3600000).toISOString() },
    ],
  } : { stats: {}, encryption_ready: true }));
  assert.doesNotMatch(text(await harness.mount()), /Tiene más de 48 horas/);
});

for (const configured of [false, true, undefined]) {
  test(`Master conserva configured y bloquea período/aprobación: ${configured}`, async () => {
    const calls = [];
    const request = async url => {
      calls.push(url);
      return json({ configured, reason: configured === false ? 'feature_disabled' : null, requests: [
        { id: 'request-test', status: 'PENDING', created_at: '2026-10-01', clinic_id: 'clinic-test' },
      ] });
    };
    const harness = componentHarness(annualPath, 'master_admin', request);
    const tree = await harness.mount({ master: true });
    assert.equal(button(tree, 'Registrar período').props.disabled, configured !== true);
    assert.equal(button(tree, 'Aprobar').props.disabled, configured !== true);
    if (configured === false) {
      assert.match(text(tree), /respaldo fotográfico anual está deshabilitado/);
      assert.doesNotMatch(text(tree), /feature_disabled/);
      const form = elements(tree).find(node => node.type === 'form');
      form.props.onSubmit({ preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, 1, 'No debe enviar un POST con configured=false');
    }
  });
}

test('panel anual Master rechaza usuarios no Master aunque sean administradores', async () => {
  let calls = 0;
  const tree = await componentHarness(annualPath, 'clinic_admin', async () => { calls++; }).mount({ master: true });
  assert.equal(tree, null);
  assert.equal(calls, 0);
});

function consentDownloader(api, downloadGzip) {
  const file = ts.createSourceFile('AdminBackup.tsx', source(backupPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'downloadConsentPages');
  assert.ok(fn);
  return vm.runInNewContext(`${compile(fn.getText(file))}\ndownloadConsentPages`, { api, downloadGzip });
}
const revision = 'a'.repeat(32);
function page(count, offset) {
  const returnedCount = Math.min(100, count - offset);
  const hasMore = offset + returnedCount < count;
  return {
    url: `https://presigned.invalid/${offset}`, filename: `consents-${offset}.html.gz`,
    count, returnedCount, offset, limit: 100, hasMore,
    nextOffset: hasMore ? offset + returnedCount : null, revision,
  };
}

test('un paciente con 251 consentimientos descarga todas las páginas, con revisión estable', async () => {
  const requests = [];
  const downloads = [];
  const progress = [];
  const download = consentDownloader(async (url, body) => {
    assert.equal(url, '/api/backup?action=consentsHtml');
    requests.push(body);
    return page(251, body.offset);
  }, async (...args) => downloads.push(args));
  const result = await download([7], part => progress.push(part));
  assert.equal(result.count, 251);
  assert.equal(result.parts, 3);
  assert.deepEqual(requests.map(body => body.offset), [0, 100, 200]);
  assert.ok(requests.every(body => body.limit === 100 && body.patientIds[0] === 7));
  assert.equal(requests[0].revision, undefined);
  assert.ok(requests.slice(1).every(body => body.revision === revision));
  assert.equal(downloads.length, 3);
  assert.deepEqual(progress, [1, 2, 3]);
});

test('selección de todos pagina sin filtro patientIds y termina también con cero registros', async () => {
  for (const count of [0, 100, 200]) {
    let downloads = 0;
    const download = consentDownloader(async (_url, body) => {
      assert.equal(body.patientIds, undefined);
      return page(count, body.offset);
    }, async () => { downloads++; });
    const result = await download(null, () => {});
    assert.equal(result.count, count);
    assert.equal(downloads, Math.ceil(count / 100));
  }
});

test('no confirma descargas truncadas, sin progreso o con conjunto cambiado', async () => {
  const invalidPages = [
    { url: 'https://presigned.invalid', filename: 'old.html.gz' },
    { ...page(251, 0), returnedCount: 0 },
    { ...page(251, 0), hasMore: false, nextOffset: null },
    { ...page(251, 0), nextOffset: 50 },
  ];
  for (const invalid of invalidPages) {
    let downloads = 0;
    const download = consentDownloader(async () => invalid, async () => { downloads++; });
    await assert.rejects(download([7], () => {}), /verificar la paginación/);
    assert.equal(downloads, 0);
  }
  const download = consentDownloader(async (_url, body) => ({
    ...page(251, body.offset), revision: body.offset ? 'b'.repeat(32) : revision,
  }), async () => {});
  await assert.rejects(download([7], () => {}), /verificar la paginación/);
});

test('errores intermedios de API o descarga no se reportan como exportación completa', async () => {
  const apiFailure = consentDownloader(async (_url, body) => {
    if (body.offset) throw new Error('La selección cambió; reinicie');
    return page(251, 0);
  }, async () => {});
  await assert.rejects(apiFailure([7], () => {}), /selección cambió/);
  const downloadFailure = consentDownloader(async (_url, body) => page(251, body.offset), async () => {
    throw new Error('Descarga fallida');
  });
  await assert.rejects(downloadFailure([7], () => {}), /Descarga fallida/);
});

test('tile backup usa el rol real, no el clinic_user de presentación Master', () => {
  const dashboard = source('../src/pages/AdminDashboard.tsx');
  const roleExpression = /const canManage = ([^;]+);/.exec(dashboard)?.[1];
  const tileExpression = /const tiles = ([^;]+);/.exec(dashboard)?.[1];
  assert.ok(roleExpression && tileExpression);
  for (const [role, expected] of [['clinic_user', 0], ['clinic_admin', 1], ['master_admin', 1]]) {
    const tiles = vm.runInNewContext(`const canManage = ${roleExpression}; ${tileExpression}`, {
      user: { role }, effectiveUser: { role: 'clinic_user' },
      MODULE_LIST: [{ feat: 'backup' }], effectiveHasFeature: () => true, disabledByOverride: new Set(),
    });
    assert.equal(tiles.length, expected);
  }
});

test('APIs autenticadas usan recordsFetch; GET/PUT presigned quedan sin credenciales', () => {
  assert.doesNotMatch(source(annualPath), /\bfetch\(/);
  assert.doesNotMatch(source('../src/pages/AdminDashboard.tsx'), /\bfetch\(/);
  const backup = source(backupPath);
  assert.equal((backup.match(/\bfetch\(/g) || []).length, 2);
  assert.match(backup, /const res = await fetch\(url\)/);
  assert.match(backup, /const put = await fetch\(url, \{ method: 'PUT'/);
  assert.match(backup, /recordsFetch\(`\/api\/backup\?action=csv/);
  assert.match(backup, /recordsFetch\('\/api\/backup\?action=template'/);
  for (const path of [backupPath, annualPath, '../src/pages/AdminDashboard.tsx']) {
    assert.match(source(path), /<Dialog open/);
    assert.doesNotMatch(source(path), /role="dialog"/);
  }
});

test('recordsFetch propaga clínica y usuario Master también a CSV y acciones anuales', async () => {
  const exports = {};
  const calls = [];
  vm.runInNewContext(compile(source('../src/utils/recordsFetch.ts')), {
    exports,
    sessionStorage: { getItem: () => 'sesion-ficticia-qa' },
    fetch: async (url, options) => { calls.push({ url, options }); return json({}); },
  });
  exports.setMasterTargetClinicId(12);
  exports.setMasterTargetUserId(34);
  for (const url of [
    '/api/backup?action=csv&dataset=patients',
    '/api/backup?action=consentsHtml',
    '/api/backup?action=listPhotoBackupRequests',
  ]) await exports.default(url);
  for (const call of calls) {
    assert.equal(call.options.headers['X-Target-Clinic-Id'], '12');
    assert.equal(call.options.headers['X-Target-User-Id'], '34');
    assert.equal(call.options.headers.Authorization, 'Bearer sesion-ficticia-qa');
  }
});

test('contrato final sin offset/limit en respuesta: 205 consentimientos se descargan 100/100/5', async () => {
  const offsets = [];
  const sizes = [];
  const download = consentDownloader(async (_url, body) => {
    offsets.push(body.offset);
    assert.equal(body.limit, 100);
    assert.deepEqual(Array.from(body.patientIds), [7]);
    assert.equal(body.revision, body.offset ? revision : undefined);
    const { offset: _offset, limit: _limit, ...response } = page(205, body.offset);
    sizes.push(response.returnedCount);
    return response;
  }, async () => {});
  const result = await download([7], () => {});
  assert.equal(result.count, 205);
  assert.equal(result.parts, 3);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.deepEqual(sizes, [100, 100, 5]);
});

test('409 aborta las páginas sin reintentar automáticamente ni descargar páginas posteriores', async () => {
  let requests = 0;
  let downloads = 0;
  const download = consentDownloader(async (_url, body) => {
    requests++;
    if (body.offset) throw Object.assign(new Error('La selección cambió'), { status: 409 });
    return page(205, 0);
  }, async () => { downloads++; });
  await assert.rejects(download([7], () => {}), failure => failure.status === 409);
  assert.equal(requests, 2);
  assert.equal(downloads, 1);
  assert.match(source(backupPath), /failure\.status === 409/);
  assert.match(source(backupPath), /Descarte todas las partes recibidas y reinicie manualmente/);
});
