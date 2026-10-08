import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const react = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function load(path, imports = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Date, Intl, console, ...globals,
    require: name => {
      if (name in imports) return imports[name];
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      throw new Error(`Import no controlado: ${name}`);
    },
  });
  return exports;
}
const accessModule = load('utils/subscriptionAccess.ts');
const { subscriptionAccess, sessionUser, subscriptionRoute, subscriptionMessage, clinicSubscriptionStatus } = accessModule;
const { policyEnrollment, EMPTY_ENROLLMENT } = load('utils/subscriptionEnrollment.ts');
const lifecycle = (state, overrides = {}) => ({
  state, policy: 'paid', policyVersion: 'paid-grace15-recovery30-v1', policy_accepted: true,
  enrollment_status: 'ENROLLED', opt_in: true, auto_purge_eligible: true,
  effective_at: '2026-10-01T05:00:00Z', expires_at: '2026-10-07T05:00:00Z',
  grace_ends_at: '2026-10-22T05:00:00Z', recovery_ends_at: '2026-11-21T05:00:00Z',
  purge_after: '2026-11-21T05:00:00Z', remainingdays: state === 'CLOSED' ? 0 : 15,
  canoperate: ['ACTIVE', 'GRACE'].includes(state), canexport: state !== 'CLOSED',
  canlogin: state !== 'CLOSED', canimport: ['ACTIVE', 'GRACE'].includes(state),
  canrestore: ['ACTIVE', 'GRACE'].includes(state), can_manual_snapshot: ['ACTIVE', 'GRACE'].includes(state),
  can_auto_backup: ['ACTIVE', 'GRACE'].includes(state), ...overrides,
});
const user = (state, role = 'clinic_admin', extra = {}) => ({
  username: 'prueba', role, clinic_id: 'ficticia', clinic_slug: 'prueba-ui', access_scope: 'all',
  subscription_lifecycle: lifecycle(state), ...extra,
});

