// Two-browser P2P goal presentation verification: real goals (forced through
// the authoritative sim) must run the celebration + replay on BOTH peers,
// hold the goal phase for the presentation, and release it at the end or on
// a guest's skip — no frozen arena, no missed replay.
//
// Headless SwiftShader renders at ~1-2 fps, so every wait is STATE-driven
// (goalState()/phase polling) with generous timeouts; the wall-clock numbers
// in the log are diagnostics only.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/goal-online';
await mkdir(out, { recursive: true });
const PORT = '4197';
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000, what = '') {
  const start = performance.now();
  while (!(await fn())) {
    if (performance.now() - start > timeout) throw new Error(`timed out: ${what} (${Math.round(performance.now() - start)}ms)`);
    await delay(150);
  }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });

const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
await context.addInitScript(() => {
  localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
    qualityPreset: 'potato', renderScale: 0.5, showStadium: false, limitFps: true, maxFps: 30,
  }));
});
const errors = [];
const track = page => {
  page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
  page.on('requestfailed', r => errors.push('reqfail: ' + r.url().slice(-70)));
};
const status = page => page.evaluate(() => document.querySelector('.online-status')?.textContent ?? '');
const phase = page => page.evaluate(() => window.rocketArenaOnline?.snapshot().phase ?? 'unknown');
const presentation = page => page.evaluate(() => {
  const el = document.querySelector('.goal-presentation');
  if (!el || el.hidden) return { active: false };
  return {
    active: true,
    announcement: !el.querySelector('.goal-presentation__announcement')?.hidden,
    replay: !el.querySelector('.goal-presentation__replay')?.hidden,
    youScored: (el.querySelector('.goal-presentation__goal-graphic')?.src ?? '').includes('goal-you-scored'),
  };
});
const goalState = page => page.evaluate(() => window.rocketArenaPresentation?.goalState?.() ?? null);
const scores = page => page.evaluate(() => ({
  blue: document.querySelector('.online-hud [data-score="blue"]')?.textContent,
  orange: document.querySelector('.online-hud [data-score="orange"]')?.textContent,
}));

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
  await page.locator('[data-home="casual"]').click();
  await page.locator('.online-dialog:not([hidden])').waitFor({ timeout: 20000 });
  return page;
}

let failures = 0;
let host = null, guest = null;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

