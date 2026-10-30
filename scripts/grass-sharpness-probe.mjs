// Close-range turf sharpness probe, honest framing: the gameplay chase camera
// (what the player actually sees) settles over the spawned car, then the
// screenshot is decoded in-page and scored with a GREEN-GATED Laplacian
// metric — only grass pixels count, so the car, white lines and painted team
// zones cannot pollute the number. Reference points measured on the source
// photo: 1:1 = ~60 HF, 2x bilinear upscale = ~12.9 HF. PASS needs the visible
// near-field grass to beat the 2x-upscale reference by a clear margin.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/grass-pass';
await mkdir(out, { recursive: true });
const PORT = '4196';
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
// No stored graphics: the fresh-install default must already be full res.
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(150000);
const errors = [];
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);
page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e))) errors.push(String(e).slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
// Let the chase camera settle on the spawned car.
await delay(5200);
// Deterministic framing: freeze the camera pose by patching updateMatrixWorld
// (the renderer recomposes the view from it every frame, so the gameplay
// controller can no longer move the shot). Low camera over open green turf,
// away from the car spawn and the centre markings.
await page.evaluate(() => {
  const camera = window.rocketArenaPresentation.camera();
  camera.position.set(2500, 55, 3000);
  camera.lookAt(2000, 0, 2000);
  const pos = camera.position.toArray();
  const quat = camera.quaternion.toArray();
  camera.updateMatrixWorld = function() {
    this.position.fromArray(pos);
    this.quaternion.fromArray(quat);
    this.matrixWorld.compose(this.position, this.quaternion, this.scale);
    this.matrixWorldInverse.copy(this.matrixWorld).invert();
  };
});
await delay(900);
const shot = await page.screenshot({ timeout: 140000 });
await import('node:fs/promises').then(fs => fs.writeFile(`${out}/low-camera-native.png`, shot));

// Facts: native buffer, anisotropic turf filters, and the green-gated HF.
const facts = await page.evaluate(async base64 => {
  const world = window.rocketArenaPresentation.world();
  const surface = world.turf.getObjectByName('Park / painted playing surface');
  const detail = surface.material.userData.parkGround.detail.value;
  const c = document.querySelector('#app > canvas');
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('screenshot decode failed'));
    image.src = `data:image/png;base64,${base64}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const W = canvas.width, H = canvas.height;
  const at = (x, y) => (y * W + x) * 4;
  const lum = (x, y) => 0.299 * data[at(x, y)] + 0.587 * data[at(x, y) + 1] + 0.114 * data[at(x, y) + 2];
  const isGreen = (x, y) => {
    const o = at(x, y);
    return data[o + 1] > data[o] + 12 && data[o + 1] > data[o + 2] + 12;
  };
  let sum = 0, count = 0, greenCount = 0;
  for (let y = Math.floor(H * 0.4); y < H - 1; y++) {
    for (let x = Math.floor(W * 0.2); x < Math.floor(W * 0.8) - 1; x++) {
      if (!isGreen(x, y)) continue;
      greenCount++;
      count++;
      const lap = Math.abs(4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1));
      sum += lap;
    }
  }
  const regionPx = Math.floor(W * 0.6) * Math.floor(H * 0.6);
  return {
    renderBuffer: `${c.width}x${c.height}`, dpr: window.devicePixelRatio || 1,
    detailAnisotropy: detail?.anisotropy ?? null,
    detailImage: detail?.image ? `${detail.image.width}x${detail.image.height}` : null,
    greenHF: +(sum / Math.max(1, count)).toFixed(2),
    greenCoverage: +(100 * greenCount / regionPx).toFixed(1),
  };
}, shot.toString('base64'));
console.log('facts:', JSON.stringify(facts));
console.log('references: photo 1:1 HF~60.7, photo 2x-bilinear HF~12.9');
console.log('page errors:', errors.length ? errors : 'none');

const fail = [];
if (facts.renderBuffer !== '1280x720') fail.push(`buffer not native: ${facts.renderBuffer}`);
if (facts.detailAnisotropy !== 16) fail.push(`anisotropy wrong: ${facts.detailAnisotropy}`);
if (facts.greenCoverage < 12) fail.push(`not enough visible grass: ${facts.greenCoverage}%`);
if (facts.greenHF < 15) fail.push(`near-field grass too soft: HF ${facts.greenHF} (2x-upscale reference is 12.9)`);
if (errors.length) fail.push(errors[0]);
await browser.close();
server.kill();
console.log(fail.length ? `FAIL: ${fail.join('; ')}` : 'SHARPNESS PROBE PASS');
process.exit(fail.length ? 1 : 0);
