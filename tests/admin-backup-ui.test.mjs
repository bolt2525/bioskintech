import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { gzipSync, gunzipSync } from 'node:zlib';

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
const json = (body, ok = true, status = ok ? 200 : 503) => ({ ok, status, json: async () => body });

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
      return json({ stats: {}, encryption_ready: state === 'ready', manual_backup: { available: true } });
    });
    let tree = await harness.mount();
    button(tree, 'Nube').props.onClick();
    tree = harness.render();
    assert.equal(button(tree, 'Crear respaldo en la nube ahora').props.disabled, state !== 'ready');
    if (state === 'notready') assert.match(text(tree), /cifrado de respaldos no está verificado/);
  });
}

for (const [quota, message] of [
  [null, /No se pudo verificar el cupo/],
  [{ available: false, next_allowed_at: '2026-10-08T05:00:00Z' }, /Ya se utilizó el cupo/],
  [{ available: false, state: 'PROCESSING' }, /copia manual en curso/],
  [{ available: false, state: 'HISTORY_INCOMPLETE', reason: 'Historial no verificado' }, /Historial no verificado/],
  [{ available: true }, /una copia manual por clínica y día/],
]) {
  test(`cupo manual falla cerrado y presenta estado: ${quota?.state || quota?.available || 'missing'}`, async () => {
    const harness = componentHarness(backupPath, 'clinic_admin', async url =>
      json(url.includes('snapshots') ? { snapshots: [] } : { stats: {}, encryption_ready: true, manual_backup: quota }));
    let tree = await harness.mount();
    button(tree, 'Nube').props.onClick();
    tree = harness.render();
    assert.equal(button(tree, 'Crear respaldo en la nube ahora').props.disabled, quota?.available !== true);
    assert.match(text(tree), message);
  });
}

test('una respuesta 429 del respaldo manual vuelve a consultar cupo y nube', async () => {
  let statsCalls = 0;
  let snapshotCalls = 0;
  const harness = componentHarness(backupPath, 'clinic_admin', async url => {
    if (url.includes('snapshots')) {
      snapshotCalls++;
      return json({ snapshots: [] });
    }
    if (url.includes('action=stats')) {
      statsCalls++;
      return json({
        stats: {},
        encryption_ready: true,
        manual_backup: statsCalls === 1 ? { available: true } : {
          available: false,
          next_allowed_at: '2026-10-08T05:00:00Z',
        },
      });
    }
    if (url.includes('action=snapshot'))
      return json({ error: 'El cupo ya se utilizó.' }, false, 429);
    throw new Error(`Solicitud inesperada: ${url}`);
  });
  let tree = await harness.mount();
  button(tree, 'Nube').props.onClick();
  tree = harness.render();
  button(tree, 'Crear respaldo en la nube ahora').props.onClick();
  tree = harness.render();
  button(tree, 'Crear respaldo').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  tree = harness.render();

  assert.equal(statsCalls, 2);
  assert.equal(snapshotCalls, 2);
  assert.match(text(tree), /El cupo ya se utilizó/);
  assert.equal(button(tree, 'Crear respaldo en la nube ahora').props.disabled, true);
});

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

test('Base de Datos distingue selección JSON, firmas, originales y copias en nube', async () => {
  const harness = componentHarness(backupPath, 'clinic_admin', async url =>
    json(url.includes('snapshots') ? { snapshots: [] } : { stats: {}, encryption_ready: true }));
  const tree = await harness.mount();
  assert.match(text(tree), /El JSON conserva datos estructurados, firmas y marcaciones/);
  assert.match(text(tree), /ni contiene los archivos de fotografías/);
  assert.match(text(tree), /no solo las casillas de Exportar/);
  assert.ok(elements(tree).some(node => node.props?.title === 'Respaldo técnico por módulos (JSON)'));
  assert.match(text(tree), /50 MiB comprimidos y 200 MiB descomprimidos/);
  assert.match(text(tree), /no entrega una copia que no puedas cargar/);
  assert.match(text(tree), /hasta 100 consentimientos/);
  for (const label of ['Exportar', 'Importar', 'Nube']) {
    const tab = elements(tree).find(node => node.type === 'button' && text(node).endsWith(label));
    assert.equal(tab.props['aria-pressed'], label === 'Exportar');
  }
});

test('La guía de importación informa errores y permite reintentar', async () => {
  let failed = true;
  const harness = componentHarness(backupPath, 'clinic_admin', async url => {
    if (url.includes('templateInfo')) return failed ? json({ error: 'Guía temporalmente no disponible' }, false)
      : json({ columns: [{ name: 'nombres', required: true, description: 'Nombres', example: 'Prueba' }] });
    return json(url.includes('snapshots') ? { snapshots: [] } : { stats: {}, encryption_ready: true });
  });
  let tree = await harness.mount();
  button(tree, 'Importar').props.onClick();
  tree = harness.render();
  button(tree, 'Importar pacientes (CSV)').props.onClick();
  tree = await harness.mount();
  assert.match(text(tree), /No se pudo cargar la guía de columnas/);
  failed = false;
  button(tree, 'Reintentar guía').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = harness.render();
  assert.doesNotMatch(text(tree), /No se pudo cargar la guía de columnas/);
  assert.match(text(tree), /Ver guía de columnas \(1\)/);
});

