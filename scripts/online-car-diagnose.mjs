// Two-browser P2P match: verify every car renders on BOTH sides after an
// online start (host-authoritative sim + guest prediction).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/invisible-car';
await mkdir(out, { recursive: true });
const PORT = '4189';
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
const errors = [];
const track = page => {
  page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url().slice(-70)));
};
const probe = page => page.evaluate(() => {
  const N = window.rocketArenaPresentation.world();
  return N.cars.map(car => {
    if (!car) return null;
    car.updateMatrixWorld(true);
    let meshes = 0, visibleMeshes = 0;
    car.traverse(o => { if (o.isMesh) { meshes++; if (o.visible) visibleMeshes++; } });
    return { visible: car.visible, meshes, visibleMeshes };
  });
});
const status = page => page.evaluate(() => document.querySelector('.online-status')?.textContent ?? '');

async function newPlayer(name, visual) {
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  track(page);
  await page.addInitScript(([n, v]) => {
    localStorage.setItem('rocket-arena.local-display.v3', JSON.stringify({ carVisual: v }));
    localStorage.setItem('arena.p2p.name', n);
  }, [name, visual]);
  await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="join"]').click();
  await page.locator('.online-dialog:not([hidden])').waitFor({ timeout: 20000 });
  return page;
}

const host = await newPlayer('HostGuy', 'fennec');
const guest = await newPlayer('GuestGal', 'octane-original');
await host.locator('[data-p2p="create"]').click();
await delay(6000);
const code = (await host.locator('[data-room-code]').textContent()).trim();
console.log('room code:', code);
await guest.locator('[name="roomCode"]').fill(code);
await guest.locator('[data-p2p="join"]').click();
await delay(6000);
console.log('host status:', await status(host));
console.log('guest status:', await status(guest));
await host.locator('[data-p2p="start"]').click({ timeout: 30000 });
await delay(12000);
console.log('after start — host status:', await status(host));
console.log('after start — guest status:', await status(guest));
console.log('host cars:', JSON.stringify(await probe(host)));
console.log('guest cars:', JSON.stringify(await probe(guest)));
await host.screenshot({ path: `${out}/online-host.png` });
await guest.screenshot({ path: `${out}/online-guest.png` });
// Let the match run a while; visibility must hold.
await delay(12000);
console.log('host cars (late):', JSON.stringify(await probe(host)));
console.log('guest cars (late):', JSON.stringify(await probe(guest)));
await host.screenshot({ path: `${out}/online-host-late.png` });
await guest.screenshot({ path: `${out}/online-guest-late.png` });
console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
server.kill();
