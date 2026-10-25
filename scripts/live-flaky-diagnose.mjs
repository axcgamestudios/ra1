// LIVE site under a slow flaky connection (like the player's mobile network):
// cold cache, 400kbps, some requests killed. Watch which model loads fail and
// what the player actually sees (error screen vs invisible car vs garage hero).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/invisible-car';
await mkdir(out, { recursive: true });
const URL = 'https://axcgamestudios.github.io/ra1/?physicsDebug=1';
const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.route('**/*', async route => {
  // Flaky: kill ~1 in 5 requests for large binaries.
  const url = route.request().url();
  if (/\.(glb|gltf|wasm|webp|bin)$/i.test(url) && Math.random() < 0.2) {
    await route.abort('connectionreset');
    return;
  }
  await route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(120000);
const errors = [], failed = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
page.on('requestfailed', r => failed.push(r.url().split('/').slice(-2).join('/') + ' :: ' + (r.failure()?.errorText ?? '')));
page.on('response', r => { if (r.status() >= 400) failed.push(r.url().split('/').slice(-2).join('/') + ' :: HTTP ' + r.status()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 60000));
const state = await page.evaluate(() => ({
  loadState: document.querySelector('[data-load]')?.dataset.state ?? document.querySelector('#loading')?.dataset.state ?? 'unknown',
  homeVisible: !document.querySelector('.arena-home')?.hidden,
  label: document.querySelector('.load__label')?.textContent ?? null,
  note: document.querySelector('.load__note')?.textContent ?? null,
})).catch(e => ({ err: String(e).slice(0, 150) }));
console.log('flaky-network boot:', JSON.stringify(state));
await page.screenshot({ path: `${out}/live-flaky.png` });
console.log('failed requests (' + failed.length + '):', failed.slice(0, 12));
console.log('page errors:', errors.slice(0, 6));
await browser.close();
