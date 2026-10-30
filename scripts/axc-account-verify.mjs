// End-to-end verification of the axc SSO account integration against the
// built dist/: the account chip in the home screen, the auth modal (with the
// Escape gate that keeps the game dialogs underneath open), the display-name
// lock inside the P2P dialog, and full graceful degradation when the system
// cannot load at all. The axc libraries resolve to the copies shipped with
// the game; the account server and network stay hermetic.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = '4183';
const serve = join(import.meta.dirname, '../tools/serve.mjs');
const server = spawn(process.execPath, [serve], {
  env: { ...process.env, PORT, ROCKET_ARENA_LIVE_RELOAD: '0', ROCKET_ARENA_DIST: '1' }, stdio: 'ignore',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 30000) {
  const start = performance.now();
  while (!(await fn())) { if (performance.now() - start > timeout) throw new Error('timed out'); await delay(120); }
}
await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } });
await mkdir('evidence/axc-account', { recursive: true });

const browser = await chromium.launch({
  executablePath: '/home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const axcAuth = await readFile(join(import.meta.dirname, '../public/assets/axc/axc-auth.js'), 'utf8');
const axcUi = await readFile(join(import.meta.dirname, '../public/assets/axc/axc-ui.js'), 'utf8');
const results = {};
const failures = [];
const check = (name, ok, extra = '') => {
  results[name] = ok;
  if (!ok) failures.push(`${name}${extra ? ` (${extra})` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

// ---------------------------------------------------------------- system up --
{
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await context.route('**/axcStudios/axc-auth.js', route => route.fulfill({ contentType: 'application/javascript', body: axcAuth }));
  await context.route('**/axcStudios/axc-ui.js', route => route.fulfill({ contentType: 'application/javascript', body: axcUi }));
  await context.route('**textdb.dev/**', route => route.fulfill({ contentType: 'text/plain', body: '' }));
  await context.route('**ntfy.sh/**', route => route.fulfill({ contentType: 'text/plain', body: '' }));
  await context.route('**formsubmit.co/**', route => route.fulfill({ contentType: 'text/plain', body: '' }));
  try { await context.routeWebSocket(/wsn-c6o3/, ws => { try { ws.close(); } catch {} }); } catch {}
  await context.addInitScript(() => {
    localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
      qualityPreset: 'potato', renderScale: .25, showStadium: false, limitFps: true, maxFps: 30,
    }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();

  // 1. The account chip mounts in the home header corner.
  await page.locator('.arena-home__account .axcui-chip').waitFor({ timeout: 20000 });
  const chipGuest = await page.locator('.arena-home__account .axcui-chip').textContent();
  check('chip mounted (signed out)', /iniciar sesi/i.test(chipGuest ?? ''), chipGuest ?? '');
  await page.screenshot({ path: 'evidence/axc-account/home-guest.png' });

  // 2. The chip opens the shared auth modal; Escape closes only the modal.
  await page.locator('.arena-home__account .axcui-chip').click();
  await page.locator('#axc-auth-modal.open').waitFor();
  check('auth modal opens from chip', true);
  await page.screenshot({ path: 'evidence/axc-account/auth-modal.png' });
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#axc-auth-modal.open').count()));
  const homeStillOpen = await page.locator('.arena-home:not([hidden])').count();
  check('Escape closes modal, keeps game home open', homeStillOpen === 1);

  // 3. Sign-in state: chip avatar + username, player card and saved name.
  await page.evaluate(() => {
    window.AXC.state.user = { u: 'rocket_fan', m: 'fan@axc.st' };
    window.AXC.emit('auth', window.AXC.state.user);
  });
  await until(async () => /rocket_fan/i.test((await page.locator('.arena-home__account .axcui-chip').textContent()) ?? ''));
  const cardName = await page.locator('[data-home-player]').textContent();
  check('player card shows account name', cardName === 'ROCKET_FAN', cardName ?? '');
  const savedName = await page.evaluate(() => localStorage.getItem('arena.p2p.name'));
  check('account name persists locally', savedName === 'rocket_fan', String(savedName));
  await page.screenshot({ path: 'evidence/axc-account/home-signed-in.png' });

  // 4. P2P dialog: the display name locks to the account identity.
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="casual"]').click();
  await page.locator('.online-panel:not([hidden])').waitFor();
  const nameState = await page.evaluate(() => {
    const input = document.querySelector('.online-panel [name="displayName"]');
    const row = document.querySelector('.online-panel [data-p2p="account"]');
    const identity = document.querySelector('.online-panel [data-p2p-identity]');
    return { value: input?.value, disabled: input?.disabled, row: row?.textContent, identity: identity?.textContent };
  });
  check('p2p name locked to account', nameState.value === 'rocket_fan' && nameState.disabled === true, JSON.stringify(nameState));
  check('p2p account row shows username', /rocket_fan/i.test(nameState.row ?? ''), nameState.row ?? '');
  check('p2p identity reflects sign-in', /signed in/i.test(nameState.identity ?? ''), nameState.identity ?? '');

  // 5. The P2P account button opens the modal; Escape must not close the
  //    room dialog underneath it (the game's Escape path stays gated).
  await page.locator('[data-p2p="account"]').click();
  await page.locator('#axc-auth-modal.open').waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await page.locator('#axc-auth-modal.open').count()));
  const p2pStillOpen = await page.locator('.online-panel:not([hidden])').count();
  check('Escape keeps p2p dialog open under modal', p2pStillOpen === 1);
  await page.screenshot({ path: 'evidence/axc-account/p2p-signed-in.png' });

  // 6. Sign-out restores the free guest name flow.
  await page.evaluate(() => { window.AXC.state.user = null; window.AXC.emit('auth', null); });
  await until(async () => !(await page.evaluate(() => document.querySelector('.online-panel [name="displayName"]')?.disabled)));
  const guestState = await page.evaluate(() => {
    const input = document.querySelector('.online-panel [name="displayName"]');
    const row = document.querySelector('.online-panel [data-p2p="account"]');
    return { disabled: input?.disabled, row: row?.textContent };
  });
  check('sign-out unlocks guest name', guestState.disabled === false, JSON.stringify(guestState));
  check('account row back to sign-in', /sign in/i.test(guestState.row ?? ''), guestState.row ?? '');

  check('no page errors (system up)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

// ------------------------------------------------------------ degradation --
{
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  // Neither the CDN nor the shipped fallback can load: the system is absent.
  await context.route('**/axcStudios/**', route => route.abort());
  await context.route('**/assets/axc/**', route => route.abort());
  await context.addInitScript(() => {
    localStorage.setItem('rocket-arena.local-graphics-presets.v1', JSON.stringify({
      qualityPreset: 'potato', renderScale: .25, showStadium: false, limitFps: true, maxFps: 30,
    }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();
  await delay(1500); // let the failed loads settle
  const chipCount = await page.locator('.arena-home__account .axcui-chip').count();
  check('degraded boot has no chip', chipCount === 0);
  const cardName = await page.locator('[data-home-player]').textContent();
  check('degraded player card falls back', cardName === 'PLAYER', cardName ?? '');
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="casual"]').click();
  await page.locator('.online-panel:not([hidden])').waitFor();
  const degraded = await page.evaluate(() => {
    const input = document.querySelector('.online-panel [name="displayName"]');
    const row = document.querySelector('.online-panel [data-p2p="account"]');
    return { disabled: input?.disabled, rowHidden: row?.hidden, typed: (input.value = 'guest_name', input.value) };
  });
  check('degraded p2p keeps free name flow', degraded.disabled === false && degraded.rowHidden === true, JSON.stringify(degraded));
  await page.screenshot({ path: 'evidence/axc-account/degraded-p2p.png' });
  check('no page errors (degraded)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await context.close();
}

await browser.close();
server.kill();
await delay(300);
console.log(failures.length ? `\nAXC ACCOUNT VERIFY FAILED (${failures.length})` : '\nAXC ACCOUNT VERIFY PASSED');
process.exit(failures.length ? 1 : 0);
