/** Small observable app store with URL-hash sync (spec §8, "Shareable state"). */
import { IMMERSIONS, clampNa, type ImmersionId } from '../data/optics';
import { PROBES_DEFAULT, PROBES_MAX } from '../data/probes';
import { DEFAULT_LONG_FRACTION } from '../data/cell';

export type Stage = 1 | 2 | 3 | 4;
export type HybPhase = 'none' | 'running' | 'bound';

export interface AppState {
  stage: Stage;
  /** Which molecule stages 1–2 focus on. */
  isoform: 'long' | 'short';
  labels: boolean;
  colorByNt: boolean;
  autoRotate: boolean;
  helical: boolean;
  showEnds: boolean;
  showCdsSet: boolean;
  showDistalSet: boolean;
  probesPerSet: number;
  hyb: HybPhase;
  washed: boolean;
  animSpeed: number;
  diffraction: boolean;
  ellipsoid: boolean;
  immersion: ImmersionId;
  na: number;
  /** Focal plane height relative to the featured molecules (stage 3) or coverslip (stage 4), µm. */
  focalZ: number;
  cellFocalZ: number;
  chGreen: boolean;
  chMagenta: boolean;
  chDapi: boolean;
  noise: boolean;
  pixels: boolean;
  chromatic: boolean;
  mip: boolean;
  cellOutline: boolean;
  /** Dim, blurred lab room behind the cell stage. */
  labBackdrop: boolean;
  longFraction: number;
  seed: number;
  presentation: boolean;
  help: boolean;
  /** Camera for share links: target xyz + azimuth, polar, log10 FOV(nm). Empty = stage preset. */
  cam: number[];
}

export const DEFAULT_STATE: AppState = {
  stage: 1,
  isoform: 'long',
  labels: true,
  colorByNt: false,
  autoRotate: false,
  helical: false,
  showEnds: true,
  showCdsSet: true,
  showDistalSet: true,
  probesPerSet: PROBES_DEFAULT,
  hyb: 'none',
  washed: false,
  animSpeed: 1,
  diffraction: true,
  ellipsoid: true,
  immersion: 'oil',
  na: IMMERSIONS.oil.naDefault,
  focalZ: 0,
  cellFocalZ: 1.6,
  chGreen: true,
  chMagenta: true,
  chDapi: true,
  noise: true,
  pixels: true,
  chromatic: false,
  mip: false,
  cellOutline: true,
  labBackdrop: true,
  longFraction: DEFAULT_LONG_FRACTION,
  seed: 1,
  presentation: false,
  help: false,
  cam: [],
};

type Listener = (state: AppState, prev: AppState) => void;

