import * as THREE from 'three';
import type { ScalpHairVisualization } from './Clinical3DViewer';
import { getScalpCoverage, getScalpDensity } from '../../../../data/scalpPatterns';

const HEAD_CENTER = new THREE.Vector3(0, 0.58, -0.08);
const SURFACE_OFFSET = 0.003;
type SurfaceVertex = { point: THREE.Vector3; normal: THREE.Vector3 };

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

export const createScalpGroomGroup = (
  visualization: ScalpHairVisualization,
  head: THREE.Object3D,
): THREE.Group | null => {
  const boundary = visualization.boundaryClosed ? visualization.boundaryPoints : null;
  if (!boundary || boundary.length < 3) return null;
  const profile = createBoundaryProfile(boundary);
  const meshes: THREE.Mesh[] = [];
  head.updateMatrixWorld(true);
  head.traverse(child => {
    if (child instanceof THREE.Mesh && child.name !== 'SCALP_HAIR_SOURCE'
      && child.geometry.getAttribute('position')) meshes.push(child);
  });
  if (!meshes.length) return null;

  const density = getScalpDensity(visualization.density);
  const female = visualization.scale === 'ludwig';
  const hairColor = new THREE.Color(visualization.color ?? '#2b1a12');
  const length = THREE.MathUtils.clamp(visualization.lengthScale ?? 0.82, 0.55, 1.8);
  const compactness = THREE.MathUtils.clamp(visualization.layDown ?? 0.78, 0.45, 0.96);
  const positions: number[] = [];
  const normals: number[] = [];
  const coverages: number[] = [];
  const strandPositions: number[] = [];
  const strandNormals: number[] = [];
  let strandCount = 0;
  let seed = 74219;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const boundaryDistance = (point: THREE.Vector3) =>
    point.y - getBoundaryHeight(Math.atan2(point.z - HEAD_CENTER.z, point.x), profile);
  const coverage = (point: THREE.Vector3) =>
    getScalpCoverage(point, visualization) * THREE.MathUtils.smoothstep(boundaryDistance(point), 0, 0.055);

  const addStrand = (root: THREE.Vector3, normal: THREE.Vector3, probability: number) => {
    // Stable candidates across stages/densities keep comparisons free of random regrowth.
    const selection = random();
    const variation = random();
    const directionVariation = random();
    if (selection > probability * density) return;
    strandCount += 1;
    const side = root.x < 0 ? -1 : 1;
    const flow = female
      ? new THREE.Vector3(side * 0.75, -0.85, -0.22)
      : new THREE.Vector3(side * 0.22 + (directionVariation - 0.5) * 0.2, -0.35, -1);
    flow.addScaledVector(normal, -flow.dot(normal)).normalize();
    const widthDirection = new THREE.Vector3().crossVectors(flow, normal).normalize();
    const drape = female && (Math.abs(root.x) > 0.72 || root.z < -0.7);
    const strandLength = length * (drape ? 0.72 + variation * 0.38 : female ? 0.2 : 0.08);
    const width = female ? 0.006 : 0.004;
    const segments = drape ? 8 : 4;
    let previousLeft: THREE.Vector3 | null = null;
    let previousRight: THREE.Vector3 | null = null;
    for (let segment = 0; segment <= segments; segment += 1) {
      const t = segment / segments;
      const point = root.clone().addScaledVector(flow, strandLength * t);
      // A small lift that returns to the scalp, not a second inflated hair shell.
      point.addScaledVector(normal, SURFACE_OFFSET + Math.sin(Math.PI * t) * 0.025 * (1 - compactness));
      if (drape) {
        point.x += side * 0.055 * Math.sin(Math.PI * t);
        point.y -= strandLength * t * t * 0.55;
      }
      const halfWidth = width * (1 - t * 0.85);
      const left = point.clone().addScaledVector(widthDirection, -halfWidth);
      const right = point.clone().addScaledVector(widthDirection, halfWidth);
      if (previousLeft && previousRight) {
        for (const vertex of [previousLeft, previousRight, left, previousRight, right, left]) {
          strandPositions.push(vertex.x, vertex.y, vertex.z);
          strandNormals.push(normal.x, normal.y, normal.z);
        }
      }
      previousLeft = left;
      previousRight = right;
    }
  };

  const emitTriangle = (a: SurfaceVertex, b: SurfaceVertex, c: SurfaceVertex) => {
    for (const { point, normal } of [a, b, c]) {
      const surfacePoint = point.clone().addScaledVector(normal, SURFACE_OFFSET);
      positions.push(surfacePoint.x, surfacePoint.y, surfacePoint.z);
      normals.push(normal.x, normal.y, normal.z);
      coverages.push(coverage(point));
    }
    const area = b.point.clone().sub(a.point).cross(c.point.clone().sub(a.point)).length() * 0.5;
    const candidates = area * (female ? 1800 : 2400);
    const count = Math.floor(candidates) + (random() < candidates % 1 ? 1 : 0);
    for (let i = 0; i < count; i += 1) {
      const u = Math.sqrt(random());
      const v = random();
      const root = a.point.clone().multiplyScalar(1 - u)
        .addScaledVector(b.point, u * (1 - v)).addScaledVector(c.point, u * v);
      const normal = a.normal.clone().multiplyScalar(1 - u)
        .addScaledVector(b.normal, u * (1 - v)).addScaledVector(c.normal, u * v).normalize();
      addStrand(root, normal, coverage(root));
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
  if (!positions.length) return null;
  const hairGeometry = new THREE.BufferGeometry();
  hairGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  hairGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  hairGeometry.setAttribute('scalpCoverage', new THREE.Float32BufferAttribute(coverages, 1));
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
    strandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(strandPositions, 3));
    strandGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(strandNormals, 3));
    const strands = new THREE.Mesh(strandGeometry, new THREE.MeshPhysicalMaterial({
      color: hairColor, roughness: visualization.roughness ?? 0.58,
      side: THREE.DoubleSide, sheen: 0.4,
    }));
    strands.userData.isScalpVisualization = true;
    group.add(strands);
  }
  group.userData.strandCount = strandCount;
  group.userData.density = density;
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
