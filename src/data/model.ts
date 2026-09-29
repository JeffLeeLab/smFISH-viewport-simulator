/**
 * The shared world model. Molecular coordinates (nm) are the single source of truth for
 * fluorophore positions; the optical and cell scenes read from here.
 *
 * A molecule *model* (sequence, chain shape, probe sites) lives in its own local frame with
 * the chain's anchor at the origin. Where it sits in the world is a separate *placement*
 * (centre + rotation), so every RNA in the cell can reuse one of a few shape variants.
 */
import { generateTranscript, getRegion, type Isoform, type IsoformId, type Region, type Transcript } from './transcript';
import { availableWindows, designProbes, PROBES_MAX, type Probe, type ProbeDesign, type ProbeSetId } from './probes';
import {
  computePose,
  dyePosition,
  generateChain,
  SS_HELIX_RISE,
  partnerPosition,
  siteFrame,
  vec,
  type Chain,
  type SiteFrame,
  type Vec3,
} from './conformation';
import { hashSeed } from './rng';

export const TRANSCRIPT_SEED = 1998; // Femino et al. — the year smFISH was introduced.
/** Distance between the two featured molecules (nm). */
export const MOLECULE_SEPARATION = 700;
/** Shape variants per isoform used across the cell population. */
export const VARIANTS = 4;

export type MoleculeKind = IsoformId | 'nascent';

export interface Site {
  probe: Probe;
  frame: SiteFrame;
}

export interface MoleculeModel {
  key: string;
  kind: MoleculeKind;
  isoform: Isoform;
  chain: Chain;
  /** Probes whose target exists on this molecule. */
  sites: Site[];
  /** Site index for each nt (−1 if none). */
  siteOf: Int32Array;
}

/** Quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];

export interface Placement {
  /** Where the coil's centroid goes (units of the caller's frame). */
  centre: Vec3;
  rot: Quat;
}

/** A fluorophore on a fully bound probe, in the model's anchor frame (nm). */
export interface LocalDye {
  pos: Vec3;
  set: ProbeSetId;
  probe: Probe;
}

/** Try successive seeds until both probe sets can be designed at full size. */
function findTranscript(seed: number): Transcript {
  for (let attempt = 0; attempt < 64; attempt++) {
    const tx = generateTranscript(hashSeed(seed, attempt));
    const w = availableWindows(tx);
    if (w.cds >= PROBES_MAX && w.distal >= PROBES_MAX) return tx;
  }
  throw new Error('Could not design a full probe set');
}

function sitesFor(isoform: Isoform, chain: Chain, design: ProbeDesign, allowDistal: boolean): { sites: Site[]; siteOf: Int32Array } {
  const sites = design.all
    .filter((p) => (allowDistal || p.set === 'cds') && p.targetEnd <= isoform.length && isoform.seq.slice(p.targetStart, p.targetEnd) === p.target)
    .map((probe) => ({ probe, frame: siteFrame(chain, probe.targetStart, probe.targetEnd - probe.targetStart) }));
  const siteOf = new Int32Array(isoform.length).fill(-1);
  sites.forEach((s, i) => {
    for (let nt = s.probe.targetStart; nt < s.probe.targetEnd; nt++) siteOf[nt] = i;
  });
  return { sites, siteOf };
}

/** Rotate v by quaternion q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 q × v; v' = v + w t + q × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Local (anchor-frame) point → placed point: centre + R (p − centroid) · scale. */
export function placePoint(model: MoleculeModel, pl: Placement, p: Vec3, scale = 1): Vec3 {
  const c = model.chain.centroid;
  const r = rotate(pl.rot, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  return [pl.centre[0] + r[0] * scale, pl.centre[1] + r[1] * scale, pl.centre[2] + r[2] * scale];
}

/**
 * Rotation that turns the molecule's plane (local x–y) to face a viewing direction, with its
 * rows running horizontally on screen.
 */
export function facingRotation(dir: Vec3): Quat {
  const n = vec.norm(dir);
  let x = vec.cross([0, 0, 1], n);
  x = vec.len(x) < 1e-6 ? [1, 0, 0] : vec.norm(x);
  const y = vec.cross(n, x);
  // Rotation matrix with columns x, y, n → quaternion.
  const m = [x[0], y[0], n[0], x[1], y[1], n[1], x[2], y[2], n[2]];
  const tr = m[0] + m[4] + m[8];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, s / 4];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s, (m[2] - m[6]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4, (m[3] - m[1]) / s];
  }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Direction the featured molecules face: toward the stage 1 camera. */
export const FEATURED_FACING: Vec3 = [0.35, -0.8, 0.62];

/** Placement of a featured molecule in the molecular scene (nm, origin at their midpoint). */
export function featuredPlacement(id: IsoformId): Placement {
  const x = (id === 'long' ? -1 : 1) * (MOLECULE_SEPARATION / 2);
  return { centre: [x, 0, 0], rot: facingRotation(FEATURED_FACING) };
}

/** Shape variants for each isoform, nascent prefixes, and cached bound-dye positions. */
export class MoleculeLibrary {
  private cache = new Map<string, MoleculeModel>();
  private dyeCache = new Map<string, LocalDye[]>();

