/**
 * One mRNA molecule: backbone tube, instanced bases with LOD, m7G cap and region labels.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { MoleculeModel, Placement } from '../../data/model';
import { computePose, HYBRID_RADIUS, radialAt, type Vec3 } from '../../data/conformation';
import { regionOf, REGION_NAMES, type RegionId } from '../../data/transcript';
import { DynamicTubes, stickGeometry, stickMatrix } from './tubes';
import { CAP_COLOR, NT_COLOR, REGION_COLOR } from '../palette';

export const BACKBONE_RADIUS = 0.38;
export const POLYA_RADIUS = 0.28;
const BASE_LEN_FREE = 0.6;
const BASE_RADIUS = 0.13;
const CAP_RADIUS = 0.95;

export class MoleculeView {
  readonly group = new THREE.Group();
  /** Child of `group` holding geometry in the model's anchor frame. */
  readonly local = new THREE.Group();
  private invLocal = new THREE.Matrix4();
  readonly model: MoleculeModel;
  readonly L: number;
  /** Current pose, molecule-local nm. */
  readonly positions: Float32Array;
  /** Pair progress per nt (written by the probe system). */
  readonly zip: Float32Array;
  readonly tubes: DynamicTubes;
  readonly bases: THREE.InstancedMesh;
  readonly cap: THREE.Mesh;
  readonly capStub: THREE.Mesh;
  readonly labelRoot = new THREE.Group();
  private labels: { obj: CSS2DObject; nt: number; region: RegionId | 'end5' | 'end3' }[] = [];
  private scratch: Float32Array;
  private radii: Float32Array;
  private regionIdx: Uint8Array;
  private regionIds: RegionId[];
  private colorByNt = false;
  private highlight: RegionId | null = null;
  baseGrow = 1;
  thicken = 1;
  capScale = 1;
  h = 0;
  private dirty = true;

  constructor(
    model: MoleculeModel,
    readonly key: string,
    placement: Placement,
    backboneMat: THREE.Material,
    baseMat: THREE.Material,
    capMat: THREE.Material,
  ) {
    this.model = model;
    const L = (this.L = model.chain.length);
    this.positions = new Float32Array(model.chain.rest);
    this.zip = new Float32Array(L);
    this.scratch = new Float32Array((L - 1) * 3);
    // Outer group: placement (centroid position + rotation); inner group: anchor frame.
    this.group.name = `molecule-${key}`;
    this.group.position.set(...placement.centre);
    this.group.quaternion.set(...placement.rot);
    this.local.position.set(-model.chain.centroid[0], -model.chain.centroid[1], -model.chain.centroid[2]);
    this.group.add(this.local);
    this.group.updateMatrixWorld(true);

    this.regionIds = model.isoform.regions.map((r) => r.id);
    this.regionIdx = new Uint8Array(L);
    this.radii = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const r = regionOf(model.isoform, i);
      this.regionIdx[i] = this.regionIds.indexOf(r.id);
      this.radii[i] = r.id === 'polya' ? POLYA_RADIUS : BACKBONE_RADIUS;
    }
    // Taper the last few nt of the tail.
    for (let i = 0; i < 6; i++) this.radii[L - 1 - i] *= 0.6 + i * 0.07;

    this.tubes = new DynamicTubes([{ count: L, radius: this.radii }], 8);
    const backbone = new THREE.Mesh(this.tubes.geometry, backboneMat);
    backbone.frustumCulled = false;
    backbone.name = 'backbone';
    this.local.add(backbone);

    this.bases = new THREE.InstancedMesh(stickGeometry(5), baseMat, L);
    this.bases.frustumCulled = false;
    this.bases.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bases.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L * 3), 3);
    this.local.add(this.bases);

    this.cap = new THREE.Mesh(new THREE.IcosahedronGeometry(CAP_RADIUS, 3), capMat);
    this.capStub = new THREE.Mesh(stickGeometry(6), capMat);
    this.local.add(this.cap, this.capStub);

    this.applyColors();
    this.buildLabels();
    this.local.add(this.labelRoot);
  }

  private buildLabels(): void {
    const iso = this.model.isoform;
    // Label each region at the point of its middle stretch farthest from the coil centre,
    // so labels sit on the periphery instead of piling up in the middle.
    const rest = this.model.chain.rest;
    const [cx, cy, cz] = this.model.chain.centroid;
    const labelNt = (start: number, end: number, from = 0.2, to = 0.8) => {
      const a = start + Math.floor((end - start) * from);
      const b = start + Math.ceil((end - start) * to);
      let best = a;
      let bestD = -1;
      for (let i = a; i < b; i++) {
        const d = (rest[i * 3] - cx) ** 2 + (rest[i * 3 + 1] - cy) ** 2 + (rest[i * 3 + 2] - cz) ** 2;
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };
    for (const r of iso.regions) {
      const el = document.createElement('div');
      el.className = 'mol-label region-label';
      el.innerHTML = `<span class="dot" style="background:${'#' + REGION_COLOR[r.id].getHexString()}"></span>${REGION_NAMES[r.id]}`;
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1.3);
      this.labelRoot.add(obj);
      // The poly(A) label stays near the tail's base, clear of the 3′ end label.
      const nt = r.id === 'polya' ? labelNt(r.start, r.end, 0.15, 0.45) : labelNt(r.start, r.end);
      this.labels.push({ obj, nt, region: r.id });
    }
    const capEl = document.createElement('div');
    capEl.className = 'mol-label region-label';
    capEl.innerHTML = `<span class="dot" style="background:#${CAP_COLOR.getHexString()}"></span>5′ cap (m7G)`;
    const cap = new CSS2DObject(capEl);
    cap.center.set(1.08, 0.5); // to the left of the cap, clear of the 5′UTR label
    this.labelRoot.add(cap);
    this.labels.push({ obj: cap, nt: -1, region: 'end5' });

    const end3 = document.createElement('div');
    end3.className = 'mol-label end-label';
    end3.textContent = '3′';
    const e3 = new CSS2DObject(end3);
    this.labelRoot.add(e3);
    this.labels.push({ obj: e3, nt: this.L - 1, region: 'end3' });
  }

  private labelFlags = { regions: true, ends: true, focused: true };

  setLabelVisibility(regions: boolean, ends: boolean, focused = this.labelFlags.focused): void {
    this.labelFlags = { regions, ends, focused };
    for (const l of this.labels) {
      const isEnd = l.region === 'end3';
      l.obj.visible = focused && (isEnd ? ends : regions);
    }
  }

  get labelSettings(): { regions: boolean; ends: boolean } {
    return { regions: this.labelFlags.regions, ends: this.labelFlags.ends };
  }

  get colorByNtOn(): boolean {
    return this.colorByNt;
  }

  /** Only the molecule being looked at carries labels. */
  setFocused(on: boolean): void {
    if (on !== this.labelFlags.focused) this.setLabelVisibility(this.labelFlags.regions, this.labelFlags.ends, on);
  }

  /** Region labels fade out in close-ups, where they would cover the probes. */
  setLabelFade(opacity: number): void {
    const o = opacity.toFixed(2);
    for (const l of this.labels) {
      if (l.region === 'end3') continue;
      if (l.obj.element.style.opacity !== o) l.obj.element.style.opacity = o;
    }
  }

  setColorByNt(on: boolean): void {
    if (on === this.colorByNt) return;
    this.colorByNt = on;
    this.applyColors();
  }

  setHighlight(region: RegionId | null): void {
    if (region === this.highlight) return;
    this.highlight = region;
    this.applyColors();
    for (const l of this.labels) l.obj.element.classList.toggle('hot', l.region === region);
  }

  private applyColors(): void {
    const c = new THREE.Color();
    const seq = this.model.isoform.seq;
    const baseCol = this.bases.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.L; i++) {
      const id = this.regionIds[this.regionIdx[i]];
      c.copy(REGION_COLOR[id]);
      if (this.highlight === id) c.lerp(new THREE.Color(1, 1, 1), 0.28).multiplyScalar(1.25);
      else if (this.highlight) c.multiplyScalar(0.55);
      this.tubes.setPointColor(0, i, c.r, c.g, c.b);
      const bc = this.colorByNt ? NT_COLOR[seq[i]] ?? c : c;
      const k = this.colorByNt ? 1 : 1.25;
      baseCol[i * 3] = bc.r * k;
      baseCol[i * 3 + 1] = bc.g * k;
      baseCol[i * 3 + 2] = bc.b * k;
    }
    this.tubes.markColorsDirty();
    this.bases.instanceColor!.needsUpdate = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Recompute the pose from `zip` and rebuild geometry. */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const m = this.model;
    const frames = m.sites.map((s) => s.frame);
    computePose(m.chain, frames, m.siteOf, this.zip, this.h, this.positions, this.scratch);
    this.tubes.update(this.positions, this.thicken);
    this.updateBases();
    this.updateCap();
    this.updateLabels();
  }

  private updateBases(): void {
    const m = this.model;
    const P = this.positions;
    const D = m.chain.baseDir0;
    const out = this.bases.instanceMatrix.array as Float32Array;
    const grow = this.baseGrow;
    const r = BASE_RADIUS * Math.min(this.thicken, 1.6);
    for (let i = 0; i < this.L; i++) {
      let dx = D[i * 3];
      let dy = D[i * 3 + 1];
      let dz = D[i * 3 + 2];
      let length = BASE_LEN_FREE;
      const si = m.siteOf[i];
      const b = si >= 0 ? this.zip[i] : 0;
      if (b > 0) {
        const f = m.sites[si].frame;
        const rad = radialAt(f, i - f.start, this.h);
        dx += (-rad[0] - dx) * b;
        dy += (-rad[1] - dy) * b;
        dz += (-rad[2] - dz) * b;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;
        const bound = (HYBRID_RADIUS - BACKBONE_RADIUS - 0.04) * this.h;
        length += (bound - length) * b;
      }
      const l = length * grow;
      const off = this.radii[i] * this.thicken * 0.8;
      stickMatrix(
        out,
        i,
        P[i * 3] + dx * off,
        P[i * 3 + 1] + dy * off,
        P[i * 3 + 2] + dz * off,
        dx,
        dy,
        dz,
        Math.max(1e-4, l),
        l > 1e-3 ? r : 0,
      );
    }
    this.bases.instanceMatrix.needsUpdate = true;
    this.bases.visible = grow > 0.001;
  }

  private updateCap(): void {
    const P = this.positions;
    // Outward from the 5′ end, opposite the first step.
    const tx = P[0] - P[3];
    const ty = P[1] - P[4];
    const tz = P[2] - P[5];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const s = this.capScale;
    const stubLen = 1.3 * Math.max(1, s * 0.6);
    const cx = P[0] + (tx / tl) * (stubLen + CAP_RADIUS * s);
    const cy = P[1] + (ty / tl) * (stubLen + CAP_RADIUS * s);
    const cz = P[2] + (tz / tl) * (stubLen + CAP_RADIUS * s);
    this.cap.position.set(cx, cy, cz);
    this.cap.scale.setScalar(s);
    const m = new Float32Array(16);
    // 5′–5′ triphosphate stub.
    stickMatrix(m, 0, P[0], P[1], P[2], tx / tl, ty / tl, tz / tl, stubLen, 0.22 * Math.min(s, 2));
    this.capStub.matrixAutoUpdate = false;
    this.capStub.matrix.fromArray(m);
  }

  private updateLabels(): void {
    const P = this.positions;
    for (const l of this.labels) {
      if (l.nt < 0) {
        l.obj.position.copy(this.cap.position);
      } else {
        l.obj.position.set(P[l.nt * 3], P[l.nt * 3 + 1], P[l.nt * 3 + 2]);
      }
    }
  }

  /** Molecule-local position of nt i. */
  ntPosition(i: number): Vec3 {
    return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }

  /** Scene-space position of nt i. */
  ntWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return this.localToScene(out.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]));
  }

  /** Anchor-frame point → molecular-scene nm (in place). */
  localToScene(v: THREE.Vector3): THREE.Vector3 {
    return v.applyMatrix4(this.local.matrixWorld);
  }

  /** Scene-space ray → anchor frame. */
  rayToLocal(ray: THREE.Ray): THREE.Ray {
    this.invLocal.copy(this.local.matrixWorld).invert();
    return ray.clone().applyMatrix4(this.invLocal);
  }

  /** Scene-space centre of the coil. */
  get centre(): THREE.Vector3 {
    return this.group.position.clone();
  }

  dispose(): void {
    this.tubes.dispose();
    this.bases.dispose();
    this.cap.geometry.dispose();
    this.capStub.geometry.dispose();
    for (const l of this.labels) l.obj.element.remove();
    this.group.removeFromParent();
  }

  /** Nearest nt to a ray within `tol` nm (scene space). */
  pick(sceneRay: THREE.Ray, tol: number): { nt: number; dist: number } | null {
    const ray = this.rayToLocal(sceneRay);
    const P = this.positions;
    const v = new THREE.Vector3();
    let best = -1;
    let bestT = Infinity;
    const tol2 = tol * tol;
    for (let i = 0; i < this.L; i++) {
      v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      const t = (v.x - ray.origin.x) * ray.direction.x + (v.y - ray.origin.y) * ray.direction.y + (v.z - ray.origin.z) * ray.direction.z;
      if (t <= 0 || t > bestT) continue;
      if (ray.distanceSqToPoint(v) < tol2) {
        best = i;
        bestT = t;
      }
    }
    if (best < 0) {
      // Also allow picking the cap.
      const c = this.cap.position;
      if (ray.distanceSqToPoint(c) < (CAP_RADIUS * this.capScale + tol) ** 2) return { nt: -1, dist: c.distanceTo(ray.origin) };
      return null;
    }
    return { nt: best, dist: bestT };
  }


}
