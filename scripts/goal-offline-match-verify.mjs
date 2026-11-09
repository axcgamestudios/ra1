// Offline bot-match regression: a rival goal (orange) must trigger the
// celebration + replay from the BOT's viewpoint and return to kickoff.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = '4193';
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
  await page.locator('[data-home="match"]').click();
  await page.locator('[data-match="start"]').click();
  await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
  await delay(6000);

  const presentation = () => page.evaluate(() => {
    const el = document.querySelector('.goal-presentation');
    if (!el || el.hidden) return { active: false };
    return {
      active: true,
      announcement: !el.querySelector('.goal-presentation__announcement')?.hidden,
      replay: !el.querySelector('.goal-presentation__replay')?.hidden,
      youScored: (el.querySelector('.goal-presentation__goal-graphic')?.src ?? '').includes('goal-you-scored'),
    };
  });
  const goalState = () => page.evaluate(() => window.rocketArenaPresentation.goalState());
  const matchDebug = () => page.evaluate(() => window.rocketArenaPresentation.replayDebug());

  // Blue (the bot team, default roster) scores through the real offline pipeline.
  await page.evaluate(() => window.rocketArenaPresentation.forceGoal(0));
  await until(async () => (await presentation()).active, 20000, 'presentation begins');
  check('offline match: celebration begins (rival goal)', (await presentation()).announcement, JSON.stringify(await presentation()));
  check('offline match: no "you scored" graphic for a rival goal', !(await presentation()).youScored);
  await until(async () => (await goalState()).replaying, 60000, 'replay starts');
  check('offline match: replay starts from the scorer viewpoint', (await presentation()).replay);
  await until(async () => !(await presentation()).active, 120000, 'presentation ends naturally');
  await delay(2000);
  const debug = await matchDebug();
  check('offline match: back to kickoff after the presentation', debug.phase === 'kickoff', JSON.stringify(debug));
  const score = await page.evaluate(() => ({
    blue: document.querySelector('[data-match="blue-score"]')?.textContent,
    orange: document.querySelector('[data-match="orange-score"]')?.textContent,
  }));
  check("offline match: blue (bot) scored", score.blue === "1", JSON.stringify(score));
  check('offline match: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  failures++;
  console.log('HARNESS ERROR:', String(error).slice(0, 400));
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await browser.close().catch(() => {});
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
