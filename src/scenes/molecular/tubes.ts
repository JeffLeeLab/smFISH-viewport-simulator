/**
 * Dynamic tubes: several independent strips through point lists, rebuilt in place every
 * frame the chain moves. Frames are parallel-transported so the tube never twists.
 */
import * as THREE from 'three';

export interface StripSpec {
  count: number;
  /** Radius per point (or one value for the whole strip), nm. */
  radius: number | Float32Array;
}

export class DynamicTubes {
  readonly geometry = new THREE.BufferGeometry();
  readonly strips: StripSpec[];
  readonly radial: number;
  readonly pointCount: number;
  private pos: THREE.BufferAttribute;
  private nrm: THREE.BufferAttribute;
  readonly color: THREE.BufferAttribute;
  /** Per-strip radius multiplier (0 hides a strip). */
  readonly stripScale: Float32Array;
  private vertOffset: number[] = [];
  private pointOffset: number[] = [];

  constructor(strips: StripSpec[], radial = 8) {
    this.strips = strips;
    this.radial = radial;
    this.stripScale = new Float32Array(strips.length).fill(1);
    let verts = 0;
    let points = 0;
    const index: number[] = [];
    for (const s of strips) {
      this.vertOffset.push(verts);
      this.pointOffset.push(points);
      const base = verts;
      // Rings.
      for (let i = 0; i < s.count - 1; i++) {
        for (let r = 0; r < radial; r++) {
          const a = base + i * radial + r;
          const b = base + i * radial + ((r + 1) % radial);
          const c = a + radial;
          const d = b + radial;
          index.push(a, b, c, b, d, c);
        }
      }
      // End caps: one apex vertex per end.
      const capStart = base + s.count * radial;
      const capEnd = capStart + 1;
      for (let r = 0; r < radial; r++) {
        const a = base + r;
        const b = base + ((r + 1) % radial);
        index.push(capStart, b, a);
        const e = base + (s.count - 1) * radial + r;
        const f = base + (s.count - 1) * radial + ((r + 1) % radial);
        index.push(capEnd, e, f);
      }
      verts += s.count * radial + 2;
      points += s.count;
    }
    this.pointCount = points;
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.color = new THREE.BufferAttribute(new Float32Array(verts * 3).fill(1), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nrm.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.pos);
    this.geometry.setAttribute('normal', this.nrm);
    this.geometry.setAttribute('color', this.color);
    this.geometry.setIndex(verts > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }

  /** Colour every vertex of point `p` of strip `s` (plus caps at the ends). */
  setPointColor(s: number, p: number, r: number, g: number, b: number): void {
    const c = this.color.array as Float32Array;
    const spec = this.strips[s];
    const base = this.vertOffset[s];
    for (let k = 0; k < this.radial; k++) {
      const v = (base + p * this.radial + k) * 3;
      c[v] = r;
      c[v + 1] = g;
      c[v + 2] = b;
    }
    if (p === 0 || p === spec.count - 1) {
      const v = (base + spec.count * this.radial + (p === 0 ? 0 : 1)) * 3;
      c[v] = r;
      c[v + 1] = g;
      c[v + 2] = b;
    }
  }

  markColorsDirty(): void {
    this.color.needsUpdate = true;
  }

  /**
   * Rebuild from `points` (3 floats per point, strips concatenated in order).
   * `radiusScale` thickens everything uniformly (minimum on-screen size).
   */
  update(points: Float32Array, radiusScale = 1, onlyStrip = -1): void {
    const P = this.pos.array as Float32Array;
    const N = this.nrm.array as Float32Array;
    const R = this.radial;
    const cosT = new Float32Array(R);
    const sinT = new Float32Array(R);
    for (let r = 0; r < R; r++) {
      cosT[r] = Math.cos((r / R) * Math.PI * 2);
      sinT[r] = Math.sin((r / R) * Math.PI * 2);
    }
    for (let s = 0; s < this.strips.length; s++) {
      if (onlyStrip >= 0 && s !== onlyStrip) continue;
      const spec = this.strips[s];
      const n = spec.count;
      const po = this.pointOffset[s] * 3;
      const vo = this.vertOffset[s];
      const scale = radiusScale * this.stripScale[s];
      // Frame state.
      let tx = 0,
        ty = 0,
        tz = 1,
        nx = 1,
        ny = 0,
        nz = 0;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        let dx = points[po + i1 * 3] - points[po + i0 * 3];
        let dy = points[po + i1 * 3 + 1] - points[po + i0 * 3 + 1];
        let dz = points[po + i1 * 3 + 2] - points[po + i0 * 3 + 2];
        let dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-9) {
          dx = tx;
          dy = ty;
          dz = tz;
          dl = 1;
        }
        dx /= dl;
        dy /= dl;
        dz /= dl;
        if (i === 0) {
          // Initial normal: any perpendicular.
          if (Math.abs(dx) < 0.9) {
            nx = 0;
            ny = dz;
            nz = -dy;
          } else {
            nx = -dz;
            ny = 0;
            nz = dx;
          }
        } else {
          // Parallel transport: remove the tangent component from the previous normal.
          const d = nx * dx + ny * dy + nz * dz;
          nx -= d * dx;
          ny -= d * dy;
          nz -= d * dz;
        }
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        tx = dx;
        ty = dy;
        tz = dz;
        // Binormal.
        const bx = ty * nz - tz * ny;
        const by = tz * nx - tx * nz;
        const bz = tx * ny - ty * nx;
        const rad = (typeof spec.radius === 'number' ? spec.radius : spec.radius[i]) * scale;
        const cx = points[po + i * 3];
        const cy = points[po + i * 3 + 1];
        const cz = points[po + i * 3 + 2];
        for (let r = 0; r < R; r++) {
          const ox = cosT[r] * nx + sinT[r] * bx;
          const oy = cosT[r] * ny + sinT[r] * by;
          const oz = cosT[r] * nz + sinT[r] * bz;
          const v = (vo + i * R + r) * 3;
          P[v] = cx + ox * rad;
          P[v + 1] = cy + oy * rad;
          P[v + 2] = cz + oz * rad;
          N[v] = ox;
          N[v + 1] = oy;
          N[v + 2] = oz;
        }
        if (i === 0 || i === n - 1) {
          const sign = i === 0 ? -1 : 1;
          const v = (vo + n * R + (i === 0 ? 0 : 1)) * 3;
          P[v] = cx + sign * tx * rad;
          P[v + 1] = cy + sign * ty * rad;
          P[v + 2] = cz + sign * tz * rad;
          N[v] = sign * tx;
          N[v + 1] = sign * ty;
          N[v + 2] = sign * tz;
        }
      }
    }
    this.pos.needsUpdate = true;
    this.nrm.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** Write an instance matrix for a stick from `p` along unit `d`, length `l`, radius `r`. */
export function stickMatrix(
  out: Float32Array,
  i: number,
  px: number,
  py: number,
  pz: number,
  dx: number,
  dy: number,
  dz: number,
  l: number,
  r: number,
): void {
  // Perpendiculars to d.
  let ax: number, ay: number, az: number;
  if (Math.abs(dx) < 0.9) {
    ax = 0;
    ay = dz;
    az = -dy;
  } else {
    ax = -dz;
    ay = 0;
    az = dx;
  }
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;
  // b = a × d keeps the basis right-handed (no mirrored instances).
  const bx = ay * dz - az * dy;
  const by = az * dx - ax * dz;
  const bz = ax * dy - ay * dx;
  const o = i * 16;
  out[o] = ax * r;
  out[o + 1] = ay * r;
  out[o + 2] = az * r;
  out[o + 3] = 0;
  out[o + 4] = dx * l;
  out[o + 5] = dy * l;
  out[o + 6] = dz * l;
  out[o + 7] = 0;
  out[o + 8] = bx * r;
  out[o + 9] = by * r;
  out[o + 10] = bz * r;
  out[o + 11] = 0;
  out[o + 12] = px;
  out[o + 13] = py;
  out[o + 14] = pz;
  out[o + 15] = 1;
}

/** Unit cylinder from y = 0 to y = 1 (radius 1), for stick instances. */
export function stickGeometry(radial = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, radial, 1, false);
  g.translate(0, 0.5, 0);
  return g;
}

/** Write a uniform-scale sphere instance matrix. */
export function sphereMatrix(out: Float32Array, i: number, x: number, y: number, z: number, r: number): void {
  const o = i * 16;
  out.fill(0, o, o + 16);
  out[o] = r;
  out[o + 5] = r;
  out[o + 10] = r;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}
