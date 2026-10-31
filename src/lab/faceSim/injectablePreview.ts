import type { SimMode } from './engine';

/** Contrato visual local: deliberadamente no acepta dosis, productos ni zonas clínicas. */
export interface PreviewSettings {
  after: boolean;
  /** Intensidad global (0–1). */
  intensity: number;
  enabled: Record<SimMode, boolean>;
  /** Variador por inyectable (0–1.5, 1 = neutro). Opcional para compatibilidad. */
  levels?: Partial<Record<SimMode, number>>;
  /** Escala visual del área de cobertura por categoría (0.5–2, 1 = neutro). No es un radio clínico. */
  coverage?: Partial<Record<SimMode, number>>;
  /** Indica al visor que dibuje las áreas de cobertura; los filtros de píxel/superficie lo ignoran. */
  showCoverage?: boolean;
}
export interface PreviewSample {
  mode: SimMode;
  x: number;
  y: number;
}
/** Área circular de cobertura visual (radio normalizado a la altura; en X dividir por el aspecto). */
export interface PreviewCoverageArea extends PreviewSample {
  radius: number;
}
export const DEFAULT_PREVIEW: PreviewSettings = {
  after: true,
  intensity: 0.6,
  enabled: { toxina: true, relleno_ha: true, hidratacion: true, bioestimulador: true },
  levels: { toxina: 1, relleno_ha: 1, hidratacion: 1, bioestimulador: 1 },
  coverage: { toxina: 1, relleno_ha: 1, hidratacion: 1, bioestimulador: 1 },
  showCoverage: false,
};
export const PREVIEW_DESCRIPTIONS: Record<SimMode, string> = {
  toxina: 'Filtro que atenúa el detalle fino y las líneas más anchas existentes, protegiendo bordes marcados. No inventa líneas ni simula relajación muscular.',
  relleno_ha: 'Proyección local de la malla proporcional a la altura facial (hasta 3 %) y brillo de piel. Los labios conservan su textura. No representa ml inyectados ni predice resultados.',
  hidratacion: 'Suavizado cosmético local de microtextura y luminosidad, con protección de bordes. No mide hidratación ni predice resultados.',
  bioestimulador: 'Unifica textura y tono locales de forma ilustrativa; no simula producción de colágeno.',
};
/** Qué hace cada variador, en lenguaje de filtro. */
export const PREVIEW_FILTERS: Record<SimMode, string> = {
  toxina: 'Atenuar líneas',
  relleno_ha: 'Relieve y brillo',
  hidratacion: 'Suavizar y luminosidad',
  bioestimulador: 'Textura y tono',
};
export const MAX_LEVEL = 1.5;
export const MIN_COVERAGE = 0.5;
export const MAX_COVERAGE = 2;
/** Radio visual base por categoría, normalizado a la altura de la imagen. Puramente demostrativo. */
export const PREVIEW_COVERAGE_BASE: Readonly<Record<SimMode, number>> = {
  toxina: 0.065,
  relleno_ha: 0.045,
  hidratacion: 0.1,
  bioestimulador: 0.085,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Curva creciente sin meseta (barata, sin exp): la ganancia 1–1.5 sigue variando el resultado. */
const saturate = (max: number, half: number, weight: number) => (max * weight) / (weight + half);
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const strength = (settings: PreviewSettings) => settings.after && Number.isFinite(settings.intensity)
  ? clamp(settings.intensity, 0, 1) : 0;
const levelOf = (settings: PreviewSettings, mode: SimMode) => {
  const level = settings.levels?.[mode];
  return typeof level === 'number' && Number.isFinite(level) ? clamp(level, 0, MAX_LEVEL) : 1;
};

/** Ganancia final por inyectable = global × variador propio. */
export function previewGain(settings: PreviewSettings, mode: SimMode): number {
  return strength(settings) * levelOf(settings, mode);
}
/** Escala de cobertura saneada (0.5–2; 1 si falta o no es finita). */
export function previewCoverageScale(settings: PreviewSettings, mode: SimMode): number {
  const scale = settings.coverage?.[mode];
  return typeof scale === 'number' && Number.isFinite(scale) ? clamp(scale, MIN_COVERAGE, MAX_COVERAGE) : 1;
}
/** Radio visual normalizado (altura = 1) usado por píxeles, superficie, shader y overlay. */
export function previewRadius(settings: PreviewSettings, mode: SimMode): number {
  return PREVIEW_COVERAGE_BASE[mode] * previewCoverageScale(settings, mode);
}

/** Peso gaussiano compartido con el shader: exp(-d² / (0.5·r²)). */
const falloff = (distanceSq: number, radius: number) => Math.exp(-distanceSq / (0.5 * radius * radius));
/** Fuera de 2·r el peso es < 4e-4; se descarta para acotar el coste. */
const REACH = 2;

const isValidSample = (p: PreviewSample, settings: PreviewSettings) =>
  settings.enabled[p.mode] === true && Number.isFinite(p.x) && Number.isFinite(p.y);
const active = (samples: readonly PreviewSample[], settings: PreviewSettings) =>
  samples.filter(p => isValidSample(p, settings) && previewGain(settings, p.mode) > 0)
    .map(p => ({ mode: p.mode, x: p.x, y: p.y, gain: previewGain(settings, p.mode), radius: previewRadius(settings, p.mode) }));

/**
 * Áreas para que el visor dibuje la cobertura. Vacío si `showCoverage` no está activo.
 * No depende de antes/después ni de la intensidad global: solo de categoría activa y nivel > 0.
 */
export function previewCoverage(samples: readonly PreviewSample[], settings: PreviewSettings): PreviewCoverageArea[] {
  if (!settings.showCoverage) return [];
  return samples.filter(p => isValidSample(p, settings) && levelOf(settings, p.mode) > 0)
    .map(p => ({ mode: p.mode, x: p.x, y: p.y, radius: previewRadius(settings, p.mode) }));
}

/** Uniformes compatibles con el shader local, sin invocar el motor antiguo dosis→efecto. */
export function buildIllustrativeEffects(samples: readonly PreviewSample[], settings: PreviewSettings, aspect: number, limit = 64) {
  const list = strength(settings) ? active(samples, settings).slice(0, limit) : [];
  const a = new Float32Array(limit * 4), b = new Float32Array(limit * 4), c = new Float32Array(limit * 4);
  const fit = Number.isFinite(aspect) && aspect > 0 ? Math.min(1, aspect) : 1;
  list.forEach((p, i) => {
    // Ganancia sin recortar a 1: el shader ya acota la suma final.
    a.set([p.x, p.y, p.radius * fit, p.gain], i * 4);
    // Sin desplazamiento direccional ni perfiles anatómicos prescriptivos.
    b.set([p.mode === 'relleno_ha' ? 0.055 : p.mode === 'bioestimulador' ? 0.018 : 0,
      0, 0, p.mode === 'toxina' ? 0.45 : p.mode === 'bioestimulador' ? 0.12 : 0], i * 4);
    c.set([p.mode === 'hidratacion' ? 0.42 : p.mode === 'bioestimulador' ? 0.15 : 0, 0, 0, 0], i * 4);
  });
  return { count: list.length, a, b, c };
}

/**
 * Helper para el visor principal: posiciones + RGB opcional, UV con origen superior.
 * No muta buffers ni conoce dosis. Solo procesa vértices observados (no tapa/cabello).
 * La toxina modifica únicamente contraste RGB existente, nunca geometría/líneas.
 * El relieve escala con la altura observada, no con unidades arbitrarias del modelo ni dosis.
 */
export function previewSurface(
  positions: Float32Array, uvs: Float32Array, samples: readonly PreviewSample[], settings: PreviewSettings,
  aspect: number, rgb?: Float32Array, observedVertexCount = positions.length / 3,
) {
  const next = positions.slice(), colors = rgb?.slice();
  if (!strength(settings)) return { positions: next, rgb: colors };
  const list = active(samples, settings);
  if (!list.length) return { positions: next, rgb: colors };
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const count = Math.min(observedVertexCount, positions.length / 3, uvs.length / 2);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minY = Math.min(minY, positions[i * 3 + 1]); maxY = Math.max(maxY, positions[i * 3 + 1]);
  }
  const height = maxY > minY ? maxY - minY : 1;
  for (let i = 0; i < count; i++) {
    let relief = 0, glow = 0, soften = 0;
    for (const p of list) {
      const dx = (uvs[i * 2] - p.x) * ratio, dy = uvs[i * 2 + 1] - p.y;
      const w = falloff(dx * dx + dy * dy, p.radius) * p.gain;
      // Altura relativa: hasta 3 % para HA a ganancia 1,5; ilustrativo, nunca ml → volumen.
      relief = Math.max(relief, w * height * (p.mode === 'relleno_ha' ? 0.02 : p.mode === 'bioestimulador' ? 0.004 : 0));
      glow = Math.max(glow, w * (p.mode === 'hidratacion' ? 0.045 : p.mode === 'bioestimulador' ? 0.018 : 0));
      soften = Math.max(soften, p.mode === 'toxina' ? Math.min(0.6, w * 0.25) : 0);
    }
    // Conserva XY/UV y la abertura labial: solo cambia la profundidad de la máscara observada.
    next[i * 3 + 2] += relief;
    if (colors) for (let channel = 0; channel < 3; channel++) {
      const at = i * 3 + channel;
      colors[at] = clamp((colors[at] - 0.5) * (1 - soften) + 0.5 + glow, 0, 1);
    }
  }
  return { positions: next, rgb: colors };
}

