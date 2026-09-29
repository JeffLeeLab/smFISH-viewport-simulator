/** Top-left HUD: stage name, 1-2-5 scale bar and stage readouts (spec §3). */
import { niceScaleBar, STAGE_NAMES } from '../core/scale';
import type { Stage } from '../state/store';
import { el } from './controls';

export interface HudData {
  stage: Stage;
  nmPerPx: number;
  readouts: { k: string; v: string; cls?: string }[];
  hint: string;
}

export class Hud {
  private root: HTMLElement;
  private num: HTMLElement;
  private name: HTMLElement;
  private bar: HTMLElement;
  private barLbl: HTMLElement;
  private readouts: HTMLElement;
  private hintEl: HTMLElement;
  private lastReadouts = '';
  private lastHint = '';
  private lastStage = 0;

  constructor(parent: HTMLElement) {
    this.num = el('span', { class: 'num' });
    this.name = el('span', { class: 'name' });
    this.bar = el('div', { class: 'bar' });
    this.barLbl = el('div', { class: 'lbl' });
    this.readouts = el('div', { class: 'hud-readouts', 'aria-live': 'polite' });
    this.hintEl = el('div', { class: 'hud-hint' });
    this.root = el(
      'div',
      { id: 'hud' },
      el('div', { class: 'hud-stage' }, this.num, this.name),
      el('div', { class: 'scalebar', 'aria-hidden': 'true' }, this.bar, this.barLbl),
      this.readouts,
      this.hintEl,
    );
    parent.append(this.root);
  }

  update(d: HudData): void {
    if (d.stage !== this.lastStage) {
      this.lastStage = d.stage;
      this.num.textContent = `${d.stage}`;
      this.name.textContent = STAGE_NAMES[d.stage];
    }
    const sb = niceScaleBar(d.nmPerPx, 150);
    this.bar.style.width = `${sb.px.toFixed(1)}px`;
    if (this.barLbl.textContent !== sb.label) this.barLbl.textContent = sb.label;
    const r = d.readouts.map((x) => `<span class="k">${x.k}</span><span class="${x.cls ?? ''}">${x.v}</span>`).join('');
    if (r !== this.lastReadouts) {
      this.lastReadouts = r;
      this.readouts.innerHTML = r;
    }
    if (d.hint !== this.lastHint) {
      this.lastHint = d.hint;
      this.hintEl.innerHTML = d.hint;
    }
  }
}
