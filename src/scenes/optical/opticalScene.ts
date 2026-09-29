/**
 * Optical scene (1 unit = 1 µm), origin at the midpoint of the featured molecules
 * (spec §6.3). Every bound fluorophore becomes a 3D Gaussian PSF. The volume is rendered
 * with the closed-form line integral of each Gaussian along the view ray (emission-only
 * volume rendering), so no ray marching is needed.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { WorldModel } from '../../data/model';
import type { AppState, Store } from '../../state/store';
import type { QualityLevel } from '../../core/quality';
import { DYES } from '../../data/dyes';
import { CAMERA, IMMERSIONS, backgroundPhotons, psfFwhm, psfSigma, snr } from '../../data/optics';
import { Rng } from '../../data/rng';
import { CHANNEL_COLOR } from '../palette';
import { BAND_MOL_OPT, smoothstep, formatLength } from '../../core/scale';
import {
  addNoise,
  centroid,
  emptyDyes,
  measureFwhm,
  profile,
  renderSection,
  type ChannelDyes,
  type Sigma3,
} from './psfImage';

/** One RNA to draw as a PSF spot: its fluorophores in optical-scene µm. */
export interface OpticalSpotInput {
  key: string;
  kind: 'long' | 'short' | 'nascent';
  dyes: { x: number; y: number; z: number; set: 'cds' | 'distal'; weight: number }[];
}
/** PSF spots drawn at once (the RNAs nearest the camera target). */
export const MAX_SPOTS = 20;
const MAX_DYES_PER_SPOT = 128;
const INSET_WIDTH_UM = 64 * (CAMERA.pixelNm / 1000); // 4.16 µm
/** Display window for camera images, photons per pixel. */
const DISPLAY_BLACK = 12;
const DISPLAY_WHITE = 130;
const DISPLAY_GAMMA = 0.75;
/** 3D glow: intensity (photons/pixel) at which a channel reaches ~63% brightness. */
const I0_3D = 26;

const PSF_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const PSF_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDyes;
  uniform int uRow;
  uniform int uCount;
  uniform vec3 uSigG, uSigM, uOffM;
  uniform float uGain, uI0, uOpacity;
  uniform vec3 uColG, uColM;
  uniform vec2 uChan;
  varying vec3 vWorld;
  const float TWO_PI = 6.283185307;
  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - cameraPosition);
    vec3 iG = 1.0 / (uSigG * uSigG);
    vec3 iM = 1.0 / (uSigM * uSigM);
    vec3 rd2 = rd * rd;
    float aG = dot(rd2, iG);
    float aM = dot(rd2, iM);
    float sG = 0.0, sM = 0.0;
    for (int i = 0; i < ${MAX_DYES_PER_SPOT}; i++) {
      if (i >= uCount) break;
      vec4 d = texelFetch(uDyes, ivec2(i, uRow), 0);
      if (d.w > 0.0) {
        vec3 p = ro - (d.xyz + uOffM);
        float b = dot(rd * p, iM);
        float c = dot(p * p, iM);
        sM += d.w * exp(-0.5 * (c - b * b / aM));
      } else if (d.w < 0.0) {
        vec3 p = ro - d.xyz;
        float b = dot(rd * p, iG);
        float c = dot(p * p, iG);
        sG -= d.w * exp(-0.5 * (c - b * b / aG));
      }
    }
    // Line integral of a normalised 3D Gaussian: exp(...) / (2π σx σy σz √a).
    float IG = uGain * sG / (TWO_PI * uSigG.x * uSigG.y * uSigG.z * sqrt(aG));
    float IM = uGain * sM / (TWO_PI * uSigM.x * uSigM.y * uSigM.z * sqrt(aM));
    vec3 col = uChan.x * uColG * (1.0 - exp(-pow(IG / uI0, 1.3))) + uChan.y * uColM * (1.0 - exp(-pow(IM / uI0, 1.3)));
    gl_FragColor = vec4(col * uOpacity, 0.0);
  }
