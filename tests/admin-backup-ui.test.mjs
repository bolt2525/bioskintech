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
const orderPath = '../src/components/admin/AnnualPhotoBackupOrder.tsx';
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
class TestDecompressionStream {
  constructor(format) { assert.equal(format, 'gzip'); }
}

// Harness sin dependencias nuevas: ejecuta componentes y efectos con hooks controlados.
// No sustituye una prueba de foco/teclado en un navegador real.
function componentHarness(path, role, request, lifecycle, deliveryOnly = false) {
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
      if (name.endsWith('/useAuth')) return { useAuth: () => ({ user: role ? { role, subscription_lifecycle: lifecycle, delivery_only: deliveryOnly } : null }) };
      if (name.endsWith('/subscriptionAccess')) {
        const accessExports = {};
        vm.runInNewContext(compile(source('../src/utils/subscriptionAccess.ts')), { exports: accessExports, Intl, Date });
        return accessExports;
      }
      if (name.endsWith('/annualPhotoBackup')) {
        const annualExports = {};
        vm.runInNewContext(compile(source('../src/utils/annualPhotoBackup.ts')), { exports: annualExports, Intl, Number });
        return annualExports;
      }
      if (name.endsWith('/recordsFetch')) return { __esModule: true, default: request };
      return new Proxy({}, { get: () => () => null });
    },
    window: { setInterval: () => 1, clearInterval() {} },
    Error,
    console,
    Blob: globalThis.Blob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    DecompressionStream: TestDecompressionStream,
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
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

const batchFile = count => {
  const content = Buffer.from([
    JSON.stringify({ type: 'manifest' }),
    ...Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'batch', index })),
    JSON.stringify({ type: 'trailer' }),
    '',
  ].join('\n'));
  const bytes = new Uint8Array(content);
  return {
    name: 'respaldo-qa.jsonl.gz',
    size: bytes.byteLength,
    stream: () => ({
      pipeThrough: () => ({
        getReader: () => {
          let read = false;
          return {
            read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }),
            releaseLock() {},
          };
        },
      }),
    }),
  };
};

function batchApi(totalBatches, { partial = false, loseFirstResponse = false } = {}) {
  const calls = [];
  const applied = new Map();
  let responseLost = false;
  const info = {
    signature: 'valid', sameClinic: true, timestamp: '2026-01-01T00:00:00.000Z', ageDays: 1,
    modules: ['patients'], total_batches: totalBatches, counts: { patients: totalBatches },
  };
  const report = (index, existing = false) => ({
    inserted: existing ? {} : { patients: 1 }, existing: existing ? { patients: 1 } : {},
    deferred: {}, skipped: {}, errors: partial ? [{ table: 'patients', id: 7, error: 'Validación de QA' }] : [],
    errorCount: partial ? 1 : 0, deferredCount: 0,
  });
  const request = async (url, options) => {
    if (!options?.body) return json(url.includes('snapshots') ? { snapshots: [] } : { stats: {}, encryption_ready: true });
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.phase === 'inspect') return json({ phase: 'inspect', info, confirmations: [], resume_token: 'dry-0',
      progress: { next_index: 0, total_batches: totalBatches, done: false }, completed: false, committed: false });
    if (body.phase === 'prepare') return json({ phase: 'prepare', info, confirmations: [],
      resume_token: 'apply-0', progress: { next_index: 0, total_batches: totalBatches, done: false }, completed: false, committed: false });
    if (body.phase === 'batch') {
      const next = body.index + 1;
      if (body.dryRun) return json({ phase: 'batch', info, confirmations: [], resume_token: `dry-${next}`,
        progress: { next_index: next, total_batches: totalBatches, done: next === totalBatches },
        completed: false, committed: false, report: report(body.index) });
      const wasApplied = applied.has(body.index);
      applied.set(body.index, true);
      if (loseFirstResponse && body.index === 1 && !responseLost) {
        responseLost = true;
        throw new Error('Respuesta perdida tras confirmar el lote');
      }
      return json({ phase: 'batch', info, confirmations: [], resume_token: `apply-${next}`,
        progress: { next_index: next, total_batches: totalBatches, done: next === totalBatches },
        completed: false, committed: true, report: report(body.index, wasApplied) });
    }
    if (body.phase === 'finish') return json({ phase: 'finish', info, confirmations: [],
      resume_token: null, progress: { next_index: totalBatches, total_batches: totalBatches, done: true },
      completed: true, committed: false });
    assert.fail(`Fase de respaldo inesperada: ${body.phase}`);
  };
  return { request, calls };
}

