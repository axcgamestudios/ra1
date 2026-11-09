// Offline regression: a freeplay goal (real pipeline) must still trigger the
// celebration + replay and return to playable state afterwards.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = '4196';
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0' }, stdio: 'ignore',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000, what = '') {
  const start = performance.now();
  while (!(await fn())) { if (performance.now() - start > timeout) throw new Error(`timed out: ${what}`); await delay(150); }
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
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
try {
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
  await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="freeplay"]').click();
  await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
  await delay(5000);

  const presentation = () => page.evaluate(() => {
    const el = document.querySelector('.goal-presentation');
    if (!el || el.hidden) return { active: false };
    return {
      active: true,
      announcement: !el.querySelector('.goal-presentation__announcement')?.hidden,
      replay: !el.querySelector('.goal-presentation__replay')?.hidden,
      graphicLoaded: (el.querySelector('.goal-presentation__goal-graphic')?.naturalWidth ?? 0) > 0,
    };
  });
  const goalState = () => page.evaluate(() => window.rocketArenaPresentation.goalState());

  // Real freeplay goal: place the ball on a collision course with a goal.
  await page.evaluate(() => window.rocketArenaPresentation.forceGoal(0));
  await until(async () => (await presentation()).active, 20000, 'presentation begins');
  await until(async () => (await presentation()).graphicLoaded, 10000, 'goal graphic loads');
  check('offline: celebration begins with the goal graphic loaded', true, JSON.stringify(await presentation()));
  await until(async () => (await goalState()).replaying, 60000, 'replay starts');
  check('offline: replay starts', (await presentation()).replay, JSON.stringify(await presentation()));
  await until(async () => !(await presentation()).active, 120000, 'presentation ends naturally');
  // Back to playable freeplay: the ball reset is observable via the physics debug.
  await delay(1500);
  const ball = await page.evaluate(() => {
    const s = window.rocketArenaPhysics?.snapshot?.();
    const sample = s?.samples?.at(-1);
    return sample ? { y: sample.state[3] } : null; // STATE_LAYOUT.BALL + 1 (horizontal depth)
  });
  check('offline: arena reset after the presentation (ball back near center)', !!ball && Math.abs(ball.y) < 600, JSON.stringify(ball));
  check('offline: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  failures++;
  console.log('HARNESS ERROR:', String(error).slice(0, 400));
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await browser.close().catch(() => {});
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
