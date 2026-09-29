/**
 * Molecular scene (1 unit = 1 nm), origin at the midpoint of the two featured molecules.
 */
import * as THREE from 'three';
import { featuredPlacement, type MoleculeLibrary, type MoleculeModel, type WorldModel } from '../../data/model';
import { nearestRecords, recordModel, type RnaRecord } from '../../data/population';
import type { ProbeSetId } from '../../data/probes';
import { MoleculeView } from './moleculeView';
import { ProbeSystem, type BoundDye, type ProbeMaterials } from './probeSystem';
import { CAP_COLOR, SET_COLOR } from '../palette';
import { BACKGROUND } from '../../core/renderer';

const N_DYE_LIGHTS = 8;
/** Near clip plane as a fraction of camera distance (cuts away strands in front). */
export const NEAR_CLIP = 0.58;

export function haloMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uWorldSize: { value: 3.2 },
      uMinPx: { value: 9 },
      uPxPerUnit: { value: 1 },
      uGain: { value: 1 },
      uDpr: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float intensity;
      uniform float uWorldSize, uMinPx, uPxPerUnit, uDpr;
      varying vec3 vColor;
      varying float vI;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // Perspective size in px, never below uMinPx.
        float px = uWorldSize * uPxPerUnit / max(1e-6, -mv.z);
        gl_PointSize = max(px, uMinPx) * uDpr * step(0.001, intensity);
        vColor = color;
        vI = intensity * min(1.0, px / uMinPx + 0.6);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uGain;
      varying vec3 vColor;
      varying float vI;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        float a = exp(-r2 * 4.5) * (1.0 - smoothstep(0.7, 1.0, r2));
        gl_FragColor = vec4(vColor * a * vI * uGain, 1.0);
      }
    `,
    // Additive colour that leaves destination alpha alone, so halos don't punch holes in the
    // background layer.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    transparent: true,
  });
}

/**
 * Lets vertex/instance colours glow slightly when zoomed out, so the thin strand still reads
 * as coloured regions at 300 nm; close up, shading is purely lit.
 */
function addSelfGlow(mat: THREE.Material, glow: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSelfGlow = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uSelfGlow;\nvoid main() {')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * uSelfGlow;\n#endif',
      );
  };
}

/**
 * Faint drifting specks that suggest a crowded cytoplasm (spec §5). The field lives in a box
 * around the camera target that scales with zoom, so it reads the same at every scale.
 */
class ParticleField {
  readonly points: THREE.Points;
  private base: Float32Array;
  private vel: Float32Array;
  private pos: THREE.BufferAttribute;
  constructor(n = 700) {
    const rng = Math.random;
    this.base = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      this.base[i] = rng() * 2 - 1;
      this.vel[i] = (rng() * 2 - 1) * 0.012;
    }
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(this.base), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = 1 + rng() * 1.6;
    g.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: { uDpr: { value: 1 }, uAlpha: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float size;
          uniform float uDpr;
          varying float vA;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = size * uDpr;
            // Fade with distance from the focal region (the box centre).
            vA = 1.0 - smoothstep(0.35, 1.0, length(position));
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uAlpha;
          varying float vA;
          void main() {
            vec2 d = gl_PointCoord - 0.5;
            float a = smoothstep(0.25, 0.0, dot(d, d)) * vA * uAlpha;
            gl_FragColor = vec4(vec3(0.32, 0.38, 0.52) * a * 0.22, 0.0);
          }
        `,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthWrite: false,
        transparent: true,
        fog: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
  }

  update(dt: number, target: THREE.Vector3, camDist: number, dpr: number, still: boolean): void {
    if (!still) {
      const b = this.base;
      for (let i = 0; i < b.length; i++) {
        b[i] += this.vel[i] * dt;
        if (b[i] > 1) b[i] -= 2;
        else if (b[i] < -1) b[i] += 2;
      }
      (this.pos.array as Float32Array).set(b);
      this.pos.needsUpdate = true;
    }
    this.points.position.copy(target);
    this.points.scale.setScalar(camDist * 0.9);
    (this.points.material as THREE.ShaderMaterial).uniforms.uDpr.value = dpr;
  }
}

interface Instance {
  view: MoleculeView;
  probes: ProbeSystem;
  modelKey: string;
  lastSeen: number;
}

