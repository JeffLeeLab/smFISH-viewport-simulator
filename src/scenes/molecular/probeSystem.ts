/**
 * Probes around one molecule (spec §6.1): target probes that find, dock and zip onto their
 * sites 5′→3′, excess probes that drift and occasionally bump off mismatched sequence, and
 * the wash that sweeps unbound probes away.
 */
import * as THREE from 'three';
import type { MoleculeModel } from '../../data/model';
import type { Probe, ProbeSetId } from '../../data/probes';
import { PROBE_LENGTH } from '../../data/probes';
import {
  dyePosition,
  HYBRID_RADIUS,
  partnerPosition,
  radialAt,
  RUNG_POSITIONS,
  DYE_RADIUS,
  type Vec3,
} from '../../data/conformation';
import { Rng, hashSeed } from '../../data/rng';
import type { MoleculeView } from './moleculeView';
import { DynamicTubes, sphereMatrix, stickGeometry, stickMatrix } from './tubes';
import { PROBE_COLOR, SET_COLOR } from '../palette';

const PROBE_RADIUS = 0.3;
const FREE_RISE = 0.55;
const BASE_LEN_FREE = 0.85;
const ZIP_TIME = 0.9;
const WASH_TIME = 1.6;
/** Probes per set drifting in, as a multiple of the target count ("~3× excess"). */
const EXCESS = 2;

type Kind = 'target' | 'decoy';

interface Actor {
  kind: Kind;
  set: ProbeSetId;
  probe: Probe | null;
  site: number;
  rank: number;
  // Free-body motion.
  start: THREE.Vector3;
  qStart: THREE.Quaternion;
  spin: THREE.Vector3;
  wobble: number[]; // 9 frequencies/phases
  tDock: number;
  // Decoy bump.
  bumpT: number;
  bumpNt: number;
  // Live state.
  zip: number;
  present: number;
  flash: number;
  x: THREE.Vector3;
  q: THREE.Quaternion;
}

export interface BoundDye {
  /** Key of the molecule it sits on (e.g. "featured-long", "rna-17"). */
  molecule: string;
  /** Scene-space nm. */
  pos: THREE.Vector3;
  set: ProbeSetId;
  weight: number;
  probe: Probe;
}

/** Free (unpaired) probe shape, local frame: 5′ end at the origin, running along +x. */
const FREE_SHAPE: Vec3[] = [];
const FREE_BASE_DIR: Vec3[] = [];
for (let j = 0; j < PROBE_LENGTH; j++) {
  const t = j / (PROBE_LENGTH - 1);
  FREE_SHAPE.push([j * FREE_RISE, -0.9 * Math.sin(Math.PI * t), 0.35 * Math.sin(2 * Math.PI * t)]);
  const a = j * 0.55;
  const d = new THREE.Vector3(0.15, Math.cos(a) * 0.9 + 0.4, Math.sin(a) * 0.9).normalize();
  FREE_BASE_DIR.push([d.x, d.y, d.z]);
}
const FREE_DYE_LOCAL = new THREE.Vector3(...FREE_SHAPE[PROBE_LENGTH - 1]).add(
  new THREE.Vector3(0.55, -0.85, 0).normalize().multiplyScalar(0.9 + DYE_RADIUS),
);

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();

