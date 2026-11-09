// Two-browser P2P join-robustness verification. The reported bug: the join
// gets stuck showing only "Player connecting…" and the guest never gets in.
// Three root causes are exercised end to end against the real PeerJS cloud:
//
//   1. Signaling drop: the host's room ID unregisters (nobody can join).
//      Fixed by auto re-registration via peer.reconnect().
//   2. A failed negotiation round: the guest used to give up after ONE 15 s
//      attempt. Fixed by retrying the whole round on a fresh peer (fresh ICE).
//   3. A zombie connection that never says hello: the host stayed on
//      "Player connecting…" FOREVER. Fixed by the hello timeout + pre-hello
//      close status reset.
//
// Every case ends with a REAL join + match start, proving the room was never
// wedged. Headless SwiftShader renders slowly, so waits are state-driven.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const out = 'evidence/join-robustness';
await mkdir(out, { recursive: true });
const PORT = '4213';
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
const peerState = page => page.evaluate(() => window.rocketArenaP2P?.peerState?.() ?? null);
const rosterRows = page => page.evaluate(() => document.querySelectorAll('.online-private-roster p').length);

async function newPlayer(name) {
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  track(page);
  await page.addInitScript(n => {
    localStorage.setItem('rocket-arena.local-display.v3', JSON.stringify({ carVisual: 'octane-original' }));
    localStorage.setItem('arena.p2p.name', n);
  }, name);
  await page.goto(`http://127.0.0.1:${PORT}/?physicsDebug=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.arena-home:not([hidden])').waitFor();
  await page.locator('[data-home="play"]').click();
  await page.locator('[data-home="casual"]').click();
  await page.locator('.online-dialog:not([hidden])').waitFor({ timeout: 20000 });
  return page;
}

async function createRoom(host) {
  await host.locator('[data-p2p="create"]').click();
  await delay(6000);
  return (await host.locator('[data-room-code]').textContent()).trim();
}

async function joinAndStart(host, guest, code, label) {
  await guest.locator('[name="roomCode"]').fill(code);
  await guest.locator('[data-p2p="join"]').click();
  await until(async () => (await status(guest)).includes('In the lobby'), 45000, `${label}: guest lobby`);
  // The host's "joined" status is transient (the guest's ready signal
  // replaces it within ~300 ms), so assert on the durable roster instead.
  await until(async () => (await rosterRows(host)) >= 2, 30000, `${label}: host roster has 2 cars (host status: ${await status(host)})`);
  await host.locator('[data-p2p="start"]').click({ timeout: 30000 });
  await until(async () => (await phase(host)) === 'playing', 90000, `${label}: host playing`);
  await until(async () => (await phase(guest)) === 'playing', 90000, `${label}: guest playing`);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

try {
  // ------------------------------------------- case 1: signaling drop --------
  // The host's signaling socket dies (server blip). Without re-registration
  // the room ID is gone and no guest can ever find the room again.
  {
    console.log('\n== case 1: host signaling drop -> room re-registers, join still works ==');
    const host = await newPlayer('HostOne');
    const guest = await newPlayer('GuestOne');
    const code = await createRoom(host);
    console.log('room code:', code);

    let state = await peerState(host);
    check('c1: peer registered before the drop', !!state?.open && state?.code === code, JSON.stringify(state));
    const dropped = await host.evaluate(() => window.rocketArenaP2P.dropSignaling());
    // The auto re-register fires immediately, so by the time we read state it
    // may already be mid-reconnect or even open again — the durable proof is
    // the next check (same code, registered again).
    state = await peerState(host);
    check('c1: signaling dropped', dropped === true && !state?.destroyed, JSON.stringify(state));

    await until(async () => (await peerState(host))?.open === true, 25000, 'c1: signaling re-registered');
    state = await peerState(host);
    check('c1: room ID re-registered with the same code', state?.code === code && !!state?.roomReady, JSON.stringify(state));
    await host.screenshot({ path: `${out}/01-host-reregistered.png` });

    await joinAndStart(host, guest, code, 'c1');
    check('c1: guest joined and the match started after a signaling drop', true, `host=${await status(host)}`);
    await guest.close(); await host.close();
  }

  // ---------------------------------------- case 2: failed first round -------
  // The first negotiation round fails (createOffer rejected = ICE/negotiation
  // error). The join must retry on a fresh peer and succeed instead of
  // bouncing the player back to the lobby after one 15 s attempt.
  {
    console.log('\n== case 2: failed first negotiation round -> guest retries and gets in ==');
    const host = await newPlayer('HostTwo');
    const guest = await newPlayer('GuestTwo');
    const code = await createRoom(host);
    console.log('room code:', code);

    // Break the FIRST createOffer only (the PeerJS constructor feature probe
    // uses createDataChannel, not createOffer, so this hits the real round).
    await guest.evaluate(() => {
      const orig = RTCPeerConnection.prototype.createOffer;
      let calls = 0;
      RTCPeerConnection.prototype.createOffer = function (...args) {
        if (calls++ === 0) return Promise.reject(new Error('simulated negotiation failure'));
        return orig.apply(this, args);
      };
    });
    const seen = [];
    const recorder = setInterval(async () => { try { seen.push(await status(guest)); } catch {} }, 200);

    await guest.locator('[name="roomCode"]').fill(code);
    await guest.locator('[data-p2p="join"]').click();
    await until(async () => (await status(guest)).includes('In the lobby'), 60000, 'c2: guest lobby');
    clearInterval(recorder);
    check('c2: guest saw the automatic retry', seen.some(s => s.includes('retrying (2/3)')), seen.filter(s => s.includes('retry')).at(-1) ?? 'no retry status captured');
    check('c2: guest reached the lobby after the retry', (await status(guest)).includes('In the lobby'));
    await guest.screenshot({ path: `${out}/02-guest-retried-into-lobby.png` });

    await until(async () => (await rosterRows(host)) >= 2, 30000, `c2: host roster has 2 cars (host status: ${await status(host)})`);
    await host.locator('[data-p2p="start"]').click({ timeout: 30000 });
    await until(async () => (await phase(host)) === 'playing', 90000, 'c2: host playing');
    await until(async () => (await phase(guest)) === 'playing', 90000, 'c2: guest playing');
    check('c2: match started through the retried link', true);
    await guest.close(); await host.close();
  }

  // ------------------------------------------ case 3: zombie connection ------
  // A raw PeerJS client connects to the room and never sends hello. The host
  // must show "Player connecting…", drop the zombie after the hello timeout,
  // reset its status on its own, and still accept a real guest afterwards.
  {
    console.log('\n== case 3: zombie connection -> host un-sticks itself, room still joinable ==');
    const host = await newPlayer('HostThree');
    const guest = await newPlayer('GuestThree');
    const code = await createRoom(host);
    console.log('room code:', code);

    const zombie = await context.newPage();
    track(zombie);
    await zombie.goto(`http://127.0.0.1:${PORT}/zombie-probe`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await zombie.evaluate(c => {
      window.__zombie = { open: false, closed: false };
      import('/src/vendor/peerjs.mjs').then(({ Peer }) => {
        const peer = new Peer(undefined, { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
        peer.on('open', () => {
          const conn = peer.connect('ra1-v1-' + c, { reliable: false });
          conn.on('open', () => { window.__zombie.open = true; }); // deliberately never says hello
          conn.on('close', () => { window.__zombie.closed = true; });
          conn.on('error', () => {});
        });
        peer.on('error', () => {});
      });
    }, code);
    await until(async () => zombie.evaluate(() => window.__zombie?.open === true), 30000, 'c3: zombie channel open');
    await until(async () => (await status(host)).includes('Player connecting'), 15000, 'c3: host shows Player connecting');
    check('c3: host entered the Player connecting state', true, await status(host));

    // HELLO_TIMEOUT (20 s) + slack: the host must drop the zombie on its own.
    await until(async () => {
      const text = await status(host);
      return !text.includes('Player connecting') && text.includes('could not finish connecting');
    }, 30000, 'c3: hello timeout dropped the zombie');
    check('c3: zombie dropped and status reset by itself', true, await status(host));
    await host.screenshot({ path: `${out}/03-host-zombie-dropped.png` });

    await joinAndStart(host, guest, code, 'c3');
    check('c3: real guest joined after the zombie was dropped', true, `host=${await status(host)}`);
    await zombie.close(); await guest.close(); await host.close();
  }

  check('no page errors across all cases', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (error) {
  failures++;
  console.error('HARNESS ERROR:', error);
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\nJOIN ROBUSTNESS PASS' : `\nJOIN ROBUSTNESS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
