/** Hover/tap tooltip for probes and mRNA regions (spec §4.2). */
import type { Probe } from '../data/probes';
import { PROBE_SETS } from '../data/probes';
import { DYES } from '../data/dyes';
import { el } from './controls';

export class Tooltip {
  private root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = el('div', { id: 'tooltip', hidden: '', role: 'tooltip' });
    parent.append(this.root);
  }

  private place(x: number, y: number): void {
    const parent = this.root.parentElement!.getBoundingClientRect();
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const px = Math.min(x, parent.width - w - 24);
    const py = Math.min(y, parent.height - h - 24);
    this.root.style.left = `${Math.max(0, px)}px`;
    this.root.style.top = `${Math.max(0, py)}px`;
  }

  showText(title: string, html: string, x: number, y: number): void {
    this.root.innerHTML = `<div class="t">${title}</div><div>${html}</div>`;
    this.root.hidden = false;
    this.place(x, y);
  }

  showProbe(p: Probe, bound: boolean, x: number, y: number): void {
    const dye = DYES[p.dye];
    const set = PROBE_SETS[p.set];
    const colour = p.set === 'cds' ? 'm' : 'g';
    this.root.innerHTML = `
      <div class="t"><span class="sw ${colour}">●</span> ${set.name} · probe ${p.rank + 1} ${bound ? '(bound)' : '(unbound)'}</div>
      <div class="seq">5′-${p.seq}-3′ ● dye</div>
      <div class="kv">
        <span>target</span><span>nt ${p.targetStart + 1}–${p.targetEnd}</span>
        <span>GC</span><span>${Math.round(p.gc * 100)}%</span>
        <span>Tm</span><span>≈ ${p.tm.toFixed(0)} °C (approx.)</span>
        <span>dye</span><span>${dye.name} (3′ end)</span>
        <span>ex / em</span><span>${dye.exNm} / ${dye.emNm} nm</span>
      </div>`;
    this.root.hidden = false;
    this.place(x, y);
  }

  hide(): void {
    this.root.hidden = true;
  }
}
