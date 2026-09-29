/**
 * Widefield Gaussian PSF (Zhang et al. 2007) and the illustrative camera/noise model
 * (spec §4.4–4.5). Lengths are in nm unless stated.
 */
import type { Rng } from './rng';

export type ImmersionId = 'air' | 'water' | 'oil';

export interface Immersion {
  id: ImmersionId;
  name: string;
  n: number;
  naMin: number;
  naMax: number;
  naDefault: number;
}

export const IMMERSIONS: Record<ImmersionId, Immersion> = {
  air: { id: 'air', name: 'Air', n: 1.0, naMin: 0.3, naMax: 0.95, naDefault: 0.75 },
  water: { id: 'water', name: 'Water', n: 1.33, naMin: 0.8, naMax: 1.27, naDefault: 1.2 },
  oil: { id: 'oil', name: 'Oil', n: 1.515, naMin: 0.8, naMax: 1.49, naDefault: 1.4 },
};

export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2); // 2.3548…

export interface PsfSigma {
  /** Lateral standard deviation, nm. */
  xy: number;
  /** Axial standard deviation, nm. */
  z: number;
}

export function psfSigma(lambdaEmNm: number, na: number, n: number): PsfSigma {
  return {
    xy: (0.21 * lambdaEmNm) / na,
    z: (0.66 * lambdaEmNm * n) / (na * na),
  };
}

export function psfFwhm(lambdaEmNm: number, na: number, n: number): PsfSigma {
  const s = psfSigma(lambdaEmNm, na, n);
  return { xy: s.xy * FWHM_PER_SIGMA, z: s.z * FWHM_PER_SIGMA };
}

/** Keep NA inside the immersion preset's range (always below n). */
export function clampNa(na: number, imm: ImmersionId): number {
  const p = IMMERSIONS[imm];
  return Math.min(p.naMax, Math.max(p.naMin, na));
}

/** Camera and noise model. Illustrative numbers, not a specific instrument. */
export const CAMERA = {
  /** Back-projected pixel size: 6.5 µm sCMOS pixel behind a 100× objective. */
  pixelNm: 65,
  zStepNm: 200,
  photonsPerDye: 40,
  autofluorescence: 20,
  unboundHaze: 60,
  readNoise: 1.5,
  /** Chromatic offset of the magenta channel when the toggle is on. */
  chromaticLateralNm: 30,
  chromaticAxialNm: 100,
} as const;

export function backgroundPhotons(washed: boolean): number {
  return CAMERA.autofluorescence + (washed ? 0 : CAMERA.unboundHaze);
}

/** Fraction of one dye's photons landing in the brightest (centred, in-focus) pixel. */
export function peakPixelFraction(sigmaXyNm: number, pixelNm: number = CAMERA.pixelNm): number {
  // Exact pixel integral of a centred 2D Gaussian.
  const h = pixelNm / 2 / (Math.SQRT2 * sigmaXyNm);
  const e = erf(h);
  return e * e;
}

/** Expected in-focus peak signal (photons above background) for N co-localised dyes. */
export function spotPeakPhotons(nDyes: number, sigmaXyNm: number): number {
  return nDyes * CAMERA.photonsPerDye * peakPixelFraction(sigmaXyNm);
}

/** SNR readout (spec §4.5). */
export function snr(peak: number, background: number, read: number = CAMERA.readNoise): number {
  return peak / Math.sqrt(peak + background + read * read);
}

/** One noisy camera pixel. */
export function noisyPixel(rng: Rng, expected: number, read: number = CAMERA.readNoise): number {
  return rng.poisson(expected) + read * rng.gauss();
}

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
