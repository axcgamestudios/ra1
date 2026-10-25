// Real gameplay announcer flow: boot the game into freeplay, drive the kickoff
// ball straight at the orange goal with boost and watch the announcer chain
// fire: SHOT ON GOAL! -> GOAL! -> NICE SHOT!.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = '4176';
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
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'potato', renderScale: 0.5, showStadium: true, limitFps: true, maxFps: 60,
  }));
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2000);

const readState = () => page.evaluate(() => {
  const dbg = window.rocketArenaPhysics?.snapshot();
  const s = dbg?.samples?.[dbg.samples.length - 1];
  return s ? { carX: s.state[22], carY: s.state[23], ballX: s.state[4], ballY: s.state[5] } : null;
});

// Re-roll the kickoff until we get the straight center spawn (car x ~ 0,
// directly behind the ball): driving dead straight then hits the ball into
// the goal without any steering.
let spawns = 0;
for (; spawns < 20; spawns++) {
  const state = await readState();
  if (state && Math.abs(state.carX) < 60 && Math.abs(state.carY) > 2300) break;
  await page.keyboard.press('Backspace');
  await delay(350);
}
console.log('kickoff re-rolls:', spawns, 'start:', JSON.stringify(await readState()));

// Focus the window (game reads global key events) and hold throttle only: a
// full-boost kickoff lob clears the crossbar, a pushed rolling ball scores.
await page.evaluate(() => window.focus());
await page.keyboard.down('w');
const seen = new Set();
const poll = setInterval(async () => {
  const text = await page.evaluate(() => {
    const el = document.querySelector('.announcer-banner');
    return el && !el.hidden ? el.textContent : null;
  }).catch(() => null);
  if (text) seen.add(text);
}, 90);
const trace = setInterval(async () => {
  const info = await page.evaluate(() => {
    const dbg = window.rocketArenaPhysics?.snapshot();
    const s = dbg?.samples?.[dbg.samples.length - 1];
    return s ? { car: s.state.slice(22, 25).map(v => v.toFixed(0)), ball: s.state.slice(4, 7).map(v => v.toFixed(0)) } : null;
  }).catch(() => null);
  console.log('  trace:', JSON.stringify(info));
}, 1500);

// Drive straight into the ball and chase it: the kickoff lob flies over the
// bar, lands and rolls; the closing second touch near the goal is the shot.
await delay(34000);
clearInterval(poll);
clearInterval(trace);

await page.keyboard.up('w');

const observed = [...seen];
console.log('banners observed during play:', observed);
const stats = await page.evaluate(() => window.rocketArenaPresentation.stats());
console.log('stats after play:', stats.slots.map(s => ({ slot: s.slot, goals: s.goals, shots: s.shots, points: s.points })));

const failures = [];
if (!observed.includes('SHOT ON GOAL!')) failures.push('no SHOT ON GOAL! banner');
if (!observed.includes('GOAL!')) failures.push('no GOAL! banner');
if (!observed.includes('NICE SHOT!')) failures.push('no NICE SHOT! banner');
for (const e of errors) failures.push(`pageerror: ${e}`);
console.log(failures.length === 0 ? '\nGAMEPLAY ANNOUNCER FLOW: ALL PASS' : `\nGAMEPLAY FAILURES:\n${failures.join('\n')}`);

await browser.close();
server.kill();
await Promise.race([once(server, 'exit'), delay(3000)]);
process.exit(failures.length === 0 ? 0 : 1);
