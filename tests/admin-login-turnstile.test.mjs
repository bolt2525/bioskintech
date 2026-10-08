import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach } from 'node:test';

import { verifyTurnstileToken } from '../lib/turnstile.js';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL: process.env.VERCEL,
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
  TURNSTILE_HOSTNAMES: process.env.TURNSTILE_HOSTNAMES,
  APP_URL: process.env.APP_URL,
};
const originalFetch = globalThis.fetch;
const request = {
  headers: { 'x-forwarded-for': '203.0.113.20' },
  socket: {},
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

test('admin login accepts only admin_login from an allowed hostname', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TURNSTILE_SECRET = 'secret';
  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app';
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, action: 'admin_login', hostname: 'bioskintech.vercel.app' }),
  });

  assert.deepEqual(await verifyTurnstileToken(request, 'valid-token', { action: 'admin_login' }), { ok: true });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, action: 'public_booking', hostname: 'bioskintech.vercel.app' }),
  });
  assert.equal((await verifyTurnstileToken(request, 'valid-token', { action: 'admin_login' })).status, 403);

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, action: 'admin_login', hostname: 'evil.example' }),
  });
  assert.equal((await verifyTurnstileToken(request, 'valid-token', { action: 'admin_login' })).status, 403);
  assert.equal((await verifyTurnstileToken(request, '', { action: 'admin_login' })).status, 403);
  assert.equal((await verifyTurnstileToken(request, 'x'.repeat(2049), { action: 'admin_login' })).status, 403);
});

test('admin login fails closed when Turnstile is missing or unavailable', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.TURNSTILE_SECRET;
  assert.equal((await verifyTurnstileToken(request, 'token', { action: 'admin_login' })).status, 503);
  process.env.NODE_ENV = 'development';
  process.env.VERCEL = '1';
  assert.equal((await verifyTurnstileToken(request, 'token', { action: 'admin_login' })).status, 503);

  process.env.TURNSTILE_SECRET = 'secret';
  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app';
  globalThis.fetch = async () => { throw new Error('network unavailable'); };
  assert.equal((await verifyTurnstileToken(request, 'token', { action: 'admin_login' })).status, 503);
});

test('login endpoint verifies Turnstile before calling credential authentication', () => {
  const source = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
  const loginBranch = source.slice(source.indexOf("if (action === 'login')"), source.indexOf("if (action === 'verify')"));
  assert.ok(loginBranch.includes("action: req.body?.master_key ? 'admin_master_login' : 'admin_login'"));
  assert.ok(loginBranch.indexOf('verifyTurnstileToken(') < loginBranch.indexOf('loginUser('));
  assert.match(loginBranch, /if \(!turnstile\.ok\)[\s\S]*return res\.status\(turnstile\.status\)/);
});

test('normal and master login send the token and render the scoped widget', () => {
  const expectedActions = new Map([
    ['AdminLogin.tsx', 'admin_login'],
    ['AdminMasterLogin.tsx', 'admin_master_login'],
  ]);
  for (const [page, action] of expectedActions) {
    const source = readFileSync(new URL(`../src/pages/${page}`, import.meta.url), 'utf8');
    assert.ok(source.includes(`action="${action}"`));
    assert.match(source, /turnstileToken/);
    assert.match(source, /setTurnstileResetKey/);
  }
});
