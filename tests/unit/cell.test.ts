import { describe, expect, it } from 'vitest';
import {
  cellHeight,
  countSpots,
  insideCell,
  insideNucleus,
  makeCellShape,
  N_CYTO,
  N_NUCLEAR,
  resolveSpots,
  seedSpots,
} from '../../src/data/cell';
import { buildWorld } from '../../src/data/model';
import { getRegion } from '../../src/data/transcript';

const world = buildWorld();
const params = (n: number, longFraction: number) => ({
  probesPerSet: n,
  longFraction,
  cdsProbes: world.design.cds,
  distalProbes: world.design.distal,
  geneLength: getRegion(world.transcript.long, 'polya')!.start,
});

describe('cell model', () => {
  for (const seed of [1, 2, 17, 123]) {
    const shape = makeCellShape(seed);
    it(`seed ${seed}: cell ~20×15×6 µm with the nucleus inside`, () => {
      let maxH = 0;
      for (let x = -12; x <= 12; x += 0.25) for (let y = -9; y <= 9; y += 0.25) maxH = Math.max(maxH, cellHeight(shape, x, y));
      expect(maxH).toBeGreaterThan(4.5);
      expect(maxH).toBeLessThan(6.6);
      // Sample the nucleus surface: every point must be inside the cell.
      const [cx, cy, cz] = shape.nucleusCentre;
      const [a, b, c] = shape.nucleusRadii;
      for (let t = 0; t < Math.PI; t += 0.2) {
        for (let p = 0; p < 2 * Math.PI; p += 0.3) {
          const x = cx + a * 0.98 * Math.sin(t) * Math.cos(p);
          const y = cy + b * 0.98 * Math.sin(t) * Math.sin(p);
          const z = cz + c * 0.98 * Math.cos(t);
          expect(insideCell(shape, x, y, z), `${x},${y},${z}`).toBe(true);
        }
      }
      const [fx, fy, fz] = shape.featured;
      expect(insideCell(shape, fx, fy, fz, 0.3)).toBe(true);
      expect(insideNucleus(shape, fx, fy, fz)).toBe(false);
    });

    it(`seed ${seed}: places ~74 cytoplasmic and ~6 nuclear mRNAs plus 2 transcription sites`, () => {
      const seeds = seedSpots(shape);
      const cyto = seeds.filter((s) => s.kind === 'cyto' || s.kind === 'featured');
      expect(cyto).toHaveLength(N_CYTO);
      expect(seeds.filter((s) => s.kind === 'nuclear')).toHaveLength(N_NUCLEAR);
      const ts = new Set(seeds.filter((s) => s.kind === 'nascent').map((s) => s.ts));
      expect(ts.size).toBe(2);
      for (const s of cyto) {
        expect(insideCell(shape, s.x, s.y, s.z)).toBe(true);
        expect(insideNucleus(shape, s.x, s.y, s.z)).toBe(false);
      }
    });
  }

  it('counts long/short isoforms from the ratio, with the featured pair fixed', () => {
    const seeds = seedSpots(makeCellShape(1));
    const c60 = countSpots(resolveSpots(seeds, params(10, 0.6)));
    expect(c60.total).toBe(80);
    expect(c60.long / c60.total).toBeGreaterThan(0.45);
    expect(c60.long / c60.total).toBeLessThan(0.75);
    const c0 = countSpots(resolveSpots(seeds, params(10, 0)));
    expect(c0.long).toBe(1); // only the featured long isoform
    const c1 = countSpots(resolveSpots(seeds, params(10, 1)));
    expect(c1.short).toBe(1);
  });

  it('short isoforms carry only magenta probes; long carry both', () => {
    const spots = resolveSpots(seedSpots(makeCellShape(3)), params(12, 0.5));
    for (const s of spots) {
      if (s.isoform === 'short') expect([s.magenta, s.green]).toEqual([12, 0]);
      if (s.isoform === 'long') expect([s.magenta, s.green]).toEqual([12, 12]);
    }
  });

  it('transcription sites are magenta-dominant', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const spots = resolveSpots(seedSpots(makeCellShape(seed)), params(10, 0.6)).filter((s) => s.kind === 'nascent');
      const m = spots.reduce((a, s) => a + s.magenta, 0);
      const g = spots.reduce((a, s) => a + s.green, 0);
      expect(m).toBeGreaterThan(g * 1.5);
    }
  });
});