function confirmBatch(tree, pattern) {
  const component = elements(tree).find(node => typeof node.type === 'function' &&
    node.type.name === 'Confirm' && pattern.test(text(node.props.children)));
  assert.ok(component, `Confirmación no encontrada: ${pattern}`);
  component.props.onChange(true);
}

function hasCard(tree, title) {
  return elements(tree).some(node => node.type?.name === 'Card' && node.props.title === title);
}

function selectBatchFile(tree, file) {
  const input = elements(tree).find(node => node.type === 'input' && node.props.type === 'file' &&
    node.props.accept.includes('.jsonl.gz'));
  assert.ok(input, 'No se encontró el selector de respaldos por lotes');
  input.props.onChange({ target: { files: [file], value: file.name } });
}

function approveBatchRestore(harness, buttonLabel) {
  let tree = harness.render();
  button(tree, buttonLabel).props.onClick();
  tree = harness.render();
  const confirmation = elements(tree).filter(node => node.type === 'button' &&
    text(node) === (buttonLabel === 'Restaurar todos los lotes' ? 'Restaurar por lotes' : 'Reanudar por lotes')).at(-1);
  assert.ok(confirmation, 'No se encontró la confirmación modal de restauración');
  confirmation.props.onClick();
}

test('Worker OFF permite solicitud adicional con can_request aunque la entrega gratis esté reservada', async () => {
  const calls = [];
  const harness = componentHarness(annualPath, 'clinic_admin', async (url, options) => {
    calls.push({ url, options });
    return json(url.includes('requestPhotoBackup') ? {
      requestId: 'pedido-ficticio', status: 'PAYMENT_PENDING', entitlement_kind: 'PAID', payment_status: 'NEEDS_QUOTE', processor_ready: false,
    } : { configured: true, processor_ready: false, eligible: false, can_request: true, additional_requires_payment: true,
      period: { id: 'periodo-ficticio', start_date: '2026-01-01', end_date: '2027-01-01', request_deadline_at: '2027-01-16T05:00:00Z' }, requests: [] });
  });
  let tree = await harness.mount();
  assert.equal(button(tree, 'Solicitar Respaldo Anual').props.disabled, false);
  assert.doesNotMatch(text(tree), /Worker|SMTP|procesador|esquema/);
  assert.match(text(tree), /requiere cotización y pago/);
  button(tree, 'Solicitar Respaldo Anual').props.onClick();
  tree = harness.render();
  assert.match(text(tree), /Confirmar no autoriza un cargo/);
  assert.equal(calls.length, 1, 'abrir confirmación no registra ni cobra');
  await button(tree, 'Confirmar').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = harness.render();
  const post = calls.find(call => call.url.includes('requestPhotoBackup'));
  assert.deepEqual(JSON.parse(post.options.body), {});
  assert.match(text(tree), /no se realizó ningún cobro automático/i);
  assert.equal(calls.some(call => /Payment|approve|Quote/.test(call.url)), false);
});

test('doble confirmación inmediata no registra dos solicitudes adicionales', async () => {
  let resolve;
  let posts = 0;
  const harness = componentHarness(annualPath, 'clinic_admin', async url => {
    if (url.includes('requestPhotoBackup')) {
      posts++;
      return new Promise(done => { resolve = done; });
    }
    return json({ configured: true, processor_ready: false, eligible: false, can_request: true, additional_requires_payment: true, requests: [] });
  });
  let tree = await harness.mount();
  button(tree, 'Solicitar Respaldo Anual').props.onClick();
  tree = harness.render();
  const confirm = button(tree, 'Confirmar');
  confirm.props.onClick();
  confirm.props.onClick();
  assert.equal(posts, 1);
  resolve(json({ entitlement_kind: 'PAID', payment_status: 'NEEDS_QUOTE' }));
  await new Promise(done => setImmediate(done));
});

