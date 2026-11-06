import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/admin/ficha-clinica/components/simulationPhotos.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness(fetcher) {
  const exports = {};
  class Reader {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file.encoded || 'YWJj'}`;
      queueMicrotask(() => this.onload());
    }
  }
  vm.runInNewContext(compiled, {
    exports, Blob, Map, Set, Object, Error, FileReader: Reader,
    require(name) {
      if (name.endsWith('/recordsFetch')) return { __esModule: true, default: fetcher };
      if (name.endsWith('/skinVisualAI')) return {
        parsePhotoReference: data => ({ id: data.id, r2Key: data.r2_key }),
        safePhotoReadURL: url => url,
      };
      throw new Error(`Importación inesperada: ${name}`);
    },
  });
  return exports;
}

const original = () => ({ type: 'image/jpeg' });
const response = id => ({ ok: true, json: async () => ({ id, r2_key: `clinics/test/records/1/photos/${id}.jpg` }) });

test('solo sube la foto original y reutiliza su identidad exacta', async () => {
  const requests = [];
  const { ensureSimulationPhotos } = harness(async (_url, options) => { requests.push(JSON.parse(options.body)); return response(requests.length); });
  const cache = new Map(), file = original(), canvas = {};
  const captures = [{ id: 'frontal', canvas, original: file }];
  const first = await ensureSimulationPhotos(1, captures, cache);
  const second = await ensureSimulationPhotos(1, captures, cache);
  assert.equal(first.frontal.id, 1);
  assert.equal(second.frontal.id, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].fileBase64, 'YWJj');
  assert.equal(requests[0].content_type, 'image/jpeg');
  await ensureSimulationPhotos(1, [{ ...captures[0], canvas: {} }], cache);
  await ensureSimulationPhotos(1, [{ ...captures[0], original: original() }], cache);
  await ensureSimulationPhotos(2, captures, cache);
  assert.equal(requests.length, 4);
});

test('sin original o con formato no admitido nunca sube el canvas', async () => {
  let count = 0;
  const { ensureSimulationPhotos } = harness(async () => { count++; return response(1); });
  for (const original of [undefined, { type: 'image/heic' }]) {
    await assert.rejects(ensureSimulationPhotos(1, [{ id: 'frontal', canvas: {}, original }], new Map()), /original/);
  }
  assert.equal(count, 0);
});

test('un envío demasiado grande falla explícitamente antes de llamar a la API', async () => {
  let count = 0;
  const { ensureSimulationPhotos } = harness(async () => { count++; return response(1); });
  await assert.rejects(ensureSimulationPhotos(1, [{
    id: 'frontal', canvas: {}, original: { type: 'image/png', encoded: 'A'.repeat(4_000_000) },
  }], new Map()), /límite/);
  assert.equal(count, 0);
});

test('un fallo de red advierte que la subida pudo haber terminado', async () => {
  const { ensureSimulationPhotos } = harness(async () => { throw new Error('red'); });
  await assert.rejects(ensureSimulationPhotos(1, [{ id: 'frontal', canvas: {}, original: original() }], new Map()), /Podría haberse guardado/);
});

test('no reutiliza la misma foto durable en dos vistas', async () => {
  const { ensureSimulationPhotos } = harness(async () => response(1));
  await assert.rejects(ensureSimulationPhotos(1, [
    { id: 'frontal', canvas: {}, original: original() },
    { id: 'izquierda', canvas: {}, original: original() },
  ], new Map()), /foto diferente/);
});