/**
 * Media móvil horizontal sobre 4 planos intercalados. La ventana se recorta en los bordes,
 * así que siempre contiene el píxel central (n ≥ 1, sin divisiones por cero).
 */
function blurRows(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number) {
  const first = Math.min(radius, width - 1);
  for (let y = 0; y < height; y++) {
    const origin = y * width * 4;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = first + 1;
    for (let k = 0, at = origin; k <= first; k++, at += 4) { s0 += src[at]; s1 += src[at + 1]; s2 += src[at + 2]; s3 += src[at + 3]; }
    for (let x = 0; x < width; x++) {
      const at = origin + x * 4;
      dst[at] = s0 / n; dst[at + 1] = s1 / n; dst[at + 2] = s2 / n; dst[at + 3] = s3 / n;
      const add = x + radius + 1, drop = x - radius;
      if (add < width) { const a = origin + add * 4; s0 += src[a]; s1 += src[a + 1]; s2 += src[a + 2]; s3 += src[a + 3]; n++; }
      if (drop >= 0) { const d = origin + drop * 4; s0 -= src[d]; s1 -= src[d + 1]; s2 -= src[d + 2]; s3 -= src[d + 3]; n--; }
    }
  }
}
/** Media móvil vertical recorriendo filas completas (acceso secuencial a memoria). */
function blurColumns(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number) {
  const stride = width * 4, sum = new Float64Array(stride), first = Math.min(radius, height - 1);
  for (let k = 0; k <= first; k++) for (let j = 0, at = k * stride; j < stride; j++, at++) sum[j] += src[at];
  let n = first + 1;
  for (let y = 0; y < height; y++) {
    for (let j = 0, at = y * stride; j < stride; j++, at++) dst[at] = sum[j] / n;
    const add = y + radius + 1, drop = y - radius;
    if (add < height) { for (let j = 0, at = add * stride; j < stride; j++, at++) sum[j] += src[at]; n++; }
    if (drop >= 0) { for (let j = 0, at = drop * stride; j < stride; j++, at++) sum[j] -= src[at]; n--; }
  }
}
/** Desenfoque de caja separable (4 planos); radio saneado: entero, ≥ 0 y acotado al tamaño. */
function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.min(Math.max(width, height), Math.max(0, Math.floor(Number.isFinite(radius) ? radius : 0)));
  if (r === 0 || width <= 0 || height <= 0) return src.slice();
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  blurRows(src, tmp, width, height, r);
  blurColumns(tmp, out, width, height, r);
  return out;
}
interface PreviewLayers {
  /** Base fina (RGB normalizado): imagen − fine = detalle fino. */
  fine: Float32Array;
  /** Base gruesa (RGB normalizado): fine − coarse = líneas más anchas. */
  coarse: Float32Array;
  /** Fracción de vecindad gruesa dentro de la máscara (0–1) para suavizar en los bordes. */
  support: Float32Array;
}
/** Escalas relativas al lado menor; independientes de los controles para poder reutilizarse. */
const FINE_SCALE = 0.004, COARSE_SCALE = 0.012;
/** Umbrales de luminancia (0–255) a partir de los que un detalle se trata como borde/rasgo. */
const FINE_EDGE: readonly [number, number] = [28, 72], COARSE_EDGE: readonly [number, number] = [36, 96];
const CACHE_MAX_PIXELS = 4_194_304;
const layerCache = new WeakMap<Uint8ClampedArray, { width: number; height: number; signature: number; layers: PreviewLayers }>();

