import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src/lab/faceSim'), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, console, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    require(name) {
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(file), name), target = [base, `${base}.ts`].find(p => existsSync(p));
      if (!target) throw new Error(`Missing ${base}`);
      return load(target);
    },
  }, { filename: file });
  return exports;
}
const atlas = load(path.join(root, 'genericFaceAtlas.json'));
const symmetry = load(path.join(root, 'annotationSymmetry.ts'));
const annotations = load(path.join(root, 'anatomicalAnnotations.ts'));
const records = load(path.join(root, 'injectableLocalRecord.ts'));
const engine = load(path.join(root, 'engine.ts'));
const regions = load(path.join(root, 'faceRegions.ts'));
const transfer = load(path.join(root, 'faceTransfer.ts'));
const point = i => ({ x: atlas.positions[i * 3], y: atlas.positions[i * 3 + 1], z: atlas.positions[i * 3 + 2] });
const at = i => transfer.locateModelPoint(point(i), atlas);

test('mover punta conserva entrada, otras ramas y original; rechaza destinos inválidos', () => {
  const binding = { kind: 'pattern', illustrativePlane: 'skin', paths: [[at(50), at(205)], [at(50), at(207)]] };
  const before = structuredClone(binding), target = at(206);
  const moved = symmetry.moveAnnotationTip(binding, 0, target, atlas);
  assert.ok(moved);
  assert.equal(JSON.stringify(binding), JSON.stringify(before));
  assert.deepEqual(moved.paths[0][0], binding.paths[0][0]);
  assert.deepEqual(moved.paths[0].at(-1), target);
  assert.deepEqual(moved.paths[1], binding.paths[1]);
  assert.equal(moved.illustrativePlane, 'skin');
  assert.equal(symmetry.moveAnnotationTip(binding, -1, target, atlas), null);
  assert.equal(symmetry.moveAnnotationTip(binding, 0, target, atlas, () => false), null);
});

test('óvalo tiene ejes independientes; regla proporcional no inventa milímetros', () => {
  const outline = annotations.shapeOutline({ shapeType: 'ellipse', center: point(205),
    normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 }, width: 0.08, height: 0.04 });
  assert.equal(outline.length, 49);
  const width = Math.max(...outline.map(p => p.x)) - Math.min(...outline.map(p => p.x));
  const height = Math.max(...outline.map(p => p.y)) - Math.min(...outline.map(p => p.y));
  assert.ok(Math.abs(width / height - 2) < 1e-8);
  assert.deepEqual(outline[0], outline.at(-1));
  const line = { kind: 'line', paths: [[at(50), at(205)]] };
  const value = symmetry.annotationProportion(line, atlas);
  assert.ok(value > 0 && value < 100);
  assert.equal(symmetry.annotationProportion({ kind: 'point', paths: [[at(50)]] }, atlas), 0);
});

test('dibujos y entradas no generan puntos derivados ni efectos de volumen', () => {
  const base = { mode: 'toxina', dose: 5, zone: 'Auto', paths: [[{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.5 }]] };
  for (const kind of ['line', 'arrow', 'pattern', 'circle', 'rect', 'point']) {
    const result = engine.expandElems([{ ...base, id: kind, kind, graphicOnly: true }], engine.DEFAULT_FRAME, 1);
    assert.equal(result.points.length + result.derived.length, 0, kind);
  }
  const result = engine.expandElems([{ ...base, id: 'entry', kind: 'line', entry: true }], engine.DEFAULT_FRAME, 1);
  assert.equal(result.points.length + result.derived.length, 0);
});

test('export/import remapea vínculo punta-trazo y conserva estilo, texto y dosis cero', () => {
  const meta = {
    line: { mode: 'toxina', dose: 0, zone: 'Auto', entry: true, technique: 'Línea', strokeColor: '#123456', strokeWidth: 5 },
    tip: { mode: 'toxina', dose: 0, plane: 'Intradérmico', zone: 'Auto', product: 'Vial ficticio', parent: 'line', tip: 0 },
    note: { mode: 'toxina', dose: 0, zone: 'Auto', graphicOnly: true, annotationKind: 'text', annotationText: 'Nota ficticia' },
  };
  const encoded = records.localRecord([{ id: 'tip', position: point(205) }, { id: 'note', position: point(50) }],
    [{ id: 'line', points: [point(50), point(205)], color: '#123456', thickness: 5 }], [], meta,
    { line: 'line', tip: 'point', note: 'point' });
  const decoded = records.importLocalRecord(JSON.stringify(encoded), []);
  const entries = Object.entries(decoded.meta), tip = entries.find(([, m]) => m.parent), line = entries.find(([, m]) => m.entry);
  assert.ok(tip && line);
  assert.equal(tip[1].parent, line[0]);
  assert.equal(tip[1].dose, 0);
  assert.equal(tip[1].plane, 'Intradérmico');
  assert.equal(line[1].strokeColor, '#123456');
  assert.equal(line[1].strokeWidth, 5);
  assert.equal(entries.find(([, m]) => m.annotationKind === 'text')[1].annotationText, 'Nota ficticia');
  encoded.mapping_data.lab.meta.line.strokeColor = 'url(javascript:invalid)';
  assert.throws(() => records.importLocalRecord(JSON.stringify(encoded), []), /metadatos/);
});

test('ojeras cerradas no alcanzan la vertiente nasal medial', () => {
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: atlas.positions[i * 3], y: -atlas.positions[i * 3 + 1] }));
  const map = regions.buildFaceRegionMap(landmarks, atlas.triangles, 1, atlas.positions);
  const labels = regions.buildFaceTriangleRegions(map, atlas.positions);
  const zone = ids => labels[Array.from({ length: labels.length }, (_, i) => i)
    .find(i => ids.every(id => atlas.triangles.slice(i * 3, i * 3 + 3).includes(id)))];
  assert.equal(zone([121, 232, 120]), 'Ojeras');
  assert.equal(zone([350, 452, 349]), 'Ojeras');
  assert.notEqual(zone([233, 128, 245]), 'Ojeras');
  assert.notEqual(zone([453, 357, 465]), 'Ojeras');
  assert.equal(zone([6, 122, 168]), 'Dorso nasal');
});