test('vigencia habilitada no exige otro registro y fallos no muestran códigos internos', async () => {
  const harness = componentHarness(annualPath, 'clinic_admin', async () => json({
    configured: true, processor_ready: false, can_request: true, period: null,
    period_suggestion: { starts_at: '2026-10-07T18:00:00Z', ends_at: '2027-10-07T18:00:00Z',
      source: 'subscription_expires_at - 12 months', duration_days: 365, requires_master_confirmation: false },
    requests: [{ id: 'pedido-ficticio', created_at: '2026-10-01T05:00:00Z', status: 'FAILED',
      error_code: 'R2_INTERNAL_FAILURE', notification_error: 'SMTP_FAILED' }],
  }));
  const tree = await harness.mount();
  assert.equal(button(tree, 'Solicitar Respaldo Anual').props.disabled, false);
  assert.match(text(tree), /Vigencia hasta 7 oct 2027/);
  assert.match(text(tree), /No se pudo preparar el respaldo/);
  assert.match(text(tree), /Tu solicitud sigue registrada/);
  assert.doesNotMatch(text(tree), /registrar el período|revisar la vigencia|Worker|SMTP|R2_INTERNAL_FAILURE|0 fotografías/);
});

for (const status of [
  { configured: true, eligible: true, can_request: false },
  { configured: true, eligible: true },
  { configured: false, eligible: true, can_request: true },
]) {
  test(`can_request falla cerrado sin inferir desde eligible/configured: ${JSON.stringify(status)}`, async () => {
    const harness = componentHarness(annualPath, 'clinic_admin', async () => json({ ...status, processor_ready: true, requests: [] }));
    assert.equal(button(await harness.mount(), 'Solicitar Respaldo Anual').props.disabled, true);
  });
}

test('Master con registro listo y Worker OFF registra períodos sin poder aprobar', async () => {
  const calls = [];
  const status = { configured: true, processor_ready: false, pending_count: 1, notifications: [], requests: [
    { id: 'pedido-ficticio', clinic_id: 'clinica-ficticia', created_at: '2026-10-01T05:00:00Z', status: 'PENDING', entitlement_kind: 'FREE' },
  ] };
  const harness = componentHarness(annualPath, 'master_admin', async (url, options) => { calls.push({ url, options }); return json(status); });
  let summary;
  const props = { master: true, onProviderStatus: next => { summary = next; } };
  let tree = await harness.mount(props);
  assert.equal(button(tree, 'Registrar período').props.disabled, false);
  assert.equal(button(tree, 'Aprobar').props.disabled, true);
  assert.equal(summary.pending_count, 1);
  button(tree, 'Aprobar').props.onClick();
  tree = harness.render(props);
  assert.equal(button(tree, 'Confirmar').props.disabled, true);
  await button(tree, 'Confirmar').props.onClick();
  assert.equal(calls.some(call => call.url.includes('approvePhotoBackup')), false, 'handler tampoco envía aprobación con Worker OFF');
});

test('solicitud pagada pendiente y fallo SMTP se muestran sin habilitar aprobación', async () => {
  const harness = componentHarness(annualPath, 'master_admin', async () => json({
    configured: true, processor_ready: true, pending_count: 1,
    notifications: [{ request_id: 'pedido-ficticio', kind: 'REQUESTED', status: 'FAILED', attempts: 2, last_error: 'no-debe-exponerse' }],
    requests: [{ id: 'pedido-ficticio', clinic_id: 'clinica-ficticia', created_at: '2026-10-01T05:00:00Z',
      status: 'PAYMENT_PENDING', entitlement_kind: 'PAID', payment_status: 'NEEDS_QUOTE' }],
  }));
  const tree = await harness.mount({ master: true });
  assert.match(text(tree), /Cotización o pago pendiente/);
  assert.match(text(tree), /Sin pago confirmado/);
  assert.match(text(tree), /Envío fallido · 2 intentos/);
  assert.doesNotMatch(text(tree), /no-debe-exponerse/);
  assert.equal(elements(tree).some(node => node.type === 'button' && text(node) === 'Aprobar'), false);
});

