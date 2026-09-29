import { describe, expect, it } from 'vitest';
import { gcFraction, getRegion, PAS, PAS_TO_CLEAVAGE, REGION_LENGTHS, STOP_CODONS } from '../../src/data/transcript';
import { buildWorld } from '../../src/data/model';

const world = buildWorld();
const { long, short } = world.transcript;

describe('made-up transcript', () => {
  it('has the specified region lengths', () => {
    for (const [id, n] of Object.entries(REGION_LENGTHS)) {
      const r = getRegion(long, id as keyof typeof REGION_LENGTHS)!;
      expect(r.end - r.start, id).toBe(n);
    }
    expect(getRegion(short, 'utr3ext')).toBeUndefined();
    expect(short.length).toBe(120 + 1500 + 300 + 150);
    expect(long.length).toBe(120 + 1500 + 300 + 1200 + 150);
  });

  it('isoforms share everything up to the proximal cleavage site', () => {
    const cut = getRegion(short, 'utr3')!.end;
    expect(long.seq.slice(0, cut)).toBe(short.seq.slice(0, cut));
  });

  it('CDS starts with AUG, ends with UAA and has no in-frame stop codons', () => {
    const cds = getRegion(long, 'cds')!;
    const s = long.seq.slice(cds.start, cds.end);
    expect(s.slice(0, 3)).toBe('AUG');
    expect(s.slice(-3)).toBe('UAA');
    for (let i = 3; i < s.length - 3; i += 3) {
      expect(STOP_CODONS).not.toContain(s.slice(i, i + 3));
    }
  });

  it('has AAUAAA ~20 nt upstream of both cleavage sites and nowhere else', () => {
    const prox = getRegion(short, 'utr3')!.end;
    const dist = getRegion(long, 'utr3ext')!.end;
    expect(long.seq.slice(prox - PAS_TO_CLEAVAGE - 6, prox - PAS_TO_CLEAVAGE)).toBe(PAS);
    expect(long.seq.slice(dist - PAS_TO_CLEAVAGE - 6, dist - PAS_TO_CLEAVAGE)).toBe(PAS);
    const body = long.seq.slice(0, getRegion(long, 'polya')!.start);
    const hits = [...body.matchAll(/AAUAAA/g)].map((m) => m.index);
    expect(hits).toEqual([world.transcript.pasProximal, world.transcript.pasDistal]);
  });

  it('5′UTR has no upstream AUG', () => {
    const utr5 = getRegion(long, 'utr5')!;
    expect(long.seq.slice(utr5.start, utr5.end)).not.toContain('AUG');
  });

  it('ends in a 150-nt poly(A) tail', () => {
    expect(long.seq.slice(-150)).toBe('A'.repeat(150));
    expect(short.seq.slice(-150)).toBe('A'.repeat(150));
  });

  it('has overall GC content near 45–50%', () => {
    const body = long.seq.slice(0, getRegion(long, 'polya')!.start);
    const gc = gcFraction(body);
    expect(gc).toBeGreaterThan(0.43);
    expect(gc).toBeLessThan(0.52);
  });

  it('is reproducible', () => {
    expect(buildWorld().transcript.long.seq).toBe(long.seq);
  });
});
