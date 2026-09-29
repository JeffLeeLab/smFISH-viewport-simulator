/** Help overlay (`?`): controls and shortcuts (spec §8). */
import type { Store } from '../state/store';
import { el } from './controls';

const ROWS: [string, string][] = [
  ['Scroll / pinch', 'Zoom. One continuous scale from bases (~20 nm) to the whole cell (~30 µm).'],
  ['Drag', 'Orbit.'],
  ['Shift / Ctrl / ⌘ + drag', 'Pan up, down, left or right (also right-drag or two-finger drag).'],
  ['Arrow keys', 'Pan (hold Shift for bigger steps). + / − zoom.'],
  ['Double-click', 'Zoom into the RNA under the cursor: cell → its spot → the molecule.'],
  ['1 – 4', 'Go to stage: Molecule, Hybridise, Diffraction, Cell'],
  ['H', 'Replay hybridisation'],
  ['W', 'Wash away unbound probes'],
  ['S', 'Schematic ladder ↔ helical duplex'],
  ['G / M / D', 'Toggle green / magenta / DAPI channel'],
  ['P', '3D ↔ maximum-intensity projection (stage 4)'],
  ['[ / ]', 'Move the focal plane down / up (200 nm steps)'],
  ['R', 'Reset the camera for this stage'],
  ['F', 'Presentation mode'],
  ['?', 'Show / hide this help'],
];

export class Help {
  private root: HTMLElement;
  constructor(store: Store) {
    const table = el('table');
    for (const [k, v] of ROWS) {
      const keys = k
        .split(' ')
        .map((p) => (p.length <= 2 && p !== '–' && p !== '/' && p !== '+' ? `<kbd>${p}</kbd>` : p))
        .join(' ');
      table.append(el('tr', {}, el('td', { html: keys }), el('td', {}, v)));
    }
    const close = el('button', { class: 'btn', type: 'button' }, 'Close');
    close.addEventListener('click', () => store.set({ help: false }));
    const card = el(
      'div',
      { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' },
      el('h2', { id: 'help-title' }, 'Controls'),
      table,
      el('p', {}, 'Tip: the URL updates as you explore, so you can copy it to share a particular view.'),
      close,
    );
    this.root = el('div', { id: 'help', hidden: '' }, card);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) store.set({ help: false });
    });
    document.body.append(this.root);
    store.watch(['help'], (s) => {
      this.root.hidden = !s.help;
      if (s.help) close.focus();
    });
  }
}