const paidOrder = extra => ({
  id: 'pedido-ficticio', clinic_id: 'clinica-ficticia', created_at: '2026-10-01T05:00:00Z',
  status: 'PAYMENT_PENDING', entitlement_kind: 'PAID', payment_status: 'PAYMENT_PENDING',
  original_total_bytes: 5e9, quote_total_cents: 1000, ...extra,
});

test('cotización parcial se continúa explícitamente y no permite aceptar ni pagar', async () => {
  const commands = [];
  const props = { item: paidOrder({ original_total_bytes: null, quote_total_cents: null, payment_status: 'NEEDS_QUOTE' }),
    busy: false, execute: async command => { commands.push(command); return { quote_complete: false, bytes_measured: 3e9 }; } };
  const harness = componentHarness(orderPath, 'master_admin', async () => {});
  let tree = harness.render(props);
  assert.equal(button(tree, 'Registrar aceptación').props.disabled, true);
  await button(tree, 'Calcular cotización').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = harness.render(props);
  assert.match(text(tree), /Medición parcial/);
  assert.equal(button(tree, 'Registrar aceptación').props.disabled, true);
  assert.equal(button(tree, 'Confirmar pago recibido').props.disabled, true);
  assert.equal(button(tree, 'Continuar cotización').props.disabled, false);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'quotePhotoBackup');
  assert.deepEqual({ ...commands[0].body }, { requestId: 'pedido-ficticio', clinicId: 'clinica-ficticia' });
});

test('aceptación y pago exigen confirmación explícita y referencia; nunca envían paid=true', async () => {
  const commands = [];
  const harness = componentHarness(orderPath, 'master_admin', async () => {});
  const props = { item: paidOrder({}), busy: false, execute: async command => { commands.push(command); } };
  let tree = harness.render(props);
  assert.equal(button(tree, 'Confirmar pago recibido').props.disabled, true);
  button(tree, 'Registrar aceptación').props.onClick();
  tree = harness.render(props);
  assert.equal(button(tree, 'Confirmar registro').props.disabled, true);
  elements(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = harness.render(props);
  await button(tree, 'Confirmar registro').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands[0].action, 'acceptPhotoBackupQuote');
  assert.equal(commands[0].body.acceptanceConfirmed, true);
  assert.equal(commands[0].body.paymentConfirmed, undefined);
  const accepted = { ...props, item: paidOrder({ quote_accepted_at: '2026-10-07T05:00:00Z' }) };
  tree = harness.render(accepted);
  button(tree, 'Confirmar pago recibido').props.onClick();
  tree = harness.render(accepted);
  elements(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = harness.render(accepted);
  assert.equal(button(tree, 'Confirmar registro').props.disabled, true);
  elements(tree).find(node => node.type === 'input' && node.props.name === 'payment_reference').props.onChange({ target: { value: 'PAGO-FICTICIO-2026' } });
  tree = harness.render(accepted);
  await button(tree, 'Confirmar registro').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands[1].action, 'confirmPhotoBackupPayment');
  assert.equal(commands[1].body.paymentConfirmed, true);
  assert.equal(commands[1].body.paymentReference, 'PAGO-FICTICIO-2026');
  assert.equal(commands.some(command => 'paid' in command.body || 'payment_status' in command.body), false);
});

