/** Control panel (spec §6, §8): stage buttons, channels and per-stage controls. */
import type { AppState, Stage, Store } from '../state/store';
import type { App } from '../app';
import { IMMERSIONS, clampNa, type ImmersionId } from '../data/optics';
import { PROBES_MAX } from '../data/probes';
import { STAGE_NAMES } from '../core/scale';
import { Controls, el } from './controls';

export class Panel {
  private sections: Record<Stage, HTMLElement>;
  constructor(root: HTMLElement, store: Store, app: App) {
    const c = new Controls(store);
    const set = (patch: Partial<AppState>) => store.set(patch);

    // Head.
    const handle = el('button', { class: 'sheet-handle', type: 'button', 'aria-label': 'Resize panel' });
    root.append(
      handle,
      el(
        'header',
        { class: 'panel-head' },
        el('h1', {}, 'smFISH Viewport'),
        el('div', { class: 'sub' }, 'Single-molecule FISH, from one mRNA to a whole cell'),
      ),
    );
    this.bindSheet(root, handle);

    // Stage buttons.
    const stages = el('nav', { class: 'stages', 'aria-label': 'Stages' });
    const stageBtns = ([1, 2, 3, 4] as Stage[]).map((n) => {
      const b = el(
        'button',
        { class: 'stage-btn', type: 'button', 'aria-pressed': 'false', title: `${STAGE_NAMES[n]} (${n})` },
        el('span', { class: 'n' }, String(n)),
        el('span', { class: 't' }, STAGE_NAMES[n]),
      );
      b.addEventListener('click', () => app.goToStage(n));
      stages.append(b);
      return b;
    });
    c.onRefresh((s) => stageBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(s.stage === i + 1))));
    root.append(stages);

    // Channels (always visible).
    const chan = (label: string, color: string, key: 'chGreen' | 'chMagenta' | 'chDapi', kbd: string) => {
      const b = el(
        'button',
        { class: 'ch-btn', type: 'button', 'aria-pressed': 'false', title: `${label} (${kbd})` },
        el('span', { class: 'sw-dot', style: `background:${color};color:${color}` }),
        label,
      );
      b.addEventListener('click', () => store.toggle(key));
      c.onRefresh((s) => {
        b.setAttribute('aria-pressed', String(s[key]));
        if (key === 'chDapi') (b as HTMLButtonElement).disabled = s.stage !== 4;
      });
      return b;
    };
    const merge = el(
      'button',
      { class: 'ch-btn', type: 'button', 'aria-pressed': 'false', title: 'Merge: show green and magenta together' },
      el('span', { class: 'sw-dot', style: 'background:#fff;color:#fff' }),
      'Merge',
    );
    merge.addEventListener('click', () => set({ chGreen: true, chMagenta: true }));
    c.onRefresh((s) => merge.setAttribute('aria-pressed', String(s.chGreen && s.chMagenta)));
    const why = c.info(
      'Alexa 546 actually looks yellow-orange and Alexa 647 is far-red, barely visible to the eye. Microscopy software shows each channel in a <b>pseudocolour</b>. Green and magenta are easy to tell apart, colour-blind friendly, and add up to white where they overlap.',
    );
    root.append(
      c.section(
        'Channels',
        el('div', { class: 'channels' }, chan('Green', 'var(--green)', 'chGreen', 'G'), chan('Magenta', 'var(--magenta)', 'chMagenta', 'M'), chan('DAPI', 'var(--dapi)', 'chDapi', 'D'), merge),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('span', { class: 'hint-text', style: 'margin:0' }, 'Why green and magenta?'), why.button),
        why.pop,
      ),
    );
    root.querySelector('.section h3')!.append(el('span', { class: 'hint-text', style: 'margin:0;text-transform:none;letter-spacing:0' }, 'Alexa 546 · Alexa 647'));

    const probesSlider = () =>
      c.slider({
        label: 'Probes per set',
        min: 1,
        max: PROBES_MAX,
        step: 1,
        get: (s) => s.probesPerSet,
        set: (v) => set({ probesPerSet: v }),
        format: (v) => `${v}`,
      });

    // Stage 1.
    const s1 = c.section(
      '1 · Molecule',
      c.segmented({ label: 'Isoform', options: [{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }], get: (s) => s.isoform, set: (v) => set({ isoform: v }) }),
      c.toggle({ label: 'Region labels', get: (s) => s.labels, set: (v) => set({ labels: v }) }),
      c.toggle({ label: 'Colour by nucleotide', get: (s) => s.colorByNt, set: (v) => set({ colorByNt: v }) }),
      c.toggle({ label: 'Auto-rotate', get: (s) => s.autoRotate, set: (v) => set({ autoRotate: v }) }),
      el('div', { class: 'hint-text' }, 'Zoom in (below ~120 nm) to see individual bases. Made-up sequence for teaching.'),
    );

    // Stage 2.
    const hybBtn = c.button('Hybridise', () => set({ hyb: 'running' }), { kbd: 'H', primary: true });
    const washBtn = c.button('Wash', () => set({ washed: true }), { kbd: 'W' });
    c.onRefresh((s) => {
      hybBtn.firstChild!.textContent = s.hyb === 'none' ? 'Hybridise ' : 'Replay ';
      (washBtn as HTMLButtonElement).disabled = s.hyb === 'none' || s.washed;
      washBtn.style.opacity = s.hyb === 'none' || s.washed ? '0.45' : '';
      washBtn.firstChild!.textContent = s.washed ? 'Washed ' : 'Wash ';
    });
    const isoBtn = c.button('Show short isoform', () => set({ isoform: store.state.isoform === 'long' ? 'short' : 'long' }));
    c.onRefresh((s) => (isoBtn.textContent = s.isoform === 'long' ? 'Show short isoform' : 'Show long isoform'));
    const s2 = c.section(
      '2 · Hybridise',
      el('div', { class: 'btn-row', style: 'margin-top:0' }, hybBtn, washBtn, isoBtn),
      c.segmented({ label: 'Duplex', kbd: 'S', options: [{ value: 'schematic', label: 'Schematic' }, { value: 'helical', label: 'Helical' }], get: (s) => (s.helical ? 'helical' : 'schematic'), set: (v) => set({ helical: v === 'helical' }) }),
      c.toggle({ label: '5′ / 3′ labels', get: (s) => s.showEnds, set: (v) => set({ showEnds: v }) }),
      c.toggle({ label: 'CDS set (magenta)', get: (s) => s.showCdsSet, set: (v) => set({ showCdsSet: v }) }),
      c.toggle({ label: 'Distal 3′UTR set (green)', get: (s) => s.showDistalSet, set: (v) => set({ showDistalSet: v }) }),
      probesSlider(),
      c.slider({ label: 'Animation speed', min: 0.25, max: 2, step: 0.25, get: (s) => s.animSpeed, set: (v) => set({ animSpeed: v }), format: (v) => `${v}×` }),
      el('div', { class: 'hint-text' }, 'Real smFISH designs typically use ~20–48 probes per set.'),
    );

    // Stage 3.
    const imm = c.segmented<ImmersionId>({
      label: 'Immersion',
      options: (Object.keys(IMMERSIONS) as ImmersionId[]).map((id) => ({ value: id, label: IMMERSIONS[id].name })),
      get: (s) => s.immersion,
      set: (v) => set({ immersion: v, na: IMMERSIONS[v].naDefault }),
    });
    const na = c.slider({
      label: 'Numerical aperture (NA)',
      min: 0.3,
      max: 1.49,
      step: 0.01,
      range: (s) => [IMMERSIONS[s.immersion].naMin, IMMERSIONS[s.immersion].naMax],
      get: (s) => s.na,
      set: (v) => set({ na: clampNa(v, store.state.immersion) }),
      format: (v) => v.toFixed(2),
    });
    const focal = c.slider({
      label: 'Focal plane z',
      min: -1.6,
      max: 1.6,
      step: 0.05,
      get: (s) => s.focalZ,
      set: (v) => set({ focalZ: v }),
      format: (v) => `${v >= 0 ? '+' : ''}${(v * 1000).toFixed(0)} nm`,
    });
    const s3 = c.section(
      '3 · Diffraction',
      c.toggle({ label: 'Diffraction', get: (s) => s.diffraction, set: (v) => set({ diffraction: v }) }),
      c.toggle({ label: 'FWHM ellipsoid', get: (s) => s.ellipsoid, set: (v) => set({ ellipsoid: v }) }),
      imm,
      na,
      probesSlider(),
      focal,
      el('div', { class: 'hint-text' }, 'Drag the focal plane in the view, or use [ and ].'),
      app.opt.insetElement,
      app.opt.profileElement,
      c.toggle({ label: 'Camera noise', get: (s) => s.noise, set: (v) => set({ noise: v }) }),
      c.toggle({ label: 'Show camera pixels', get: (s) => s.pixels, set: (v) => set({ pixels: v }) }),
      c.toggle({ label: 'Chromatic offset', get: (s) => s.chromatic, set: (v) => set({ chromatic: v }) }),
      c.toggle({ label: 'Washed', kbd: 'W', get: (s) => s.washed, set: (v) => set({ washed: v }) }),
    );

    // Stage 4.
    const s4 = c.section(
      '4 · Cell',
      c.segmented({ label: 'View', kbd: 'P', options: [{ value: '3d', label: '3D' }, { value: 'mip', label: 'MIP' }], get: (s) => (s.mip ? 'mip' : '3d'), set: (v) => set({ mip: v === 'mip' }) }),
      c.toggle({ label: 'Cell outline', get: (s) => s.cellOutline, set: (v) => set({ cellOutline: v }) }),
      c.toggle({ label: 'Lab backdrop', get: (s) => s.labBackdrop, set: (v) => set({ labBackdrop: v }) }),
      c.slider({
        label: 'Focal plane z',
        min: 0,
        max: 6,
        step: 0.1,
        get: (s) => s.cellFocalZ,
        set: (v) => set({ cellFocalZ: v }),
        format: (v) => `${v.toFixed(1)} µm`,
      }),
      app.cell.insetElement,
      c.slider({
        label: 'Long-isoform fraction',
        min: 0,
        max: 1,
        step: 0.05,
        get: (s) => s.longFraction,
        set: (v) => set({ longFraction: v }),
        format: (v) => `${Math.round(v * 100)}%`,
      }),
      probesSlider(),
      c.toggle({ label: 'Camera noise', get: (s) => s.noise, set: (v) => set({ noise: v }) }),
      el('div', { class: 'btn-row' }, c.button('Randomise cell', () => set({ seed: (store.state.seed % 9973) + 1 + Math.floor(Math.random() * 500) }))),
      app.cell.countsElement,
    );

    this.sections = { 1: s1, 2: s2, 3: s3, 4: s4 };
    root.append(s1, s2, s3, s4);
    store.watch(['stage'], (s) => {
      for (const [k, sec] of Object.entries(this.sections)) sec.hidden = Number(k) !== s.stage;
    });

    // Footer.
    const share = c.button('Copy link', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        share.textContent = 'Link copied';
        setTimeout(() => (share.textContent = 'Copy link'), 1400);
      } catch {
        share.textContent = 'Copy failed';
      }
    });
    root.append(
      el(
        'footer',
        { class: 'panel-foot' },
        c.button('Help', () => store.toggle('help'), { kbd: '?' }),
        c.button('Screenshot', () => app.screenshot()),
        c.button('Present', () => store.toggle('presentation'), { kbd: 'F' }),
        share,
        el('div', { class: 'credit', html: 'PSF model: Zhang et al. 2007. smFISH: Femino et al. 1998; Raj et al. 2008.' }),
      ),
    );
  }

  frame(_scale: number): void {
    // Reserved for per-frame panel updates.
  }

  /** Mobile bottom sheet: drag the handle to resize. */
  private bindSheet(root: HTMLElement, handle: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    handle.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = root.getBoundingClientRect().height;
      root.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!root.classList.contains('dragging')) return;
      const h = Math.min(window.innerHeight - 80, Math.max(56, startH + (startY - e.clientY)));
      document.documentElement.style.setProperty('--sheet-h', `${h}px`);
    });
    const end = () => {
      root.classList.remove('dragging');
      window.dispatchEvent(new Event('resize'));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('click', () => {
      const h = root.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--sheet-h', h < 120 ? '42vh' : '56px');
      window.dispatchEvent(new Event('resize'));
    });
  }
}
