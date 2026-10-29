import type { SimMode } from './engine';

/** Contrato visual local: deliberadamente no acepta dosis, productos ni zonas clínicas. */
export interface PreviewSettings {
  after: boolean;
  intensity: number;
  enabled: Record<SimMode, boolean>;
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
};
export const PREVIEW_DESCRIPTIONS: Record<SimMode, string> = {
  toxina: 'Atenuación cosmética del contraste local. No inventa líneas ni simula relajación muscular.',
  relleno_ha: 'Variación ilustrativa del relieve local; no representa volumen inyectado.',
  hidratacion: 'Variación ilustrativa de luminosidad; no mide hidratación.',
  bioestimulador: 'Variación ilustrativa de tono y relieve; no simula producción de colágeno.',
};
const strength = (settings: PreviewSettings) => settings.after && Number.isFinite(settings.intensity)
  ? Math.max(0, Math.min(1, settings.intensity)) : 0;
const active = (samples: readonly PreviewSample[], settings: PreviewSettings) =>
  samples.filter(p => settings.enabled[p.mode] && Number.isFinite(p.x) && Number.isFinite(p.y));

/** Uniformes compatibles con el shader local, sin invocar el motor antiguo dosis→efecto. */
export function buildIllustrativeEffects(samples: readonly PreviewSample[], settings: PreviewSettings, aspect: number, limit = 64) {
  const list = strength(settings) ? active(samples, settings).slice(0, limit) : [];
  const a = new Float32Array(limit * 4), b = new Float32Array(limit * 4), c = new Float32Array(limit * 4);
  list.forEach((p, i) => {
    a.set([p.x, p.y, 0.075 * Math.min(1, aspect), strength(settings)], i * 4);
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
  const next = positions.slice(), colors = rgb?.slice(), gain = strength(settings);
  if (!gain) return { positions: next, rgb: colors };
  const list = active(samples, settings);
  for (let i = 0; i < Math.min(observedVertexCount, positions.length / 3); i++) {
    let relief = 0, glow = 0, soften = 0;
    for (const p of list) {
      const d = Math.hypot((uvs[i * 2] - p.x) * aspect, uvs[i * 2 + 1] - p.y);
      const w = Math.exp(-d * d / 0.0028) * gain;
      relief = Math.max(relief, w * (p.mode === 'relleno_ha' ? 0.018 : p.mode === 'bioestimulador' ? 0.006 : 0));
      glow = Math.max(glow, w * (p.mode === 'hidratacion' ? 0.045 : p.mode === 'bioestimulador' ? 0.018 : 0));
      soften = Math.max(soften, p.mode === 'toxina' ? w * 0.1 : 0);
    }
    next[i * 3 + 2] += relief;
    if (colors) for (let channel = 0; channel < 3; channel++) {
      const at = i * 3 + channel;
      colors[at] = Math.max(0, Math.min(1, (colors[at] - 0.5) * (1 - soften) + 0.5 + glow));
    }
  }
  return { positions: next, rgb: colors };
}

/** RGB local para textura; conserva alpha y no genera detalles nuevos. */
export function previewPixels(
  rgba: Uint8ClampedArray, width: number, height: number,
  samples: readonly PreviewSample[], settings: PreviewSettings, mask: Uint8Array,
) {
  const next = rgba.slice(), gain = strength(settings);
  if (!gain) return next;
  const list = active(samples, settings), aspect = width / height;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    let glow = 0, soften = 0;
    for (const p of list) {
      const d = Math.hypot(((i % width) / width - p.x) * aspect, Math.floor(i / width) / height - p.y);
      const w = Math.exp(-d * d / 0.0028) * gain;
      glow = Math.max(glow, w * (p.mode === 'hidratacion' ? 12 : p.mode === 'bioestimulador' ? 5 : 0));
      soften = Math.max(soften, p.mode === 'toxina' ? w * 0.1 : 0);
    }
    for (let c = 0; c < 3; c++) next[i * 4 + c] = (rgba[i * 4 + c] - 128) * (1 - soften) + 128 + glow;
  }
  return next;
}
