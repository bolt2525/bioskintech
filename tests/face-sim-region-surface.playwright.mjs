/**
 * QA WebGL del Clinical3DViewer REAL con male_head.glb (modelo genérico, no pacientes).
 * No inicia servidores, modifica producción ni instala paquetes.
 * Esperar turno pesado explícito ANTES de ejecutar:
 * $env:FACE_SIM_HEAVY_QA='1'
 * $env:PLAYWRIGHT_MODULE='<ruta existente a playwright-core/index.mjs>'
 * node tests/face-sim-region-surface.playwright.mjs
 *
 * Desktop + móvil: punteros reales, callback de zona, cobertura de píxeles GPU
 * contra máscara renderizada con depth prepass del GLB, oclusor delante de la
 * mejilla y selección fijada vista desde atrás. No es una prueba de tap móvil:
 * el hover móvil usa un PointerEvent de ratón en viewport/contexto móvil.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

if (process.env.FACE_SIM_HEAVY_QA !== '1') throw new Error('Espera el turno pesado antes de activar FACE_SIM_HEAVY_QA=1.');
const origin = process.env.FACE_SIM_QA_ORIGIN ?? 'http://127.0.0.1:5173';
const url = new URL(origin);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:', 'QA solo local.');
const atlas = JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url), 'utf8'));
const glb = readFileSync(new URL('../public/models/clinical/male_head.glb', import.meta.url));
assert.equal(createHash('sha256').update(glb).digest('hex'), atlas.provenance.glbSha256, 'Atlas y GLB deben coincidir.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [], failures = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
      isMobile: viewport.width < 600, hasTouch: viewport.width < 600, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(90000);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request().url();
        if (request.startsWith(`${origin}/api/`)) return route.abort();
        return request.startsWith(`${origin}/`) || /^(data:|blob:)/.test(request) ? route.continue() : route.abort();
      });
      await page.goto(`${origin}/dev/hair-lab`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
        const path = '/src/components/admin/ficha-clinica/components/Clinical3DViewer.tsx';
        const source = await (await fetch(path)).text();
        // Misma instancia Three que usa el visor (no instrumentar otra copia del módulo).
        const THREE = await import(source.match(/import \* as THREE from "([^"]+)"/)[1]);
        const { default: Viewer } = await import(path);
        const { genericFaceAtlas: atlas, locateModelPoint } = await import('/src/lab/faceSim/faceTransfer.ts');
        const { buildFaceRegionMap, buildFaceTriangleRegions } = await import('/src/lab/faceSim/faceRegions.ts');
        const { buildRegionCells, regionCellAt, regionCellPositions } = await import('/src/lab/faceSim/regionMesh.ts');
        const map = buildFaceRegionMap(Array.from({ length: 468 }, (_, i) =>
          ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] })), atlas.triangles, 1, atlas.positions);
        const cells = buildRegionCells(map, buildFaceTriangleRegions(map, atlas.positions));
        const labelAt = (label, x) => label === 'Mejillas' ? `${label} · ${x < 0 ? 'derecha' : 'izquierda'}` : label;
        const positions = [], colors = [], labels = [];
        for (const cell of cells) {
          const vertices = regionCellPositions(cell, atlas.triangles, atlas.positions, atlas.surface);
          const x = regionCellPositions(cell, atlas.triangles, atlas.positions).filter((_, i) => i % 3 === 0)
            .reduce((sum, value) => sum + value / 3, 0);
          positions.push(...vertices);
          for (let i = 0; i < vertices.length / 9; i++) labels.push(labelAt(cell.label, x));
          for (let i = 0; i < vertices.length / 3; i++) colors.push(0, 1, 1);
        }
        const qa = window.__regionSurfaceQA = { hover: null, pending: null, frames: 0 };
        const overlay = { positions: Float32Array.from(positions), colors: Float32Array.from(colors), labels,
          opacity: 0, wireframe: true, highlight: 'mesh', depthTest: true,
          onHover: zone => { qa.hover = zone; },
          zoneAt: point => {
            const address = locateModelPoint(point, atlas);
            return address ? labelAt(regionCellAt(address, cells), point.x) : null;
          } };
        const host = document.createElement('main');
        host.id = 'region-surface-qa';
        host.style.cssText = 'margin:16px;width:calc(100vw - 32px);height:calc(100dvh - 64px)';
        const oldRoot = document.getElementById('root');
        if (oldRoot) { oldRoot.hidden = true; oldRoot.style.display = 'none'; }
        document.body.style.margin = '0';
        document.body.append(host);
        const root = createRoot(host), markers = [];
        const render = selectedZone => root.render(React.createElement(Viewer, {
          markers, readOnly: true, labInteraction: true, height: '100%',
          cameraPreset: 'face', modelUrl: '/models/clinical/male_head.glb',
          anatomicalOverlay: { ...overlay, selectedZone },
        }));
        const afterRender = THREE.Mesh.prototype.onAfterRender;
        THREE.Mesh.prototype.onAfterRender = function (renderer, scene, camera) {
          if (renderer.domElement.closest('#region-surface-qa') && this.name === 'ANATOMICAL_REFERENCE_OVERLAY') {
            if (!qa.renderer) {
              // Three asigna render en la instancia, no en WebGLRenderer.prototype.
              const originalRender = renderer.render;
              renderer.render = function (scene, camera) {
                const result = originalRender.call(this, scene, camera);
                if (scene === qa.scene && !qa.masking) {
                  qa.frames++;
                  if (qa.pending) {
                    const finish = qa.pending; qa.pending = null;
                    finish(qa.pixels());
                  }
                }
                return result;
              };
              qa.restoreRender = () => { renderer.render = originalRender; };
            }
            Object.assign(qa, { renderer, scene, camera, canvas: renderer.domElement, overlayMesh: this });
          }
          return afterRender.apply(this, arguments);
        };
        qa.pixels = () => {
          const gl = qa.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return { pixels, width, height };
        };
        qa.capture = () => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { qa.pending = null; reject(new Error('El visor no produjo un frame GPU en 30 s.')); }, 30000);
          qa.pending = frame => { clearTimeout(timeout); resolve(frame); };
        });
        qa.model = () => qa.scene.children.find(child => child instanceof THREE.Group
          && child.children.some(object => object instanceof THREE.Group || object instanceof THREE.Mesh));
        qa.point = zone => {
          const caster = new THREE.Raycaster(), bounds = qa.canvas.getBoundingClientRect();
          let best = null, maxArea = 0;
          for (let i = 0; i < labels.length; i++) {
            if (labels[i] !== zone) continue;
            const corners = [0, 1, 2].map(j => new THREE.Vector3().fromArray(positions, i * 9 + j * 3));
            const triangle = new THREE.Triangle(...corners), center = triangle.getMidpoint(new THREE.Vector3());
            const projected = center.clone().project(qa.camera), area = triangle.getArea();
            if (Math.abs(projected.x) > 0.9 || Math.abs(projected.y) > 0.9 || area <= maxArea) continue;
            if (overlay.zoneAt(center) !== zone) continue;
            caster.setFromCamera(new THREE.Vector2(projected.x, projected.y), qa.camera);
            const hit = caster.intersectObject(qa.model(), true)[0];
            if (!hit || hit.point.distanceTo(center) > 0.001) continue;
            maxArea = area;
            best = { x: bounds.left + (projected.x + 1) * bounds.width / 2,
              y: bounds.top + (1 - projected.y) * bounds.height / 2, world: center.toArray() };
          }
          if (!best) throw new Error(`No hay punto interior visible para ${zone}.`);
          return best;
        };
        qa.mask = zone => {
          const scene = new THREE.Scene(), black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, toneMapped: false });
          const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide,
            toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
          const model = qa.model().clone(true);
          model.traverse(object => { if (object.isMesh) object.material = black; });
          scene.add(model);
          const selected = positions.filter((_, i) => labels[Math.floor(i / 9)] === zone);
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(selected, 3));
          scene.add(new THREE.Mesh(geometry, white));
          const target = new THREE.WebGLRenderTarget(qa.renderer.domElement.width, qa.renderer.domElement.height);
          const previous = qa.renderer.getRenderTarget(), color = qa.renderer.getClearColor(new THREE.Color());
          const alpha = qa.renderer.getClearAlpha(), pixels = new Uint8Array(target.width * target.height * 4);
          qa.masking = true;
          try {
            qa.renderer.setRenderTarget(target); qa.renderer.setClearColor(0x000000, 1);
            qa.renderer.render(scene, qa.camera);
            qa.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
          } finally {
            qa.renderer.setRenderTarget(previous); qa.renderer.setClearColor(color, alpha); qa.masking = false;
            target.dispose(); geometry.dispose(); black.dispose(); white.dispose();
          }
          return pixels;
        };
        qa.compare = async (before, zone) => {
          const after = await qa.capture(), mask = qa.mask(zone);
          let expected = 0, changed = 0;
          // Erosión de un píxel: excluye antialias del límite, no triángulos interiores.
          const white = index => mask[index] > 220 && mask[index + 1] > 220 && mask[index + 2] > 220;
          for (let y = 1; y < after.height - 1; y++) for (let x = 1; x < after.width - 1; x++) {
            const i = (y * after.width + x) * 4;
            if (![i, i - 4, i + 4, i - after.width * 4, i + after.width * 4].every(white)) continue;
            expected++;
            if ([0, 1, 2].reduce((sum, k) => sum + Math.abs(after.pixels[i + k] - before.pixels[i + k]), 0) > 12) changed++;
          }
          return { expected, changed, coverage: changed / expected };
        };
        qa.block = point => {
          const geometry = new THREE.PlaneGeometry(0.35, 0.35);
          const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, depthWrite: true });
          const blocker = new THREE.Mesh(geometry, material);
          blocker.position.fromArray(point.world).addScaledVector(qa.camera.getWorldDirection(new THREE.Vector3()), -0.5);
          blocker.quaternion.copy(qa.camera.quaternion); qa.scene.add(blocker);
          qa.blocker = blocker;
        };
        qa.centerDiff = async (before, point) => {
          const after = await qa.capture(), rect = qa.canvas.getBoundingClientRect();
          const x = Math.round((point.x - rect.left) / rect.width * after.width);
          const y = Math.round((1 - (point.y - rect.top) / rect.height) * after.height);
          let maximum = 0, green = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const i = ((y + dy) * after.width + x + dx) * 4;
            if (before.pixels[i + 1] > before.pixels[i] + 30 && before.pixels[i + 1] > before.pixels[i + 2] + 30) green++;
            maximum = Math.max(maximum, ...[0, 1, 2].map(k => Math.abs(after.pixels[i + k] - before.pixels[i + k])));
          }
          return { maximum, green };
        };
        qa.back = () => {
          qa.camera.position.set(0, 0.15, -8); qa.camera.lookAt(0, 0.15, 0);
          qa.camera.updateMatrixWorld(true);
        };
        qa.select = render;
        qa.cleanup = () => {
          qa.restoreRender?.();
          root.unmount(); host.remove();
          THREE.Mesh.prototype.onAfterRender = afterRender;
          if (oldRoot) { oldRoot.hidden = false; oldRoot.style.display = ''; }
        };
        render(null);
      });
      await page.waitForFunction(() => window.__regionSurfaceQA?.frames > 3);
      const zones = ['Mejillas · derecha', 'Mejillas · izquierda', 'Mentón'];
      for (const zone of zones) {
        await page.mouse.move(1, 1);
        await page.waitForFunction(() => window.__regionSurfaceQA.hover === null);
        const baseline = await page.evaluate(async () => {
          const capture = await window.__regionSurfaceQA.capture();
          window.__regionSurfaceQA.baseline = capture; return true;
        });
        assert.ok(baseline);
        const point = await page.evaluate(zone => window.__regionSurfaceQA.point(zone), zone);
        await page.mouse.move(point.x, point.y, { steps: 4 });
        await page.waitForFunction(zone => window.__regionSurfaceQA.hover === zone, zone);
        const metric = await page.evaluate(zone => {
          const qa = window.__regionSurfaceQA; return qa.compare(qa.baseline, zone);
        }, zone);
        assert.ok(metric.expected > (viewport.width < 600 ? 8 : 80), `${zone}: máscara visible insuficiente ${JSON.stringify(metric)}`);
        assert.ok(metric.coverage >= 0.97, `${zone}: islas/triángulos ausentes ${JSON.stringify(metric)}`);
        results.push({ viewport, zone, ...metric });
        console.log(JSON.stringify({ viewport, zone, ...metric }));
      }
      const point = await page.evaluate(() => window.__regionSurfaceQA.point('Mejillas · derecha'));
      await page.evaluate(point => window.__regionSurfaceQA.block(point), point);
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => window.__regionSurfaceQA.hover === null);
      await page.evaluate(async () => {
        const qa = window.__regionSurfaceQA; qa.blockedBaseline = await qa.capture();
      });
      await page.mouse.move(point.x, point.y, { steps: 4 });
      await page.waitForFunction(() => window.__regionSurfaceQA.hover === 'Mejillas · derecha');
      const occlusion = await page.evaluate(point => {
        const qa = window.__regionSurfaceQA; return qa.centerDiff(qa.blockedBaseline, point);
      }, point);
      assert.equal(occlusion.green, 25, 'El oclusor debe cubrir la muestra GPU.');
      assert.ok(occlusion.maximum <= 2, `El hover atraviesa el oclusor: ${JSON.stringify(occlusion)}`);
      console.log(JSON.stringify({ viewport, occlusion }));
      await page.mouse.move(1, 1);
      await page.evaluate(() => {
        const qa = window.__regionSurfaceQA;
        qa.scene.remove(qa.blocker); qa.blocker.geometry.dispose(); qa.blocker.material.dispose(); qa.back();
      });
      await page.waitForFunction(() => window.__regionSurfaceQA.hover === null);
      await page.evaluate(async () => {
        const qa = window.__regionSurfaceQA; qa.rearBaseline = await qa.capture(); qa.select('Mejillas · derecha');
      });
      await page.waitForFunction(() => window.__regionSurfaceQA.hover === 'Mejillas · derecha');
      const rear = await page.evaluate(async () => {
        const qa = window.__regionSurfaceQA, after = await qa.capture();
        let changed = 0;
        const samples = [], mask = qa.mask('Mejillas · derecha');
        let maskPixels = 0;
        for (let i = 0; i < after.pixels.length; i += 4) {
          if (mask[i] > 220 && mask[i + 1] > 220 && mask[i + 2] > 220) maskPixels++;
          if ([0, 1, 2].some(k => Math.abs(after.pixels[i + k] - qa.rearBaseline.pixels[i + k]) > 12)) {
            changed++;
            if (samples.length < 24) samples.push({ x: (i / 4) % after.width, y: Math.floor(i / 4 / after.width),
              before: [...qa.rearBaseline.pixels.slice(i, i + 3)], after: [...after.pixels.slice(i, i + 3)] });
          }
        }
        const grid = qa.scene.children.find(object => object.isMesh && object.renderOrder === 14);
        if (grid) grid.visible = false;
        const withoutGrid = await qa.capture();
        let fillChanged = 0;
        for (let i = 0; i < withoutGrid.pixels.length; i += 4) {
          if ([0, 1, 2].some(k => Math.abs(withoutGrid.pixels[i + k] - qa.rearBaseline.pixels[i + k]) > 12)) fillChanged++;
        }
        if (grid) grid.visible = true;
        return { changed, fillChanged, maskPixels, samples };
      });
      console.log(JSON.stringify({ viewport, rear }));
      // Recoge ambos tamaños antes de fallar; no relaja el umbral ni oculta la fuga.
      if (rear.changed > 4) failures.push({ viewport, issue: 'retícula visible desde atrás', changed: rear.changed, fillChanged: rear.fillChanged });
      results.push({ viewport, occlusion, rear });
      assert.deepEqual(errors, [], 'Sin errores JS en el visor.');
      await page.evaluate(() => window.__regionSurfaceQA.cleanup());
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', fixture: 'GLB genérico sintético; sin pacientes', results, failures }, null, 2));
  assert.deepEqual(failures, [], 'Sin fuga de regiones a través de la hemicara trasera.');
} finally { await browser.close(); }
