import * as THREE from 'three';
import type { ScalpHairVisualization } from './Clinical3DViewer';

const HEAD_CENTER = new THREE.Vector3(0, 0.58, -0.08);
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

const createBoundaryProfile = (
  points: NonNullable<ScalpHairVisualization['boundaryPoints']>,
) => {
  const samples: Array<{ angle: number; height: number }> = [];
  let previousAngle = -Infinity;
  points.forEach(({ x, y, z }) => {
    let angle = Math.atan2(z - HEAD_CENTER.z, x - HEAD_CENTER.x);
    while (angle < previousAngle) angle += Math.PI * 2;
    samples.push({ angle, height: y });
    previousAngle = angle;
  });
  return samples;
};

const getBoundaryHeight = (angle: number, profile: Array<{ angle: number; height: number }>) => {
  const first = profile[0];
  if (!first) return Number.POSITIVE_INFINITY;
  let normalizedAngle = angle;
  while (normalizedAngle < first.angle) normalizedAngle += Math.PI * 2;
  while (normalizedAngle >= first.angle + Math.PI * 2) normalizedAngle -= Math.PI * 2;

  for (let index = 1; index < profile.length; index += 1) {
    const end = profile[index];
    if (normalizedAngle > end.angle) continue;
    const start = profile[index - 1];
    const amount = (normalizedAngle - start.angle) / (end.angle - start.angle || 1);
    return THREE.MathUtils.lerp(start.height, end.height, amount);
  }

  const last = profile[profile.length - 1];
  const endAngle = first.angle + Math.PI * 2;
  const amount = (normalizedAngle - last.angle) / (endAngle - last.angle || 1);
  return THREE.MathUtils.lerp(last.height, first.height, amount);
};

