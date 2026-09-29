/**
 * Cell stage model (spec §6.4), in µm. The cell sits on the coverslip (z = 0) and z is the
 * optical axis.
 */
import { Rng, hashSeed } from './rng';
import type { Probe } from './probes';

export const CELL_SEMI_A = 10; // µm, half of ~20 µm
export const CELL_SEMI_B = 7.5; // µm, half of ~15 µm
export const CELL_MAX_HEIGHT = 6;
export const NUCLEUS_RADII: [number, number, number] = [5, 4, 2];
export const N_CYTO = 150;
export const N_NUCLEAR = 10;
export const N_TS = 2;
export const DEFAULT_LONG_FRACTION = 0.6;

export interface CellShape {
  seed: number;
  harmonics: { k: number; amp: number; phase: number }[];
  nucleusCentre: [number, number, number];
  nucleusRadii: [number, number, number];
  /** Where the two featured molecules sit (their midpoint), µm. */
  featured: [number, number, number];
}

export function makeCellShape(seed: number): CellShape {
  const rng = new Rng(hashSeed(seed, 'cell'));
  const harmonics = [
    { k: 2, amp: rng.range(0.04, 0.09), phase: rng.range(0, Math.PI * 2) },
    { k: 3, amp: rng.range(0.03, 0.07), phase: rng.range(0, Math.PI * 2) },
    { k: 5, amp: rng.range(0.015, 0.035), phase: rng.range(0, Math.PI * 2) },
  ];
  const nucleusCentre: [number, number, number] = [
    rng.range(-1.8, -0.6),
    rng.range(-0.6, 0.8),
    NUCLEUS_RADII[2] + 0.45,
  ];
  const shape: CellShape = {
    seed,
    harmonics,
    nucleusCentre,
    nucleusRadii: [...NUCLEUS_RADII],
    featured: [0, 0, 0],
  };
  // Featured molecules: in the cytoplasm, between the nucleus and the +x edge.
  const fx = nucleusCentre[0] + NUCLEUS_RADII[0] + 2.1;
  const fy = nucleusCentre[1] - 1.2;
  const fz = Math.min(1.6, cellHeight(shape, fx, fy) * 0.5);
  shape.featured = [fx, fy, fz];
  return shape;
}

/** Footprint radius multiplier at polar angle α. */
function footprintScale(shape: CellShape, alpha: number): number {
  let r = 1;
  for (const h of shape.harmonics) r += h.amp * Math.cos(h.k * alpha + h.phase);
  return r;
}

/** Normalised footprint radius: < 1 inside the cell outline. */
export function footprintRho(shape: CellShape, x: number, y: number): number {
  const xn = x / CELL_SEMI_A;
  const yn = y / CELL_SEMI_B;
  const alpha = Math.atan2(yn, xn);
  return Math.hypot(xn, yn) / footprintScale(shape, alpha);
}

/** Point on the outline at polar angle α (µm). */
export function outlinePoint(shape: CellShape, alpha: number): [number, number] {
  const r = footprintScale(shape, alpha);
  return [Math.cos(alpha) * CELL_SEMI_A * r, Math.sin(alpha) * CELL_SEMI_B * r];
}

const EDGE_HEIGHT = 0.35;

/** Height of the top membrane above the coverslip (0 outside the footprint). */
export function cellHeight(shape: CellShape, x: number, y: number): number {
  const rho = footprintRho(shape, x, y);
  if (rho >= 1) return 0;
  const [nx, ny] = shape.nucleusCentre;
  const d2 = (x - nx) ** 2 + (y - ny) ** 2;
  const edge = Math.pow(1 - rho * rho, 0.3); // rounds the rim
  let h = edge * (EDGE_HEIGHT + 2.25 * Math.pow(1 - rho * rho, 0.75) + 3.1 * Math.exp(-d2 / (2 * 3.9 * 3.9)));
  // The membrane always drapes over the nucleus with a small margin.
  const [a, b, c] = shape.nucleusRadii;
  // (The cover falls away continuously outside the nucleus footprint, so there is no seam.)
  const e = ((x - nx) / a) ** 2 + ((y - ny) / b) ** 2;
  const top = shape.nucleusCentre[2] + c * Math.sqrt(Math.max(0, 1 - e)) + 0.55 - 4 * Math.max(0, e - 1);
  h = smoothMax(h, top, 0.9);
  return Math.min(CELL_MAX_HEIGHT, h);
}

function smoothMax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
}

export function insideNucleus(shape: CellShape, x: number, y: number, z: number, shrink = 1): boolean {
  const [cx, cy, cz] = shape.nucleusCentre;
  const [a, b, c] = shape.nucleusRadii;
  return ((x - cx) / (a * shrink)) ** 2 + ((y - cy) / (b * shrink)) ** 2 + ((z - cz) / (c * shrink)) ** 2 < 1;
}

export function insideCell(shape: CellShape, x: number, y: number, z: number, margin = 0): boolean {
  if (z < margin) return false;
  return z < cellHeight(shape, x, y) - margin;
}

// ---------------------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------------------

export type SpotKind = 'featured' | 'cyto' | 'nuclear' | 'nascent';

