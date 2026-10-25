// Reproduce the goal-mouth obstruction at HIGH quality (user's "max graphics").
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/goal-bug';
await mkdir(out, { recursive: true });
const PORT = '4176';
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
    qualityPreset: 'high', renderScale: 1, showStadium: true, limitFps: true, maxFps: 30,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
page.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);
// Kickoff framing at high quality.
await page.screenshot({ path: `${out}/high-kickoff.png` });
// Drive toward the far (blue) goal for a mid-game framing closer to the mouth.
await page.keyboard.down('w');
await delay(2200);
await page.keyboard.up('w');
await delay(1500);
await page.screenshot({ path: `${out}/high-midgame.png` });
console.log('saved high-kickoff.png / high-midgame.png');
await browser.close();
server.kill();
await delay(300);
console.log('done');
