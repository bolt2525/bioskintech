import * as THREE from 'three';
import type { ScalpHairVisualization } from './Clinical3DViewer';
import { getScalpCoverage, getScalpDensity } from '../../../../data/scalpPatterns';

const HEAD_CENTER = new THREE.Vector3(0, 0.58, -0.08);
const SURFACE_OFFSET = 0.003;
type SurfaceVertex = { point: THREE.Vector3; normal: THREE.Vector3 };
type SurfaceCache = {
  snapshot: unknown[];
  points: Float64Array;
  normals: Float64Array;
  positions: Float32Array;
  surfaceNormals: Float32Array;
  boundaryFactors: Float64Array;
  index: Uint32Array;
  candidates: [Float64Array | undefined, Float64Array | undefined];
};
// ponytail: one CPU surface + two sampling families per model → no shared disposable GPU resources.
const surfaces = new WeakMap<THREE.Object3D, SurfaceCache>();

const createBoundaryProfile = (points: NonNullable<ScalpHairVisualization['boundaryPoints']>) =>
  points.map(({ x, y, z }) => ({
    angle: THREE.MathUtils.euclideanModulo(Math.atan2(z - HEAD_CENTER.z, x), Math.PI * 2),
    height: y,
  })).sort((a, b) => a.angle - b.angle);

const getBoundaryHeight = (angle: number, profile: ReturnType<typeof createBoundaryProfile>) => {
  const normalized = THREE.MathUtils.euclideanModulo(angle, Math.PI * 2);
  const nextIndex = profile.findIndex(sample => sample.angle > normalized);
  const end = profile[nextIndex < 0 ? 0 : nextIndex];
  const start = profile[(nextIndex <= 0 ? profile.length : nextIndex) - 1];
  const span = THREE.MathUtils.euclideanModulo(end.angle - start.angle, Math.PI * 2);
  const amount = THREE.MathUtils.euclideanModulo(normalized - start.angle, Math.PI * 2) / (span || 1);
  return THREE.MathUtils.lerp(start.height, end.height, amount);
};

const buildSurface = (
  meshes: THREE.Mesh[], profile: ReturnType<typeof createBoundaryProfile>, snapshot: unknown[],
): SurfaceCache => {
  const points: number[] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  const boundaryFactors: number[] = [];
  const vertexIndices = new Map<SurfaceVertex, number>();
  const boundaryDistance = (point: THREE.Vector3) =>
    point.y - getBoundaryHeight(Math.atan2(point.z - HEAD_CENTER.z, point.x), profile);
  const emitTriangle = (a: SurfaceVertex, b: SurfaceVertex, c: SurfaceVertex) => {
    for (const vertex of [a, b, c]) {
      let vertexIndex = vertexIndices.get(vertex);
      if (vertexIndex === undefined) {
        vertexIndex = points.length / 3;
        vertexIndices.set(vertex, vertexIndex);
        const { point, normal } = vertex;
        points.push(point.x, point.y, point.z);
        const surfacePoint = point.clone().addScaledVector(normal, SURFACE_OFFSET);
        positions.push(surfacePoint.x, surfacePoint.y, surfacePoint.z);
        normals.push(normal.x, normal.y, normal.z);
        boundaryFactors.push(THREE.MathUtils.smoothstep(boundaryDistance(point), 0, 0.055));
      }
      index.push(vertexIndex);
    }
  };
  const midpoint = (a: SurfaceVertex, b: SurfaceVertex): SurfaceVertex => ({
    point: a.point.clone().lerp(b.point, 0.5),
    normal: a.normal.clone().lerp(b.normal, 0.5).normalize(),
  });
  const subdivide = (a: SurfaceVertex, b: SurfaceVertex, c: SurfaceVertex, depth = 0) => {
    const edge = Math.max(a.point.distanceTo(b.point), b.point.distanceTo(c.point), c.point.distanceTo(a.point));
    if (edge <= 0.085 || depth >= 5) {
      emitTriangle(a, b, c);
      return;
    }
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    subdivide(a, ab, ca, depth + 1);
    subdivide(ab, b, bc, depth + 1);
    subdivide(ca, bc, c, depth + 1);
    subdivide(ab, bc, ca, depth + 1);
  };

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const sourcePositions = geometry.getAttribute('position');
    const sourceNormals = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const count = index?.count ?? sourcePositions.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const vertices = [0, 1, 2].map(offset => {
        const vertexIndex = index ? index.getX(i + offset) : i + offset;
        const point = new THREE.Vector3().fromBufferAttribute(sourcePositions, vertexIndex).applyMatrix4(mesh.matrixWorld);
        const normal = new THREE.Vector3().fromBufferAttribute(sourceNormals, vertexIndex).applyMatrix3(normalMatrix).normalize();
        if (normal.dot(point.clone().sub(HEAD_CENTER)) < 0) normal.negate();
        return { point, normal };
      });
      if (vertices.every(vertex => boundaryDistance(vertex.point) < -0.1)) continue;
      const center = vertices[0].point.clone().add(vertices[1].point).add(vertices[2].point).multiplyScalar(1 / 3);
      const faceNormal = vertices[1].point.clone().sub(vertices[0].point)
        .cross(vertices[2].point.clone().sub(vertices[0].point)).normalize();
      if (Math.abs(faceNormal.dot(center.clone().sub(HEAD_CENTER).normalize())) < 0.12) continue;
      subdivide(vertices[0], vertices[1], vertices[2]);
    }
  }
  return {
    snapshot, points: new Float64Array(points), normals: new Float64Array(normals),
    positions: new Float32Array(positions), surfaceNormals: new Float32Array(normals),
    boundaryFactors: new Float64Array(boundaryFactors), index: new Uint32Array(index),
    candidates: [undefined, undefined],
  };
};