export const createScalpGroomGroup = (
  visualization: ScalpHairVisualization,
  head: THREE.Object3D,
): THREE.Group | null => {
  const boundary = visualization.boundaryClosed ? visualization.boundaryPoints : null;
  if (!boundary || boundary.length < 3) return null;

  const profile = createBoundaryProfile(boundary);
  const scalpSourceMeshes: THREE.Mesh[] = [];
  const headMeshes: THREE.Mesh[] = [];
  head.updateMatrixWorld(true);
  head.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    if (mesh.name === 'SCALP_HAIR_SOURCE') scalpSourceMeshes.push(mesh);
    else headMeshes.push(mesh);
  });
  const sourceMeshes = scalpSourceMeshes.length ? scalpSourceMeshes : headMeshes;
  const hasPrebuiltScalpSource = scalpSourceMeshes.length > 0;
  if (!sourceMeshes.length) return null;

  const densityFactor = visualization.density === 'Alta'
    ? 1
    : visualization.density === 'Baja'
      ? 0.72
      : 0.88;
  const hairColor = new THREE.Color(visualization.color ?? '#2b1a12');
  const scalpColor = new THREE.Color('#7a625c');
  const lengthScale = THREE.MathUtils.clamp(visualization.lengthScale ?? 0.82, 0.55, 1.8);
  const compactness = THREE.MathUtils.clamp(visualization.layDown ?? 0.78, 0.45, 0.96);
  const liftScale = THREE.MathUtils.lerp(1.2, 0.72, (compactness - 0.45) / 0.51);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const localA = new THREE.Vector3();
  const localB = new THREE.Vector3();
  const localC = new THREE.Vector3();
  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  const worldC = new THREE.Vector3();
  const edgeAC = new THREE.Vector3();
  const worldNormalA = new THREE.Vector3();
  const worldNormalB = new THREE.Vector3();
  const worldNormalC = new THREE.Vector3();
  const center = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const color = new THREE.Color();

  sourceMeshes.forEach(mesh => {
    const source = mesh.geometry;
    if (!source.getAttribute('normal')) source.computeVertexNormals();
    const sourcePositions = source.getAttribute('position');
    const sourceNormals = source.getAttribute('normal');
    const index = source.getIndex();
    const normalCount = index?.count ?? sourcePositions.count;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    for (let offset = 0; offset + 2 < normalCount; offset += 3) {
      const aIndex = index ? index.getX(offset) : offset;
      const bIndex = index ? index.getX(offset + 1) : offset + 1;
      const cIndex = index ? index.getX(offset + 2) : offset + 2;
      localA.fromBufferAttribute(sourcePositions, aIndex);
      localB.fromBufferAttribute(sourcePositions, bIndex);
      localC.fromBufferAttribute(sourcePositions, cIndex);
      worldA.copy(localA).applyMatrix4(mesh.matrixWorld);
      worldB.copy(localB).applyMatrix4(mesh.matrixWorld);
      worldC.copy(localC).applyMatrix4(mesh.matrixWorld);
      center.copy(worldA).add(worldB).add(worldC).multiplyScalar(1 / 3);
      const angle = Math.atan2(center.z - HEAD_CENTER.z, center.x - HEAD_CENTER.x);
      const boundaryHeight = getBoundaryHeight(angle, profile);
      if (!hasPrebuiltScalpSource && center.y < boundaryHeight - 0.025) continue;

      radial.subVectors(center, HEAD_CENTER).normalize();
      faceNormal.subVectors(worldB, worldA).cross(edgeAC.subVectors(worldC, worldA)).normalize();
      if (faceNormal.dot(radial) < 0) faceNormal.negate();
      if (!hasPrebuiltScalpSource && faceNormal.dot(radial) < 0.12) continue;
      if (getCoverage(center, visualization) * densityFactor < 0.24) continue;

      const trianglePoints = [worldA, worldB, worldC];
      const triangleNormals = [worldNormalA, worldNormalB, worldNormalC];
      const sourceIndices = [aIndex, bIndex, cIndex];
      trianglePoints.forEach((point, vertexIndex) => {
        const sourceNormal = new THREE.Vector3().fromBufferAttribute(sourceNormals, sourceIndices[vertexIndex]);
        const normal = triangleNormals[vertexIndex]
          .copy(sourceNormal)
          .applyMatrix3(normalMatrix)
          .normalize();
        if (normal.dot(radial) < 0) normal.negate();

        const vertexAngle = Math.atan2(point.z - HEAD_CENTER.z, point.x - HEAD_CENTER.x);
        const vertexBoundary = getBoundaryHeight(vertexAngle, profile);
        const edgeFade = THREE.MathUtils.smoothstep(point.y - vertexBoundary, 0, 0.18);
        const crownLift = THREE.MathUtils.smoothstep(point.y, vertexBoundary, vertexBoundary + 0.7);
        const flowRidge = Math.sin((point.x + point.z * 0.35) * 24 + point.y * 10) * 0.0025;
        const shellOffset = 0.004 + (
          lengthScale * (0.018 + crownLift * 0.035) + flowRidge
        ) * edgeFade * liftScale;
        point.addScaledVector(normal, shellOffset);
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);

        const localCoverage = getCoverage(point, visualization) * densityFactor;
        const strandVariation = 0.93 + 0.07 * (
          0.5 + 0.5 * Math.sin((point.x + point.z * 0.3) * 42 + point.y * 13)
        );
        color.copy(scalpColor).lerp(hairColor, THREE.MathUtils.clamp(localCoverage, 0, 1));
        color.multiplyScalar(strandVariation);
        colors.push(color.r, color.g, color.b);
      });
    }
  });

  if (!positions.length) return null;
  const hairGeometry = new THREE.BufferGeometry();
  hairGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  hairGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  hairGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  hairGeometry.computeBoundingSphere();

  const group = new THREE.Group();
  group.name = 'scalp-hair-cap';
  const hair = new THREE.Mesh(
    hairGeometry,
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: THREE.MathUtils.clamp(visualization.roughness ?? 0.58, 0.3, 0.95),
      metalness: 0,
      vertexColors: true,
      sheen: 0.8,
      sheenColor: hairColor.clone().offsetHSL(0.01, -0.08, 0.14),
      sheenRoughness: 0.62,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  );
  hair.castShadow = true;
  hair.receiveShadow = true;
  hair.userData.isScalpVisualization = true;
  group.add(hair);

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

  return group;
};
