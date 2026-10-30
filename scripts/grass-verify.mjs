// Grass pass verification: user-supplied pasto texture applied at full
// resolution (no stretch), fine 3D blades on High/Balanced, none on Potato.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/grass-pass';
await mkdir(out, { recursive: true });
const PORT = '4193';
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
const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'high', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(150000);
const errors = [];
// Known pre-existing SwiftShader limitation (reproduced on the parent
// commit): the Fennec chassis shadow material compiles GLSL with a
// dynamically indexed sampler array, which SwiftShader's translator rejects.
// Unrelated to the grass pass — filtered so only real regressions fail.
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);
page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) errors.push(String(e).slice(0, 300)); });
page.on('console', m => { if (m.type() === 'error' && !isKnownSwiftShaderCarError(m.text())) errors.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(6000);

// 1) Scene facts: blade mesh, blade count, texture resolution, gain match.
const facts = await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const blades = world.turf.getObjectByName('Park / fine 3D grass blades');
  const surface = world.turf.getObjectByName('Park / painted playing surface');
  const ground = surface.material.userData.parkGround;
  const detail = ground.detail.value;
  return {
    bladesPresent: Boolean(blades),
    bladeCount: blades?.userData.bladeCount ?? 0,
    spacing: blades?.userData.grassSpacing ?? null,
    visible: blades?.visible ?? null,
    detailImage: detail?.image ? `${detail.image.width}x${detail.image.height}` : null,
    grassGain: Number(ground.grassGain.value.toFixed(4)),
    anisotropy: detail?.anisotropy ?? null,
    canvas: `${surface.material.map.image.width}x${surface.material.map.image.height}`,
  };
});
console.log('HIGH preset facts:', JSON.stringify(facts, null, 2));

// 2) Grazing close-up across the turf: where stretching/blur would show.
const shoot = async (name, setup) => {
  await page.evaluate(setup);
  await delay(1800);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 140000 });
};
await shoot('grass-closeup-grazing', () => {
  const camera = window.rocketArenaPresentation.camera();
  camera.position.set(-600, 26, 900);
  camera.lookAt(200, 0, -1500);
});
// 3) Pitch overview from above: checker + team paint + uniform tiling.
await shoot('pitch-overhead', () => {
  const camera = window.rocketArenaPresentation.camera();
  camera.position.set(0, 3600, 2600);
  camera.lookAt(0, 0, 0);
});
// The behind-car gameplay framing is captured by the Balanced boot below
// (its default camera tracks the car) — no need to pay for it twice here.

// 5) Wind uniform advances on render (the clock hook is installed).
const windHook = await page.evaluate(() => {
  const blades = window.rocketArenaPresentation.world().turf.getObjectByName('Park / fine 3D grass blades');
  return typeof blades?.onBeforeRender === 'function';
});
console.log('wind clock hook present:', windHook);

// Free the single SwiftShader GPU process for the next boot.
await context.close();

// 6) Balanced preset in a fresh boot: the default lawn is a dense carpet too.
const balancedContext = await browser.newContext({ viewport: { width: 800, height: 450 } });
await balancedContext.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'balanced', renderScale: 0.5, showStadium: false, limitFps: true, maxFps: 30,
  }));
});
const balancedPage = await balancedContext.newPage();
balancedPage.setDefaultTimeout(150000);
const balancedErrors = [];
balancedPage.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) balancedErrors.push(String(e).slice(0, 300)); });
balancedPage.on('console', m => { if (m.type() === 'error' && !isKnownSwiftShaderCarError(m.text())) balancedErrors.push(m.text().slice(0, 300)); });
await balancedPage.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await balancedPage.locator('.arena-home:not([hidden])').waitFor();
await balancedPage.locator('[data-home="play"]').click();
await balancedPage.locator('[data-home="freeplay"]').click();
await balancedPage.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(5000);
const balancedFacts = await balancedPage.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const blades = world.turf.getObjectByName('Park / fine 3D grass blades');
  return {
    bladesPresent: Boolean(blades),
    bladeCount: blades?.userData.bladeCount ?? 0,
    spacing: blades?.userData.grassSpacing ?? null,
  };
});
console.log('BALANCED preset facts:', JSON.stringify(balancedFacts));
await balancedPage.screenshot({ path: `${out}/balanced-carpet.png`, timeout: 140000 });
await balancedContext.close();

// 7) Potato preset in a fresh boot: blades are never built at all.
const potatoContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await potatoContext.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'potato', renderScale: 0.6, showStadium: false, limitFps: true, maxFps: 30,
  }));
});
const potatoPage = await potatoContext.newPage();
potatoPage.setDefaultTimeout(90000);
const potatoErrors = [];
potatoPage.on('pageerror', e => potatoErrors.push(String(e).slice(0, 300)));
await potatoPage.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await potatoPage.locator('.arena-home:not([hidden])').waitFor();
await potatoPage.locator('[data-home="play"]').click();
await potatoPage.locator('[data-home="freeplay"]').click();
await potatoPage.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);
const potatoFacts = await potatoPage.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const blades = world.turf.getObjectByName('Park / fine 3D grass blades');
  return { bladesPresent: Boolean(blades) };
});
console.log('POTATO preset facts:', JSON.stringify(potatoFacts));
await potatoPage.screenshot({ path: `${out}/potato.png`, timeout: 140000 });
await potatoContext.close();

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');

await browser.close();
server.kill();
const failure = [];
if (!facts.bladesPresent) failure.push('missing blade mesh on High');
if (facts.bladeCount < 2000000) failure.push(`blade count too low: ${facts.bladeCount}`);
if (facts.spacing !== 6) failure.push(`High spacing wrong: ${facts.spacing}`);
if (facts.detailImage !== '1024x1024') failure.push(`detail texture wrong: ${facts.detailImage}`);
if (facts.grassGain < 0.7 || facts.grassGain > 1.6) failure.push(`grassGain out of range: ${facts.grassGain}`);
if (facts.canvas !== '2048x2560') failure.push(`turf canvas wrong: ${facts.canvas}`);
if (errors.length) failure.push(`page errors: ${errors[0]}`);
if (balancedErrors.length) failure.push(`balanced page errors: ${balancedErrors[0]}`);
if (!balancedFacts.bladesPresent || balancedFacts.bladeCount < 1200000 || balancedFacts.spacing !== 8)
  failure.push(`balanced carpet wrong: ${JSON.stringify(balancedFacts)}`);
if (potatoErrors.length) failure.push(`potato page errors: ${potatoErrors[0]}`);
if (potatoFacts.bladesPresent) failure.push('potato built blades');
console.log(failure.length ? `FAIL: ${failure.join('; ')}` : 'GRASS PASS');
process.exit(failure.length ? 1 : 0);
