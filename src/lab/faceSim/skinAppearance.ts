export type SkinAppearanceChannel = 'contrast' | 'redness' | 'texture';
/** Selección ampliada; el tipo anterior se conserva para mapas de la UI de tres canales. */
export type SkinAppearanceVisualChannel = SkinAppearanceChannel | 'shine';
/** Candidatos puramente visuales; no añade opciones a la UI anterior. */
export type SkinSignalChannel = SkinAppearanceVisualChannel | 'poreCandidates' | 'redDots';

export interface SkinAppearanceLayer {
  rgba: Uint8ClampedArray;
  /** Fracción del ROI original; no porcentaje de severidad. */
  coverage: number;
  highlightedPixels: number;
  /** Permite distinguir ausencia de señal de imposibilidad de analizar. */
  status: 'unavailable' | 'no-signal' | 'highlighted';
  /** Umbral de la magnitud interna del canal, no una unidad clínica. */
  threshold: number;
}

export interface SkinAppearanceResult {
  usable: boolean;
  warnings: string[];
  channels: Record<SkinAppearanceVisualChannel, SkinAppearanceLayer>;
  candidates: Record<'poreCandidates' | 'redDots', SkinAppearanceLayer>;
  diagnostics: {
    roiPixels: number;
    analyzedPixels: number;
    analyzedFraction: number;
    noisyFraction: number;
    localRadius: number;
    referenceRadius: number;
  };
}

export function skinSignalLayer(result: SkinAppearanceResult, channel: SkinSignalChannel): SkinAppearanceLayer {
  return channel === 'poreCandidates' || channel === 'redDots' ? result.candidates[channel] : result.channels[channel];
}

const LIMITATIONS = [
  'Simulación visual local de RGB; no es un diagnóstico ni una recomendación.',
  'Los canales muestran diferencias cromáticas/oscuras locales, rojez relativa y microcontraste; no identifican lesiones, lunares, pecas, granos, comedones, vasos superficiales o profundos ni poros reales.',
  'La cobertura es la fracción de píxeles del ROI resaltados, no un score clínico. Luz, maquillaje, compresión y ruido pueden alterar el resultado.',
  'El padre debe excluir ojos, labios, pelo y fondo del ROI. Se omiten bordes y cambios abruptos; no se puede certificar enfoque, color real ni anatomía con RGB.',
  'El brillo aparente combina aclaramiento y pérdida relativa de saturación; no mide grasa, hidratación ni identifica zona T. RGB no detecta arterias, venas, lesiones reales ni profundidad.',
  'Textura significa microcontraste aparente: no permite separar con certeza detalle superficial, ruido, enfoque o compresión.',
  'Los candidatos son agrupaciones RGB pequeñas y compactas: no confirman poros, acné ni vasos reales. El contraste aparente no mide melanina ni identifica pigmentación real.',
];

function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Suelo contra cuantización y techo para no borrar señal extendida al normalizarla contra sí misma. */
function robustThreshold(values: number[], floor: number): number {
  const center = median(values);
  if (center >= floor * 1.5) return floor * 1.5;
  const deviation = median(values.map(value => Math.abs(value - center)));
  return Math.max(floor, Math.min(floor * 1.5, center + 3 * 1.4826 * deviation));
}

