/** Colour tokens (spec §5), as three.js colours (linear working space). */
import * as THREE from 'three';
import type { RegionId } from '../data/transcript';
import type { ProbeSetId } from '../data/probes';

export const TOKENS = {
  cap: '#C9A24A',
  utr5: '#1F5A63',
  cds: '#2E3478',
  utr3: '#5E2745',
  utr3ext: '#6A4A1E',
  polya: '#3C424C',
  probe: '#D9DCE3',
  green: '#3CFF6A',
  magenta: '#FF3CF0',
  dapi: '#4A7BFF',
  background: '#05070A',
} as const;

/**
 * The region tokens are deliberately dark; lit surfaces need a little lift to read on the
 * near-black background, so the rendered base colour is the token brightened slightly.
 */
function lifted(hex: string, amount = 1.9): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(amount);
}

export const REGION_COLOR: Record<RegionId, THREE.Color> = {
  utr5: lifted(TOKENS.utr5),
  cds: lifted(TOKENS.cds, 2.1),
  utr3: lifted(TOKENS.utr3),
  utr3ext: lifted(TOKENS.utr3ext),
  polya: lifted(TOKENS.polya, 1.6),
};

export const NT_COLOR: Record<string, THREE.Color> = {
  A: new THREE.Color('#C8644E'),
  U: new THREE.Color('#C9A640'),
  G: new THREE.Color('#5F9E6E'),
  C: new THREE.Color('#5B84C4'),
};

export const PROBE_COLOR = new THREE.Color(TOKENS.probe);
export const CAP_COLOR = new THREE.Color(TOKENS.cap);

export const SET_COLOR: Record<ProbeSetId, THREE.Color> = {
  cds: new THREE.Color(TOKENS.magenta),
  distal: new THREE.Color(TOKENS.green),
};

export const CHANNEL_COLOR = {
  green: new THREE.Color(TOKENS.green),
  magenta: new THREE.Color(TOKENS.magenta),
  dapi: new THREE.Color(TOKENS.dapi),
};
