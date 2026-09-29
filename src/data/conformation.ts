/**
 * Molecular geometry (spec §4.6), in nm.
 *
 * The unbound mRNA is a clean, mostly straight strand with gentle wiggles, folded into a
 * few parallel rows joined by U-turns (no crossings), so its 5′→3′ order reads like lines
 * of text while the molecule stays compact (~280 × 140 nm) — compact enough that probes at
 * both ends fall inside one diffraction-limited spot. Resampled at 0.6 nm per nt; the
 * poly(A) tail curls off the last row. The chain is stored as step
 * vectors so that hybridised sites can straighten (or twist into an A-form helix) while
 * the rest of the chain moves rigidly with them, anchored at one nucleotide.
 */
import { Rng } from './rng';

export type Vec3 = [number, number, number];

export const NT_RISE_SS = 0.6; // ssRNA, nm per nt
export const HYBRID_RISE = 0.28; // A-form RNA–DNA hybrid, nm per bp
export const HYBRID_BP_PER_TURN = 11;
export const HYBRID_RADIUS = 1.0; // backbone radius of the duplex, nm
export const LINKER_LENGTH = 0.9; // C6 amino linker, nm
export const DYE_RADIUS = 0.7; // Alexa dyes are ~1.3–1.5 nm across
export const RUNG_POSITIONS = [2, 6, 11, 15];

export interface ChainOptions {
  length: number;
  seed: number;
  /** nt index from which the chain is more flexible (poly(A) tail). */
  flexibleFrom: number;
  /** nt index held fixed when sites straighten. */
  anchor: number;
  /** Distance between neighbouring rows of the folded strand, nm. */
  rowSpacing?: number;
  /**
   * Contour per row including its U-turn, nm. Choosing it so two nucleotides are an even
   * number of rows apart stacks them directly above each other (used to keep the two probe
   * sets of the long isoform within one diffraction-limited spot).
   */
  rowPitch?: number;
}

/** Rows of the folded strand: spacing and target length (nm). */
export const ROW_SPACING = 24;
export const TARGET_ROW = 250;

export interface Chain {
  length: number;
  anchor: number;
  /** Unbound positions (3·length), anchor at the origin. */
  rest: Float32Array;
  /** Unbound step vectors (3·(length−1)). */
  step0: Float32Array;
  /** Unit base directions in the unbound coil (3·length). */
  baseDir0: Float32Array;
  /** Centroid of the unbound coil. */
  centroid: Vec3;
}

// ---------- small vector helpers (plain arrays keep this module three-free) ----------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vec = { sub, add, scale, dot, cross, len, norm };

function anyPerpendicular(t: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(t, ref));
}

