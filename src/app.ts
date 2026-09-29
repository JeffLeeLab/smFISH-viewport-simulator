/**
 * App orchestration: store ↔ scenes wiring, stage flights, the render loop and input.
 */
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { AppState, Stage, Store } from './state/store';
import type { WorldModel } from './data/model';
import { makeCellShape, type CellShape } from './data/cell';
import { Renderer } from './core/renderer';
import { CameraRig, type View } from './core/cameraRig';
import { BASE_LOD, MOLECULE_FIT_NM, sceneWeights, smoothstep, stageForScale, STAGE_FOV_NM, type SceneWeights } from './core/scale';
import { QualityManager } from './core/quality';
import { MolecularScene, NEAR_CLIP } from './scenes/molecular/molecularScene';
import { OpticalScene } from './scenes/optical/opticalScene';
import { CellScene } from './scenes/cell/cellScene';
import { LabBackdrop } from './scenes/cell/labBackdrop';
import { Panel } from './ui/panel';
import { Hud } from './ui/hud';
import { Captions } from './ui/captions';
import { Tooltip } from './ui/tooltip';
import { Help } from './ui/help';
import { bindKeyboard } from './ui/keyboard';
import { REGION_NAMES, regionOf } from './data/transcript';
import { makeRecords, nearestRecords, recordDyes, recordKind, type RnaRecord } from './data/population';
import { FEATURED_FACING, rotate } from './data/model';
import { MAX_SPOTS, type OpticalSpotInput } from './scenes/optical/opticalScene';
import type { BoundDye } from './scenes/molecular/probeSystem';

/** Unit conversion: 1 µm = 1000 nm. */
const NM = 1000;

export class App {
  readonly store: Store;
  readonly world: WorldModel;
  readonly renderer: Renderer;
  readonly rig: CameraRig;
  readonly mol: MolecularScene;
  readonly opt: OpticalScene;
  readonly cell: CellScene;
  readonly lab = new LabBackdrop();
  /** Debug hook for tuning the backdrop (null = normal). */
  labGainOverride: number | null = null;
  cellShape: CellShape;
  /** Every RNA in the cell, each a zoomable molecule (regenerated with the cell seed). */
  records: RnaRecord[];
  private generation = 0;
  /** Featured-molecule midpoint in cell-world µm (molecular/optical scene origin). */
  readonly p0 = new THREE.Vector3();
  readonly viewport: HTMLElement;
  private canvas: HTMLCanvasElement;
  private labelRenderers: Record<'mol' | 'opt' | 'cell', CSS2DRenderer>;
  private hud: Hud;
  private panel: Panel;
  private captions: Captions;
  private tooltip: Tooltip;
  private quality: QualityManager;
  private last = performance.now();
  private weights: SceneWeights = { mol: 1, opt: 0, cell: 0 };
  /** Bound fluorophores this frame (the single source of truth for later scenes). */
  private dyes: ReturnType<MolecularScene['boundDyes']> = [];
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private autoStaging = false;
  private pointer = { x: 0, y: 0, inside: false, moved: false };
  private camDirtyTimer = 0;
  private lastCamKey = '';

  constructor(store: Store, world: WorldModel) {
    this.store = store;
    this.world = world;
    this.viewport = document.getElementById('viewport')!;
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.cellShape = makeCellShape(store.state.seed);
    this.p0.set(...this.cellShape.featured);
    this.records = makeRecords(this.cellShape);

    this.rig = new CameraRig(this.canvas);
    this.rig.reducedMotion = this.reducedMotion;
    this.mol = new MolecularScene(world);
    this.renderer = new Renderer(this.canvas, { scene: this.mol.scene, camera: this.mol.camera });
    this.opt = new OpticalScene(world, store);
    this.cell = new CellScene(world, store, this.cellShape, this.records);
    this.renderer.setLayers(
      { scene: this.opt.scene, camera: this.opt.camera },
      { scene: this.cell.scene, camera: this.cell.camera },
      { scene: this.lab.scene, camera: this.lab.camera },
    );
    this.quality = new QualityManager(this.renderer, (level) => {
      this.cell.setQuality(level);
      this.opt.setQuality(level);
      this.resize();
    });

    const labels = document.getElementById('labels')!;
    const mk = () => {
      const r = new CSS2DRenderer();
      labels.append(r.domElement);
      return r;
    };
    this.labelRenderers = { mol: mk(), opt: mk(), cell: mk() };

    this.hud = new Hud(this.viewport);
    this.captions = new Captions(this.viewport, store);
    this.tooltip = new Tooltip(this.viewport);
    new Help(store);
    this.panel = new Panel(document.getElementById('panel')!, store, this);

    this.wireStore();
    bindKeyboard(store, this);
    this.bindPointer();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    // Initial camera: share-link camera if present, else the stage preset.
    const s = store.state;
    if (s.cam.length === 6) this.rig.setView(this.viewFromCam(s.cam));
    else this.rig.setView(this.stageView(s.stage));
    this.rig.onUserInput = () => this.captions.userInteracted();
  }

