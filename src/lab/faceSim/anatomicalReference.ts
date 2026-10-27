/** Referencia genérica, NO anatomía individual. No infiere estructuras del paciente. */
export interface AnatomicalReference {
  /** Imagen completa, sin recortes ni eliminación de marcas. Propiedad del panel. */
  canvas: HTMLCanvasElement;
  /** Un par por vértice, mismo orden que surfaceUVs; origen arriba-izquierda, sin flipY. */
  uvs: Float32Array;
  /** Desplazamiento hacia dentro como fracción del ancho facial; NO milímetros. */
  depth: number;
  opacity: number;
  kind: 'muscle' | 'vessels' | 'bone';
}

export interface ReferencePoint { x: number; y: number }
export type ReferenceAnchors = readonly [ReferencePoint, ReferencePoint, ReferencePoint];
/** x' = a*x + b*y + c; y' = d*x + e*y + f. */
export type AffineTransform = readonly [number, number, number, number, number, number];

/** Comisuras externas de ambos ojos y centro del mentón, sin detectar la ilustración. */
export const ANATOMICAL_ANCHOR_INDICES = [33, 263, 152] as const;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function assertTriangle(points: ReferenceAnchors) {
  if (points.length !== 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new Error('Los tres anclajes deben tener coordenadas finitas.');
  }
  const [a, b, c] = points;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const span = Math.max(
    (b.x - a.x) ** 2 + (b.y - a.y) ** 2,
    (c.x - a.x) ** 2 + (c.y - a.y) ** 2,
    (c.x - b.x) ** 2 + (c.y - b.y) ** 2,
  );
  if (span < 1e-10 || Math.abs(cross) <= span * 1e-5) {
    throw new Error('Anclajes degenerados: separa los dos ojos y sitúa el mentón fuera de su línea.');
  }
}

/** Ajuste afín exacto foto del paciente → imagen de referencia, no transformación inversa. */
export function fitAffineTransform(source: ReferenceAnchors, target: ReferenceAnchors): AffineTransform {
  assertTriangle(source);
  assertTriangle(target);
  const [p, q, r] = source;
  const ux = q.x - p.x, uy = q.y - p.y, vx = r.x - p.x, vy = r.y - p.y;
  const det = ux * vy - uy * vx;
  const row = (axis: 'x' | 'y'): [number, number, number] => {
    const u = target[1][axis] - target[0][axis], v = target[2][axis] - target[0][axis];
    const a = (u * vy - v * uy) / det, b = (ux * v - vx * u) / det;
    return [a, b, target[0][axis] - a * p.x - b * p.y];
  };
  const transform: AffineTransform = [...row('x'), ...row('y')];
  if (!transform.every(Number.isFinite)) throw new Error('El ajuste afín no es finito. Revisa los anclajes.');
  return transform;
}

export function applyAffineTransform(t: AffineTransform, p: ReferencePoint): ReferencePoint {
  return { x: t[0] * p.x + t[1] * p.y + t[2], y: t[3] * p.x + t[4] * p.y + t[5] };
}

/** Los UV fuera de [0,1] se conservan: el consumidor debe mostrarlos transparentes, no repetir bordes. */
export function fitAnatomicalUVs(surfaceUVs: Float32Array, anchors: ReferenceAnchors): Float32Array {
  if (surfaceUVs.length < (263 + 1) * 2 || surfaceUVs.length % 2 !== 0 ||
      !surfaceUVs.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error('UV de paciente inválidos: usa pares normalizados y el orden original de landmarks (mínimo 264).');
  }
  if (anchors.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) {
    throw new Error('Coloca los tres anclajes dentro de la imagen de referencia.');
  }
  const at = (i: number): ReferencePoint => ({
    x: surfaceUVs[i * 2], y: surfaceUVs[i * 2 + 1],
  });
  const source: ReferenceAnchors = [at(33), at(263), at(152)];
  const transform = fitAffineTransform(source, anchors);
  const uvs = new Float32Array(surfaceUVs.length);
  for (let i = 0; i < uvs.length; i += 2) {
    const p = applyAffineTransform(transform, { x: surfaceUVs[i], y: surfaceUVs[i + 1] });
    uvs[i] = p.x;
    uvs[i + 1] = p.y;
  }
  if (!uvs.every(Number.isFinite)) throw new Error('El ajuste produce UV no finitos. Revisa los anclajes.');
  return uvs;
}

export function validateAnatomicalFile(file: Pick<File, 'size' | 'type'>): void {
  if (!MIME_TYPES.has(file.type)) throw new Error('Formato no admitido. Selecciona una imagen JPEG, PNG o WebP (no SVG).');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_REFERENCE_BYTES) {
    throw new Error('La imagen debe ocupar entre 1 byte y 10 MB.');
  }
}

/** Solo memoria y URL blob local. Revoca la URL incluso al fallar, sustituir o cancelar. */
export async function loadAnatomicalImage(file: File, signal: AbortSignal): Promise<HTMLCanvasElement> {
  validateAnatomicalFile(file);
  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const image = new Image();
  let canvas: HTMLCanvasElement | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(new DOMException('Carga cancelada.', 'AbortError'));
      };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error('No se pudo decodificar la imagen. Prueba otro archivo JPEG, PNG o WebP.')); };
      signal.addEventListener('abort', abort, { once: true });
      image.src = url;
    });
    signal.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width < 2 || height < 2 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
      throw new Error('Dimensiones no admitidas: mínimo 2 × 2, máximo 8192 por lado y 16 megapíxeles. Usa una imagen menor sin ocultar marcas.');
    }
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No se pudo crear el lienzo local. Prueba en otro navegador.');
    context.drawImage(image, 0, 0);
    return canvas;
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = '';
    URL.revokeObjectURL(url);
  }
}
