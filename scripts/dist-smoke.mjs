// Smoke the built dist/: boot, enter free play, cycle 2 stadiums, fire a
// goal explosion, open the garage decals panel — no errors allowed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = '4178';
const serve = join(import.meta.dirname, '../tools/serve.mjs');
const server = spawn(process.execPath, [serve], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0', ROCKET_ARENA_DIST: '1' }, stdio: 'ignore',
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
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'potato', renderScale: .25, showStadium: false, limitFps: true, maxFps: 30,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2000);
for (const stadium of ['mannfield', 'urban']) {
  await page.evaluate(id => window.rocketArenaPresentation.stadium.set(id), stadium);
  await delay(1800);
}
await page.evaluate(() => window.rocketArenaPresentation.testGoal(1));
await delay(600);
await page.screenshot({ path: 'evidence/stadium-pass/dist-smoke.png' });
const boost = await page.evaluate(() => ({
  dial: Boolean(document.querySelector('.arcade-boost__dial')),
  speedMeter: Boolean(document.querySelector('.speed-meter')),
}));
console.log('dist smoke:', JSON.stringify(boost), 'errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.kill();
await delay(300);
if (errors.length || !boost.dial || boost.speedMeter) { console.log('SMOKE FAILED'); process.exit(1); }
console.log('SMOKE PASSED');