const sampleSurface = (
  surface: SurfaceCache, female: boolean, profile: ReturnType<typeof createBoundaryProfile>,
) => {
  const candidates: number[] = [];
  let seed = 74219;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
  const root = new THREE.Vector3(), normal = new THREE.Vector3(), edge = new THREE.Vector3();
  for (let i = 0; i < surface.index.length; i += 3) {
    const ai = surface.index[i] * 3, bi = surface.index[i + 1] * 3, ci = surface.index[i + 2] * 3;
    a.fromArray(surface.points, ai); b.fromArray(surface.points, bi); c.fromArray(surface.points, ci);
    na.fromArray(surface.normals, ai); nb.fromArray(surface.normals, bi); nc.fromArray(surface.normals, ci);
    const area = edge.copy(b).sub(a).cross(root.copy(c).sub(a)).length() * 0.5;
    const amount = area * (female ? 1800 : 2400);
    const count = Math.floor(amount) + (random() < amount % 1 ? 1 : 0);
    for (let j = 0; j < count; j += 1) {
      const u = Math.sqrt(random()), v = random();
      root.copy(a).multiplyScalar(1 - u).addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v);
      normal.copy(na).multiplyScalar(1 - u).addScaledVector(nb, u * (1 - v)).addScaledVector(nc, u * v).normalize();
      // Keep the original random stream, including rejected candidates, in double precision.
      const selection = random(), variation = random(), directionVariation = random();
      const boundaryFactor = THREE.MathUtils.smoothstep(root.y
        - getBoundaryHeight(Math.atan2(root.z - HEAD_CENTER.z, root.x), profile), 0, 0.055);
      // Outside-contour candidates can never pass any stage/density. Still consume
      // their random values (and retain selection === 0) to preserve exact output.
      if (boundaryFactor > 0 || selection === 0) {
        candidates.push(root.x, root.y, root.z, normal.x, normal.y, normal.z,
          selection, variation, directionVariation, boundaryFactor);
      }
    }
  }
  return new Float64Array(candidates);
};

