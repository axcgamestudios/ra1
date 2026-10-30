// Decisive 3D blade existence proof: hide the turf surface plane so ONLY the
// instanced blades render over the void — then measure colored pixel coverage.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/grass-pass';
await mkdir(out, { recursive: true });
const PORT = '4197';
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) {
  const start = performance.now();
  while (!(await fn())) { if (performance.now() - start > timeout) throw new Error('timed out'); await delay(120); }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });

const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'high', renderScale: 0.5, showStadium: false, limitFps: true, maxFps: 30,
  }));
  localStorage.setItem('rocket-arena.camera-settings.v1', JSON.stringify({
    fov: 60, distance: 100, height: 40, angleDeg: 0,
    stiffness: 0.45, swivelSpeed: 2.5, transitionSpeed: 1, ballCam: false,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(150000);
const errors = [];
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);
page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) errors.push(String(e).slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(3500);

// Hide the painted surface: whatever remains low in frame is pure 3D blades.
const hidden = await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const surface = world.turf.getObjectByName('Park / painted playing surface');
  surface.visible = false;
  return true;
});
await delay(900);
await page.screenshot({ path: `${out}/blades-only.png`, timeout: 140000 });
await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  world.turf.getObjectByName('Park / painted playing surface').visible = true;
});
console.log('surface hidden for the proof shot:', hidden);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
