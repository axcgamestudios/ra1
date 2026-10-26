// Debug: why doesn't Enter dismiss the title gate on a webdriver=false page?
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = '4211';
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore',
});
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
const page = await context.newPage();
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 }));
});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.locator('#loading[data-state="ready"] .load__press').waitFor({ timeout: 90000 });
console.log('gate ready, webdriver =', await page.evaluate(() => navigator.webdriver));
const before = await page.getAttribute('#loading', 'data-state');
await page.keyboard.press('Enter');
await delay(1500);
const after = await page.evaluate(() => document.querySelector('#loading')?.dataset?.state ?? 'removed');
const homeHidden = await page.evaluate(() => {
  const home = document.querySelector('.arena-home');
  return home ? home.hidden : 'missing';
});
console.log(JSON.stringify({ before, after, homeHidden, errors: errors.slice(0, 4) }, null, 2));
await browser.close();
server.kill();