  start(): void {
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------------------
  // Stage views
  // -------------------------------------------------------------------------------------

  /** Direction (camera offset from target) → camera-controls azimuth/polar (z-up). */
  private anglesFor(dir: THREE.Vector3): { azimuth: number; polar: number } {
    const d = dir.clone().normalize();
    // camera-controls works in a y-up space; map z-up → y-up.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    d.applyQuaternion(q);
    const s = new THREE.Spherical().setFromVector3(d);
    return { azimuth: s.theta, polar: s.phi };
  }

  stageView(stage: Stage, iso: 'long' | 'short' = this.store.state.isoform): View {
    const molToWorld = (v: THREE.Vector3) => v.clone().divideScalar(NM).add(this.p0);
    switch (stage) {
      case 1: {
        const target = molToWorld(this.mol.moleculeCentre(iso));
        // Fit the whole molecule across the view (the FOV is set on the smaller dimension).
        const a = this.rig.viewAspect;
        const fovNm = a < 1 ? MOLECULE_FIT_NM : Math.min(MOLECULE_FIT_NM, Math.max(STAGE_FOV_NM[1], MOLECULE_FIT_NM / a));
        return { target, fovNm, ...this.anglesFor(new THREE.Vector3(...FEATURED_FACING)) };
      }
      case 2:
        return { target: this.p0.clone(), fovNm: STAGE_FOV_NM[2], ...this.anglesFor(new THREE.Vector3(0.1, -1, 0.42)) };
      case 3: {
        const s = this.store.state;
        const target = new THREE.Vector3(0, 0, 2.2);
        if (s.mip) return { target, fovNm: STAGE_FOV_NM[3], ...this.anglesFor(new THREE.Vector3(0.0001, -0.0001, 1)) };
        return { target, fovNm: STAGE_FOV_NM[3], ...this.anglesFor(new THREE.Vector3(0.25, -0.78, 0.95)) };
      }
    }
  }

  private viewFromCam(cam: number[]): View {
    return { target: new THREE.Vector3(cam[0], cam[1], cam[2]), azimuth: cam[3], polar: cam[4], fovNm: Math.pow(10, cam[5]) };
  }

  /** Stage button / key: fly there and set up stage behaviour. */
  goToStage(stage: Stage): void {
    this.autoStaging = true;
    this.store.set({ stage, cam: [], ...this.stageEntryPatch(stage, this.store.state.stage) });
    this.autoStaging = false;
    void this.rig.flyTo(this.stageView(stage));
  }

  /**
   * What moving to a stage implies. Stages 2–3 image a finished experiment: if the probes
   * aren't bound yet, bind and wash them; leaving stage 1 with bound but unwashed probes
   * washes them, as a real protocol would before imaging. (Unwashed images stay available
   * through the Washed toggle in stages 2–3.) Stage 1 waits for H.
   */
  private stageEntryPatch(stage: Stage, from: Stage): Partial<AppState> {
    const s = this.store.state;
    if (stage >= 2 && s.hyb !== 'bound') return { hyb: 'bound', washed: true };
    if (stage >= 2 && from === 1 && !s.washed) return { washed: true };
    return {};
  }

  resetCamera(): void {
    void this.rig.flyTo(this.stageView(this.store.state.stage));
  }

  // -------------------------------------------------------------------------------------
  // Store wiring
  // -------------------------------------------------------------------------------------

  private wireStore(): void {
    const st = this.store;
    st.watch(['probesPerSet'], (s) => {
      this.mol.configureProbes(s.probesPerSet, s.hyb !== 'none');
      if (s.hyb === 'running') this.startHybridisation(false);
      else if (s.hyb === 'bound') this.forEachProbes((p) => p.finish());
    });
    let prevHyb = st.state.hyb;
    st.watch(['hyb'], (s) => {
      if (s.hyb === 'running') this.startHybridisation(prevHyb === 'bound');
      else if (s.hyb === 'bound' && prevHyb !== 'running') this.forEachProbes((p) => p.finish());
      else if (s.hyb === 'bound') this.forEachProbes((p) => (p.running = false));
      else if (s.hyb === 'none') this.forEachProbes((p) => p.reset());
      prevHyb = s.hyb;
    });
    st.watch(['washed'], (s) => this.forEachProbes((p) => (p.washed = s.washed)));
    st.watch(['helical'], (s) => (this.mol.hTarget = s.helical ? 1 : 0));
    st.watch(['showCdsSet', 'showDistalSet'], (s) => {
      this.mol.markDirty();
      this.mol.setShowSet('cds', s.showCdsSet);
      this.mol.setShowSet('distal', s.showDistalSet);
    });
    st.watch(['labels', 'showEnds'], (s) => {
      for (const v of Object.values(this.mol.views)) v.setLabelVisibility(s.labels, s.showEnds);
    });
    st.watch(['colorByNt'], (s) => {
      for (const v of Object.values(this.mol.views)) v.setColorByNt(s.colorByNt);
    });
    st.watch(['autoRotate'], (s) => (this.rig.autoRotateSpeed = s.autoRotate && !this.reducedMotion ? 0.12 : 0));
    let prevIso = st.state.isoform;
    st.watch(['isoform'], (s) => {
      if (s.isoform !== prevIso && s.stage === 1) void this.rig.flyTo(this.stageView(s.stage, s.isoform));
      prevIso = s.isoform;
    });
    let prevStage = st.state.stage;
    st.watch(['stage'], (s) => {
      // Stage changes from outside the app (e.g. hash edits) also fly the camera.
      if (!this.autoStaging && s.stage !== prevStage) {
        const patch = this.stageEntryPatch(s.stage, prevStage);
        if (Object.keys(patch).length) st.set(patch);
        void this.rig.flyTo(this.stageView(s.stage));
      }
      prevStage = s.stage;
      document.body.dataset.stage = String(s.stage);
    });
    st.watch(['mip'], (s) => {
      if (s.stage === 3) void this.rig.flyTo(this.stageView(3));
    });
    st.watch(['seed'], (s) => {
      if (s.seed === this.cellShape.seed) return;
      const prev = this.p0.clone();
      this.cellShape = makeCellShape(s.seed);
      this.p0.set(...this.cellShape.featured);
      // Keep the view locked on whatever it was showing if that was the molecules.
      if (this.store.state.stage < 3) this.rig.shift(this.p0.clone().sub(prev));
      this.records = makeRecords(this.cellShape);
      this.generation++;
      this.cell.setShape(this.cellShape, this.records);
    });
    st.watch(['presentation'], (s) => {
      document.body.classList.toggle('presentation', s.presentation);
      requestAnimationFrame(() => this.resize());
    });
  }

  private forEachProbes(fn: (p: MolecularScene['probes']['long']) => void): void {
    fn(this.mol.probes.long);
    fn(this.mol.probes.short);
    this.mol.markDirty();
  }

  private startHybridisation(_replay: boolean): void {
    this.forEachProbes((p) => {
      p.washed = false;
      p.start();
    });
    if (this.store.state.washed) this.store.set({ washed: false });
  }

  // -------------------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------------------

  private resize(): void {
    const r = this.viewport.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / h);
    for (const lr of Object.values(this.labelRenderers)) lr.setSize(w, h);
    for (const c of [this.mol.camera, this.opt.camera, this.cell.camera]) {
      c.aspect = w / h;
      c.updateProjectionMatrix();
    }
    this.opt.setViewportSize(w, h);
    this.cell.setViewportSize(w, h);
  }

