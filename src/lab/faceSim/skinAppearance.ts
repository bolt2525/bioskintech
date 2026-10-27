export type SkinAppearanceChannel = 'contrast' | 'redness' | 'texture';

export interface SkinAppearanceResult {
  usable: boolean;
  warnings: string[];
  channels: Record<SkinAppearanceChannel, { rgba: Uint8ClampedArray; coverage: number }>;
}

const LIMITATIONS = [
  'Visualización educativa local de RGB; no es un diagnóstico ni una recomendación.',
  'Los canales muestran diferencias cromáticas/oscuras locales, rojez relativa y microcontraste; no identifican lesiones, lunares, pecas, granos, comedones, vasos superficiales o profundos ni poros reales.',
  'La cobertura es la fracción de píxeles del ROI resaltados, no un score clínico. Luz, maquillaje, compresión y ruido pueden alterar el resultado.',
  'El padre debe excluir ojos, labios, pelo y fondo del ROI. Se omiten bordes y cambios abruptos; no se puede certificar enfoque, color real ni anatomía con RGB.',
];

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Un suelo absoluto evita amplificar cuantización; MAD evita normalizar todo a "hallazgos". */
function robustThreshold(values: number[], floor: number): number {
  const center = median(values);
  const deviation = median(values.map(value => Math.abs(value - center)));
  return Math.max(floor, center + 3 * 1.4826 * deviation);
}

function integral(values: ArrayLike<number>, width: number, height: number): Float64Array {
  const stride = width + 1;
  const result = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x];
      result[(y + 1) * stride + x + 1] = result[y * stride + x + 1] + row;
    }
  }
  return result;
}

function boxSum(table: Float64Array, stride: number, x: number, y: number, radius: number): number {
  const left = x - radius;
  const right = x + radius + 1;
  const top = y - radius;
  const bottom = y + radius + 1;
  return table[bottom * stride + right] - table[top * stride + right]
    - table[bottom * stride + left] + table[top * stride + left];
}

/**
 * Análisis síncrono, determinista y sin E/S. No muta image ni mask.
 * RGBA de 8 bits, sin premultiplicar, y máscara construida por el padre (no cero = ROI).
 * Entrada malformada: TypeError/RangeError. Calidad insuficiente: usable=false,
 * motivo en warnings y todas las capas a cero. Uniforme válido: usable=true, cobertura cero.
 * Soporta hasta 4 194 304 píxeles, lados <=4096; diseñado para imágenes de unos 384 px.
 */
