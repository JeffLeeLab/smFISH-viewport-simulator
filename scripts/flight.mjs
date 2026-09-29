// Dev helper: capture frames during a stage flight.
import { chromium } from '@playwright/test';
const [outDir, hash, js, ...times] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:5173/#' + hash);
await page.waitForTimeout(2500);
await page.evaluate(js);
const t0 = Date.now();
for (const t of times.map(Number)) {
  const wait = t - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({ path: `${outDir}/flight-${t}.png` });
  const s = await page.evaluate(() => smfish.app.rig.s.toFixed(2));
  console.log(t, 's=', s);
}
await browser.close();
