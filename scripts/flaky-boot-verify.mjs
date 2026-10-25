// With retries in place, a 20%-failure flaky link must still boot the game.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = '4202';
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 60000) {
  const start = performance.now();
  while (!(await fn())) { if (performance.now() - start > timeout) throw new Error('timed out'); await delay(150); }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });
const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 }));
});
// Kill ~18% of binary requests; retries must recover every one of them.
await context.route('**/*', async route => {
  const url = route.request().url();
  if (/\.(glb|gltf|wasm|webp|bin|json)(\?|$)/i.test(url) && Math.random() < 0.18) {
    await route.abort('connectionreset'); return;
  }
  await route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor({ timeout: 120000 });
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 120000 });
await delay(2500);
const probe = await page.evaluate(() => {
  const N = window.rocketArenaPresentation.world();
  const car = N.cars[0];
  let meshes = 0, vis = 0;
  car.traverse(o => { if (o.isMesh) { meshes++; if (o.visible) vis++; } });
  return { carVisible: car.visible, meshes, vis, visual: N.carVisuals[0] };
});
console.log('FLAKY BOOT PROBE:', JSON.stringify(probe));
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await page.screenshot({ path: 'evidence/invisible-car/flaky-boot-recovered.png' });
const ok = probe.carVisible && probe.vis > 0 && errors.length === 0;
await browser.close(); server.kill();
console.log(ok ? 'PASS: flaky network recovered via retries' : 'FAIL');
process.exit(ok ? 0 : 1);