export function analyzeSkinAppearance(
  image: { width: number; height: number; data: Uint8ClampedArray },
  mask: Uint8Array,
): SkinAppearanceResult {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width <= 0 || image.height <= 0
    || image.width > 4096 || image.height > 4096 || image.width * image.height > 4_194_304) {
    throw new RangeError('Dimensiones inválidas: enteros positivos, lados <=4096 y hasta 4194304 píxeles.');
  }
  const { width, height, data } = image;
  const size = width * height;
  if (!(data instanceof Uint8ClampedArray) || data.length !== size * 4) {
    throw new TypeError('RGBA inválido: se requiere Uint8ClampedArray de longitud width*height*4.');
  }
  if (!(mask instanceof Uint8Array) || mask.length !== size) {
    throw new TypeError('Máscara inválida: se requiere Uint8Array de longitud width*height.');
  }
  const result: SkinAppearanceResult = {
    usable: false,
    warnings: [...LIMITATIONS],
    channels: {
      contrast: { rgba: new Uint8ClampedArray(size * 4), coverage: 0 },
      redness: { rgba: new Uint8ClampedArray(size * 4), coverage: 0 },
      texture: { rgba: new Uint8ClampedArray(size * 4), coverage: 0 },
    },
  };
  const reject = (reason: string): SkinAppearanceResult => {
    result.warnings.unshift(`No utilizable: ${reason}`);
    return result;
  };

  const luminance = new Float32Array(size);
  const red = new Float32Array(size);
  const green = new Float32Array(size);
  const roi = new Uint8Array(size);
  let roiCount = 0;
  let dark = 0;
  let clipped = 0;
  let transparent = 0;
  let blueCyan = 0;
  let monochromatic = 0;
  let neutral = 0;
  let lightSum = 0;
  for (let i = 0; i < size; i++) {
    if (!mask[i]) continue;
    roi[i] = 1;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const sum = Math.max(1, r + g + b);
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[i] = light;
    red[i] = r / sum;
    green[i] = g / sum;
    roiCount++;
    lightSum += light;
    if (light < 25) dark++;
    if (low <= 2 || high >= 253) clipped++;
    if (data[i * 4 + 3] < 250) transparent++;
    if ((b > r * 1.12 && b - r > 15)
      || (g > r * 1.18 && g - r > 18 && b > r * 1.08)) blueCyan++;
    if (high - low > 70 && high > Math.max(1, low) * 2.8) monochromatic++;
    if ((high - low) / Math.max(1, high) < 0.035) neutral++;
  }
  if (roiCount < 64) return reject('ROI vacío o insuficiente (mínimo 64 píxeles).');
  if (blueCyan / roiCount > 0.35) {
    return reject('dominante de iluminación fuertemente azul/cian; el RGB no permite interpretar el color de la superficie.');
  }
  if (monochromatic / roiCount > 0.6 || neutral / roiCount > 0.9) {
    return reject('imagen monocromática o sin información cromática suficiente.');
  }
  if (lightSum / roiCount < 35 || dark / roiCount > 0.45) {
    return reject('oscuridad excesiva para comparar variaciones locales.');
  }
  if (clipped / roiCount > 0.2) return reject('saturación o recorte de canales RGB excesivo.');
  if (transparent / roiCount > 0.05) return reject('calidad insuficiente: demasiados píxeles transparentes en el ROI.');

  const stride = width + 1;
  const counts = integral(roi, width, height);
  const lights = integral(luminance, width, height);
  const reds = integral(red, width, height);
  const greens = integral(green, width, height);
  // Evitar bordes abruptos y su vecindad, incluidos ojos si el ROI llega hasta su borde.
  const edges = new Uint8Array(size);
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const i = y * width + x;
    if (!mask[i]) continue;
    for (const j of [i + 1, i + width]) {
      if (mask[j] && (Math.abs(luminance[i] - luminance[j]) > 45
        || Math.hypot(red[i] - red[j], green[i] - green[j]) > 0.13)) {
        edges[i] = 1;
        edges[j] = 1;
      }
    }
  }
  const edgeSums = integral(edges, width, height);
  const radius = Math.max(4, Math.min(12, Math.round(Math.min(width, height) / 32)));
  const area = (2 * radius + 1) ** 2;
  const candidates: number[] = [];
  const contrast: number[] = [], redness: number[] = [], texture: number[] = [];
  let noisy = 0;
  let supported = 0;
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < width - radius; x++) {
    const i = y * width + x;
    // Erosión completa: ningún promedio mezcla piel con exterior, huecos u ojos excluidos.
    if (boxSum(counts, stride, x, y, radius) !== area) continue;
    const smallLight = boxSum(lights, stride, x, y, 1) / 9;
    const residual = Math.abs(luminance[i] - smallLight);
    if (residual > Math.max(18, smallLight * 0.16)) noisy++;
    // Contabilizar ruido antes de excluir bordes evita aceptar ruido como una capa vacía válida.
    candidates.push(i);
    const baseLight = boxSum(lights, stride, x, y, radius) / area;
    const smallRed = boxSum(reds, stride, x, y, 1) / 9;
    const smallGreen = boxSum(greens, stride, x, y, 1) / 9;
    const baseRed = boxSum(reds, stride, x, y, radius) / area;
    const baseGreen = boxSum(greens, stride, x, y, radius) / area;
    const colorDifference = Math.hypot(smallRed - baseRed, smallGreen - baseGreen);
    // Excluir todo el soporte del filtro grande, no solo el borde: evita halos residuales.
    const blocked = boxSum(edgeSums, stride, x, y, radius) > 0
      || luminance[i] < 20 || luminance[i] > 245;
    if (!blocked) supported++;
    contrast.push(blocked ? 0 : Math.max(
      Math.max(0, baseLight - smallLight) / Math.max(40, baseLight) / 0.055,
      colorDifference / 0.025,
    ));
    redness.push(blocked ? 0 : Math.max(0, (smallRed - smallGreen) - (baseRed - baseGreen)));
    texture.push(blocked || residual < 3 ? 0 : residual / Math.max(40, smallLight));
  }
  if (candidates.length < Math.max(32, roiCount * 0.1)) {
    return reject('ROI demasiado estrecho o resolución insuficiente tras excluir bordes.');
  }
  if (noisy / candidates.length > 0.35) return reject('calidad insuficiente: ruido o microcontraste extremo generalizado.');
  if (supported < Math.max(32, roiCount * 0.1)) {
    return reject('calidad insuficiente: predominan bordes abruptos o píxeles sin señal local utilizable.');
  }

  const paint = (channel: SkinAppearanceChannel, values: number[], floor: number, color: number[]) => {
    const threshold = robustThreshold([...values], floor);
    const output = result.channels[channel];
    let highlighted = 0;
    values.forEach((value, index) => {
      if (value <= threshold) return;
      const offset = candidates[index] * 4;
      output.rgba.set(color, offset);
      // Escala acotada, no min/max de la foto: una fluctuación mínima nunca llena la capa.
      output.rgba[offset + 3] = Math.round(50 + 140 * Math.min(1, (value - threshold) / (2 * threshold)));
      highlighted++;
    });
    output.coverage = highlighted / roiCount;
  };
  paint('contrast', contrast, 1, [245, 158, 11]);
  paint('redness', redness, 0.025, [239, 68, 68]);
  paint('texture', texture, 0.025, [139, 92, 246]);
  result.usable = true;
  return result;
}
