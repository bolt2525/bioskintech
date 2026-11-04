export const PROFILE_CALIBRATION = [
  { id: 'radix', landmark: 168, label: 'Raíz nasal', radius: 0.11, width: 0.1 },
  { id: 'bridge', landmark: 6, label: 'Dorso superior', radius: 0.1, width: 0.1 },
  { id: 'tip', landmark: 1, label: 'Punta nasal', radius: 0.1, width: 0.11 },
  { id: 'subnasal', landmark: 2, label: 'Base nasal', radius: 0.065, width: 0.1 },
  { id: 'philtrum', landmark: 164, label: 'Filtrum', radius: 0.055, width: 0.1 },
  { id: 'upperLip', landmark: 0, label: 'Labio superior', radius: 0.05, width: 0.17 },
  { id: 'lowerLip', landmark: 17, label: 'Labio inferior', radius: 0.055, width: 0.17 },
  { id: 'chin', landmark: 152, label: 'Mentón', radius: 0.12, width: 0.18 },
] as const;
export type ProfileCalibration = Partial<Record<typeof PROFILE_CALIBRATION[number]['id'], number>>;
const EYE_BOUNDARY = new Set([33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]);

/** Ajuste explícito del prior, en fracciones del alto facial; no interpreta píxeles como profundidad. */
export function calibrateProfileDepth(
  positions: Float32Array, indices: Uint32Array, settings: ProfileCalibration,
): { positions: Float32Array; gain: number; maxDisplacement: number } {
  if (positions.length < 468 * 3 || positions.length % 3 || !positions.every(Number.isFinite)
    || indices.length % 3 || indices.some(i => i >= positions.length / 3)
    || Object.entries(settings).some(([id, value]) => !PROFILE_CALIBRATION.some(control => control.id === id)
      || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 0.08)) {
    throw new Error('Calibración de perfil inválida: revisa referencias e intensidades (−8 a +8 %).');
  }
  const out = positions.slice();
  const height = Math.hypot(positions[10 * 3] - positions[152 * 3], positions[10 * 3 + 1] - positions[152 * 3 + 1]);
  if (!(height > 1e-6)) throw new Error('La altura facial no permite calibrar el perfil.');
  const active = PROFILE_CALIBRATION.filter(control => settings[control.id]);
  if (!active.length) return { positions: out, gain: 1, maxDisplacement: 0 };
  const delta = new Float64Array(positions.length / 3);
  for (let i = 0; i < delta.length; i++) {
    if (i >= 468 || EYE_BOUNDARY.has(i)) continue;
    if (positions[i * 3 + 1] >= positions[168 * 3 + 1] + height * 0.035) continue;
    let displacement = 0, total = 0;
    for (const control of active) {
      const offset = control.landmark * 3;
      const distance = Math.hypot((positions[i * 3] - positions[offset]) / (height * control.width),
        (positions[i * 3 + 1] - positions[offset + 1]) / (height * control.radius));
      if (distance >= 1) continue;
      const weight = (1 - distance) ** 4 * (4 * distance + 1);
      displacement += weight * settings[control.id]! * height;
      total += weight;
    }
    delta[i] = displacement / Math.max(1, total);
  }
  const valid = (gain: number) => {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
      const ab = [0, 1, 2].map(axis => positions[b * 3 + axis] - positions[a * 3 + axis]);
      const ac = [0, 1, 2].map(axis => positions[c * 3 + axis] - positions[a * 3 + axis]);
      const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const db = (delta[b] - delta[a]) * gain, dc = (delta[c] - delta[a]) * gain;
      const next = [normal[0] + ab[1] * dc - db * ac[1], normal[1] + db * ac[0] - ab[0] * dc, normal[2]];
      const area = normal.reduce((sum, v) => sum + v * v, 0);
      if (area > 1e-18 && next.reduce((sum, v, j) => sum + v * normal[j], 0) < area * 0.2) return false;
    }
    return true;
  };
  let gain = 1;
  if (!valid(1)) {
    let low = 0, high = 1;
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2;
      if (valid(middle)) low = middle; else high = middle;
    }
    gain = low * 0.999;
  }
  let maxDisplacement = 0;
  delta.forEach((value, i) => {
    out[i * 3 + 2] += value * gain;
    maxDisplacement = Math.max(maxDisplacement, Math.abs(out[i * 3 + 2] - positions[i * 3 + 2]));
  });
  return { positions: out, gain, maxDisplacement };
}