for (const state of ['ACTIVE', 'GRACE', 'RECOVERY', 'CLOSED']) {
  for (const role of ['clinic_admin', 'clinic_user', 'master_admin']) {
    test(`capacidades UI intersectan ${state} / ${role}`, () => {
      const access = subscriptionAccess(user(state, role));
      const operational = role === 'master_admin' || ['ACTIVE', 'GRACE'].includes(state);
      assert.equal(access.canOperate, operational);
      assert.equal(access.canImport, operational && role !== 'clinic_user');
      assert.equal(access.canRestore, operational && role !== 'clinic_user');
      assert.equal(access.canManualSnapshot, operational && role !== 'clinic_user');
      assert.equal(access.canAutoBackup, operational);
      assert.equal(access.canExport, role === 'master_admin' || (role === 'clinic_admin' && state !== 'CLOSED'));
    });
  }
}
test('delivery_only nunca habilita exportación, escrituras ni solicitud anual', () => {
  for (const state of ['ACTIVE', 'GRACE', 'RECOVERY', 'CLOSED']) {
    const access = subscriptionAccess(user(state, 'clinic_admin', { delivery_only: true }));
    for (const key of ['canOperate', 'canExport', 'canImport', 'canRestore', 'canManualSnapshot', 'canAutoBackup', 'canRequestAnnual'])
      assert.equal(access[key], false, key);
    assert.equal(access.canAnnualDelivery, true);
    assert.equal(subscriptionRoute(user(state, 'clinic_admin', { delivery_only: true }), '/admin/finance'), 'delivery');
  }
  assert.equal(subscriptionAccess(user('CLOSED', 'clinic_user', { delivery_only: true })).canAnnualDelivery, false);
});
test('flags del servidor prevalecen sobre estado; faltantes legacy/demo conservan comportamiento', () => {
  const restricted = user('ACTIVE', 'clinic_admin', { subscription_lifecycle: lifecycle('ACTIVE', {
    canimport: false, canrestore: false, canexport: false, can_manual_snapshot: false, can_auto_backup: false,
  }) });
  const result = subscriptionAccess(restricted);
  for (const key of ['canImport', 'canRestore', 'canExport', 'canManualSnapshot', 'canAutoBackup']) assert.equal(result[key], false);
  for (const is_demo of [false, true]) {
    assert.equal(subscriptionAccess(user('ACTIVE', 'clinic_admin', { subscription_lifecycle: undefined, is_demo })).canOperate, true);
  }
  assert.equal(subscriptionAccess(null).canOperate, false);
  assert.equal(subscriptionAccess(user('CLOSED', 'clinic_admin', { subscription_lifecycle: lifecycle('CLOSED', { policy: 'invalid' }) })).canOperate, false);
});
test('auth normaliza top-level login/verify/OTP sin perder campos; null explícito prevalece', () => {
  const old = user('ACTIVE');
  const result = sessionUser({ user: old, subscription_lifecycle: lifecycle('RECOVERY'), delivery_only: true });
  assert.equal(result.subscription_lifecycle.state, 'RECOVERY');
  assert.equal(result.delivery_only, true);
  assert.equal(old.subscription_lifecycle.state, 'ACTIVE');
  assert.equal(sessionUser({ user: old, subscription_lifecycle: null }).subscription_lifecycle, null);
  assert.equal(sessionUser({ user: old }).subscription_lifecycle.state, 'ACTIVE');
});
test('RECOVERY bloquea todas las URLs clínicas anidadas y legacy antes de montar módulos', () => {
  const paths = ['/admin/calendar', '/admin/clinical-records/new', '/admin/ficha-clinica/paciente/9',
    '/admin/prueba-ui/prueba/clinical-records/edit/9', '/admin/prueba-ui/prueba/ficha-clinica/expediente/9',
    '/admin/prueba-ui/prueba/finance', '/admin/master/otra/usuario/backup', '/admin/skin-explorer'];
  for (const path of paths) {
    assert.equal(subscriptionRoute(user('RECOVERY'), path), 'redirect', path);
    assert.equal(subscriptionRoute(user('RECOVERY', 'clinic_user'), path), 'blocked', path);
    assert.equal(subscriptionRoute(user('GRACE'), path), 'normal', path);
  }
  for (const path of ['/admin', '/admin/prueba-ui/prueba']) assert.equal(subscriptionRoute(user('RECOVERY'), path), 'dashboard');
  for (const path of ['/admin/backup', '/admin/prueba-ui/prueba/backup']) assert.equal(subscriptionRoute(user('RECOVERY'), path), 'backup');
  assert.equal(subscriptionRoute(user('CLOSED'), '/admin/backup'), 'blocked');
});
test('banners usan límites EC y plazos 15+30; nunca cuentan vencimientos negativos', () => {
  assert.match(subscriptionMessage(lifecycle('GRACE')), /15 días.*30 días/);
  assert.match(subscriptionMessage(lifecycle('GRACE')), /22 oct.*Ecuador/);
  assert.match(subscriptionMessage(lifecycle('RECOVERY')), /45 días.*vencimiento/);
  assert.match(subscriptionMessage(lifecycle('RECOVERY', { remainingdays: -1 })), /0 días restantes/);
  const status = clinicSubscriptionStatus({ subscription_lifecycle: lifecycle('RECOVERY') });
  assert.equal(status.state, 'RECOVERY');
  assert.match(status.baseline, /15 \+ 30/);
  const legacy = clinicSubscriptionStatus({ subscription_expires_at: '2026-10-01T05:00:00Z' }, Date.parse('2026-10-07T05:00:00Z'));
  assert.match(legacy.baseline, /legacy.*21 días/);
  assert.match(clinicSubscriptionStatus({ subscription_lifecycle: lifecycle('ACTIVE', { enrollment_status: 'SCHEDULED' }) }).baseline, /programada/);
});
test('inscripción exige acuerdo explícito y fechas prospectivas; no se activa al renovar', () => {
  const now = Date.parse('2026-10-07T17:00:00Z');
  const end = now + 365 * 86400000;
  assert.equal(policyEnrollment(EMPTY_ENROLLMENT, end, now), undefined);
  const draft = { enabled: true, acceptanceConfirmed: true, basis: 'addendum', contractReference: 'ADENDA-PRUEBA-2026',
    acceptedAt: '2026-10-06T17:00:00Z', effectiveAt: '2026-10-08T17:00:00Z' };
  const result = policyEnrollment(draft, end, now);
  assert.equal(result.policy_version, 'paid-grace15-recovery30-v1');
  assert.equal(result.opt_in, true);
  assert.equal(result.acceptance_confirmed, true);
  assert.equal(result.effective_at, '2026-10-08T17:00:00.000Z');
  for (const patch of [{ acceptanceConfirmed: false }, { contractReference: 'corto' }, { effectiveAt: '2026-10-06T17:00:00Z' },
    { acceptedAt: '2026-10-09T17:00:00Z' }, { effectiveAt: '2028-10-08T17:00:00Z' }, { contractReference: 'referencia\u0000invalida' }])
    assert.throws(() => policyEnrollment({ ...draft, ...patch }, end, now));
});

