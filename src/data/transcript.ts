/**
 * Made-up teaching transcript (spec §4.1). Everything is generated from a seed, so the
 * sequence is reproducible but not a real gene.
 */
import { Rng } from './rng';

export type RegionId = 'utr5' | 'cds' | 'utr3' | 'utr3ext' | 'polya';
export type IsoformId = 'long' | 'short';

export interface Region {
  id: RegionId;
  name: string;
  /** 0-based, inclusive. */
  start: number;
  /** 0-based, exclusive. */
  end: number;
}

export interface Isoform {
  id: IsoformId;
  seq: string;
  regions: Region[];
  length: number;
}

export interface Transcript {
  long: Isoform;
  short: Isoform;
  /** Start of the proximal AAUAAA (same coordinate on both isoforms). */
  pasProximal: number;
  /** Start of the distal AAUAAA (long isoform only). */
  pasDistal: number;
}

export const REGION_LENGTHS = {
  utr5: 120,
  cds: 1500,
  utr3: 300,
  utr3ext: 1200,
  polya: 150,
} as const;

export const REGION_NAMES: Record<RegionId, string> = {
  utr5: '5′UTR',
  cds: 'CDS',
  utr3: '3′UTR',
  utr3ext: 'Extended 3′UTR',
  polya: 'Poly(A) tail',
};

export const PAS = 'AAUAAA';
/** Nucleotides between the end of AAUAAA and the cleavage site. */
export const PAS_TO_CLEAVAGE = 20;
export const STOP_CODONS = ['UAA', 'UAG', 'UGA'];

const BASES = ['A', 'U', 'G', 'C'] as const;
/** Slight AU bias gives ~48% GC overall. */
const BASE_WEIGHTS = [0.26, 0.26, 0.24, 0.24];

function randomBase(rng: Rng): string {
  return rng.weighted(BASES, BASE_WEIGHTS);
}

/** True if any forbidden motif ends within the last `window` characters of `s`. */
function endsWithForbidden(s: string, forbidden: readonly string[], window = 1): boolean {
  for (const motif of forbidden) {
    const from = Math.max(0, s.length - motif.length - window + 1);
    if (s.indexOf(motif, from) !== -1) return true;
  }
  return false;
}

/** Append `n` random bases to `prefix`, re-rolling any base that would create a forbidden motif. */
function randomSegment(rng: Rng, prefix: string, n: number, forbidden: readonly string[]): string {
  let s = prefix;
  for (let i = 0; i < n; i++) {
    let tries = 0;
    let candidate: string;
    do {
      candidate = s + randomBase(rng);
      tries++;
    } while (endsWithForbidden(candidate, forbidden) && tries < 50);
    s = candidate;
  }
  return s.slice(prefix.length);
}

function randomCds(rng: Rng, prefix: string, length: number): string {
  const codons = length / 3;
  let s = prefix + 'AUG';
  for (let c = 1; c < codons - 1; c++) {
    let codon: string;
    let tries = 0;
    do {
      codon = randomBase(rng) + randomBase(rng) + randomBase(rng);
      tries++;
    } while (
      (STOP_CODONS.includes(codon) || endsWithForbidden(s + codon, [PAS], 3)) &&
      tries < 200
    );
    s += codon;
  }
  s += 'UAA';
  return s.slice(prefix.length);
}

export function generateTranscript(seed: number): Transcript {
  const rng = new Rng(seed);
  const L = REGION_LENGTHS;

  // 5′UTR: no upstream AUG and no stray polyadenylation signals.
  let seq = '';
  seq += randomSegment(rng, seq, L.utr5, ['AUG', PAS]);
  const cdsStart = seq.length;
  seq += randomCds(rng, seq, L.cds);

  // Common 3′UTR: random body, then AAUAAA ~20 nt upstream of the proximal cleavage site.
  const utr3Start = seq.length;
  const bodyCommon = L.utr3 - PAS.length - PAS_TO_CLEAVAGE;
  seq += randomSegment(rng, seq, bodyCommon, [PAS]);
  const pasProximal = seq.length;
  seq += PAS;
  seq += randomSegment(rng, seq, PAS_TO_CLEAVAGE, [PAS]);
  const proximalCleavage = seq.length;

  // Extended 3′UTR (long isoform only).
  const bodyExt = L.utr3ext - PAS.length - PAS_TO_CLEAVAGE;
  let ext = randomSegment(rng, seq, bodyExt, [PAS]);
  const pasDistal = proximalCleavage + ext.length;
  ext += PAS;
  ext += randomSegment(rng, seq + ext, PAS_TO_CLEAVAGE, [PAS]);

  const polyA = 'A'.repeat(L.polya);

  const shared: Region[] = [
    { id: 'utr5', name: REGION_NAMES.utr5, start: 0, end: cdsStart },
    { id: 'cds', name: REGION_NAMES.cds, start: cdsStart, end: utr3Start },
    { id: 'utr3', name: REGION_NAMES.utr3, start: utr3Start, end: proximalCleavage },
  ];

  const shortSeq = seq + polyA;
  const short: Isoform = {
    id: 'short',
    seq: shortSeq,
    length: shortSeq.length,
    regions: [
      ...shared,
      { id: 'polya', name: REGION_NAMES.polya, start: proximalCleavage, end: shortSeq.length },
    ],
  };

  const longSeq = seq + ext + polyA;
  const distalCleavage = proximalCleavage + ext.length;
  const long: Isoform = {
    id: 'long',
    seq: longSeq,
    length: longSeq.length,
    regions: [
      ...shared,
      { id: 'utr3ext', name: REGION_NAMES.utr3ext, start: proximalCleavage, end: distalCleavage },
      { id: 'polya', name: REGION_NAMES.polya, start: distalCleavage, end: longSeq.length },
    ],
  };

  return { long, short, pasProximal, pasDistal };
}

export function regionOf(iso: Isoform, nt: number): Region {
  for (const r of iso.regions) if (nt >= r.start && nt < r.end) return r;
  return iso.regions[iso.regions.length - 1];
}

export function getRegion(iso: Isoform, id: RegionId): Region | undefined {
  return iso.regions.find((r) => r.id === id);
}

export function gcFraction(s: string): number {
  let gc = 0;
  for (const c of s) if (c === 'G' || c === 'C') gc++;
  return s.length ? gc / s.length : 0;
}