/** Convolución normalizada por máscara: los píxeles fuera (ojos, labios, fondo) no se promedian hacia la piel. */
function buildLayers(rgba: Uint8ClampedArray, mask: ArrayLike<number>, width: number, height: number): PreviewLayers {
  const n = width * height, planes = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) if (mask[i]) {
    planes[i * 4] = rgba[i * 4]; planes[i * 4 + 1] = rgba[i * 4 + 1]; planes[i * 4 + 2] = rgba[i * 4 + 2]; planes[i * 4 + 3] = 1;
  }
  const unit = Math.min(width, height);
  const fineRadius = Math.max(1, Math.round(unit * FINE_SCALE));
  const coarseRadius = Math.max(fineRadius + 1, Math.round(unit * COARSE_SCALE));
  const level1 = boxBlur(planes, width, height, fineRadius);
  const level2 = boxBlur(level1, width, height, coarseRadius);
  const fine = new Float32Array(n * 3), coarse = new Float32Array(n * 3), support = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w1 = level1[i * 4 + 3], w2 = level2[i * 4 + 3];
    support[i] = w2;
    for (let c = 0; c < 3; c++) {
      fine[i * 3 + c] = w1 > 0 ? level1[i * 4 + c] / w1 : rgba[i * 4 + c];
      coarse[i * 3 + c] = w2 > 0 ? level2[i * 4 + c] / w2 : fine[i * 3 + c];
    }
  }
  return { fine, coarse, support };
}
/** Huella FNV-1a de RGB + máscara: invalida la caché si el mismo buffer fue mutado. */
function fingerprint(rgba: Uint8ClampedArray, mask: ArrayLike<number>, n: number): number {
  let hash = (0x811c9dc5 ^ n) >>> 0;
  for (let i = 0; i < n; i++) {
    hash = Math.imul(hash ^ rgba[i * 4], 0x01000193);
    hash = Math.imul(hash ^ rgba[i * 4 + 1], 0x01000193);
    hash = Math.imul(hash ^ rgba[i * 4 + 2], 0x01000193);
    hash = Math.imul(hash ^ (mask[i] ? 1 : 0), 0x01000193);
  }
  return hash >>> 0;
}
/** Reutiliza las bases cuando solo cambian los controles; memoria ligada a la vida del buffer. */
function layersFor(rgba: Uint8ClampedArray, mask: ArrayLike<number>, width: number, height: number): PreviewLayers {
  const n = width * height;
  if (n > CACHE_MAX_PIXELS) return buildLayers(rgba, mask, width, height);
  const signature = fingerprint(rgba, mask, n), cached = layerCache.get(rgba);
  if (cached && cached.width === width && cached.height === height && cached.signature === signature) return cached.layers;
  const layers = buildLayers(rgba, mask, width, height);
  layerCache.set(rgba, { width, height, signature, layers });
  return layers;
}