function authHarness(storedUser, request) {
  const storage = new Map([['adminSessionToken', 'token-ficticio'], ['adminUser', JSON.stringify(storedUser)]]);
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const slots = []; let cursor = 0;
  const hooks = {
    ...react,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: fn => fn, useEffect() {},
  };
  const provider = load('context/AuthContext.tsx', {
    react: hooks, '../utils/subscriptionAccess': accessModule,
  }, { sessionStorage, localStorage: { getItem: () => null }, fetch: request });
  return {
    sessionStorage,
    render() { cursor = 0; return provider.AuthProvider({ children: null }).props.value; },
  };
}
const response = body => ({ ok: true, json: async () => body });
test('storage nunca concede features antes de verify; renovación recupera solo las originales', async () => {
  const original = ['calendar', 'backup'];
  let state = 'RECOVERY';
  const harness = authHarness({ ...user('ACTIVE'), features: original }, async () => response({
    success: true, valid: true, user: user(state), features: original, subscription_lifecycle: lifecycle(state),
  }));
  let auth = harness.render();
  assert.equal(auth.isAuthVerified, false);
  assert.equal(auth.isAuthenticated, false);
  assert.equal(auth.hasFeature('calendar'), false);
  await auth.checkAuth();
  auth = harness.render();
  assert.equal(auth.hasFeature('calendar'), false);
  assert.equal(auth.hasFeature('backup'), true);
  assert.deepEqual(Array.from(auth.features), original);
  state = 'ACTIVE';
  await auth.checkAuth();
  auth = harness.render();
  assert.equal(auth.hasFeature('calendar'), true);
  assert.equal(auth.hasFeature('finance'), false);
  assert.deepEqual(JSON.parse(harness.sessionStorage.getItem('adminUser')).features, original);
});
test('verify comparte peticiones y un resultado tardío no resucita logout', async () => {
  let resolve; let calls = 0;
  const harness = authHarness(user('RECOVERY'), async url => {
    if (url.includes('logout')) return response({});
    calls++;
    return new Promise(done => { resolve = done; });
  });
  const auth = harness.render();
  const pending = auth.checkAuth();
  assert.equal(auth.checkAuth(), pending);
  assert.equal(calls, 1);
  auth.logout();
  resolve(response({ success: true, valid: true, user: user('ACTIVE'), features: ['calendar'] }));
  assert.equal(await pending, false);
  assert.equal(harness.render().isAuthenticated, false);
  assert.equal(harness.sessionStorage.getItem('adminUser'), null);
});
test('login aplica ciclo top-level y conserva features incluso en entrega exclusiva', async () => {
  const harness = authHarness(user('ACTIVE'), async () => response({
    success: true, sessionToken: 'token-login-ficticio', user: user('ACTIVE'),
    subscription_lifecycle: lifecycle('CLOSED'), delivery_only: true, features: ['calendar', 'backup'],
  }));
  const result = await harness.render().login('prueba', 'ficticia');
  assert.equal(result.ok, true);
  assert.equal(result.user.subscription_lifecycle.state, 'CLOSED');
  const auth = harness.render();
  assert.equal(auth.hasFeature('calendar'), false);
  assert.equal(auth.hasFeature('backup'), true);
  assert.deepEqual(Array.from(auth.features), ['calendar', 'backup']);
  const saved = JSON.parse(harness.sessionStorage.getItem('adminUser'));
  assert.equal(saved.delivery_only, true);
  assert.equal(saved.subscription_lifecycle.state, 'CLOSED');
});
test('cambiar token no reutiliza verify anterior ni sobrescribe el nuevo ciclo', async () => {
  const pending = [];
  const harness = authHarness(user('ACTIVE'), () => new Promise(resolve => pending.push(resolve)));
  const first = harness.render().checkAuth();
  harness.sessionStorage.setItem('adminSessionToken', 'otro-token-ficticio');
  const second = harness.render().checkAuth();
  assert.equal(pending.length, 2);
  pending[1](response({ success: true, valid: true, user: user('RECOVERY'), features: ['backup'] }));
  assert.equal(await second, true);
  pending[0](response({ success: true, valid: true, user: user('ACTIVE'), features: ['calendar'] }));
  assert.equal(await first, false);
  assert.equal(harness.render().user.subscription_lifecycle.state, 'RECOVERY');
});
test('fallo de verify no permite operar desde el storage anterior', async () => {
  const harness = authHarness({ ...user('ACTIVE'), features: ['calendar'] }, async () => { throw new Error('Sin conexión'); });
  assert.equal(await harness.render().checkAuth(), false);
  const auth = harness.render();
  assert.equal(auth.isAuthenticated, false);
  assert.equal(auth.hasFeature('calendar'), false);
});
test('formulario contractual no asume aceptación ni elegibilidad y conserva API existente', () => {
  const Fields = load('components/admin/SubscriptionEnrollmentFields.tsx', { react: { ...react, useId: () => 'enrollment-test' } }).default;
  const tree = Fields({ value: EMPTY_ENROLLMENT, eligible: false, onChange() {} });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<input\b(?=[^>]*name="policy_opt_in")(?=[^>]*disabled)/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /No cambia un contrato existente sin acuerdo/);
  const master = source('pages/AdminMasterDashboard.tsx');
  const handler = master.slice(master.indexOf('const handleUpdateSubscription ='), master.indexOf('/** Genera contraseña'));
  assert.match(handler, /action=updateClinicSubscription/);
  assert.match(handler, /subscription_kind: 'paid', policy_enrollment: enrollment/);
  assert.match(handler, /!response.ok \|\| !data.success/);
  assert.doesNotMatch(handler, /setFeatData|setFeature|ALL_FEATURES/);
  assert.match(master, /labelledBy=\{subTitleId\}/);
  const app = source('App.tsx');
  assert.match(app, /<SubscriptionGate>[\s\S]*<Routes>[\s\S]*<\/Routes>[\s\S]*<\/SubscriptionGate>/);
});
test('guard renderizado no monta módulos ni aceptación legal en recuperación/entrega/cierre', () => {
  let mounts = 0;
  const SensitiveModule = () => { mounts++; return react.createElement('p', null, 'Módulo clínico'); };
  for (const [person, verified, path, expected] of [
    [user('ACTIVE'), false, '/admin/calendar', /Verificando acceso/],
    [user('RECOVERY'), true, '/admin/finance', /Redirección/],
    [user('RECOVERY'), true, '/admin', /Base de Datos/],
    [user('CLOSED'), true, '/admin/backup', /acceso operativo está bloqueado/i],
    [user('CLOSED', 'clinic_admin', { delivery_only: true }), true, '/admin/finance', /Entrega anual mínima/],
  ]) {
    const Gate = load('components/layout/SubscriptionGate.tsx', {
      '../../hooks/useAuth': { useAuth: () => ({ user: person, isAuthenticated: true, isAuthVerified: verified }) },
      '../../utils/subscriptionAccess': accessModule,
      'react-router-dom': { useLocation: () => ({ pathname: path }), Navigate: () => 'Redirección', Link: props => react.createElement('a', null, props.children) },
      '../admin/AnnualPhotoBackupPanel': { __esModule: true, default: () => 'Entrega anual mínima' },
      './AdminLayout': { __esModule: true, default: props => react.createElement('div', null, props.children) },
      './SubscriptionBanner': { __esModule: true, default: () => null },
      './LegalAcceptanceGate': { __esModule: true, default: () => { throw new Error('No debe montar aceptación legal restringida'); } },
    }).default;
    const html = renderToStaticMarkup(react.createElement(Gate, null, react.createElement(SensitiveModule)));
    assert.match(html, expected);
    assert.doesNotMatch(html, /Módulo clínico/);
  }
  assert.equal(mounts, 0);
});