  constructor(
    readonly transcript: Transcript,
    readonly design: ProbeDesign,
    private seed: number,
  ) {}

  get(kind: IsoformId, variant: number): MoleculeModel {
    const key = `${kind}:${variant}`;
    let m = this.cache.get(key);
    if (m) return m;
    const isoform = this.transcript[kind];
    const cds = getRegion(isoform, 'cds')!;
    const polyA = getRegion(isoform, 'polya')!;
    const anchor = Math.floor((cds.start + cds.end) / 2);
    let rowPitch: number | undefined;
    if (kind === 'long') {
      // Stack the CDS probe cluster (around the anchor) and the distal probe cluster two
      // rows apart in same-direction rows, so both colours fall in one spot.
      const d = this.design.distal[Math.min(11, this.design.distal.length - 1)];
      rowPitch = (((d.targetStart + d.targetEnd) / 2 - anchor) * SS_HELIX_RISE) / 2;
    }
    const chain = generateChain({
      length: isoform.length,
      seed: variant === 0 ? hashSeed(this.seed, `${kind}-coil`) : hashSeed(this.seed, kind, variant),
      flexibleFrom: polyA.start,
      anchor,
      rowPitch,
    });
    const { sites, siteOf } = sitesFor(isoform, chain, this.design, kind === 'long');
    m = { key, kind, isoform, chain, sites, siteOf };
    this.cache.set(key, m);
    return m;
  }

  /**
   * A nascent transcript: the first `length` nt of a long-isoform variant (still being made
   * at a transcription site). Its chain is a prefix of the parent's, in the parent's frame.
   */
  nascent(variant: number, length: number): MoleculeModel {
    const parent = this.get('long', variant);
    const L = Math.max(40, Math.min(parent.isoform.length, Math.round(length / 10) * 10));
    const key = `nascent:${variant}:${L}`;
    let m = this.cache.get(key);
    if (m) return m;
    const pc = parent.chain;
    const rest = pc.rest.slice(0, L * 3);
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < L; i++) {
      cx += rest[i * 3];
      cy += rest[i * 3 + 1];
      cz += rest[i * 3 + 2];
    }
    const chain: Chain = {
      length: L,
      anchor: Math.min(pc.anchor, L - 1),
      rest,
      axis: pc.axis.slice(0, L * 3),
      step0: pc.step0.slice(0, (L - 1) * 3),
      baseDir0: pc.baseDir0.slice(0, L * 3),
      centroid: [cx / L, cy / L, cz / L],
    };
    const regions: Region[] = parent.isoform.regions
      .filter((r) => r.start < L)
      .map((r) => ({ ...r, end: Math.min(r.end, L) }));
    const isoform: Isoform = { id: 'long', seq: parent.isoform.seq.slice(0, L), regions, length: L };
    const { sites, siteOf } = sitesFor(isoform, chain, this.design, true);
    m = { key, kind: 'nascent', isoform, chain, sites, siteOf };
    this.cache.set(key, m);
    return m;
  }

  /**
   * Fluorophore positions (anchor frame, nm) with the first `n` probes of each set fully
   * bound. `h` blends schematic (0) → helical (1) duplex geometry.
   */
  boundDyes(model: MoleculeModel, n: number, h: number): LocalDye[] {
    const hk = Math.round(h * 20) / 20;
    if (model.kind === 'nascent') {
      // Same pose as the parent; keep the dyes whose targets have been transcribed.
      const variant = Number(model.key.split(':')[1]);
      const parent = this.get('long', variant);
      return this.boundDyes(parent, n, hk).filter((d) => d.probe.targetEnd <= model.isoform.length);
    }
    const key = `${model.key}|${n}|${hk}`;
    let out = this.dyeCache.get(key);
    if (out) return out;
    const L = model.chain.length;
    const zip = new Float32Array(L);
    for (const s of model.sites) {
      if (s.probe.rank >= n) continue;
      for (let k = 0; k < s.frame.length; k++) zip[s.frame.start + k] = 1;
    }
    const pose = new Float32Array(L * 3);
    computePose(model.chain, model.sites.map((s) => s.frame), model.siteOf, zip, hk, pose);
    out = [];
    for (const s of model.sites) {
      if (s.probe.rank >= n) continue;
      const f = s.frame;
      const i = f.start;
      const p3 = partnerPosition(f, 0, hk, [pose[i * 3], pose[i * 3 + 1], pose[i * 3 + 2]]);
      out.push({ pos: dyePosition(f, hk, p3), set: s.probe.set, probe: s.probe });
    }
    if (this.dyeCache.size > 200) this.dyeCache.clear();
    this.dyeCache.set(key, out);
    return out;
  }
}

export interface WorldModel {
  transcript: Transcript;
  design: ProbeDesign;
  library: MoleculeLibrary;
  /** The two featured molecules (variant 0 of each isoform). */
  long: MoleculeModel;
  short: MoleculeModel;
}

export function buildWorld(seed = TRANSCRIPT_SEED): WorldModel {
  const transcript = findTranscript(seed);
  const design = designProbes(transcript);
  const library = new MoleculeLibrary(transcript, design, seed);
  return { transcript, design, library, long: library.get('long', 0), short: library.get('short', 0) };
}