/** Most extra (non-featured) molecules kept in full detail at once. */
const MAX_EXTRA = 8;

export class MolecularScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly views: Record<'long' | 'short', MoleculeView>;
  readonly probes: Record<'long' | 'short', ProbeSystem>;
  private dyeLights: THREE.PointLight[] = [];
  private keyLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private halo: THREE.ShaderMaterial;
  private world: WorldModel;
  /** Molecules from the cell population shown in full detail near the camera. */
  private extra = new Map<string, Instance>();
  private generation = -1;
  private mats: {
    backbone: THREE.Material;
    base: THREE.Material;
    cap: THREE.Material;
    probes: ProbeMaterials;
  };
  hTarget = 0;
  h = 0;
  private selfGlow = { value: 0 };
  private particles = new ParticleField();

  constructor(world: WorldModel) {
    this.world = world;
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1e5);
    this.camera.up.set(0, 0, 1);
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(BACKGROUND.getHex(), 0.001);

    // Lighting: soft sky/ground fill, a camera-mounted key light and a rim light.
    this.scene.add(new THREE.HemisphereLight(0xa9bcff, 0x201418, 1.1));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    this.rimLight = new THREE.DirectionalLight(0x9fc7ff, 1.6);
    this.camera.add(this.keyLight, this.keyLight.target, this.rimLight, this.rimLight.target);
    this.keyLight.position.set(-0.6, 0.8, 0.4);
    this.keyLight.target.position.set(0, 0, -1);
    this.rimLight.position.set(0.7, -0.3, -1.2);
    this.rimLight.target.position.set(0, 0, 0);
    this.scene.add(this.camera);
    for (let i = 0; i < N_DYE_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      this.dyeLights.push(l);
      this.scene.add(l);
    }

    const backboneMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.32,
      sheen: 0.4,
      sheenColor: new THREE.Color(0x8899ff),
    });
    const baseMat = new THREE.MeshPhysicalMaterial({ roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const capMat = new THREE.MeshPhysicalMaterial({
      color: CAP_COLOR,
      emissive: CAP_COLOR,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      clearcoat: 0.8,
      metalness: 0.2,
    });
    const probeMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.3,
      clearcoat: 0.9,
      clearcoatRoughness: 0.18,
    });
    const probeBaseMat = new THREE.MeshPhysicalMaterial({ roughness: 0.45, clearcoat: 0.4 });
    addSelfGlow(backboneMat, this.selfGlow);
    addSelfGlow(baseMat, this.selfGlow);
    const dyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.halo = haloMaterial();

    const mats = { backbone: probeMat, base: probeBaseMat, dye: dyeMat, halo: this.halo };
    this.mats = { backbone: backboneMat, base: baseMat, cap: capMat, probes: mats };
    this.views = {
      long: new MoleculeView(world.long, 'featured-long', featuredPlacement('long'), backboneMat, baseMat, capMat),
      short: new MoleculeView(world.short, 'featured-short', featuredPlacement('short'), backboneMat, baseMat, capMat),
    };
    const design = { cds: world.design.cds, distal: world.design.distal };
    this.probes = {
      long: new ProbeSystem(this.views.long, mats, design),
      short: new ProbeSystem(this.views.short, mats, design),
    };
    for (const v of Object.values(this.views)) {
      this.scene.add(v.group);
      v.update();
    }
    this.scene.add(this.particles.points);
  }

  /** Frames of forced updates left (the model must update even while the scene is hidden). */
  private dirtyFrames = 0;

  markDirty(frames = 4): void {
    this.dirtyFrames = Math.max(this.dirtyFrames, frames);
  }

  /**
   * True while the molecular model needs updating even if the scene is invisible: the
   * optical and cell scenes read fluorophore positions from it.
   */
  get busy(): boolean {
    return this.dirtyFrames > 0 || this.h !== this.hTarget || this.allProbes().some((p) => p.running);
  }

  allViews(): MoleculeView[] {
    return [this.views.long, this.views.short, ...[...this.extra.values()].map((i) => i.view)];
  }

  allProbes(): ProbeSystem[] {
    return [this.probes.long, this.probes.short, ...[...this.extra.values()].map((i) => i.probes)];
  }

  configureProbes(n: number, instantBound: boolean): void {
    for (const p of this.allProbes()) p.configure(n, instantBound);
    this.markDirty();
  }

  setShowSet(set: ProbeSetId, on: boolean): void {
    for (const p of this.allProbes()) p.showSet[set] = on;
  }

  /** Scene-space centre of a featured molecule's coil. */
  moleculeCentre(id: 'long' | 'short'): THREE.Vector3 {
    return this.views[id].centre;
  }

  /**
   * Keep full molecular detail for the cell RNAs near the camera target, so any spot in the
   * cell can be zoomed into. New molecules copy the featured molecules' probe state.
   */
  syncPopulation(o: {
    generation: number;
    records: readonly RnaRecord[];
    lib: MoleculeLibrary;
    longFraction: number;
    p0: THREE.Vector3;
    target: THREE.Vector3;
    fovNm: number;
    now: number;
  }): void {
    if (o.generation !== this.generation) {
      for (const inst of this.extra.values()) this.disposeInstance(inst);
      this.extra.clear();
      this.generation = o.generation;
    }
    if (o.fovNm < 1800) {
      const radius = Math.max(0.5, (o.fovNm / 1000) * 0.9);
      const near = nearestRecords(
        o.records.filter((r) => r.kind !== 'featured'),
        [o.target.x, o.target.y, o.target.z],
        radius,
        5,
      );
      for (const r of near) {
        const model = recordModel(o.lib, r, o.longFraction);
        let inst = this.extra.get(r.key);
        if (inst && inst.modelKey !== model.key) {
          this.disposeInstance(inst);
          this.extra.delete(r.key);
          inst = undefined;
        }
        if (!inst) inst = this.createInstance(r, model, o.p0);
        inst.lastSeen = o.now;
      }
    }
    // Drop molecules that have been out of range for a while, oldest first.
    const list = [...this.extra.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key, inst] of list) {
      if (o.now - inst.lastSeen > 3 || this.extra.size > MAX_EXTRA) {
        this.disposeInstance(inst);
        this.extra.delete(key);
      }
    }
  }

  private createInstance(r: RnaRecord, model: MoleculeModel, p0: THREE.Vector3): Instance {
    const centre: [number, number, number] = [(r.x - p0.x) * 1000, (r.y - p0.y) * 1000, (r.z - p0.z) * 1000];
    const view = new MoleculeView(model, r.key, { centre, rot: r.rot }, this.mats.backbone, this.mats.base, this.mats.cap);
    const ref = this.views.long;
    view.setLabelVisibility(ref.labelSettings.regions, ref.labelSettings.ends, false);
    view.setColorByNt(ref.colorByNtOn);
    view.h = this.h;
    const design = { cds: this.world.design.cds, distal: this.world.design.distal };
    const probes = new ProbeSystem(view, this.mats.probes, design);
    probes.copyStateFrom(this.probes.long);
    this.scene.add(view.group);
    view.markDirty();
    view.update();
    this.markDirty();
    const inst = { view, probes, modelKey: model.key, lastSeen: 0 };
    this.extra.set(r.key, inst);
    return inst;
  }

  private disposeInstance(inst: Instance): void {
    inst.probes.dispose();
    inst.view.dispose();
  }

  /**
   * Per-frame update. `nmPerPx` is the scale at the camera target; `camDist` the camera
   * distance (nm).
   */
  update(dt: number, animDt: number, nmPerPx: number, camDist: number, target: THREE.Vector3, baseGrow: number, reducedMotion: boolean, dpr: number): boolean {
    if (this.dirtyFrames > 0) this.dirtyFrames--;
    // Schematic ↔ helical morph.
    const hSpeed = reducedMotion ? 20 : 2.2;
    this.h += (this.hTarget - this.h) * Math.min(1, dt * hSpeed);
    if (Math.abs(this.h - this.hTarget) < 1e-3) this.h = this.hTarget;

    // Minimum on-screen sizes (spec §4.6).
    const thicken = Math.max(1, (3 * nmPerPx) / (2 * 0.38));
    const capScale = Math.max(1, (8 * nmPerPx) / (2 * 0.95));
    const dyeScale = Math.max(1, (5 * nmPerPx) / (2 * 0.7));

    let changed = false;
    const fovNm = camDist * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const labelFade = Math.min(1, Math.max(0, (fovNm - 70) / 60));
    const g = Math.min(1, Math.max(0, (Math.log10(fovNm) - Math.log10(70)) / (Math.log10(320) - Math.log10(70))));
    this.selfGlow.value = 0.04 + 0.55 * g * g * (3 - 2 * g);
    // Labels go on the molecule being looked at.
    const views = this.allViews();
    const probes = this.allProbes();
    let focus: MoleculeView | null = null;
    let focusD = (Math.max(fovNm * 0.6, 220)) ** 2;
    for (const v of views) {
      const d = v.centre.distanceToSquared(target);
      if (d < focusD) {
        focusD = d;
        focus = v;
      }
    }
    views.forEach((v, i) => {
      v.setFocused(v === focus);
      v.setLabelFade(labelFade);
      const p = probes[i];
      if (v.thicken !== thicken || v.capScale !== capScale || v.baseGrow !== baseGrow) {
        v.thicken = thicken;
        v.capScale = capScale;
        v.baseGrow = baseGrow;
        v.markDirty();
      }
      p.h = this.h;
      p.thicken = thicken;
      p.dyeScale = dyeScale;
      if (p.update(animDt, reducedMotion)) changed = true;
    });

    // Halo sizing.
    const u = this.halo.uniforms;
    // px covered by 1 nm at depth d is camDist / (nmPerPx · d).
    u.uPxPerUnit.value = camDist / nmPerPx;
    u.uDpr.value = dpr;
    u.uMinPx.value = 11;
    // Halos matter when dyes are tiny on screen; close up, bloom does the work.
    u.uGain.value = 0.35 + 0.65 * Math.min(1, Math.max(0, (nmPerPx - 0.05) / 0.25));

    this.particles.update(dt, target, camDist, dpr, reducedMotion);

    // Fog scales with zoom.
    (this.scene.fog as THREE.FogExp2).density = 0.5 / camDist;

    // Faint dye point lights on the closest dyes.
    const near: { p: THREE.Vector3; c: THREE.Color; i: number; d: number }[] = [];
    for (const p of probes) {
      p.forEachShownDye((pos, set, intensity) => {
        near.push({ p: pos.clone(), c: SET_COLOR[set], i: intensity, d: pos.distanceToSquared(target) });
      });
    }
    near.sort((a, b) => a.d - b.d);
    const lightScale = Math.max(1, nmPerPx * 3);
    this.dyeLights.forEach((l, i) => {
      const n = near[i];
      if (!n) {
        l.intensity = 0;
        return;
      }
      l.position.copy(n.p);
      l.color.copy(n.c);
      l.distance = 9 * lightScale;
      l.intensity = 6 * n.i * lightScale * lightScale;
    });

    // Camera-relative key light keeps shading consistent while orbiting.
    this.keyLight.intensity = 2.6;
    return changed;
  }

  /** Bound dyes on every molecule shown in full detail (keyed by molecule). */
  boundDyes(): BoundDye[] {
    const out: BoundDye[] = [];
    for (const p of this.allProbes()) p.boundDyes(out);
    return out;
  }

  /** Keys of the molecules currently shown in full detail. */
  liveKeys(): Set<string> {
    return new Set(this.allViews().map((v) => v.key));
  }

  viewByKey(key: string): MoleculeView | undefined {
    return this.allViews().find((v) => v.key === key);
  }

  pick(ray: THREE.Ray, tolNm: number): { kind: 'probe'; probe: import('../../data/probes').Probe; bound: boolean } | { kind: 'nt'; molecule: string; nt: number } | null {
    let bestProbe: ReturnType<ProbeSystem['pick']> = null;
    for (const p of this.allProbes()) {
      const h = p.pick(ray, tolNm);
      if (h && (!bestProbe || h.dist < bestProbe.dist)) bestProbe = h;
    }
    let bestNt: { molecule: string; nt: number; dist: number } | null = null;
    for (const v of this.allViews()) {
      const h = v.pick(ray, tolNm);
      if (h && (!bestNt || h.dist < bestNt.dist)) bestNt = { molecule: v.key, nt: h.nt, dist: h.dist };
    }
    if (bestProbe && (!bestNt || bestProbe.dist <= bestNt.dist + 1)) return { kind: 'probe', probe: bestProbe.probe, bound: bestProbe.bound };
    if (bestNt) return { kind: 'nt', molecule: bestNt.molecule, nt: bestNt.nt };
    return null;
  }
}
