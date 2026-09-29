/**
 * Every RNA in the cell as a zoomable molecule (spec §3, §6.3): a record per RNA with its
 * position, orientation and shape variant. Records resolve to molecule models from the
 * library, and their fluorophore positions are computed from the same molecular geometry
 * the molecular scene draws.
 */
import { Rng, hashSeed } from './rng';
import { seedSpots, type CellShape, type SpotSeed } from './cell';
import { getRegion } from './transcript';
import {
  FEATURED_FACING,
  facingRotation,
  placePoint,
  VARIANTS,
  type LocalDye,
  type MoleculeLibrary,
  type MoleculeModel,
  type Placement,
  type Quat,
} from './model';
import type { Vec3 } from './conformation';
import type { ProbeSetId } from './probes';

export interface RnaRecord extends SpotSeed {
  id: number;
  /** Stable key, e.g. "rna-17" (featured: "featured-long"). */
  key: string;
  variant: number;
  rot: Quat;
}

function randomQuat(rng: Rng): Quat {
  // Uniform random rotation (Shoemake).
  const u1 = rng.next();
  const u2 = rng.next() * Math.PI * 2;
  const u3 = rng.next() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

export function makeRecords(shape: CellShape): RnaRecord[] {
  const rng = new Rng(hashSeed(shape.seed, 'orient'));
  const featuredRot = facingRotation(FEATURED_FACING);
  return seedSpots(shape).map((s, id) => {
    const featured = s.kind === 'featured';
    return {
      ...s,
      id,
      key: featured ? `featured-${s.isoform}` : `rna-${id}`,
      variant: featured ? 0 : 1 + rng.int(VARIANTS - 1),
      rot: featured ? featuredRot : randomQuat(rng),
    };
  });
}

export function recordKind(r: RnaRecord, longFraction: number): 'long' | 'short' | 'nascent' {
  if (r.kind === 'nascent') return 'nascent';
  return r.isoform ?? (r.u < longFraction ? 'long' : 'short');
}

export function recordModel(lib: MoleculeLibrary, r: RnaRecord, longFraction: number): MoleculeModel {
  const kind = recordKind(r, longFraction);
  if (kind === 'nascent') {
    const gene = getRegion(lib.transcript.long, 'polya')!.start;
    return lib.nascent(r.variant, (r.progress ?? 1) * gene);
  }
  return lib.get(kind, r.variant);
}

/** Placement in cell-world µm (the model's nm are scaled by 1/1000). */
export function recordPlacement(r: RnaRecord): Placement {
  return { centre: [r.x, r.y, r.z], rot: r.rot };
}

export interface WorldDye {
  /** Cell-world µm. */
  pos: Vec3;
  set: ProbeSetId;
  local: LocalDye;
}

/** Fluorophores on a record's molecule with N probes per set bound, in cell-world µm. */
export function recordDyes(lib: MoleculeLibrary, r: RnaRecord, n: number, h: number, longFraction: number): WorldDye[] {
  const model = recordModel(lib, r, longFraction);
  const pl = recordPlacement(r);
  return lib.boundDyes(model, n, h).map((d) => ({ pos: placePoint(model, pl, d.pos, 1 / 1000), set: d.set, local: d }));
}

/** Records within `radius` µm of a point, nearest first. */
export function nearestRecords(records: readonly RnaRecord[], p: Vec3, radius: number, max: number): RnaRecord[] {
  const r2 = radius * radius;
  return records
    .map((r) => ({ r, d: (r.x - p[0]) ** 2 + (r.y - p[1]) ** 2 + (r.z - p[2]) ** 2 }))
    .filter((x) => x.d <= r2)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.r);
}
