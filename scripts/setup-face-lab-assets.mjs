// Copia el WASM de MediaPipe y descarga el modelo Face Landmarker para el Laboratorio 3D.
// Se sirven desde el mismo origen (la CSP bloquea CDNs). Uso: npm run lab:face-assets
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  if (statSync(`public/mediapipe/wasm/${file}`).size === 0) throw new Error(`Asset WASM vacío: ${file}`);
}

mkdirSync('public/models/face', { recursive: true });
const target = 'public/models/face/face_landmarker.task';
const res = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task');
if (!res.ok) throw new Error(`Descarga de Face Landmarker fallida: HTTP ${res.status}`);

const model = Buffer.from(await res.arrayBuffer());
const expectedHash = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
const actualHash = createHash('sha256').update(model).digest('hex');
if (actualHash !== expectedHash) throw new Error(`Checksum inválido para Face Landmarker: ${actualHash}`);
writeFileSync(target, model);
console.log(`Assets de MediaPipe verificados en public/ (modelo: ${model.length} bytes).`);