try {
  host = await newPlayer('HostGuy', 'fennec');
  guest = await newPlayer('GuestGal', 'octane-original');
  await host.locator('[data-p2p="create"]').click();
  await delay(6000);
  const code = (await host.locator('[data-room-code]').textContent()).trim();
  console.log('room code:', code);
  await guest.locator('[name="roomCode"]').fill(code);
  await guest.locator('[data-p2p="join"]').click();
  await delay(6000);
  await host.locator('[data-p2p="start"]').click({ timeout: 30000 });

  await until(async () => (await phase(host)) === 'playing', 90000, 'host playing');
  await until(async () => (await phase(guest)) === 'playing', 90000, 'guest playing');
  check('match started, both peers playing', true, `host=${await status(host)}`);
  await delay(8000); // let the replay buffer record some play

  // ---------------------------------------------------------------- goal 1 ----
  // Blue (host team) scores through the REAL pipeline: the host's
  // authoritative ball placement -> pollGoal -> phase 'goal' -> events.
  await host.evaluate(() => window.rocketArenaPresentation.forceGoal(0));
  await until(async () => (await phase(host)) === 'goal', 15000, 'host goal phase');
  await until(async () => (await phase(guest)) === 'goal', 15000, 'guest goal phase');
  check('goal 1: phase is goal on both peers', true);

  await until(async () => (await presentation(host)).active, 15000, 'host presentation');
  await until(async () => (await presentation(guest)).active, 15000, 'guest presentation');
  await until(async () => (await goalState(host)).elapsed >= 0.2, 30000, 'host celebration advances');
  const hostCele = await presentation(host), guestCele = await presentation(guest);
  check('goal 1: celebration visible on host', hostCele.active && hostCele.announcement, JSON.stringify(hostCele));
  check('goal 1: celebration visible on guest', guestCele.active && guestCele.announcement, JSON.stringify(guestCele));
  check('goal 1: host sees "you scored"', hostCele.youScored);
  check('goal 1: guest does not see "you scored"', guestCele.active && !guestCele.youScored);
  await host.screenshot({ path: `${out}/01-host-celebration.png` });
  await guest.screenshot({ path: `${out}/02-guest-celebration.png` });

  // The goal phase HOLDS while the presentation runs (the old bug: 3 s of
  // dead-frozen arena, then a hard reset with no replay at all).
  await delay(4000);
  check('goal 1: goal phase held while the presentation runs',
    (await phase(host)) === 'goal' && (await phase(guest)) === 'goal',
    `host=${await phase(host)} guest=${await phase(guest)}`);

  // Replay phase (2 s celebration, then the clip) on both peers. The guest
  // must be sampled IMMEDIATELY after its own wait: waiting for the host's
  // replay start (SwiftShader renders it much slower) lets the guest's clip
  // finish naturally in between, which is not a game failure.
  await until(async () => (await goalState(guest)).replaying, 60000, 'guest replay starts');
  const guestRep = await presentation(guest);
  await until(async () => (await goalState(host)).replaying, 90000, 'host replay starts');
  const hostRep = await presentation(host);
  check('goal 1: replay running on guest', guestRep.active && guestRep.replay, JSON.stringify(guestRep));
  check('goal 1: replay running on host', hostRep.active && hostRep.replay, JSON.stringify(hostRep));
  await host.screenshot({ path: `${out}/03-host-replay.png` });
  await guest.screenshot({ path: `${out}/04-guest-replay.png` });

  // Natural end: both presentations finish, kickoff follows, play resumes.
  await until(async () => !(await presentation(host)).active, 120000, 'host presentation end');
  await until(async () => !(await presentation(guest)).active, 120000, 'guest presentation end');
  await delay(1000);
  const postScores = await scores(guest);
  check('goal 1: blue scored', postScores.blue === '1', JSON.stringify(postScores));
  await until(async () => (await phase(host)) === 'playing', 60000, 'host resumes playing');
  await until(async () => (await phase(guest)) === 'playing', 60000, 'guest resumes playing');
  check('goal 1: match resumed for everyone', true, `host=${await phase(host)} guest=${await phase(guest)}`);
  await host.screenshot({ path: `${out}/05-host-resumed.png` });
  await delay(8000);

  // ---------------------------------------------------------------- goal 2 ----
  // Orange (guest team) scores, then the GUEST skips: the goal phase must end
  // for everyone shortly after (no staring at a frozen arena).
  await host.evaluate(() => window.rocketArenaPresentation.forceGoal(1));
  await until(async () => (await phase(guest)) === 'goal', 15000, 'guest goal phase 2');
  await until(async () => (await presentation(guest)).active, 15000, 'guest presentation 2');
  await until(async () => (await goalState(guest)).replaying, 90000, 'guest replay 2');
  await until(async () => (await goalState(host)).replaying, 120000, 'host replay 2');
  const guestRep2 = await presentation(guest), hostRep2 = await presentation(host);
  check('goal 2: replay running on guest', guestRep2.active && guestRep2.replay, JSON.stringify(guestRep2));
  check('goal 2: replay running on host', hostRep2.active && hostRep2.replay, JSON.stringify(hostRep2));
  check('goal 2: guest sees "you scored"', guestRep2.youScored);
  await guest.screenshot({ path: `${out}/06-guest-replay-goal2.png` });

  const skipAt = performance.now();
  await guest.keyboard.press('Escape');
  await until(async () => !(await presentation(guest)).active, 10000, 'guest skip ends presentation');
  await until(async () => !(await presentation(host)).active, 15000, 'host presentation cut by skip');
  check('goal 2: guest skip ended both presentations', true,
    `${Math.round(performance.now() - skipAt)} ms after skip`);
  await until(async () => {
    const p = await phase(host);
    return p === 'kickoff' || p === 'playing';
  }, 15000, 'host leaves goal phase after skip');
  await until(async () => {
    const p = await phase(guest);
    return p === 'kickoff' || p === 'playing';
  }, 15000, 'guest leaves goal phase after skip');
  check('goal 2: goal phase released for everyone after skip', true,
    `host=${await phase(host)} guest=${await phase(guest)}`);
  await until(async () => (await phase(host)) === 'playing', 60000, 'host playing again');
  await until(async () => (await phase(guest)) === 'playing', 60000, 'guest playing again');
  const finalScores = await scores(guest);
  check('goal 2: orange scored', finalScores.orange === '1', JSON.stringify(finalScores));
  await host.screenshot({ path: `${out}/07-host-after-skip.png` });

  const realErrors = errors.filter(e => !e.includes('Fennec') && !e.includes('favicon'));
  check('no page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures++;
  console.log('HARNESS ERROR:', String(error).slice(0, 400));
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    if (!page) continue;
    try {
      console.log(`${name}: phase=${await phase(page)} presentation=${JSON.stringify(await presentation(page))} goal=${JSON.stringify(await goalState(page))} status=${await status(page)}`);
    } catch (e) { console.log(`${name}: diagnostics failed: ${String(e).slice(0, 120)}`); }
  }
  console.log('page errors:', errors.slice(0, 8));
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await browser.close().catch(() => {});
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
