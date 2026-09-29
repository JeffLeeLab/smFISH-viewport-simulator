import { expect, test, type Page } from '@playwright/test';

/** Visual smoke tests (spec §12): each stage renders something, with no page errors. */

async function canvasStats(page: Page) {
  return page.evaluate(() => {
    const src = document.getElementById('gl') as HTMLCanvasElement;
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 100;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let sum2 = 0;
    let max = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += v;
      sum2 += v * v;
      max = Math.max(max, v);
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(sum2 / n - mean * mean), max };
  });
}

const STAGES = [
  { hash: 'stage=1', name: 'Molecule' },
  { hash: 'stage=2', name: 'Hybridise' },
  { hash: 'stage=3', name: 'Diffraction' },
  { hash: 'stage=4', name: 'Cell' },
];

for (const s of STAGES) {
  test(`stage ${s.name} renders`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/#${s.hash}`);
    await expect(page.locator('.hud-stage .name')).toHaveText(s.name, { timeout: 15_000 });
    await page.waitForTimeout(s.name === 'Hybridise' ? 7000 : 3000);
    const stats = await canvasStats(page);
    expect(stats.max, 'something bright is drawn').toBeGreaterThan(60);
    expect(stats.std, 'the frame is not a flat colour').toBeGreaterThan(2);
    await page.screenshot({ path: info.outputPath(`${s.name}.png`) });
    expect(errors).toEqual([]);
  });
}

test('changing the URL hash changes the stage', async ({ page }) => {
  await page.goto('/#stage=1');
  await expect(page.locator('.hud-stage .name')).toHaveText('Molecule');
  await page.evaluate(() => (location.hash = '#stage=4'));
  await expect(page.locator('.hud-stage .name')).toHaveText('Cell', { timeout: 10_000 });
});

test('keyboard-only walkthrough of the stages', async ({ page }) => {
  await page.goto('/');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (const [key, name] of [['2', 'Hybridise'], ['3', 'Diffraction'], ['4', 'Cell'], ['1', 'Molecule']] as const) {
    await page.keyboard.press(key);
    await expect(page.locator('.stage-btn[aria-pressed="true"] .t')).toHaveText(name);
    await expect(page.locator('.hud-stage .name')).toHaveText(name, { timeout: 10_000 });
  }
  await page.keyboard.press('?');
  await expect(page.locator('#help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help')).toBeHidden();
});

test('Shift-drag and arrow keys pan instead of orbiting', async ({ page }) => {
  await page.goto('/#stage=3');
  await page.waitForTimeout(2500);
  const view = () => page.evaluate(() => {
    const v = smfish.app.rig.getView();
    return { x: v.target.x, y: v.target.y, z: v.target.z, az: v.azimuth, po: v.polar };
  });
  const a = await view();
  const box = (await page.locator('#gl').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 60, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(600);
  const b = await view();
  expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeGreaterThan(0.05);
  expect(Math.abs(b.az - a.az)).toBeLessThan(1e-3);
  expect(Math.abs(b.po - a.po)).toBeLessThan(1e-3);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  const c = await view();
  expect(Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z)).toBeGreaterThan(0.05);
});

test('double-click zooms from the cell into any RNA, then into its molecule', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/#stage=4');
  await page.waitForTimeout(3500);
  // Screen position of an ordinary (non-featured) cytoplasmic RNA.
  const target = await page.evaluate(() => {
    const app = smfish.app;
    const r = app.records.find((x: { kind: string }) => x.kind === 'cyto');
    const v = new (app.rig.target.constructor)(r.x, r.y, r.z).project(app.cell.camera);
    const rect = document.getElementById('gl')!.getBoundingClientRect();
    return { key: r.key, x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  });
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(2800);
  const fov1 = await page.evaluate(() => Math.pow(10, smfish.app.rig.s));
  expect(fov1).toBeGreaterThan(2000);
  expect(fov1).toBeLessThan(3500);
  await expect(page.locator('.hud-stage .name')).toHaveText('Diffraction');
  // The spot is now at the centre of the view: double-click it again.
  const box = (await page.locator('#gl').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ fov: Math.pow(10, smfish.app.rig.s), live: [...smfish.app.mol.liveKeys()] }));
  expect(after.fov).toBeLessThan(600);
  expect(after.live).toContain(target.key);
  await expect(page.locator('.hud-stage .name')).toHaveText('Molecule');
  expect(errors).toEqual([]);
});
