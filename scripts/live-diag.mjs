import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const out = 'evidence/invisible-car';
await mkdir(out, { recursive: true });
const URL = 'https://axcgamestudios.github.io/ra1/?physicsDebug=1';
const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [], failed = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
page.on('requestfailed', r => failed.push(r.url().slice(-80) + ' :: ' + r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) failed.push(r.url().slice(-80) + ' :: HTTP ' + r.status()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
const probe = await page.evaluate(() => {
  const N = window.rocketArenaPresentation.world();
  const car = N.cars[0];
  car.updateMatrixWorld(true);
  let meshes = 0, visibleMeshes = 0;
  car.traverse(o => { if (o.isMesh) { meshes++; if (o.visible) visibleMeshes++; } });
  return { carVisible: car.visible, visual: N.carVisuals[0], meshes, visibleMeshes, inScene: car.parent === N.scene };
});
console.log('LIVE boot probe:', JSON.stringify(probe));
await page.screenshot({ path: `${out}/live-boot.png` });
console.log('failed requests:', failed.length ? failed : 'none');
console.log('page errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