  /** Derive each scene's camera from the master camera (spec §3). */
  private syncCameras(): void {
    const master = this.rig.camera;
    const dist = this.rig.controls.distance; // µm
    const q = master.quaternion;

    const mc = this.mol.camera;
    mc.position.copy(master.position).sub(this.p0).multiplyScalar(NM);
    mc.quaternion.copy(q);
    mc.near = dist * NM * NEAR_CLIP;
    mc.far = dist * NM * 8;
    mc.updateProjectionMatrix();
    mc.updateMatrixWorld();

    const oc = this.opt.camera;
    oc.position.copy(master.position).sub(this.p0);
    oc.quaternion.copy(q);
    oc.near = dist * 0.05;
    oc.far = dist * 50;
    oc.updateProjectionMatrix();
    oc.updateMatrixWorld();

    const cc = this.cell.camera;
    cc.position.copy(master.position);
    cc.quaternion.copy(q);
    cc.near = dist * 0.02;
    cc.far = dist * 50;
    cc.updateProjectionMatrix();
    cc.updateMatrixWorld();
  }

  private frame(dt: number): void {
    const s = this.store.state;
    this.quality.sample(dt);
    this.rig.update(dt);
    this.syncCameras();

    const scale = this.rig.s;
    const w = (this.weights = sceneWeights(scale));
    const { width, height } = this.renderer.size;
    const nmPerPx = this.rig.nmPerPx(height);
    const target = this.rig.target;
    const molTarget = target.clone().sub(this.p0).multiplyScalar(NM);
    const camDistNm = this.rig.controls.distance * NM;

    // Full molecular detail for whichever cell RNAs are near the camera.
    this.mol.syncPopulation({
      generation: this.generation,
      records: this.records,
      lib: this.world.library,
      longFraction: s.longFraction,
      p0: this.p0,
      target,
      fovNm: Math.pow(10, scale),
      now: performance.now() / 1000,
    });

    // Molecular scene.
    const animDt = dt * s.animSpeed;
    if (w.mol > 0.001 || this.mol.busy) {
      const baseGrow = 1 - smoothstep(BASE_LOD[0], BASE_LOD[1], scale);
      this.mol.update(dt, animDt, nmPerPx, camDistNm, molTarget, baseGrow, this.reducedMotion, this.renderer.gl.getPixelRatio());
      this.renderer.focusMolecular(molTarget, camDistNm);
    }
    if (s.hyb === 'running' && this.mol.probes.long.complete && this.mol.probes.short.complete && this.mol.probes.long.clock > 1) {
      this.store.set({ hyb: 'bound' });
    }

    // Optical and cell scenes.
    const dyes = (this.dyes = this.mol.boundDyes());
    if (w.opt > 0.001 || s.stage === 2) this.opt.update(dt, this.opticalSpots(target, dyes), scale, nmPerPx, w.opt, target.clone().sub(this.p0));
    this.cell.update(dt, dyes, this.p0, scale, nmPerPx, w.cell);

    this.renderer.dofEnabled = this.quality.level === 0;
    this.lab.sync(this.rig.camera.quaternion, width / Math.max(1, height));
    // The lab sits dimly behind the cell; dimmer still in the flat MIP view.
    this.renderer.labGain = this.labGainOverride ?? (s.labBackdrop ? (s.mip ? 0.35 : 0.7) : 0);
    this.renderer.render(w, dt);

    // Labels per scene, faded with the scene weight.
    const lr = this.labelRenderers;
    const layers: [keyof typeof lr, number, THREE.Scene, THREE.Camera][] = [
      ['mol', w.mol, this.mol.scene, this.mol.camera],
      ['opt', w.opt, this.opt.scene, this.opt.camera],
      ['cell', w.cell, this.cell.scene, this.cell.camera],
    ];
    for (const [k, weight, scene, cam] of layers) {
      const vis = weight > 0.05;
      lr[k].domElement.style.opacity = String(Math.min(1, (weight - 0.05) * 2));
      lr[k].domElement.style.display = vis ? '' : 'none';
      if (vis) lr[k].render(scene, cam);
    }

    // HUD.
    this.hud.update({
      stage: this.displayStage(scale),
      nmPerPx,
      readouts: this.readouts(),
      hint: this.hint(scale),
    });
    this.panel.frame(scale);

    // Follow the scale with the stage selector when the user zooms freely.
    if (!this.rig.flying) this.autoStage(scale);
    this.maybeStoreCamera(width);
    if (this.pointer.moved) {
      this.pointer.moved = false;
      this.updateHover();
    }
  }

