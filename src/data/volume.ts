/**
 * PSF-convolved cell volume (spec §6.3). Values are "photons per camera pixel if the focal
 * plane were here", i.e. a z-stack. Channels are packed as RGBA8 with a square-root
 * encoding: R = magenta (Alexa 647), G = green (Alexa 546), B = DAPI, A = cytoplasm mask.
 */
import { CAMERA } from './optics';
import { cellHeight, type CellShape } from './cell';
import { hashSeed } from './rng';

export interface VolumeGrid {
  nx: number;
  ny: number;
  nz: number;
  /** World bounds, µm. */
  min: [number, number, number];
  max: [number, number, number];
}

export const VOLUME_FULL: VolumeGrid = { nx: 256, ny: 192, nz: 48, min: [-11.6, -8.7, 0], max: [11.6, 8.7, 6.4] };
export const VOLUME_LOW: VolumeGrid = { nx: 160, ny: 120, nz: 32, min: [-11.6, -8.7, 0], max: [11.6, 8.7, 6.4] };

/** Encoding ceiling for the spot channels and DAPI (photons per pixel). */
export const ENCODE_MAX = 420;

export interface VolumeSpot {
  x: number;
  y: number;
  z: number;
  green: number;
  magenta: number;
  /** Extra blur for spots drawn as one point (the spread of dyes along the molecule), µm. */
  spread: number;
}

export interface VolumeParams {
  grid: VolumeGrid;
  spots: VolumeSpot[];
  sigmaGreen: [number, number, number];
  sigmaMagenta: [number, number, number];
  chromatic: [number, number, number];
  shape: CellShape;
}

const encode = (v: number) => Math.round(Math.sqrt(Math.min(1, Math.max(0, v / ENCODE_MAX))) * 255);
export const decode = (b: number) => (b / 255) ** 2 * ENCODE_MAX;

/** Smooth 3D value noise, seeded. */
function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  let s = hashSeed(seed, 'noise');
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    val[i] = s / 4294967296;
  }
  const h = (x: number, y: number, z: number) => val[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = fade(x - xi);
    const yf = fade(y - yi);
    const zf = fade(z - zi);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf),
      zf,
    );
  };
}

/** DAPI and cytoplasm mask channels (depend only on the cell shape). */
export function buildStructure(grid: VolumeGrid, shape: CellShape): { dapi: Float32Array; mask: Uint8Array } {
  const { nx, ny, nz, min, max } = grid;
  const n = nx * ny * nz;
  const dapi = new Float32Array(n);
  const mask = new Uint8Array(n);
  const dx = (max[0] - min[0]) / nx;
  const dy = (max[1] - min[1]) / ny;
  const dz = (max[2] - min[2]) / nz;
  const noise = makeNoise(shape.seed);
  const [cx, cy, cz] = shape.nucleusCentre;
  const [ra, rb, rc] = shape.nucleusRadii;
  // Two nucleoli: DAPI-poor holes.
  const nucleoli = [
    [cx + ra * 0.3, cy - rb * 0.15, cz + rc * 0.05, 1.1],
    [cx - ra * 0.35, cy + rb * 0.3, cz - rc * 0.1, 0.8],
  ];
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = min[1] + (j + 0.5) * dy;
    for (let i = 0; i < nx; i++) heights[j * nx + i] = cellHeight(shape, min[0] + (i + 0.5) * dx, y);
  }
  for (let k = 0; k < nz; k++) {
    const z = min[2] + (k + 0.5) * dz;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + (j + 0.5) * dy;
      for (let i = 0; i < nx; i++) {
        const x = min[0] + (i + 0.5) * dx;
        const idx = (k * ny + j) * nx + i;
        const h = heights[j * nx + i];
        if (h > 0 && z < h) {
          const edge = Math.min(1, (h - z) / 0.25, z / 0.2);
          mask[idx] = Math.round(255 * Math.max(0, edge));
        }
        const e = ((x - cx) / ra) ** 2 + ((y - cy) / rb) ** 2 + ((z - cz) / rc) ** 2;
        if (e < 1.15) {
          const inside = 1 - Math.min(1, Math.max(0, (Math.sqrt(e) - 0.94) / 0.1));
          if (inside <= 0) continue;
          // Chromatin texture: a few octaves of smooth noise, brighter toward the envelope.
          const f = noise(x * 1.6, y * 1.6, z * 1.6) * 0.55 + noise(x * 3.7, y * 3.7, z * 3.7) * 0.3 + noise(x * 8, y * 8, z * 8) * 0.15;
          let v = 0.35 + 0.9 * f * f + 0.25 * Math.max(0, e - 0.6);
          for (const [nx0, ny0, nz0, r] of nucleoli) {
            const d = Math.hypot(x - nx0, y - ny0, (z - nz0) * 1.4) / r;
            if (d < 1.2) v *= 0.25 + 0.75 * Math.min(1, Math.max(0, (d - 0.7) / 0.5));
          }
          dapi[idx] = 70 * v * inside;
        }
      }
    }
  }
  return { dapi, mask };
}

