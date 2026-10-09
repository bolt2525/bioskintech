import * as THREE from 'three';
import type { ScalpHairVisualization } from './Clinical3DViewer';

type ProxyTriangle = {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  area: number;
  edgeDistance: number;
};

const PROXY_SEGMENTS = 128;
const PROXY_RINGS = 12;
const HEAD_CENTER = new THREE.Vector3(0, 0.58, -0.08);
const HEAD_RADII = new THREE.Vector3(1.17, 1.9, 1.58);
const CROWN_DIRECTION = new THREE.Vector3(0, 1, 0);
const NORWOOD_STAGE_INDEX: Record<string, number> = {
  I: 0,
  II: 1,
  III: 2,
  'III Vertex': 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
};

const seededRandom = (seedText: string) => {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const getCoverage = (position: THREE.Vector3, visualization: ScalpHairVisualization): number => {
  const absX = Math.abs(position.x);
  if (visualization.scale === 'ludwig') {
    const central = Math.exp(
      -((position.x / 0.66) ** 2)
      -(((position.z + 0.18) / 1.08) ** 2),
    );
    const loss = visualization.stage === 'III' ? 0.82 : visualization.stage === 'II' ? 0.58 : 0.32;
    return THREE.MathUtils.clamp(0.98 - central * loss, 0.12, 0.98);
  }

  const stage = NORWOOD_STAGE_INDEX[visualization.stage] ?? 0;
  const front = THREE.MathUtils.smoothstep(position.z, 0.18, 1.45);
  const temple = THREE.MathUtils.smoothstep(absX, 0.5, 1.05)
    * THREE.MathUtils.smoothstep(position.y, 0.78, 1.42)
    * front;
  const crownDistance = Math.hypot(position.x / 0.82, (position.z + 0.55) / 0.88);
  const crown = 1 - THREE.MathUtils.smoothstep(crownDistance, 0.25, 1.08);
  const centralBridge = (1 - THREE.MathUtils.smoothstep(absX, 0.35, 0.95))
    * THREE.MathUtils.smoothstep(position.y, 0.55, 1.6);

  const frontLoss = [0, 0.12, 0.42, 0.34, 0.68, 0.84, 0.96, 1][stage];
  const crownLoss = [0, 0, 0.08, 0.82, 0.86, 0.92, 0.98, 1][stage];
  const bridgeLoss = [0, 0, 0.12, 0.18, 0.56, 0.82, 0.98, 1][stage];
  const loss = Math.max(
    front * frontLoss * (0.34 + temple * 0.66),
    crown * crownLoss,
    centralBridge * bridgeLoss,
  );
  const horseshoe = absX > 0.78 || position.z < -0.72 || position.y < 0.42;
  if (stage >= 6 && horseshoe) return stage === 7 ? 0.78 : 0.9;
  return THREE.MathUtils.clamp(1 - loss, 0, 1);
};

const createProxyGeometry = (boundary: Array<{ x: number; y: number; z: number }>) => {
  const boundaryCurve = new THREE.CatmullRomCurve3(
    boundary.map(point => new THREE.Vector3(point.x, point.y, point.z)),
    true,
    'centripetal',
  );
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const direction = new THREE.Vector3();
  const projected = new THREE.Vector3();

  for (let ring = 0; ring <= PROXY_RINGS; ring += 1) {
    const edgeDistance = ring / PROXY_RINGS;
    const eased = THREE.MathUtils.smoothstep(edgeDistance, 0, 1);
    for (let segment = 0; segment < PROXY_SEGMENTS; segment += 1) {
      const boundaryPoint = boundaryCurve.getPointAt(segment / PROXY_SEGMENTS);
      direction.set(
        (boundaryPoint.x - HEAD_CENTER.x) / HEAD_RADII.x,
        (boundaryPoint.y - HEAD_CENTER.y) / HEAD_RADII.y,
        (boundaryPoint.z - HEAD_CENTER.z) / HEAD_RADII.z,
      ).normalize();
      direction.lerp(CROWN_DIRECTION, eased).normalize();
      projected.set(
        HEAD_CENTER.x + direction.x * HEAD_RADII.x,
        HEAD_CENTER.y + direction.y * HEAD_RADII.y,
        HEAD_CENTER.z + direction.z * HEAD_RADII.z,
      );
      if (ring === 0) projected.copy(boundaryPoint);
      const shellOffset = 0.018 + Math.sin(Math.PI * edgeDistance) * 0.24;
      projected.addScaledVector(direction, shellOffset);
      positions.push(projected.x, projected.y, projected.z);
      uvs.push(segment / PROXY_SEGMENTS, edgeDistance);
    }
  }

  for (let ring = 0; ring < PROXY_RINGS; ring += 1) {
    for (let segment = 0; segment < PROXY_SEGMENTS; segment += 1) {
      const next = (segment + 1) % PROXY_SEGMENTS;
      const current = ring * PROXY_SEGMENTS + segment;
      const currentNext = ring * PROXY_SEGMENTS + next;
      const inner = (ring + 1) * PROXY_SEGMENTS + segment;
      const innerNext = (ring + 1) * PROXY_SEGMENTS + next;
      indices.push(current, inner, currentNext, currentNext, inner, innerNext);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const getProxyTriangles = (geometry: THREE.BufferGeometry): ProxyTriangle[] => {
  const positions = geometry.getAttribute('position');
  const uvs = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  if (!index) return [];
  const triangles: ProxyTriangle[] = [];
  for (let offset = 0; offset < index.count; offset += 3) {
    const aIndex = index.getX(offset);
    const bIndex = index.getX(offset + 1);
    const cIndex = index.getX(offset + 2);
    const a = new THREE.Vector3().fromBufferAttribute(positions, aIndex);
    const b = new THREE.Vector3().fromBufferAttribute(positions, bIndex);
    const c = new THREE.Vector3().fromBufferAttribute(positions, cIndex);
    const area = new THREE.Triangle(a, b, c).getArea();
    if (area <= 1e-7) continue;
    triangles.push({
      a,
      b,
      c,
      area,
      edgeDistance: (uvs.getY(aIndex) + uvs.getY(bIndex) + uvs.getY(cIndex)) / 3,
    });
  }
  return triangles;
};

const createLockGeometry = () => {
  const geometry = new THREE.BufferGeometry();
  const radialSegments = 6;
  const rings = [
    { y: 0, width: 0.2, depth: 0.1, curve: 0 },
    { y: 0.3, width: 0.27, depth: 0.12, curve: 0.015 },
    { y: 0.62, width: 0.23, depth: 0.09, curve: 0.05 },
    { y: 0.86, width: 0.14, depth: 0.055, curve: 0.09 },
    { y: 1, width: 0.025, depth: 0.012, curve: 0.13 },
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  rings.forEach(ring => {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * Math.PI * 2;
      positions.push(
        Math.cos(angle) * ring.width,
        ring.y,
        ring.curve + Math.sin(angle) * ring.depth,
      );
    }
  });
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    const current = ring * radialSegments;
    const next = current + radialSegments;
    for (let side = 0; side < radialSegments; side += 1) {
      const following = (side + 1) % radialSegments;
      indices.push(
        current + side, next + side, current + following,
        current + following, next + side, next + following,
      );
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

export const createScalpGroomGroup = (
  visualization: ScalpHairVisualization,
): THREE.Group | null => {
  const boundary = visualization.boundaryClosed ? visualization.boundaryPoints : null;
  if (!boundary || boundary.length < 3) return null;

  const proxyGeometry = createProxyGeometry(boundary);
  const triangles = getProxyTriangles(proxyGeometry);
  if (!triangles.length) {
    proxyGeometry.dispose();
    return null;
  }

  const group = new THREE.Group();
  group.name = 'scalp-groom-proxy';
  const baseColor = new THREE.Color(visualization.color ?? '#2b1a12');
  const underlayPositions: number[] = [];
  const underlayNormals: number[] = [];
  const normal = new THREE.Vector3();
  const radial = new THREE.Vector3();

  triangles.forEach(triangle => {
    const center = triangle.a.clone().add(triangle.b).add(triangle.c).multiplyScalar(1 / 3);
    if (getCoverage(center, visualization) < 0.46) return;
    normal.subVectors(triangle.b, triangle.a)
      .cross(new THREE.Vector3().subVectors(triangle.c, triangle.a))
      .normalize();
    radial.copy(center).sub(HEAD_CENTER);
    if (normal.dot(radial) < 0) normal.negate();
    [triangle.a, triangle.b, triangle.c].forEach(point => {
      underlayPositions.push(
        point.x + normal.x * 0.003,
        point.y + normal.y * 0.003,
        point.z + normal.z * 0.003,
      );
      underlayNormals.push(normal.x, normal.y, normal.z);
    });
  });

  if (underlayPositions.length) {
    const underlayGeometry = new THREE.BufferGeometry();
    underlayGeometry.setAttribute('position', new THREE.Float32BufferAttribute(underlayPositions, 3));
    underlayGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(underlayNormals, 3));
    const underlay = new THREE.Mesh(
      underlayGeometry,
      new THREE.MeshPhysicalMaterial({
        color: baseColor.clone().offsetHSL(0, -0.03, -0.04),
        roughness: THREE.MathUtils.clamp((visualization.roughness ?? 0.58) + 0.14, 0.42, 0.98),
        metalness: 0,
        sheen: 0.45,
        sheenColor: baseColor.clone().offsetHSL(0.01, -0.08, 0.12),
        side: THREE.DoubleSide,
      }),
    );
    underlay.castShadow = true;
    underlay.receiveShadow = true;
    underlay.userData.isScalpVisualization = true;
    group.add(underlay);
  }

  const densityStyle = visualization.density === 'Alta'
    ? { count: 1500, length: 0.24, width: 0.105 }
    : visualization.density === 'Baja'
      ? { count: 560, length: 0.19, width: 0.08 }
      : { count: 980, length: 0.215, width: 0.092 };
  const lockGeometry = createLockGeometry();
  const lockMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: THREE.MathUtils.clamp(visualization.roughness ?? 0.58, 0.3, 0.95),
    metalness: 0,
    vertexColors: true,
    sheen: 0.9,
    sheenColor: baseColor.clone().offsetHSL(0.01, -0.08, 0.18),
    sheenRoughness: 0.55,
  });
  const locks = new THREE.InstancedMesh(lockGeometry, lockMaterial, densityStyle.count);
  locks.castShadow = true;
  locks.receiveShadow = true;
  locks.frustumCulled = false;
  locks.userData.isScalpVisualization = true;

  const cumulativeAreas: number[] = [];
  let totalArea = 0;
  triangles.forEach(triangle => {
    totalArea += triangle.area;
    cumulativeAreas.push(totalArea);
  });
  const random = seededRandom(`${visualization.scale}:${visualization.stage}:${visualization.density}:proxy-v1`);
  const up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const flow = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const twist = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const crown = new THREE.Vector3(0, HEAD_CENTER.y + HEAD_RADII.y, HEAD_CENTER.z);
  const lengthScale = THREE.MathUtils.clamp(visualization.lengthScale ?? 1, 0.55, 1.8);
  const layDown = THREE.MathUtils.clamp(visualization.layDown ?? 0.78, 0.45, 0.96);
  let lockCount = 0;
  const maxAttempts = densityStyle.count * 28;

  for (let attempt = 0; attempt < maxAttempts && lockCount < densityStyle.count; attempt += 1) {
    const target = random() * totalArea;
    let low = 0;
    let high = cumulativeAreas.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cumulativeAreas[middle] < target) low = middle + 1;
      else high = middle;
    }
    const triangle = triangles[low];
    const sqrtR1 = Math.sqrt(random());
    const weightA = 1 - sqrtR1;
    const weightB = sqrtR1 * (1 - random());
    const weightC = 1 - weightA - weightB;
    position.copy(triangle.a).multiplyScalar(weightA)
      .addScaledVector(triangle.b, weightB)
      .addScaledVector(triangle.c, weightC);
    if (random() > getCoverage(position, visualization)) continue;
    normal.subVectors(triangle.b, triangle.a)
      .cross(new THREE.Vector3().subVectors(triangle.c, triangle.a))
      .normalize();
    radial.copy(position).sub(HEAD_CENTER);
    if (normal.dot(radial) < 0) normal.negate();
    flow.subVectors(crown, position);
    flow.addScaledVector(normal, -flow.dot(normal)).normalize();
    const surfaceFollow = THREE.MathUtils.lerp(0.9, 0.985, (layDown - 0.45) / 0.51);
    direction.copy(flow).multiplyScalar(surfaceFollow).addScaledVector(normal, 1 - surfaceFollow).normalize();
    quaternion.setFromUnitVectors(up, direction);
    twist.setFromAxisAngle(up, (random() - 0.5) * 0.55);
    quaternion.multiply(twist);
    position.addScaledVector(normal, 0.01);
    const edgeScale = THREE.MathUtils.lerp(0.42, 1, THREE.MathUtils.smoothstep(triangle.edgeDistance, 0, 0.3));
    const variation = 0.86 + random() * 0.26;
    scale.set(
      densityStyle.width * variation * edgeScale,
      densityStyle.length * lengthScale * variation * edgeScale,
      densityStyle.width * variation * edgeScale,
    );
    matrix.compose(position, quaternion, scale);
    locks.setMatrixAt(lockCount, matrix);
    color.copy(baseColor).offsetHSL(
      (random() - 0.5) * 0.02,
      (random() - 0.5) * 0.05,
      (random() - 0.5) * 0.07,
    );
    locks.setColorAt(lockCount, color);
    lockCount += 1;
  }
  locks.count = lockCount;
  locks.instanceMatrix.needsUpdate = true;
  if (locks.instanceColor) locks.instanceColor.needsUpdate = true;
  group.add(locks);

  if (visualization.showBoundaryTrace) {
    const traceCurve = new THREE.CatmullRomCurve3(
      boundary.map(point => new THREE.Vector3(point.x, point.y, point.z)),
      true,
      'centripetal',
    );
    const trace = new THREE.Mesh(
      new THREE.TubeGeometry(traceCurve, 192, 0.01, 6, true),
      new THREE.MeshBasicMaterial({ color: '#e7b85c', depthWrite: false }),
    );
    trace.renderOrder = 20;
    trace.userData.isScalpVisualization = true;
    group.add(trace);
  }

  proxyGeometry.dispose();
  return group;
};
