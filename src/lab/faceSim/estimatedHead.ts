import type { PersonalSurface } from './engine';

/** Copia local del contorno MediaPipe mesh468; no incluye iris. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;

export interface EstimatedHeadSurface extends PersonalSurface {
  /** Número de ÍNDICES (no triángulos) originales. Grupo observado: [0, observedIndexCount).
   * Grupo estimado sin textura: [observedIndexCount, indices.length).
   * Incluye las tapas de ojos/boca, aunque reutilicen vértices con UV fotográficas.
   */
  observedIndexCount: number;
}

type Point = { x: number; y: number; z: number };
type Edge = { a: number; b: number; count: number };
function fail(reason: string): never {
  throw new Error(`Cabeza estimada: ${reason}`);
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function boundaryLoops(indices: ArrayLike<number>, vertexCount: number): number[][] {
  const edges = new Map<string, Edge>();
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [indices[i], indices[i + 1], indices[i + 2]];
    if (triangle.some(v => !Number.isInteger(v) || v < 0 || v >= vertexCount) || new Set(triangle).size !== 3) {
      fail('índices inválidos.');
    }
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3], key = edgeKey(a, b), edge = edges.get(key);
      if (!edge) edges.set(key, { a, b, count: 1 });
      else {
        if (edge.count !== 1 || edge.a !== b || edge.b !== a) fail('malla no manifold u orientación inconsistente.');
        edge.count++;
      }
    }
  }
  const next = new Map<number, number>(), incoming = new Set<number>();
  for (const { a, b, count } of edges.values()) {
    if (count !== 1) continue;
    if (next.has(a) || incoming.has(b)) fail('frontera ramificada.');
    next.set(a, b);
    incoming.add(b);
  }
  const loops: number[][] = [];
  while (next.size) {
    const start = next.keys().next().value!;
    const loop: number[] = [];
    let current = start;
    do {
      loop.push(current);
      const following = next.get(current);
      if (following === undefined) fail('frontera abierta.');
      next.delete(current);
      current = following;
    } while (current !== start);
    if (loop.length < 3) fail('frontera degenerada.');
    loops.push(loop);
  }
  return loops;
}

function area(loop: number[], points: Point[]): number {
  // Triangulación algebraica respecto al primer punto: estable ante traslaciones.
  return loop.slice(1, -1).reduce((sum, id, i) =>
    sum + cross(points[loop[0]], points[id], points[loop[i + 2]]), 0);
}

function polygonCentroid(loop: number[], points: Point[]): Point {
  const origin = points[loop[0]];
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = points[loop[i]], b = points[loop[(i + 1) % loop.length]];
    const ax = a.x - origin.x, ay = a.y - origin.y;
    const bx = b.x - origin.x, by = b.y - origin.y;
    const wedge = ax * by - ay * bx;
    twiceArea += wedge;
    x += (ax + bx) * wedge;
    y += (ay + by) * wedge;
  }
  return { x: origin.x + x / (3 * twiceArea), y: origin.y + y / (3 * twiceArea), z: 0 };
}

function intersects(a: Point, b: Point, c: Point, d: Point, epsilon: number, distanceEpsilon: number): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  const on = (p: Point, q: Point, r: Point) =>
    r.x >= Math.min(p.x, q.x) - distanceEpsilon && r.x <= Math.max(p.x, q.x) + distanceEpsilon &&
    r.y >= Math.min(p.y, q.y) - distanceEpsilon && r.y <= Math.max(p.y, q.y) + distanceEpsilon;
  return (abC * abD < 0 && cdA * cdB < 0) ||
    (Math.abs(abC) <= epsilon && on(a, b, c)) || (Math.abs(abD) <= epsilon && on(a, b, d)) ||
    (Math.abs(cdA) <= epsilon && on(c, d, a)) || (Math.abs(cdB) <= epsilon && on(c, d, b));
}

