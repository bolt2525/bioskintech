// Toda firma nueva se guarda en este lienzo fijo: el documento la muestra siempre con el mismo tamaño y posición.
export const SIGNATURE_BOX = { width: 600, height: 240 } as const;
/** Pluma para signature_pad: el grosor mínimo evita que los trazos rápidos salgan tenues. */
export const SIGNATURE_PEN = { penColor: '#0b1b3f', minWidth: 1.6, maxWidth: 3.6, velocityFilterWeight: 0.7, throttle: 8 } as const;
const INK = [11, 27, 63];
/** Alto de impresión de toda firma normalizada (el ancho sale de la proporción 5:2). */
export const NORMALIZED_SIGNATURE_HEIGHT_PX = 96;
const MARGIN_X = 16, MARGIN_TOP = 16, MARGIN_BOTTOM = 24, MAX_UPSCALE = 3;

/**
 * Normaliza la firma: toma solo el trazo real (ignora el espacio en blanco), la escala para ocupar el
 * lienzo fijo, la centra y la apoya sobre la línea inferior, con fondo transparente.
 * trim-canvas no sirve aquí porque el lienzo de captura usa fondo blanco opaco.
 */
export function normalizeSignature(source: HTMLCanvasElement): string {
  const { width, height } = source;
  const pixels = source.getContext('2d')!.getImageData(0, 0, width, height).data;
  const isInk = (i: number) => pixels[i + 3] > 16 && !(pixels[i] > 235 && pixels[i + 1] > 235 && pixels[i + 2] > 235);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isInk((y * width + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const out = document.createElement('canvas');
  out.width = SIGNATURE_BOX.width;
  out.height = SIGNATURE_BOX.height;
  const ctx = out.getContext('2d')!;
  if (x1 < 0) return out.toDataURL('image/png');
  const cropW = x1 - x0 + 1, cropH = y1 - y0 + 1;
  const scale = Math.min((SIGNATURE_BOX.width - 2 * MARGIN_X) / cropW,
    (SIGNATURE_BOX.height - MARGIN_TOP - MARGIN_BOTTOM) / cropH, MAX_UPSCALE);
  const drawW = cropW * scale, drawH = cropH * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x0, y0, cropW, cropH,
    (SIGNATURE_BOX.width - drawW) / 2, SIGNATURE_BOX.height - MARGIN_BOTTOM - drawH, drawW, drawH);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  // Tinta uniforme: todo pixel con trazo pasa a color de tinta y su opacidad se refuerza,
  // así un trazo rápido (fino/tenue) o reducido de tamaño queda igual de nítido que uno lento.
  const alpha = new Uint8ClampedArray(d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    const darkness = 255 - Math.min(d[i], d[i + 1], d[i + 2]);
    alpha[i / 4] = d[i + 3] && darkness > 20 ? Math.min(255, darkness * 3) : 0;
  }
  // Si la firma se redujo mucho, engrosa 1 px para que los trazos no se pierdan al imprimir.
  const thicken = scale < 0.6;
  const w = out.width, h = out.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = alpha[y * w + x];
      if (thicken && a < 255) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) a = Math.max(a, alpha[ny * w + nx]);
        }
      }
      const i = (y * w + x) * 4;
      d[i] = INK[0]; d[i + 1] = INK[1]; d[i + 2] = INK[2]; d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out.toDataURL('image/png');
}

/** Normaliza una firma ya guardada (p. ej. la firma reutilizable del profesional). */
export async function normalizeSignatureDataUrl(dataUrl: string): Promise<string> {
  if (isNormalizedSignature(dataUrl)) return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { return dataUrl; }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return normalizeSignature(canvas);
}

/** true si la firma ya viene en el lienzo normalizado (lee el ancho/alto del encabezado PNG sin decodificarla). */
export function isNormalizedSignature(dataUrl?: string | null): boolean {
  if (!dataUrl?.startsWith('data:image/png;base64,')) return false;
  try {
    const head = atob(dataUrl.slice(22, 22 + 32));
    const dim = (o: number) => ((head.charCodeAt(o) << 24) | (head.charCodeAt(o + 1) << 16) | (head.charCodeAt(o + 2) << 8) | head.charCodeAt(o + 3)) >>> 0;
    return dim(16) === SIGNATURE_BOX.width && dim(20) === SIGNATURE_BOX.height;
  } catch {
    return false;
  }
}
