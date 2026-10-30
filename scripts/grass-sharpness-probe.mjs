// Close-range grass sharpness probe: lowest legitimate gameplay camera
// (height 40, distance 100, fov 60) frames the turf right behind the car,
// where the 1024px texture must resolve individual blades.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/grass-pass';
await mkdir(out, { recursive: true });
const PORT = '4196';
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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'high', renderScale: 1, showStadium: false, limitFps: true, maxFps: 30,
  }));
  // Lowest, closest camera the game allows: turf fills the lower frame.
  localStorage.setItem('rocket-arena.camera-settings.v1', JSON.stringify({
    fov: 60, distance: 100, height: 40, angleDeg: 0,
    stiffness: 0.45, swivelSpeed: 2.5, transitionSpeed: 1, ballCam: false,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(4000);
await page.screenshot({ path: `${out}/low-camera.png` });

// Camera facts: confirm the low framing actually engaged.
const camFacts = await page.evaluate(() => {
  const camera = window.rocketArenaPresentation.camera();
  return {
    y: Math.round(camera.position.y), fov: Math.round(camera.fov),
    pos: camera.position.toArray().map(v => Math.round(v)),
  };
});
console.log('camera facts:', JSON.stringify(camFacts));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
server.kill();