export interface SpotSeed {
  x: number;
  y: number;
  z: number;
  kind: SpotKind;
  /** Uniform draw compared with the long-isoform fraction. */
  u: number;
  /** Fixed isoform (featured molecules only). */
  isoform?: 'long' | 'short';
  /** Transcription progress along the gene, 0–1 (nascent only). */
  progress?: number;
  /** Transcription site index (nascent only). */
  ts?: number;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  kind: SpotKind;
  isoform: 'long' | 'short' | 'nascent';
  green: number;
  magenta: number;
}

/** Positions and random draws for every RNA in the cell; independent of N and the ratio. */
export function seedSpots(shape: CellShape): SpotSeed[] {
  const rng = new Rng(hashSeed(shape.seed, 'spots'));
  const out: SpotSeed[] = [];
  const [fx, fy, fz] = shape.featured;
  out.push({ x: fx - 0.35, y: fy, z: fz, kind: 'featured', u: 0, isoform: 'long' });
  out.push({ x: fx + 0.35, y: fy, z: fz, kind: 'featured', u: 1, isoform: 'short' });

  const [nx, ny] = shape.nucleusCentre;
  let guard = 0;
  while (out.length < N_CYTO && guard++ < 200000) {
    const x = rng.range(-CELL_SEMI_A * 1.15, CELL_SEMI_A * 1.15);
    const y = rng.range(-CELL_SEMI_B * 1.15, CELL_SEMI_B * 1.15);
    const h = cellHeight(shape, x, y);
    if (h < 0.6) continue;
    const z = rng.range(0.25, h - 0.25);
    if (insideNucleus(shape, x, y, z, 1.08)) continue;
    // Mild perinuclear enrichment, as often seen for cytoplasmic mRNAs.
    const d = Math.hypot(x - nx, y - ny);
    if (rng.next() > 0.35 + 0.65 * Math.exp(-Math.max(0, d - 4) / 5)) continue;
    // Keep clear of the featured pair so the stage 3 view shows just those two.
    if (Math.hypot(x - fx, y - fy, z - fz) < 2.6) continue;
    out.push({ x, y, z, kind: 'cyto', u: rng.next() });
  }

  guard = 0;
  let nuclear = 0;
  const [cx, cy, cz] = shape.nucleusCentre;
  const [ra, rb, rc] = shape.nucleusRadii;
  while (nuclear < N_NUCLEAR && guard++ < 100000) {
    const x = cx + rng.range(-ra, ra);
    const y = cy + rng.range(-rb, rb);
    const z = cz + rng.range(-rc, rc);
    if (!insideNucleus(shape, x, y, z, 0.85)) continue;
    out.push({ x, y, z, kind: 'nuclear', u: rng.next() });
    nuclear++;
  }

  // Transcription sites: tight clusters of nascent RNAs at various stages of completion.
  const sites: [number, number, number][] = [];
  guard = 0;
  while (sites.length < N_TS && guard++ < 10000) {
    const x = cx + rng.range(-ra, ra) * 0.6;
    const y = cy + rng.range(-rb, rb) * 0.6;
    const z = cz + rng.range(-rc, rc) * 0.4;
    if (!insideNucleus(shape, x, y, z, 0.6)) continue;
    if (sites.some((s) => Math.hypot(s[0] - x, s[1] - y) < 2.5)) continue;
    sites.push([x, y, z]);
  }
  sites.forEach((s, ts) => {
    const n = 8 + rng.int(8);
    for (let i = 0; i < n; i++) {
      // ~20% are complete but not yet released; the rest are still being transcribed.
      const progress = rng.next() < 0.2 ? 1 : rng.next();
      out.push({
        x: s[0] + rng.gauss() * 0.05,
        y: s[1] + rng.gauss() * 0.05,
        z: s[2] + rng.gauss() * 0.07,
        kind: 'nascent',
        u: rng.next(),
        progress,
        ts,
      });
    }
  });
  return out;
}

export interface SpotParams {
  probesPerSet: number;
  longFraction: number;
  cdsProbes: readonly Probe[];
  distalProbes: readonly Probe[];
  /** Transcribed length of the gene body (nt) used to judge which probes a nascent RNA has. */
  geneLength: number;
}

export function resolveSpots(seeds: readonly SpotSeed[], p: SpotParams): Spot[] {
  const n = p.probesPerSet;
  const cds = p.cdsProbes.slice(0, n);
  const distal = p.distalProbes.slice(0, n);
  return seeds.map((s) => {
    if (s.kind === 'nascent') {
      const reached = (s.progress ?? 0) * p.geneLength;
      return {
        x: s.x,
        y: s.y,
        z: s.z,
        kind: s.kind,
        isoform: 'nascent',
        magenta: cds.filter((q) => q.targetEnd <= reached).length,
        green: distal.filter((q) => q.targetEnd <= reached).length,
      };
    }
    const isoform = s.isoform ?? (s.u < p.longFraction ? 'long' : 'short');
    return {
      x: s.x,
      y: s.y,
      z: s.z,
      kind: s.kind,
      isoform,
      magenta: cds.length,
      green: isoform === 'long' ? distal.length : 0,
    };
  });
}

export interface SpotCounts {
  total: number;
  long: number;
  short: number;
  transcriptionSites: number;
}

export function countSpots(spots: readonly Spot[]): SpotCounts {
  let long = 0;
  let short = 0;
  for (const s of spots) {
    if (s.isoform === 'long') long++;
    else if (s.isoform === 'short') short++;
  }
  const hasTs = spots.some((s) => s.kind === 'nascent');
  return { total: long + short, long, short, transcriptionSites: hasTs ? N_TS : 0 };
}