export const createScalpGroomGroup = (
  visualization: ScalpHairVisualization,
  head: THREE.Object3D,
): THREE.Group | null => {
  const boundary = visualization.boundaryClosed ? visualization.boundaryPoints : null;
  if (!boundary || boundary.length < 3) return null;
  const meshes: THREE.Mesh[] = [];
  const snapshot: unknown[] = boundary.flatMap(({ x, y, z }) => [x, y, z]);
  head.updateWorldMatrix(true, true);
  head.traverse(child => {
    if (!(child instanceof THREE.Mesh) || child.name === 'SCALP_HAIR_SOURCE'
      || !child.geometry.getAttribute('position')) return;
    meshes.push(child);
    const geometry = child.geometry;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    snapshot.push(child, geometry, ...child.matrixWorld.elements);
    for (const attribute of [geometry.getAttribute('position'), geometry.getAttribute('normal'), geometry.index]) {
      snapshot.push(attribute, attribute?.array, attribute?.count);
      // Interleaved attributes carry their update version on the backing buffer.
      snapshot.push(attribute && ('data' in attribute ? attribute.data.version : attribute.version));
    }
  });
  if (!meshes.length) return null;
  let surface = surfaces.get(head);
  const surfaceBuilds = !surface || snapshot.length !== surface.snapshot.length
    || snapshot.some((value, i) => value !== surface!.snapshot[i]) ? 1 : 0;
  let profile: ReturnType<typeof createBoundaryProfile> | undefined;
  if (surfaceBuilds) {
    profile = createBoundaryProfile(boundary);
    surface = buildSurface(meshes, profile, snapshot);
    surfaces.set(head, surface);
  }
  if (!surface || !surface.positions.length) return null;
  const density = getScalpDensity(visualization.density);
  // Savin shares feminine styling; clinical coverage always comes from scalpPatterns.
  const female = visualization.scale === 'ludwig' || visualization.scale === 'savin';
  const family = female ? 1 : 0;
  const samplingBuilds = surface.candidates[family] ? 0 : 1;
  const candidates = surface.candidates[family] ?? sampleSurface(surface, female, profile ?? createBoundaryProfile(boundary));
  surface.candidates[family] = candidates;
  const hairColor = new THREE.Color(visualization.color ?? '#2b1a12');
  const length = THREE.MathUtils.clamp(visualization.lengthScale ?? 0.82, 0.55, 1.8);
  const compactness = THREE.MathUtils.clamp(visualization.layDown ?? 0.78, 0.45, 0.96);
  const coverages = new Float32Array(surface.points.length / 3);
  const root = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < coverages.length; i += 1) {
    root.fromArray(surface.points, i * 3);
    coverages[i] = getScalpCoverage(root, visualization) * surface.boundaryFactors[i];
  }
  const selected = new Uint32Array(candidates.length / 10);
  let strandCount = 0, vertexCount = 0, indexCount = 0;
  for (let i = 0; i < candidates.length; i += 10) {
    root.fromArray(candidates, i);
    if (candidates[i + 6] > getScalpCoverage(root, visualization) * candidates[i + 9] * density) continue;
    selected[strandCount++] = i;
    const segments = female && (Math.abs(root.x) > 0.72 || root.z < -0.7) ? 8 : 4;
    vertexCount += (segments + 1) * 2;
    indexCount += segments * 6;
  }
  const strandPositions = new Float32Array(vertexCount * 3);
  const strandNormals = new Float32Array(vertexCount * 3);
  const strandIndex = new Uint32Array(indexCount);
  const flow = new THREE.Vector3(), widthDirection = new THREE.Vector3();
  const point = new THREE.Vector3(), left = new THREE.Vector3(), right = new THREE.Vector3();
  let vertexOffset = 0, indexOffset = 0;
  for (let i = 0; i < strandCount; i += 1) {
    const offset = selected[i];
    root.fromArray(candidates, offset); normal.fromArray(candidates, offset + 3);
    const variation = candidates[offset + 7], directionVariation = candidates[offset + 8];
    const side = root.x < 0 ? -1 : 1;
    if (female) flow.set(side * 0.75, -0.85, -0.22);
    else flow.set(side * 0.22 + (directionVariation - 0.5) * 0.2, -0.35, -1);
    flow.addScaledVector(normal, -flow.dot(normal)).normalize();
    widthDirection.crossVectors(flow, normal).normalize();
    const drape = female && (Math.abs(root.x) > 0.72 || root.z < -0.7);
    const strandLength = length * (drape ? 0.72 + variation * 0.38 : female ? 0.2 : 0.08);
    const width = female ? 0.006 : 0.004;
    const segments = drape ? 8 : 4;
    for (let segment = 0; segment <= segments; segment += 1) {
      const t = segment / segments;
      point.copy(root).addScaledVector(flow, strandLength * t);
      point.addScaledVector(normal, SURFACE_OFFSET + Math.sin(Math.PI * t) * 0.025 * (1 - compactness));
      if (drape) {
        point.x += side * 0.055 * Math.sin(Math.PI * t);
        point.y -= strandLength * t * t * 0.55;
      }
      const halfWidth = width * (1 - t * 0.85);
      left.copy(point).addScaledVector(widthDirection, -halfWidth);
      right.copy(point).addScaledVector(widthDirection, halfWidth);
      left.toArray(strandPositions, vertexOffset * 3);
      right.toArray(strandPositions, (vertexOffset + 1) * 3);
      normal.toArray(strandNormals, vertexOffset * 3);
      normal.toArray(strandNormals, (vertexOffset + 1) * 3);
      if (segment) {
        strandIndex[indexOffset++] = vertexOffset - 2;
        strandIndex[indexOffset++] = vertexOffset - 1;
        strandIndex[indexOffset++] = vertexOffset;
        strandIndex[indexOffset++] = vertexOffset - 1;
        strandIndex[indexOffset++] = vertexOffset + 1;
        strandIndex[indexOffset++] = vertexOffset;
      }
      vertexOffset += 2;
    }
  }
  const hairGeometry = new THREE.BufferGeometry();
  hairGeometry.setAttribute('position', new THREE.BufferAttribute(surface.positions.slice(), 3));
  hairGeometry.setAttribute('normal', new THREE.BufferAttribute(surface.surfaceNormals.slice(), 3));
  hairGeometry.setAttribute('scalpCoverage', new THREE.BufferAttribute(coverages, 1));
  hairGeometry.setIndex(new THREE.BufferAttribute(surface.index.slice(), 1));
  const material = new THREE.MeshPhysicalMaterial({
    color: hairColor, roughness: visualization.roughness ?? 0.58,
    sheen: 0.35, sheenColor: hairColor.clone().offsetHSL(0, -0.1, 0.12),
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.hairDensity = { value: density };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float scalpCoverage;\nvarying float vScalpCoverage;\nvarying vec3 vScalpPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvScalpCoverage = scalpCoverage;\nvScalpPosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float hairDensity;\nvarying float vScalpCoverage;\nvarying vec3 vScalpPosition;')
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        float angle = atan(vScalpPosition.x, vScalpPosition.z + 0.08);
        float strands = 0.5 + 0.5 * sin(angle * 530.0 + vScalpPosition.y * 18.0);
        float localDensity = hairDensity * vScalpCoverage;
        float strandMask = smoothstep(1.0 - localDensity, 1.06 - localDensity, strands);
        diffuseColor.a *= vScalpCoverage * strandMask * mix(0.48, 0.96, hairDensity);
        if (diffuseColor.a < 0.015) discard;`);
  };
  material.customProgramCacheKey = () => 'bioskin-surface-hair-v3';
  const group = new THREE.Group();
  group.name = 'scalp-surface-groom';
  const hair = new THREE.Mesh(hairGeometry, material);
  hair.userData.isScalpVisualization = true;
  group.add(hair);
  if (strandPositions.length) {
    const strandGeometry = new THREE.BufferGeometry();
    strandGeometry.setAttribute('position', new THREE.BufferAttribute(strandPositions, 3));
    strandGeometry.setAttribute('normal', new THREE.BufferAttribute(strandNormals, 3));
    strandGeometry.setIndex(new THREE.BufferAttribute(strandIndex, 1));
    const strands = new THREE.Mesh(strandGeometry, new THREE.MeshPhysicalMaterial({
      color: hairColor, roughness: visualization.roughness ?? 0.58,
      side: THREE.DoubleSide, sheen: 0.4,
    }));
    strands.userData.isScalpVisualization = true;
    group.add(strands);
  }
  group.userData.strandCount = strandCount;
  group.userData.density = density;
  group.userData.groomPerformance = {
    surfaceBuilds, samplingBuilds, candidateCount: candidates.length / 10,
    cachedBytes: surface.points.byteLength + surface.normals.byteLength + surface.positions.byteLength
      + surface.surfaceNormals.byteLength + surface.boundaryFactors.byteLength + surface.index.byteLength
      + surface.candidates.reduce((sum, samples) => sum + (samples?.byteLength ?? 0), 0),
  };
  if (visualization.showBoundaryTrace) {
    const curve = new THREE.CatmullRomCurve3(boundary.map(point => new THREE.Vector3(point.x, point.y, point.z)), true, 'centripetal');
    const trace = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 192, 0.006, 6, true),
      new THREE.MeshBasicMaterial({ color: '#e7b85c', depthWrite: false }),
    );
    trace.userData.isScalpVisualization = true;
    group.add(trace);
  }
  return group;
};