  /** The HUD follows the actual scale, including mid-flight. */
  private displayStage(scale: number): Stage {
    return stageForScale(scale);
  }

  private autoStage(scale: number): void {
    const cur = this.store.state.stage;
    const want = stageForScale(scale);
    if (want === cur) return;
    // Hysteresis: only switch once clearly inside the new stage's range.
    const fov = Math.pow(10, scale);
    const clear =
      (want === 1 && fov < 560) || (want === 2 && fov > 760 && fov < 5200) || (want === 3 && fov > 7000);
    if (!clear) return;
    this.autoStaging = true;
    // Zooming out of stage 1 onto the spots also washes (not binding: that stays up to H).
    const wash = cur === 1 && want >= 2 && this.store.state.hyb === 'bound' && !this.store.state.washed;
    this.store.set({ stage: want, ...(wash ? { washed: true } : {}) });
    this.autoStaging = false;
  }

  /** Persist the camera to the URL hash once it has been still for a moment. */
  private maybeStoreCamera(_w: number): void {
    const v = this.rig.getView();
    const cam = [v.target.x, v.target.y, v.target.z, v.azimuth, v.polar, Math.log10(v.fovNm)];
    const key = cam.map((x) => x.toFixed(3)).join(',');
    if (key === this.lastCamKey) return;
    this.lastCamKey = key;
    window.clearTimeout(this.camDirtyTimer);
    this.camDirtyTimer = window.setTimeout(() => {
      if (!this.rig.flying) this.store.set({ cam });
    }, 900);
  }

