import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { getTurnstileAllowedHosts, verifyTurnstileToken } from '../api/public-booking.js';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
  TURNSTILE_HOSTNAMES: process.env.TURNSTILE_HOSTNAMES,
  APP_URL: process.env.APP_URL,
};
const originalFetch = globalThis.fetch;
const request = {
  headers: { 'x-forwarded-for': '203.0.113.10' },
  socket: {},
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

test('Turnstile normalizes explicit and application hostnames', () => {
  process.env.NODE_ENV = 'production';
  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app, https://preview.example.com/path';
  process.env.APP_URL = 'https://bioskin.example.com/';
  assert.deepEqual(getTurnstileAllowedHosts(), [
    'bioskintech.vercel.app',
    'preview.example.com',
    'bioskin.example.com',
  ]);
});

test('Turnstile accepts only the booking action and an allowed hostname', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TURNSTILE_SECRET = 'secret';
  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app';
  delete process.env.APP_URL;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = new URLSearchParams(options.body);
    assert.ok(options.signal);
    return {
      ok: true,
      json: async () => ({ success: true, action: 'public_booking', hostname: 'bioskintech.vercel.app' }),
    };
  };

  assert.deepEqual(await verifyTurnstileToken(request, 'valid-token'), { ok: true });
  assert.equal(requestBody.get('response'), 'valid-token');
  assert.equal(requestBody.get('remoteip'), '203.0.113.10');
});

test('Turnstile fails closed for invalid configuration, action, hostname and token length', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TURNSTILE_SECRET = 'secret';
  delete process.env.TURNSTILE_HOSTNAMES;
  delete process.env.APP_URL;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ success: true, action: 'other_action', hostname: 'evil.example' }) };
  };

  assert.equal((await verifyTurnstileToken(request, 'token')).status, 503);
  assert.equal((await verifyTurnstileToken(request, 'x'.repeat(2049))).status, 403);
  assert.equal((await verifyTurnstileToken(request, `token${' '.repeat(2044)}`)).status, 403);
  assert.equal(fetchCalls, 0);

  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app';
  assert.equal((await verifyTurnstileToken(request, 'token')).status, 403);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, action: 'public_booking', hostname: 'evil.example' }),
  });
  assert.equal((await verifyTurnstileToken(request, 'token')).status, 403);
});

test('Turnstile converts Siteverify transport failures into a closed 503 response', async () => {
  process.env.NODE_ENV = 'production';
  process.env.TURNSTILE_SECRET = 'secret';
  process.env.TURNSTILE_HOSTNAMES = 'bioskintech.vercel.app';
  delete process.env.APP_URL;
  globalThis.fetch = async () => {
    throw new Error('network unavailable');
  };

  const result = await verifyTurnstileToken(request, 'valid-token');
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
