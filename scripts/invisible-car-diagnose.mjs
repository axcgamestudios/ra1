// Reproduce "car model doesn't load / car turns invisible".
// Boots the game, probes the live car in freeplay, swaps every garage body,
// enters a bot match, fires a goal (replay) and probes again after each step.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/invisible-car';
await mkdir(out, { recursive: true });
const PORT = '4188';
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
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);

const probe = index => page.evaluate(i => {
  const N = window.rocketArenaPresentation.world();
  const car = N.cars[i];
  if (!car) return { exists: false };
  car.updateMatrixWorld(true);
  let meshes = 0, visibleMeshes = 0, materials = 0, missingMaterial = 0;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  car.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    if (!o.visible) return;
    visibleMeshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { materials++; if (!m) missingMaterial++; }
    const g = o.geometry;
    if (g?.attributes?.position?.count) {
      g.computeBoundingBox?.();
      const b = g.boundingBox;
      if (b) {
        const v = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
        for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], v[k]); box.max[k] = Math.max(box.max[k], v[k + 3]); }
      }
    }
  });
  const pos = [car.matrixWorld.elements[12], car.matrixWorld.elements[13], car.matrixWorld.elements[14]];
  return {
    exists: true, carVisible: car.visible, visual: N.carVisuals[i],
    inScene: car.parent === N.scene, sceneChildren: N.scene.children.length,
    meshes, visibleMeshes, materials, missingMaterial,
    bounds: isFinite(box.min[0]) ? box : null,
    pos: pos.map(n => Math.round(n)),
  };
}, index);

const report = {};
report.boot = await probe(0);
await page.screenshot({ path: `${out}/01-boot-freeplay.png` });
console.log('boot:', JSON.stringify(report.boot));

// Garage swap through every body.
await page.keyboard.press('Escape');
await delay(700);
await page.locator('[data-pause="home"]').click();
await page.locator('.arena-home:not([hidden])').waitFor({ timeout: 20000 });
await page.locator('[data-home="garage"]').click();
await page.locator('#car-overlay:not([hidden])').waitFor({ timeout: 20000 });
await delay(1500);
const carIds = await page.evaluate(() => Array.from(document.querySelectorAll('[data-car-choice]')).map(b => b.dataset.carChoice));
console.log('garage bodies:', carIds.join(', '));
report.swaps = [];
// Garage swaps happen live (onChoose swaps the arena car immediately); probe
// the arena car after each card click without leaving the garage.
for (const id of carIds) {
  await page.locator(`[data-car-choice="${id}"]`).click();
  await delay(2600);
  const p = await probe(0);
  report.swaps.push({ id, ...p });
  console.log(`swap ${id}:`, JSON.stringify({ visible: p.carVisible, meshes: p.meshes, vis: p.visibleMeshes, inScene: p.inScene, pos: p.pos }));
  if (!p.carVisible || !p.visibleMeshes) await page.screenshot({ path: `${out}/broken-${id}.png` });
}
await page.screenshot({ path: `${out}/02-garage-end.png` });

// Bot match: both cars must render, survive a goal + replay. BACK returns to
// the home screen; from there open a bot match via the play menu.
await page.locator('[data-car-close]').first().click();
await delay(600);
await page.locator('.arena-home:not([hidden])').waitFor({ timeout: 20000 });
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="match"]').click();
await page.locator('[data-bot-id]').first().click();
await delay(300);
await page.locator('[data-match="start"]').click();
await delay(6000);
report.matchStart = { self: await probe(0), bot: await probe(1) };
console.log('match self:', JSON.stringify(report.matchStart.self));
console.log('match bot:', JSON.stringify(report.matchStart.bot));
await page.screenshot({ path: `${out}/03-match.png` });

await page.evaluate(() => window.rocketArenaPresentation.testGoal(0));
await delay(1500);
await page.screenshot({ path: `${out}/04-goal.png` });
await delay(9000);
report.afterGoal = { self: await probe(0), bot: await probe(1) };
console.log('after goal self:', JSON.stringify(report.afterGoal.self));
await page.screenshot({ path: `${out}/05-after-goal.png` });

console.log('page errors:', errors.length ? errors.slice(0, 8) : 'none');

// Persist report for inspection.
const { writeFile } = await import('node:fs/promises');
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.kill();
process.exit(errors.length ? 1 : 0);