  /**
   * PSF spots for the RNAs around the camera target (optical µm). Molecules shown in full
   * detail supply their live dyes; the rest use the same geometry from the library.
   */
  private opticalSpots(target: THREE.Vector3, live: BoundDye[]): OpticalSpotInput[] {
    const s = this.store.state;
    const fovUm = Math.pow(10, this.rig.s) / 1000;
    const near = nearestRecords(this.records, [target.x, target.y, target.z], Math.max(1.5, fovUm * 0.8), MAX_SPOTS);
    const byKey = new Map<string, BoundDye[]>();
    for (const d of live) byKey.set(d.molecule, [...(byKey.get(d.molecule) ?? []), d]);
    const h = s.helical ? 1 : 0;
    const out: OpticalSpotInput[] = [];
    for (const r of near) {
      const kind = recordKind(r, s.longFraction);
      const mine = byKey.get(r.key);
      let dyes: OpticalSpotInput['dyes'] = [];
      if (mine) {
        dyes = mine.map((d) => ({ x: d.pos.x / 1000, y: d.pos.y / 1000, z: d.pos.z / 1000, set: d.set, weight: d.weight }));
      } else if (s.hyb === 'bound') {
        dyes = recordDyes(this.world.library, r, s.probesPerSet, h, s.longFraction).map((d) => ({
          x: d.pos[0] - this.p0.x,
          y: d.pos[1] - this.p0.y,
          z: d.pos[2] - this.p0.z,
          set: d.set,
          weight: 1,
        }));
      }
      if (dyes.length) out.push({ key: r.key, kind, dyes });
    }
    return out;
  }

  /** The cell RNA under a cell-world ray (µm), nearest along the ray. */
  private pickRecord(ray: THREE.Ray, tolUm: number): RnaRecord | null {
    let best: RnaRecord | null = null;
    let bestT = Infinity;
    const v = new THREE.Vector3();
    for (const r of this.records) {
      v.set(r.x, r.y, r.z);
      const t = v.clone().sub(ray.origin).dot(ray.direction);
      if (t <= 0 || t >= bestT) continue;
      if (ray.distanceSqToPoint(v) < tolUm * tolUm) {
        best = r;
        bestT = t;
      }
    }
    return best;
  }

  /**
   * Double-click zoom: from the cell to one RNA's diffraction-limited spot, and from a spot
   * to the molecule itself (facing its folded strand).
   */
  private zoomTo(r: RnaRecord): void {
    const fov = Math.pow(10, this.rig.s);
    const v = this.rig.getView();
    const target = new THREE.Vector3(r.x, r.y, r.z);
    if (fov > 3200) {
      void this.rig.flyTo({ ...v, target, fovNm: 2800 });
      this.opt.selected = r.key;
      return;
    }
    // Face the molecule's plane from whichever side the camera is on.
    const n = new THREE.Vector3(...rotate(r.rot, [0, 0, 1]));
    const camDir = this.rig.camera.position.clone().sub(this.rig.target).normalize();
    if (n.dot(camDir) < 0) n.negate();
    if (Math.abs(n.z) > 0.97) n.x += 0.05;
    void this.rig.flyTo({ target, fovNm: MOLECULE_FIT_NM, ...this.anglesFor(n) });
    this.opt.selected = r.key;
  }

