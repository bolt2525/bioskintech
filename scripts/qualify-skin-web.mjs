import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'model-dir': { type: 'string' },
  output: { type: 'string' },
}, strict: true });
assert(values['model-dir'] && values.output,
  'Uso: node scripts/qualify-skin-web.mjs --model-dir EXPORTACION --output INFORME.json');
const root = resolve(values['model-dir']);
const output = resolve(values.output);
assert(!existsSync(output), 'El informe ya existe; usar un nombre nuevo.');
const specification = await readFile(join(root, 'model.json'));
const spec = JSON.parse(specification);
assert(spec.version === 1 && spec.format === 'onnx' && spec.eligibleForClinicalUse === false);
assert(Number.isInteger(spec.size) && spec.size >= 64 && spec.size <= 512);
assert(Number.isFinite(spec.threshold) && spec.threshold >= 0 && spec.threshold <= 1);
assert.deepEqual(spec.inputShape, [1, 3, spec.size, spec.size]);
assert.deepEqual(spec.outputShape, [1, 1, spec.size, spec.size]);
assert(spec.encoding === 'little-endian-float32' && spec.normalization === 'rgb-div127.5-minus1');
assert(spec.inputName === 'image' && spec.outputName === 'probability');
assert(spec.tolerances.maxAbsoluteError <= .0001 && spec.tolerances.maxAbsoluteError > 0);
assert(spec.tolerances.minimumMaskAgreement >= .999 && spec.tolerances.minimumMaskAgreement <= 1);
assert(Array.isArray(spec.cases) && spec.cases.length >= 2 && spec.cases.length <= 100);
const files = new Map();
for (const item of [spec.model, ...spec.cases.flatMap(item => [item.input, item.expected])]) {
  assert(/^[a-zA-Z0-9_-]+\.(onnx|f32)$/.test(item.file), 'Archivo fuera del contrato.');
  assert(Number.isInteger(item.bytes) && item.bytes > 0 && item.bytes <= 100_000_000);
  assert(/^[a-f0-9]{64}$/.test(item.sha256));
  assert(!files.has('/' + item.file), 'Archivo repetido en el contrato.');
  const content = await readFile(join(root, item.file));
  assert(content.length === item.bytes, 'Tamaño de archivo alterado.');
  assert(createHash('sha256').update(content).digest('hex') === item.sha256, 'SHA256 de archivo alterado.');
  files.set('/' + item.file, join(root, item.file));
}
for (const item of spec.cases) {
  assert(item.input.bytes === 3 * spec.size * spec.size * 4);
  assert(item.expected.bytes === spec.size * spec.size * 4);
}
const runtime = fileURLToPath(new URL('../node_modules/onnxruntime-web/dist/', import.meta.url));
for (const name of await readdir(runtime)) {
  if (/^ort[\w.-]+\.(mjs|wasm)$/.test(name)) files.set('/runtime/' + name, join(runtime, name));
}
const html = `<!doctype html><html lang="es"><meta charset="utf-8">
<title>Paridad experimental ONNX</title>
<p id="status">Comprobando inferencia local. No es un diagnóstico médico.</p>
<script type="module">
const report = { version: 1, passed: false, backend: 'wasm', threads: 1,
  eligibleForClinicalUse: false, cases: [], userAgent: navigator.userAgent,
  scope: 'Paridad numérica con tensores preprocesados; no precisión clínica ni prueba en teléfonos físicos.' };
let session;
async function bytes(item) {
  const response = await fetch('/' + item.file);
  if (!response.ok) throw new Error('No se pudo leer ' + item.file);
  const buffer = await response.arrayBuffer();
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    value => value.toString(16).padStart(2, '0')).join('');
  if (sha !== item.sha256 || buffer.byteLength !== item.bytes) throw new Error('Archivo alterado: ' + item.file);
  return buffer;
}
try {
  const ort = await import('/runtime/ort.wasm.min.mjs');
  const response = await fetch('/model.json');
  if (!response.ok) throw new Error('No se pudo leer el contrato.');
  const spec = await response.json();
  report.modelSha256 = spec.model.sha256;
  report.sourceCheckpointSha256 = spec.sourceCheckpointSha256;
  ort.env.wasm.numThreads = 1;
  const start = performance.now();
  session = await ort.InferenceSession.create(await bytes(spec.model), { executionProviders: ['wasm'] });
  report.initializationMilliseconds = performance.now() - start;
  for (const item of spec.cases) {
    const input = new ort.Tensor('float32', new Float32Array(await bytes(item.input)), spec.inputShape);
    const expected = new Float32Array(await bytes(item.expected));
    const start = performance.now();
    const outputs = await session.run({ [spec.inputName]: input });
    const elapsed = performance.now() - start;
    const actual = outputs[spec.outputName];
    if (!actual || actual.type !== 'float32' || actual.data.length !== expected.length ||
        actual.dims.some((value, index) => value !== spec.outputShape[index]) ||
        actual.dims.length !== spec.outputShape.length) throw new Error('Forma de salida incorrecta.');
    let maxAbsoluteError = 0, equal = 0;
    for (let i = 0; i < expected.length; i++) {
      if (!Number.isFinite(actual.data[i]) || !Number.isFinite(expected[i])) throw new Error('Salida no finita.');
      maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(actual.data[i] - expected[i]));
      if ((actual.data[i] >= spec.threshold) === (expected[i] >= spec.threshold)) equal++;
    }
    const maskAgreement = equal / expected.length;
    report.cases.push({ name: item.name, milliseconds: elapsed, maxAbsoluteError, maskAgreement });
    input.dispose();
    actual.dispose();
    if (maxAbsoluteError > spec.tolerances.maxAbsoluteError ||
        maskAgreement < spec.tolerances.minimumMaskAgreement) throw new Error('Paridad insuficiente: ' + item.name);
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
} finally {
  if (session) await session.release();
}
window.skinQualification = report;
document.getElementById('status').textContent = report.passed ? 'Paridad aprobada; no validación clínica.' : report.error;
await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
</script></html>`;
let received = false;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:;");
    if (request.method === 'POST' && path === '/report') {
      assert(!received, 'Informe duplicado.');
      assert(request.headers.origin === 'http://127.0.0.1:' + server.address().port, 'Origen no autorizado.');
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        assert(Buffer.byteLength(text) <= 128_000, 'Informe demasiado grande.');
      }
      const report = JSON.parse(text);
      assert(typeof report.passed === 'boolean' && report.eligibleForClinicalUse === false);
      if (report.passed) {
        assert(report.modelSha256 === spec.model.sha256 && report.cases.length === spec.cases.length);
        for (const [index, item] of report.cases.entries()) {
          assert(item.name === spec.cases[index].name);
          assert(Number.isFinite(item.maxAbsoluteError) && item.maxAbsoluteError >= 0 &&
            item.maxAbsoluteError <= spec.tolerances.maxAbsoluteError);
          assert(Number.isFinite(item.maskAgreement) && item.maskAgreement >= spec.tolerances.minimumMaskAgreement &&
            item.maskAgreement <= 1);
          assert(Number.isFinite(item.milliseconds) && item.milliseconds >= 0);
        }
      }
      received = true;
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      response.end('ok');
      console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, output, error: report.error }));
      process.exitCode = report.passed ? 0 : 1;
      clearTimeout(timeout);
      server.close();
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end();
    } else if (path === '/' || path === '/model.json') {
      response.setHeader('Content-Type', path === '/' ? 'text/html; charset=utf-8' : 'application/json');
      response.end(path === '/' ? html : specification);
    } else if (files.has(path)) {
      response.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' :
        path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
      response.end(await readFile(files.get(path)));
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error.message);
    response.writeHead(400).end('Solicitud inválida.');
  }
});
const timeout = setTimeout(() => {
  console.error('No se recibió una evaluación completa del navegador en 180 segundos.');
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
}, 180_000);
server.listen(0, '127.0.0.1', () => console.log('Abrir http://127.0.0.1:' + server.address().port));
