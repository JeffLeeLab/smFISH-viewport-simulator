// Dev helper: capture screenshots of the running app with headless Chrome.
// Usage: node scripts/shot.mjs <outDir> <name>=<hash>[@<waitMs>][!<js>] ...
import { chromium } from '@playwright/test';

const [outDir, ...specs] = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900) },
  deviceScaleFactor: Number(process.env.DPR ?? 1),
});
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
for (const spec of specs) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  const bang = rest.indexOf('!');
  const hashAndWait = bang >= 0 ? rest.slice(0, bang) : rest;
  const js = bang >= 0 ? rest.slice(bang + 1) : '';
  const [hash, wait] = hashAndWait.split('@');
  await page.goto(base + '#' + hash, { waitUntil: 'load' });
  await page.waitForTimeout(Number(wait ?? 2500));
  if (js) {
    await page.evaluate(js);
    await page.waitForTimeout(Number(process.env.AFTER ?? 1500));
  }
  await page.screenshot({ path: `${outDir}/${name}.png` });
  if (process.env.SAMPLE) {
    const pts = process.env.SAMPLE.split(';').map((p) => p.split(',').map(Number));
    const px = await page.evaluate((pts) => {
      const src = document.getElementById('gl');
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext('2d');
      g.drawImage(src, 0, 0);
      return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
    }, pts);
    console.log('samples', JSON.stringify(px));
  }
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
  console.log(name, 'fps~', fps);
}
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 40).join('\n'));
await browser.close();
