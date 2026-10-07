import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/components/admin/ContractGenerator.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
}).outputFiles[0].text;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const ContractGenerator = module.exports.default;

test('legal versions stay synchronized between server and published documents', () => {
  const frontend = readFileSync(new URL('../src/components/legal/LegalLayout.tsx', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../api/admin-auth.js', import.meta.url), 'utf8');
  const version = frontend.match(/export const LEGAL_VERSION = '([^']+)'/)[1];
  assert.equal(backend.match(/export const LEGAL_VERSION = '([^']+)'/)[1], version);
  assert.equal(version, '2026-10-06');
});

test('default natural-person contract does not require a legal representative', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(html, /Persona natural, por sus propios derechos/);
  assert.doesNotMatch(html, /<input[^>]*name="representative"/);
  assert.doesNotMatch(html, /<input[^>]*name="representativeId"/);
  assert.doesNotMatch(html, /<input[^>]*name="representativeRole"/);
  assert.match(html, /name="clinicName"/);
});

test('default package excludes chatbot and does not silently enable negotiated annex', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(html, /Excluido:.*?chatbot WhatsApp del sistema/);
  assert.doesNotMatch(html, /servicio opcional contratado durante esta vigencia anual/);
  assert.doesNotMatch(html, /B\.1\. Soporte y clasificación/);
  assert.match(html, /dolo, culpa grave/);
});

test('printed privacy safeguards disclose plan coverage and do not claim photographic backups', () => {
  const html = renderToStaticMarkup(React.createElement(ContractGenerator));
  assert.match(html, /vercel\.com\/legal\/dpa/);
  assert.match(html, /no se presume su cobertura en Hobby/);
  assert.match(html, /neon\.com\/platform-terms/);
  assert.match(html, /cloudflare-customer-dpa/);
  assert.match(html, /las fotografías no forman parte de los respaldos/);
});

test('registration and invitation reject stale or missing legal versions before database operations', async () => {
  const { default: handler } = await import('../api/admin-auth.js');
  for (const action of ['register', 'useInvite']) {
    for (const version of [undefined, '2026-10-01']) {
      let status;
      let response;
      const res = {
        setHeader() {},
        status(value) { status = value; return this; },
        json(value) { response = value; return this; },
      };
      await handler({
        method: 'POST',
        query: { action },
        headers: {},
        body: { accepted_terms: true, accepted_legal_version: version },
      }, res);
      assert.equal(status, 400, `${action}: reject version ${version}`);
      assert.match(response.error, /versión|actualiz/i);
    }
  }
});

test('both onboarding forms submit the displayed legal version', () => {
  for (const page of ['AdminRegister', 'InviteRegister']) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /import \{ LEGAL_VERSION \}/);
    assert.match(source, /accepted_legal_version: LEGAL_VERSION/);
  }
});