test('cotización manual solo se presenta para originales >50GB y envía centavos USD', async () => {
  const commands = [];
  const harness = componentHarness(orderPath, 'master_admin', async () => {});
  const props = { item: paidOrder({ original_total_bytes: 50e9, quote_total_cents: null }), busy: false, execute: async command => {
    commands.push(command); return { quote_complete: true, original_total_bytes: 50e9 + 1, quote_total_cents: 5550 };
  } };
  assert.equal(elements(harness.render(props)).some(node => node.type === 'form'), false);
  const large = { ...props, item: paidOrder({ original_total_bytes: 50e9 + 1, quote_total_cents: null }) };
  let tree = harness.render(large);
  elements(tree).find(node => node.type === 'input' && node.props.name === 'manual_quote_usd').props.onChange({ target: { value: '55,50' } });
  tree = harness.render(large);
  elements(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands[0].body.manualTotalCents, 5550);
  tree = harness.render(large);
  assert.match(text(tree), /GB originales/);
  assert.match(text(tree), /IVA incluido/);
  assert.equal(button(tree, 'Registrar aceptación').props.disabled, false);
});

test('reintento SMTP usa acción independiente de aprobación e informa error sin simular éxito', async () => {
  const commands = [];
  const harness = componentHarness(orderPath, 'master_admin', async () => {});
  const props = { item: paidOrder({ status: 'READY', notification_error: 'SMTP_FAILED' }), busy: false,
    execute: async command => { commands.push(command); throw new Error('No se pudo enviar; intenta más tarde.'); } };
  let tree = harness.render(props);
  await button(tree, 'Reintentar avisos por correo').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = harness.render(props);
  assert.equal(commands[0].action, 'retryPhotoBackupNotifications');
  assert.match(text(tree), /No se pudo enviar/);
  assert.equal(commands.some(command => command.action === 'approvePhotoBackup'), false);
});

test('RECOVERY permite nube/exportación pero bloquea importación, restauración y snapshot manual', async () => {
  const calls = [];
  const restricted = { state: 'RECOVERY', canoperate: false, canexport: true, canimport: false, canrestore: false, can_manual_snapshot: false };
  const harness = componentHarness(backupPath, 'clinic_admin', async url => {
    calls.push(url);
    return json(url.includes('snapshots') ? { snapshots: [{ key: 'ficticia', kind: 'auto', created_at: '2026-10-06T05:00:00Z' }] }
      : { stats: {}, encryption_ready: true, manual_backup: { available: true } });
  }, restricted);
  let tree = await harness.mount();
  assert.equal(button(tree, 'Importar').props.disabled, true);
  button(tree, 'Nube').props.onClick();
  tree = harness.render();
  assert.equal(button(tree, 'Crear respaldo en la nube ahora').props.disabled, true);
  const restoreButton = button(tree, 'Restaurar…');
  assert.equal(restoreButton.props.disabled, true);
  // Incluso un handler invocado fuera del botón no debe enviar operaciones prohibidas.
  await restoreButton.props.onClick();
  assert.equal(calls.some(url => url.includes('action=restore')), false);
  assert.equal(elements(tree).some(node => node.props?.title === 'Descargar' && node.props.disabled === false), true);
});

test('delivery_only consulta solo estado anual y ofrece descargas, sin solicitud', async () => {
  const calls = [];
  const harness = componentHarness(annualPath, 'clinic_admin', async url => {
    calls.push(url);
    return json({ configured: false, eligible: true, requests: [{ id: 'ficticia', status: 'READY', created_at: '2026-10-06T05:00:00Z', parts: [{ index: 0 }] }] });
  }, { state: 'CLOSED', canoperate: false, canexport: false }, true);
  const tree = await harness.mount({ deliveryOnly: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /photoBackupStatus/);
  assert.equal(elements(tree).some(node => node.type === 'button' && text(node) === 'Solicitar Respaldo Anual'), false);
  assert.equal(elements(tree).some(node => node.type === 'button' && /Descargar/.test(text(node))), true);
});

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
    if (state === 'notready') assert.match(text(tree), /No se pudo verificar la disponibilidad/);
  });
}

