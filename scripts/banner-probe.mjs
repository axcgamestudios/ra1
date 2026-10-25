import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = '4204';
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 60000) {
  const start = performance.now();
  while (!(await fn())) { if (performance.now() - start > timeout) throw new Error('timed out'); await delay(150); }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });
const browser = await chromium.launch({ executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 })));
const page = await context.newPage();
page.setDefaultTimeout(90000);
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('.arena-play__item[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(1500);
for (const ms of [80, 300, 700]) {
  await page.evaluate(() => window.rocketArenaPresentation.say('epic-save'));
  await delay(ms);
  const probe = await page.evaluate(() => {
    const b = document.querySelector('.announcer-banner');
    const text = b?.querySelector('.announcer-banner__text');
    return { hidden: b?.hidden, cls: b?.className, text: text?.textContent,
      rect: text ? JSON.stringify(text.getBoundingClientRect()) : null,
      opacity: text ? getComputedStyle(text).opacity : null };
  });
  console.log(`t=${ms}ms:`, JSON.stringify(probe));
  await delay(2200 - ms);
}
await browser.close(); server.kill();
