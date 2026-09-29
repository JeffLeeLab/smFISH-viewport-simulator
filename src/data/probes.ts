/**
 * smFISH probe design (spec §4.2): 18-nt antisense DNA oligos, ≥2 nt apart, 40–60% GC.
 * Positions are designed for the maximum set size; the first N by rank are shown, so
 * changing N adds or removes probes without shuffling the others.
 */
import { gcFraction, getRegion, type Transcript } from './transcript';
import type { DyeId } from './dyes';

export type ProbeSetId = 'cds' | 'distal';

export interface Probe {
  set: ProbeSetId;
  /** 0 = shown first. */
  rank: number;
  /** Target window on the mRNA, 0-based [start, end). Same coordinates on both isoforms. */
  targetStart: number;
  targetEnd: number;
  /** Target RNA 5′→3′. */
  target: string;
  /** Probe DNA 5′→3′ (reverse complement of the target, T for U). */
  seq: string;
  gc: number;
  tm: number;
  dye: DyeId;
}

export interface ProbeSetInfo {
  id: ProbeSetId;
  name: string;
  dye: DyeId;
  bindsShort: boolean;
}

export const PROBE_LENGTH = 18;
export const PROBE_MIN_GAP = 2;
export const PROBES_MAX = 48;
export const PROBES_DEFAULT = 10;
export const GC_MIN = 0.4;
export const GC_MAX = 0.6;

export const PROBE_SETS: Record<ProbeSetId, ProbeSetInfo> = {
  cds: { id: 'cds', name: 'CDS set', dye: 'af647', bindsShort: true },
  distal: { id: 'distal', name: 'Distal 3′UTR set', dye: 'af546', bindsShort: false },
};

const DNA_COMPLEMENT: Record<string, string> = { A: 'T', U: 'A', T: 'A', G: 'C', C: 'G' };

/** Reverse complement of an RNA (or DNA) sequence, written as DNA 5′→3′. */
export function reverseComplementDna(rna: string): string {
  let out = '';
  for (let i = rna.length - 1; i >= 0; i--) out += DNA_COMPLEMENT[rna[i]] ?? 'N';
  return out;
}

/**
 * Approximate melting temperature (°C) using the basic salt-adjusted formula at 2× SSC
 * ([Na+] ≈ 0.33 M). Labelled "approx." in the UI.
 */
export function approxTm(dna: string, naMolar = 0.33): number {
  const n = dna.length;
  const gcPct = gcFraction(dna) * 100;
  return 81.5 + 16.6 * Math.log10(naMolar) + 0.41 * gcPct - 600 / n;
}

function windowOk(seq: string, start: number): boolean {
  const gc = gcFraction(seq.slice(start, start + PROBE_LENGTH));
  return gc >= GC_MIN - 1e-9 && gc <= GC_MAX + 1e-9;
}

/** Greedy tiling from the 5′ end of [start, end). Returns window start positions. */
function tileForward(seq: string, start: number, end: number): number[] {
  const out: number[] = [];
  let pos = start;
  while (pos + PROBE_LENGTH <= end) {
    if (windowOk(seq, pos)) {
      out.push(pos);
      pos += PROBE_LENGTH + PROBE_MIN_GAP;
    } else pos++;
  }
  return out;
}

/** Greedy tiling from the 3′ end of [start, end). Returns window starts, 3′-most first. */
function tileBackward(seq: string, start: number, end: number): number[] {
  const out: number[] = [];
  let pos = end - PROBE_LENGTH;
  while (pos >= start) {
    if (windowOk(seq, pos)) {
      out.push(pos);
      pos -= PROBE_LENGTH + PROBE_MIN_GAP;
    } else pos--;
  }
  return out;
}

function makeProbe(set: ProbeSetId, rank: number, seq: string, start: number): Probe {
  const target = seq.slice(start, start + PROBE_LENGTH);
  const dna = reverseComplementDna(target);
  return {
    set,
    rank,
    targetStart: start,
    targetEnd: start + PROBE_LENGTH,
    target,
    seq: dna,
    gc: gcFraction(dna),
    tm: approxTm(dna),
    dye: PROBE_SETS[set].dye,
  };
}

export interface ProbeDesign {
  cds: Probe[];
  distal: Probe[];
  /** All probes, CDS set first. */
  all: Probe[];
}

/**
 * CDS probes tile the coding sequence and are ranked outward from its centre, so any N
 * forms one contiguous cluster. Distal probes tile the extended 3′UTR from the poly(A)
 * end, so small N cluster toward the distal cleavage site.
 */
export function designProbes(tx: Transcript): ProbeDesign {
  const seq = tx.long.seq;
  const cdsRegion = getRegion(tx.long, 'cds')!;
  const extRegion = getRegion(tx.long, 'utr3ext')!;

  const cdsWindows = tileForward(seq, cdsRegion.start, cdsRegion.end);
  const centre = (cdsRegion.start + cdsRegion.end) / 2;
  const cdsRanked = [...cdsWindows]
    .sort(
      (a, b) =>
        Math.abs(a + PROBE_LENGTH / 2 - centre) - Math.abs(b + PROBE_LENGTH / 2 - centre) ||
        a - b,
    )
    .slice(0, PROBES_MAX);
  const cds = cdsRanked.map((start, rank) => makeProbe('cds', rank, seq, start));

  const distalWindows = tileBackward(seq, extRegion.start, extRegion.end).slice(0, PROBES_MAX);
  const distal = distalWindows.map((start, rank) => makeProbe('distal', rank, seq, start));

  return { cds, distal, all: [...cds, ...distal] };
}

/** Number of windows available, used to check the design can supply PROBES_MAX. */
export function availableWindows(tx: Transcript): { cds: number; distal: number } {
  const seq = tx.long.seq;
  const cds = getRegion(tx.long, 'cds')!;
  const ext = getRegion(tx.long, 'utr3ext')!;
  return {
    cds: tileForward(seq, cds.start, cds.end).length,
    distal: tileBackward(seq, ext.start, ext.end).length,
  };
}