/** Splat each spot's Gaussian directly into the grid (spots are sparse, so this is fast). */
export function splatSpots(p: VolumeParams, green: Float32Array, magenta: Float32Array): void {
  const { nx, ny, nz, min, max } = p.grid;
  const dx = (max[0] - min[0]) / nx;
  const dy = (max[1] - min[1]) / ny;
  const dz = (max[2] - min[2]) / nz;
  const area = (CAMERA.pixelNm / 1000) ** 2;
  green.fill(0);
  magenta.fill(0);
  const wx = new Float32Array(nx);
  const wy = new Float32Array(ny);
  const wz = new Float32Array(nz);
  const splat = (out: Float32Array, sx0: number, sy0: number, sz0: number, x: number, y: number, z: number, dyes: number, spread: number) => {
    if (dyes <= 0) return;
    const sx = Math.hypot(sx0, spread);
    const sy = Math.hypot(sy0, spread);
    const sz = Math.hypot(sz0, spread);
    // Peak: photons per camera pixel at focus, 2D-normalised in xy, un-normalised in z.
    const amp = (dyes * CAMERA.photonsPerDye * area) / (2 * Math.PI * sx * sy);
    const i0 = Math.max(0, Math.floor((x - 4 * sx - min[0]) / dx));
    const i1 = Math.min(nx - 1, Math.ceil((x + 4 * sx - min[0]) / dx));
    const j0 = Math.max(0, Math.floor((y - 4 * sy - min[1]) / dy));
    const j1 = Math.min(ny - 1, Math.ceil((y + 4 * sy - min[1]) / dy));
    const k0 = Math.max(0, Math.floor((z - 4 * sz - min[2]) / dz));
    const k1 = Math.min(nz - 1, Math.ceil((z + 4 * sz - min[2]) / dz));
    for (let i = i0; i <= i1; i++) wx[i] = Math.exp(-(((min[0] + (i + 0.5) * dx - x) / sx) ** 2) / 2);
    for (let j = j0; j <= j1; j++) wy[j] = Math.exp(-(((min[1] + (j + 0.5) * dy - y) / sy) ** 2) / 2);
    for (let k = k0; k <= k1; k++) wz[k] = Math.exp(-(((min[2] + (k + 0.5) * dz - z) / sz) ** 2) / 2);
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        const f = amp * wz[k] * wy[j];
        const row = (k * ny + j) * nx;
        for (let i = i0; i <= i1; i++) out[row + i] += f * wx[i];
      }
    }
  };
  const [gx, gy, gz] = p.sigmaGreen;
  const [mx, my, mz] = p.sigmaMagenta;
  const [ox, oy, oz] = p.chromatic;
  for (const s of p.spots) {
    splat(green, gx, gy, gz, s.x, s.y, s.z, s.green, s.spread);
    splat(magenta, mx, my, mz, s.x + ox, s.y + oy, s.z + oz, s.magenta, s.spread);
  }
}

export function pack(green: Float32Array, magenta: Float32Array, dapi: Float32Array, mask: Uint8Array): Uint8Array {
  const n = green.length;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = encode(magenta[i]);
    out[i * 4 + 1] = encode(green[i]);
    out[i * 4 + 2] = encode(dapi[i]);
    out[i * 4 + 3] = mask[i];
  }
  return out;
}