function segmentHitsTriangle(p: Point, q: Point, a: Point, b: Point, c: Point, epsilon: number): boolean {
  const sub = (u: Point, v: Point): Point => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const cross3 = (u: Point, v: Point): Point => ({ x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x });
  const dot = (u: Point, v: Point) => u.x * v.x + u.y * v.y + u.z * v.z;
  const d = sub(q, p), ab = sub(b, a), ac = sub(c, a), h = cross3(d, ac), det = dot(ab, h);
  if (Math.abs(det) <= epsilon) return false;
  const s = sub(p, a), u = dot(s, h) / det, r = cross3(s, ab);
  const v = dot(d, r) / det, t = dot(ac, r) / det;
  return u >= 0 && v >= 0 && u + v <= 1 && t >= 0 && t <= 1;
}

/** Ear clipping: no abanico desde un centro que podría quedar fuera de un contorno cóncavo. */
function triangulate(loop: number[], points: Point[], epsilon: number): number[] {
  const remaining = [...loop], output: number[] = [], sign = Math.sign(area(loop, points));
  while (remaining.length > 3) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length];
      const b = remaining[i], c = remaining[(i + 1) % remaining.length];
      if (sign * cross(points[a], points[b], points[c]) <= epsilon) continue;
      const contains = remaining.some(id => id !== a && id !== b && id !== c &&
        sign * cross(points[a], points[b], points[id]) >= -epsilon &&
        sign * cross(points[b], points[c], points[id]) >= -epsilon &&
        sign * cross(points[c], points[a], points[id]) >= -epsilon);
      if (contains) continue;
      output.push(a, b, c);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) fail('no se puede triangular una abertura sin degeneraciones.');
  }
  if (sign * cross(points[remaining[0]], points[remaining[1]], points[remaining[2]]) <= epsilon) {
    fail('tapa degenerada.');
  }
  output.push(...remaining);
  return output;
}

/**
 * Prior PARAMÉTRICO, no reconstrucción anatómica ni evidencia de zonas observadas.
 * Puro: conserva prefijos de positions/uvs/indices y la MISMA projection; no renormaliza.
 * El llamador debe autorizar >=3 fotos y cobertura bilateral: PersonalSurface no las contiene.
 *
 * Exige una superficie orientada, contenida en XY por el FACE_OVAL (tolerancia
 * periférica del 1% para landmarks de la sien) como frontera
 * externa y centro visible desde todo su borde (admite concavidades suaves).
 * Tolera triángulos interiores invertidos/degenerados en XY: MediaPipe puede
 * producirlos aun con una frontera válida. Conserva sus defectos originales;
 * el cierre no certifica que la superficie observada sea un escaneo sin pliegues.
 * Rechaza geometría incompatible en vez de devolver un cierre engañoso.
 * Ojos y boca se sellan con discos triangulados, NO con anatomía ocular/oral.
 * La orientación se hereda de la entrada, incluso si toda la entrada está invertida.
 * El exportador GLB separa los índices observados y los cierres estimados en dos mallas/materiales.
 */
