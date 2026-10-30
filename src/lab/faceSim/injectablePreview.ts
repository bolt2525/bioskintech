import type { SimMode } from './engine';

/** Contrato visual local: deliberadamente no acepta dosis, productos ni zonas clínicas. */
export interface PreviewSettings {
  after: boolean;
  /** Intensidad global (0–1). */
  intensity: number;
  enabled: Record<SimMode, boolean>;
  /** Variador por inyectable (0–1.5, 1 = neutro). Opcional para compatibilidad. */
  levels?: Partial<Record<SimMode, number>>;
}
export interface PreviewSample {
  mode: SimMode;
  x: number;
  y: number;
}
export const DEFAULT_PREVIEW: PreviewSettings = {
  after: true,
  intensity: 0.6,
  enabled: { toxina: true, relleno_ha: true, hidratacion: true, bioestimulador: true },
  levels: { toxina: 1, relleno_ha: 1, hidratacion: 1, bioestimulador: 1 },
};
export const PREVIEW_DESCRIPTIONS: Record<SimMode, string> = {
  toxina: 'Filtro que atenúa el detalle fino (líneas) existente. No inventa líneas ni simula relajación muscular.',
  relleno_ha: 'Variación ilustrativa del relieve y brillo local; no representa volumen inyectado.',
  hidratacion: 'Variación ilustrativa de luminosidad; no mide hidratación.',
  bioestimulador: 'Unifica textura y tono locales de forma ilustrativa; no simula producción de colágeno.',
};
/** Qué hace cada variador, en lenguaje de filtro. */
export const PREVIEW_FILTERS: Record<SimMode, string> = {
  toxina: 'Atenuar líneas',
  relleno_ha: 'Relieve y brillo',
  hidratacion: 'Luminosidad',
  bioestimulador: 'Textura y tono',
};
export const MAX_LEVEL = 1.5;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const strength = (settings: PreviewSettings) => settings.after && Number.isFinite(settings.intensity)
  ? clamp(settings.intensity, 0, 1) : 0;
/** Ganancia final por inyectable = global × variador propio. */
export function previewGain(settings: PreviewSettings, mode: SimMode): number {
  const level = settings.levels?.[mode];
  return strength(settings) * (Number.isFinite(level) ? clamp(level!, 0, MAX_LEVEL) : 1);
}
const active = (samples: readonly PreviewSample[], settings: PreviewSettings) =>
  samples.filter(p => settings.enabled[p.mode] && previewGain(settings, p.mode) > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));

