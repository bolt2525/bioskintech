import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], external = [], writes = [];
  let deny = false, enabled = false, hold;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
    if (url.pathname === '/api/admin-auth') {
      if (url.searchParams.get('action') === 'getUserModuleOverrides') {
        return route.fulfill({ json: { overrides: enabled ? [{ feature: 'skin_visual_ai', enabled: true }] : [] } });
      }
      const body = request.postDataJSON(); writes.push(body);
      if (hold) await hold;
      if (deny) return route.fulfill({ status: 403, json: { error: 'Sin permiso para cambiar este usuario.' } });
      enabled = body.enabled;
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname !== '/__skin_permission_test__') return route.continue();
    const response = await route.fetch(), html = await response.text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import Permission from '/src/components/admin/UserSkinVisualPermission.tsx';
      import '/src/index.css';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      window.mountPermission = (userId, clinicEnabled=true) => root.render(React.createElement(Permission, {userId, clinicEnabled}));
      window.mountPermission(12);
      </script>`;
    const body = html.replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script)
      .replace(/<link[^>]+(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/g, '');
    assert.notEqual(body, html);
    return route.fulfill({ response, body });
  });
  await page.goto(origin + '/__skin_permission_test__');
  const checkbox = page.getByRole('checkbox', { name: 'Análisis visual Gemini para este usuario' });
  await checkbox.waitFor(); await checkbox.isEnabled();
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  assert.equal(await checkbox.isChecked(), false);
  deny = true;
  await checkbox.click();
  await page.getByRole('alert').filter({ hasText: 'Sin permiso' }).waitFor();
  assert.equal(await checkbox.isChecked(), false, 'no confirmar permiso si el servidor rechaza');
  deny = false;
  await checkbox.click();
  await page.getByRole('status').filter({ hasText: 'habilitado' }).waitFor();
  assert.equal(await checkbox.isChecked(), true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await checkbox.isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.evaluate(() => window.mountPermission(12, false));
  assert.equal(await checkbox.isEnabled(), true, 'se puede revocar aunque la clínica esté apagada');
  await checkbox.click();
  await page.getByRole('status').filter({ hasText: 'revocado' }).waitFor();
  assert.equal(await checkbox.isEnabled(), false);
  await page.evaluate(() => window.mountPermission(12, true));
  let release;
  hold = new Promise(resolve => { release = resolve; });
  await checkbox.click();
  await page.getByRole('status').filter({ hasText: 'Guardando' }).waitFor();
  await page.evaluate(() => window.mountPermission(13, true));
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  release(); hold = undefined;
  await page.waitForTimeout(100);
  assert.equal(await checkbox.isChecked(), false, 'respuesta del usuario anterior no habilita al nuevo');
  assert.equal(await page.getByRole('status').count(), 0);
  assert.ok(writes.every(item => item.feature === 'skin_visual_ai' && typeof item.enabled === 'boolean'));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, explicitOptIn: true, deniedWritePreservesState: true,
    revokeWhileClinicDisabled: true, staleUserResponseIgnored: true, viewports: [1440, 390], externalRequests: external.length }));
} finally { await browser.close(); }
