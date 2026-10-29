import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lab/faceSim/defaultLayers.ts', import.meta.url), 'utf8')
  .replace(/^import \{[^}]+\} from '\.\/anatomicalReference';$/m, 'const fitAnatomicalUVs = () => { throw new Error(); }, fitLandmarkUVs = fitAnatomicalUVs;')
  .replace(/^import .* from '\.\/anatomicalZones';$/m, 'const ANATOMICAL_ZONES = {};');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { keyOutBackground, keyVascularLines, DEFAULT_LAYER_SOURCES } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('capas por defecto: tres planos ordenados de superficial a profundo con imágenes locales', () => {
  assert.deepEqual(DEFAULT_LAYER_SOURCES.map(s => s.kind), ['muscle', 'vessels', 'bone']);
  const depths = DEFAULT_LAYER_SOURCES.map(s => s.depth);
  assert.ok(depths[1] < depths[0] && depths[0] < depths[2], 'las arterias acompañan al músculo por delante, el hueso queda detrás');
  assert.ok(DEFAULT_LAYER_SOURCES.every(s => s.url.startsWith('/face-layers/')));
});

test('el fondo blanco conectado al borde se vuelve transparente y el blanco interior se conserva', () => {
  const w = 7, h = 7, data = new Uint8ClampedArray(w * h * 4).fill(255);
  const paint = (x, y, v) => data.set([v, v, v, 255], (y * w + x) * 4);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) paint(x, y, 120);
  paint(3, 3, 255); // «diente» blanco rodeado de ilustración
  keyOutBackground(data, w, h);
  assert.equal(data[3], 0);
  assert.equal(data[(3 * w + 3) * 4 + 3], 255);
  assert.ok(data[(1 * w + 1) * 4 + 3] > 0);
});

test('el aislamiento arterial conserva líneas rojas, no la musculatura de fondo ni el blanco', () => {
  const data = Uint8ClampedArray.from([145, 30, 20, 255, 200, 150, 145, 255, 255, 255, 255, 255, 145, 30, 20, 0]);
  keyVascularLines(data);
  assert.equal(data[3], 255);
  assert.equal(data[7], 0);
  assert.equal(data[11], 0);
  assert.equal(data[15], 0);
});
