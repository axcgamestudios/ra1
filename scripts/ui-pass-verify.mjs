// Visual verification for this pass: boot loading screen (stage checklist +
// tips), the RL "PRESS ANY BUTTON TO START" title gate, the reverted play-mode
// grid, the animated main menu, the RL pause menu (5 rows + player card),
// announcer banners, the scoreboard, the goal light beams and the winner
// screen (WINNER / team word / MVP / nameplates).
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

// RL title gate: with navigator.webdriver faked off, the loaded boot screen
// must hold on "PRESS ANY BUTTON TO START" until a real key arrives.
{
  const human = await context.newPage();
  await human.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({ qualityPreset: 'balanced', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 30 }));
  });
  human.setDefaultTimeout(90000);
  human.on('pageerror', e => errors.push(String(e).slice(0, 250)));
  await human.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await human.locator('#loading[data-state="ready"] .load__press').waitFor({ timeout: 90000 });
  results.gateState = await human.getAttribute('#loading', 'data-state');
  results.gatePress = await human.locator('.load__press').isVisible();
  results.gateLegal = await human.locator('.load__legal').isVisible();
  results.gateChecklistHidden = !(await human.locator('#loading .load__progress-block').isVisible());
  await human.screenshot({ path: `${out}/boot-press-any-button.png` });
  await human.keyboard.press('Enter');
  await human.locator('.arena-home:not([hidden])').waitFor({ timeout: 90000 });
  await until(async () => (await human.locator('#loading').count()) === 0);
  results.gateKeyDismisses = true;
  await human.close();
  console.log('title gate:', JSON.stringify({ state: results.gateState, press: results.gatePress, legal: results.gateLegal }));
}
// Goal celebration: light beams + electric arcs fire with the explosion.
await page.evaluate(() => window.rocketArenaPresentation.testGoal(0));
await delay(420);
results.beams = await page.evaluate(() => {
  const beams = [...document.querySelectorAll('canvas')];
  return { effectsActive: window.rocketArenaPresentation.effectsActive() };
});
await page.screenshot({ path: `${out}/goal-beams.png` });
console.log('goal beams:', JSON.stringify(results.beams));

// RL pause menu: five rows, highlighted RESUME GAME, hint + player card.
await page.keyboard.press('Escape');
await delay(500);
results.pause = await page.evaluate(() => {
  const menu = document.querySelector('.arena-pause');
  return {
    open: menu && !menu.hidden,
    title: menu?.querySelector('h2')?.textContent,
    rows: [...menu.querySelectorAll('nav [data-pause]')].map(b => b.textContent.trim()),
    hint: menu?.querySelector('[data-pause-hint]')?.textContent,
    hintVisible: menu?.querySelector('[data-pause-hint]')?.offsetParent !== null,
    player: menu?.querySelector('[data-pause-name]')?.textContent,
    level: menu?.querySelector('[data-pause-level]')?.textContent,
    party: menu?.querySelector('[data-pause="party"]')?.textContent.trim(),
  };
});
await page.screenshot({ path: `${out}/pause-menu.png` });
await page.keyboard.press('Escape');
await delay(400);
results.pauseClosed = await page.evaluate(() => document.querySelector('.arena-pause')?.hidden !== false);
console.log('pause menu:', JSON.stringify(results.pause));

// Winner screen: WINNER caption, glowing team word, MVP line, nameplates.
await page.evaluate(() => window.rocketArenaPresentation.testVictory('victory', 0));
await delay(700);
results.victory = await page.evaluate(() => {
  const screen = document.querySelector('.arena-victory');
  return {
    visible: screen && !screen.hidden,
    caption: screen?.querySelector('.arena-victory__caption')?.textContent,
    word: screen?.querySelector('.arena-victory__word')?.textContent,
    mvp: screen?.querySelector('.arena-victory__mvp')?.textContent,
    plates: [...screen.querySelectorAll('.arena-victory__plate')].map(p => ({
      name: p.querySelector('b')?.textContent,
      titles: [...p.querySelectorAll('.arena-victory__plate-line i')].map(i => i.textContent),
      mvp: p.classList.contains('is-mvp'),
    })),
    confetti: screen?.querySelectorAll('.arena-victory__confetti i').length,
    buttons: [...screen.querySelectorAll('.arena-victory__button')].map(b => b.textContent),
  };
});
await page.screenshot({ path: `${out}/winner-screen.png` });
await page.evaluate(() => window.rocketArenaPresentation.testVictory('defeat', 0));
await delay(500);
results.defeatWord = await page.evaluate(() => document.querySelector('.arena-victory .arena-victory__word')?.textContent);
results.defeatChip = await page.evaluate(() => document.querySelector('.arena-victory .arena-victory__chip')?.textContent);
await page.screenshot({ path: `${out}/defeat-screen.png` });
console.log('winner screen:', JSON.stringify(results.victory));
console.log('defeat screen:', JSON.stringify({ word: results.defeatWord, chip: results.defeatChip }));
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.kill();
const ok = results.playItems === 3 && results.loadingStages === 8 && results.loadingGone
  && results.level === 'LVL 13' && results.board.visible && results.board.rows >= 2
  && results.board.blueWins === '112' && errors.length === 0
  && results.gateState === 'ready' && results.gatePress && results.gateLegal
  && results.gateChecklistHidden && results.gateKeyDismisses
  && results.pause?.open && results.pause?.rows?.length === 5
  && results.pause?.rows[0] === 'RESUME GAME' && results.pause?.rows[4] === 'EXIT TO MAIN MENU'
  && results.pause?.hintVisible && results.pause?.party === 'CREATE PARTY'
  && results.pauseClosed && results.victory?.visible
  && results.victory?.caption === 'WINNER' && results.victory?.word === 'BLUE'
  && results.victory?.plates?.length === 2 && results.victory?.plates[0]?.mvp
  && results.victory?.confetti >= 12 && results.defeatWord === 'ORANGE'
  && results.defeatChip === 'DEFEAT';
console.log(ok ? 'PASS: UI verification' : 'FAIL: UI verification');
process.exit(ok ? 0 : 1);
