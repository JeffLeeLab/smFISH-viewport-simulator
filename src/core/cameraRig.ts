/**
 * One master camera in cell-world µm (z = optical axis, coverslip at z = 0). Each scene
 * derives its own camera from it, in its own units (spec §3). Stage flights use van Wijk &
 * Nuij's smooth zoom-and-pan path so a jump from 40 nm to 25 µm always keeps context.
 */
import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { S_MAX, S_MIN } from './scale';

CameraControls.install({
  THREE: {
    Vector2: THREE.Vector2,
    Vector3: THREE.Vector3,
    Vector4: THREE.Vector4,
    Quaternion: THREE.Quaternion,
    Matrix4: THREE.Matrix4,
    Spherical: THREE.Spherical,
    Box3: THREE.Box3,
    Sphere: THREE.Sphere,
    Raycaster: THREE.Raycaster,
  },
});

export const CAMERA_FOV_DEG = 32;

export interface View {
  /** Orbit target, cell-world µm. */
  target: THREE.Vector3;
  azimuth: number;
  polar: number;
  /** Field of view across the smaller viewport dimension, nm. */
  fovNm: number;
}

interface Flight {
  from: View;
  to: View;
  t: number;
  duration: number;
  S: number;
  path: (s: number) => { c: THREE.Vector3; w: number };
  resolve: () => void;
}

