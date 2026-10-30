// Flat photo-turf pass verification (3D blades removed per user request):
// the pasto photo is the base color at full resolution, the frame renders at
// NATIVE resolution by default (the "pixeleado" fix), anisotropy is maxed and
// no blade mesh exists on any preset.
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
// Known pre-existing SwiftShader limitation (reproduced on the parent
// commit): the Fennec chassis shadow material compiles GLSL with a
// dynamically indexed sampler array, which SwiftShader's translator rejects.
// Unrelated to the turf pass — filtered so only real regressions fail.
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);

const boot = async ({ stored, viewport = { width: 1024, height: 576 }, deviceScaleFactor = 1 }) => {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  if (stored) await context.addInitScript(value => {
    if (value !== null) localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify(value));
  }, stored);
  const page = await context.newPage();
  page.setDefaultTimeout(150000);
  const errors = [];
  page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) errors.push(String(e).slice(0, 300)); });
  page.on('console', m => { if (m.type() === 'error' && !isKnownSwiftShaderCarError(m.text())) errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="freeplay"]').click();
  await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
  await delay(6000);
  return { context, page, errors };
};

const factsOf = page => page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const blades = world.turf.getObjectByName('Park / fine 3D grass blades');
  const surface = world.turf.getObjectByName('Park / painted playing surface');
  const ground = surface.material.userData.parkGround;
  const detail = ground.detail.value;
  const canvas = surface.material.map.image;
  return {
    bladesPresent: Boolean(blades),
    bladeMeshes: world.scene.children.length && world.turf.children.filter(c => /blade/i.test(c.name)).length,
    detailImage: detail?.image ? `${detail.image.width}x${detail.image.height}` : null,
    detailAnisotropy: detail?.anisotropy ?? null,
    canvasAnisotropy: surface.material.map.anisotropy ?? null,
    canvas: `${canvas.width}x${canvas.height}`,
    grassGain: Number(ground.grassGain.value.toFixed(4)),
    renderBuffer: (() => { const c = document.querySelector('#app > canvas'); return c ? `${c.width}x${c.height}` : null; })(),
    contextAntialias: (() => { const c = document.querySelector('#app > canvas'); const gl = c?.getContext('webgl2'); return gl ? Boolean(gl.getContextAttributes().antialias) : null; })(),
  };
});

// 1) Fresh install (no stored graphics): native-resolution default + turf facts.
{
  const { context, page, errors } = await boot({ stored: null });
  const facts = await factsOf(page);
  console.log('FRESH DEFAULT facts:', JSON.stringify(facts, null, 2));
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  const expectedBuffer = `${Math.round(1024 * dpr)}x${Math.round(576 * dpr)}`;
  // Freeze the camera pose via updateMatrixWorld so the gameplay controller
  // cannot drift the framing between setup and screenshot.
  const freeze = framing => {
    const camera = window.rocketArenaPresentation.camera();
    camera.position.set(...framing.position);
    camera.lookAt(...framing.target);
    const pos = camera.position.toArray(), quat = camera.quaternion.toArray();
    camera.updateMatrixWorld = function() {
      this.position.fromArray(pos);
      this.quaternion.fromArray(quat);
      this.matrixWorld.compose(this.position, this.quaternion, this.scale);
      this.matrixWorldInverse.copy(this.matrixWorld).invert();
    };
  };
  const shoot = async (name, framing) => {
    if (framing) await page.evaluate(freeze, framing);
    await delay(1200);
    await page.screenshot({ path: `${out}/${name}.png`, timeout: 140000 });
  };
  // Grazing close-up across the pitch: where tiling/stretch would show.
  await shoot('native-closeup', { position: [-600, 26, 900], target: [200, 0, -1500] });
  // Overhead of the marked pitch: checker gone, markings and paint intact.
  await shoot('native-overhead', { position: [0, 3600, 2600], target: [0, 0, 0] });
  // The player's actual chase-camera framing, untouched.
  await shoot('native-gameplay', null);
  globalThis.freshFacts = { facts, errors, expectedBuffer };
  await context.close();
}

