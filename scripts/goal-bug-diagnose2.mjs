// Follow-up: dump the scene's coordinate space and goal-adjacent meshes.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = '4175';
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
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
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
await delay(2000);

const info = await page.evaluate(() => {
  const world = window.rocketArenaPresentation.world();
  const camera = window.rocketArenaPresentation.camera();
  const scene = world.scene;
  scene.updateMatrixWorld(true);
  const rows = [];
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.visible) return;
    const V = obj.position.constructor;
    const p = new V();
    obj.getWorldPosition(p);
    let size = 0;
    try {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    } catch {}
    const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    rows.push({
      name: (obj.name || obj.parent?.name || '(unnamed)').slice(0, 55),
      x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), size: Math.round(size),
      color: m?.color?.getHexString?.() ?? '', op: m?.opacity, tr: m?.transparent ? 1 : 0,
      blend: m?.blending, dw: m?.depthWrite === false ? 0 : 1,
    });
  });
  return { rows, cameraPos: [camera.position.x, camera.position.y, camera.position.z].map(Math.round) };
});
console.log('camera at', info.cameraPos, `— ${info.rows.length} visible meshes`);
console.log('\n=== 45 meshes with largest |z| ===');
for (const r of info.rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 45))
  console.log(`${String(r.name).padEnd(55)} pos(${r.x},${r.y},${r.z}) size ${String(r.size).padStart(5)} #${r.color} op=${r.op} tr=${r.tr} blend=${r.blend} dw=${r.dw}`);
await browser.close();
server.kill();
await once(server, 'exit').catch(() => {});
console.log('done');
