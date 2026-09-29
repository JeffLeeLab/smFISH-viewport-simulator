// Dev helper: zoom from the cell into an arbitrary RNA (spot, then molecule).
import { chromium } from '@playwright/test';
const out = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('console', m.text()));
await page.goto('http://localhost:5173/#stage=4');
await page.waitForTimeout(3500);
const key = process.argv[3] ?? 'rna-40';
await page.evaluate((k) => { const a = smfish.app; a.zoomTo(a.records.find((r) => r.key === k)); }, key);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/zoom-spot.png` });
await page.evaluate((k) => { const a = smfish.app; a.zoomTo(a.records.find((r) => r.key === k)); }, key);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/zoom-mol.png` });
console.log(await page.evaluate(() => [...smfish.app.mol.liveKeys()].join(',')));
await browser.close();
