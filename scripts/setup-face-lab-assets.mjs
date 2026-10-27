// Copia WASM y verifica los modelos Face Landmarker/Hair Segmenter del laboratorio.
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
const hairResponse = await fetch('https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite');
if (!hairResponse.ok) throw new Error(`Descarga de Hair Segmenter fallida: HTTP ${hairResponse.status}`);
const hairModel = Buffer.from(await hairResponse.arrayBuffer());
const hairHash = createHash('sha256').update(hairModel).digest('hex');
if (hairHash !== '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84') throw new Error(`Checksum inválido para Hair Segmenter: ${hairHash}`);
writeFileSync('public/models/face/hair_segmenter.tflite', hairModel);
console.log(`Hair Segmenter verificado: ${hairModel.length} bytes.`);
const headResponse = await fetch('https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite');
if (!headResponse.ok) throw new Error(`Descarga de Selfie Multiclass fallida: HTTP ${headResponse.status}`);
const headModel = Buffer.from(await headResponse.arrayBuffer());
const headHash = createHash('sha256').update(headModel).digest('hex');
if (headHash !== 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0') throw new Error(`Checksum inválido para Selfie Multiclass: ${headHash}`);
writeFileSync('public/models/face/selfie_multiclass.tflite', headModel);
console.log(`Selfie Multiclass verificado: ${headModel.length} bytes.`);