type InfluenceFields = Partial<Record<SimMode, Float32Array>>;
/**
 * Peso máximo por categoría en píxeles de máscara. Las gaussianas se evalúan en una rejilla
 * de paso ≤ r/4 (suaves a esa escala) y se interpolan bilinealmente: coste ~1/paso² por slider.
 */
function influenceFields(
  list: ReturnType<typeof active>, width: number, height: number, mask: ArrayLike<number>,
): InfluenceFields | null {
  const minRadius = list.reduce((min, p) => Math.min(min, p.radius), Infinity);
  const step = clamp(Math.floor((minRadius * height) / 4), 1, 8);
  const gw = Math.ceil((width - 1) / step) + 1, gh = Math.ceil((height - 1) / step) + 1;
  const grids: InfluenceFields = {}, aspect = width / height;
  const bounds: Partial<Record<SimMode, [number, number, number, number]>> = {};
  for (const p of list) {
    const grid = grids[p.mode] ??= new Float32Array(gw * gh);
    const reach = REACH * p.radius;
    const gy0 = Math.max(0, Math.ceil(((p.y - reach) * height) / step)), gy1 = Math.min(gh - 1, Math.floor(((p.y + reach) * height) / step));
    const gx0 = Math.max(0, Math.ceil((p.x * width - reach * height) / step)), gx1 = Math.min(gw - 1, Math.floor((p.x * width + reach * height) / step));
    if (gx0 > gx1 || gy0 > gy1) continue;
    const box = bounds[p.mode] ??= [gx0, gy0, gx1, gy1];
    box[0] = Math.min(box[0], gx0); box[1] = Math.min(box[1], gy0); box[2] = Math.max(box[2], gx1); box[3] = Math.max(box[3], gy1);
    // Gaussiana separable: exp(-(dx²+dy²)/k) = exp(-dx²/k)·exp(-dy²/k); evita una exp por punto.
    const row = new Float32Array(gx1 - gx0 + 1);
    for (let gx = gx0; gx <= gx1; gx++) { const dx = ((gx * step) / width - p.x) * aspect; row[gx - gx0] = falloff(dx * dx, p.radius); }
    for (let gy = gy0; gy <= gy1; gy++) {
      const dy = (gy * step) / height - p.y, wy = falloff(dy * dy, p.radius) * p.gain;
      for (let gx = gx0, g = gy * gw + gx0; gx <= gx1; gx++, g++) {
        const w = row[gx - gx0] * wy;
        if (w > grid[g]) grid[g] = w;
      }
    }
  }
  const fields: InfluenceFields = {};
  let touched = false;
  for (const mode of Object.keys(bounds) as SimMode[]) {
    const grid = grids[mode]!, field = fields[mode] = new Float32Array(width * height);
    // Solo la caja de píxeles cuyas celdas vecinas pueden tener peso.
    const [bx0, by0, bx1, by1] = bounds[mode]!;
    const xa = Math.max(0, (bx0 - 1) * step + 1), xb = Math.min(width - 1, (bx1 + 1) * step - 1);
    const ya = Math.max(0, (by0 - 1) * step + 1), yb = Math.min(height - 1, (by1 + 1) * step - 1);
    for (let y = ya; y <= yb; y++) {
      const gy = Math.min(gh - 2, Math.floor(y / step)), ty = gh > 1 ? y / step - gy : 0;
      for (let x = xa, i = y * width + xa; x <= xb; x++, i++) {
        if (!mask[i]) continue;
        const gx = Math.min(gw - 2, Math.floor(x / step)), tx = gw > 1 ? x / step - gx : 0;
        const g = Math.max(0, gy) * gw + Math.max(0, gx), right = gw > 1 ? 1 : 0, down = gh > 1 ? gw : 0;
        const top = grid[g] + (grid[g + right] - grid[g]) * tx;
        const bottom = grid[g + down] + (grid[g + down + right] - grid[g + down]) * tx;
        const w = top + (bottom - top) * ty;
        if (w > 0) { field[i] = w; touched = true; }
      }
    }
  }
  return touched ? fields : null;
}
/**
 * Filtros RGB locales por inyectable; conserva alpha, no toca píxeles fuera de la máscara
 * y no genera detalles nuevos. Descomposición multiescala con protección de bordes:
 * toxina atenúa detalle fino y líneas más anchas, bioestimulador unifica textura/tono,
 * hidratación aporta luminosidad y relleno un brillo de relieve.
 */
