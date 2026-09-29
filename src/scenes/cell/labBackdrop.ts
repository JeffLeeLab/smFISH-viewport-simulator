/**
 * Decorative backdrop for the cell stage (spec §5): a dim microscopy lab with benches,
 * microscopes, shelves and a monitor, built from primitives (no assets). It is rendered at
 * low resolution from a camera that turns with the main view but never moves, then blurred,
 * so it reads as an out-of-focus room around the sample. Units: metres, z up. Not to scale
 * with the cell, and not meant to be.
 */
import * as THREE from 'three';
import { Rng } from '../../data/rng';

const EYE = new THREE.Vector3(0, -0.8, 1.45);

function mat(color: THREE.ColorRepresentation, rough = 0.7, metal = 0, emissive?: THREE.ColorRepresentation, ei = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  if (emissive !== undefined) {
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = ei;
  }
  return m;
}

function box(w: number, d: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m);
  b.position.set(x, y, z);
  return b;
}

function cyl(r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 20): THREE.Mesh {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  c.rotation.x = Math.PI / 2; // cylinders stand along z
  c.position.set(x, y, z);
  return c;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** An upright fluorescence microscope, roughly 0.6 m tall, facing −y (toward its user). */
function microscope(rng: Rng, accent: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  const body = mat(0x2a2f38, 0.45, 0.3);
  const dark = mat(0x0f1115, 0.5, 0.4);
  const chrome = mat(0x8a93a3, 0.25, 0.9);
  g.add(box(0.34, 0.42, 0.06, body, 0, 0, 0.03)); // base
  g.add(box(0.12, 0.12, 0.46, body, 0, 0.15, 0.28)); // pillar
  g.add(box(0.12, 0.34, 0.1, body, 0, 0.02, 0.5)); // arm
  g.add(box(0.26, 0.2, 0.025, dark, 0, -0.04, 0.24)); // stage
  g.add(cyl(0.035, 0.05, chrome, 0, -0.04, 0.39)); // nosepiece
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const o = cyl(0.011, 0.06 + i * 0.008, chrome, Math.cos(a) * 0.028, -0.04 + Math.sin(a) * 0.028, 0.34);
    g.add(o);
  }
  // Binocular head angled toward the user.
  const head = new THREE.Group();
  head.add(box(0.1, 0.12, 0.06, body, 0, 0, 0));
  for (const x of [-0.03, 0.03]) {
    const e = cyl(0.012, 0.1, dark, x, -0.07, 0.03);
    e.rotation.x = Math.PI / 2 - 0.6;
    head.add(e);
  }
  head.position.set(0, -0.08, 0.58);
  g.add(head);
  // Epi-fluorescence lamp housing with a glowing filter-cube indicator.
  g.add(box(0.1, 0.16, 0.08, dark, 0, 0.28, 0.5));
  g.add(box(0.02, 0.005, 0.02, mat(0x000000, 1, 0, accent, 3), 0.03, 0.2, 0.52));
  // Knobs.
  for (const x of [-0.08, 0.08]) {
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 20), chrome);
    k.rotation.z = Math.PI / 2; // axle along x
    k.position.set(x, 0.12, 0.2);
    g.add(k);
  }
  g.rotation.z = rng.range(-0.25, 0.25);
  return g;
}

function bottle(rng: Rng, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const tint = [0x3a2a18, 0x1d2b3d, 0x2d3a2a, 0x3b3b40][rng.int(4)];
  const h = rng.range(0.12, 0.26);
  const r = rng.range(0.03, 0.05);
  g.add(cyl(r, h, mat(tint, 0.15, 0.1), 0, 0, h / 2));
  g.add(cyl(r * 0.45, 0.04, mat([0x2255aa, 0xaa3322, 0xdddddd, 0x33aa55][rng.int(4)], 0.5), 0, 0, h + 0.02));
  const label = cyl(r * 1.01, h * 0.35, mat(0xbfc4cc, 0.8), 0, 0, h * 0.45);
  g.add(label);
  g.position.set(x, y, z);
  return g;
}