for (const [quota, message] of [
  [null, /No se pudo verificar la disponibilidad/],
  [{ available: false, next_allowed_at: '2026-10-08T05:00:00Z' }, /Ya creaste una copia hoy/],
  [{ available: false, state: 'PROCESSING' }, /copia manual en curso/],
  [{ available: false, state: 'HISTORY_INCOMPLETE', reason: 'Historial no verificado' }, /Copia no disponible/],
  [{ available: true }, /Puedes crear una copia ahora/],
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
    { response: json({ snapshots: [] }), expected: /No hay copias automáticas registradas/ },
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

test('Base de Datos muestra acciones concretas sin límites ni detalles internos', async () => {
  const harness = componentHarness(backupPath, 'clinic_admin', async url =>
    json(url.includes('snapshots') ? { snapshots: [] } : { stats: {}, encryption_ready: true }));
  const tree = await harness.mount();
  assert.match(text(tree), /fotografías originales se solicitan por separado/);
  assert.match(text(tree), /todos los módulos de tu clínica/);
  assert.ok(hasCard(tree, 'Respaldo por módulos'));
  assert.doesNotMatch(text(tree), /límites|50 MiB|200 MiB|snapshot|checksums|Worker|SMTP/);
  assert.match(text(tree), /Descargar respaldo por lotes/);
  assert.match(text(tree), /conserva todas las partes descargadas/);
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

test('la restauración por lotes conserva y muestra un resultado final parcial', async () => {
  const { request, calls } = batchApi(1, { partial: true });
  const harness = componentHarness(backupPath, 'clinic_admin', request);
  let tree = await harness.mount();
  button(tree, 'Importar').props.onClick();
  selectBatchFile(harness.render(), batchFile(1));
  await waitFor(() => calls.length >= 3 && hasCard(harness.render(), 'Simulación completa por lotes'),
    `La simulación no verificó el trailer: ${JSON.stringify(calls)} ${text(harness.render())}`);
  tree = harness.render();
  assert.match(text(tree), /1 lotes verificados/);
  confirmBatch(tree, /Permito confirmar por lote/);
  tree = harness.render();
  confirmBatch(tree, /Revisé la simulación completa/);
  approveBatchRestore(harness, 'Restaurar todos los lotes');
  await waitFor(() => calls.some(call => call.phase === 'finish' && call.resumeToken === 'apply-1') &&
    text(harness.render()).includes('Restauración finalizada con resultado parcial'),
    'La aplicación por lotes no terminó');

  tree = harness.render();
  assert.match(text(tree), /Restauración finalizada con resultado parcial/);
  assert.match(text(tree), /El trailer del archivo sí fue verificado/);
  assert.match(text(tree), /Validación de QA/);
  const partialStatus = elements(tree).find(node => node.props?.role === 'status' &&
    text(node).includes('Restauración finalizada con resultado parcial'));
  assert.ok(partialStatus?.props.className.includes('bg-amber-50'));
  assert.equal(elements(tree).some(node => node.props?.role === 'status' &&
    node.props.className?.includes('bg-emerald-50') && /restauración/i.test(text(node))), false);
  assert.equal(elements(tree).some(node => node.type === 'button' && text(node) === 'Restaurar todos los lotes'), false,
    'Una restauración completa no debe ofrecer repetir la operación desde el mismo resumen');
  assert.ok(elements(tree).some(node => node.type === 'button' && text(node) === 'Nueva restauración'));
});

test('restauración interrumpida informa incertidumbre y reiniciar el mismo archivo es idempotente', async () => {
  const { request, calls } = batchApi(2, { loseFirstResponse: true });
  const harness = componentHarness(backupPath, 'clinic_admin', request);
  const file = batchFile(2);
  let tree = await harness.mount();
  button(tree, 'Importar').props.onClick();
  selectBatchFile(harness.render(), file);
  await waitFor(() => calls.length >= 4 && hasCard(harness.render(), 'Simulación completa por lotes'),
    `La simulación no verificó el trailer: ${JSON.stringify(calls)} ${text(harness.render())}`);
  tree = harness.render();
  confirmBatch(tree, /Revisé la simulación completa/);
  approveBatchRestore(harness, 'Restaurar todos los lotes');
  await waitFor(() => text(harness.render()).includes('Restauración incompleta:'),
    'La interfaz no informó la restauración interrumpida');
  tree = harness.render();
  assert.match(text(tree), /El lote interrumpido pudo haberse aplicado/);
  assert.match(text(tree), /No se verificó el trailer/);
  const interruptedStatus = elements(tree).find(node => node.props?.role === 'status' &&
    text(node).includes('Restauración incompleta:'));
  assert.ok(interruptedStatus?.props.className.includes('bg-amber-50'));
  assert.equal(elements(tree).some(node => node.props?.role === 'status' &&
    node.props.className?.includes('bg-emerald-50') && /restauración/i.test(text(node))), false);
  assert.ok(elements(tree).some(node => node.type === 'button' && text(node) === 'Reanudar por lotes'));

  button(tree, 'Cancelar').props.onClick();
  selectBatchFile(harness.render(), file);
  await waitFor(() => calls.filter(call => call.phase === 'finish' && call.resumeToken === 'dry-2').length === 2 &&
    hasCard(harness.render(), 'Simulación completa por lotes'),
    'No se pudo volver a simular el archivo al reintentar');
  tree = harness.render();
  confirmBatch(tree, /Revisé la simulación completa/);
  approveBatchRestore(harness, 'Restaurar todos los lotes');
  await waitFor(() => calls.some(call => call.phase === 'finish' && call.resumeToken === 'apply-2') &&
    text(harness.render()).includes('Restauración completa: 2 lotes confirmados'),
    'El reintento idempotente no terminó');

  const appliedIndexes = calls.filter(call => call.phase === 'batch' && !call.dryRun).map(call => call.index);
  assert.deepEqual(appliedIndexes, [0, 1, 0, 1]);
  tree = harness.render();
  assert.match(text(tree), /Restauración completa: 2 lotes confirmados y trailer verificado/);
  assert.doesNotMatch(text(tree), /Restauración por lotes interrumpida/);
});

test('El canal anual apagado conserva coordinación asistida sin solicitudes automáticas', async () => {
  const calls = [];
  const harness = componentHarness(annualPath, 'clinic_admin', async url => {
    calls.push(url);
    return json({ configured: false, eligible: false, reason: 'feature_disabled', requests: [] });
  });
  const tree = await harness.mount();
  assert.match(text(tree), /Contacta a soporte para solicitar tu respaldo anual/);
  assert.doesNotMatch(text(tree), /Worker|SMTP|esquema|todavía no está habilitado|feature_disabled/);
  assert.equal(button(tree, 'Solicitar Respaldo Anual').props.disabled, true);
  assert.equal(calls.length, 1);
});

for (const configured of [false, true, undefined]) {
  test(`Master conserva configured y bloquea período/aprobación: ${configured}`, async () => {
    const calls = [];
    const request = async url => {
      calls.push(url);
      return json({ configured, processor_ready: configured === true, reason: configured === false ? 'feature_disabled' : null, requests: [
        { id: 'request-test', status: 'PENDING', created_at: '2026-10-01', clinic_id: 'clinic-test' },
      ] });
    };
    const harness = componentHarness(annualPath, 'master_admin', request);
    const tree = await harness.mount({ master: true });
    assert.equal(button(tree, 'Registrar período').props.disabled, configured !== true);
    assert.equal(button(tree, 'Aprobar').props.disabled, configured !== true);
    if (configured === false) {
      assert.match(text(tree), /Contacta a soporte para solicitar tu respaldo anual/);
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
  assert.match(text(tree), /Vigencia sugerida/);
  assert.doesNotMatch(text(tree), /vencimiento de suscripción menos|no determina el período contractual anual/);
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
  assert.equal((backup.match(/\bfetch\(/g) || []).length, 4);
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