  private readouts(): { k: string; v: string; cls?: string }[] {
    const scale = this.rig.s;
    const stage = this.displayStage(scale);
    if (stage === 2) return this.opt.readouts();
    if (stage === 3) return this.cell.readouts();
    const s = this.store.state;
    const out: { k: string; v: string; cls?: string }[] = [];
    if (s.hyb !== 'none') {
      const n = (id: 'long' | 'short', set: 'cds' | 'distal') =>
        this.dyes.filter((d) => d.molecule === `featured-${id}` && d.set === set && d.weight > 0.99).length;
      out.push({ k: 'bound (long)', v: `${n('long', 'cds')} magenta · ${n('long', 'distal')} green` });
      out.push({ k: 'bound (short)', v: `${n('short', 'cds')} magenta · ${n('short', 'distal')} green` });
      out.push({ k: 'unbound probes', v: s.washed ? 'washed away' : 'still present' });
    }
    return out;
  }

  private hint(scale: number): string {
    const s = this.store.state;
    const stage = this.displayStage(scale);
    if (s.hyb !== 'none' && !s.washed && stage >= 2) return 'Unbound probes haven’t been washed away, so the background is high. Press <kbd>W</kbd> to wash.';
    if (s.hyb !== 'none') return '';
    if (stage === 1) return 'Press <kbd>H</kbd> to add probes and watch them hybridise.';
    return 'No probes bound yet. Press <kbd>H</kbd> to hybridise, or <kbd>2</kbd> to jump ahead.';
    return '';
  }

  // -------------------------------------------------------------------------------------
  // Pointer: hover highlight and tooltips
  // -------------------------------------------------------------------------------------