export class LabBackdrop {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.05, 40);

  constructor() {
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(EYE);
    const rng = new Rng(20260929);
    const s = this.scene;

    // Room shell: floor tiles, dark walls, a dim ceiling.
    const tiles = canvasTexture(512, 512, (g) => {
      g.fillStyle = '#1b1e24';
      g.fillRect(0, 0, 512, 512);
      g.strokeStyle = '#101216';
      g.lineWidth = 4;
      for (let i = 0; i <= 512; i += 128) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i, 512);
        g.moveTo(0, i);
        g.lineTo(512, i);
        g.stroke();
      }
    });
    tiles.wrapS = tiles.wrapT = THREE.RepeatWrapping;
    tiles.repeat.set(5, 5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.35, metalness: 0.1 }));
    s.add(floor);
    const wallMat = mat(0x1a2130, 0.9);
    const W = 4.5;
    const H = 3;
    const walls: [number, number][] = [
      [0, W],
      [0, -W],
      [W, 0],
      [-W, 0],
    ];
    for (const [x, y] of walls) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(2 * W, H), wallMat);
      w.position.set(x, y, H / 2);
      w.up.set(0, 0, 1);
      w.lookAt(0, 0, H / 2); // face into the room
      s.add(w);
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * W, 2 * W), mat(0x10141c, 1));
    ceiling.position.z = H;
    ceiling.rotation.x = Math.PI;
    s.add(ceiling);
    // Ceiling light panels, mostly off (it's a dark imaging room); one on low.
    for (const [x, y, on] of [
      [-1.5, 1.5, 0.35],
      [1.5, 1.5, 0.05],
      [-1.5, -1.5, 0.05],
      [1.5, -1.5, 0.05],
    ] as const) {
      const p = box(1.2, 0.3, 0.02, mat(0x000000, 1, 0, 0xdfe8ff, on), x, y, H - 0.02);
      s.add(p);
    }

    // Benches around the room, epoxy tops.
    const top = mat(0x14171c, 0.3, 0.2);
    const cab = mat(0x252b36, 0.8);
    const bench = (x: number, y: number, w: number, d: number, rz = 0) => {
      const g = new THREE.Group();
      g.add(box(w, d, 0.04, top, 0, 0, 0.9));
      g.add(box(w - 0.04, d - 0.06, 0.86, cab, 0, 0.02, 0.43));
      g.position.set(x, y, 0);
      g.rotation.z = rz;
      s.add(g);
      return g;
    };
    bench(0, 0.45, 2.8, 0.8); // the bench in front of the viewer
    bench(0, W - 0.45, 6, 0.8); // back wall
    bench(W - 0.45, 0, 5, 0.8, Math.PI / 2); // right wall
    bench(-W + 0.45, 0.6, 4, 0.8, Math.PI / 2); // left wall
    bench(-0.6, -W + 0.45, 5.4, 0.8, Math.PI); // front wall (behind the viewer)

    // Microscopes: one on the near bench, others around the room.
    // Rotation turns each scope's eyepieces (local −y) toward the room.
    const scopes: [number, number, number, THREE.ColorRepresentation][] = [
      [0.45, 0.55, 0.25, 0x3cff6a],
      [-0.95, 0.55, -0.2, 0xff3cf0],
      [-1.8, W - 0.45, 0, 0x4a7bff],
      [0.9, W - 0.45, 0, 0xff3cf0],
      [W - 0.45, -1.2, -Math.PI / 2, 0x3cff6a],
      [-W + 0.45, 1.6, Math.PI / 2, 0xffb347],
    ];
    for (const [x, y, rz, accent] of scopes) {
      const m = microscope(rng, accent);
      m.position.set(x, y, 0.92);
      m.rotation.z += rz;
      s.add(m);
    }
    const shelfMat = mat(0x2a303b, 0.7);
    // Behind the viewer: two more scopes, an incubator, a centrifuge and wall shelves.
    for (const [x, accent] of [
      [-2.3, 0x3cff6a],
      [0.4, 0x4a7bff],
    ] as const) {
      const m = microscope(rng, accent);
      m.position.set(x, -W + 0.45, 0.92);
      m.rotation.z += Math.PI;
      s.add(m);
    }
    const inc = new THREE.Group();
    inc.add(box(0.7, 0.7, 0.9, mat(0xc9ced6, 0.5, 0.2), 0, 0, 0.45));
    inc.add(box(0.16, 0.01, 0.06, mat(0x000000, 1, 0, 0x6dff9a, 2.2), 0.18, 0.355, 0.78));
    inc.add(box(0.04, 0.02, 0.5, mat(0x8a93a3, 0.3, 0.8), -0.28, 0.36, 0.45));
    inc.position.set(1.8, -W + 0.45, 0.92);
    inc.rotation.z = Math.PI;
    s.add(inc);
    const cent = new THREE.Group();
    cent.add(cyl(0.22, 0.28, mat(0xe2e5ea, 0.4, 0.1), 0, 0, 0.14, 28));
    cent.add(cyl(0.2, 0.02, mat(0x1b2230, 0.3, 0.3), 0, 0, 0.29, 28));
    cent.add(box(0.08, 0.01, 0.03, mat(0x000000, 1, 0, 0xff5a3c, 2.5), 0, -0.22, 0.2));
    cent.position.set(-1.1, -W + 0.45, 0.92);
    s.add(cent);
    for (let row = 0; row < 2; row++) {
      const z = 1.6 + row * 0.45;
      s.add(box(5, 0.3, 0.03, shelfMat, -0.6, -W + 0.2, z));
      for (let i = 0; i < 16; i++) s.add(bottle(rng, -3 + i * 0.3 + rng.range(-0.05, 0.05), -W + 0.2, z + 0.015));
    }
    // A door on the right wall with a lit exit sign.
    s.add(box(0.02, 1, 2.1, mat(0x2b3140, 0.6), W - 0.02, -2.6, 1.05));
    s.add(box(0.02, 0.3, 0.12, mat(0x000000, 1, 0, 0x33ff77, 2.5), W - 0.03, -2.6, 2.3));

    // A confocal enclosure: big black box with a blue status strip.
    const conf = new THREE.Group();
    conf.add(box(1.1, 0.7, 0.8, mat(0x08090c, 0.6, 0.2), 0, 0, 0.4));
    conf.add(box(0.9, 0.01, 0.02, mat(0x000000, 1, 0, 0x3a6bff, 2.5), 0, -0.355, 0.7));
    conf.position.set(W - 0.5, 1.8, 0.92);
    s.add(conf);

    // Monitor on the near bench showing an smFISH image.
    const screen = canvasTexture(512, 320, (g) => {
      g.fillStyle = '#0b0d12';
      g.fillRect(0, 0, 512, 320);
      g.fillStyle = '#1a1f2a';
      g.fillRect(0, 0, 512, 22);
      g.fillRect(380, 22, 132, 298);
      g.fillStyle = '#000';
      g.fillRect(12, 34, 356, 274);
      const grd = g.createRadialGradient(170, 170, 10, 170, 170, 80);
      grd.addColorStop(0, 'rgba(74,123,255,0.9)');
      grd.addColorStop(1, 'rgba(74,123,255,0)');
      g.fillStyle = grd;
      g.fillRect(12, 34, 356, 274);
      for (let i = 0; i < 90; i++) {
        const x = 20 + rng.next() * 340;
        const y = 40 + rng.next() * 260;
        g.fillStyle = rng.next() < 0.6 ? '#ffffff' : '#ff3cf0';
        g.beginPath();
        g.arc(x, y, 1.6 + rng.next(), 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#2a3244';
      for (let i = 0; i < 8; i++) g.fillRect(392, 40 + i * 30, 90 + rng.next() * 20, 10);
    });
    const monitor = new THREE.Group();
    monitor.add(box(0.62, 0.03, 0.38, mat(0x0c0d10, 0.4, 0.3), 0, 0, 0.3));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), new THREE.MeshBasicMaterial({ map: screen }));
    face.rotation.x = Math.PI / 2; // faces local −y
    face.position.set(0, -0.017, 0.3);
    monitor.add(face);
    monitor.add(box(0.05, 0.05, 0.12, mat(0x0c0d10, 0.4), 0, 0.02, 0.06));
    monitor.position.set(-0.25, 0.72, 0.92);
    monitor.rotation.z = 0.5; // angled toward the viewer
    s.add(monitor);
    const glow = new THREE.PointLight(0x7a9cff, 0.6, 2.2, 2);
    glow.position.set(-0.25, 0.4, 1.25);
    s.add(glow);

    // Bench clutter: tube racks, pipettes, an ice bucket.
    const rack = new THREE.Group();
    rack.add(box(0.26, 0.1, 0.04, mat(0x2f6fb5, 0.6), 0, 0, 0.02));
    const caps = [0xff4d4d, 0xffd24d, 0x4dff88, 0x4d9dff, 0xffffff];
    for (let i = 0; i < 12; i++) {
      rack.add(cyl(0.008, 0.06, mat(caps[rng.int(caps.length)], 0.5), -0.11 + (i % 6) * 0.044, i < 6 ? -0.02 : 0.02, 0.07));
    }
    rack.position.set(1.0, 0.3, 0.92);
    s.add(rack);

    // Shelves with bottles on the back wall.
    for (let row = 0; row < 3; row++) {
      const z = 1.45 + row * 0.42;
      s.add(box(5, 0.3, 0.03, shelfMat, 0, W - 0.2, z));
      for (let i = 0; i < 18; i++) s.add(bottle(rng, -2.4 + i * 0.28 + rng.range(-0.05, 0.05), W - 0.2, z + 0.015));
    }

    // A window at night on the left wall.
    const win = canvasTexture(256, 160, (g) => {
      const sky = g.createLinearGradient(0, 0, 0, 160);
      sky.addColorStop(0, '#0a1430');
      sky.addColorStop(1, '#1b2a4d');
      g.fillStyle = sky;
      g.fillRect(0, 0, 256, 160);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = rng.next() < 0.7 ? '#ffd79a' : '#9ac4ff';
        g.fillRect(rng.next() * 256, 90 + rng.next() * 70, 2, 2);
      }
    });
    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), new THREE.MeshBasicMaterial({ map: win, color: 0x8899bb }));
    windowMesh.position.set(-W + 0.01, -1.4, 1.75);
    windowMesh.up.set(0, 0, 1);
    windowMesh.lookAt(0, -1.4, 1.75);
    s.add(windowMesh);

    // Instrument LEDs scattered around (they bloom into soft bokeh once blurred).
    const ledColors = [0x3cff6a, 0xff3b3b, 0x4a7bff, 0xffb347];
    for (let i = 0; i < 26; i++) {
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), mat(0x000000, 1, 0, ledColors[rng.int(4)], 4));
      const side = rng.int(3);
      const t = rng.range(-2, 2);
      if (side === 0) led.position.set(t, W - 0.42, rng.range(0.3, 0.88));
      else if (side === 1) led.position.set(W - 0.42, t, rng.range(0.3, 0.88));
      else led.position.set(-W + 0.42, t, rng.range(0.3, 0.88));
      s.add(led);
    }

    // Lighting: a dim room, a warm desk lamp over the near bench.
    s.add(new THREE.HemisphereLight(0x8fa6d6, 0x1c1c1c, 0.6));
    const lamp = new THREE.PointLight(0xffc98a, 2.2, 3.5, 2);
    lamp.position.set(0.3, 0.3, 1.75);
    s.add(lamp);
    s.add(box(0.14, 0.14, 0.04, mat(0x000000, 1, 0, 0xffd9a8, 2), 0.3, 0.3, 1.77));
    const back = new THREE.PointLight(0xffd2a0, 1.1, 3.2, 2);
    back.position.set(0.2, -W + 1.0, 1.8);
    s.add(back);
    const fill = new THREE.PointLight(0x6f86c0, 1.2, 6, 2);
    fill.position.set(-1.5, 1.5, 2.6);
    s.add(fill);
  }

  /**
   * Follow the main camera's heading exactly, but with its tilt halved: looking steeply
   * down at the cell still shows the room (benches, microscopes) rather than the floor.
   * The camera never moves, so the room behaves like a distant backdrop.
   */
  sync(q: THREE.Quaternion, aspect: number): void {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const yaw = Math.atan2(f.y, f.x);
    const pitch = Math.asin(Math.max(-1, Math.min(1, f.z))) * 0.5;
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch));
    this.camera.lookAt(this.camera.position.clone().add(dir));
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
