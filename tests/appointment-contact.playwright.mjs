import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:5183';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { success: true } });
    return route.continue();
  });
  await page.goto(base);
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AuthProvider } = await import('/src/context/AuthContext.tsx');
    const { default: CalendarManager } = await import('/src/components/CalendarManager.tsx');
    const user = { id: 'qa-user', username: 'qa', role: 'clinic_admin',
      clinic_id: 'qa-clinic', clinic_name: 'Clínica ficticia QA' };
    sessionStorage.setItem('adminSessionToken', 'ficticio-sin-validez');
    sessionStorage.setItem('adminUser', JSON.stringify(user));
    const descriptions = ['Teléfono: +34 (612) 345-678', 'Telefono: 001 (202) 555-0123',
      'Teléfono: 0991234567', 'Teléfono: 593991234567', 'Servicio: Otro',
      'Teléfono:\nEmail: prueba@example.test', 'Teléfono: 123'];
    const events = descriptions.map((description, i) => ({
      id: `qa-${i}`, summary: `Cita: Paciente ficticio ${i} - Prueba`, description,
      start: { dateTime: '2026-11-07T10:00:00-05:00' },
      end: { dateTime: '2026-11-07T10:30:00-05:00' }, eventType: 'appointment',
    }));
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (!String(url).includes('/api/')) return realFetch(url, options);
      let data = { success: true };
      if (String(url).includes('verify')) data = { success: true, valid: true, user, features: ['agenda'] };
      else if (String(url).includes('getClinicSettings')) data = { settings: { general: { name: user.clinic_name } } };
      else if (String(url).includes('listStaffResources')) data = { enabled: false, resources: [] };
      else if (String(url).includes('/api/calendar')) {
        const body = JSON.parse(options?.body || '{}');
        if (body.action === 'updateEvent') {
          const event = events.find(item => item.id === body.eventId);
          event.description = body.description ?? event.description;
          event.summary = body.summary ?? event.summary;
          data = { success: true, event };
        } else data = { success: true, events };
      }
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    document.getElementById('root').style.display = 'none';
    const container = document.createElement('div');
    container.id = 'qa-agenda';
    document.body.append(container);
    createRoot(container).render(React.createElement(AuthProvider, null,
      React.createElement(CalendarManager, { onBack() {} })));
  });
  const panel = page.locator('#qa-agenda');
  await panel.getByText('Paciente ficticio 6', { exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const links = await panel.locator('a[href*="wa.me"]').evaluateAll(elements => elements.map(el => new URL(el.href).pathname));
    assert.deepEqual(links, ['/34612345678', '/12025550123', '/593991234567', '/593991234567']);
    assert.equal(await panel.getByRole('button', { name: 'Añadir teléfono para WhatsApp', exact: true }).count(), 2);
    assert.equal(await panel.getByRole('button', { name: 'Revisar teléfono para WhatsApp', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sin desbordamiento ${width}px`);
    await panel.getByRole('button', { name: 'Añadir teléfono para WhatsApp', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    assert.match(await dialog.getByRole('status').innerText(), /Sin teléfono registrado en Google Calendar/);
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
  }
  await panel.locator('a[href*="wa.me"]').first().focus();
  await page.keyboard.press('Space');
  assert.equal(await page.getByRole('dialog').count(), 0, 'el teclado en controles hijos no abre la tarjeta');
  await panel.getByRole('button', { name: 'Añadir teléfono para WhatsApp', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Editar', exact: true }).click();
  await dialog.getByLabel(/Descripción/).fill('Teléfono: +39 06 6982 0000\nServicio: Otro');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await panel.locator('a[href*="wa.me/390669820000"]').count(), 1, 'editar recupera el enlace sin recargar');
  await panel.getByRole('button', { name: 'Ver detalles', exact: true }).first().click();
  assert.match(await page.getByRole('dialog').innerText(), /no verifica si el número tiene WhatsApp/);
  assert.equal(await page.getByRole('dialog').getByRole('link', { name: 'Abrir WhatsApp', exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log('QA agenda: destinos extranjeros/locales, ausencia/invalidez, teclado, edición y aviso WhatsApp; desktop/móvil aprobados. Sin envíos reales.');
} finally {
  await browser.close();
}
