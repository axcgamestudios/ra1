// Potato preset: 3D blades must never be built.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = '4198';
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) { const s = performance.now(); while (!(await fn())) { if (performance.now() - s > timeout) throw new Error('timeout'); await delay(120); } }
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });
const browser = await chromium.launch({ executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'potato', renderScale: 0.6, showStadium: false, limitFps: true, maxFps: 30 }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
// Known SwiftShader limitation (see grass-verify.mjs): the Fennec chassis
// shadow material uses a dynamically indexed sampler array. Unrelated here.
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);
page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) errors.push(String(e).slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);
const facts = await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  return {
    bladesPresent: Boolean(world.turf.getObjectByName('Park / fine 3D grass blades')),
    detailImage: (() => { const s = world.turf.getObjectByName('Park / painted playing surface'); const d = s.material.userData.parkGround.detail.value; return d?.image ? `${d.image.width}x${d.image.height}` : null; })(),
  };
});
console.log('POTATO facts:', JSON.stringify(facts));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.kill();
const fail = facts.bladesPresent || errors.length;
console.log(fail ? 'POTATO FAIL' : 'POTATO PASS');
process.exit(fail ? 1 : 0);
