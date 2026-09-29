/**
 * Cell scene (1 unit = 1 µm, coverslip at z = 0; spec §6.3): a translucent adherent cell,
 * DAPI-stained nucleus and ~80 mRNA spots, ray-marched from a PSF-convolved volume built
 * in a Web Worker.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { WorldModel } from '../../data/model';
import type { AppState, Store } from '../../state/store';
import type { BoundDye } from '../molecular/probeSystem';
import type { QualityLevel } from '../../core/quality';
import {
  countSpots,
  outlinePoint,
  cellHeight,
  resolveSpots,
  type CellShape,
  type Spot,
  type SpotSeed,
} from '../../data/cell';
import { recordDyes, type RnaRecord } from '../../data/population';
import {
  buildStructure,
  decode,
  ENCODE_MAX,
  pack,
  splatSpots,
  VOLUME_FULL,
  VOLUME_LOW,
  type VolumeGrid,
  type VolumeSpot,
} from '../../data/volume';
import { CAMERA, IMMERSIONS, psfSigma } from '../../data/optics';
import { DYES } from '../../data/dyes';
import { getRegion } from '../../data/transcript';
import { Rng } from '../../data/rng';
import { CHANNEL_COLOR } from '../palette';
import { formatLength, smoothstep } from '../../core/scale';
import type { BuildRequest, BuildResult } from '../../workers/volume.worker';

const RAY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const RAY_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVol;
  uniform vec3 uMin, uMax;
  uniform float uStep, uMip, uEncodeMax, uOpacity, uHaze;
  uniform int uMaxSteps;
  uniform vec3 uColG, uColM, uColD, uChan;
  uniform vec4 uI0;     // spots (sum), dapi (sum), spots (mip), dapi (mip)
  varying vec3 vWorld;

  vec2 hitBox(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (uMin - ro) * inv;
    vec3 t1 = (uMax - ro) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
  }
  float curve(float x) { return 1.0 - exp(-pow(max(x, 0.0), 1.25)); }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);
    vec2 t = hitBox(ro, rd);
    t.x = max(t.x, 0.0);
    if (t.x >= t.y) discard;
    float len = t.y - t.x;
    int n = int(min(float(uMaxSteps), ceil(len / uStep)));
    float dt = len / float(n);
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    vec4 acc = vec4(0.0);
    vec4 mx = vec4(0.0);
    vec3 size = uMax - uMin;
    for (int i = 0; i < 640; i++) {
      if (i >= n) break;
      vec3 p = ro + rd * (t.x + (float(i) + jitter) * dt);
      vec4 v = texture(uVol, (p - uMin) / size);
      v.rgb = v.rgb * v.rgb * uEncodeMax;
      acc += v * dt;
      mx = max(mx, v);
    }
    // r = magenta, g = green, b = DAPI, a = cytoplasm mask.
    vec3 I = mix(acc.rgb, mx.rgb, uMip);
    float i0s = mix(uI0.x, uI0.z, uMip);
    float i0d = mix(uI0.y, uI0.w, uMip);
    vec3 col = uChan.x * uColG * curve(I.g / i0s)
             + uChan.y * uColM * curve(I.r / i0s)
             + uChan.z * uColD * curve(I.b / i0d);
    // Faint cytoplasmic autofluorescence (and unbound-probe haze before the wash).
    float body = mix(acc.a * 0.12, mx.a * 0.6, uMip);
    col += vec3(0.05, 0.06, 0.07) * body * (0.3 + uHaze) * (uChan.x + uChan.y) * 0.5;
    gl_FragColor = vec4(col * uOpacity, 0.0);
  }
`;

const FRESNEL_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRESNEL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uPower, uIntensity, uFill;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
    gl_FragColor = vec4(uColor * (f * uIntensity + uFill), 0.0);
  }
`;

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

function fresnel(color: THREE.ColorRepresentation, power: number, intensity: number, fill: number): THREE.ShaderMaterial {
  return additive(
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uPower: { value: power },
        uIntensity: { value: intensity },
        uFill: { value: fill },
      },
      vertexShader: FRESNEL_VERT,
      fragmentShader: FRESNEL_FRAG,
      depthTest: false,
    }),
  );
}

/** Closed membrane mesh: the height-field dome over the footprint plus a flat base. */
function membraneGeometry(shape: CellShape): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 160, 80);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // SphereGeometry is y-up; treat its y as our z.
    const sx = pos.getX(i);
    const sy = pos.getZ(i);
    const sz = pos.getY(i);
    const rho = Math.min(1, Math.hypot(sx, sy));
    const alpha = Math.atan2(sy, sx);
    const [ex, ey] = outlinePoint(shape, alpha);
    const x = ex * rho;
    const y = ey * rho;
    const z = sz >= 0 ? Math.max(0.02, cellHeight(shape, x * 0.999, y * 0.999)) : 0;
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export class CellScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 10000);
  readonly insetElement: HTMLElement;
  readonly countsElement: HTMLElement;
  private store: Store;
  private world: WorldModel;
  private shape: CellShape;
  private seeds: RnaRecord[] = [];
  private spots: Spot[] = [];
  private grid: VolumeGrid = VOLUME_FULL;
  private volTex: THREE.Data3DTexture;
  private volData: Uint8Array | null = null;
  private volMat: THREE.ShaderMaterial;
  private volMesh: THREE.Mesh;
  private membrane: THREE.Mesh;
  private nucleus: THREE.Mesh;
  private plane: THREE.Mesh;
  private planeTex: THREE.CanvasTexture;
  private planeCanvas = document.createElement('canvas');
  private insetCanvas: HTMLCanvasElement;
  private insetCap: HTMLElement;
  private insetBar: HTMLElement;
  private insetBarLbl: HTMLElement;
  private tsLabels: CSS2DObject[] = [];
  private worker: Worker | null = null;
  private jobId = 0;
  private inFlight = false;
  private builtKey = '';
  private sentKey = '';
  private insetKey = '';
  private noiseRng = new Rng(11);
  private noiseTimer = 0;
  private quality: QualityLevel = 0;
  lastBuildMs = 0;

  constructor(world: WorldModel, store: Store, shape: CellShape, records: RnaRecord[]) {
    this.world = world;
    this.store = store;
    this.shape = shape;
    this.camera.up.set(0, 0, 1);

    const g = this.grid;
    this.volTex = new THREE.Data3DTexture(new Uint8Array(g.nx * g.ny * g.nz * 4), g.nx, g.ny, g.nz);
    this.volTex.format = THREE.RGBAFormat;
    this.volTex.type = THREE.UnsignedByteType;
    this.volTex.minFilter = this.volTex.magFilter = THREE.LinearFilter;
    this.volTex.unpackAlignment = 1;
    this.volTex.needsUpdate = true;

    this.volMat = additive(
      new THREE.ShaderMaterial({
        uniforms: {
          uVol: { value: this.volTex },
          uMin: { value: new THREE.Vector3(...g.min) },
          uMax: { value: new THREE.Vector3(...g.max) },
          uStep: { value: 0.06 },
          uMaxSteps: { value: 420 },
          uMip: { value: 0 },
          uEncodeMax: { value: ENCODE_MAX },
          uOpacity: { value: 1 },
          uHaze: { value: 0 },
          uColG: { value: CHANNEL_COLOR.green.clone() },
          uColM: { value: CHANNEL_COLOR.magenta.clone() },
          uColD: { value: CHANNEL_COLOR.dapi.clone() },
          uChan: { value: new THREE.Vector3(1, 1, 1) },
          uI0: { value: new THREE.Vector4(9, 280, 38, 120) },
        },
        vertexShader: RAY_VERT,
        fragmentShader: RAY_FRAG,
        side: THREE.BackSide,
        depthTest: false,
      }),
    );
    this.volMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.volMat);
    this.volMesh.frustumCulled = false;
    this.volMesh.renderOrder = 1;
    this.fitVolumeMesh();
    this.scene.add(this.volMesh);

    this.membrane = new THREE.Mesh(membraneGeometry(shape), fresnel(0xb8c8ff, 2.6, 0.42, 0.012));
    this.membrane.renderOrder = 3;
    this.scene.add(this.membrane);
    this.nucleus = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), fresnel(0x6f8fff, 2.2, 0.16, 0.0));
    this.nucleus.renderOrder = 3;
    this.placeNucleus();
    this.scene.add(this.nucleus);

    // Coverslip reference grid (5 µm).
    const lines: THREE.Vector3[] = [];
    for (let v = -15; v <= 15; v += 5) {
      lines.push(new THREE.Vector3(v, -15, 0), new THREE.Vector3(v, 15, 0));
      lines.push(new THREE.Vector3(-15, v, 0), new THREE.Vector3(15, v, 0));
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(lines),
      additive(new THREE.LineBasicMaterial({ color: 0x0c1018, depthTest: false })),
    );
    grid.renderOrder = 0;
    this.scene.add(grid);

    // Focal plane (section) and inset share an image.
    this.insetCanvas = document.createElement('canvas');
    this.insetCanvas.width = g.nx;
    this.insetCanvas.height = g.ny;
    this.planeCanvas.width = g.nx;
    this.planeCanvas.height = g.ny;
    this.planeTex = new THREE.CanvasTexture(this.planeCanvas);
    this.planeTex.colorSpace = THREE.SRGBColorSpace;
    const w = g.max[0] - g.min[0];
    const h = g.max[1] - g.min[1];
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      additive(new THREE.MeshBasicMaterial({ map: this.planeTex, opacity: 0.55, side: THREE.DoubleSide, depthTest: false })),
    );
    this.plane.position.set((g.max[0] + g.min[0]) / 2, (g.max[1] + g.min[1]) / 2, 1.6);
    const frame = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-w / 2, -h / 2, 0),
        new THREE.Vector3(w / 2, -h / 2, 0),
        new THREE.Vector3(w / 2, h / 2, 0),
        new THREE.Vector3(-w / 2, h / 2, 0),
      ]),
      additive(new THREE.LineBasicMaterial({ color: 0x33405c, depthTest: false })),
    );
    this.plane.add(frame);
    this.plane.renderOrder = 2;
    this.scene.add(this.plane);

    this.insetCap = document.createElement('div');
    this.insetCap.className = 'inset-cap';
    this.insetBar = document.createElement('div');
    this.insetBar.className = 'inset-bar';
    this.insetBarLbl = document.createElement('div');
    this.insetBarLbl.className = 'inset-bar-lbl';
    this.insetElement = document.createElement('div');
    this.insetElement.className = 'inset';
    this.insetElement.style.aspectRatio = `${g.nx} / ${g.ny}`;
    this.insetElement.setAttribute('role', 'img');
    this.insetElement.setAttribute('aria-label', 'Simulated camera image of the cell');
    this.insetElement.append(this.insetCanvas, this.insetCap, this.insetBar, this.insetBarLbl);
    this.countsElement = document.createElement('div');
    this.countsElement.className = 'counts';
    this.countsElement.setAttribute('aria-live', 'polite');

    this.seeds = records;
    this.makeTsLabels();

    try {
      this.worker = new Worker(new URL('../../workers/volume.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<BuildResult>) => this.onBuilt(e.data);
    } catch {
      this.worker = null;
    }
  }

  private fitVolumeMesh(): void {
    const g = this.grid;
    this.volMesh.position.set((g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2);
    this.volMesh.scale.set(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]);
  }

  private placeNucleus(): void {
    this.nucleus.position.set(...this.shape.nucleusCentre);
    this.nucleus.scale.set(...this.shape.nucleusRadii);
  }

  private makeTsLabels(): void {
    for (const l of this.tsLabels) this.scene.remove(l);
    this.tsLabels = [];
    const byTs = new Map<number, SpotSeed[]>();
    for (const s of this.seeds) if (s.kind === 'nascent') byTs.set(s.ts!, [...(byTs.get(s.ts!) ?? []), s]);
    for (const list of byTs.values()) {
      const c = list.reduce((a, s) => a.add(new THREE.Vector3(s.x, s.y, s.z)), new THREE.Vector3()).divideScalar(list.length);
      const el = document.createElement('div');
      el.className = 'axis-label ts-label';
      el.textContent = 'transcription site';
      const o = new CSS2DObject(el);
      o.center.set(-0.12, 0.5);
      o.position.copy(c);
      this.tsLabels.push(o);
      this.scene.add(o);
    }
  }

  setShape(shape: CellShape, records: RnaRecord[]): void {
    this.shape = shape;
    this.membrane.geometry.dispose();
    this.membrane.geometry = membraneGeometry(shape);
    this.placeNucleus();
    this.seeds = records;
    this.makeTsLabels();
    this.builtKey = '';
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    const grid = level >= 2 ? VOLUME_LOW : VOLUME_FULL;
    this.volMat.uniforms.uStep.value = level === 0 ? 0.06 : 0.1;
    this.volMat.uniforms.uMaxSteps.value = level === 0 ? 420 : 220;
    if (grid !== this.grid) {
      this.grid = grid;
      this.volTex.dispose();
      this.volTex = new THREE.Data3DTexture(new Uint8Array(grid.nx * grid.ny * grid.nz * 4), grid.nx, grid.ny, grid.nz);
      this.volTex.format = THREE.RGBAFormat;
      this.volTex.minFilter = this.volTex.magFilter = THREE.LinearFilter;
      this.volTex.unpackAlignment = 1;
      this.volTex.needsUpdate = true;
      this.volMat.uniforms.uVol.value = this.volTex;
      this.volData = null;
      this.builtKey = '';
    }
  }

  setViewportSize(_w: number, _h: number): void {}

  private sigmas(s: AppState): { g: [number, number, number]; m: [number, number, number]; gz: number; mz: number } {
    const n = IMMERSIONS[s.immersion].n;
    const g = psfSigma(DYES.af546.emNm, s.na, n);
    const m = psfSigma(DYES.af647.emNm, s.na, n);
    return {
      g: [g.xy / 1000, g.xy / 1000, g.z / 1000],
      m: [m.xy / 1000, m.xy / 1000, m.z / 1000],
      gz: g.z / 1000,
      mz: m.z / 1000,
    };
  }

  private volumeSpots(s: AppState, dyes: BoundDye[], p0: THREE.Vector3): VolumeSpot[] {
    if (s.hyb !== 'bound') return [];
    const out: VolumeSpot[] = [];
    // Every RNA contributes its actual fluorophores, from the same molecular geometry the
    // molecular scene draws (so zooming into any spot is continuous).
    const h = s.helical ? 1 : 0;
    for (const r of this.seeds) {
      if (r.kind === 'featured') continue;
      for (const d of recordDyes(this.world.library, r, s.probesPerSet, h, s.longFraction)) {
        out.push({ x: d.pos[0], y: d.pos[1], z: d.pos[2], green: d.set === 'distal' ? 1 : 0, magenta: d.set === 'cds' ? 1 : 0, spread: 0 });
      }
    }
    // The two featured molecules use their live dye positions from the molecular scene.
    for (const d of dyes) {
      if (!d.molecule.startsWith('featured')) continue;
      out.push({
        x: p0.x + d.pos.x / 1000,
        y: p0.y + d.pos.y / 1000,
        z: p0.z + d.pos.z / 1000,
        green: d.set === 'distal' ? d.weight : 0,
        magenta: d.set === 'cds' ? d.weight : 0,
        spread: 0,
      });
    }
    return out;
  }

  update(dt: number, dyes: BoundDye[], p0: THREE.Vector3, scale: number, _nmPerPx: number, weight: number): void {
    const s = this.store.state;
    const design = this.world.design;
    const polyA = getRegion(this.world.transcript.long, 'polya')!;
    this.spots = resolveSpots(this.seeds, {
      probesPerSet: s.probesPerSet,
      longFraction: s.longFraction,
      cdsProbes: design.cds,
      distalProbes: design.distal,
      geneLength: polyA.start,
    });
    this.updateCounts(s);
    const active = weight > 0.001 || s.stage === 3;
    if (!active) return;

    // Volume rebuild when anything that shapes it changes.
    let dyeKey = 0;
    for (const d of dyes) if (d.molecule.startsWith('featured')) dyeKey += d.pos.x * 0.37 + d.pos.y * 0.11 + d.pos.z * 0.07 + d.weight;
    const key = [s.seed, s.probesPerSet, s.longFraction, s.na, s.immersion, s.chromatic, s.helical, s.hyb === 'bound', dyeKey.toFixed(0), this.grid.nx].join('|');
    if (key !== this.builtKey && !this.inFlight) this.requestBuild(s, dyes, p0, key);

    const u = this.volMat.uniforms;
    u.uChan.value.set(s.chGreen ? 1 : 0, s.chMagenta ? 1 : 0, s.chDapi ? 1 : 0);
    const mipTarget = s.mip ? 1 : 0;
    u.uMip.value += (mipTarget - u.uMip.value) * Math.min(1, dt * 5);
    if (Math.abs(u.uMip.value - mipTarget) < 1e-3) u.uMip.value = mipTarget;
    u.uHaze.value = s.washed ? 0 : 1.5;
    this.membrane.visible = s.cellOutline;
    // The rim only reads as an outline from a distance; close up it would be a bright sheet.
    const far = smoothstep(Math.log10(7000), Math.log10(16000), scale);
    const mu = (this.membrane.material as THREE.ShaderMaterial).uniforms;
    mu.uIntensity.value = (s.mip ? 0.22 : 0.42) * far;
    mu.uFill.value = 0.012 * far;
    this.nucleus.visible = s.cellOutline && !s.chDapi;
    this.plane.visible = !s.mip && this.volData !== null;
    this.plane.position.z = s.cellFocalZ;
    for (const l of this.tsLabels) l.visible = s.hyb === 'bound' && weight > 0.5 && (s.chMagenta || s.chGreen);

    // Inset/section.
    this.noiseTimer += dt;
    const tick = s.noise && this.noiseTimer > 0.2 ? Math.floor(performance.now() / 200) : 0;
    const ikey = [this.builtKey, s.cellFocalZ, s.mip, s.noise ? tick : -1, s.chGreen, s.chMagenta, s.chDapi, s.washed].join('|');
    if (ikey !== this.insetKey && this.volData) {
      this.insetKey = ikey;
      if (s.noise) this.noiseTimer = 0;
      this.renderInset(s);
    }
  }

  private requestBuild(s: AppState, dyes: BoundDye[], p0: THREE.Vector3, key: string): void {
    const sig = this.sigmas(s);
    const off = s.chromatic
      ? ([CAMERA.chromaticLateralNm / 1000 / Math.SQRT2, CAMERA.chromaticLateralNm / 1000 / Math.SQRT2, CAMERA.chromaticAxialNm / 1000] as [number, number, number])
      : ([0, 0, 0] as [number, number, number]);
    const req: BuildRequest = {
      id: ++this.jobId,
      params: {
        grid: this.grid,
        spots: this.volumeSpots(s, dyes, p0),
        sigmaGreen: sig.g,
        sigmaMagenta: sig.m,
        chromatic: off,
        shape: this.shape,
      },
    };
    this.sentKey = key;
    if (this.worker) {
      this.inFlight = true;
      this.worker.postMessage(req);
    } else {
      // Fallback (no worker support): build on the main thread.
      const t0 = performance.now();
      const st = buildStructure(req.params.grid, req.params.shape);
      const n = req.params.grid.nx * req.params.grid.ny * req.params.grid.nz;
      const gr = new Float32Array(n);
      const mg = new Float32Array(n);
      splatSpots(req.params, gr, mg);
      this.onBuilt({ id: req.id, data: pack(gr, mg, st.dapi, st.mask), ms: performance.now() - t0 });
    }
  }

  private onBuilt(r: BuildResult): void {
    this.inFlight = false;
    if (r.id !== this.jobId) return;
    const g = this.grid;
    if (r.data.length !== g.nx * g.ny * g.nz * 4) return;
    this.volData = r.data;
    this.volTex.image.data = r.data;
    this.volTex.needsUpdate = true;
    this.builtKey = this.sentKey;
    this.lastBuildMs = r.ms;
  }

  /** Section (or MIP) channels, cached until the volume, plane or mode changes. */
  private section: { key: string; G: Float32Array; M: Float32Array; D: Float32Array; A: Float32Array } | null = null;
  private cleanKey = '';

  private sectionFor(s: AppState) {
    const key = [this.builtKey, s.cellFocalZ, s.mip].join('|');
    if (this.section?.key === key) return this.section;
    const data = this.volData!;
    const g = this.grid;
    const { nx, ny, nz } = g;
    const dz = (g.max[2] - g.min[2]) / nz;
    const kf = Math.min(nz - 1, Math.max(0, s.cellFocalZ / dz - 0.5));
    const k0 = Math.floor(kf);
    const k1 = Math.min(nz - 1, k0 + 1);
    const t = kf - k0;
    const n = nx * ny;
    const G = new Float32Array(n);
    const M = new Float32Array(n);
    const D = new Float32Array(n);
    const A = new Float32Array(n);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = (ny - 1 - j) * nx + i; // flip so +y is up in the image
        if (s.mip) {
          let mg = 0,
            mm = 0,
            md = 0,
            ma = 0;
          for (let k = 0; k < nz; k++) {
            const q = ((k * ny + j) * nx + i) * 4;
            if (data[q] > mm) mm = data[q];
            if (data[q + 1] > mg) mg = data[q + 1];
            if (data[q + 2] > md) md = data[q + 2];
            if (data[q + 3] > ma) ma = data[q + 3];
          }
          M[o] = decode(mm);
          G[o] = decode(mg);
          D[o] = decode(md);
          A[o] = ma / 255;
        } else {
          const q0 = ((k0 * ny + j) * nx + i) * 4;
          const q1 = ((k1 * ny + j) * nx + i) * 4;
          M[o] = decode(data[q0]) * (1 - t) + decode(data[q1]) * t;
          G[o] = decode(data[q0 + 1]) * (1 - t) + decode(data[q1 + 1]) * t;
          D[o] = decode(data[q0 + 2]) * (1 - t) + decode(data[q1 + 2]) * t;
          A[o] = (data[q0 + 3] * (1 - t) + data[q1 + 3] * t) / 255;
        }
      }
    }
    this.section = { key, G, M, D, A };
    return this.section;
  }

  /** Display curve as a lookup table over photons 0–511 (one entry per photon). */
  private static lut(black: number, white: number, gamma: number, gain = 1): Float32Array {
    const t = new Float32Array(512);
    for (let v = 0; v < 512; v++) t[v] = Math.pow(Math.min(1, Math.max(0, (v - black) / (white - black))), gamma) * gain;
    return t;
  }
  /** 64k standard-normal samples (power-of-two length, +1 so k + 1 stays in range). */
  private static GAUSS = (() => {
    const r = new Rng(424242);
    const t = new Float32Array(65536 + 1);
    for (let i = 0; i < t.length; i++) t[i] = r.gauss();
    return t;
  })();
  private static LUT_NOISY = CellScene.lut(12, 130, 0.75);
  private static LUT_DAPI_NOISY = CellScene.lut(10, 120, 0.85);
  private static LUT_CLEAN = CellScene.lut(3, 80, 0.75);
  private static LUT_DAPI_CLEAN = CellScene.lut(6, 110, 0.85, 0.5);

  /** Section at the focal plane (or MIP), with camera background and noise. */
  private renderInset(s: AppState): void {
    const g = this.grid;
    const { nx, ny } = g;
    const c = this.insetCanvas;
    if (c.width !== nx || c.height !== ny) {
      c.width = this.planeCanvas.width = nx;
      c.height = this.planeCanvas.height = ny;
      this.planeTex.dispose();
      this.cleanKey = '';
    }
    const { G, M, D, A } = this.sectionFor(s);
    const n = nx * ny;
    const haze = s.washed ? 0 : CAMERA.unboundHaze;
    const idx = (v: number) => (v <= 0 ? 0 : v >= 511 ? 511 : v | 0);
    const paint = (canvas: HTMLCanvasElement, noisy: boolean) => {
      const ctx = canvas.getContext('2d')!;
      const im = ctx.createImageData(nx, ny);
      // Shot + read noise: v + √v·g₁ + σ_read·g₂, with g from a precomputed Gaussian table
      // read from a fresh random offset each tick (fast enough for 50k pixels × 3 channels).
      const noiseOn = noisy && s.noise;
      const T = CellScene.GAUSS;
      let k = noiseOn ? this.noiseRng.int(65536) : 0;
      const px = (v: number) => {
        if (!noiseOn) return v;
        k = (k + 2) & 65535;
        return v + Math.sqrt(v > 0 ? v : 0) * T[k] + CAMERA.readNoise * T[k + 1];
      };
      const L = noisy ? CellScene.LUT_NOISY : CellScene.LUT_CLEAN;
      const LD = noisy ? CellScene.LUT_DAPI_NOISY : CellScene.LUT_DAPI_CLEAN;
      for (let i = 0; i < n; i++) {
        const bg = noisy ? 6 + (CAMERA.autofluorescence - 6) * A[i] + haze * A[i] : 0;
        const vg = s.chGreen ? L[idx(px(G[i] + bg))] : 0;
        const vm = s.chMagenta ? L[idx(px(M[i] + bg))] : 0;
        const vd = s.chDapi ? LD[idx(px(D[i] + (noisy ? 6 : 0)))] : 0;
        im.data[i * 4] = Math.min(255, 60 * vg + 255 * vm + 74 * vd);
        im.data[i * 4 + 1] = Math.min(255, 255 * vg + 60 * vm + 123 * vd);
        im.data[i * 4 + 2] = Math.min(255, 106 * vg + 240 * vm + 255 * vd);
        im.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
    };
    paint(c, true);
    // The noise-free plane image only changes with the section or channels.
    const ck = [this.section!.key, s.chGreen, s.chMagenta, s.chDapi].join('|');
    if (ck !== this.cleanKey) {
      this.cleanKey = ck;
      paint(this.planeCanvas, false);
      this.planeTex.needsUpdate = true;
    }
    const vx = ((g.max[0] - g.min[0]) / nx) * 1000;
    this.insetCap.textContent = s.mip ? `max-intensity projection · ${Math.round(vx)} nm px` : `z ${s.cellFocalZ.toFixed(1)} µm · ${Math.round(vx)} nm px`;
    const barUm = 5;
    this.insetBar.style.width = `${(barUm / (g.max[0] - g.min[0])) * 100}%`;
    this.insetBarLbl.textContent = formatLength(barUm * 1000);
  }

  private updateCounts(s: AppState): void {
    const bound = s.hyb === 'bound';
    const c = countSpots(this.spots);
    const html = bound
      ? `Spots: <b>${c.total}</b> · <span class="g">White (long): ${c.long}</span> · <span class="m">Magenta-only (short): ${c.short}</span><br><span style="color:var(--faint)">+ ${c.transcriptionSites} transcription sites · counts from the model, not image analysis</span>`
      : '<span style="color:var(--faint)">No probes hybridised yet.</span>';
    if (this.countsElement.innerHTML !== html) this.countsElement.innerHTML = html;
  }

  readouts(): { k: string; v: string; cls?: string }[] {
    const s = this.store.state;
    const c = countSpots(this.spots);
    if (s.hyb !== 'bound') return [{ k: 'spots', v: 'none (not hybridised)' }];
    return [
      { k: 'spots', v: `${c.total}` },
      { k: 'white (long)', v: `${c.long}` },
      { k: 'magenta (short)', v: `${c.short}`, cls: 'm' },
      { k: 'view', v: s.mip ? 'max-intensity projection' : '3D volume' },
      { k: 'objective', v: `NA ${s.na.toFixed(2)} · ${IMMERSIONS[s.immersion].name.toLowerCase()}` },
    ];
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }
}
