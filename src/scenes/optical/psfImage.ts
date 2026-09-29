/**
 * CPU side of the optical model: the camera image in a focal plane and line profiles.
 * Uses the same Gaussian PSF as the 3D view, so 2D and 3D always agree (spec §10).
 * Lengths in µm.
 */
import { CAMERA, erf } from '../../data/optics';
import type { Rng } from '../../data/rng';

export interface Sigma3 {
  x: number;
  y: number;
  z: number;
}

export interface ChannelDyes {
  /** Interleaved x, y, z (µm). */
  pos: Float32Array;
  weight: Float32Array;
  count: number;
}

export function emptyDyes(capacity: number): ChannelDyes {
  return { pos: new Float32Array(capacity * 3), weight: new Float32Array(capacity), count: 0 };
}

export interface SectionParams {
  /** Image centre (µm) and full width (µm). */
  cx: number;
  cy: number;
  width: number;
  /** Pixels across. */
  size: number;
  focalZ: number;
  sigma: Sigma3;
  /** Physical camera pixel (µm); intensities are photons per camera pixel. */
  cameraPixel: number;
}

/**
 * Expected photons per camera pixel (no background, no noise) in one focal plane. When the
 * sampling is finer than the camera pixel, each sample is scaled to "photons per camera
 * pixel" so brightness does not depend on the display resolution.
 */
export function renderSection(dyes: ChannelDyes, p: SectionParams, out: Float32Array): void {
  out.fill(0);
  const { size, width, sigma } = p;
  const step = width / size;
  const x0 = p.cx - width / 2;
  const y0 = p.cy - width / 2;
  const photons = CAMERA.photonsPerDye;
  const binned = step >= p.cameraPixel * 0.999;
  const area = p.cameraPixel * p.cameraPixel;
  const inv2sx = 1 / (Math.SQRT2 * sigma.x);
  const inv2sy = 1 / (Math.SQRT2 * sigma.y);
  const norm2d = 1 / (2 * Math.PI * sigma.x * sigma.y);
  const reach = 4 * Math.max(sigma.x, sigma.y);
  const wx = new Float32Array(size);
  const wy = new Float32Array(size);
  for (let d = 0; d < dyes.count; d++) {
    const dx = dyes.pos[d * 3];
    const dy = dyes.pos[d * 3 + 1];
    const dz = dyes.pos[d * 3 + 2];
    const w = dyes.weight[d];
    if (w <= 0) continue;
    const zf = Math.exp(-((p.focalZ - dz) ** 2) / (2 * sigma.z * sigma.z));
    const amp = w * photons * zf;
    if (amp < 1e-4) continue;
    const i0 = Math.max(0, Math.floor((dx - reach - x0) / step));
    const i1 = Math.min(size - 1, Math.ceil((dx + reach - x0) / step));
    const j0 = Math.max(0, Math.floor((dy - reach - y0) / step));
    const j1 = Math.min(size - 1, Math.ceil((dy + reach - y0) / step));
    if (i0 > i1 || j0 > j1) continue;
    // Separable weights: exact pixel integrals when binned, point samples otherwise.
    for (let i = i0; i <= i1; i++) {
      const a = x0 + i * step;
      wx[i] = binned
        ? 0.5 * (erf((a + step - dx) * inv2sx) - erf((a - dx) * inv2sx))
        : Math.exp(-((a + step / 2 - dx) ** 2) * inv2sx * inv2sx);
    }
    for (let j = j0; j <= j1; j++) {
      const b = y0 + j * step;
      wy[j] = binned
        ? 0.5 * (erf((b + step - dy) * inv2sy) - erf((b - dy) * inv2sy))
        : Math.exp(-((b + step / 2 - dy) ** 2) * inv2sy * inv2sy);
    }
    const k = binned ? amp : amp * norm2d * area;
    for (let j = j0; j <= j1; j++) {
      const row = (size - 1 - j) * size; // image rows run top to bottom (+y up)
      const f = k * wy[j];
      for (let i = i0; i <= i1; i++) out[row + i] += f * wx[i];
    }
  }
}

/** Add background, shot noise and read noise in place (photons → camera counts). */
export function addNoise(img: Float32Array, background: number, rng: Rng | null): void {
  for (let i = 0; i < img.length; i++) {
    const lambda = img[i] + background;
    img[i] = rng ? rng.poisson(lambda) + CAMERA.readNoise * rng.gauss() : lambda;
  }
}

/** Relative 3D intensity along a line, for the profile chart. */
export function profile(
  dyes: ChannelDyes,
  sigma: Sigma3,
  origin: [number, number, number],
  axis: 0 | 1 | 2,
  half: number,
  n: number,
): Float32Array {
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = -half + (2 * half * k) / (n - 1);
    const px = origin[0] + (axis === 0 ? t : 0);
    const py = origin[1] + (axis === 1 ? t : 0);
    const pz = origin[2] + (axis === 2 ? t : 0);
    let v = 0;
    for (let d = 0; d < dyes.count; d++) {
      const w = dyes.weight[d];
      if (w <= 0) continue;
      const ex = (px - dyes.pos[d * 3]) / sigma.x;
      const ey = (py - dyes.pos[d * 3 + 1]) / sigma.y;
      const ez = (pz - dyes.pos[d * 3 + 2]) / sigma.z;
      v += w * Math.exp(-0.5 * (ex * ex + ey * ey + ez * ez));
    }
    out[k] = v;
  }
  return out;
}

/** Full width at half maximum of a sampled curve (same units as the sample span). */
export function measureFwhm(curve: Float32Array, span: number): number {
  let max = 0;
  let im = 0;
  for (let i = 0; i < curve.length; i++) if (curve[i] > max) {
    max = curve[i];
    im = i;
  }
  if (max <= 0) return 0;
  const h = max / 2;
  let l = im;
  while (l > 0 && curve[l] > h) l--;
  let r = im;
  while (r < curve.length - 1 && curve[r] > h) r++;
  const interp = (a: number, b: number) => a + (h - curve[a]) / (curve[b] - curve[a] || 1) * (b - a);
  const left = l < im ? interp(l, l + 1) : l;
  const right = r > im ? interp(r - 1, r) : r;
  return ((right - left) / (curve.length - 1)) * span;
}

export function centroid(d: ChannelDyes): [number, number, number] | null {
  let sx = 0,
    sy = 0,
    sz = 0,
    sw = 0;
  for (let i = 0; i < d.count; i++) {
    const w = d.weight[i];
    sx += d.pos[i * 3] * w;
    sy += d.pos[i * 3 + 1] * w;
    sz += d.pos[i * 3 + 2] * w;
    sw += w;
  }
  return sw > 0 ? [sx / sw, sy / sw, sz / sw] : null;
}
