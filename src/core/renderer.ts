/**
 * Renderer and compositing (spec §3, §5). The molecular scene goes through depth of field,
 * bloom and ACES tone mapping. The optical and cell scenes render microscope-like,
 * display-mapped colours into their own targets, so channel hues stay exact (green +
 * magenta = white). A final pass cross-fades the three by scale weight.
 */
import * as THREE from 'three';
import {
  BloomEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  Pass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import type { SceneWeights } from './scale';

export const BACKGROUND = new THREE.Color('#05070A');

export interface Layer {
  scene: THREE.Scene;
  camera: THREE.Camera;
}

class CompositePass extends Pass {
  weights: SceneWeights = { mol: 1, opt: 0, cell: 0 };
  labGain = 1;
  opt: Layer | null = null;
  cell: Layer | null = null;
  /** Decorative backdrop behind the cell layer, rendered small and blurred. */
  lab: Layer | null = null;
  readonly rtLab: THREE.WebGLRenderTarget;
  readonly rtOpt: THREE.WebGLRenderTarget;
  readonly rtCell: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;

  constructor() {
    super('CompositePass');
    this.needsSwap = false;
    const opts = { type: THREE.HalfFloatType, samples: 4, depthBuffer: true };
    this.rtOpt = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtCell = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtLab = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2, depthBuffer: true });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tMol: { value: null },
        tOpt: { value: this.rtOpt.texture },
        tCell: { value: this.rtCell.texture },
        tLab: { value: this.rtLab.texture },
        uLabTexel: { value: new THREE.Vector2(1, 1) },
        uLabGain: { value: 0 },
        uW: { value: new THREE.Vector3(1, 0, 0) },
        uBg: { value: BACKGROUND.clone() },
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMol, tOpt, tCell, tLab;
        uniform vec2 uLabTexel;
        uniform float uLabGain;
        // Soft 13-tap blur: the lab is out of focus behind the sample.
        vec3 labBlur(vec2 uv) {
          vec3 s = texture2D(tLab, uv).rgb * 0.2;
          for (int i = 0; i < 12; i++) {
            float a = float(i) * 0.5236;
            float r = (i % 2 == 0) ? 1.6 : 3.2;
            s += texture2D(tLab, uv + vec2(cos(a), sin(a)) * r * uLabTexel).rgb * (i % 2 == 0 ? 0.09 : 0.0433);
          }
          return s;
        }
        uniform vec3 uW, uBg;
        uniform float uTime, uAspect;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
        void main() {
          // Layers are cleared to transparent black; the background goes in underneath.
          vec3 c = uBg * max(0.0, 1.0 - uW.x - uW.y - uW.z);
          if (uW.x > 0.0) { vec4 t = texture2D(tMol, vUv); c += uW.x * (t.rgb + (1.0 - clamp(t.a, 0.0, 1.0)) * uBg); }
          if (uW.y > 0.0) { vec4 t = texture2D(tOpt, vUv); c += uW.y * (t.rgb + (1.0 - clamp(t.a, 0.0, 1.0)) * uBg); }
          if (uW.z > 0.0) {
            vec4 t = texture2D(tCell, vUv);
            vec3 behind = uBg + (uLabGain > 0.0 ? labBlur(vUv) * uLabGain : vec3(0.0));
            c += uW.z * (t.rgb + (1.0 - clamp(t.a, 0.0, 1.0)) * behind);
          }
          // Soft vignette.
          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
          c *= 1.0 - 0.22 * smoothstep(0.35, 1.05, length(q));
          gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
          // Dither to avoid banding in the dark gradients.
          gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.mat;
  }

  override setSize(width: number, height: number): void {
    this.rtOpt.setSize(width, height);
    this.rtCell.setSize(width, height);
    const lw = Math.max(1, Math.round(width / 4));
    const lh = Math.max(1, Math.round(height / 4));
    this.rtLab.setSize(lw, lh);
    this.mat.uniforms.uLabTexel.value.set(1 / lw, 1 / lh);
    this.mat.uniforms.uAspect.value = width / Math.max(1, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget,
  ): void {
    const w = this.weights;
    const u = this.mat.uniforms;
    // Clear to transparent black: unlike a coloured clear, it needs no colour-space conversion.
    renderer.setClearColor(0x000000, 0);
    if (w.opt > 0 && this.opt) {
      renderer.setRenderTarget(this.rtOpt);
      renderer.clear();
      renderer.render(this.opt.scene, this.opt.camera);
    }
    this.mat.uniforms.uLabGain.value = this.lab ? this.labGain : 0;
    if (w.cell > 0 && this.lab && this.labGain > 0) {
      renderer.setRenderTarget(this.rtLab);
      renderer.clear();
      renderer.render(this.lab.scene, this.lab.camera);
    }
    if (w.cell > 0 && this.cell) {
      renderer.setRenderTarget(this.rtCell);
      renderer.clear();
      renderer.render(this.cell.scene, this.cell.camera);
    }
    u.tMol.value = inputBuffer.texture;
    u.uW.value.set(w.mol, w.opt, w.cell);
    u.uTime.value = (u.uTime.value + 0.618) % 100;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  private molPass: RenderPass;
  private molEffects: EffectPass;
  private composite: CompositePass;
  readonly bloom: BloomEffect;
  readonly dof: DepthOfFieldEffect;
  private molLayer: Layer;
  private width = 1;
  private height = 1;
  pixelRatioCap = 2;

  constructor(canvas: HTMLCanvasElement, mol: Layer) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // screenshot button
      stencil: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.setClearColor(0x000000, 0);
    this.molLayer = mol;

    this.composer = new EffectComposer(this.gl, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 4,
    });
    this.molPass = new RenderPass(mol.scene, mol.camera);
    this.molPass.clearPass.overrideClearColor = new THREE.Color(0, 0, 0);
    this.molPass.clearPass.overrideClearAlpha = 0;
    this.dof = new DepthOfFieldEffect(mol.camera, { focusDistance: 1, focusRange: 1, bokehScale: 1.4 });
    this.bloom = new BloomEffect({
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.25,
      intensity: 1.35,
      mipmapBlur: true,
      radius: 0.62,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.molEffects = new EffectPass(mol.camera, this.dof, this.bloom, tone);
    this.composite = new CompositePass();
    this.composite.renderToScreen = true;
    this.composer.addPass(this.molPass);
    this.composer.addPass(this.molEffects);
    this.composer.addPass(this.composite);
  }

  setLayers(opt: Layer, cell: Layer, lab?: Layer): void {
    this.composite.opt = opt;
    this.composite.cell = cell;
    this.composite.lab = lab ?? null;
  }

  /** Brightness of the lab backdrop behind the cell (0 hides it). */
  set labGain(v: number) {
    this.composite.labGain = v;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.gl.setSize(width, height, false);
    this.composer.setSize(width, height, false);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get drawingBufferSize(): THREE.Vector2 {
    return this.gl.getDrawingBufferSize(new THREE.Vector2());
  }

  set dofEnabled(on: boolean) {
    this.dof.blendMode.opacity.value = on ? 1 : 0;
  }

  /** Focus on a world-space point of the molecular scene, with a range relative to distance. */
  focusMolecular(target: THREE.Vector3, distance: number): void {
    this.dof.target = target;
    this.dof.cocMaterial.focusRange = distance * 0.9;
  }

  render(weights: SceneWeights, dt: number): void {
    const molOn = weights.mol > 0.001;
    this.molPass.enabled = molOn;
    this.molEffects.enabled = molOn;
    this.composite.weights = weights;
    this.molPass.mainCamera = this.molLayer.camera;
    this.composer.render(dt);
  }
}

export function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
