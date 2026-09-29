import { describe, expect, it } from 'vitest';
import {
  approxTm,
  GC_MAX,
  GC_MIN,
  PROBE_LENGTH,
  PROBE_MIN_GAP,
  PROBES_MAX,
  reverseComplementDna,
  type Probe,
} from '../../src/data/probes';
import { getRegion } from '../../src/data/transcript';
import { buildWorld } from '../../src/data/model';

const world = buildWorld();
const { design } = world;
const tx = world.transcript;

function noOverlap(probes: Probe[]) {
  const sorted = [...probes].sort((a, b) => a.targetStart - b.targetStart);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].targetStart - sorted[i - 1].targetEnd).toBeGreaterThanOrEqual(PROBE_MIN_GAP);
  }
}

describe('reverse complement', () => {
  it('complements RNA into DNA, reversed', () => {
    expect(reverseComplementDna('AUGC')).toBe('GCAT');
    expect(reverseComplementDna('AAAUUUGGGCCC')).toBe('GGGCCCAAATTT');
  });
  it('probe pairs with its target antiparallel', () => {
    const p = design.cds[0];
    const pair: Record<string, string> = { A: 'U', T: 'A', G: 'C', C: 'G' };
    // probe 5′→3′ read against target 3′→5′
    for (let j = 0; j < PROBE_LENGTH; j++) {
      expect(pair[p.seq[j]]).toBe(p.target[PROBE_LENGTH - 1 - j]);
    }
  });
});

describe('probe design', () => {
  it('supplies the maximum set size for both sets', () => {
    expect(design.cds).toHaveLength(PROBES_MAX);
    expect(design.distal).toHaveLength(PROBES_MAX);
  });

  it('uses 18-nt probes with GC 40–60%', () => {
    for (const p of design.all) {
      expect(p.seq).toHaveLength(PROBE_LENGTH);
      expect(p.gc).toBeGreaterThanOrEqual(GC_MIN - 1e-9);
      expect(p.gc).toBeLessThanOrEqual(GC_MAX + 1e-9);
      expect(p.seq).toBe(reverseComplementDna(tx.long.seq.slice(p.targetStart, p.targetEnd)));
    }
  });

  it('keeps probes ≥2 nt apart with no overlaps, within and across sets', () => {
    noOverlap(design.cds);
    noOverlap(design.distal);
    noOverlap(design.all);
  });

  it('puts CDS probes in the CDS and distal probes only in the extended 3′UTR', () => {
    const cds = getRegion(tx.long, 'cds')!;
    const ext = getRegion(tx.long, 'utr3ext')!;
    for (const p of design.cds) {
      expect(p.targetStart).toBeGreaterThanOrEqual(cds.start);
      expect(p.targetEnd).toBeLessThanOrEqual(cds.end);
    }
    for (const p of design.distal) {
      expect(p.targetStart).toBeGreaterThanOrEqual(ext.start);
      expect(p.targetEnd).toBeLessThanOrEqual(ext.end);
    }
  });

  it('distal targets do not exist on the short isoform', () => {
    expect(world.short.sites.every((s) => s.probe.set === 'cds')).toBe(true);
    expect(world.short.sites).toHaveLength(PROBES_MAX);
    expect(world.long.sites).toHaveLength(2 * PROBES_MAX);
    for (const p of design.distal) expect(p.targetStart).toBeGreaterThanOrEqual(tx.short.length - 150);
  });

  it('ranks CDS probes as a cluster growing from the CDS centre', () => {
    const cds = getRegion(tx.long, 'cds')!;
    const centre = (cds.start + cds.end) / 2;
    const d = design.cds.map((p) => Math.abs((p.targetStart + p.targetEnd) / 2 - centre));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
  });

  it('ranks distal probes from the poly(A) end', () => {
    for (let i = 1; i < design.distal.length; i++) {
      expect(design.distal[i].targetStart).toBeLessThan(design.distal[i - 1].targetStart);
    }
  });

  it('gives plausible approximate Tm values', () => {
    expect(approxTm('ACGTACGTACGTACGTAC')).toBeGreaterThan(50);
    expect(approxTm('ACGTACGTACGTACGTAC')).toBeLessThan(70);
    for (const p of design.all) expect(p.dye).toBe(p.set === 'cds' ? 'af647' : 'af546');
  });
});
