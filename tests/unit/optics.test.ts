import { describe, expect, it } from 'vitest';
import { clampNa, IMMERSIONS, psfFwhm, snr, spotPeakPhotons, backgroundPhotons, peakPixelFraction } from '../../src/data/optics';
import { DYES } from '../../src/data/dyes';

describe('widefield Gaussian PSF (Zhang et al. 2007)', () => {
  const oil = IMMERSIONS.oil;
  it('matches the §4.4 fixtures within ±2 nm', () => {
    const a546 = psfFwhm(DYES.af546.emNm, 1.4, oil.n);
    const a647 = psfFwhm(DYES.af647.emNm, 1.4, oil.n);
    expect(Math.abs(a546.xy - 202)).toBeLessThanOrEqual(2);
    expect(Math.abs(a546.z - 688)).toBeLessThanOrEqual(2);
    expect(Math.abs(a647.xy - 236)).toBeLessThanOrEqual(2);
    expect(Math.abs(a647.z - 803)).toBeLessThanOrEqual(2);
    expect(a546.z / a546.xy).toBeCloseTo(3.4, 1);
  });

  it('keeps NA below the immersion index', () => {
    for (const imm of Object.values(IMMERSIONS)) {
      expect(clampNa(5, imm.id)).toBeLessThan(imm.n);
      expect(clampNa(0, imm.id)).toBe(imm.naMin);
      expect(imm.naDefault).toBeGreaterThanOrEqual(imm.naMin);
      expect(imm.naDefault).toBeLessThanOrEqual(imm.naMax);
    }
  });

  it('pixel fraction is a sensible fraction', () => {
    const f = peakPixelFraction(86);
    expect(f).toBeGreaterThan(0.05);
    expect(f).toBeLessThan(0.12);
  });
});

describe('signal and noise model', () => {
  const sigma = (0.21 * DYES.af546.emNm) / 1.4;
  const s = (n: number, washed = true) => snr(spotPeakPhotons(n, sigma), backgroundPhotons(washed));
  it('1–2 probes sit at or below the noise floor', () => {
    expect(s(1)).toBeLessThan(1.5);
    expect(s(2)).toBeLessThan(2.2);
  });
  it('~8–10 probes clearly stand out', () => {
    expect(s(8)).toBeGreaterThan(3.5);
    expect(s(10)).toBeGreaterThan(4);
  });
  it('washing raises SNR', () => {
    expect(s(10, false)).toBeLessThan(s(10, true));
  });
});
