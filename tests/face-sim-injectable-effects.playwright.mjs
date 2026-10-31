/**
 * Regresión local de inyectables: UI real, textura/GLB/render reales y captura sintética.
 * Solo el detector de cara se sustituye por landmarks de fixture (no se prueba MediaPipe).
 * PLAYWRIGHT_MODULE=<playwright-core/index.mjs> node tests/face-sim-injectable-effects.playwright.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url), 'utf8'));
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const modes = ['toxina', 'relleno_ha', 'hidratacion', 'bioestimulador'];
const labels = ['Toxina', 'Relleno HA', 'Hidratación', 'Bioestimulador'];
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!/^(http:\/\/127\.0\.0\.1:5173\/|data:|blob:)/.test(url)) return route.abort();
    if (url.includes('/src/lab/faceSim/FaceSimLab.tsx')) {
      const response = await route.fetch();
      const source = await response.text();
      const detector = /async function detectFrame\([^]*?\n\}/;
      assert.match(source, detector, 'detector aislado localizado');
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
  await page.goto('http://127.0.0.1:5173/dev/hair-lab', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Simulación facial', exact: true }).click();
  const spaces = page.getByRole('navigation', { name: 'Espacios del laboratorio' });
  await spaces.waitFor();
  // Observa materiales y geometría que realmente llegan al render, sin sustituir el cálculo.
  const png = await page.evaluate(async aspect => {
    const code = await (await fetch('/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx')).text();
    const THREE = await import(code.match(/import \* as THREE from "([^"]+)"/)[1]);
    window.__effects = { personal: null, generic: null };
    const original = THREE.Mesh.prototype.onAfterRender;
    THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
      if (this.name === 'MORPHOLOGY_SKIN_AFTER') {
        const material = Array.isArray(this.material) ? this.material[0] : this.material;
        const image = material.map?.image;
        if (image && image !== window.__skinImage) {
          window.__skinImage = image;
          const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
          const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
          const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
          let hash = 0;
          for (let i = 0; i < bytes.length; i += 4) hash += bytes[i] + bytes[i + 1] + bytes[i + 2];
          window.__skinHash = hash;
        }
      }
      const kind = renderer.domElement.closest('section[aria-label="Foto personal en 3D"]') ? 'personal'
        : renderer.domElement.closest('section[aria-label="Modelo genérico 3D"]') ? 'generic' : null;
      if (kind && this.name.startsWith('PERSONAL_FACE_SURFACE') && !this.name.includes('_POINT')) {
        if (window.__effects[kind]?.uuid !== this.uuid) {
          const pos = this.geometry.attributes.position.array;
          let geometryHash = 0, colorHash = 0, textureHash = 0;
          for (let i = 0; i < pos.length; i++) geometryHash += pos[i] * ((i % 97) + 1);
          const colors = this.geometry.attributes.color?.array;
          if (colors) for (let i = 0; i < colors.length; i++) colorHash += colors[i] * ((i % 97) + 1);
          const image = this.material.map?.image;
          if (image) {
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < bytes.length; i += 4) textureHash += bytes[i] + bytes[i + 1] + bytes[i + 2];
          }
          window.__effects[kind] = { uuid: this.uuid, geometryHash, colorHash, textureHash, at: performance.now(),
            positions: Array.from(pos), indices: Array.from(this.geometry.index.array) };
        }
        const bounds = renderer.domElement.getBoundingClientRect();
        window.__effects[kind].lips = [14, 17, 87, 317, 84, 314].map(id => {
          const point = new THREE.Vector3().fromBufferAttribute(this.geometry.attributes.position, id)
            .applyMatrix4(this.matrixWorld).project(camera);
          return [point.x * bounds.width / 2, point.y * bounds.height / 2];
        });
      }
      return original?.apply(this, arguments);
    };
    const c = document.createElement('canvas'); c.width = 480; c.height = Math.round(480 / aspect);
    const ctx = c.getContext('2d'), pixels = ctx.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, stripe = y % 13 < 2 ? -28 : 0;
      pixels.data.set([180 + stripe, 145 + stripe, 125 + stripe, 255], i);
    }
    ctx.putImageData(pixels, 0, 0); return c.toDataURL();
  }, fixture.aspect);
  await page.getByLabel('Cargar Frontal', { exact: true }).setInputFiles({
    name: 'piel-sintetica.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64'),
  });
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Conservar detección original', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirmar límites', exact: true }).click();
  await page.getByLabel('Confirmar captura Frontal', { exact: true }).check();
  await spaces.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Personal', exact: true }).click();
  const personal = page.getByRole('region', { name: 'Foto personal en 3D', exact: true });
  await personal.locator('canvas').waitFor();
  await page.waitForFunction(() => window.__effects.personal);
  const before = await page.evaluate(() => window.__effects.personal);
  await page.getByRole('tab', { name: /Revisar/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Después', exact: true }).getAttribute('aria-pressed'), 'true');
  results.push('Revisar activa Después sin paso oculto');
  // Puntos anatómicos en ambas mejillas para cada categoría; ningún dato clínico real.
  const points = modes.flatMap((mode, m) => [50, 280].map(id => ({ id: `effect-${m}-${id}`,
    position: { x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] }, units: 0, mode })));
  const meta = Object.fromEntries(points.map(p => [p.id, { mode: p.mode, product: 'QA ficticio', zone: 'Auto', dose: 1 }]));
  await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(JSON.stringify({ mapping_data: {
    injectionPoints: points, freehandLines: [], surfaceShapes: [], lab: { version: 1, meta },
  } }));
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 8);
  const amounts = await page.getByLabel('Volumen acumulado', { exact: true }).textContent();
  for (const label of labels) await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('1');
  await page.waitForFunction(hash => window.__effects.personal?.textureHash === hash, before.textureHash);
  const sample = () => page.evaluate(() => ({ ...window.__effects.personal }));
  const nextFrame = async old => {
    await page.waitForFunction(id => window.__effects.personal?.uuid !== id, old.uuid);
    return sample();
  };
  for (let i = 0; i < modes.length; i++) {
    const label = labels[i], base = await sample();
    await page.getByRole('button', { name: 'Antes', exact: true }).click();
    await page.getByLabel(`Efecto ${label}`, { exact: true }).check();
    assert.equal(await page.getByRole('button', { name: 'Después', exact: true }).getAttribute('aria-pressed'), 'true');
    let active = await nextFrame(base);
    await page.waitForFunction(hash => window.__effects.personal?.textureHash !== hash, before.textureHash);
    active = await sample();
    assert.notEqual(active.textureHash, before.textureHash, `${label}: textura renderizada cambia`);
    if (modes[i] === 'relleno_ha' || modes[i] === 'bioestimulador')
      assert.notEqual(active.geometryHash, before.geometryHash, `${label}: relieve renderizado cambia`);
    await page.getByLabel(`Intensidad ${label}`, { exact: true }).fill('0');
    await page.waitForFunction(hash => window.__effects.personal?.textureHash === hash, before.textureHash);
    await page.getByLabel(`Intensidad ${label}`, { exact: true }).fill('1.5');
    await page.waitForFunction(hash => window.__effects.personal?.textureHash !== hash, before.textureHash);
    const narrowBefore = await sample();
    await page.getByLabel(`Cobertura visual ${label}`, { exact: true }).fill('2');
    await page.waitForFunction(hash => window.__effects.personal?.textureHash !== hash, narrowBefore.textureHash);
    await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
    await page.waitForFunction(hash => window.__effects.personal?.textureHash === hash, before.textureHash);
    results.push(`${label}: activar, intensidad cero/máxima, cobertura y desactivar cambian/restauran textura real`);
  }
  // El atlas genérico también recibe efectos en vista dividida, no solo en vista única.
  await page.getByLabel('Visor dividido · genérico y máscara', { exact: true }).check();
  await page.waitForFunction(() => window.__effects.generic);
  const genericBase = await page.evaluate(() => window.__effects.generic);
  for (let i = 0; i < modes.length; i++) {
    const key = modes[i] === 'relleno_ha' || modes[i] === 'bioestimulador' ? 'geometryHash' : 'colorHash';
    await page.getByLabel(`Efecto ${labels[i]}`, { exact: true }).check();
    await page.waitForFunction(([key, hash]) => window.__effects.generic?.[key] !== hash, [key, genericBase[key]]);
    await page.getByLabel(`Efecto ${labels[i]}`, { exact: true }).uncheck();
    await page.waitForFunction(([key, hash]) => window.__effects.generic?.[key] === hash, [key, genericBase[key]]);
  }
  results.push('Genérico dividido recibe y restaura los cuatro efectos en Después');
  await page.getByRole('button', { name: 'Antes', exact: true }).click();
  await page.waitForFunction(hash => window.__effects.personal?.textureHash === hash, before.textureHash);
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 8);
  assert.equal(await page.getByLabel('Volumen acumulado', { exact: true }).textContent(), amounts);
  results.push('Antes restaura original; registro intacto');
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Foto', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Antes', exact: true }).getAttribute('aria-pressed'), 'true');
  const photo = page.locator('canvas:visible');
  // Solo cambia el contenido del canvas: las etiquetas y porcentajes del panel quedan fuera de la captura.
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('0');
  await page.waitForTimeout(500);
  const originalPhoto = await photo.screenshot();
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('1');
  for (const label of labels) {
    await page.getByLabel(`Efecto ${label}`, { exact: true }).check();
    await page.waitForTimeout(500);
    const changedPhoto = await photo.screenshot();
    assert.ok(!changedPhoto.equals(originalPhoto), `${label}: píxeles de foto visibles cambian; ${JSON.stringify(await photo.evaluate(c => {
      const gl = c.getContext('webgl'), program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!program) return { contextLost: gl.isContextLost(), error: gl.getError(),
        status: [...document.querySelectorAll('[role="status"]')].map(e => e.textContent) };
      return { prepared: gl.getUniform(program, gl.getUniformLocation(program, 'prepared')),
        count: gl.getUniform(program, gl.getUniformLocation(program, 'count')), split: gl.getUniform(program, gl.getUniformLocation(program, 'split')),
        error: gl.getError(), opacity: c.style.opacity };
    }))}`);
    await page.getByLabel(`Efecto ${label}`, { exact: true }).uncheck();
    await page.waitForTimeout(500);
    assert.deepEqual(await photo.screenshot(), originalPhoto, `${label}: foto restaurada`);
  }
  results.push('Foto: los cuatro filtros modifican píxeles visibles y restauran el original');
  await spaces.getByRole('button', { name: 'Capturas', exact: true }).click();
  await spaces.getByRole('button', { name: 'Simular y marcar', exact: true }).click();
  await page.getByLabel('Efecto Hidratación', { exact: true }).check();
  await page.waitForTimeout(500);
  assert.ok(!(await photo.screenshot()).equals(originalPhoto), 'renderer fotográfico funciona tras volver de Capturas');
  assert.equal(await photo.evaluate(c => c.getContext('webgl').isContextLost()), false);
  results.push('Cambio Capturas/Simular reconecta canvas y conserva contexto válido');
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Punto', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Antes', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 8);
  results.push('Elegir herramienta de marcación vuelve a Antes sin modificar el registro');
  // Caso reportado: seis puntos de HA en labio inferior, no solo muestras de mejilla ni hash distinto.
  await page.getByRole('toolbar', { name: 'Marcar', exact: true }).getByRole('button', { name: 'Personal', exact: true }).click();
  await page.getByLabel('Visor dividido · genérico y máscara', { exact: true }).uncheck();
  await page.getByRole('tab', { name: /Revisar/ }).click();
  const lipPoints = [14, 17, 87, 317, 84, 314].map(id => ({ id: `lip-${id}`,
    position: { x: atlas.positions[id * 3], y: atlas.positions[id * 3 + 1], z: atlas.positions[id * 3 + 2] }, units: 0 }));
  await page.getByRole('button', { name: 'Limpiar', exact: true }).click();
  if (!await page.getByLabel('JSON de Inyectables', { exact: true }).isVisible())
    await page.getByText('Importar de Inyectables', { exact: true }).click();
  await page.getByLabel('JSON de Inyectables', { exact: true }).fill(JSON.stringify({ mapping_data: {
    injectionPoints: lipPoints, freehandLines: [], surfaceShapes: [], lab: { version: 1,
      meta: Object.fromEntries(lipPoints.map(p => [p.id, { mode: 'relleno_ha', zone: 'Labio inferior', dose: 0.05 }])) },
  } }));
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  assert.equal(await page.getByRole('list', { name: 'Elementos marcados' }).locator('li').count(), 6);
  const lipAmounts = await page.getByLabel('Volumen acumulado', { exact: true }).textContent();
  await page.getByLabel('Efecto Hidratación', { exact: true }).uncheck();
  await page.getByLabel('Efecto Relleno HA', { exact: true }).check();
  await page.getByLabel('Cobertura visual Relleno HA', { exact: true }).fill('1');
  await page.getByLabel('Intensidad visual independiente', { exact: true }).fill('0.6');
  const previous = await sample();
  await page.getByLabel('Intensidad Relleno HA', { exact: true }).fill('0');
  await nextFrame(previous);
  const lipCanvas = personal.locator('canvas');
  await lipCanvas.scrollIntoViewIfNeeded();
  const bounds = await lipCanvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5 + 110, bounds.y + bounds.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const lipOriginal = await sample(), originalRender = await lipCanvas.screenshot();
  await page.getByLabel('Intensidad Relleno HA', { exact: true }).fill('1.5');
  const lipAfter = await nextFrame(lipOriginal);
  const displacements = lipAfter.positions.filter((_, i) => i % 3 === 0).map((_, id) =>
    Math.hypot(...[0, 1, 2].map(k => lipAfter.positions[id * 3 + k] - lipOriginal.positions[id * 3 + k])));
  const yValues = lipOriginal.positions.filter((_, i) => i % 3 === 1), height = Math.max(...yValues) - Math.min(...yValues);
  const screenShift = Math.max(...lipAfter.lips.map((p, i) => Math.hypot(p[0] - lipOriginal.lips[i][0], p[1] - lipOriginal.lips[i][1])));
  assert.ok(Math.max(...displacements) >= height * 0.015, 'relieve real del labio ≥ 1,5 % de altura facial');
  assert.ok(Math.max(...displacements) <= height * 0.03, 'relieve acotado al 3 %');
  for (const id of [14, 17, 87, 317, 84, 314])
    assert.ok(displacements[id] >= height * 0.015, `punto labial ${id}: relieve perceptible, no solo mejillas`);
  assert.ok(screenShift >= 3, `desplazamiento labial perceptible ≥ 3 CSS px: ${screenShift}`);
  const normal = (positions, a, b, c) => {
    const u = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]);
    const v = [0, 1, 2].map(k => positions[c * 3 + k] - positions[a * 3 + k]);
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  for (let i = 0; i < lipOriginal.indices.length; i += 3) {
    const ids = lipOriginal.indices.slice(i, i + 3), n0 = normal(lipOriginal.positions, ...ids), n1 = normal(lipAfter.positions, ...ids);
    if (Math.hypot(...n0) < 1e-8) continue;
    assert.ok(n0.reduce((sum, value, k) => sum + value * n1[k], 0) > 0, `triángulo ${i / 3} sin invertir`);
  }
  assert.ok(!(await lipCanvas.screenshot()).equals(originalRender), 'silueta/render del labio cambia');
  await page.getByLabel('Intensidad Relleno HA', { exact: true }).fill('0');
  await page.waitForFunction(hash => window.__effects.personal.geometryHash === hash, lipOriginal.geometryHash);
  assert.equal(await page.getByLabel('Volumen acumulado', { exact: true }).textContent(), lipAmounts);
  console.log(JSON.stringify({ lipMaxReliefPercent: Math.max(...displacements) / height * 100, lipScreenShiftPx: screenShift }));
  results.push('Seis puntos labiales: relieve ≥ 1,5 %, desplazamiento ≥ 3 px en vista oblicua, sin inversiones y reversible');
  await page.getByRole('navigation', { name: 'Grupos del editor' })
    .getByRole('button', { name: 'Morfología, piel y capas', exact: true }).click();
  const appearance = page.locator('[data-face-appearance-group]');
  await appearance.getByRole('button', { name: 'Piel', exact: true }).click();
  const regionEditor = appearance.getByRole('region', { name: 'Revisión visual manual por zonas', exact: true });
  const roi = regionEditor.getByRole('application', { name: 'Área para delimitar una zona de piel' });
  await roi.waitFor();
  await page.waitForFunction(() => window.__skinHash > 0);
  const skinBefore = await page.evaluate(() => window.__skinHash);
  assert.equal(await regionEditor.getByLabel('Atenuar apariencia de cicatriz', { exact: true }).count(), 0, 'sin control antes de validar');
  await roi.scrollIntoViewIfNeeded();
  const box = await roi.boundingBox(), cheek = fixture.landmarks[50];
  await page.mouse.move(box.x + box.width * (cheek[0] - 0.07), box.y + box.height * (cheek[1] - 0.07));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (cheek[0] + 0.07), box.y + box.height * (cheek[1] + 0.07), { steps: 5 });
  await page.mouse.up();
  await regionEditor.locator('select').selectOption({ label: 'Cicatriz' });
  await regionEditor.getByRole('button', { name: 'Analizar solo esta zona', exact: true }).click();
  await regionEditor.getByRole('button', { name: 'Validar revisión manual', exact: true }).click();
  await regionEditor.getByLabel('Atenuar apariencia de cicatriz', { exact: true }).fill('1');
  await page.waitForFunction(hash => window.__skinHash !== hash, skinBefore);
  const scarHash = await page.evaluate(() => window.__skinHash);
  await regionEditor.getByRole('button', { name: 'Ver antes', exact: true }).click();
  await page.waitForFunction(hash => window.__skinHash === hash, skinBefore);
  await regionEditor.getByRole('button', { name: 'Ver después', exact: true }).click();
  await page.waitForFunction(hash => window.__skinHash === hash, scarHash);
  await regionEditor.getByRole('button', { name: 'Restablecer · imagen original', exact: true }).click();
  await page.waitForFunction(hash => window.__skinHash === hash, skinBefore);
  results.push('Piel: rectángulo → Cicatriz → analizar → validar → atenuar modifica textura 3D; Antes/Después y restablecer reversibles');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(errors, []);
  results.push('Escritorio/móvil sin desbordamiento ni errores JavaScript');
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  await browser.close();
}
