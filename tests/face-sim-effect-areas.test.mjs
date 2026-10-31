import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadFaceAreaModule } from './helpers/load-face-area-module.mjs';
const preview = loadFaceAreaModule(path.resolve('src/lab/faceSim/injectablePreview.ts'));
const roi = loadFaceAreaModule(path.resolve('src/lab/faceSim/skinRegionReview.ts'));
const engine = loadFaceAreaModule(path.resolve('src/lab/faceSim/engine.ts'));
const regions = loadFaceAreaModule(path.resolve('src/lab/faceSim/faceRegions.ts'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/face-sim-mediapipe-synthetic.json', import.meta.url)));
const chart = fixture.landmarks.map(([x, y]) => ({ x, y }));
const width = 320, height = Math.round(width / fixture.aspect);
const rgba = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const stripe = y % 13 < 2 ? -28 : 0;
  rgba.set([180 + stripe, 145 + stripe, 125 + stripe, 193], (y * width + x) * 4);
}
const mask = new Uint8Array(width * height).fill(1);
const polygon = [{ x: 0.1, y: 0.3 }, { x: 0.9, y: 0.3 }, { x: 0.9, y: 0.95 }, { x: 0.1, y: 0.95 }];
const area = mode => ({ id: mode, mode, label: 'ROI manual', chart, polygon });
const settings = mode => ({ ...preview.DEFAULT_PREVIEW, intensity: 1, areaLandmarks: chart,
  enabled: Object.fromEntries(Object.keys(preview.DEFAULT_PREVIEW.enabled).map(m => [m, m === mode])), manualAreas: [area(mode)] });
const output = (mode, extra = {}, samples = []) => preview.previewPixels(rgba, width, height, samples, { ...settings(mode), ...extra }, mask);

test('frontend: categorías, esquema anatómico, controles semánticos y aviso no clínico', () => {
  const Editor = loadFaceAreaModule(path.resolve('src/lab/faceSim/EffectAreaEditor.tsx')).default;
  const markup = renderToStaticMarkup(React.createElement(Editor, {
    chart: preview.GENERIC_EFFECT_CHART, aspect: .75, areas: [], onChange() {},
  }));
  for (const label of ['Áreas de efecto', 'Toxina', 'Relleno HA', 'Hidratación', 'Bioestimulador', 'Frente', 'Mejillas', 'Mentón',
    'Rectángulo', 'Trazo libre', 'Deshacer área', 'Borrar área', 'Limpiar categoría', 'no se exportan', 'Escape'])
    assert.ok(markup.includes(label), label);
  assert.match(markup, /<summary/);
  assert.match(markup, /aria-label="Editor de áreas de efecto"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /tabindex="0"/);
});

test('ROI compartido valida rectángulo/trazo libre y rechaza cruces/no finitos/degenerado', () => {
  assert.equal(roi.isValidSkinPolygon(polygon), true);
  assert.equal(roi.isValidSkinPolygon([{ x: .2, y: .4 }, { x: .7, y: .35 }, { x: .8, y: .8 }, { x: .3, y: .9 }]), true);
  for (const bad of [[], [{ x: NaN, y: 0 }, ...polygon], [polygon[0], polygon[2], polygon[1], polygon[3]]])
    assert.equal(roi.isValidSkinPolygon(bad), false);
  assert.equal(preview.manualAreaWeight(.05, .5, polygon), 0);
  assert.equal(preview.manualAreaWeight(.5, .5, polygon), 1);
  assert.ok(preview.manualAreaWeight(.11, .5, polygon) < 1);
});

test('cuatro categorías independientes sin puntos, max no amplifica, alpha/máscara/ROI/protecciones exactos', () => {
  const contour = engine.FACE_OVAL.map(id => chart[id]);
  const exclusions = ['leftEye', 'rightEye', 'upperLip', 'lowerLip'].map(key => regions.FACE_REGION_BOUNDARIES[key].map(id => chart[id]));
  for (const mode of Object.keys(preview.DEFAULT_PREVIEW.enabled)) {
    const out = output(mode);
    assert.ok(out.some((value, i) => i % 4 !== 3 && value !== rgba[i]), `${mode} produce filtro sin puntos`);
    assert.deepEqual(output(mode, { manualAreas: [area(mode), { ...area(mode), id: 'duplicado' }] }), out, 'max, no doble amplitud');
    for (let i = 0; i < width * height; i++) {
      assert.equal(out[i * 4 + 3], rgba[i * 4 + 3]);
      const x = (i % width + .5) / width, y = (Math.floor(i / width) + .5) / height;
      if (!roi.pointInValidatedSkinPolygon(x, y, polygon) || !roi.pointInValidatedSkinPolygon(x, y, contour)
        || exclusions.some(p => roi.pointInValidatedSkinPolygon(x, y, p))) {
        assert.deepEqual(out.subarray(i * 4, i * 4 + 4), rgba.subarray(i * 4, i * 4 + 4), `${mode} protección/ROI`);
      }
    }
    for (const extra of [{ after: false }, { intensity: 0 }, { levels: { [mode]: 0 } },
      { enabled: {} }, { manualAreas: [] }, { areaLandmarks: undefined }]) assert.deepEqual(output(mode, extra), rgba);
    const masked = new Uint8Array(mask.length);
    assert.deepEqual(preview.previewPixels(rgba, width, height, [], settings(mode), masked), rgba);
  }
});

test('un punto estratégico: centro lejano hidratación/bio >=3 RGB; el punto y dosis no cambian', () => {
  for (const mode of ['hidratacion', 'bioestimulador']) {
    const point = { ...chart[151], mode, dose: .05 };
    const before = output(mode, { manualAreas: [] }, [point]);
    const after = output(mode, {}, [point]);
    let farChanged = 0;
    for (let i = 0; i < width * height; i++) {
      const x = (i % width + .5) / width, y = (Math.floor(i / width) + .5) / height;
      if (Math.hypot((x - point.x) * fixture.aspect, y - point.y) < 2 * preview.previewRadius(settings(mode), mode)) continue;
      if (after[i * 4] - before[i * 4] >= 3 && after[i * 4 + 1] - before[i * 4 + 1] >= 3 && after[i * 4 + 2] - before[i * 4 + 2] >= 3) farChanged++;
    }
    assert.ok(farChanged > 100, `${mode}: ${farChanged} píxeles lejanos >=3 RGB`);
    assert.equal(point.dose, .05);
    assert.deepEqual(output(mode, { manualAreas: [area(mode), area(mode === 'hidratacion' ? 'bioestimulador' : 'hidratacion')] }, [point]), after,
      'área de categoría desactivada no contamina');
  }
});

test('transferencia por triángulos a otro chart y superficie genérica, sin modificar buffers', () => {
  const generic = preview.GENERIC_EFFECT_CHART;
  const positions = Float32Array.from(JSON.parse(readFileSync(new URL('../src/lab/faceSim/genericFaceAtlas.json', import.meta.url))).positions);
  const uvs = Float32Array.from(generic.flatMap(p => [p.x, p.y]));
  const rgb = new Float32Array(positions.length).fill(.5);
  const s = { ...settings('hidratacion'), areaLandmarks: generic };
  const out = preview.previewSurface(positions, uvs, [], s, .75, rgb);
  assert.deepEqual(out.positions, positions, 'hidratación no mueve geometría');
  assert.ok(out.rgb.some((value, i) => value > rgb[i]));
  assert.deepEqual(preview.previewSurface(positions, uvs, [], { ...s, after: false }, .75, rgb).rgb, rgb);
  assert.ok(preview.previewPixels(rgba, width, height, [], s, mask).some((v, i) => v !== rgba[i]), 'foto → atlas no reusa encuadre');
});