const tmpV = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: CameraControls;
  private flight: Flight | null = null;
  private aspect = 1;
  autoRotateSpeed = 0;
  reducedMotion = false;
  /** Fires when the user starts interacting (cancels flights). */
  onUserInput: (() => void) | null = null;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 1e-4, 1e4);
    this.camera.up.set(0, 0, 1);
    this.controls = new CameraControls(this.camera, dom);
    const c = this.controls;
    c.dollyToCursor = true;
    c.smoothTime = 0.14;
    c.draggingSmoothTime = 0.06;
    c.dollySpeed = 2.2;
    c.truckSpeed = 1.6;
    c.azimuthRotateSpeed = 0.7;
    c.polarRotateSpeed = 0.7;
    c.mouseButtons.left = CameraControls.ACTION.ROTATE;
    c.mouseButtons.right = CameraControls.ACTION.TRUCK;
    c.mouseButtons.middle = CameraControls.ACTION.DOLLY;
    c.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
    c.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
    c.touches.two = CameraControls.ACTION.TOUCH_DOLLY_TRUCK;
    c.touches.three = CameraControls.ACTION.TOUCH_TRUCK;
    c.minDistance = this.distanceFor(Math.pow(10, S_MIN));
    c.maxDistance = this.distanceFor(Math.pow(10, S_MAX));
    const cancel = () => {
      if (this.flight) {
        this.flight.resolve();
        this.flight = null;
      }
      this.onUserInput?.();
    };
    c.addEventListener('controlstart', cancel);
    dom.addEventListener('wheel', cancel, { passive: true });

    // Shift / Ctrl / ⌘ + left-drag pans (up, down, left, right) instead of orbiting.
    // camera-controls reads the button mapping on pointer-down, so swap it just before.
    const setLeft = (e: PointerEvent | KeyboardEvent) => {
      const pan = e.shiftKey || e.ctrlKey || e.metaKey;
      c.mouseButtons.left = pan ? CameraControls.ACTION.TRUCK : CameraControls.ACTION.ROTATE;
    };
    (dom.parentElement ?? dom).addEventListener('pointerdown', setLeft, { capture: true });
    window.addEventListener('keydown', setLeft);
    window.addEventListener('keyup', setLeft);
  }

  /** Multiply the field of view (keyboard zoom). */
  zoomBy(factor: number): void {
    const d = this.controls.distance * factor;
    void this.controls.dollyTo(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, d)), true);
  }

  /** Pan by a fraction of the field of view (arrow keys). */
  pan(fx: number, fy: number): void {
    if (this.flight) {
      this.flight.resolve();
      this.flight = null;
    }
    const d = this.controls.distance * 2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2);
    void this.controls.truck(fx * d, -fy * d, true);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.distanceFor(Math.pow(10, S_MIN));
    this.controls.maxDistance = this.distanceFor(Math.pow(10, S_MAX));
  }

  /** Camera distance (µm) that shows fovNm across the smaller viewport dimension. */
  distanceFor(fovNm: number): number {
    const t = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2);
    const minDimFactor = this.aspect < 1 ? this.aspect : 1;
    return fovNm / 1000 / (2 * t * minDimFactor);
  }

  fovNmFor(distance: number): number {
    const t = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2);
    const minDimFactor = this.aspect < 1 ? this.aspect : 1;
    return distance * 1000 * 2 * t * minDimFactor;
  }

  /** nm per CSS pixel at the target depth. */
  nmPerPx(viewportHeightPx: number): number {
    const t = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2);
    return (this.controls.distance * 1000 * 2 * t) / viewportHeightPx;
  }

  get s(): number {
    return Math.log10(this.fovNmFor(this.controls.distance));
  }

  get target(): THREE.Vector3 {
    return this.controls.getTarget(new THREE.Vector3());
  }

  getView(): View {
    return {
      target: this.target,
      azimuth: this.controls.azimuthAngle,
      polar: this.controls.polarAngle,
      fovNm: this.fovNmFor(this.controls.distance),
    };
  }

  /** Place the camera immediately. */
  setView(v: View): void {
    this.flight = null;
    const pos = this.positionFor(v.target, v.azimuth, v.polar, this.distanceFor(v.fovNm));
    this.controls.setLookAt(pos.x, pos.y, pos.z, v.target.x, v.target.y, v.target.z, false);
  }

  private positionFor(target: THREE.Vector3, azimuth: number, polar: number, dist: number) {
    // camera-controls measures angles in its y-up space; our up is +z.
    const sph = new THREE.Spherical(dist, polar, azimuth);
    const offset = new THREE.Vector3().setFromSpherical(sph); // y-up
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.camera.up);
    offset.applyQuaternion(q);
    return target.clone().add(offset);
  }

  /** Fly smoothly to a view. Resolves when finished or interrupted. */
  flyTo(to: View, speed = 1): Promise<void> {
    if (this.flight) this.flight.resolve();
    const from = this.getView();
    if (this.reducedMotion) {
      this.setView(to);
      return Promise.resolve();
    }
    const { path, S } = zoomPanPath(from.target, from.fovNm / 1000, to.target, to.fovNm / 1000);
    // Duration grows with path length, ~1.2 s for a typical stage change.
    const duration = Math.min(2.4, Math.max(0.7, 0.45 + S * 0.32)) / speed;
    // Take the short way round in azimuth.
    let dAz = to.azimuth - from.azimuth;
    dAz = ((((dAz + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const toFixed = { ...to, azimuth: from.azimuth + dAz };
    return new Promise((resolve) => {
      this.flight = { from, to: toFixed, t: 0, duration, S, path, resolve };
    });
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  update(dt: number): boolean {
    const f = this.flight;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = easeInOut(f.t);
      const { c, w } = f.path(e * f.S);
      const az = f.from.azimuth + (f.to.azimuth - f.from.azimuth) * e;
      const po = f.from.polar + (f.to.polar - f.from.polar) * e;
      const pos = this.positionFor(c, az, po, this.distanceFor(w * 1000));
      this.controls.setLookAt(pos.x, pos.y, pos.z, c.x, c.y, c.z, false);
      if (f.t >= 1) {
        this.flight = null;
        f.resolve();
      }
    } else if (this.autoRotateSpeed) {
      this.controls.azimuthAngle += this.autoRotateSpeed * dt;
    }
    return this.controls.update(dt);
  }

  /** Move everything by a world offset (used when the cell is re-seeded). */
  shift(delta: THREE.Vector3): void {
    const t = this.target.add(delta);
    const p = this.controls.getPosition(tmpV).add(delta);
    this.controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
  }
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * van Wijk & Nuij (2003), "Smooth and efficient zooming and panning". Returns the optimal
 * path c(s), w(s) between two views of width w0 and w1, and its length S.
 */
export function zoomPanPath(
  c0: THREE.Vector3,
  w0: number,
  c1: THREE.Vector3,
  w1: number,
  rho = 1.3,
): { path: (s: number) => { c: THREE.Vector3; w: number }; S: number } {
  const u1 = c0.distanceTo(c1);
  const dir = c1.clone().sub(c0);
  if (u1 < 1e-9 * Math.max(w0, w1)) {
    const k = w1 >= w0 ? 1 : -1;
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return {
      S,
      path: (s) => ({ c: c0.clone().lerp(c1, S ? s / S : 1), w: w0 * Math.exp(k * rho * s) }),
    };
  }
  const r2 = rho * rho;
  const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * u1 * u1) / (2 * w0 * r2 * u1);
  const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * u1 * u1) / (2 * w1 * r2 * u1);
  const r0 = Math.log(-b0 + Math.sqrt(b0 * b0 + 1));
  const r1 = Math.log(-b1 + Math.sqrt(b1 * b1 + 1));
  const S = (r1 - r0) / rho;
  const coshr0 = Math.cosh(r0);
  const sinhr0 = Math.sinh(r0);
  return {
    S,
    path: (s) => {
      const u = (w0 / r2) * (coshr0 * Math.tanh(rho * s + r0) - sinhr0);
      const w = (w0 * coshr0) / Math.cosh(rho * s + r0);
      return { c: c0.clone().addScaledVector(dir, u / u1), w };
    },
  };
}
