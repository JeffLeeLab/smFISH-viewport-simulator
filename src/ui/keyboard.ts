/** Keyboard shortcuts (spec §8). */
import type { Stage, Store } from '../state/store';
import type { App } from '../app';
import { CAMERA } from '../data/optics';

export function bindKeyboard(store: Store, app: App): void {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLButtonElement && e.key.startsWith('Arrow')) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      if ((t as HTMLInputElement).type !== 'range') return;
      if (!/^[1-3hwsgmdprf?[\]]$/i.test(e.key)) return;
    }
    const s = store.state;
    const k = e.key;
    let handled = true;
    switch (k) {
      case '1':
      case '2':
      case '3':
        app.goToStage(Number(k) as Stage);
        break;
      case 'h':
      case 'H':
        store.set({ hyb: 'running' });
        break;
      case 'w':
      case 'W':
        if (s.hyb !== 'none') store.set({ washed: true });
        break;
      case 's':
      case 'S':
        store.toggle('helical');
        break;
      case 'g':
      case 'G':
        store.toggle('chGreen');
        break;
      case 'm':
      case 'M':
        store.toggle('chMagenta');
        break;
      case 'd':
      case 'D':
        store.toggle('chDapi');
        break;
      case 'p':
      case 'P':
        store.toggle('mip');
        break;
      case '[':
      case ']': {
        const step = (CAMERA.zStepNm / 1000) * (k === ']' ? 1 : -1);
        if (s.stage === 3) store.set({ cellFocalZ: Math.max(0, Math.min(6, Math.round((s.cellFocalZ + step) * 10) / 10)) });
        else store.set({ focalZ: Math.max(-1.6, Math.min(1.6, Math.round((s.focalZ + step) * 10) / 10)) });
        break;
      }
      case 'r':
      case 'R':
        app.resetCamera();
        break;
      case 'f':
      case 'F':
        store.toggle('presentation');
        break;
      case '?':
        store.toggle('help');
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = e.shiftKey ? 0.25 : 0.08;
        const fx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
        const fy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        app.rig.pan(fx, fy);
        break;
      }
      case '+':
      case '=':
      case '-':
      case '_':
        app.rig.zoomBy(k === '+' || k === '=' ? 1 / 1.4 : 1.4);
        break;
      case 'Escape':
        if (s.help) store.set({ help: false });
        else if (s.presentation) store.set({ presentation: false });
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });
}
