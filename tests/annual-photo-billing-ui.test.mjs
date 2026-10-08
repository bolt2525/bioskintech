import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function compile(path, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, Number, Intl, Error, Set, ...globals, require: name => {
    if (name in imports) return imports[name];
    throw new Error(`Dependencia sin controlar: ${name}`);
  } });
  return exports;
}
const helpers = compile('utils/annualPhotoBackup.ts');
test('solicitudes usan can_request; aprobación exige Worker y pago servidor de las adicionales', () => {
  assert.equal(helpers.annualCanRequest({ configured: true, eligible: false, can_request: true }), true);
  assert.equal(helpers.annualCanRequest({ configured: true, eligible: true }), false);
  assert.equal(helpers.annualCanRequest(null), false);
  for (const status of ['PENDING', 'APPROVED', 'FAILED']) {
    assert.equal(helpers.annualCanApprove({ status, entitlement_kind: 'FREE' }, false), false);
    assert.equal(helpers.annualCanApprove({ status, entitlement_kind: 'PAID', payment_status: 'NEEDS_QUOTE' }, true), false);
    assert.equal(helpers.annualCanApprove({ status, entitlement_kind: 'PAID', payment_status: 'PAID' }, true), true);
  }
  for (const status of ['PAYMENT_PENDING', 'NEEDS_QUOTE', 'READY', 'EXPIRED', 'REJECTED'])
    assert.equal(helpers.annualCanApprove({ status, entitlement_kind: 'PAID', payment_status: 'PAID' }, true), false);
});
test('USD en centavos y GB decimales no confunden ZIP/MiB ni infieren precio con datos faltantes', () => {
  assert.equal(helpers.manualQuoteCents('55,50'), 5550);
  assert.equal(helpers.manualQuoteCents('55.5'), 5550);
  assert.equal(helpers.manualQuoteCents('0.01'), 1);
  for (const value of ['0', '-1', 'abc', '1.234', '1e3', 'Infinity', '1000000.01'])
    assert.throws(() => helpers.manualQuoteCents(value));
  assert.match(helpers.annualOriginalSize(5e9), /5 GB originales/);
  assert.match(helpers.annualOriginalSize(null), /no verificado/);
  assert.equal(helpers.annualMoney(null), 'Cotización pendiente');
  assert.match(helpers.annualMoney(1000), /10/);
});

function providerHarness(request) {
  const slots = []; let cursor = 0; let effects = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useCallback: callback => callback,
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect: callback => { effects.push(callback); },
  };
  const module = compile('hooks/useAnnualPhotoProviderStatus.ts', {
    react: hooks, '../utils/recordsFetch': { __esModule: true, default: request },
  }, { window: { setInterval: () => 1, clearInterval() {} } });
  return {
    render(enabled = true) { cursor = 0; effects = []; return module.useAnnualPhotoProviderStatus(enabled); },
    async mount(enabled = true) {
      this.render(enabled);
      for (const effect of effects) effect();
      await new Promise(resolve => setImmediate(resolve));
      return this.render(enabled);
    },
  };
}
test('contador proveedor usa pending_count persistente y deduplica fallos sin datos clínicos', async () => {
  const calls = [];
  let fail = false;
  const harness = providerHarness(async url => {
    calls.push(url);
    if (fail) throw new Error('Sin conexión');
    return { ok: true, json: async () => ({
      configured: true, processor_ready: false, pending_count: 107,
      requests: [{ id: 'pedido-ficticio', notification_error: 'SMTP_FAILED' }],
      notifications: [{ request_id: 'pedido-ficticio', status: 'FAILED' }, { request_id: 'pedido-ficticio', status: 'FAILED' },
        { request_id: 'otro-pedido-ficticio', status: 'FAILED' }, { request_id: 'enviado-ficticio', status: 'SENT' }],
    }) };
  });
  let state = await harness.mount();
  assert.equal(state.pendingCount, 107, 'no usa longitud de lista limitada');
  assert.equal(state.failedCount, 2);
  assert.deepEqual(calls, ['/api/backup?action=listPhotoBackupRequests']);
  fail = true;
  await state.refresh();
  state = harness.render();
  assert.equal(state.pendingCount, 107, 'un fallo no borra pendientes conocidos');
  assert.match(state.error, /No se pudo actualizar/);
  state.update({ configured: true, processor_ready: false, pending_count: 0, requests: [], notifications: [] });
  state = harness.render();
  assert.equal(state.pendingCount, 0);
  assert.equal(state.failedCount, 0);
  assert.equal(state.error, '');
});
test('hook proveedor no consulta el endpoint para roles no autorizados y faltantes no se presentan como cero', async () => {
  let calls = 0;
  const harness = providerHarness(async () => { calls++; return { ok: true, json: async () => ({ requests: [] }) }; });
  let state = await harness.mount(false);
  assert.equal(calls, 0);
  assert.equal(state.pendingCount, null);
  state = await harness.mount(true);
  assert.equal(calls, 1);
  assert.equal(state.pendingCount, null);
});
test('un contador tardío no sobrescribe el estado fresco de una acción del proveedor', async () => {
  let resolve;
  const harness = providerHarness(() => new Promise(done => { resolve = done; }));
  const state = harness.render();
  const pending = state.refresh();
  state.update({ configured: true, pending_count: 0, requests: [], notifications: [] });
  resolve({ ok: true, json: async () => ({ configured: true, pending_count: 3, requests: [], notifications: [] }) });
  await pending;
  assert.equal(harness.render().pendingCount, 0);
});
test('integración de campana Master y tarjeta anual limita UI a metadatos y comandos existentes', () => {
  const master = source('pages/AdminMasterDashboard.tsx');
  assert.match(master, /useAnnualPhotoProviderStatus\(user\?\.role === 'master_admin'\)/);
  assert.match(master, /onProviderStatus=\{annualProvider.update\}/);
  assert.match(master, /setTab\('photo-backups'\)/);
  assert.match(master, /annualProvider.pendingCount/);
  const order = source('components/admin/AnnualPhotoBackupOrder.tsx');
  assert.match(order, /bytes > 50e9/);
  assert.match(order, /acceptanceConfirmed: true/);
  assert.match(order, /paymentConfirmed: true, paymentReference: paymentReference.trim\(\)/);
  assert.doesNotMatch(order, /paid:\s*true|payment_status:\s*'PAID'|fetch\(/);
  const panel = source('components/admin/AnnualPhotoBackupPanel.tsx');
  assert.doesNotMatch(panel, /notification\.last_error|requester_email|snapshot_data/);
  assert.match(panel, /retryPhotoBackupNotifications/);
});