export function generateChain(opts: ChainOptions): Chain {
  const { length: L, seed, flexibleFrom, anchor } = opts;
  const rng = new Rng(seed);
  const s = opts.rowSpacing ?? ROW_SPACING;
  const r = s / 2; // U-turn radius
  const turnLen = Math.PI * r;
  const flex = Math.min(L - 1, Math.max(1, flexibleFrom));
  const body = (flex - 1) * NT_RISE_SS; // contour of everything before the poly(A) tail
  // Rows of equal length; the last row takes whatever contour is left over.
  const pitch = opts.rowPitch ?? (body + turnLen) / Math.max(1, Math.round((body + turnLen) / (TARGET_ROW + turnLen)));
  const rowLen = Math.max(20, pitch - turnLen);
  const rows = Math.max(1, Math.round((body + turnLen) / pitch));
  // Gentle wiggles: two lateral and two vertical sinusoids along the contour.
  // Smooth 1D value noise gives irregular, gentle wiggles (no fixed period).
  const knots = (spacing: number, amp: number) => {
    const n = Math.ceil((body + 400) / spacing) + 4;
    const v = Array.from({ length: n }, () => (rng.next() * 2 - 1) * amp);
    return (t: number) => {
      const x = t / spacing;
      const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
      const f = x - i;
      const e = f * f * (3 - 2 * f);
      return v[i] + (v[i + 1] - v[i]) * e;
    };
  };
  const latA = knots(26, 1.3);
  const latB = knots(70, 1.6);
  const vertA = knots(40, 1.6);
  const vertB = knots(110, 2.0);
  const lateral = (t: number) => latA(t) + latB(t);
  const vertical = (t: number) => vertA(t) + vertB(t);

  // Centreline, sampled every ~0.3 nm: straight rows joined by semicircular U-turns, lying
  // in the local x–y plane (the molecule is placed and rotated later).
  const dense: Vec3[] = [];
  let xCur = -rowLen / 2;
  let t = 0; // contour along the centreline
  const push = (x: number, y: number, tangentX: number, tangentY: number, wiggle = 1) => {
    // Offset perpendicular to the path in-plane, plus out-of-plane undulation.
    const w = lateral(t) * wiggle;
    dense.push([x - tangentY * w, y + tangentX * w, vertical(t) * wiggle]);
  };
  const STEP = 0.3;
  for (let k = 0; k < rows; k++) {
    const len = k < rows - 1 ? rowLen : Math.max(20, body - (rows - 1) * pitch);
    const dirX = k % 2 === 0 ? 1 : -1;
    const y = k * s;
    const x0 = xCur;
    const bow = (rng.next() - 0.5) * 5; // each row slightly bowed
    const n = Math.max(2, Math.round(len / STEP));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      push(x0 + dirX * len * f, y + bow * Math.sin(Math.PI * f), dirX, 0);
      t += len / n;
    }
    if (k < rows - 1) {
      // U-turn around (xEnd, y + r).
      const xEnd = x0 + dirX * len;
      xCur = xEnd;
      const nt = Math.max(4, Math.round(turnLen / STEP));
      for (let i = 0; i < nt; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / nt;
        const cx = xEnd + dirX * r * Math.cos(a);
        const cy = y + r + r * Math.sin(a);
        push(cx, cy, -dirX * Math.sin(a), Math.cos(a));
        t += turnLen / nt;
      }
    }
  }
  // Poly(A) tail: a looser, curling continuation off the end of the last row.
  {
    const last = dense[dense.length - 1];
    const prev = dense[dense.length - 20] ?? last;
    let dir: Vec3 = norm(sub(last, prev));
    let p: Vec3 = [...last];
    const tailLen = (L - flex) * NT_RISE_SS + 20;
    const curl = rng.next() < 0.5 ? 1 : -1;
    for (let d = 0; d < tailLen; d += STEP) {
      // Curves gently outward (+y), with a little random wander.
      const turn = curl * 0.004 + (rng.next() - 0.5) * 0.02;
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      dir = norm([dir[0] * c - dir[1] * sn, dir[0] * sn + dir[1] * c + 0.0015, dir[2] + (rng.next() - 0.5) * 0.01]);
      p = add(p, scale(dir, STEP));
      dense.push(p);
    }
  }

  // Arc-length resampling at exactly 0.6 nm per nt.
  const rest = new Float32Array(L * 3);
  let carried = 0; // distance travelled since the last written point
  let prev = dense[0];
  rest.set(prev, 0);
  let written = 1;
  for (let i = 1; i < dense.length && written < L; i++) {
    const cur = dense[i];
    let segLen = len(sub(cur, prev));
    let from = prev;
    while (carried + segLen >= NT_RISE_SS && written < L) {
      const need = NT_RISE_SS - carried;
      const f = need / segLen;
      const q = add(from, scale(sub(cur, from), f));
      rest.set(q, written * 3);
      written++;
      from = q;
      segLen -= need;
      carried = 0;
    }
    carried += segLen;
    prev = cur;
  }
  // Keep the chain complete if the path ran short (it is built with a margin).
  while (written < L) {
    const i = (written - 1) * 3;
    rest.set([rest[i] + NT_RISE_SS, rest[i + 1], rest[i + 2]], written * 3);
    written++;
  }

  // Re-centre on the anchor.
  const a: Vec3 = [rest[anchor * 3], rest[anchor * 3 + 1], rest[anchor * 3 + 2]];
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < L; i++) {
    rest[i * 3] -= a[0];
    rest[i * 3 + 1] -= a[1];
    rest[i * 3 + 2] -= a[2];
    cx += rest[i * 3];
    cy += rest[i * 3 + 1];
    cz += rest[i * 3 + 2];
  }

  const step0 = new Float32Array((L - 1) * 3);
  for (let i = 0; i < L - 1; i++) {
    for (let c = 0; c < 3; c++) step0[i * 3 + c] = rest[(i + 1) * 3 + c] - rest[i * 3 + c];
  }

  // Parallel-transport frames give each base a direction that rotates gently along the chain.
  const baseDir0 = new Float32Array(L * 3);
  let T: Vec3 = norm([step0[0], step0[1], step0[2]]);
  let N: Vec3 = anyPerpendicular(T);
  for (let i = 0; i < L; i++) {
    const si = Math.min(i, L - 2);
    const Tn = norm([step0[si * 3], step0[si * 3 + 1], step0[si * 3 + 2]]);
    // Transport N from T to Tn.
    const axis = cross(T, Tn);
    const s = len(axis);
    if (s > 1e-6) {
      const k = scale(axis, 1 / s);
      const c = dot(T, Tn);
      const ang = Math.atan2(s, c);
      N = rotate(N, k, ang);
    }
    N = norm(sub(N, scale(Tn, dot(N, Tn))));
    T = Tn;
    const B = cross(T, N);
    const phi = i * 0.6;
    const d = add(scale(N, Math.cos(phi)), scale(B, Math.sin(phi)));
    baseDir0.set(d, i * 3);
  }

  return { length: L, anchor, rest, step0, baseDir0, centroid: [cx / L, cy / L, cz / L] };
}