function chroma(red: number, green: number): number {
  return Math.hypot(red - 1 / 3, green - 1 / 3, 2 / 3 - red - green);
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

/** Retiene agrupaciones pequeñas y compactas, no líneas ni regiones extensas. */
function retainCompactCandidates(active: Uint8Array, width: number, height: number): void {
  const visited = new Uint8Array(active.length);
  const maxSide = Math.max(5, Math.round(Math.min(width, height) / 16));
  for (let start = 0; start < active.length; start++) {
    if (!active[start] || visited[start]) continue;
    const group = [start];
    visited[start] = 1;
    let left = width, right = 0, top = height, bottom = 0;
    for (let cursor = 0; cursor < group.length; cursor++) {
      const i = group[cursor], x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, j = ny * width + nx;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || visited[j] || !active[j]) continue;
        visited[j] = 1; group.push(j);
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (group.length < 3 || Math.max(w, h) > maxSide
      || Math.max(w / h, h / w) > 2.5 || group.length / (w * h) < 0.25) {
      for (const i of group) active[i] = 0;
    }
  }
}

/**
 * Análisis síncrono, determinista y sin E/S. No muta image ni mask.
 * RGBA de 8 bits, sin premultiplicar, y máscara construida por el padre (no cero = ROI).
 * Entrada malformada: TypeError/RangeError. Calidad insuficiente: usable=false,
 * motivo en warnings y todas las capas a cero (status=unavailable).
 * Uniforme válido: usable=true, cobertura cero y status=no-signal, nunca "ausencia de lesiones".
 * diagnostics.analyzedFraction expresa soporte efectivo, no confianza diagnóstica.
 * No aplica corrección de balance de blancos ni reconstruye color perdido por recorte.
 * Soporta hasta 4 194 304 píxeles, lados <=4096; diseñado para imágenes de unos 384 px.
 * sensitivity: 0..1, por defecto 0.5; ajusta umbrales visuales, no la calidad ni el ROI.
 * candidates añade filtros compactos sin cambiar las claves históricas de channels.
 */
export function analyzeSkinAppearance(
  image: { width: number; height: number; data: Uint8ClampedArray },
  mask: Uint8Array,
  options: { sensitivity?: number } = {},
): SkinAppearanceResult {
  const sensitivity = options.sensitivity ?? 0.5;
  if (!Number.isFinite(sensitivity) || sensitivity < 0 || sensitivity > 1) {
    throw new RangeError('Sensibilidad inválida: se requiere un número entre 0 y 1.');
  }
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
  const layer = (): SkinAppearanceLayer => ({
    rgba: new Uint8ClampedArray(size * 4), coverage: 0,
    highlightedPixels: 0, status: 'unavailable', threshold: 0,
  });
  const result: SkinAppearanceResult = {
    usable: false,
    warnings: [...LIMITATIONS],
    channels: {
      contrast: layer(), redness: layer(), texture: layer(), shine: layer(),
    },
    candidates: { poreCandidates: layer(), redDots: layer() },
    diagnostics: {
      roiPixels: 0, analyzedPixels: 0, analyzedFraction: 0, noisyFraction: 0,
      localRadius: 0, referenceRadius: 0,
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
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const sum = Math.max(1, r + g + b);
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // No mezclar píxeles transparentes, recortados o casi negros con el soporte del filtro.
    if (data[i * 4 + 3] >= 250 && low > 2 && high < 253 && light >= 20 && light <= 245) {
      roi[i] = 1;
      luminance[i] = light;
      red[i] = r / sum;
      green[i] = g / sum;
    }
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
  result.diagnostics.roiPixels = roiCount;
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
  const impulses = new Uint8Array(size);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    if (boxSum(counts, stride, x, y, 1) !== 9) continue;
    const smallLight = boxSum(lights, stride, x, y, 1) / 9;
    const chromaticResidual = Math.hypot(
      red[i] - boxSum(reds, stride, x, y, 1) / 9,
      green[i] - boxSum(greens, stride, x, y, 1) / 9,
    );
    if (Math.abs(luminance[i] - smallLight) > Math.max(18, smallLight * 0.16)
      || chromaticResidual > 0.045) impulses[i] = 1;
  }
  const impulseSums = integral(impulses, width, height);
  // Evitar bordes abruptos y su vecindad, incluidos ojos si el ROI llega hasta su borde.
  const edges = new Uint8Array(size);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!roi[i]) continue;
    const neighbors = [];
    if (x + 1 < width) neighbors.push(i + 1);
    if (y + 1 < height) neighbors.push(i + width);
    for (const j of neighbors) {
      if (roi[j] && (Math.abs(luminance[i] - luminance[j]) > 45
        || Math.hypot(red[i] - red[j], green[i] - green[j]) > 0.13)) {
        edges[i] = 1;
        edges[j] = 1;
      }
    }
  }
  const edgeSums = integral(edges, width, height);
  const radius = Math.max(4, Math.min(12, Math.round(Math.min(width, height) / 32)));
  const referenceRadius = Math.max(radius, Math.round(Math.min(width, height) / 8));
  result.diagnostics.localRadius = radius;
  result.diagnostics.referenceRadius = referenceRadius;
  const area = (2 * radius + 1) ** 2;
  const candidates: number[] = [];
  const contrast: number[] = [], redness: number[] = [], texture: number[] = [], shine: number[] = [];
  const smallDark: number[] = [];
  let noisy = 0;
  let supported = 0;
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < width - radius; x++) {
    const i = y * width + x;
    // Centro 3×3 íntegro y referencia ponderada por ROI: sin contaminación exterior
    // ni erosión de todo el radio (que vaciaba máscaras pequeñas o con huecos).
    const localCount = boxSum(counts, stride, x, y, radius);
    if (localCount < area * 0.72 || boxSum(counts, stride, x, y, 1) !== 9) continue;
    const smallLight = boxSum(lights, stride, x, y, 1) / 9;
    const residual = Math.abs(luminance[i] - smallLight);
    if (impulses[i]) noisy++;
    // Contabilizar ruido antes de excluir bordes evita aceptar ruido como una capa vacía válida.
    candidates.push(i);
    const smallRed = boxSum(reds, stride, x, y, 1) / 9;
    const smallGreen = boxSum(greens, stride, x, y, 1) / 9;
    const smallChroma = chroma(smallRed, smallGreen);
    // Excluir el soporte de cada escala, no solo el píxel de borde: evita halos residuales.
    const blocked = boxSum(edgeSums, stride, x, y, radius) > 0
      || boxSum(impulseSums, stride, x, y, 1) > 0;
    if (!blocked) supported++;
    let contrastValue = 0, rednessValue = 0, shineValue = 0;
    // Dos escalas: diferencias pequeñas y regiones suaves más amplias, sin baseline global
    // que confunda gradientes de iluminación con cambios de superficie.
    const largeRadius = Math.min(referenceRadius, x, y, width - x - 1, height - y - 1);
    if (!blocked) for (const r of largeRadius === radius ? [radius] : [radius, largeRadius]) {
      const count = r === radius ? localCount : boxSum(counts, stride, x, y, r);
      if (count < (2 * r + 1) ** 2 * 0.72 || boxSum(edgeSums, stride, x, y, r) > 0) continue;
      const baseLight = boxSum(lights, stride, x, y, r) / count;
      const baseRed = boxSum(reds, stride, x, y, r) / count;
      const baseGreen = boxSum(greens, stride, x, y, r) / count;
      const colorDifference = Math.hypot(smallRed - baseRed, smallGreen - baseGreen);
      contrastValue = Math.max(contrastValue,
        Math.max(0, baseLight - smallLight) / Math.max(40, baseLight) / 0.055,
        colorDifference / 0.025);
      rednessValue = Math.max(rednessValue, (smallRed - smallGreen) - (baseRed - baseGreen));
      const baseChroma = chroma(baseRed, baseGreen);
      const desaturation = Math.max(0, baseChroma - smallChroma) / Math.max(0.03, baseChroma);
      shineValue = Math.max(shineValue, Math.min(
        Math.max(0, smallLight - baseLight) / Math.max(40, baseLight), desaturation * 0.5,
      ));
    }
    contrast.push(contrastValue);
    redness.push(rednessValue);
    texture.push(blocked || residual < 3 ? 0 : residual / Math.max(40, smallLight));
    shine.push(shineValue);
    smallDark.push(blocked ? 0 : Math.max(0,
      boxSum(lights, stride, x, y, radius) / localCount - smallLight,
    ) / Math.max(40, smallLight));
  }
  if (candidates.length < Math.max(32, roiCount * 0.1)) {
    return reject('ROI demasiado estrecho o resolución insuficiente tras excluir bordes.');
  }
  result.diagnostics.noisyFraction = noisy / candidates.length;
  if (result.diagnostics.noisyFraction > 0.35) return reject('calidad insuficiente: ruido o microcontraste extremo generalizado.');
  if (supported < Math.max(32, roiCount * 0.1)) {
    return reject('calidad insuficiente: predominan bordes abruptos o píxeles sin señal local utilizable.');
  }

  result.diagnostics.analyzedPixels = supported;
  result.diagnostics.analyzedFraction = supported / roiCount;
  if (supported / roiCount < 0.5) result.warnings.unshift('Soporte parcial: menos de la mitad del ROI tiene señal local analizable.');
  const paint = (channel: SkinSignalChannel, values: number[], floor: number, color: number[], compact = false) => {
    const threshold = robustThreshold([...values], floor) * (1.5 - sensitivity);
    const output = skinSignalLayer(result, channel);
    const active = new Uint8Array(size);
    values.forEach((value, index) => {
      if (value > threshold) active[candidates[index]] = 1;
    });
    if (compact) retainCompactCandidates(active, width, height);
    let highlighted = 0;
    values.forEach((value, index) => {
      if (value <= threshold) return;
      const i = candidates[index];
      if (!active[i]) return;
      // No representar motas aisladas de cuantización como detalle resuelto.
      // Se consulta el mapa original, sin propagar ni rellenar huecos del ROI.
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        neighbors += active[i + dy * width + dx];
      }
      if (neighbors < 3) return;
      const offset = i * 4;
      output.rgba.set(color, offset);
      // Escala acotada, no min/max de la foto: una fluctuación mínima nunca llena la capa.
      output.rgba[offset + 3] = Math.round(50 + 140 * Math.min(1, (value - threshold) / (2 * threshold)));
      highlighted++;
    });
    output.coverage = highlighted / roiCount;
    output.highlightedPixels = highlighted;
    output.status = highlighted ? 'highlighted' : 'no-signal';
    output.threshold = threshold;
  };
  paint('contrast', contrast, 1, [245, 158, 11]);
  paint('redness', redness, 0.025, [239, 68, 68]);
  paint('texture', texture, 0.025, [139, 92, 246]);
  paint('shine', shine, 0.06, [14, 165, 233]);
  paint('poreCandidates', smallDark, 0.045, [6, 182, 212], true);
  paint('redDots', redness, 0.025, [244, 63, 94], true);
  result.usable = true;
  return result;
}