export function previewPixels(
  rgba: Uint8ClampedArray, width: number, height: number,
  samples: readonly PreviewSample[], settings: PreviewSettings, mask: Uint8Array,
) {
  const next = rgba.slice();
  if (!strength(settings) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return next;
  const n = width * height;
  if (rgba.length < n * 4) return next;
  const list = active(samples, settings);
  if (!list.length) return next;
  const fields = influenceFields(list, width, height, mask);
  if (!fields) return next;
  const { fine, coarse, support } = layersFor(rgba, mask, width, height);
  const { toxina, relleno_ha: relleno, hidratacion, bioestimulador } = fields;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const wT = toxina?.[i] ?? 0, wR = relleno?.[i] ?? 0, wH = hidratacion?.[i] ?? 0, wB = bioestimulador?.[i] ?? 0;
    if (wT + wR + wH + wB <= 0) continue;
    const at = i * 4, rgb = i * 3;
    const border = smoothstep(0.2, 0.75, support[i]);
    const original = luma(rgba[at], rgba[at + 1], rgba[at + 2]);
    const base1 = luma(fine[rgb], fine[rgb + 1], fine[rgb + 2]);
    const base2 = luma(coarse[rgb], coarse[rgb + 1], coarse[rgb + 2]);
    const tF = wT > 0 ? saturate(0.92, 0.35, wT) : 0, tC = wT > 0 ? saturate(0.7, 0.45, wT) : 0;
    const bF = wB > 0 ? saturate(0.62, 0.5, wB) : 0, bC = wB > 0 ? saturate(0.32, 0.6, wB) : 0;
    const hF = wH > 0 ? saturate(0.72, 0.4, wH) : 0, hC = wH > 0 ? saturate(0.28, 0.6, wH) : 0;
    const fineAmount = 1 - (1 - tF) * (1 - bF) * (1 - hF), coarseAmount = 1 - (1 - tC) * (1 - bC) * (1 - hC);
    const keepFine = 1 - fineAmount * (1 - smoothstep(FINE_EDGE[0], FINE_EDGE[1], Math.abs(original - base1))) * border;
    const keepCoarse = 1 - coarseAmount * (1 - smoothstep(COARSE_EDGE[0], COARSE_EDGE[1], Math.abs(base1 - base2))) * border;
    const glow = (wH * 12 + wB * 5 + wR * 6) * border;
    for (let c = 0; c < 3; c++) {
      const value = rgba[at + c], f = fine[rgb + c], g = coarse[rgb + c];
      next[at + c] = g + (f - g) * keepCoarse + (value - f) * keepFine + glow;
    }
  }
  return next;
}