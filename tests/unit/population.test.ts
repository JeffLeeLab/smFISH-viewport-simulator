import { describe, expect, it } from 'vitest';
import { buildWorld, placePoint, rotate } from '../../src/data/model';
import { makeCellShape, countSpots, resolveSpots } from '../../src/data/cell';
import { makeRecords, recordDyes, recordKind, recordModel } from '../../src/data/population';
import { getRegion } from '../../src/data/transcript';

const world = buildWorld();
const shape = makeCellShape(1);
const records = makeRecords(shape);

describe('cell population', () => {
  it('gives every RNA a record with a unique key and a unit rotation', () => {
    expect(new Set(records.map((r) => r.key)).size).toBe(records.length);
    for (const r of records) expect(Math.hypot(...r.rot)).toBeCloseTo(1, 6);
    expect(records.filter((r) => r.kind === 'featured').map((r) => r.key).sort()).toEqual(['featured-long', 'featured-short']);
  });

  it('resolves isoforms consistently with the spot counts', () => {
    const lf = 0.6;
    const counts = countSpots(
      resolveSpots(records, {
        probesPerSet: 10,
        longFraction: lf,
        cdsProbes: world.design.cds,
        distalProbes: world.design.distal,
        geneLength: getRegion(world.transcript.long, 'polya')!.start,
      }),
    );
    expect(records.filter((r) => recordKind(r, lf) === 'long').length).toBe(counts.long);
    expect(records.filter((r) => recordKind(r, lf) === 'short').length).toBe(counts.short);
  });

  it('places each molecule’s dyes around its record position', () => {
    for (const r of records.slice(0, 40)) {
      const dyes = recordDyes(world.library, r, 10, 0, 0.6);
      const kind = recordKind(r, 0.6);
      if (kind === 'short') expect(dyes.every((d) => d.set === 'cds')).toBe(true);
      for (const d of dyes) expect(Math.hypot(d.pos[0] - r.x, d.pos[1] - r.y, d.pos[2] - r.z)).toBeLessThan(0.3);
    }
  });

  it('nascent RNAs are prefixes of a long-isoform chain with only transcribed probes', () => {
    const r = records.find((x) => x.kind === 'nascent' && (x.progress ?? 0) < 0.5)!;
    const m = recordModel(world.library, r, 0.6);
    expect(m.kind).toBe('nascent');
    expect(m.sites.every((s) => s.probe.targetEnd <= m.isoform.length)).toBe(true);
    const parent = world.library.get('long', r.variant);
    expect(Array.from(m.chain.rest.slice(0, 30))).toEqual(Array.from(parent.chain.rest.slice(0, 30)));
  });

  it('placement is a rigid transform', () => {
    const m = world.long;
    const pl = { centre: [1, 2, 3] as [number, number, number], rot: records[5].rot };
    const a = placePoint(m, pl, [0, 0, 0]);
    const b = placePoint(m, pl, [10, 0, 0]);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(10, 6);
    const v = rotate(pl.rot, [0, 0, 1]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });
});
