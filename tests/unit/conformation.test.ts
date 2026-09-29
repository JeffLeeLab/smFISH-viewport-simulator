import { describe, expect, it } from 'vitest';
import { buildWorld, featuredPlacement } from '../../src/data/model';
import {
  computePose,
  HYBRID_RISE,
  NT_RISE_SS,
  SS_HELIX_RADIUS,
  SS_HELIX_RISE,
  partnerPosition,
  dyePosition,
  vec,
  type Vec3,
} from '../../src/data/conformation';

const world = buildWorld();

function at(a: Float32Array, i: number): Vec3 {
  return [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
}

describe('mRNA coil', () => {
  it('has ~0.6 nm of backbone per nt', () => {
    const { chain } = world.long;
    for (let i = 0; i < chain.length - 1; i += 97) {
      expect(Math.abs(vec.len(vec.sub(at(chain.rest, i + 1), at(chain.rest, i))) - NT_RISE_SS)).toBeLessThan(0.03);
    }
  });

  it('winds into a right-handed helix around its axis (~11 nt per turn)', () => {
    const { chain } = world.long;
    const A = chain.axis;
    for (let i = 100; i < 1500; i += 131) {
      const r0 = vec.sub(at(chain.rest, i), at(A, i));
      const r1 = vec.sub(at(chain.rest, i + 1), at(A, i + 1));
      const t = vec.norm(vec.sub(at(A, i + 1), at(A, i)));
      expect(vec.len(r0)).toBeCloseTo(SS_HELIX_RADIUS, 1);
      expect(vec.len(vec.sub(at(A, i + 1), at(A, i)))).toBeCloseTo(SS_HELIX_RISE, 2);
      // Turning ~33° per nt, anticlockwise looking down the axis from the 3′ end.
      const turn = Math.atan2(vec.dot(vec.cross(r0, r1), t), vec.dot(r0, r1));
      expect(turn).toBeGreaterThan(0.45);
      expect(turn).toBeLessThan(0.7);
    }
  });

  it('is a compact folded strand of a few long rows', () => {
    for (const m of [world.long, world.short]) {
      const r = m.chain.rest;
      const ext = [0, 1, 2].map((c) => {
        let lo = Infinity,
          hi = -Infinity;
        // Ignore the poly(A) tail, which curls off the end.
        const body = m.isoform.regions.find((x) => x.id === 'polya')!.start;
        for (let i = 0; i < body; i++) {
          lo = Math.min(lo, r[i * 3 + c]);
          hi = Math.max(hi, r[i * 3 + c]);
        }
        return hi - lo;
      });
      expect(ext[0]).toBeGreaterThan(250);
      expect(ext[0]).toBeLessThan(420);
      expect(ext[1]).toBeGreaterThan(20);
      expect(ext[1]).toBeLessThan(120);
      expect(ext[2]).toBeLessThan(20); // nearly flat, so the order reads clearly
    }
  });

  it('never crosses itself (strands stay apart)', () => {
    const r = world.long.chain.rest;
    const L = world.long.chain.length;
    let min = Infinity;
    for (let i = 0; i < L; i += 5) {
      for (let j = i + 120; j < L; j += 5) {
        const d = Math.hypot(r[i * 3] - r[j * 3], r[i * 3 + 1] - r[j * 3 + 1], r[i * 3 + 2] - r[j * 3 + 2]);
        min = Math.min(min, d);
      }
    }
    expect(min).toBeGreaterThan(8);
  });

  it('keeps the CDS and distal-3′UTR probe clusters within one diffraction-limited spot', () => {
    for (const [v, h] of [[0, 0], [0, 1], [1, 1], [2, 1], [3, 1]]) {
      const dyes = world.library.boundDyes(world.library.get('long', v), 10, h);
      const c = (set: string) => {
        const d = dyes.filter((x) => x.set === set);
        return [0, 1, 2].map((k) => d.reduce((a, x) => a + x.pos[k], 0) / d.length);
      };
      const a = c('cds');
      const b = c('distal');
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `variant ${v}`).toBeLessThan(130);
    }
  });

  it('places the two featured molecules ~700 nm apart', () => {
    expect(featuredPlacement('short').centre[0] - featuredPlacement('long').centre[0]).toBe(700);
  });
});

describe('hybridised pose', () => {
  const m = world.long;
  const L = m.chain.length;
  const zip = new Float32Array(L);
  const site = m.sites[0];
  for (let nt = site.probe.targetStart; nt < site.probe.targetEnd; nt++) zip[nt] = 1;

  it('unbound pose equals the rest coil', () => {
    const out = new Float32Array(L * 3);
    computePose(m.chain, m.sites.map((s) => s.frame), m.siteOf, new Float32Array(L), 0, out);
    for (let i = 0; i < L * 3; i += 301) expect(out[i]).toBeCloseTo(m.chain.rest[i], 3);
  });

  it('barely disturbs the strand when a probe binds in helical mode', () => {
    const out = new Float32Array(L * 3);
    computePose(m.chain, m.sites.map((s) => s.frame), m.siteOf, zip, 1, out);
    // The hybrid continues the strand's own helix, so the rest of the chain hardly moves.
    const far = site.probe.targetEnd + 200;
    expect(vec.len(vec.sub(at(out, far), at(m.chain.rest, far)))).toBeLessThan(2);
  });

  it('straightens a bound site to the helical rise', () => {
    const out = new Float32Array(L * 3);
    computePose(m.chain, m.sites.map((s) => s.frame), m.siteOf, zip, 1, out);
    const a = at(out, site.probe.targetStart);
    const b = at(out, site.probe.targetEnd - 1);
    const axial = vec.dot(vec.sub(b, a), site.frame.u);
    expect(axial).toBeCloseTo(17 * HYBRID_RISE, 3);
  });

  it('puts the dye on the probe 3′ end, at the mRNA-5′ side of the site', () => {
    const out = new Float32Array(L * 3);
    computePose(m.chain, m.sites.map((s) => s.frame), m.siteOf, zip, 0, out);
    const f = site.frame;
    const p5 = at(out, f.start); // mRNA 5′-most nt of the site pairs with the probe 3′ end
    const probe3 = partnerPosition(f, 0, 0, p5);
    const dye = dyePosition(f, 0, probe3);
    const siteMid = at(out, f.start + 9);
    expect(vec.dot(vec.sub(dye, siteMid), f.u)).toBeLessThan(0);
  });
});
