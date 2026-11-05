import { analyzeSkinAppearance, skinVisualCandidates, type SkinVisualCandidate } from './skinAppearance.ts';

export interface SkinScanWindow { x: number; y: number; width: number; height: number }
export interface SkinScanSummary {
  windows: number;
  coverage: number;
  truncated: boolean;
}
interface Pixels { width: number; height: number; data: Uint8ClampedArray }

function validateArea(width: number, height: number, mask: Uint8Array) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 1400 || height > 1400 || !(mask instanceof Uint8Array) || mask.length !== width * height) {
    throw new RangeError('La exploración necesita una imagen y un área de piel válidas de hasta 1400 px.');
  }
}

/** Recorre piel autorizada aunque no haya candidatos RGB. Nunca amplía la fotografía. */
export function planSkinScan(width: number, height: number, mask: Uint8Array): SkinScanWindow[] {
  validateArea(width, height, mask);
  const starts = (size: number) => {
    const positions = [0];
    while (positions[positions.length - 1] + 512 < size) {
      positions.push(Math.min(size - 512, positions[positions.length - 1] + 384));
    }
    return positions;
  };
  const windows: SkinScanWindow[] = [];
  for (const y of starts(height)) for (const x of starts(width)) {
    const w = Math.min(512, width), h = Math.min(512, height);
    let pixels = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      if (mask[row * width + col]) pixels++;
    }
    if (pixels >= 64) windows.push({ x, y, width: w, height: h });
  }
  if (!windows.length) throw new Error('No hay un área de piel con al menos 64 píxeles para explorar.');
  return windows;
}

/** Invierte el recorte; las cajas siguen referidas a la foto completa, no al visor ni a la máscara. */
export function remapSkinScanCandidate(
  candidate: SkinVisualCandidate, window: SkinScanWindow, width: number, height: number,
): SkinVisualCandidate {
  if (![width, height, window.x, window.y, window.width, window.height].every(Number.isSafeInteger)
    || width < 1 || height < 1 || width > 1400 || height > 1400
    || window.x < 0 || window.y < 0 || window.width < 1 || window.height < 1
    || window.x + window.width > width || window.y + window.height > height
    || ![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
    || candidate.x < 0 || candidate.y < 0 || candidate.width <= 0 || candidate.height <= 0
    || candidate.x + candidate.width > 1 + 1e-8 || candidate.y + candidate.height > 1 + 1e-8) {
    throw new RangeError('Caja o coordenadas del recorte de piel inválidas.');
  }
  return {
    ...candidate, id: `scan:${width}x${height}:${window.x},${window.y}:${window.width}x${window.height}:${candidate.id}`,
    x: (window.x + candidate.x * window.width) / width,
    y: (window.y + candidate.y * window.height) / height,
    width: candidate.width * window.width / width,
    height: candidate.height * window.height / height,
  };
}

/** Alterna sectores antes de limitar; no favorece únicamente la parte superior de la foto. */
export function mergeSkinScanCandidates(passes: readonly (readonly SkinVisualCandidate[])[]) {
  const candidates: SkinVisualCandidate[] = [];
  for (let index = 0; index < Math.max(0, ...passes.map(pass => pass.length)); index++) {
    for (const pass of passes) {
      const next = pass[index];
      if (!next) continue;
      const duplicate = candidates.some(previous => {
        if (previous.channel !== next.channel) return false;
        const intersection = Math.max(0, Math.min(previous.x + previous.width, next.x + next.width) - Math.max(previous.x, next.x))
          * Math.max(0, Math.min(previous.y + previous.height, next.y + next.height) - Math.max(previous.y, next.y));
        return intersection / Math.min(previous.width * previous.height, next.width * next.height) >= .65;
      });
      if (!duplicate) candidates.push(next);
    }
  }
  return { candidates: candidates.slice(0, 112), truncated: candidates.length > 112 };
}

export async function scanSkinRegions(
  image: Pixels, mask: Uint8Array, baseline: readonly SkinVisualCandidate[],
  options: { sensitivity: number; cancelled: () => boolean; onProgress: (completed: number, total: number) => void },
): Promise<{ candidates: SkinVisualCandidate[]; scan: SkinScanSummary }> {
  const { width, height, data } = image;
  const windows = planSkinScan(width, height, mask);
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('Los píxeles de la exploración no coinciden con la fotografía.');
  }
  if (!Number.isFinite(options.sensitivity) || options.sensitivity < 0 || options.sensitivity > 1) {
    throw new RangeError('Sensibilidad de exploración inválida.');
  }
  const passes: SkinVisualCandidate[][] = [], covered = new Uint8Array(mask.length);
  const checkCancelled = () => {
    if (options.cancelled()) throw new DOMException('Exploración cancelada.', 'AbortError');
  };
  for (const [index, window] of windows.entries()) {
    await new Promise(resolve => setTimeout(resolve, 0));
    checkCancelled();
    const rgba = new Uint8ClampedArray(window.width * window.height * 4), cropMask = new Uint8Array(window.width * window.height);
    for (let y = 0; y < window.height; y++) {
      const offset = (window.y + y) * width + window.x;
      rgba.set(data.subarray(offset * 4, (offset + window.width) * 4), y * window.width * 4);
      cropMask.set(mask.subarray(offset, offset + window.width), y * window.width);
    }
    const analysis = analyzeSkinAppearance({ width: window.width, height: window.height, data: rgba }, cropMask,
      { sensitivity: options.sensitivity });
    if (analysis.usable) {
      const local = skinVisualCandidates(analysis, cropMask, window.width, window.height, true);
      passes.push(local.map(candidate => remapSkinScanCandidate(candidate, window, width, height)));
      for (let y = 0; y < window.height; y++) for (let x = 0; x < window.width; x++) {
        if (cropMask[y * window.width + x]) covered[(window.y + y) * width + window.x + x] = 1;
      }
    }
    checkCancelled();
    options.onProgress(index + 1, windows.length);
  }
  checkCancelled();
  const eligible = mask.reduce((sum, pixel) => sum + Number(!!pixel), 0);
  const coverage = covered.reduce((sum, pixel) => sum + pixel, 0) / eligible;
  if (!coverage) throw new Error('Ninguna zona tiene calidad suficiente para explorar. Se conserva la revisión anterior.');
  const merged = mergeSkinScanCandidates([...passes, baseline]);
  return { candidates: merged.candidates, scan: { windows: windows.length, coverage, truncated: merged.truncated } };
}
