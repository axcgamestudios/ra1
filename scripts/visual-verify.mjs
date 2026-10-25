// Visual verification: 6 stadiums (sky must change per stadium), clear goal
// mouths, the new boost gauge, garage decals + explosion editors, and a
// custom goal explosion fired in-game.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/stadium-pass';
await mkdir(out, { recursive: true });
const PORT = '4177';
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
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);

// Sky sampling per stadium — the bug was identical skies everywhere.
const skySamples = {};
for (const stadium of ['park', 'mannfield', 'coliseum', 'neon', 'dusk', 'urban']) {
  await page.evaluate(id => window.rocketArenaPresentation.stadium.set(id), stadium);
  await delay(2800);
  await page.screenshot({ path: `${out}/${stadium}.png` });
  skySamples[stadium] = await page.evaluate(() => {
    const canvas = document.querySelector('#app canvas');
    if (!canvas) return null;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return null;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(4);
    gl.readPixels(Math.floor(w * .5), Math.floor(h * .93), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return [pixels[0], pixels[1], pixels[2]];
  });
  console.log(`${stadium}: sky ${JSON.stringify(skySamples[stadium])} accents=${await page.evaluate(() => window.rocketArenaPresentation.stadium.accents())}`);
}
const skies = Object.values(skySamples).filter(Boolean).map(c => c.join(','));
console.log(`distinct sky colors (readPixels): ${new Set(skies).size}`);

// Boost gauge present with the new live SVG dial?
const gauge = await page.evaluate(() => {
  const boost = document.querySelector('.boost.arcade-boost');
  return {
    dial: Boolean(boost?.querySelector('.arcade-boost__dial')),
    fill: Boolean(boost?.querySelector('[data-el="boostFill"]')),
    sparks: boost?.querySelectorAll('.arcade-boost__sparks i').length ?? 0,
    speedMeter: Boolean(document.querySelector('.speed-meter')),
  };
});
console.log('boost gauge:', JSON.stringify(gauge), '— speedMeter must be absent');
await page.screenshot({ path: `${out}/hud.png`, clip: { x: 980, y: 480, width: 300, height: 240 } });

// Custom goal explosion: set an urban-purple nova spec and fire it.
await page.evaluate(() => {
  const store = localStorage.getItem('rocket-arena.goal-explosion.v1');
  localStorage.setItem('rocket-arena.goal-explosion.v1', JSON.stringify({
    blue: { style: 'nova', primary: '#b44cff', secondary: '#ffe27a', intensity: 1.6 },
    orange: { style: 'confetti', primary: '#ff8c3c', secondary: '#ffffff', intensity: 1.3 },
  }));
  return store;
});
await page.evaluate(() => window.rocketArenaPresentation.testGoal(0));
await delay(700);
await page.screenshot({ path: `${out}/explosion-nova.png` });
console.log('fired nova explosion');

// Garage: decals + explosion panels. Path: pause -> main menu -> garage.
await page.keyboard.press('Escape');
await delay(700);
await page.locator('[data-pause="home"]').click();
await page.locator('.arena-home:not([hidden])').waitFor({ timeout: 20000 });
await page.locator('[data-home="garage"]').click();
await page.locator('#car-overlay:not([hidden])').waitFor({ timeout: 20000 });
await delay(1200);
await page.locator('[data-garage-category="decal"]').click();
await delay(400);
await page.locator('[data-decal-choice="stripes"]').click();
await delay(500);
await page.screenshot({ path: `${out}/garage-decals.png` });
const decalState = await page.evaluate(() => ({
  active: document.querySelector('[data-decal-choice].is-active')?.dataset.decalChoice,
  saved: JSON.parse(localStorage.getItem('rocket-arena.garage-paint.v2')).fennec.blue.decal,
}));
console.log('garage decals:', JSON.stringify(decalState));
await page.locator('[data-garage-category="explosion"]').click();
await delay(400);
await page.locator('[data-explosion-choice="fireworks"]').click();
await delay(400);
await page.screenshot({ path: `${out}/garage-explosion.png` });
const explosionState = await page.evaluate(() => ({
  active: document.querySelector('[data-explosion-choice].is-active')?.dataset.explosionChoice,
  saved: JSON.parse(localStorage.getItem('rocket-arena.goal-explosion.v1')),
}));
console.log('garage explosion:', JSON.stringify(explosionState));
await page.locator('[data-car-close]').first().click();
await delay(600);

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.kill();
await delay(300);
console.log('done');
