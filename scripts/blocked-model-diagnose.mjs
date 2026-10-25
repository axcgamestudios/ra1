// What does the player experience when the car model request FAILS?
// Simulates a flaky mobile connection: block the sketchfab GLB mid-boot and
// during a garage swap. Expected player-visible outcome per the bug report:
// "the car model doesn't load, it turns invisible".
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/invisible-car';
await mkdir(out, { recursive: true });
const PORT = '4201';
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
    qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 250)));

// Block ONLY the car model GLBs (fennec-v2 first; then every sketchfab asset).
await page.route('**/assets/sketchfab/**', route => route.abort('failed'));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await delay(20000);
const state = await page.evaluate(() => ({
  loadState: document.querySelector('#loading')?.dataset?.state ?? document.querySelector('[data-load]')?.dataset?.state ?? 'unknown',
  loadingHidden: document.querySelector('.load')?.hidden ?? document.querySelector('#loading')?.hidden ?? null,
  homeVisible: !document.querySelector('.arena-home')?.hidden,
  label: document.querySelector('.load__label')?.textContent ?? null,
  note: document.querySelector('.load__note')?.textContent ?? null,
})).catch(e => ({ evaluateError: String(e) }));
console.log('boot with blocked car GLBs:', JSON.stringify(state));
await page.screenshot({ path: `${out}/blocked-boot.png` });
const body = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => null);
console.log('body text:', JSON.stringify(body?.slice(0, 300)));
console.log('page errors:', errors.slice(0, 4));
await browser.close();
server.kill();
