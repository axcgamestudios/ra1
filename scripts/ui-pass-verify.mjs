// Visual verification for this pass: boot loading screen (stage checklist +
// tips), the reverted play-mode grid, the animated main menu, announcer banner
// (all kinds), and the scoreboard's side rails/mode/overtime treatment.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/ui-pass';
await mkdir(out, { recursive: true });
const PORT = '4203';
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
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 }));
  localStorage.setItem('arena.p2p.name', 'Psyonix');
  localStorage.setItem('rocket-arena.player-progress.v1', JSON.stringify({ played: 90, blueWins: 112, orangeWins: 8 }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
const results = {};

// Boot loading screen: stage checklist + tips visible, then it fades away.
await page.locator('#loading').waitFor();
results.loadingStages = await page.locator('#loading .load__stages li').count();
results.loadingTip = await page.locator('#loading [data-load-tip]').count();
await page.screenshot({ path: `${out}/loading.png` });
await page.locator('.arena-home:not([hidden])').waitFor();
await until(async () => (await page.locator('#loading').count()) === 0);
results.loadingGone = true;
console.log('loading:', JSON.stringify(results));

// Home: player card with level + staggered entrance + FX classes.
results.level = await page.locator('[data-home-level]').textContent();
results.entering = await page.locator('.arena-home.is-entering').count();
await page.screenshot({ path: `${out}/home-main.png` });
await page.locator('[data-home="play"]').click();
await delay(400);
results.playItems = await page.locator('.arena-mode').count();
await page.locator('.arena-mode[data-home="match"]').hover();
await delay(300);
await page.screenshot({ path: `${out}/home-play-grid.png` });
console.log('home:', JSON.stringify(results));

// MULTIPLAYER card opens the peer-to-peer dialog.
await page.locator('.arena-mode[data-home="casual"]').click();
await delay(1200);
results.onlineVisible = await page.locator('.online-status').isVisible();
results.joinStatus = await page.locator('.online-status').textContent();
await page.screenshot({ path: `${out}/home-join-dialog.png` });
console.log('multiplayer entry:', JSON.stringify(results));

// Freeplay: announcer banners + scoreboard.
await page.locator('[data-p2p="back"]').click();
await delay(600);
await page.locator('[data-home="play"]').click();
await delay(300);
await page.locator('.arena-mode[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2000);
for (const kind of ['what-a-save', 'epic-save', 'demolition', 'great-pass']) {
  await page.evaluate(k => window.rocketArenaPresentation.say(k), kind);
  await delay(340);
  await page.screenshot({ path: `${out}/announcer-${kind}.png` });
  await delay(1900);
}
results.bannerText = await page.evaluate(() => document.querySelector('.announcer-banner__text')?.textContent ?? null);
results.bannerKinds = await page.evaluate(() => {
  const kinds = ['what-a-save', 'epic-save', 'demolition', 'great-pass'];
  return kinds.map(k => { window.rocketArenaPresentation.say(k); const b = document.querySelector('.announcer-banner'); return b?.dataset?.kind; });
});
console.log('announcer:', JSON.stringify(results));

// Scoreboard: hold TAB, check the new pieces.
await page.keyboard.down('Tab');
await delay(600);
results.board = await page.evaluate(() => {
  const board = document.querySelector('.arena-scoreboard');
  return {
    visible: !board.hidden,
    mode: board.querySelector('[data-board="mode-label"]')?.textContent,
    phase: board.querySelector('[data-board="phase-label"]')?.textContent,
    blueWins: board.querySelector('[data-board="blue-wins"]')?.textContent,
    orangeWins: board.querySelector('[data-board="orange-wins"]')?.textContent,
    blueMvp: board.querySelector('[data-board="blue-mvp"]')?.textContent,
    rows: board.querySelectorAll('.arena-scoreboard__player').length,
  };
});
await page.screenshot({ path: `${out}/scoreboard.png` });
await page.keyboard.up('Tab');
console.log('scoreboard:', JSON.stringify(results));
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.kill();
const ok = results.playItems === 3 && results.loadingStages === 8 && results.loadingGone
  && results.level === 'LVL 13' && results.board.visible && results.board.rows >= 2
  && results.board.blueWins === '112' && errors.length === 0;
console.log(ok ? 'PASS: UI verification' : 'FAIL: UI verification');
process.exit(ok ? 0 : 1);
