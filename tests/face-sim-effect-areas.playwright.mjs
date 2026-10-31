/**
 * UI + textura REAL del material renderizado; detector fixture sintético aislado.
 * PLAYWRIGHT_MODULE=<playwright/index.mjs> node tests/face-sim-effect-areas.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url)));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (!/^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(url)) return route.abort();
      if (url.includes('/src/lab/faceSim/FaceSimLab.tsx')) {
        const response = await route.fetch(), source = await response.text();
        const detector = /async function detectFrame\([^]*?\n\}/;
        assert.match(source, detector);
        const landmarks = fixture.landmarks.map(([x, y, z]) => ({ x, y, z }));
        return route.fulfill({ response, body: source.replace(detector, `async function detectFrame(img) {
          const landmarks = ${JSON.stringify(landmarks)};
          return { frame: frameFromLandmarks(landmarks), landmarks, detectedLandmarks: landmarks,
            regionMap: buildFaceRegionMap(landmarks, ${JSON.stringify(atlas.triangles)}, img.width / img.height, genericFaceAtlas.positions),
            contourAdjusted: 0, reason: '', captureWarnings: [] };
        }`) });
      }
      return route.continue();
    });
    await page.goto('http://127.0.0.1:5173/dev/hair-lab');
    await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
    const spaces = page.getByRole('navigation', { name: 'Espacios del laboratorio' });
    await spaces.waitFor();
    const png = await page.evaluate(async aspect => {
      const code = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
      const THREE = await import(code.match(/import \* as THREE from "([^"]+)"/)[1]);
      window.__areaTextures = {};
      window.__areaCameras = new Map();
      const original = THREE.Mesh.prototype.onAfterRender;
      THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
        window.__areaCameras.set(renderer.domElement, [...camera.position.toArray(), ...camera.quaternion.toArray()]);
        const kind = renderer.domElement.closest('section[aria-label="Foto personal en 3D"]') ? 'personal'
          : renderer.domElement.closest('section[aria-label="Modelo genérico 3D"]') ? 'generic' : null;
        if (kind && this.name.startsWith('PERSONAL_FACE_SURFACE') && !this.name.includes('_POINT')
          && window.__areaTextures[kind]?.uuid !== this.uuid) {
          const material = Array.isArray(this.material) ? this.material[0] : this.material;
          const image = material.map?.image;
          const pos = this.geometry.attributes.position.array;
          const color = this.geometry.attributes.color?.array;
          let geometry = 0, colors = 0;
          for (let i = 0; i < pos.length; i++) geometry += pos[i] * ((i % 97) + 1);
          if (color) for (let i = 0; i < color.length; i++) colors += color[i] * ((i % 97) + 1);
          let rgba;
          if (image) {
            const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
            const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
            rgba = ctx.getImageData(0, 0, c.width, c.height).data;
          }
          window.__areaTextures[kind] = { uuid: this.uuid, rgba, width: image?.width, height: image?.height, geometry, colors };
        }
        return original?.apply(this, arguments);
      };
      const c = document.createElement('canvas'); c.width = 480; c.height = Math.round(480 / aspect);
      const ctx = c.getContext('2d'), pixels = ctx.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const stripe = y % 13 < 2 ? -28 : 0;
        pixels.data.set([180 + stripe, 145 + stripe, 125 + stripe, 255], (y * c.width + x) * 4);
      }
      ctx.putImageData(pixels, 0, 0); return c.toDataURL();
    }, fixture.aspect);
    await page.getByLabel('Cargar Frontal', { exact: true }).setInputFiles({
      name: 'area-piel-sintetica.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64'),
    });
    await page.waitForFunction(() => document.body.textContent.includes('Rostro detectado en Frontal.')
      && document.querySelector('input[aria-label="Confirmar captura Frontal"]'));
    const dialog = page.getByRole('dialog');
    await page.waitForFunction(() => document.querySelector('dialog[open]')
      || document.body.textContent.includes('Contorno válido aceptado'));
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Cerrar revisión', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: 'Revisar frente, sienes y mentón', exact: true }).click();
    await dialog.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
    await page.getByLabel('Confirmar captura Frontal', { exact: true }).check();
    await spaces.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Marcar', exact: true });
    await toolbar.getByRole('button', { name: 'Personal', exact: true }).click();
    await page.waitForFunction(() => window.__areaTextures.personal?.rgba);
    await page.getByRole('tab', { name: /Revisar/ }).click();
    // Gate educativo real: área sobre modelo sin ninguna marcación.
    await page.getByText('Áreas de efecto', { exact: true }).click();
    await page.getByRole('button', { name: 'Antes', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__areaNoPoint = window.__areaTextures.personal.rgba; });
    await page.getByLabel('Zona anatómica del área', { exact: true }).selectOption('Mejillas');
    await page.getByRole('button', { name: 'Añadir zona', exact: true }).click();
    await page.waitForFunction(() => window.__areaTextures.personal.rgba.some((v, i) => v !== window.__areaNoPoint[i]));
    assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 0);
    await page.getByRole('button', { name: 'Limpiar categoría', exact: true }).click();
    await page.waitForFunction(() => window.__areaTextures.personal.rgba.every((v, i) => v === window.__areaNoPoint[i]));
    await page.getByText('Áreas de efecto', { exact: true }).click();
    await page.getByText('Importar de Inyectables', { exact: true }).click();
    const id = 'area-un-punto', index = 151;
    const pointRecord = mode => JSON.stringify({ mapping_data: {
      injectionPoints: [{ id, position: { x: atlas.positions[index * 3], y: atlas.positions[index * 3 + 1], z: atlas.positions[index * 3 + 2] }, units: .05, mode }],
      freehandLines: [], surfaceShapes: [], lab: { version: 1, meta: { [id]: { mode, product: 'QA ficticio', zone: 'Auto', dose: .05 } } },
    } });
    await page.getByLabel('JSON de Inyectables', { exact: true }).fill(pointRecord('hidratacion'));
    await page.getByRole('button', { name: 'Importar', exact: true }).click();
    for (const label of ['Toxina', 'Relleno HA', 'Hidratación', 'Bioestimulador']) await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
    await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Antes', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__areaOriginal = window.__areaTextures.personal; });
    const ledger = page.getByRole('list', { name: 'Elementos marcados' });
    assert.equal(await ledger.locator('li').count(), 1);
    const dose = await page.getByLabel('Volumen acumulado', { exact: true }).textContent();
    assert.match(dose, /0[,.]05/, 'fixture 0.05 ml');
    await page.getByText('Áreas de efecto', { exact: true }).click();
    const areaPanel = page.locator('details').filter({ has: page.getByText('Áreas de efecto', { exact: true }) });
    const editor = page.getByRole('img', { name: 'Editor de áreas de efecto', exact: true });
    const waitTexture = async old => {
      await page.waitForFunction(uuid => window.__areaTextures.personal.uuid !== uuid, old);
      await page.waitForTimeout(400);
    };
    const uuid = () => page.evaluate(() => window.__areaTextures.personal.uuid);
    const unchanged = async () => page.evaluate(() => {
      const current = window.__areaTextures.personal.rgba, before = window.__areaOriginal.rgba;
      return current.length === before.length && current.every((value, i) => value === before[i]);
    });
    const draw = async (tool, points) => {
      await areaPanel.getByRole('button', { name: tool, exact: true }).click();
      await editor.scrollIntoViewIfNeeded();
      const box = await editor.boundingBox();
      await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
      await page.mouse.down();
      for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: tool === 'Trazo libre' ? 12 : 2 });
      await page.mouse.up();
      await page.getByRole('button', { name: 'Confirmar área', exact: true }).click();
    };
    for (const [mode, label, radius] of [['hidratacion', 'Hidratación', .1], ['bioestimulador', 'Bioestimulador', .085]]) {
      if (mode === 'bioestimulador') {
        // El importador agrega: sustituir explícitamente el punto del fixture, no acumular dos.
        await ledger.getByRole('button', { name: 'Eliminar marca 1', exact: true }).click();
        await page.getByLabel('JSON de Inyectables', { exact: true }).fill(pointRecord(mode));
        await page.getByRole('button', { name: 'Importar', exact: true }).click();
        assert.equal(await ledger.locator('li').count(), 1);
      }
      await page.getByLabel('Categoría de área', { exact: true }).selectOption(mode);
      await page.getByLabel(`Efecto ${label}`, { exact: true }).check();
      await page.waitForFunction(() => {
        const current = window.__areaTextures.personal.rgba, original = window.__areaOriginal.rgba;
        return current.some((v, i) => v !== original[i]);
      });
      await page.evaluate(() => { window.__areaPointBase = window.__areaTextures.personal; });
      let old = await uuid();
      await draw('Rectángulo', [[.1, .3], [.9, .95]]);
      await waitTexture(old);
      await page.waitForFunction(({ point, radius, aspect }) => {
        const current = window.__areaTextures.personal, before = window.__areaPointBase;
        let far3 = 0;
        for (let i = 0; i < current.width * current.height; i++) {
          const x = (i % current.width + .5) / current.width, y = (Math.floor(i / current.width) + .5) / current.height;
          if (Math.hypot((x - point[0]) * aspect, y - point[1]) > 2 * radius
            && [0, 1, 2].every(c => current.rgba[i * 4 + c] - before.rgba[i * 4 + c] >= 3)) far3++;
        }
        return far3 > 100;
      }, { point: fixture.landmarks[151], radius, aspect: fixture.aspect });
      const pixelEvidence = await page.evaluate(({ point, radius, aspect }) => {
        const current = window.__areaTextures.personal, before = window.__areaPointBase;
        let far3 = 0, outside = 0, alpha = 0;
        for (let i = 0; i < current.width * current.height; i++) {
          const x = (i % current.width + .5) / current.width, y = (Math.floor(i / current.width) + .5) / current.height;
          const far = Math.hypot((x - point[0]) * aspect, y - point[1]) > 2 * radius;
          if (far && [0, 1, 2].every(c => current.rgba[i * 4 + c] - before.rgba[i * 4 + c] >= 3)) far3++;
          if ((x < .1 || x > .9 || y < .3 || y > .95) && [0, 1, 2, 3].some(c => current.rgba[i * 4 + c] !== before.rgba[i * 4 + c])) outside++;
          if (current.rgba[i * 4 + 3] !== before.rgba[i * 4 + 3]) alpha++;
        }
        return { far3, outside, alpha };
      }, { point: fixture.landmarks[151], radius, aspect: fixture.aspect });
      assert.ok(pixelEvidence.far3 > 100, `${width} ${label} centro lejano >=3 RGB: ${JSON.stringify(pixelEvidence)}`);
      assert.equal(pixelEvidence.outside, 0, 'fuera de ROI exacto');
      assert.equal(pixelEvidence.alpha, 0);
      // Ojos/boca originales exactos en la textura usada por el modelo.
      const protectedPixels = await page.evaluate(ids => {
        const current = window.__areaTextures.personal, original = window.__areaOriginal;
        return ids.map(([x, y]) => {
          const at = (Math.floor(y * current.height) * current.width + Math.floor(x * current.width)) * 4;
          return [0, 1, 2, 3].every(c => current.rgba[at + c] === original.rgba[at + c]);
        });
      }, [33, 263, 13, 14].map(i => fixture.landmarks[i]));
      assert.ok(protectedPixels.every(Boolean), 'ojos/boca originales exactos');
      // Sin amplificación por duplicación.
      await page.evaluate(() => { window.__areaSingle = window.__areaTextures.personal.rgba; });
      old = await uuid(); await draw('Rectángulo', [[.1, .3], [.9, .95]]); await waitTexture(old);
      assert.equal(await page.evaluate(() => window.__areaTextures.personal.rgba.every((v, i) => v === window.__areaSingle[i])), true);
      await page.getByRole('button', { name: 'Deshacer área', exact: true }).click();
      // Antes / cero / off restauran original; hydration contiene un punto y nivel cero también lo desactiva.
      for (const action of ['before', 'zero', 'off']) {
        old = await uuid();
        if (action === 'before') await page.getByRole('button', { name: 'Antes', exact: true }).click();
        if (action === 'zero') await page.getByLabel(`Intensidad ${label}`, { exact: true }).fill('0');
        if (action === 'off') await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
        await waitTexture(old); assert.equal(await unchanged(), true, `${label} ${action} exacto`);
        old = await uuid();
        if (action === 'before') await page.getByRole('button', { name: 'Después', exact: true }).click();
        if (action === 'zero') await page.getByLabel(`Intensidad ${label}`, { exact: true }).fill('1');
        if (action === 'off') await page.getByLabel(`Efecto ${label}`, { exact: true }).check();
        await waitTexture(old);
      }
      // Borrar seleccionado restaura el campo de punto sin borrar la marcación.
      await page.getByLabel('Área seleccionada', { exact: true }).selectOption({ index: 1 });
      old = await uuid(); await page.getByRole('button', { name: 'Borrar área', exact: true }).click(); await waitTexture(old);
      assert.equal(await page.evaluate(() => window.__areaTextures.personal.rgba.every((v, i) => v === window.__areaPointBase.rgba[i])), true);
      // Preset y trazo libre ejercitan la misma UI, no helpers.
      old = await uuid(); await page.getByLabel('Zona anatómica del área', { exact: true }).selectOption('Mejillas');
      await page.getByRole('button', { name: 'Añadir zona', exact: true }).click(); await waitTexture(old);
      assert.equal(await page.evaluate(() => window.__areaTextures.personal.rgba.some((v, i) => v !== window.__areaPointBase.rgba[i])), true);
      await page.getByRole('button', { name: 'Limpiar categoría', exact: true }).click();
      await page.waitForFunction(() => window.__areaTextures.personal.rgba.every((v, i) => v === window.__areaPointBase.rgba[i]));
      old = await uuid(); await draw('Trazo libre', [[.12, .32], [.85, .33], [.88, .85], [.2, .91], [.12, .32]]); await waitTexture(old);
      await page.waitForFunction(() => window.__areaTextures.personal.rgba.some((v, i) => v !== window.__areaPointBase.rgba[i]));
      assert.equal(await page.evaluate(() => window.__areaTextures.personal.rgba.some((v, i) => v !== window.__areaPointBase.rgba[i])), true);
      await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
      results.push(`${width}px ${label}: ${pixelEvidence.far3} pixels lejanos ≥3RGB; ROI/alpha/protección/max/antes/cero/off/delete/preset/libre`);
      console.log(results.at(-1));
    }
    // Ambas áreas siguen guardadas: limpiar hidratación no elimina bio.
    await page.getByLabel('Categoría de área', { exact: true }).selectOption('hidratacion');
    await page.getByRole('button', { name: 'Limpiar categoría', exact: true }).click();
    await page.getByLabel('Categoría de área', { exact: true }).selectOption('bioestimulador');
    assert.equal(await page.getByLabel('Área seleccionada', { exact: true }).locator('option').count(), 2);
    await page.getByLabel('Efecto Bioestimulador', { exact: true }).check();
    await page.waitForTimeout(1500);
    // Foto real usa el mismo campo; comparación limpia cambia/restaura pixels visibles.
    await toolbar.getByRole('button', { name: 'Foto', exact: true }).click();
    await page.getByRole('button', { name: 'Antes', exact: true }).click();
    await page.waitForTimeout(800);
    const photo = page.locator('canvas:visible').last(), beforePhoto = await photo.screenshot();
    await page.getByRole('button', { name: 'Después', exact: true }).click(); await page.waitForTimeout(1500);
    assert.ok(!(await photo.screenshot()).equals(beforePhoto), 'foto real cambia con área bio');
    await page.getByRole('button', { name: 'Antes', exact: true }).click(); await page.waitForTimeout(800);
    assert.deepEqual(await photo.screenshot(), beforePhoto);
    await page.getByRole('button', { name: 'Doble visor', exact: true }).click();
    assert.ok(await page.getByText('Comparación limpia de efectos', { exact: false }).isVisible());
    await page.getByRole('button', { name: 'Deslizador', exact: true }).click();
    await page.getByLabel('Comparación Antes / Después', { exact: true }).fill('0.7');
    await page.getByRole('button', { name: 'Vista actual', exact: true }).click();
    await toolbar.getByRole('button', { name: 'Personal', exact: true }).click();
    await page.getByRole('button', { name: 'Doble visor', exact: true }).click();
    await page.waitForTimeout(1500);
    const personalCanvases = page.locator('section[aria-label="Foto personal en 3D"] canvas');
    assert.equal(await personalCanvases.count(), 2);
    const synchronized = () => page.evaluate(() => {
      const canvases = [...document.querySelectorAll('section[aria-label="Foto personal en 3D"] canvas')];
      const poses = canvases.map(c => window.__areaCameras.get(c));
      return poses.length === 2 && poses.every(Boolean) && poses[0].every((value, i) => Math.abs(value - poses[1][i]) < 1e-5);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Foto personal en 3D"] canvas')].every(c => window.__areaCameras.has(c)));
    assert.equal(await synchronized(), true, 'cámaras antes/después sincronizadas');
    await personalCanvases.first().scrollIntoViewIfNeeded();
    const box = await personalCanvases.first().boundingBox();
    const cameraBefore = await personalCanvases.first().evaluate(c => window.__areaCameras.get(c));
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .55, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(500);
    assert.notDeepEqual(await personalCanvases.first().evaluate(c => window.__areaCameras.get(c)), cameraBefore, 'giro real');
    assert.equal(await synchronized(), true, 'giro en doble sincronizado');
    results.push(`${width}px: foto antes/después exactos; comparadores foto/3D y giro de cámara sincronizado`);
    await page.getByRole('button', { name: 'Vista actual', exact: true }).click();
    assert.equal(await ledger.locator('li').count(), 1);
    assert.equal(await page.getByLabel('Volumen acumulado', { exact: true }).textContent(), dose);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'sin overflow horizontal');
    await editor.focus(); await page.keyboard.press('Escape');
    await page.getByText('Trazado cancelado; áreas guardadas intactas.', { exact: true }).waitFor();
    await areaPanel.getByRole('button', { name: 'Rectángulo', exact: true }).click();
    await editor.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Confirmar área', exact: true }).isEnabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Confirmar área', exact: true }).isEnabled(), false);
    // Export real: intercepta el Blob local, sin persistir ni enviar a servicios.
    await page.evaluate(() => {
      const original = URL.createObjectURL;
      URL.createObjectURL = function (blob) {
        if (blob instanceof Blob && blob.type.includes('json')) window.__areaExport = blob.text();
        return original.call(this, blob);
      };
    });
    await page.getByRole('button', { name: 'Exportar JSON de Inyectables', exact: true }).click();
    const json = await page.evaluate(async () => await window.__areaExport);
    assert.ok(json && !json.includes('manualAreas') && !json.includes('polygon') && !json.includes('areaLandmarks'), 'áreas no exportadas');
    const record = JSON.parse(json);
    assert.equal(Object.values(record.mapping_data.lab.meta)[0].dose, .05, 'dosis exportada intacta');
    await spaces.getByRole('button', { name: 'Capturas', exact: true }).click();
    await page.getByRole('button', { name: 'Retirar Frontal', exact: true }).click();
    await page.getByText('Cambió la fuente/captura o sus UV: se descartaron las áreas de efecto incompatibles. Puntos y dosis intactos.', { exact: true }).waitFor();
    await spaces.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
    await page.getByRole('tab', { name: /Revisar/ }).click();
    await page.getByText('Áreas de efecto', { exact: true }).click();
    await page.getByLabel('Categoría de área', { exact: true }).selectOption('bioestimulador');
    assert.equal(await page.getByLabel('Área seleccionada', { exact: true }).locator('option').count(), 1, 'fuente retirada invalida ROI');
    await page.getByText('Esquema frontal · UV exactos del atlas anatómico.', { exact: true }).waitFor();
    assert.equal(await ledger.locator('li').count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(results.join('\n'));
} finally { await browser.close(); }
