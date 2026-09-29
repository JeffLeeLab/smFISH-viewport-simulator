/** Tiny DOM helpers for store-bound controls. */
import type { AppState, Store } from '../state/store';

type Updater = (s: AppState) => void;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export class Controls {
  private updaters: Updater[] = [];
  constructor(private store: Store) {
    store.subscribe((s) => this.refresh(s));
  }

  refresh(s: AppState = this.store.state): void {
    for (const u of this.updaters) u(s);
  }

  onRefresh(fn: Updater): void {
    this.updaters.push(fn);
    fn(this.store.state);
  }

  toggle(opts: {
    label: string;
    get: (s: AppState) => boolean;
    set: (v: boolean) => void;
    kbd?: string;
    disabled?: (s: AppState) => boolean;
  }): HTMLElement {
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    const label = el('label', { class: 'label', for: id }, opts.label);
    if (opts.kbd) label.append(' ', el('kbd', {}, opts.kbd));
    const sw = el('button', { class: 'switch', role: 'switch', id, 'aria-checked': 'false', type: 'button' });
    sw.addEventListener('click', () => opts.set(sw.getAttribute('aria-checked') !== 'true'));
    const row = el('div', { class: 'row' }, label, sw);
    this.onRefresh((s) => {
      sw.setAttribute('aria-checked', String(opts.get(s)));
      if (opts.disabled) {
        const d = opts.disabled(s);
        (sw as HTMLButtonElement).disabled = d;
        row.style.opacity = d ? '0.4' : '';
      }
    });
    return row;
  }

  segmented<T extends string>(opts: {
    label: string;
    options: { value: T; label: string }[];
    get: (s: AppState) => T;
    set: (v: T) => void;
    kbd?: string;
  }): HTMLElement {
    const group = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': opts.label });
    const buttons = opts.options.map((o) => {
      const b = el('button', { role: 'radio', type: 'button', 'aria-checked': 'false' }, o.label);
      b.addEventListener('click', () => opts.set(o.value));
      group.append(b);
      return b;
    });
    const label = el('span', { class: 'label' }, opts.label);
    if (opts.kbd) label.append(' ', el('kbd', {}, opts.kbd));
    this.onRefresh((s) => {
      const v = opts.get(s);
      buttons.forEach((b, i) => b.setAttribute('aria-checked', String(opts.options[i].value === v)));
    });
    return el('div', { class: 'row' }, label, group);
  }

  slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    get: (s: AppState) => number;
    set: (v: number) => void;
    format: (v: number) => string;
    range?: (s: AppState) => [number, number];
  }): HTMLElement {
    const id = 'c' + Math.random().toString(36).slice(2, 8);
    const input = el('input', {
      type: 'range',
      id,
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
    });
    const value = el('span', { class: 'value' });
    input.addEventListener('input', () => opts.set(Number(input.value)));
    this.onRefresh((s) => {
      if (opts.range) {
        const [a, b] = opts.range(s);
        input.min = String(a);
        input.max = String(b);
      }
      const v = opts.get(s);
      if (Number(input.value) !== v) input.value = String(v);
      value.textContent = opts.format(v);
      input.setAttribute('aria-valuetext', opts.format(v));
    });
    return el('div', { class: 'slider' }, el('label', { class: 'label', for: id }, opts.label), value, input);
  }

  button(label: string, onClick: () => void, opts: { kbd?: string; primary?: boolean; title?: string } = {}): HTMLButtonElement {
    const b = el('button', { class: 'btn' + (opts.primary ? ' primary' : ''), type: 'button' }, label);
    if (opts.title) b.title = opts.title;
    if (opts.kbd) b.append(el('kbd', {}, opts.kbd));
    b.addEventListener('click', onClick);
    return b;
  }

  section(title: string, ...children: (Node | string)[]): HTMLElement {
    return el('section', { class: 'section' }, el('h3', {}, title), ...children);
  }

  info(content: string): { button: HTMLButtonElement; pop: HTMLElement } {
    const button = el('button', { class: 'info', type: 'button', 'aria-expanded': 'false', 'aria-label': 'More information' }, 'i');
    const pop = el('div', { class: 'popover', hidden: '', html: content });
    button.addEventListener('click', () => {
      const open = pop.hidden;
      pop.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    });
    return { button, pop };
  }
}
