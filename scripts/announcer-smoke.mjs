// Announcer browser smoke: boot the real game, verify the new clips are
// served and every announcer kind shows its banner (visual + audio path).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = '4175';
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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.setDefaultTimeout(90000);
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.arena-home:not([hidden])').waitFor();
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="freeplay"]').click();
await page.waitForFunction(() => window.rocketArenaPresentation, null, { timeout: 60000 });
await delay(2500);

// 1) Every announcer clip (including the two new ones) is served.
const clipStatus = await page.evaluate(async () => {
  const files = ['goal.mp3', 'nice-shot.mp3', 'shot-on-goal.mp3', 'what-a-save.mp3',
    'epic-save.mp3', 'great-pass.mp3', 'what-a-play.mp3', 'demolition.mp3', 'victory.mp3', 'defeat.mp3'];
  const out = {};
  for (const f of files) out[f] = (await fetch(`/assets/audio/announcer/${f}`)).status;
  return out;
});
console.log('clip fetch status:', clipStatus);

// 2) Banner shows for every announcer kind.
const kinds = [
  ['shot-on-goal', 'SHOT ON GOAL!'],
  ['demolition', 'DEMOLITION!'],
  ['what-a-save', 'WHAT A SAVE!'],
  ['epic-save', 'EPIC SAVE!'],
  ['nice-shot', 'NICE SHOT!'],
  ['great-pass', 'GREAT PASS!'],
];
const bannerResults = {};
for (const [kind, text] of kinds) {
  await page.evaluate(k => window.rocketArenaPresentation.say(k), kind);
  const banner = await page.evaluate(() => {
    const el = document.querySelector('.announcer-banner');
    return el && !el.hidden ? el.textContent : null;
  });
  bannerResults[kind] = banner;
  await delay(400);
}
console.log('banners:', bannerResults);

const failures = [
  ...Object.entries(clipStatus).filter(([, status]) => status !== 200).map(([f, s]) => `clip ${f} -> ${s}`),
  ...Object.entries(bannerResults).filter(([, text]) => text === null).map(([k]) => `banner ${k} missing`),
  ...errors.map(e => `pageerror: ${e}`),
];
console.log(failures.length === 0 ? '\nANNOUNCER SMOKE: ALL PASS' : `\nANNOUNCER SMOKE FAILURES:\n${failures.join('\n')}`);

await browser.close();
server.kill();
await Promise.race([once(server, 'exit'), delay(3000)]);
process.exit(failures.length === 0 ? 0 : 1);