test('El canal anual apagado conserva coordinación asistida sin solicitudes automáticas', async () => {
  const calls = [];
  const harness = componentHarness(annualPath, 'clinic_admin', async url => {
    calls.push(url);
    return json({ configured: false, eligible: false, reason: 'feature_disabled', requests: [] });
  });
  const tree = await harness.mount();
  assert.match(text(tree), /Contacta a soporte para registrar y coordinar una solicitud asistida/);
  assert.match(text(tree), /canal automático todavía no está habilitado/);
  assert.equal(button(tree, 'Solicitar Respaldo Anual').props.disabled, true);
  assert.equal(calls.length, 1);
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
      assert.match(text(tree), /Procesamiento automático deshabilitado/);
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

test('Master consulta la clínica UUID y carga una sugerencia editable sin registrar automáticamente períodos', async () => {
  const id = '3f2a9c1e-7b4d-4e8a-9f10-aa11bb22cc33';
  const calls = [];
  const harness = componentHarness(annualPath, 'master_admin', async (url, options) => {
    calls.push({ url, options });
    return json(url.includes('listPhotoBackupRequests') ? { configured: true, requests: [] } : {
      configured: true, requests: [], period_suggestion: {
        starts_at: '2026-10-07T00:00:00Z', ends_at: '2027-10-07T00:00:00Z',
        source: 'subscription_expires_at - subscription_days', duration_days: 365,
        requires_master_confirmation: true,
      },
    });
  });
  const props = { master: true, clinics: [{ id, name: 'Clínica ficticia' }] };
  let tree = await harness.mount(props);
  elements(tree).find(node => node.type === 'select').props.onChange({ target: { value: id } });
  tree = await harness.mount(props);
  const query = calls.find(call => call.url.includes('photoBackupStatus'));
  assert.equal(query.options.method, 'GET');
  assert.equal(query.options.headers['X-Target-Clinic-Id'], id);
  let dates = elements(tree).filter(node => node.type === 'input' && node.props.type === 'date');
  assert.deepEqual(dates.map(node => node.props.value), ['', '']);
  button(tree, 'Usar fechas sugeridas').props.onClick();
  tree = harness.render(props);
  dates = elements(tree).filter(node => node.type === 'input' && node.props.type === 'date');
  assert.deepEqual(dates.map(node => node.props.value), ['2026-10-07', '2027-10-07']);
  dates[0].props.onChange({ target: { value: '2026-10-08' } });
  tree = harness.render(props);
  assert.equal(elements(tree).find(node => node.type === 'input' && node.props.type === 'date').props.value, '2026-10-08');
  assert.match(text(tree), /vencimiento de suscripción menos 365 días/);
  assert.match(text(tree), /no determina el período contractual anual/);
  assert.equal(calls.some(call => call.url.includes('setPhotoBackupPeriod')), false);
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
  assert.equal((backup.match(/\bfetch\(/g) || []).length, 3);
  assert.match(backup, /const response = await fetch\(url\)/);
  assert.match(backup, /const res = await fetch\(url\)/);
  assert.match(backup, /const put = await fetch\(url, \{ method: 'PUT'/);
  assert.match(backup, /recordsFetch\(`\/api\/backup\?action=csv/);
  assert.match(backup, /recordsFetch\('\/api\/backup\?action=template'/);
  for (const path of [backupPath, annualPath, '../src/pages/AdminDashboard.tsx']) {
    assert.match(source(path), /<Dialog open/);
    assert.doesNotMatch(source(path), /role="dialog"/);
  }
});

test('JSON comprimido conserva bytes, firmas y nombre sin inflar el archivo en el cliente', async () => {
  const payload = JSON.stringify({ consent_forms: [{ signature_data: 'x'.repeat(1_000_000) }], signature: 'firma-ficticia' });
  const original = gzipSync(payload);
  const blob = new Blob([original]);
  const calls = [];
  let saved;
  const backup = source(backupPath);
  const code = backup.slice(backup.indexOf('async function downloadCompressedBackup'), backup.indexOf('async function downloadConsentPages'));
  const context = {
    fetch: async (...args) => { calls.push(args); return { ok: true, blob: async () => blob }; },
    saveBlob: (body, name) => { saved = { body, name }; },
  };
  vm.createContext(context);
  vm.runInContext(compile(code), context);
  await context.downloadCompressedBackup('https://example.invalid/download', 'respaldo.json.gz');
  assert.deepEqual(calls, [['https://example.invalid/download']]);
  assert.equal(saved.body, blob);
  assert.equal(saved.name, 'respaldo.json.gz');
  assert.deepEqual(Buffer.from(await saved.body.arrayBuffer()), original);
  assert.equal(gunzipSync(original).toString(), payload);
  context.fetch = async () => ({ ok: false });
  await assert.rejects(context.downloadCompressedBackup('https://example.invalid/fail', 'fallo.json.gz'), /No se pudo descargar/);
});

test('historial pagina todas las copias y reinicia al filtrar sin perder acceso a registros antiguos', async () => {
  const snapshots = Array.from({ length: 24 }, (_, i) => ({
    key: `snapshot-${i}`, kind: i < 12 ? 'auto' : 'manual', size: 6500, created_at: '2026-10-07T08:00:00Z',
  }));
  const harness = componentHarness(backupPath, 'clinic_admin', async url =>
    json(url.includes('snapshots') ? { snapshots } : { stats: {}, encryption_ready: true }));
  let tree = await harness.mount();
  button(tree, 'Nube').props.onClick();
  tree = harness.render();
  const downloadCount = () => elements(tree).filter(node => node.type === 'button' && node.props.title === 'Descargar').length;
  assert.equal(downloadCount(), 10);
  button(tree, 'Ver 10 copias más').props.onClick();
  tree = harness.render();
  assert.equal(downloadCount(), 20);
  button(tree, 'Ver 10 copias más').props.onClick();
  tree = harness.render();
  assert.equal(downloadCount(), 24);
  elements(tree).find(node => node.type === 'select').props.onChange({ target: { value: 'manual' } });
  tree = harness.render();
  assert.equal(downloadCount(), 10);
  assert.match(text(tree), /10 de 12 copias/);
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
