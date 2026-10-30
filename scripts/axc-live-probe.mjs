// LIVE probe against the deployed GitHub Pages site: the real CDN libraries,
// the real account server — chip must mount in the home screen.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
await page.goto('https://axcgamestudios.github.io/ra1/', { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('.arena-home__account .axcui-chip').waitFor({ timeout: 45000 });
const chip = await page.locator('.arena-home__account .axcui-chip').textContent();
const net = await page.evaluate(() => ({ db: window.AXC?.state?.db, ws: window.AXC?.state?.ws, presence: window.AXC?.state?.presence }));
console.log('LIVE chip:', JSON.stringify(chip), 'network:', JSON.stringify(net), 'errors:', errors.length ? errors.slice(0, 2) : 'none');
await page.screenshot({ path: 'evidence/axc-account/live-home.png' });
await browser.close();