`;

/** Additive colour, destination alpha untouched. */
function additive<T extends THREE.Material>(m: T): T {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

interface SpotView {
  key: string | null;
  kind: OpticalSpotInput['kind'];
  row: number;
  g: ChannelDyes;
  m: ChannelDyes;
  box: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  ell: { g: THREE.Group; m: THREE.Group };
  label: CSS2DObject;
  labelEl: HTMLElement;
  centre: THREE.Vector3;
}

function ellipseGroup(color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = additive(new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(0.55), depthTest: false }));
  const xy = new THREE.LineLoop(geo, mat);
  const xz = new THREE.LineLoop(geo, mat);
  xz.rotation.x = Math.PI / 2;
  const yz = new THREE.LineLoop(geo, mat);
  yz.rotation.y = Math.PI / 2;
  g.add(xy, xz, yz);
  g.renderOrder = 5;
  return g;
}

export class OpticalScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.001, 1000);
  readonly insetElement: HTMLElement;
  readonly profileElement: HTMLCanvasElement;
  private store: Store;
  private dyeData = new Float32Array(MAX_SPOTS * MAX_DYES_PER_SPOT * 4);
  private dyeTex: THREE.DataTexture;
  private shared: Record<string, THREE.IUniform>;
  private spots: SpotView[];
  /** Image centre (optical µm): the camera target, snapped to the camera pixel grid. */
  private centre = new THREE.Vector3();
  private focal: THREE.Mesh;
  private focalTex: THREE.CanvasTexture;
  private focalOutline: THREE.LineLoop;
  private focalLabel: CSS2DObject;
  private haze: THREE.Mesh;
  private insetCanvas: HTMLCanvasElement;
  /** Same image for the 3D focal plane, with the background floor removed. */
  private planeCanvas = document.createElement('canvas');
  private insetCap: HTMLElement;
  private insetBar: HTMLElement;
  private insetBarLbl: HTMLElement;
  private imgG = new Float32Array(0);
  private imgM = new Float32Array(0);
  private cleanG = new Float32Array(0);
  private cleanM = new Float32Array(0);
  private noiseRng = new Rng(7);
  private noiseTimer = 0;
  private lastKey = '';
  private lastProfileKey = '';
  private dfac = 1;
  private sigG: Sigma3 = { x: 0.1, y: 0.1, z: 0.3 };
  private sigM: Sigma3 = { x: 0.1, y: 0.1, z: 0.3 };
  private snrVals = { g: 0, m: 0 };
  selected = 'featured-long';
  private weight = 0;
  private quality: QualityLevel = 0;

  constructor(_world: WorldModel, store: Store) {
    this.store = store;
    this.camera.up.set(0, 0, 1);

    // One row of dyes per spot.
    this.dyeTex = new THREE.DataTexture(this.dyeData, MAX_DYES_PER_SPOT, MAX_SPOTS, THREE.RGBAFormat, THREE.FloatType);
    this.dyeTex.minFilter = this.dyeTex.magFilter = THREE.NearestFilter;
    this.dyeTex.needsUpdate = true;

    this.shared = {
      uDyes: { value: this.dyeTex },
      uSigG: { value: new THREE.Vector3(0.1, 0.1, 0.3) },
      uSigM: { value: new THREE.Vector3(0.1, 0.1, 0.3) },
      uOffM: { value: new THREE.Vector3() },
      uGain: { value: CAMERA.photonsPerDye * (CAMERA.pixelNm / 1000) ** 2 },
      uI0: { value: I0_3D },
      uColG: { value: CHANNEL_COLOR.green.clone() },
      uColM: { value: CHANNEL_COLOR.magenta.clone() },
      uChan: { value: new THREE.Vector2(1, 1) },
      uOpacity: { value: 1 },
    };

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const mkSpot = (index: number): SpotView => {
      const mat = additive(
        new THREE.ShaderMaterial({
          uniforms: { ...this.shared, uRow: { value: index }, uCount: { value: 0 } },
          vertexShader: PSF_VERT,
          fragmentShader: PSF_FRAG,
          side: THREE.BackSide,
          depthTest: false,
        }),
      );
      const box = new THREE.Mesh(boxGeo, mat);
      box.frustumCulled = false;
      box.renderOrder = 2;
      const ell = { g: ellipseGroup(CHANNEL_COLOR.green), m: ellipseGroup(CHANNEL_COLOR.magenta) };
      const labelEl = document.createElement('div');
      labelEl.className = 'dim-label';
      const label = new CSS2DObject(labelEl);
      label.center.set(0.5, 1);
      this.scene.add(box, ell.g, ell.m, label);
      return {
        key: null,
        kind: 'long',
        row: index,
        g: emptyDyes(MAX_DYES_PER_SPOT),
        m: emptyDyes(MAX_DYES_PER_SPOT),
        box,
        mat,
        ell,
        label,
        labelEl,
        centre: new THREE.Vector3(),
      };
    };
    this.spots = Array.from({ length: MAX_SPOTS }, (_, i) => mkSpot(i));

    // Inset (panel) and focal plane (3D) share one canvas.
    this.insetCanvas = document.createElement('canvas');
    this.insetCanvas.width = this.insetCanvas.height = 64;
    this.insetCap = document.createElement('div');
    this.insetCap.className = 'inset-cap';
    this.insetBar = document.createElement('div');
    this.insetBar.className = 'inset-bar';
    this.insetBarLbl = document.createElement('div');
    this.insetBarLbl.className = 'inset-bar-lbl';
    this.insetElement = document.createElement('div');
    this.insetElement.className = 'inset';
    this.insetElement.setAttribute('role', 'img');
    this.insetElement.setAttribute('aria-label', 'Simulated camera image of the focal plane');
    this.insetElement.append(this.insetCanvas, this.insetCap, this.insetBar, this.insetBarLbl);
    this.profileElement = document.createElement('canvas');
    this.profileElement.className = 'profile';
    this.profileElement.setAttribute('role', 'img');
    this.profileElement.setAttribute('aria-label', 'Lateral and axial intensity profiles through the selected spot');

    this.planeCanvas.width = this.planeCanvas.height = 64;
    this.focalTex = new THREE.CanvasTexture(this.planeCanvas);
    this.focalTex.colorSpace = THREE.SRGBColorSpace;
    this.focalTex.magFilter = THREE.NearestFilter;
    this.focalTex.minFilter = THREE.LinearFilter;
    this.focal = new THREE.Mesh(
      new THREE.PlaneGeometry(INSET_WIDTH_UM, INSET_WIDTH_UM),
      additive(new THREE.MeshBasicMaterial({ map: this.focalTex, side: THREE.DoubleSide, opacity: 0.85, depthTest: false })),
    );
    this.focal.renderOrder = 1;
    this.focal.name = 'focal-plane';
    const h = INSET_WIDTH_UM / 2;
    this.focalOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0)]),
      additive(new THREE.LineBasicMaterial({ color: 0x3a4660, depthTest: false })),
    );
    const fl = document.createElement('div');
    fl.className = 'axis-label';
    this.focalLabel = new CSS2DObject(fl);
    this.focalLabel.center.set(0, 0);
    this.focalLabel.position.set(-h, -h, 0);
    this.focal.add(this.focalOutline, this.focalLabel);
    this.scene.add(this.focal);

    // Optical axis indicator.
    const axis = new THREE.Group();
    const axMat = additive(new THREE.LineBasicMaterial({ color: 0x55607a, depthTest: false }));
    axis.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -0.55), new THREE.Vector3(0, 0, 0.55)]), axMat));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.1, 16), additive(new THREE.MeshBasicMaterial({ color: 0x55607a, depthTest: false })));
    head.rotation.x = Math.PI / 2;
    head.position.z = 0.6;
    axis.add(head);
    const al = document.createElement('div');
    al.className = 'axis-label';
    al.textContent = 'z · optical axis';
    const alo = new CSS2DObject(al);
    alo.position.set(0, 0, 0.72);
    axis.add(alo);
    axis.position.set(1.05, 0.3, 0);
    this.scene.add(axis);

    // Unbound-probe haze (before the wash): a faint screen-wide lift.
    this.haze = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      additive(
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color() } },
          vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: 'uniform vec3 uColor; void main(){ gl_FragColor = vec4(uColor, 0.0); }',
          depthTest: false,
        }),
      ),
    );
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 0;
    this.scene.add(this.haze);

    store.watch(['diffraction'], () => undefined);
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
  }

  setViewportSize(_w: number, _h: number): void {
    // The profile canvas follows the panel width.
    const c = this.profileElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, c.clientWidth || 340);
    c.width = Math.round(w * dpr);
    c.height = Math.round(120 * dpr);
    this.lastProfileKey = '';
  }

  private spotByKey(key: string): SpotView | undefined {
    return this.spots.find((sp) => sp.key === key);
  }

  /** Key of the spot nearest the ray (optical µm), for selection. */
  pickSpot(ray: THREE.Ray): string | null {
    let best: string | null = null;
    let bestD = 0.35 * 0.35;
    for (const sp of this.spots) {
      if (!sp.key || !sp.box.visible) continue;
      const d = ray.distanceSqToPoint(sp.centre);
      if (d < bestD) {
        bestD = d;
        best = sp.key;
      }
    }
    return best;
  }

  hitFocalPlane(ray: THREE.Ray): THREE.Vector3 | null {
    if (!this.focal.visible) return null;
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.focal.position.z);
    const p = ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    const h = INSET_WIDTH_UM / 2;
    return Math.abs(p.x - this.centre.x) <= h && Math.abs(p.y - this.centre.y) <= h ? p : null;
  }

  get focalZ(): number {
    return this.focal.position.z;
  }

  private sigmas(s: AppState): { g: Sigma3; m: Sigma3 } {
    const n = IMMERSIONS[s.immersion].n;
    const g = psfSigma(DYES.af546.emNm, s.na, n);
    const m = psfSigma(DYES.af647.emNm, s.na, n);
    return {
      g: { x: g.xy / 1000, y: g.xy / 1000, z: g.z / 1000 },
      m: { x: m.xy / 1000, y: m.xy / 1000, z: m.z / 1000 },
    };
  }

  private chromatic(s: AppState): THREE.Vector3 {
    if (!s.chromatic) return new THREE.Vector3();
    const l = CAMERA.chromaticLateralNm / 1000 / Math.SQRT2;
    return new THREE.Vector3(l, l, CAMERA.chromaticAxialNm / 1000);
  }

  update(dt: number, inputs: OpticalSpotInput[], scale: number, nmPerPx: number, weight: number, target: THREE.Vector3): void {
    this.weight = weight;
    const s = this.store.state;
    const active = weight > 0.001 || s.stage === 3;
    if (!active) return;

    // Assign spots to pool slots, keeping each RNA in the same slot while it stays in view.
    const wanted = new Map(inputs.slice(0, MAX_SPOTS).map((i) => [i.key, i]));
    for (const sp of this.spots) if (sp.key && !wanted.has(sp.key)) sp.key = null;
    for (const inp of wanted.values()) {
      let sp = this.spotByKey(inp.key);
      if (!sp) {
        sp = this.spots.find((x) => x.key === null)!;
        sp.key = inp.key;
      }
      sp.kind = inp.kind;
    }
    for (const sp of this.spots) {
      sp.g.count = 0;
      sp.m.count = 0;
      const inp = sp.key ? wanted.get(sp.key) : undefined;
      if (!inp) continue;
      for (const d of inp.dyes) {
        const ch = d.set === 'cds' ? sp.m : sp.g;
        if (ch.count >= MAX_DYES_PER_SPOT / 2) continue;
        ch.pos[ch.count * 3] = d.x;
        ch.pos[ch.count * 3 + 1] = d.y;
        ch.pos[ch.count * 3 + 2] = d.z;
        ch.weight[ch.count] = d.weight;
        ch.count++;
      }
    }
    if (!this.spotByKey(this.selected)) {
      // Select whichever RNA is nearest the camera target.
      let best: SpotView | null = null;
      for (const sp of this.spots) {
        if (sp.key && (sp.g.count || sp.m.count)) {
          const c = centroid(sp.m.count ? sp.m : sp.g)!;
          sp.centre.set(c[0], c[1], c[2]);
          if (!best || sp.centre.distanceToSquared(target) < best.centre.distanceToSquared(target)) best = sp;
        }
      }
      if (best?.key) this.selected = best.key;
    }
    const px = CAMERA.pixelNm / 1000;
    this.centre.set(Math.round(target.x / px) * px, Math.round(target.y / px) * px, target.z);

    // Diffraction: grows in across the cross-fade band, and follows the toggle.
    const dGoal = s.diffraction ? 1 : 0;
    this.dfac += (dGoal - this.dfac) * Math.min(1, dt * 3.2);
    if (Math.abs(this.dfac - dGoal) < 1e-3) this.dfac = dGoal;
    const band = smoothstep(BAND_MOL_OPT[0], BAND_MOL_OPT[1], scale);
    const f = this.dfac * (0.15 + 0.85 * band);
    const sig = this.sigmas(s);
    this.sigG = sig.g;
    this.sigM = sig.m;
    const floor = (nmPerPx * 1.3) / 1000;
    const eff = (a: Sigma3) => new THREE.Vector3(Math.hypot(a.x * f, floor), Math.hypot(a.y * f, floor), Math.hypot(a.z * f, floor));
    const eg = eff(sig.g);
    const em = eff(sig.m);
    this.shared.uSigG.value.copy(eg);
    this.shared.uSigM.value.copy(em);
    const off = this.chromatic(s);
    this.shared.uOffM.value.copy(off);
    this.shared.uChan.value.set(s.chGreen ? 1 : 0, s.chMagenta ? 1 : 0);

    // Upload dyes and fit a box around each spot's PSF.
    const data = this.dyeData;
    data.fill(0);
    this.spots.forEach((sp, si) => {
      let k = si * MAX_DYES_PER_SPOT;
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      const add = (ch: ChannelDyes, sign: number, o: THREE.Vector3) => {
        for (let i = 0; i < ch.count; i++) {
          const x = ch.pos[i * 3] + o.x;
          const y = ch.pos[i * 3 + 1] + o.y;
          const z = ch.pos[i * 3 + 2] + o.z;
          data[k * 4] = ch.pos[i * 3];
          data[k * 4 + 1] = ch.pos[i * 3 + 1];
          data[k * 4 + 2] = ch.pos[i * 3 + 2];
          data[k * 4 + 3] = sign * ch.weight[i];
          k++;
          min.min(new THREE.Vector3(x, y, z));
          max.max(new THREE.Vector3(x, y, z));
        }
      };
      add(sp.m, 1, off);
      add(sp.g, -1, new THREE.Vector3());
      const count = k - si * MAX_DYES_PER_SPOT;
      sp.mat.uniforms.uCount.value = count;
      sp.box.visible = count > 0;
      if (count > 0) {
        const pad = new THREE.Vector3(Math.max(eg.x, em.x), Math.max(eg.y, em.y), Math.max(eg.z, em.z)).multiplyScalar(4.2);
        min.sub(pad);
        max.add(pad);
        sp.box.position.copy(min).add(max).multiplyScalar(0.5);
        sp.box.scale.copy(max).sub(min);
      }
      const cm = centroid(sp.m);
      const cg = centroid(sp.g);
      const c = cm ?? cg;
      if (c) sp.centre.set(c[0], c[1], c[2]);
      this.updateEllipsoids(sp, s, cg, cm, off, f);
    });
    this.dyeTex.needsUpdate = true;
    this.shared.uOpacity.value = 1;

    // Haze before the wash.
    const hazeAmt = s.washed ? 0 : 0.006;
    (this.haze.material as THREE.ShaderMaterial).uniforms.uColor.value
      .copy(CHANNEL_COLOR.green)
      .multiplyScalar(s.chGreen ? hazeAmt : 0)
      .add(CHANNEL_COLOR.magenta.clone().multiplyScalar(s.chMagenta ? hazeAmt : 0));

    // Focal plane and inset.
    this.focal.position.set(this.centre.x, this.centre.y, this.centre.z + s.focalZ);
    (this.focalLabel.element as HTMLElement).textContent = `focal plane · z = ${s.focalZ >= 0 ? '+' : ''}${Math.round(s.focalZ * 1000)} nm`;
    // Camera pixels are 65 nm, so the plane only makes sense once zoomed out past the cross-fade.
    this.focal.visible = f > 0.8 && band > 0.98;
    this.noiseTimer += dt;
    const noiseTick = s.noise && this.noiseTimer > 0.14 ? Math.floor(performance.now() / 140) : 0;
    const key = [this.centre.x.toFixed(3), this.centre.y.toFixed(3), this.focal.position.z.toFixed(3), s.na, s.immersion, s.washed, s.noise ? noiseTick : -1, s.pixels, s.chromatic, s.chGreen, s.chMagenta, this.dyeHash()].join('|');
    if (key !== this.lastKey) {
      this.lastKey = key;
      if (s.noise) this.noiseTimer = 0;
      this.renderInset(s, off);
    }
    const pkey = [s.na, s.immersion, s.chromatic, this.selected, s.chGreen, s.chMagenta, this.dyeHash(), this.profileElement.width].join('|');
    if (pkey !== this.lastProfileKey && this.profileElement.isConnected) {
      this.lastProfileKey = pkey;
      this.drawProfile(s, off);
    }
  }

  private dyeHash(): string {
    let h = 0;
    for (const sp of this.spots) {
      for (const ch of [sp.g, sp.m]) {
        h += ch.count * 7.1;
        for (let i = 0; i < ch.count; i++) h += ch.pos[i * 3] * 13.7 + ch.pos[i * 3 + 2] * 5.3 + ch.weight[i] * 3.1;
      }
    }
    return h.toFixed(4);
  }

  private updateEllipsoids(sp: SpotView, s: AppState, cg: number[] | null, cm: number[] | null, off: THREE.Vector3, f: number): void {
    const n = IMMERSIONS[s.immersion].n;
    // Only the spots being looked at (near the camera target) get overlays and labels.
    const c0 = cm ?? cg;
    const focused =
      !!sp.key && (sp.key === this.selected || (!!c0 && Math.hypot(c0[0] - this.centre.x, c0[1] - this.centre.y, c0[2] - this.centre.z) < 0.6));
    const show = s.ellipsoid && f > 0.5 && focused;
    const fg = psfFwhm(DYES.af546.emNm, s.na, n);
    const fm = psfFwhm(DYES.af647.emNm, s.na, n);
    const place = (g: THREE.Group, c: number[] | null, fw: { xy: number; z: number }, o: THREE.Vector3, on: boolean) => {
      g.visible = show && on && !!c;
      if (!c) return;
      g.position.set(c[0] + o.x, c[1] + o.y, c[2] + o.z);
      g.scale.set(fw.xy / 2000, fw.xy / 2000, fw.z / 2000);
    };
    place(sp.ell.g, cg, fg, new THREE.Vector3(), s.chGreen);
    place(sp.ell.m, cm, fm, off, s.chMagenta);
    const c = cm ?? cg;
    sp.label.visible = !!c && f > 0.5 && focused;
    if (c) {
      // Anchor just beyond the ellipsoid's silhouette in the camera's "up" direction.
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const a = Math.max(fg.xy, fm.xy) / 2000;
      const cz = Math.max(fg.z, fm.z) / 2000;
      const ext = Math.sqrt(a * a * (up.x * up.x + up.y * up.y) + cz * cz * up.z * up.z);
      sp.label.position.set(c[0], c[1], c[2]).addScaledVector(up, ext + 0.05);
    }
    const name = sp.kind === 'long' ? 'Long isoform' : sp.kind === 'short' ? 'Short isoform' : 'Nascent RNA';
    const merge = cg && cm ? 'white in merge' : cm ? 'magenta only' : cg ? 'green only' : '';
    let html = `<b>${name}</b><span class="merge"> · ${merge}</span>`;
    if (show && sp.key === this.selected) {
      const rows: string[] = [];
      if (cm && s.chMagenta) rows.push(`<span style="color:var(--magenta)">■</span> ${Math.round(fm.xy)} × ${Math.round(fm.z)} nm`);
      if (cg && s.chGreen) rows.push(`<span style="color:var(--green)">■</span> ${Math.round(fg.xy)} × ${Math.round(fg.z)} nm`);
      if (rows.length) html += '<span class="dims"><br>' + rows.join('&nbsp;&nbsp;') + '</span>';
    }
    if (sp.labelEl.innerHTML !== html) sp.labelEl.innerHTML = html;
    sp.labelEl.style.borderColor = sp.key === this.selected ? 'rgba(255,255,255,0.35)' : '';
  }

  private renderInset(s: AppState, off: THREE.Vector3): void {
    const size = s.pixels ? 64 : 256;
    const c = this.insetCanvas;
    if (c.width !== size) {
      c.width = c.height = size;
      this.planeCanvas.width = this.planeCanvas.height = size;
      this.focalTex.dispose();
    }
    this.focalTex.magFilter = s.pixels ? THREE.NearestFilter : THREE.LinearFilter;
    if (this.imgG.length !== size * size) {
      this.imgG = new Float32Array(size * size);
      this.imgM = new Float32Array(size * size);
      this.cleanG = new Float32Array(size * size);
      this.cleanM = new Float32Array(size * size);
    }
    const cx = this.centre.x;
    const cy = this.centre.y;
    const base = { cx, cy, width: INSET_WIDTH_UM, size, focalZ: this.focal.position.z, cameraPixel: CAMERA.pixelNm / 1000 };
    const g = emptyDyes(MAX_DYES_PER_SPOT * MAX_SPOTS);
    const m = emptyDyes(MAX_DYES_PER_SPOT * MAX_SPOTS);
    for (const sp of this.spots) {
      if (!sp.key) continue;
      for (let i = 0; i < sp.g.count; i++) {
        g.pos.set(sp.g.pos.subarray(i * 3, i * 3 + 3), g.count * 3);
        g.weight[g.count++] = sp.g.weight[i];
      }
      for (let i = 0; i < sp.m.count; i++) {
        m.pos.set([sp.m.pos[i * 3] + off.x, sp.m.pos[i * 3 + 1] + off.y, sp.m.pos[i * 3 + 2] + off.z], m.count * 3);
        m.weight[m.count++] = sp.m.weight[i];
      }
    }
    renderSection(g, { ...base, sigma: this.sigG }, this.imgG);
    renderSection(m, { ...base, sigma: this.sigM }, this.imgM);

    // SNR readout from the noise-free image around the selected spot.
    const bg = backgroundPhotons(s.washed);
    const peakNear = (img: Float32Array, cx: number, cy: number) => {
      let best = 0;
      const step = INSET_WIDTH_UM / size;
      for (let j = 0; j < size; j++) {
        const y = base.cy + INSET_WIDTH_UM / 2 - (j + 0.5) * step;
        if (Math.abs(y - cy) > 0.3) continue;
        for (let i = 0; i < size; i++) {
          const x = base.cx - INSET_WIDTH_UM / 2 + (i + 0.5) * step;
          if (Math.abs(x - cx) > 0.3) continue;
          best = Math.max(best, img[j * size + i]);
        }
      }
      return best;
    };
    const sel = this.spotByKey(this.selected);
    if (sel) {
      const cl = sel.centre;
      this.snrVals.g = sel.g.count ? snr(peakNear(this.imgG, cl.x, cl.y), bg) : 0;
      this.snrVals.m = sel.m.count ? snr(peakNear(this.imgM, cl.x + off.x, cl.y + off.y), bg) : 0;
    }

    this.cleanG.set(this.imgG);
    this.cleanM.set(this.imgM);
    const rng = s.noise ? this.noiseRng : null;
    addNoise(this.imgG, bg, rng);
    addNoise(this.imgM, bg, rng);

    // Inset: the camera image on a fixed display range (so fewer probes really look dimmer).
    this.paint(c, s, DISPLAY_BLACK, DISPLAY_WHITE);
    // Focal plane in 3D: the noise-free, background-free section, so the slice through
    // each PSF reads clearly.
    this.paint(this.planeCanvas, s, 2, 70, this.cleanG, this.cleanM);
    this.focalTex.needsUpdate = true;

    this.insetCap.textContent = `z ${s.focalZ >= 0 ? '+' : ''}${Math.round(s.focalZ * 1000)} nm · ${s.pixels ? `${CAMERA.pixelNm} nm px` : 'fine sampling'}`;
    const barUm = 1;
    this.insetBar.style.width = `${(barUm / INSET_WIDTH_UM) * 100}%`;
    this.insetBarLbl.textContent = formatLength(barUm * 1000);
  }

  private paint(c: HTMLCanvasElement, s: AppState, black: number, white: number, G0 = this.imgG, M0 = this.imgM): void {
    const size = c.width;
    const ctx = c.getContext('2d')!;
    const im = ctx.createImageData(size, size);
    const G = [60, 255, 106];
    const M = [255, 60, 240];
    const span = white - black;
    for (let i = 0; i < size * size; i++) {
      const vg = s.chGreen ? Math.min(1, Math.max(0, (G0[i] - black) / span)) : 0;
      const vm = s.chMagenta ? Math.min(1, Math.max(0, (M0[i] - black) / span)) : 0;
      const a = Math.pow(vg, DISPLAY_GAMMA);
      const b = Math.pow(vm, DISPLAY_GAMMA);
      im.data[i * 4] = Math.min(255, G[0] * a + M[0] * b);
      im.data[i * 4 + 1] = Math.min(255, G[1] * a + M[1] * b);
      im.data[i * 4 + 2] = Math.min(255, G[2] * a + M[2] * b);
      im.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
  }

  private drawProfile(s: AppState, off: THREE.Vector3): void {
    const c = this.profileElement;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    const dpr = W / Math.max(1, c.clientWidth || W);
    ctx.clearRect(0, 0, W, H);
    const sp = this.spotByKey(this.selected);
    if (!sp) return;
    const cg = centroid(sp.g);
    const cm = centroid(sp.m);
    const origin = cm ?? cg;
    const pad = 8 * dpr;
    const gap = 14 * dpr;
    const pw = (W - 2 * pad - gap) / 2;
    const top = 20 * dpr;
    const ph = H - top - 18 * dpr;
    ctx.font = `${10.5 * dpr}px IBM Plex Mono, monospace`;
    ctx.textBaseline = 'alphabetic';
    const panels: { title: string; axis: 0 | 2; half: number }[] = [
      { title: 'lateral (x)', axis: 0, half: 0.6 },
      { title: 'axial (z)', axis: 2, half: 1.6 },
    ];
    panels.forEach((p, pi) => {
      const x0 = pad + pi * (pw + gap);
      ctx.fillStyle = '#5b6272';
      ctx.fillText(p.title, x0, 12 * dpr);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, top + ph);
      ctx.lineTo(x0 + pw, top + ph);
      ctx.stroke();
      ctx.fillStyle = '#5b6272';
      ctx.fillText(`±${formatLength(p.half * 1000)}`, x0 + pw - 58 * dpr, H - 4 * dpr);
      if (!origin) return;
      const chans: { d: ChannelDyes; sig: Sigma3; col: string; on: boolean; o: THREE.Vector3 }[] = [
        { d: sp.m, sig: this.sigM, col: '#FF3CF0', on: s.chMagenta && sp.m.count > 0, o: off },
        { d: sp.g, sig: this.sigG, col: '#3CFF6A', on: s.chGreen && sp.g.count > 0, o: new THREE.Vector3() },
      ];
      let row = 0;
      for (const ch of chans) {
        if (!ch.on) continue;
        const shifted = { ...ch.d, pos: new Float32Array(ch.d.pos) };
        for (let i = 0; i < ch.d.count; i++) {
          shifted.pos[i * 3] += ch.o.x;
          shifted.pos[i * 3 + 1] += ch.o.y;
          shifted.pos[i * 3 + 2] += ch.o.z;
        }
        const cen = centroid(shifted)!;
        const n = 160;
        const curve = profile(shifted, ch.sig, [cen[0], cen[1], cen[2]], p.axis, p.half, n);
        let max = 0;
        for (const v of curve) max = Math.max(max, v);
        if (max <= 0) continue;
        // Position the curve relative to the shared origin so chromatic shifts are visible.
        const shift = (cen[p.axis] - origin[p.axis]) / (2 * p.half);
        ctx.strokeStyle = ch.col;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = x0 + (i / (n - 1) + shift) * pw;
          const y = top + ph - (curve[i] / max) * ph;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const fw = measureFwhm(curve, 2 * p.half) * 1000;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeStyle = ch.col + '88';
        ctx.lineWidth = 1 * dpr;
        const hx = x0 + (0.5 + shift) * pw;
        const halfW = (fw / 1000 / (2 * p.half)) * pw;
        ctx.beginPath();
        ctx.moveTo(hx - halfW / 2, top + ph / 2);
        ctx.lineTo(hx + halfW / 2, top + ph / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = ch.col;
        ctx.fillText(`${Math.round(fw)} nm`, x0 + pw - 56 * dpr, top + 10 * dpr + row * 12 * dpr);
        row++;
      }
    });
    ctx.fillStyle = '#8b93a3';
    ctx.fillText(`${sp.kind === 'nascent' ? 'nascent RNA' : sp.kind + ' isoform'} spot`, pad, H - 4 * dpr);
  }

  readouts(): { k: string; v: string; cls?: string }[] {
    const s = this.store.state;
    const imm = IMMERSIONS[s.immersion];
    const fg = psfFwhm(DYES.af546.emNm, s.na, imm.n);
    const fm = psfFwhm(DYES.af647.emNm, s.na, imm.n);
    return [
      { k: 'objective', v: `NA ${s.na.toFixed(2)} · ${imm.name.toLowerCase()} n ${imm.n}` },
      { k: 'FWHM 546', v: `${Math.round(fg.xy)} × ${Math.round(fg.z)} nm`, cls: 'g' },
      { k: 'FWHM 647', v: `${Math.round(fm.xy)} × ${Math.round(fm.z)} nm`, cls: 'm' },
      { k: 'SNR (selected)', v: `${this.snrVals.g.toFixed(1)} green · ${this.snrVals.m.toFixed(1)} magenta` },
      { k: 'background', v: `${backgroundPhotons(s.washed)} photons/px${s.washed ? '' : ' (not washed)'}` },
    ];
  }

  get currentWeight(): number {
    return this.weight + this.quality * 0;
  }
}
