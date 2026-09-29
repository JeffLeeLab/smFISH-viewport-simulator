// Dev helper: frame timing in heavy views (N=48, zoomed into a crowded region).
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
const timing = () => page.evaluate(() => new Promise((res) => {
  const t = []; let last = performance.now();
  const f = () => { const now = performance.now(); t.push(now - last); last = now; if (t.length < 150) requestAnimationFrame(f); else { t.sort((a, b) => a - b); res([t[75].toFixed(1), t[142].toFixed(1)]); } };
  requestAnimationFrame(f);
}));
await page.goto('http://localhost:5173/#stage=3&n=48');
await page.waitForTimeout(3500);
console.log('cell N=48 median/p95 ms', await timing());
await page.evaluate(() => { const a = smfish.app; a.zoomTo(a.records.find((r) => r.key === 'rna-40')); });
await page.waitForTimeout(3000);
console.log('optical crowd N=48', await timing());
await page.evaluate(() => { const a = smfish.app; a.zoomTo(a.records.find((r) => r.key === 'rna-40')); });
await page.waitForTimeout(3000);
console.log('molecule N=48', await timing(), 'live', await page.evaluate(() => smfish.app.mol.liveKeys().size));
console.log('volume build ms', await page.evaluate(() => smfish.app.cell.lastBuildMs.toFixed(0)));
await browser.close();
