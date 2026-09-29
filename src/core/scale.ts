/**
 * The single scale axis (spec §3): s = log10(field of view in nm).
 */
import type { Stage } from '../state/store';

export const S_MIN = Math.log10(15);
export const S_MAX = Math.log10(40000);

/** Stage presets: field of view (nm). */
export const STAGE_FOV_NM: Record<Stage, number> = { 1: 360, 2: 2800, 3: 25000 };
/** Width the stage 1 view must fit across (the long isoform plus its labels), nm. */
export const MOLECULE_FIT_NM = 440;

export const STAGE_NAMES: Record<Stage, string> = {
  1: 'Molecule & probes',
  2: 'Diffraction',
  3: 'Cell',
};

const L = Math.log10;
/** Cross-fade bands (spec §3). */
export const BAND_MOL_OPT: [number, number] = [L(480), L(950)];
export const BAND_OPT_CELL: [number, number] = [L(4000), L(8000)];
/** Bases grow in below this FOV (spec §4.6). */
export const BASE_LOD: [number, number] = [L(90), L(140)];

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface SceneWeights {
  mol: number;
  opt: number;
  cell: number;
}

export function sceneWeights(s: number): SceneWeights {
  const a = smoothstep(BAND_MOL_OPT[0], BAND_MOL_OPT[1], s);
  const b = smoothstep(BAND_OPT_CELL[0], BAND_OPT_CELL[1], s);
  return { mol: 1 - a, opt: a * (1 - b), cell: b };
}

/** The stage whose scale range contains s (used for the HUD when the user scrolls freely). */
export function stageForScale(s: number): Stage {
  if (s < L(650)) return 1;
  if (s < L(6000)) return 2;
  return 3;
}

/** 1-2-5 scale bar: the largest nice length (nm) that fits in maxPx. */
export function niceScaleBar(nmPerPx: number, maxPx = 140): { nm: number; px: number; label: string } {
  const target = nmPerPx * maxPx;
  const exp = Math.floor(Math.log10(target));
  let nm = Math.pow(10, exp);
  for (const m of [5, 2, 1]) {
    if (m * Math.pow(10, exp) <= target) {
      nm = m * Math.pow(10, exp);
      break;
    }
  }
  return { nm, px: nm / nmPerPx, label: formatLength(nm) };
}

export function formatLength(nm: number): string {
  if (nm >= 1000) {
    const um = nm / 1000;
    return `${um >= 10 ? um.toFixed(0) : +um.toFixed(1)} µm`;
  }
  return `${nm >= 10 ? nm.toFixed(0) : +nm.toFixed(1)} nm`;
}