function smoother(t: number): number {
  t = Math.min(1, Math.max(0, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface ProbeMaterials {
  backbone: THREE.Material;
  base: THREE.Material;
  dye: THREE.Material;
  halo: THREE.ShaderMaterial;
}

export class ProbeSystem {
  readonly group = new THREE.Group();
  private actors: Actor[] = [];
  private view: MoleculeView;
  private model: MoleculeModel;
  private mats: ProbeMaterials;
  private tubes: DynamicTubes | null = null;
  private tubeMesh: THREE.Mesh | null = null;
  private bases: THREE.InstancedMesh | null = null;
  private rungs: THREE.InstancedMesh | null = null;
  private linkers: THREE.InstancedMesh | null = null;
  private dyes: THREE.InstancedMesh | null = null;
  private halos: THREE.Points | null = null;
  private points = new Float32Array(0);
  /** Dye centres without the minimum-size push (what optics should use). */
  private truePos: THREE.Vector3[] = [];
  private seed: number;

  /** Run clock (s), already scaled by animation speed. */
  clock = 0;
  running = false;
  washed = false;
  washClock = -1;
  h = 0;
  thicken = 1;
  dyeScale = 1;
  haloPx = 1;
  showSet: Record<ProbeSetId, boolean> = { cds: true, distal: true };
  /** Whether hybridisation has ever been started (no probes before). */
  active = false;
  private n = 0;

  private design: Record<ProbeSetId, Probe[]>;

  constructor(view: MoleculeView, mats: ProbeMaterials, design: Record<ProbeSetId, Probe[]>) {
    this.view = view;
    this.design = design;
    this.model = view.model;
    this.mats = mats;
    this.seed = hashSeed(view.key, 'probes');
    this.group.name = `probes-${view.key}`;
    view.local.add(this.group);
  }

  get probeCount(): number {
    return this.n;
  }

  /** (Re)create actors for N probes per set. Keeps the current phase. */
  configure(n: number, instantBound: boolean): void {
    this.n = n;
    const rng = new Rng(hashSeed(this.seed, n));
    const actors: Actor[] = [];
    const sites = this.model.sites;
    const centre = this.clusterCentre();
    const mk = (kind: Kind, set: ProbeSetId, site: number, rank: number, probe: Probe | null): Actor => {
      let start: THREE.Vector3;
      if (kind === 'target') {
        const p = this.siteCentre(site);
        start = randomShell(rng, 24, 58).add(p);
      } else if (rng.next() < 0.35) {
        start = randomShell(rng, 6, 26).add(centre);
      } else {
        start = randomShell(rng, 25, 115).add(new THREE.Vector3(...this.model.chain.centroid));
      }
      const wobble: number[] = [];
      for (let i = 0; i < 9; i++) wobble.push(i < 3 ? rng.range(0.35, 1.1) : rng.range(0, Math.PI * 2));
      const a: Actor = {
        kind,
        set,
        probe,
        site,
        rank,
        start,
        qStart: new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3))),
        spin: new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).multiplyScalar(0.45),
        wobble,
        tDock: rng.range(0.7, 4.4) + rank * 0.03,
        bumpT: -1,
        bumpNt: -1,
        zip: instantBound && kind === 'target' ? 1 : 0,
        present: 0,
        flash: 0,
        x: start.clone(),
        q: new THREE.Quaternion(),
      };
      if (kind === 'decoy' && start.distanceTo(centre) < 30 && rng.next() < 0.6) {
        a.bumpT = rng.range(0.8, 5.2);
        a.bumpNt = this.nearbyNt(centre, rng);
      }
      return a;
    };
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      if (s.probe.rank < n) actors.push(mk('target', s.probe.set, i, s.probe.rank, s.probe));
    }
    const sets: ProbeSetId[] = ['cds', 'distal'];
    for (const set of sets) {
      const binds = sites.some((s) => s.probe.set === set);
      // Short isoform: the distal set has nothing to bind, so all of it drifts.
      const count = binds ? EXCESS * n : (EXCESS + 1) * n;
      const list = this.design[set];
      for (let i = 0; i < count; i++) actors.push(mk('decoy', set, -1, i, list[i % n] ?? null));
    }
    this.actors = actors;
    this.rebuildGeometry();
  }

  private clusterCentre(): THREE.Vector3 {
    const s = this.model.sites.find((x) => x.probe.set === 'cds' && x.probe.rank === 0);
    return s ? this.siteCentre(this.model.sites.indexOf(s)) : new THREE.Vector3();
  }

  private siteCentre(site: number): THREE.Vector3 {
    const f = this.model.sites[site].frame;
    const [x, y, z] = this.view.ntPosition(f.start + 9);
    return new THREE.Vector3(x, y, z);
  }

  private nearbyNt(c: THREE.Vector3, rng: Rng): number {
    const cand: number[] = [];
    for (let i = 0; i < this.view.L; i += 3) {
      if (this.model.siteOf[i] >= 0) continue;
      const [x, y, z] = this.view.ntPosition(i);
      if (Math.hypot(x - c.x, y - c.y, z - c.z) < 22) cand.push(i);
    }
    return cand.length ? cand[rng.int(cand.length)] : rng.int(this.view.L);
  }

  private rebuildGeometry(): void {
    for (const o of [this.tubeMesh, this.bases, this.rungs, this.linkers, this.dyes, this.halos]) {
      if (o) {
        this.group.remove(o);
        if (o instanceof THREE.InstancedMesh) o.dispose();
      }
    }
    this.tubes?.dispose();
    this.halos?.geometry.dispose();
    const n = this.actors.length;
    if (n === 0) {
      this.tubes = null;
      this.tubeMesh = this.bases = this.rungs = this.linkers = this.dyes = null;
      this.halos = null;
      return;
    }
    this.tubes = new DynamicTubes(this.actors.map(() => ({ count: PROBE_LENGTH, radius: PROBE_RADIUS })), 6);
    this.truePos = this.actors.map(() => new THREE.Vector3());
    this.points = new Float32Array(n * PROBE_LENGTH * 3);
    this.tubeMesh = new THREE.Mesh(this.tubes.geometry, this.mats.backbone);
    this.tubeMesh.frustumCulled = false;
    const stick = stickGeometry(5);
    this.bases = new THREE.InstancedMesh(stick, this.mats.base, n * PROBE_LENGTH);
    this.rungs = new THREE.InstancedMesh(stick, this.mats.base, n * RUNG_POSITIONS.length);
    this.linkers = new THREE.InstancedMesh(stick, this.mats.base, n);
    this.dyes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), this.mats.dye, n);
    for (const m of [this.bases, this.rungs, this.linkers, this.dyes]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.dyes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.dyes.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.dyes.name = 'dyes';
    this.bases.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * PROBE_LENGTH * 3), 3);
    this.rungs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * RUNG_POSITIONS.length * 3), 3);
    this.linkers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(0.55), 3);

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    hg.setAttribute('intensity', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.halos = new THREE.Points(hg, this.mats.halo);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 10;

    // Static colours.
    const bc = this.bases.instanceColor.array as Float32Array;
    const rc = this.rungs.instanceColor.array as Float32Array;
    const hc = hg.getAttribute('color').array as Float32Array;
    this.actors.forEach((a, i) => {
      const dim = a.kind === 'decoy' ? 0.62 : 1;
      for (let j = 0; j < PROBE_LENGTH; j++) {
        this.tubes!.setPointColor(i, j, PROBE_COLOR.r * dim, PROBE_COLOR.g * dim, PROBE_COLOR.b * dim);
        const o = (i * PROBE_LENGTH + j) * 3;
        bc[o] = PROBE_COLOR.r * 0.8 * dim;
        bc[o + 1] = PROBE_COLOR.g * 0.8 * dim;
        bc[o + 2] = PROBE_COLOR.b * 0.8 * dim;
      }
      for (let r = 0; r < RUNG_POSITIONS.length; r++) {
        const o = (i * RUNG_POSITIONS.length + r) * 3;
        rc[o] = 0.72;
        rc[o + 1] = 0.74;
        rc[o + 2] = 0.8;
      }
      const c = SET_COLOR[a.set];
      hc[i * 3] = c.r;
      hc[i * 3 + 1] = c.g;
      hc[i * 3 + 2] = c.b;
    });
    this.tubes.markColorsDirty();
    this.group.add(this.tubeMesh, this.bases, this.rungs, this.linkers, this.dyes, this.halos);
  }

  /** Adopt another system's phase (used when a molecule comes into view mid-experiment). */
  copyStateFrom(o: ProbeSystem): void {
    this.showSet = { ...o.showSet };
    this.washed = o.washed;
    this.h = o.h;
    this.configure(o.probeCount || 10, o.active && !o.running);
    if (o.running) this.start();
    else if (o.active) this.finish();
    this.washClock = o.washed ? -1 : o.washClock;
    if (o.washed) {
      // Already washed: no unbound probes to sweep away.
      this.washClock = this.clock - 10;
    }
  }

  dispose(): void {
    this.actors = [];
    this.rebuildGeometry();
    this.group.removeFromParent();
  }

  /** Start (or restart) the hybridisation run. */
  start(): void {
    this.active = true;
    this.running = true;
    this.clock = 0;
    this.washClock = -1;
    for (const a of this.actors) {
      a.x.copy(a.start);
      a.flash = 0;
    }
  }

  /** Jump to the finished state (e.g. deep link to stage 2). */
  finish(): void {
    this.active = true;
    this.running = false;
    this.clock = Math.max(this.clock, 6);
    for (const a of this.actors) if (a.kind === 'target') a.zip = 1;
  }

  reset(): void {
    this.active = false;
    this.running = false;
    this.clock = 0;
  }

  /** True once every target has docked and zipped. */
  get complete(): boolean {
    return this.actors.every((a) => a.kind !== 'target' || a.zip >= 0.999);
  }

  /**
   * Advance the simulation by dt (already speed-scaled) and rebuild geometry.
   * Returns true if the molecule pose changed.
   */
  update(dt: number, reducedMotion: boolean): boolean {
    this.clock += dt;
    let poseChanged = false;
    const zipArr = this.view.zip;
    const sites = this.model.sites;
    const clock = this.clock;

    for (const a of this.actors) {
      // Presence: probes appear with the run and decoys leave with the wash.
      let targetPresent = this.active ? 1 : 0;
      if (a.kind === 'decoy' && this.washed) {
        if (this.washClock < 0) this.washClock = clock;
        const tw = clock - this.washClock;
        targetPresent = 1 - smoother(tw / WASH_TIME);
      }
      if (reducedMotion) a.present = targetPresent;
      else a.present += (targetPresent - a.present) * Math.min(1, dt * 3.5);
      if (a.present < 0.002 && targetPresent === 0) a.present = 0;

      if (a.kind === 'target') {
        let goal: number;
        if (!this.active) goal = 0;
        else if (!this.running) goal = 1;
        else goal = reducedMotion ? smoother(clock / 0.6) : Math.min(1, Math.max(0, (clock - a.tDock) / ZIP_TIME));
        const prev = a.zip;
        // Zipping follows the schedule; un-zipping (replay) relaxes smoothly.
        a.zip = goal >= a.zip ? goal : a.zip + (goal - a.zip) * Math.min(1, dt * 4);
        if (Math.abs(a.zip - prev) > 1e-5) poseChanged = true;
      }
    }
    if (!this.washed) this.washClock = -1;

    // Write pair progress onto the mRNA.
    if (poseChanged || this.h !== this.view.h) {
      zipArr.fill(0);
      for (const a of this.actors) {
        if (a.kind !== 'target' || a.zip <= 0) continue;
        const f = sites[a.site].frame;
        for (let k = 0; k < PROBE_LENGTH; k++) zipArr[f.start + k] = pairProgress(a.zip, PROBE_LENGTH - 1 - k);
      }
      this.view.h = this.h;
      this.view.markDirty();
      poseChanged = true;
    }
    this.view.update();
    this.writeGeometry();
    return poseChanged;
  }

  /** Free-body pose for an actor at the current clock. */
  private freePose(a: Actor, clock: number): void {
    const w = a.wobble;
    const amp = a.kind === 'target' ? 7 : 9;
    const wob = tmpA.set(
      Math.sin(w[0] * clock + w[3]) * amp,
      Math.sin(w[1] * clock + w[4]) * amp,
      Math.sin(w[2] * clock + w[5]) * amp * 0.8,
    );
    a.x.copy(a.start).add(wob);
    tmpQ.setFromEuler(new THREE.Euler(a.spin.x * clock + w[6], a.spin.y * clock + w[7], a.spin.z * clock + w[8]));
    a.q.copy(a.qStart).multiply(tmpQ);
  }

  private writeGeometry(): void {
    if (!this.tubes) return;
    const sites = this.model.sites;
    const pts = this.points;
    const baseM = this.bases!.instanceMatrix.array as Float32Array;
    const rungM = this.rungs!.instanceMatrix.array as Float32Array;
    const linkM = this.linkers!.instanceMatrix.array as Float32Array;
    const dyeM = this.dyes!.instanceMatrix.array as Float32Array;
    const dyeC = this.dyes!.instanceColor!.array as Float32Array;
    const hPos = this.halos!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const hInt = this.halos!.geometry.getAttribute('intensity') as THREE.BufferAttribute;
    const h = this.h;
    const clock = this.clock;
    const bound = new THREE.Vector3();
    const free = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const q3 = new THREE.Vector3();
    const rot = new THREE.Matrix3();
    const nRung = RUNG_POSITIONS.length;

    this.actors.forEach((a, i) => {
      const shown = a.present > 0.003 && this.showSet[a.set];
      this.tubes!.stripScale[i] = shown ? Math.min(1, a.present * 1.4) : 0;
      if (!shown) {
        for (let j = 0; j < PROBE_LENGTH; j++) zeroMatrix(baseM, i * PROBE_LENGTH + j);
        for (let r = 0; r < nRung; r++) zeroMatrix(rungM, i * nRung + r);
        zeroMatrix(linkM, i);
        zeroMatrix(dyeM, i);
        hInt.setX(i, 0);
        return;
      }
      const site = a.site >= 0 ? sites[a.site] : null;
      const f = site?.frame;

      // Free-body transform.
      if (a.kind === 'target' && f) {
        const approach = this.running ? smoother(clock / Math.max(0.2, a.tDock)) : 1;
        const dockT = a.zip > 0 ? 1 : approach;
        this.freePose(a, clock);
        // Docking pose: 5′ end on the site's mRNA-3′ end, running toward the mRNA 5′ end.
        const p17 = this.view.ntPosition(f.start + PROBE_LENGTH - 1);
        const dock = partnerPosition(f, PROBE_LENGTH - 1, h, p17);
        const qDock = dockQuaternion(f, h);
        const e = dockT;
        a.x.lerp(bound.set(dock[0], dock[1], dock[2]), e);
        a.q.slerp(qDock, e * e);
      } else {
        this.freePose(a, clock);
        if (a.bumpT >= 0 && this.running) {
          const w = Math.exp(-(((clock - a.bumpT) / 0.4) ** 2));
          if (w > 0.001) {
            const [cx, cy, cz] = this.view.ntPosition(a.bumpNt);
            a.x.lerp(bound.set(cx + 1.6, cy + 1.2, cz + 0.8), w * 0.92);
          }
          a.flash = Math.exp(-(((clock - a.bumpT) / 0.13) ** 2));
        } else a.flash = 0;
        if (this.washed && this.washClock >= 0) {
          const tw = clock - this.washClock;
          a.x.add(dir.set(1, -0.35, 0.15).multiplyScalar(90 * tw * tw));
        }
      }
      rot.setFromMatrix4(tmpM.makeRotationFromQuaternion(a.q));

      // Probe nucleotides.
      for (let j = 0; j < PROBE_LENGTH; j++) {
        free.set(...FREE_SHAPE[j]).applyMatrix3(rot).add(a.x);
        const b = a.kind === 'target' ? pairProgress(a.zip, j) : 0;
        let px = free.x,
          py = free.y,
          pz = free.z;
        const k = PROBE_LENGTH - 1 - j;
        if (b > 0 && f) {
          const pm = this.view.ntPosition(f.start + k);
          const q = partnerPosition(f, k, h, pm);
          px += (q[0] - px) * b;
          py += (q[1] - py) * b;
          pz += (q[2] - pz) * b;
        }
        const o = (i * PROBE_LENGTH + j) * 3;
        pts[o] = px;
        pts[o + 1] = py;
        pts[o + 2] = pz;
        // Base: free direction → toward the duplex axis.
        dir.set(...FREE_BASE_DIR[j]).applyMatrix3(rot);
        let len = BASE_LEN_FREE;
        if (b > 0 && f) {
          const rad = radialAt(f, k, h);
          dir.lerp(tmpB.set(rad[0], rad[1], rad[2]), b).normalize();
          len += ((HYBRID_RADIUS - PROBE_RADIUS - 0.04) * h - len) * b;
        }
        const off = PROBE_RADIUS * 0.8 * this.thicken;
        const l = len * a.present;
        stickMatrix(baseM, i * PROBE_LENGTH + j, px + dir.x * off, py + dir.y * off, pz + dir.z * off, dir.x, dir.y, dir.z, Math.max(1e-4, l), l > 1e-3 ? 0.12 * Math.min(this.thicken, 1.6) : 0);
      }

      // Ladder rungs (schematic mode).
      for (let r = 0; r < nRung; r++) {
        const k = RUNG_POSITIONS[r];
        const j = PROBE_LENGTH - 1 - k;
        const b = a.kind === 'target' && f ? pairProgress(a.zip, j) : 0;
        const vis = b * (1 - h) * a.present;
        if (vis < 0.01 || !f) {
          zeroMatrix(rungM, i * nRung + r);
          continue;
        }
        const pm = this.view.ntPosition(f.start + k);
        const o = (i * PROBE_LENGTH + j) * 3;
        dir.set(pts[o] - pm[0], pts[o + 1] - pm[1], pts[o + 2] - pm[2]);
        const d = dir.length();
        dir.divideScalar(d || 1);
        const grow = smoother(vis);
        stickMatrix(rungM, i * nRung + r, pm[0], pm[1], pm[2], dir.x, dir.y, dir.z, d * grow, 0.24 * Math.min(this.thicken, 1.6));
      }

      // Linker and dye on the probe's 3′ end.
      const o3 = (i * PROBE_LENGTH + PROBE_LENGTH - 1) * 3;
      q3.set(pts[o3], pts[o3 + 1], pts[o3 + 2]);
      free.copy(FREE_DYE_LOCAL).applyMatrix3(rot).add(a.x);
      const b17 = a.kind === 'target' ? pairProgress(a.zip, PROBE_LENGTH - 1) : 0;
      if (b17 > 0 && f) {
        const d = dyePosition(f, h, [q3.x, q3.y, q3.z]);
        free.lerp(bound.set(d[0], d[1], d[2]), b17);
      }
      dir.copy(free).sub(q3);
      const dl = dir.length();
      dir.divideScalar(dl || 1);
      const dyeR = DYE_RADIUS * this.dyeScale * Math.min(1, a.present * 1.5);
      stickMatrix(linkM, i, q3.x, q3.y, q3.z, dir.x, dir.y, dir.z, Math.max(1e-4, dl - dyeR * 0.6), 0.1 * Math.min(this.thicken, 1.6));
      // With a minimum on-screen size the dye sphere is pushed out along the linker.
      this.truePos[i].copy(free);
      const push = Math.max(0, dyeR - DYE_RADIUS);
      const dx = free.x + dir.x * push;
      const dy = free.y + dir.y * push;
      const dz = free.z + dir.z * push;
      sphereMatrix(dyeM, i, dx, dy, dz, dyeR);
      const c = SET_COLOR[a.set];
      const glow = (a.kind === 'target' ? 3.2 : 1.1) * (1 + a.flash * 3) * a.present;
      dyeC[i * 3] = c.r * glow;
      dyeC[i * 3 + 1] = c.g * glow;
      dyeC[i * 3 + 2] = c.b * glow;
      hPos.setXYZ(i, dx, dy, dz);
      hInt.setX(i, (a.kind === 'target' ? 1 : 0.4) * (1 + a.flash * 2) * a.present);
    });

    this.tubes.update(pts, this.thicken);
    for (const m of [this.bases!, this.rungs!, this.linkers!, this.dyes!]) m.instanceMatrix.needsUpdate = true;
    this.dyes!.instanceColor!.needsUpdate = true;
    hPos.needsUpdate = true;
    hInt.needsUpdate = true;
  }

  /** Dyes on bound probes (scene-space nm), weighted by binding progress. */
  boundDyes(out: BoundDye[]): void {
    if (!this.dyes) return;
    const m = this.dyes.instanceMatrix.array as Float32Array;
    this.actors.forEach((a, i) => {
      if (a.kind !== 'target' || !a.probe || a.zip <= 0) return;
      const w = pairProgress(a.zip, PROBE_LENGTH - 1);
      if (w <= 0) return;
      out.push({
        molecule: this.view.key,
        pos: this.view.localToScene(this.truePos[i] ? this.truePos[i].clone() : new THREE.Vector3(m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14])),
        set: a.set,
        weight: w,
        probe: a.probe,
      });
    });
  }

  /** Scene-space dye positions for dye point lights. */
  forEachShownDye(fn: (p: THREE.Vector3, set: ProbeSetId, intensity: number) => void): void {
    if (!this.dyes) return;
    const m = this.dyes.instanceMatrix.array as Float32Array;
    const v = new THREE.Vector3();
    this.actors.forEach((a, i) => {
      if (a.present < 0.05 || !this.showSet[a.set]) return;
      this.view.localToScene(v.set(m[i * 16 + 12], m[i * 16 + 13], m[i * 16 + 14]));
      fn(v, a.set, a.kind === 'target' ? 1 : 0.35);
    });
  }

  /** Pick the probe nearest to a ray (scene space), for tooltips. */
  pick(sceneRay: THREE.Ray, tol: number): { probe: Probe; bound: boolean; dist: number } | null {
    if (!this.tubes) return null;
    const ray = this.view.rayToLocal(sceneRay);
    const v = new THREE.Vector3();
    let best: { probe: Probe; bound: boolean; dist: number } | null = null;
    const dyeM = this.dyes!.instanceMatrix.array as Float32Array;
    this.actors.forEach((a, i) => {
      if (!a.probe || a.present < 0.3 || !this.showSet[a.set]) return;
      // Every other nucleotide, plus the dye (whose on-screen size may be enlarged).
      for (let j = 0; j <= PROBE_LENGTH; j += 2) {
        let r = tol;
        if (j >= PROBE_LENGTH) {
          v.set(dyeM[i * 16 + 12], dyeM[i * 16 + 13], dyeM[i * 16 + 14]);
          r = tol + dyeM[i * 16];
        } else {
          const o = (i * PROBE_LENGTH + j) * 3;
          v.set(this.points[o], this.points[o + 1], this.points[o + 2]);
        }
        const t = tmpA.copy(v).sub(ray.origin).dot(ray.direction);
        if (t <= 0 || (best && t > best.dist)) continue;
        if (ray.distanceSqToPoint(v) < r * r) best = { probe: a.probe, bound: a.kind === 'target' && a.zip > 0.99, dist: t };
      }
    });
    return best;
  }
}

/** Pairing progress of probe nt j (0 = 5′ end) for a zip fraction. */
export function pairProgress(zip: number, j: number): number {
  return Math.min(1, Math.max(0, zip * (PROBE_LENGTH + 1) - j));
}

function zeroMatrix(a: Float32Array, i: number): void {
  a.fill(0, i * 16, i * 16 + 16);
}

function randomShell(rng: Rng, r0: number, r1: number): THREE.Vector3 {
  const v = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss() * 0.8).normalize();
  return v.multiplyScalar(rng.range(r0, r1));
}

/** Orientation that maps the free-probe frame onto the bound strand. */
function dockQuaternion(f: { u: Vec3; e1: Vec3; e2: Vec3 }, h: number): THREE.Quaternion {
  const x = new THREE.Vector3(-f.u[0], -f.u[1], -f.u[2]);
  const rad = radialAt(f as Parameters<typeof radialAt>[0], PROBE_LENGTH - 1, h);
  const y = new THREE.Vector3(rad[0], rad[1], rad[2]);
  y.addScaledVector(x, -y.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