/** Rodrigues rotation of v about unit axis k by angle a. */
function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

// ---------------------------------------------------------------------------------------
// Hybridised sites
// ---------------------------------------------------------------------------------------

export interface SiteFrame {
  start: number;
  length: number;
  /** Duplex axis, pointing mRNA 5′→3′. */
  u: Vec3;
  e1: Vec3;
  e2: Vec3;
}

export function siteFrame(chain: Chain, start: number, length: number): SiteFrame {
  let u: Vec3 = [0, 0, 0];
  for (let i = start; i < start + length - 1; i++) {
    u = add(u, [chain.step0[i * 3], chain.step0[i * 3 + 1], chain.step0[i * 3 + 2]]);
  }
  u = norm(u);
  // The strand is folded in its local x–y plane: lay each duplex flat in that plane, with
  // every probe on the same side (+y), so the ladders read face-on.
  let e1: Vec3 = cross(u, [0, 0, 1]);
  if (len(e1) < 0.2) {
    const mid = start + Math.floor(length / 2);
    e1 = [chain.baseDir0[mid * 3], chain.baseDir0[mid * 3 + 1], chain.baseDir0[mid * 3 + 2]];
  }
  e1 = sub(e1, scale(u, dot(e1, u)));
  e1 = len(e1) > 1e-4 ? norm(e1) : anyPerpendicular(u);
  if (e1[1] < -1e-6 || (Math.abs(e1[1]) <= 1e-6 && e1[0] < 0)) e1 = scale(e1, -1);
  const e2 = cross(u, e1);
  return { start, length, u, e1, e2 };
}

/** Axial rise per bp, blending schematic ladder (h = 0) to A-form helix (h = 1). */
export function riseFor(h: number): number {
  return NT_RISE_SS + (HYBRID_RISE - NT_RISE_SS) * h;
}

/** Unit vector from the duplex axis to the mRNA strand at pair k. */
export function radialAt(f: SiteFrame, k: number, h: number): Vec3 {
  const phi = Math.PI + h * k * ((2 * Math.PI) / HYBRID_BP_PER_TURN);
  return add(scale(f.e1, Math.cos(phi)), scale(f.e2, Math.sin(phi)));
}