export class Store {
  private s: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.s = initial;
  }

  get state(): Readonly<AppState> {
    return this.s;
  }

  set(patch: Partial<AppState>): void {
    const prev = this.s;
    let changed = false;
    for (const k of Object.keys(patch) as (keyof AppState)[]) {
      if (!Object.is(prev[k], patch[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.s = { ...prev, ...patch };
    for (const l of this.listeners) l(this.s, prev);
  }

  toggle(key: { [K in keyof AppState]: AppState[K] extends boolean ? K : never }[keyof AppState]): void {
    this.set({ [key]: !this.s[key] } as Partial<AppState>);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call `fn` whenever any of `keys` changes (and once immediately). */
  watch<K extends keyof AppState>(keys: K[], fn: (state: AppState) => void): () => void {
    fn(this.s);
    return this.subscribe((s, p) => {
      if (keys.some((k) => !Object.is(s[k], p[k]))) fn(s);
    });
  }
}

// ---------------------------------------------------------------------------------------
// URL hash
// ---------------------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Serialise the shareable subset of state, e.g. `stage=3&na=1.4&imm=oil&n=10&ch=gm`. */
export function toHash(s: AppState): string {
  const p = new URLSearchParams();
  p.set('stage', String(s.stage));
  if (s.isoform !== 'long') p.set('iso', s.isoform);
  p.set('na', s.na.toFixed(2).replace(/0$/, ''));
  p.set('imm', s.immersion);
  p.set('n', String(s.probesPerSet));
  p.set('ch', (s.chGreen ? 'g' : '') + (s.chMagenta ? 'm' : '') + (s.chDapi ? 'd' : '') || '-');
  p.set('wash', s.washed ? '1' : '0');
  if (s.helical) p.set('helix', '1');
  if (s.longFraction !== DEFAULT_LONG_FRACTION) p.set('long', String(Math.round(s.longFraction * 100)));
  if (s.seed !== DEFAULT_STATE.seed) p.set('seed', String(s.seed));
  if (s.mip) p.set('mip', '1');
  if (s.cam.length === 6) p.set('cam', s.cam.map((v) => +v.toFixed(4)).join(','));
  return p.toString().replace(/%2C/g, ',');
}

/** Parse a hash into a state patch. Unknown or invalid values are ignored. */
export function fromHash(hash: string): Partial<AppState> {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const out: Partial<AppState> = {};
  const stage = Number(p.get('stage'));
  if ([1, 2, 3, 4].includes(stage)) out.stage = stage as Stage;
  const iso = p.get('iso');
  if (iso === 'long' || iso === 'short') out.isoform = iso;
  const imm = p.get('imm');
  const immersion: ImmersionId = imm && imm in IMMERSIONS ? (imm as ImmersionId) : 'oil';
  if (imm && imm in IMMERSIONS) out.immersion = immersion;
  const na = Number(p.get('na'));
  if (p.has('na') && Number.isFinite(na)) out.na = clampNa(na, immersion);
  const n = Number(p.get('n'));
  if (p.has('n') && Number.isFinite(n)) out.probesPerSet = clamp(Math.round(n), 1, PROBES_MAX);
  const ch = p.get('ch');
  if (ch !== null) {
    out.chGreen = ch.includes('g');
    out.chMagenta = ch.includes('m');
    out.chDapi = ch.includes('d');
  }
  if (p.has('wash')) out.washed = p.get('wash') === '1';
  if (p.has('helix')) out.helical = p.get('helix') === '1';
  const long = Number(p.get('long'));
  if (p.has('long') && Number.isFinite(long)) out.longFraction = clamp(long, 0, 100) / 100;
  const seed = Number(p.get('seed'));
  if (p.has('seed') && Number.isInteger(seed) && seed > 0) out.seed = seed;
  if (p.has('mip')) out.mip = p.get('mip') === '1';
  const cam = p.get('cam');
  if (cam) {
    const v = cam.split(',').map(Number);
    if (v.length === 6 && v.every(Number.isFinite)) out.cam = v;
  }
  return out;
}

export function initialState(hash: string): AppState {
  const patch = fromHash(hash);
  const s = { ...DEFAULT_STATE, ...patch };
  // Jumping straight to the optical or cell stage implies a finished, washed experiment.
  if (s.stage >= 3) {
    s.hyb = 'bound';
    if (patch.washed === undefined) s.washed = true;
  } else if (s.stage === 2) {
    // A link to the hybridisation stage plays the hybridisation.
    s.hyb = 'running';
    if (patch.washed === undefined) s.washed = false;
  }
  return s;
}

/** Keep location.hash in sync (debounced) and apply manual hash edits. */
export function bindHash(store: Store): void {
  let timer = 0;
  let lastWritten = '';
  store.subscribe((s) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const h = toHash(s);
      if (h !== lastWritten) {
        lastWritten = h;
        history.replaceState(null, '', '#' + h);
      }
    }, 250);
  });
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace(/^#/, '');
    if (h === lastWritten) return;
    // Stage side effects (hybridise, wash) are applied by the app's stage watcher.
    store.set(fromHash(h));
  });
}
