// Dev helper: hover a probe, scroll the panel, and time frames at N=48.
import { chromium } from '@playwright/test';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:5173/#stage=1');
await page.waitForTimeout(1500);
await page.evaluate(() => smfish.store.set({ hyb: 'running' }));
await page.waitForTimeout(8000);
const pt = await page.evaluate(() => {
  const app = smfish.app;
  const d = app.mol.boundDyes().find((x) => x.molecule === 'featured-long' && x.set === 'cds');
  const v = d.pos.clone().project(app.mol.camera);
  const r = document.getElementById('gl').getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
});
await page.mouse.move(pt.x - 3, pt.y - 3);
await page.mouse.move(pt.x, pt.y);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/hover.png` });
// Stage 2 panel: scroll to the inset/profile.
await page.goto('http://localhost:5173/#stage=2&n=10');
await page.reload();
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector('.profile').scrollIntoView({ block: 'end' }));
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/panel2.png` });
// Frame timing at N=48 while hybridising.
await page.goto('http://localhost:5173/#stage=1&n=48');
await page.reload();
await page.waitForTimeout(1500);
await page.evaluate(() => smfish.store.set({ hyb: 'running' }));
const ms = await page.evaluate(() => new Promise((res) => {
  const t = []; let last = performance.now();
  const f = () => { const now = performance.now(); t.push(now - last); last = now; if (t.length < 180) requestAnimationFrame(f); else res(t); };
  requestAnimationFrame(f);
}));
ms.sort((a, b) => a - b);
console.log('N=48 frame ms: median', ms[90].toFixed(1), 'p95', ms[171].toFixed(1));
await browser.close();
