// Diagnose the goal obstruction bug: boot the game, walk every stadium,
// dump every mesh in the orange-goal region and screenshot the kickoff view.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';

const out = 'evidence/goal-bug';
await mkdir(out, { recursive: true });
const PORT = '4174';
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' },
  stdio: 'ignore',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) {
  const start = performance.now();
  while (!(await fn())) {
    if (performance.now() - start > timeout) throw new Error('timed out');
    await delay(120);
  }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });

const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
page.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);

const dump = await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const scene = world.scene;
  scene.updateMatrixWorld(true);
  const rows = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.visible) return;
    const V = obj.position.constructor;
    const p = new V();
    obj.getWorldPosition(p);
    if (p.z < 4200 || p.z > 7200 || Math.abs(p.x) > 3200 || p.y < -200 || p.y > 2200) return;
    let size = '';
    try {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      size = `${(bb.max.x - bb.min.x).toFixed(0)}x${(bb.max.y - bb.min.y).toFixed(0)}x${(bb.max.z - bb.min.z).toFixed(0)}`;
    } catch {}
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) {
      rows.push({
        name: obj.name || obj.parent?.name || '(unnamed)',
        pos: [p.x, p.y, p.z].map(v => Math.round(v)).join(','),
        size,
        color: m?.color?.getHexString?.() ?? String(m?.color ?? ''),
        opacity: m?.opacity, transparent: m?.transparent,
        blending: m?.blending, depthWrite: m?.depthWrite, type: m?.type,
        userDataKeys: m?.userData ? Object.keys(m.userData).join('|') : '',
      });
    }
  });
  return rows;
});
console.log(`\n=== ORANGE GOAL REGION MESHES (z 4200-7200) — ${dump.length} material slots ===`);
for (const r of dump.sort((a, b) => a.name.localeCompare(b.name)))
  console.log(`${r.name.slice(0, 58).padEnd(58)} pos(${r.pos}) size ${r.size.padEnd(12)} #${r.color} op=${r.opacity} tr=${r.transparent ? 1 : 0} blend=${r.blending} dw=${r.depthWrite ? 1 : 0}`);

for (const stadium of ['park', 'neon', 'dusk']) {
  await page.evaluate(id => window.rocketArenaPresentation.stadium.set(id), stadium);
  await delay(3000);
  await page.screenshot({ path: `${out}/goal-${stadium}.png` });
  console.log(`saved ${out}/goal-${stadium}.png`);
}
await browser.close();
server.kill();
await once(server, 'exit').catch(() => {});
console.log('done');
