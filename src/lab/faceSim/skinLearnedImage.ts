export const SKIN_MODEL = {
  url: '/models/skin/memi-v1-9a835a8f.onnx',
  sha256: '9a835a8fe458387305392c40f293f7389eb2375d7df39fd53c5d661431dcfa4b',
  bytes: 12869125, size: 256, threshold: .35,
} as const;
const COEFFICIENT_SCALE = 2 ** 22;

function evenRound(value: number) {
  const floor = Math.floor(value);
  return value - floor === .5 ? floor + floor % 2 : Math.round(value);
}

export function skinLetterboxGeometry(width: number, height: number, size: number = SKIN_MODEL.size) {
  if (![width, height, size].every(Number.isSafeInteger) || width < 1 || height < 1 ||
    width > 8192 || height > 8192 || width * height > 16_777_216 || size < 1 || size > 512) {
    throw new RangeError('Usa una foto de hasta 16 megapíxeles y lados de hasta 8192 px.');
  }
  const scale = size / Math.max(width, height);
  const w = Math.max(1, evenRound(width * scale)), h = Math.max(1, evenRound(height * scale));
  return { w, h, x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2) };
}

function coefficients(source: number, target: number) {
  const scale = source / target, support = Math.max(1, scale);
  return Array.from({ length: target }, (_, index) => {
    const center = (index + .5) * scale;
    const start = Math.max(0, Math.floor(center - support + .5));
    const end = Math.min(source, Math.floor(center + support + .5));
    const weights = Array.from({ length: end - start }, (_, i) =>
      Math.max(0, 1 - Math.abs((start + i + .5 - center) / support)));
    const sum = weights.reduce((total, value) => total + value, 0);
    return { start, weights: weights.map(value => Math.floor(value / sum * COEFFICIENT_SCALE + .5)) };
  });
}

/** Bilineal RGB: coeficientes de 22 bits y redondeo a 8 bits por eje, como PIL. */
export function prepareSkinTensor(image: { width: number; height: number; data: Uint8ClampedArray }, size: number = SKIN_MODEL.size) {
  const { width, height, data } = image, geometry = skinLetterboxGeometry(width, height, size);
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('Los píxeles no corresponden a la foto.');
  }
  const { w, h, x, y } = geometry;
  const horizontal = new Uint8Array(w * height * 3);
  const columns = coefficients(width, w), rows = coefficients(height, h);
  for (let row = 0; row < height; row++) for (let col = 0; col < w; col++) {
    const { start, weights } = columns[col];
    for (let channel = 0; channel < 3; channel++) {
      let sum = COEFFICIENT_SCALE / 2;
      for (let i = 0; i < weights.length; i++) sum += data[(row * width + start + i) * 4 + channel] * weights[i];
      horizontal[(row * w + col) * 3 + channel] = Math.floor(sum / COEFFICIENT_SCALE);
    }
  }
  const input = new Float32Array(3 * size * size).fill(-1);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const { start, weights } = rows[row];
    for (let channel = 0; channel < 3; channel++) {
      let sum = COEFFICIENT_SCALE / 2;
      for (let i = 0; i < weights.length; i++) sum += horizontal[((start + i) * w + col) * 3 + channel] * weights[i];
      const value = Math.floor(sum / COEFFICIENT_SCALE);
      input[channel * size * size + (row + y) * size + col + x] = Math.fround(Math.fround(value / 127.5) - 1);
    }
  }
  return { input, geometry };
}

export function cropSkinProbability(probability: Float32Array, width: number, height: number, size: number = SKIN_MODEL.size) {
  const { w, h, x, y } = skinLetterboxGeometry(width, height, size);
  if (!(probability instanceof Float32Array) || probability.length !== size * size ||
    probability.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError('El motor devolvió probabilidades inválidas.');
  }
  const cropped = new Float32Array(w * h);
  for (let row = 0; row < h; row++) cropped.set(probability.subarray((row + y) * size + x, (row + y) * size + x + w), row * w);
  return { probability: cropped, width: w, height: h };
}

export interface SkinLearnedResult { probability: Float32Array; width: number; height: number; milliseconds: number }
export type SkinWorkerResponse =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; result: SkinLearnedResult }
  | { kind: 'error'; message: string };