// 2) Legacy default upgrade: stored 0.85 (the old factory default) must render
//    at full resolution now; a hand-picked 0.5 must survive.
{
  const { context, page } = await boot({ stored: { qualityPreset: 'balanced', renderScale: 0.85, showStadium: false, limitFps: true, maxFps: 60 } });
  const upgraded = await page.evaluate(() => { const c = document.querySelector('#app > canvas'); return `${c.width}x${c.height}`; });
  console.log('LEGACY 0.85 render buffer:', upgraded);
  globalThis.legacyBuffer = upgraded;
  await context.close();

  const custom = await boot({ stored: { qualityPreset: 'balanced', renderScale: 0.5, showStadium: false, limitFps: true, maxFps: 60 } });
  const customBuffer = await custom.page.evaluate(() => { const c = document.querySelector('#app > canvas'); return `${c.width}x${c.height}`; });
  console.log('HAND-PICKED 0.5 render buffer:', customBuffer);
  globalThis.customBuffer = customBuffer;
  await custom.context.close();
}

// 3) High-DPI screen: renderScale 1 must mean native device pixels (DPR 2).
{
  const { context, page } = await boot({ stored: null, viewport: { width: 800, height: 450 }, deviceScaleFactor: 2 });
  const retina = await page.evaluate(() => {
    const c = document.querySelector('#app > canvas');
    return { dpr: window.devicePixelRatio || 1, buffer: `${c.width}x${c.height}` };
  });
  console.log('RETINA facts:', JSON.stringify(retina));
  globalThis.retina = retina;
  await context.close();
}

// 4) Potato preset in a fresh boot: no blades either, potato default scale kept.
{
  const { context, page, errors } = await boot({
    stored: { qualityPreset: 'potato', renderScale: 0.6, showStadium: false, limitFps: true, maxFps: 30 },
    viewport: { width: 1280, height: 720 },
  });
  const potatoFacts = await factsOf(page);
  console.log('POTATO facts:', JSON.stringify(potatoFacts));
  await page.screenshot({ path: `${out}/potato.png`, timeout: 140000 });
  globalThis.potatoFacts = { facts: potatoFacts, errors };
  await context.close();
}

await browser.close();
server.kill();

const { facts, errors, expectedBuffer } = globalThis.freshFacts;
const failure = [];
if (facts.bladesPresent) failure.push('blade mesh still exists');
if (facts.bladeMeshes) failure.push(`blade-named meshes in turf: ${facts.bladeMeshes}`);
if (facts.detailImage !== '1024x1024') failure.push(`detail texture wrong: ${facts.detailImage}`);
if (facts.detailAnisotropy !== 16) failure.push(`detail anisotropy wrong: ${facts.detailAnisotropy}`);
if (facts.canvasAnisotropy !== 16) failure.push(`canvas anisotropy wrong: ${facts.canvasAnisotropy}`);
if (facts.grassGain < 0.7 || facts.grassGain > 1.6) failure.push(`grassGain out of range: ${facts.grassGain}`);
if (facts.canvas !== '2048x2560') failure.push(`turf canvas wrong: ${facts.canvas}`);
if (facts.renderBuffer !== expectedBuffer) failure.push(`fresh render buffer ${facts.renderBuffer} != native ${expectedBuffer}`);
if (globalThis.legacyBuffer !== '1024x576') failure.push(`legacy 0.85 not upgraded: ${globalThis.legacyBuffer}`);
if (globalThis.customBuffer !== '512x288') failure.push(`hand-picked 0.5 not kept: ${globalThis.customBuffer}`);
if (globalThis.retina.buffer !== '1600x900') failure.push(`retina buffer wrong: ${globalThis.retina.buffer} (dpr ${globalThis.retina.dpr})`);
if (errors.length) failure.push(`page errors: ${errors[0]}`);
if (globalThis.potatoFacts.facts.bladesPresent) failure.push('potato built blades');
if (globalThis.potatoFacts.errors.length) failure.push(`potato page errors: ${globalThis.potatoFacts.errors[0]}`);
console.log(failure.length ? `FAIL: ${failure.join('; ')}` : 'TURF PASS');
process.exit(failure.length ? 1 : 0);
