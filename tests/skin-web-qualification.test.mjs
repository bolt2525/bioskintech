import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/qualify-skin-web.mjs', import.meta.url));

function fixture(directory) {
  function file(name, size) {
    const bytes = Buffer.alloc(size);
    writeFileSync(join(directory, name), bytes);
    return { file: name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return {
    version: 1, format: 'onnx', eligibleForClinicalUse: false, size: 64, threshold: .5,
    inputShape: [1, 3, 64, 64], outputShape: [1, 1, 64, 64],
    inputName: 'image', outputName: 'probability',
    encoding: 'little-endian-float32', normalization: 'rgb-div127.5-minus1',
    tolerances: { maxAbsoluteError: .0001, minimumMaskAgreement: .999 },
    model: file('model.onnx', 32),
    cases: [0, 1].map(index => ({
      name: 'synthetic-' + index,
      input: file('input-' + index + '.f32', 3 * 64 * 64 * 4),
      expected: file('expected-' + index + '.f32', 64 * 64 * 4),
    })),
  };
}

for (const [name, mutate] of [
  ['referencia clínica habilitada', spec => { spec.eligibleForClinicalUse = true; }],
  ['contrato de dimensiones alterado', spec => { spec.inputShape = [1, 3, 32, 32]; }],
  ['tolerancias relajadas', spec => { spec.tolerances.minimumMaskAgreement = .5; }],
  ['ruta fuera de exportación', spec => { spec.model.file = '../model.onnx'; }],
  ['huella alterada', spec => { spec.model.sha256 = 'f'.repeat(64); }],
  ['longitud de tensor incompatible', (spec, root) => {
    const item = spec.cases[0].input;
    const content = Buffer.alloc(4);
    writeFileSync(join(root, item.file), content);
    item.bytes = content.length;
    item.sha256 = createHash('sha256').update(content).digest('hex');
  }],
]) {
  test('el runner rechaza ' + name + ' antes de abrir un servidor', () => {
    const root = mkdtempSync(join(tmpdir(), 'skin-web-rejection-'));
    try {
      const spec = fixture(root);
      mutate(spec, root);
      writeFileSync(join(root, 'model.json'), JSON.stringify(spec));
      const output = join(root, 'report.json');
      assert.throws(() => execFileSync(process.execPath, [script, '--model-dir', root, '--output', output],
        { timeout: 5000, stdio: 'pipe' }), error => error.status === 1 && !error.signal);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('el runner no sobrescribe evidencia anterior', () => {
  const root = mkdtempSync(join(tmpdir(), 'skin-web-existing-'));
  try {
    const output = join(root, 'report.json');
    writeFileSync(output, 'evidencia');
    assert.throws(() => execFileSync(process.execPath, [script, '--model-dir', root, '--output', output],
      { timeout: 5000, stdio: 'pipe' }), error => error.status === 1 && !error.signal);
    assert.equal(readFileSync(output, 'utf8'), 'evidencia');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
