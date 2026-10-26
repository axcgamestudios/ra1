// Probe: goal explosion light beams + electric arcs fire and animate.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = '4212';
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
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 1, showStadium: true, limitFps: true, maxFps: 30 }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor({ timeout: 90000 });
// Enter free play.
await page.locator('[data-home="play"]').click();
await delay(300);
await page.locator('.arena-mode[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(1500);
// Move the ball somewhere visible and fire the goal explosion.
const probe = () => window.rocketArenaPresentation.world().scene.children
  .filter(child => /goal (beam|arc)/.test(child.name))
  .map(child => ({ name: child.name, visible: child.visible, scaleY: Math.round(child.scale.y), opacity: Math.round((child.material.uniforms?.opacity?.value ?? child.material.opacity ?? 0) * 100) / 100 }));
await page.evaluate(() => window.rocketArenaPresentation.testGoal(0));
const at = ms => new Promise(async resolve => { await delay(ms); resolve(await page.evaluate(probe)); });
const [t0, t300, t700, t1400] = await Promise.resolve().then(async () => {
  const a = await at(80), b = await at(300), c = await at(700), d = await at(1400);
  return [a, b, c, d];
});
await page.screenshot({ path: 'evidence/ui-pass/goal-beams-probe.png' });
console.log(JSON.stringify({ t0, t300, t700, t1400, errors: errors.slice(0, 3) }, null, 1));
const beamsVisible = t300.filter(e => /beam/.test(e.name) && e.visible).length;
const arcsVisible = t300.filter(e => /arc/.test(e.name) && e.visible).length;
const beamsGone = t1400.filter(e => /beam/.test(e.name) && e.visible).length === 0;
// Under the ~2fps SwiftShader sandbox the 1.25s animation is stretched over
// many real seconds, so assert progression (grow + fade), not completion.
const beamAt = (sample, name) => sample.find(e => e.name === name);
const fading = ['Arena / goal beam 0', 'Arena / goal beam 1', 'Arena / goal beam 2']
  .every(name => { const early = beamAt(t300, name), late = beamAt(t1400, name); return !late.visible || late.opacity < early.opacity; });
const growing = ['Arena / goal beam 0', 'Arena / goal beam 1', 'Arena / goal beam 2']
  .every(name => { const early = beamAt(t300, name), late = beamAt(t1400, name); return !late.visible || late.scaleY > early.scaleY; });
const ok = beamsVisible === 3 && arcsVisible >= 3 && (beamsGone || (fading && growing)) && errors.length === 0;
console.log('check:', JSON.stringify({ beamsVisible, arcsVisible, beamsGone, fading, growing, errors: errors.length }));
console.log(ok ? 'PASS: goal beams' : 'FAIL: goal beams');
await browser.close();
server.kill();
process.exit(ok ? 0 : 1);
