import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cache = new Map();
export function loadFaceAreaModule(file) {
  if (cache.has(file)) return cache.get(file);
  if (file.endsWith('.json')) return JSON.parse(readFileSync(file, 'utf8'));
  const exports = {};
  cache.set(file, exports);
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, { exports, console, Float32Array, Uint8Array, Uint8ClampedArray, ArrayBuffer,
    require(name) {
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(file), name);
      const target = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p));
      if (!target) throw new Error(`Módulo local inexistente: ${base}`);
      return loadFaceAreaModule(target);
    },
  }, { filename: file });
  return exports;
}