  private bindPointer(): void {
    const c = this.canvas;
    // Focal-plane dragging and spot selection in the optical scene. Capture phase on the
    // viewport runs before camera-controls' own listener on the canvas.
    let drag: { id: number; y0: number; z0: number; pxPerUm: number } | null = null;
    let down: { x: number; y: number } | null = null;
    this.viewport.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== c || this.weights.opt < 0.5) return;
        down = { x: e.clientX, y: e.clientY };
        // Modifier-drag always pans; only a plain left-drag moves the focal plane.
        if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
        const ray = this.rayFor(e, this.opt.camera);
        if (!this.opt.hitFocalPlane(ray)) return;
        // How many px the screen moves per µm of z at the plane centre.
        const { width, height } = this.renderer.size;
        const a = new THREE.Vector3(0, 0, this.opt.focalZ).project(this.opt.camera);
        const b = new THREE.Vector3(0, 0, this.opt.focalZ + 1).project(this.opt.camera);
        const pxPerUm = ((b.y - a.y) * height) / 2;
        if (Math.abs(pxPerUm) < 20 || Math.hypot((b.x - a.x) * width, (b.y - a.y) * height) < 20) return;
        drag = { id: e.pointerId, y0: e.clientY, z0: this.store.state.focalZ, pxPerUm };
        this.rig.controls.enabled = false;
        this.viewport.classList.add('dragging-plane');
        c.setPointerCapture(e.pointerId);
        e.stopPropagation();
      },
      { capture: true },
    );
    c.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dz = -(e.clientY - drag.y0) / drag.pxPerUm;
      const z = Math.max(-1.6, Math.min(1.6, drag.z0 + dz));
      this.store.set({ focalZ: Math.round(z * 200) / 200 });
    });
    const endDrag = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) {
        drag = null;
        this.rig.controls.enabled = true;
        this.viewport.classList.remove('dragging-plane');
        return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && this.weights.opt >= 0.5) {
        const id = this.opt.pickSpot(this.rayFor(e, this.opt.camera));
        if (id) this.opt.selected = id;
      }
      down = null;
    };
    c.addEventListener('dblclick', (e) => {
      const r0 = c.getBoundingClientRect();
      const p = { x: e.clientX - r0.left, y: e.clientY - r0.top };
      if (this.weights.mol >= 0.5) {
        // In the molecular view: zoom in on the point under the cursor.
        const { width, height } = this.renderer.size;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2((p.x / width) * 2 - 1, -(p.y / height) * 2 + 1), this.mol.camera);
        const hit = this.mol.pick(rc.ray, Math.max(0.8, this.rig.nmPerPx(height) * 6));
        if (hit && hit.kind === 'nt') {
          const v = this.mol.viewByKey(hit.molecule);
          if (v && hit.nt >= 0) {
            const t = v.ntWorld(hit.nt).divideScalar(NM).add(this.p0);
            void this.rig.flyTo({ ...this.rig.getView(), target: t, fovNm: Math.max(40, Math.pow(10, this.rig.s) / 4) });
          }
        }
        return;
      }
      const r = this.recordUnderPointer(p);
      if (r) this.zoomTo(r);
    });
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      this.pointer.inside = true;
      this.pointer.moved = true;
    });
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.pointer.moved = true;
    });
  }

  private rayFor(e: { clientX: number; clientY: number }, cam: THREE.Camera): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    return rc.ray;
  }

  private updateHover(): void {
    const { width, height } = this.renderer.size;
    for (const v of this.mol.allViews()) v.setHighlight(null);
    this.tooltip.hide();
    this.viewport.classList.remove('hovering');
    if (!this.pointer.inside || this.rig.flying) return;
    if (this.weights.mol < 0.5) {
      this.hoverRecord();
      return;
    }
    const ndc = new THREE.Vector2((this.pointer.x / width) * 2 - 1, -(this.pointer.y / height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.mol.camera);
    const nmPerPx = this.rig.nmPerPx(height);
    const hit = this.mol.pick(ray.ray, Math.max(0.8, nmPerPx * 6));
    if (!hit) return;
    this.viewport.classList.add('hovering');
    if (hit.kind === 'probe') {
      this.tooltip.showProbe(hit.probe, hit.bound, this.pointer.x, this.pointer.y);
      return;
    }
    const view = this.mol.viewByKey(hit.molecule);
    if (!view) return;
    if (hit.nt < 0) {
      this.tooltip.showText('5′ cap (m7G)', '7-methylguanosine joined 5′–5′ by a triphosphate bridge. Protects the mRNA and recruits the ribosome.', this.pointer.x, this.pointer.y);
      return;
    }
    const region = regionOf(view.model.isoform, hit.nt);
    view.setHighlight(region.id);
    const isoName = view.model.kind === 'nascent' ? 'nascent RNA' : `${view.model.kind} isoform`;
    this.tooltip.showText(
      REGION_NAMES[region.id],
      `${region.end - region.start} nt · ${isoName}<br><span class="seq">nt ${hit.nt + 1}: ${view.model.isoform.seq[hit.nt]}</span>`,
      this.pointer.x,
      this.pointer.y,
    );
  }

  /** Hover in the optical and cell views: which RNA is under the pointer. */
  private hoverRecord(): void {
    const r = this.recordUnderPointer(this.pointer);
    if (!r) return;
    this.viewport.classList.add('hovering');
    const kind = recordKind(r, this.store.state.longFraction);
    const what =
      kind === 'long'
        ? 'Long isoform · both probe sets (white in merge)'
        : kind === 'short'
          ? 'Short isoform · CDS probes only (magenta)'
          : `Nascent RNA at a transcription site · ${Math.round((r.progress ?? 0) * 100)}% transcribed`;
    const hint = Math.pow(10, this.rig.s) > 3200 ? 'Double-click to zoom to its spot' : 'Double-click to zoom into the molecule';
    this.tooltip.showText(r.kind === 'featured' ? 'mRNA (featured)' : 'mRNA', `${what}<br><span style="color:var(--faint)">${hint}</span>`, this.pointer.x, this.pointer.y);
  }

  private recordUnderPointer(e: { x: number; y: number }): RnaRecord | null {
    const { width, height } = this.renderer.size;
    const ndc = new THREE.Vector2((e.x / width) * 2 - 1, -(e.y / height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.cell.camera);
    const umPerPx = this.rig.nmPerPx(height) / 1000;
    return this.pickRecord(rc.ray, Math.max(0.12, umPerPx * 10));
  }

  screenshot(): void {
    this.renderer.render(this.weights, 0);
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `smfish-stage${this.store.state.stage}.png`;
    a.click();
  }
}
