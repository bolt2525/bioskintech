import type { InferenceSession } from 'onnxruntime-web';
import { cropSkinProbability, prepareSkinTensor, skinLetterboxGeometry, SKIN_MODEL, type SkinWorkerResponse } from './skinLearnedImage';

let loading: Promise<InferenceSession> | undefined;
const send = (message: SkinWorkerResponse) => self.postMessage(message);

async function loadModel() {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('/onnx/1.22.0/', self.location.origin).href;
  send({ kind: 'progress', message: 'Preparando motor local… El modelo y su motor se cargan internamente.' });
  const response = await fetch(SKIN_MODEL.url);
  if (!response.ok) throw new Error(`No se pudo cargar el modelo local (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== SKIN_MODEL.bytes || hash !== SKIN_MODEL.sha256) {
    throw new Error('El modelo descargado no coincide con la versión verificada. No se realizará el análisis.');
  }
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

self.onmessage = async (event: MessageEvent<{ image: ImageBitmap }>) => {
  const image = event.data.image;
  try {
    skinLetterboxGeometry(image.width, image.height);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('El navegador no permite leer esta foto en segundo plano.');
    context.drawImage(image, 0, 0);
    image.close();
    const width = canvas.width, height = canvas.height;
    send({ kind: 'progress', message: 'Preparando la fotografía en el dispositivo…' });
    const start = performance.now();
    const { input } = prepareSkinTensor(context.getImageData(0, 0, width, height));
    canvas.width = canvas.height = 1;
    loading ??= loadModel();
    const session = await loading;
    const ort = await import('onnxruntime-web/wasm');
    send({ kind: 'progress', message: 'Analizando la foto localmente…' });
    const tensor = new ort.Tensor('float32', input, [1, 3, SKIN_MODEL.size, SKIN_MODEL.size]);
    try {
      const outputs = await session.run({ image: tensor });
      const output = outputs.probability;
      try {
        if (!output || output.type !== 'float32' || !(output.data instanceof Float32Array) ||
          output.dims.length !== 4 || output.dims.some((value, i) => value !== [1, 1, SKIN_MODEL.size, SKIN_MODEL.size][i])) {
          throw new Error('La salida del motor no corresponde al modelo verificado.');
        }
        const result = { ...cropSkinProbability(output.data, width, height), milliseconds: performance.now() - start };
        self.postMessage({ kind: 'result', result } satisfies SkinWorkerResponse, { transfer: [result.probability.buffer] });
      } finally { output?.dispose(); }
    } finally { tensor.dispose(); }
  } catch (error) {
    image.close();
    send({ kind: 'error', message: error instanceof Error ? error.message : 'No se pudo completar el análisis local.' });
  }
};
