import { describe, expect, it } from 'vitest';
import { buildStructure, decode, pack, splatSpots, VOLUME_FULL } from '../../src/data/volume';
import { makeCellShape } from '../../src/data/cell';
import { CAMERA, peakPixelFraction } from '../../src/data/optics';

describe('cell volume', () => {
  const shape = makeCellShape(1);
  const g = VOLUME_FULL;
  const n = g.nx * g.ny * g.nz;

  it('splats a spot with the expected in-focus peak', () => {
    const green = new Float32Array(n);
    const magenta = new Float32Array(n);
    const sigma: [number, number, number] = [0.086, 0.086, 0.292];
    // Put the spot on a voxel centre so the peak is sampled.
    const dx = (g.max[0] - g.min[0]) / g.nx;
    const dy = (g.max[1] - g.min[1]) / g.ny;
    const dz = (g.max[2] - g.min[2]) / g.nz;
    const x = g.min[0] + 100.5 * dx;
    const y = g.min[1] + 80.5 * dy;
    const z = g.min[2] + 12.5 * dz;
    splatSpots({ grid: g, spots: [{ x, y, z, green: 10, magenta: 0, spread: 0 }], sigmaGreen: sigma, sigmaMagenta: sigma, chromatic: [0, 0, 0], shape }, green, magenta);
    const peak = green[(12 * g.ny + 80) * g.nx + 100];
    // Point sample of the normalised 2D Gaussian × pixel area ≈ the pixel-integrated peak.
    const expected = 10 * CAMERA.photonsPerDye * peakPixelFraction(86);
    expect(peak).toBeGreaterThan(expected * 0.9);
    expect(peak).toBeLessThan(expected * 1.15);
    expect(magenta.every((v) => v === 0)).toBe(true);
  });

  it('builds DAPI inside the nucleus only, and packs round-trippably', () => {
    const t0 = performance.now();
    const { dapi, mask } = buildStructure(g, shape);
    const ms = performance.now() - t0;
    const [cx, cy, cz] = shape.nucleusCentre;
    const idx = (x: number, y: number, z: number) => {
      const i = Math.floor(((x - g.min[0]) / (g.max[0] - g.min[0])) * g.nx);
      const j = Math.floor(((y - g.min[1]) / (g.max[1] - g.min[1])) * g.ny);
      const k = Math.floor(((z - g.min[2]) / (g.max[2] - g.min[2])) * g.nz);
      return (k * g.ny + j) * g.nx + i;
    };
    expect(dapi[idx(cx, cy, cz)]).toBeGreaterThan(5);
    expect(dapi[idx(cx + 9, cy, cz)]).toBe(0);
    expect(mask[idx(cx + 7, cy, 1)]).toBeGreaterThan(0);
    const packed = pack(new Float32Array(n).fill(36), new Float32Array(n), dapi, mask);
    expect(decode(packed[1])).toBeGreaterThan(33);
    expect(decode(packed[1])).toBeLessThan(39);
    // Generous bound for CI machines; the spec target (<500 ms on an M1) is for the whole rebuild.
    expect(ms).toBeLessThan(4000);
  });
});
