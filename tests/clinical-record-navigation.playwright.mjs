import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.LAB_URL ?? 'http://127.0.0.1:5188';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], external = [], timings = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      external.push(url.href);
      return route.abort();
    }
    const javascript = body => route.fulfill({ contentType: 'application/javascript', body });
    if (url.pathname.endsWith('/ClinicalRecordManager.tsx')) {
      const source = await (await route.fetch()).text();
      return javascript(source.replace(/react-router-dom\.js\?v=[^"']+/g, 'react-router-dom.js'));
    }
    if (url.pathname.endsWith('/useAdminNav.ts'))
      return javascript('export const useAdminNav=()=>({nav:()=>{}});');
    if (url.pathname.endsWith('/AdminLayout.tsx'))
      return javascript("export default function Layout({children}){return children;}");
    if (/\/(?:PrintModal|ConsultationActivatedModal)\.tsx$/.test(url.pathname))
      return javascript('export default function Modal(){return null;}');
    if (/\/tabs\/\w+Tab\.tsx$/.test(url.pathname)) {
      const name = url.pathname.match(/\/(\w+)Tab\.tsx$/)[1];
      return javascript(`
        import React from '/node_modules/.vite/deps/react.js';
        export default function Tab(){
          React.useEffect(()=>{
            if('${name}'!=='PhysicalExam')return;
            window.viewerMounted=true;
            let frame;
            const render=()=>{window.viewerFrames=(window.viewerFrames??0)+1;frame=requestAnimationFrame(render);};
            frame=requestAnimationFrame(render);
            return ()=>{cancelAnimationFrame(frame);window.viewerMounted=false;};
          },[]);
          return React.createElement('section',{'data-testid':'section-${name}'},'${name} sintético');
        }`);
    }
    if (url.pathname.startsWith('/api/')) {
      assert.equal(route.request().method(), 'GET');
      assert.equal(url.searchParams.get('action'), 'getRecordData');
      return route.fulfill({ json: {
        recordId: 12, patient: { id: 1, first_name: 'Paciente', last_name: 'Sintético' },
        consultations: [{ id: 7, record_id: 12, reason: 'Fixture', created_at: '2026-11-06T00:00:00Z' }],
        physicalExams: [], diagnoses: [],
      } });
    }
    if (url.pathname !== '/__clinical_navigation_fixture__') return route.continue();
    const html = await (await route.fetch()).text();
    const script = `<script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import {MemoryRouter,Routes,Route,useLocation} from '/node_modules/.vite/deps/react-router-dom.js';
      import Manager from '/src/components/admin/ficha-clinica/components/ClinicalRecordManager.tsx';
      import '/src/index.css';
      function Location(){return React.createElement('output',{'data-testid':'location'},useLocation().search);}
      ReactDOM.createRoot(document.getElementById('root')).render(
        React.createElement(MemoryRouter,{initialEntries:[${JSON.stringify(url.searchParams.has('inactive')
          ? '/record/12?tab=consultation' : '/record/12?consultation=7&tab=physical')}]},
          React.createElement(Location),
          React.createElement(Routes,null,React.createElement(Route,{path:'/record/:recordId',element:React.createElement(Manager)}))));
    </script>`;
    return route.fulfill({ contentType: 'text/html', body: html
      .replace(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      .replace(/<script[^>]+src="\/src\/main\.tsx(?:\?[^"]*)?"[^>]*><\/script>/, script) });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/__clinical_navigation_fixture__`);
    await page.getByTestId('section-PhysicalExam').waitFor().catch(async error => {
      console.error(JSON.stringify({ errors, body: await page.locator('body').innerText() }));
      throw error;
    });
    await page.waitForTimeout(300);
    for (const [tab, section] of [['diagnosis', 'Diagnosis'], ['consultation', 'Consultation']]) {
      const result = await page.evaluate(async ({ tab, section }) => {
        const start = performance.now();
        document.getElementById(`clinical-tab-${tab}`).click();
        while (true) {
          await new Promise(requestAnimationFrame);
          if (performance.now() - start > 3000) throw Error('Pestaña sin completar');
          const element = document.querySelector(`[data-testid="section-${section}"]`);
          if (!element) continue;
          let current = element, visible = true;
          while (current && current.id !== 'clinical-tabpanel') {
            if (Number(getComputedStyle(current).opacity) < .99) visible = false;
            current = current.parentElement;
          }
          if (visible) break;
        }
        await new Promise(requestAnimationFrame);
        return { milliseconds: performance.now() - start, viewerMounted: window.viewerMounted };
      }, { tab, section });
      timings.push({ width, tab, ...result });
      if (!process.env.QA_NAVIGATION_BASELINE)
        assert.ok(result.milliseconds < 250, `Cambio completo <250 ms: ${JSON.stringify(timings.at(-1))}`);
      assert.equal(result.viewerMounted, false, 'Se desmonta la escena al salir');
      assert.equal(await page.locator(`#clinical-tab-${tab}`).getAttribute('aria-selected'), 'true');
      const query = new URLSearchParams(await page.getByTestId('location').innerText());
      assert.equal(query.get('tab'), tab);
      assert.equal(query.get('consultation'), '7');
    }
    const stopped = await page.evaluate(() => window.viewerFrames);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.viewerFrames), stopped, 'No quedan frames activos en pestañas ocultas');
    await page.locator('#clinical-tab-consultation').focus();
    await page.keyboard.press('ArrowRight');
    await page.getByTestId('section-PhysicalExam').waitFor();
    assert.equal(await page.locator('#clinical-tab-physical').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#clinical-tab-physical').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }
  await page.goto(`${origin}/__clinical_navigation_fixture__?inactive=1`);
  await page.getByTestId('section-Consultation').waitFor();
  assert.equal(await page.locator('#clinical-tab-physical').isDisabled(), true);
  assert.equal(await page.locator('#clinical-tab-diagnosis').isDisabled(), true);
  await page.locator('#clinical-tab-consultation').focus();
  await page.keyboard.press('ArrowRight');
  await page.getByTestId('section-Photos').waitFor();
  assert.equal(await page.locator('#clinical-tab-photos').getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ timings, checks: 'desktop/móvil, teclado, desmontaje y frames detenidos; escena sintética para aislar la transición' }, null, 2));
} finally {
  await browser.close();
}
