import './ui/styles.css';
import { Store, bindHash, initialState } from './state/store';
import { buildWorld } from './data/model';
import { App } from './app';
import { hasWebGL2 } from './core/renderer';

function boot(): void {
  if (!hasWebGL2()) {
    document.body.innerHTML =
      '<div id="fallback"><div><h1>WebGL2 is needed</h1><p>This visualisation needs a browser with WebGL2 (any recent Chrome, Edge, Firefox or Safari).</p></div></div>';
    return;
  }
  const store = new Store(initialState(location.hash));
  bindHash(store);
  const world = buildWorld();
  const app = new App(store, world);
  app.start();
  // Handy for debugging and for the visual smoke tests.
  (window as unknown as { smfish: unknown }).smfish = { app, store, world };
}

boot();