export function buildEstimatedHead(surface: PersonalSurface): EstimatedHeadSurface {
  const { positions, uvs, indices } = surface;
  const count = positions.length / 3;
  if (!Number.isInteger(count) || count < 455 || uvs.length !== count * 2 ||
    indices.length < 3 || indices.length % 3 !== 0 ||
    !positions.every(Number.isFinite) || !uvs.every(Number.isFinite)) fail('datos incompletos o no finitos.');
  const points: Point[] = Array.from({ length: count }, (_, i) =>
    ({ x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] }));
  const loops = boundaryLoops(indices, count);
  const ovalSet = new Set<number>(FACE_OVAL);
  const outer = loops.find(loop => loop.length === FACE_OVAL.length && loop.every(id => ovalSet.has(id)));
  if (!outer) fail('se requiere el borde exterior FACE_OVAL completo y abierto.');
  // No basta con tener los mismos vértices: se exige también la misma conectividad.
  const ovalEdges = new Set(FACE_OVAL.map((id, i) => edgeKey(id, FACE_OVAL[(i + 1) % FACE_OVAL.length])));
  if (outer.some((id, i) => !ovalEdges.has(edgeKey(id, outer[(i + 1) % outer.length])))) {
    fail('conectividad FACE_OVAL inválida.');
  }
  const xs = outer.map(id => points[id].x), ys = outer.map(id => points[id].y);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  const scale = Math.max(width, height), epsilon = scale * scale * 1e-10;
  if (!(width > scale * 1e-5 && height > scale * 1e-5)) fail('óvalo degenerado.');
  const sign = Math.sign(area(outer, points));
  if (!sign) fail('óvalo degenerado.');
  // Una frontera simple y discos interiores disjuntos son necesarios para no cruzar tapas.
  const segments = loops.flatMap((loop, li) => loop.map((a, i) =>
    ({ a, b: loop[(i + 1) % loop.length], li, i, length: loop.length })));
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (const b of segments.slice(i + 1)) {
      if (a.li === b.li && (a.b === b.a || a.a === b.b)) continue;
      if (intersects(points[a.a], points[a.b], points[b.a], points[b.b], epsilon, scale * 1e-10)) {
        fail('fronteras cruzadas o coincidentes.');
      }
    }
  }
  const inside = (p: Point, loop: number[]) => {
    let result = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = points[loop[i]], b = points[loop[j]];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
        result = !result;
      }
    }
    return result;
  };
  const nearOuter = (p: Point) => outer.some((id, i) => {
    const a = points[id], b = points[outer[(i + 1) % outer.length]];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= scale * 0.01;
  });
  // MediaPipe puede situar la sien apenas fuera del óvalo en XY, pero delante
  // del collar en Z. La tolerancia periférica se verifica después en 3D.
  const referenced = new Set(indices);
  for (const id of referenced) {
    if (!ovalSet.has(id) && !inside(points[id], outer) && !nearOuter(points[id])) fail('vértice observado fuera del óvalo exterior.');
  }
  const checkedEdges = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j], b = indices[i + (j + 1) % 3], key = edgeKey(a, b);
      if (checkedEdges.has(key) || ovalEdges.has(key)) continue;
      checkedEdges.add(key);
      for (let k = 0; k < outer.length; k++) {
        const c = outer[k], d = outer[(k + 1) % outer.length];
        if (a === c || a === d || b === c || b === d) continue;
        if (intersects(points[a], points[b], points[c], points[d], epsilon, scale * 1e-10)
          && ![points[a], points[b]].some(p => !inside(p, outer) && nearOuter(p))) {
          fail('arista observada cruza el óvalo exterior.');
        }
      }
    }
  }
  const holes = loops.filter(loop => loop !== outer);
  for (const hole of holes) {
    if (sign * area(hole, points) >= -epsilon || !inside(points[hole[0]], outer) ||
      holes.some(other => other !== hole && inside(points[hole[0]], other))) {
      fail('aberturas interiores incompatibles.');
    }
  }
  // El centroide de área evita que una zona con más landmarks del contorno
  // desplace el casquete posterior por la densidad de muestreo.
  const isVisibleFromBorder = (candidate: Point) => outer.every((id, i) =>
    sign * cross(points[id], points[outer[(i + 1) % outer.length]], candidate) > epsilon);
  // En polígonos cóncavos el centroide de área puede quedar fuera del kernel.
  // Conserva entonces el centro previo solo si sigue siendo visible desde todo el borde.
  const vertexCenter: Point = {
    x: xs.reduce((sum, x) => sum + (x - xs[0]), 0) / outer.length + xs[0],
    y: ys.reduce((sum, y) => sum + (y - ys[0]), 0) / outer.length + ys[0],
    z: 0,
  };
  const center = polygonCentroid(outer, points);
  const radialCenter = isVisibleFromBorder(center) ? center : vertexCenter;
  if (!isVisibleFromBorder(radialCenter)) {
    fail('óvalo demasiado cóncavo para el prior paramétrico sin autointersecciones.');
  }
  const addedIndices: number[] = [];
  for (const hole of holes) addedIndices.push(...triangulate([...hole].reverse(), points, epsilon));

  // Collar fuera de la proyección frontal. Todo el casquete interior queda detrás
  // del mínimo Z OBSERVADO: nunca atraviesa el relieve frontal o sus tapas.
  let minZ = Infinity;
  for (const id of indices) minZ = Math.min(minZ, points[id].z);
  const collarZ = minZ - scale * 0.08, depth = Math.max(width * 0.85, height * 0.55);
  let previous = outer;
  const connect = (next: number[]) => {
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      addedIndices.push(previous[j], previous[i], next[i], previous[j], next[i], next[j]);
    }
    previous = next;
  };
  // ponytail: prior de 12 anillos → sustituir solo con evidencia posterior real.
  for (let ring = 0; ring < 12; ring++) {
    const angle = ring / 12 * Math.PI / 2, radius = Math.cos(angle);
    const next = outer.map(id => {
      const p = points[id], index = points.length;
      points.push({
        x: radialCenter.x + (p.x - radialCenter.x) * radius * 1.04,
        // Envolvente craneal: la bóveda se eleva sobre la frente; no se extruye solo la máscara facial.
        y: radialCenter.y + (p.y - radialCenter.y) * radius * 1.25 + height * (0.125 + 0.20 * Math.sin(angle)),
        z: collarZ - depth * Math.sin(angle),
      });
      return index;
    });
    connect(next);
  }
  // Casquete pequeño, sin polo degenerado ni abanico sobre un contorno cóncavo.
  addedIndices.push(...triangulate([...previous].reverse(), points, epsilon));
  const resultPositions = new Float32Array(points.length * 3);
  resultPositions.set(positions);
  for (let i = count; i < points.length; i++) {
    const p = points[i];
    resultPositions.set([p.x, p.y, p.z], i * 3);
  }
  const resultUvs = new Float32Array(points.length * 2).fill(0.5);
  resultUvs.set(uvs);
  const resultIndices = new Uint32Array(indices.length + addedIndices.length);
  resultIndices.set(indices);
  resultIndices.set(addedIndices, indices.length);
  // Comprobar la geometría REAL Float32, no solo el cálculo intermedio.
  if (!resultPositions.every(Number.isFinite)) fail('desbordamiento de coordenadas.');
  for (let i = indices.length; i < resultIndices.length; i += 3) {
    const [a, b, c] = [resultIndices[i], resultIndices[i + 1], resultIndices[i + 2]].map(id =>
      [resultPositions[id * 3], resultPositions[id * 3 + 1], resultPositions[id * 3 + 2]]);
    const u = b.map((v, j) => v - a[j]), v = c.map((value, j) => value - a[j]);
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) <= epsilon) {
      fail('precisión Float32 insuficiente para cerrar sin degeneraciones.');
    }
  }
  const observedFaces = Array.from({ length: indices.length / 3 }, (_, i) => {
    const ids = Array.from(indices.subarray(i * 3, i * 3 + 3));
    const p = ids.map(id => points[id]);
    return { ids, p, min: { x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)), z: Math.min(...p.map(v => v.z)) },
      max: { x: Math.max(...p.map(v => v.x)), y: Math.max(...p.map(v => v.y)), z: Math.max(...p.map(v => v.z)) } };
  });
  for (let i = indices.length; i < resultIndices.length; i += 3) {
    const ids = Array.from(resultIndices.subarray(i, i + 3)), p = ids.map(id => points[id]);
    const min = { x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)), z: Math.min(...p.map(v => v.z)) };
    const max = { x: Math.max(...p.map(v => v.x)), y: Math.max(...p.map(v => v.y)), z: Math.max(...p.map(v => v.z)) };
    if (max.z < minZ) continue;
    for (const face of observedFaces) {
      if (max.x < face.min.x || min.x > face.max.x || max.y < face.min.y || min.y > face.max.y
        || max.z < face.min.z || min.z > face.max.z || ids.some(id => face.ids.includes(id))) continue;
      if (p.some((a, j) => segmentHitsTriangle(a, p[(j + 1) % 3], face.p[0], face.p[1], face.p[2], scale ** 3 * 1e-10))
        || face.p.some((a, j) => segmentHitsTriangle(a, face.p[(j + 1) % 3], p[0], p[1], p[2], scale ** 3 * 1e-10))) {
        fail('el cierre estimado intersecta la superficie observada. Revisa el contorno.');
      }
    }
  }
  if (boundaryLoops(resultIndices, points.length).length) fail('no se logró cerrar todas las fronteras.');
  return { positions: resultPositions, uvs: resultUvs, indices: resultIndices,
    projection: surface.projection, observedIndexCount: indices.length };
}