/** mRNA strand position in the site's own frame (pair k, relative to the axis origin). */
export function boundLocal(f: SiteFrame, k: number, h: number): Vec3 {
  return add(scale(f.u, k * riseFor(h)), scale(radialAt(f, k, h), HYBRID_RADIUS));
}

/**
 * Compute chain positions for the current binding state.
 * `zip[i]` is the pairing progress (0–1) of nt i; `siteOf[i]` is the site index or −1.
 */
export function computePose(
  chain: Chain,
  frames: readonly SiteFrame[],
  siteOf: Int32Array,
  zip: Float32Array,
  h: number,
  out: Float32Array,
  scratch?: Float32Array,
): void {
  const L = chain.length;
  const s0 = chain.step0;
  // Step vectors.
  const steps = scratch && scratch.length >= (L - 1) * 3 ? scratch : new Float32Array((L - 1) * 3);
  for (let i = 0; i < L - 1; i++) {
    const si = siteOf[i];
    const b = si >= 0 && siteOf[i + 1] === si ? Math.min(zip[i], zip[i + 1]) : 0;
    if (b <= 0) {
      steps[i * 3] = s0[i * 3];
      steps[i * 3 + 1] = s0[i * 3 + 1];
      steps[i * 3 + 2] = s0[i * 3 + 2];
      continue;
    }
    const f = frames[si];
    const k = i - f.start;
    const m0 = boundLocal(f, k, h);
    const m1 = boundLocal(f, k + 1, h);
    for (let c = 0; c < 3; c++) {
      const tb = m1[c] - m0[c];
      steps[i * 3 + c] = s0[i * 3 + c] + (tb - s0[i * 3 + c]) * b;
    }
  }
  // Integrate outward from the anchor.
  // The anchor keeps its rest position (the origin for full chains; nascent prefixes
  // share their parent's frame).
  const a = chain.anchor;
  out[a * 3] = chain.rest[a * 3];
  out[a * 3 + 1] = chain.rest[a * 3 + 1];
  out[a * 3 + 2] = chain.rest[a * 3 + 2];
  for (let i = a; i < L - 1; i++) {
    out[(i + 1) * 3] = out[i * 3] + steps[i * 3];
    out[(i + 1) * 3 + 1] = out[i * 3 + 1] + steps[i * 3 + 1];
    out[(i + 1) * 3 + 2] = out[i * 3 + 2] + steps[i * 3 + 2];
  }
  for (let i = a - 1; i >= 0; i--) {
    out[i * 3] = out[(i + 1) * 3] - steps[i * 3];
    out[i * 3 + 1] = out[(i + 1) * 3 + 1] - steps[i * 3 + 1];
    out[i * 3 + 2] = out[(i + 1) * 3 + 2] - steps[i * 3 + 2];
  }
}

/** Position of probe nt paired with mRNA pair k, given the mRNA strand position there. */
export function partnerPosition(f: SiteFrame, k: number, h: number, mrnaPos: Vec3): Vec3 {
  return sub(mrnaPos, scale(radialAt(f, k, h), 2 * HYBRID_RADIUS));
}

/**
 * Fluorophore centre for a fully bound probe. The dye hangs off the probe's 3′ end, which
 * pairs with the site's mRNA-5′-most nucleotide (k = 0).
 */
export function dyePosition(f: SiteFrame, h: number, probe3Prime: Vec3): Vec3 {
  const out = scale(radialAt(f, 0, h), -1);
  const dir = norm(add(out, scale(f.u, -0.7)));
  return add(probe3Prime, scale(dir, LINKER_LENGTH + DYE_RADIUS));
}

/** Extent of a point cloud: the largest distance between the centroid and any point, ×2. */
export function envelopeDiameter(points: Float32Array): number {
  const n = points.length / 3;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < n; i++) {
    cx += points[i * 3];
    cy += points[i * 3 + 1];
    cz += points[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    d.push(Math.hypot(points[i * 3] - cx, points[i * 3 + 1] - cy, points[i * 3 + 2] - cz));
  }
  d.sort((x, y) => x - y);
  // 95th percentile so a single stray tail does not dominate.
  return 2 * d[Math.floor(n * 0.95)];
}
