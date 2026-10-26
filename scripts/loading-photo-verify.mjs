// Screenshot loading screen in both mid-load and ready states, desktop + mobile.
// The "PRESS ANY BUTTON" gate only holds when navigator.webdriver is faked off.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = '4213';
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
const errors = [];
for (const [label, viewport] of [['desktop', { width: 1280, height: 720 }], ['mobile', { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('pageerror', e => errors.push(`${label}: ${String(e).slice(0, 200)}`));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading').waitFor();
  await delay(1600);
  await page.screenshot({ path: `evidence/ui-pass/loading-photo-${label}-mid.png` });
  await page.locator('#loading[data-state="ready"] .load__press').waitFor({ timeout: 90000 });
  await delay(900);
  await page.screenshot({ path: `evidence/ui-pass/loading-photo-${label}-ready.png` });
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator('#loading').count()) === 0);
  await context.close();
  console.log(`${label}: captured mid + ready + dismissed`);
}
await browser.close();
server.kill();
console.log('page errors:', errors.length ? errors : 'none');
