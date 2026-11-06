import { genericFaceAtlas, locateModelPoint, locateSurfacePoint } from '../../../../lab/faceSim/faceTransfer.ts';
import type { FaceAddress, PersonalSurface } from '../../../../lab/faceSim/faceTransfer';
import { buildFaceRegionMap, buildFaceTriangleRegions, faceRegionColor } from '../../../../lab/faceSim/faceRegions.ts';
import { buildRegionCells, regionCellAt, regionCellPositions } from '../../../../lab/faceSim/regionMesh.ts';
import type { RegionCell } from '../../../../lab/faceSim/regionMesh';
import { annotationLaterality } from '../../../../lab/faceSim/annotationSymmetry.ts';
import type { AnatomicalSurfaceOverlay } from './Clinical3DViewer';

let cells: RegionCell[] | undefined;
export function skinRegionCells(): readonly RegionCell[] {
  if (!cells) {
    const map = buildFaceRegionMap(Array.from({ length: 468 }, (_, i) =>
      ({ x: genericFaceAtlas.positions[i * 3], y: -genericFaceAtlas.positions[i * 3 + 1] })),
    genericFaceAtlas.triangles, 1, genericFaceAtlas.positions);
    cells = buildRegionCells(map, buildFaceTriangleRegions(map, genericFaceAtlas.positions));
  }
  return cells;
}

export function skinZoneAt(anchor: FaceAddress): string | null {
  const label = regionCellAt(anchor, skinRegionCells());
  return label ? `${label} · ${annotationLaterality({ paths: [[anchor]], kind: 'point' }, genericFaceAtlas)}` : null;
}

/** La marcación clínica normal guarda el impacto sin offset; pointMode añade 0,03. */
export function legacySkinAnchor(position: { x: number; y: number; z: number }, normal?: { x: number; y: number; z: number }) {
  const direct = locateModelPoint(position, undefined, { normal });
  if (direct || !normal) return direct;
  return locateModelPoint({ x: position.x - normal.x * .03, y: position.y - normal.y * .03,
    z: position.z - normal.z * .03 }, undefined, { normal });
}

export function skinAnatomicalOverlay(surface?: PersonalSurface): AnatomicalSurfaceOverlay {
  const positions: number[] = [], colors: number[] = [], labels: string[] = [];
  for (const cell of skinRegionCells()) {
    const xyz = regionCellPositions(cell, genericFaceAtlas.triangles, surface?.positions ?? genericFaceAtlas.positions,
      surface ? undefined : genericFaceAtlas.surface);
    positions.push(...xyz);
    const color = faceRegionColor(cell.label);
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    for (let i = 0; i < xyz.length / 3; i++) colors.push(...rgb);
    for (let i = 0; i < xyz.length / 9; i++) labels.push(cell.label);
  }
  return { positions: Float32Array.from(positions), colors: Float32Array.from(colors), labels,
    wireframe: true, opacity: .3, depthTest: true, highlight: 'mesh',
    zoneAt: point => {
      const anchor = surface ? locateSurfacePoint(point, surface) : locateModelPoint(point);
      return anchor ? skinZoneAt(anchor) : null;
    } };
}