/** Uniformes compatibles con el shader local, sin invocar el motor antiguo dosis→efecto. */
export function buildIllustrativeEffects(samples: readonly PreviewSample[], settings: PreviewSettings, aspect: number, limit = 64) {
  const list = strength(settings) ? active(samples, settings).slice(0, limit) : [];
  const a = new Float32Array(limit * 4), b = new Float32Array(limit * 4), c = new Float32Array(limit * 4);
  list.forEach((p, i) => {
    a.set([p.x, p.y, 0.075 * Math.min(1, aspect), Math.min(1, previewGain(settings, p.mode))], i * 4);
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
 */
export function previewSurface(
  positions: Float32Array, uvs: Float32Array, samples: readonly PreviewSample[], settings: PreviewSettings,
  aspect: number, rgb?: Float32Array, observedVertexCount = positions.length / 3,
) {
  const next = positions.slice(), colors = rgb?.slice();
  if (!strength(settings)) return { positions: next, rgb: colors };
  const list = active(samples, settings).map(p => ({ ...p, gain: previewGain(settings, p.mode) }));
  for (let i = 0; i < Math.min(observedVertexCount, positions.length / 3); i++) {
    let relief = 0, glow = 0, soften = 0;
    for (const p of list) {
      const d = Math.hypot((uvs[i * 2] - p.x) * aspect, uvs[i * 2 + 1] - p.y);
      const w = Math.exp(-d * d / 0.0028) * p.gain;
      relief = Math.max(relief, w * (p.mode === 'relleno_ha' ? 0.018 : p.mode === 'bioestimulador' ? 0.006 : 0));
      glow = Math.max(glow, w * (p.mode === 'hidratacion' ? 0.045 : p.mode === 'bioestimulador' ? 0.018 : 0));
      soften = Math.max(soften, p.mode === 'toxina' ? Math.min(0.6, w * 0.25) : 0);
    }
    next[i * 3 + 2] += relief;
    if (colors) for (let channel = 0; channel < 3; channel++) {
      const at = i * 3 + channel;
      colors[at] = clamp((colors[at] - 0.5) * (1 - soften) + 0.5 + glow, 0, 1);
    }
  }
  return { positions: next, rgb: colors };
}

/** Desenfoque de caja separable (RGB); base para separar detalle fino de tono. */
function boxBlur(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(width * height * 3), out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let c = 0; c < 3; c++) {
    let sum = 0, n = 0;
    for (let x = -radius; x < width + radius; x++) {
      const add = x + radius, drop = x - radius - 1;
      if (add < width) { sum += rgba[(y * width + add) * 4 + c]; n++; }
      if (drop >= 0) { sum -= rgba[(y * width + drop) * 4 + c]; n--; }
      if (x >= 0 && x < width) tmp[(y * width + x) * 3 + c] = sum / n;
    }
  }
  for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    let sum = 0, n = 0;
    for (let y = -radius; y < height + radius; y++) {
      const add = y + radius, drop = y - radius - 1;
      if (add < height) { sum += tmp[(add * width + x) * 3 + c]; n++; }
      if (drop >= 0) { sum -= tmp[(drop * width + x) * 3 + c]; n--; }
      if (y >= 0 && y < height) out[(y * width + x) * 3 + c] = sum / n;
    }
  }
  return out;
}

/**
 * Filtros RGB locales por inyectable; conserva alpha y no genera detalles nuevos:
 * toxina atenúa detalle fino, bioestimulador unifica textura/tono,
 * hidratación aporta luminosidad y relleno un brillo de relieve.
 */
export function previewPixels(
  rgba: Uint8ClampedArray, width: number, height: number,
  samples: readonly PreviewSample[], settings: PreviewSettings, mask: Uint8Array,
) {
  const next = rgba.slice();
  if (!strength(settings)) return next;
  const list = active(samples, settings).map(p => ({ ...p, gain: previewGain(settings, p.mode) })), aspect = width / height;
  if (!list.length) return next;
  const smooth = list.some(p => p.mode === 'toxina' || p.mode === 'bioestimulador')
    ? boxBlur(rgba, width, height, Math.max(1, Math.round(Math.min(width, height) * 0.006))) : null;
  const weight: Record<SimMode, number> = { toxina: 0, relleno_ha: 0, hidratacion: 0, bioestimulador: 0 };
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    weight.toxina = weight.relleno_ha = weight.hidratacion = weight.bioestimulador = 0;
    for (const p of list) {
      const d = Math.hypot(((i % width) / width - p.x) * aspect, Math.floor(i / width) / height - p.y);
      weight[p.mode] = Math.max(weight[p.mode], Math.exp(-d * d / 0.0028) * p.gain);
    }
    const lines = Math.min(0.9, weight.toxina * 0.9), texture = Math.min(0.6, weight.bioestimulador * 0.55);
    const glow = weight.hidratacion * 12 + weight.bioestimulador * 5 + weight.relleno_ha * 6;
    const soften = Math.min(0.5, weight.toxina * 0.1);
    for (let c = 0; c < 3; c++) {
      let value = rgba[i * 4 + c];
      if (smooth) {
        const base = smooth[i * 3 + c];
        value = base + (value - base) * (1 - Math.max(lines, texture));
      }
      next[i * 4 + c] = (value - 128) * (1 - soften) + 128 + glow;
    }
  }
  return next;
}