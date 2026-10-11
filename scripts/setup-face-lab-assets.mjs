// Copia el WASM de MediaPipe y descarga el modelo Face Landmarker para el Laboratorio 3D.
// Se sirven desde el mismo origen (la CSP bloquea CDNs). Uso: npm run lab:face-assets
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

mkdirSync('public/mediapipe', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
mkdirSync('public/models/face', { recursive: true });
const target = 'public/models/face/face_landmarker.task';
if (!existsSync(target)) {
  try {
    const res = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task');
    if (!res.ok) throw new Error(`Descarga fallida: ${res.status}`);
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  } catch (error) {
    console.warn(`No se pudo descargar Face Landmarker; el laboratorio conservará el marco manual. ${error instanceof Error ? error.message : ''}`);
  }
}
console.log('Assets de MediaPipe listos en public/.');
