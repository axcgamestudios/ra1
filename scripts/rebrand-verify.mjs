// "Rocket Ball" rebrand verification: every user-facing surface (page title,
// boot wordmark, home brand, PWA manifest, multiplayer header, loading photo
// URL) says Rocket Ball, the fake registered-trademark claim and its (R) mark
// are gone, no DOM text mentions Rocket League, and the reserved display-name
// list covers the new brand via the real protocol module.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { validName } from '../src/online/protocol.js';

const out = 'evidence/rebrand';
await mkdir(out, { recursive: true });
const PORT = '4197';
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
const isKnownSwiftShaderCarError = text => /Fennec_Chassis|texture2DCompare|array index for samplers/.test(text);
const isNetworkNoise = text => /peer|websocket|network|fetch|ERR_|socket|signaling/i.test(text);

const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.setDefaultTimeout(150000);
const errors = [];
const notFound = [];
page.on('response', r => { if (r.status() >= 400) notFound.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', e => { if (!isKnownSwiftShaderCarError(String(e)) && !isNetworkNoise(String(e))) errors.push(String(e).slice(0, 300)); });
page.on('console', m => { if (m.type() === 'error' && !isKnownSwiftShaderCarError(m.text()) && !isNetworkNoise(m.text())) errors.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

// 1) Boot screen branding, straight from the served HTML.
const bootFacts = await page.evaluate(() => {
  const title = document.querySelector('.load__title');
  const legal = document.querySelector('.load__legal');
  return {
    docTitle: document.title,
    wordmark: title ? title.textContent.replace(/\s+/g, ' ').trim() : null,
    regMark: Boolean(document.querySelector('.load__reg')),
    legalText: legal ? legal.textContent.replace(/\s+/g, ' ').trim() : null,
    loadingBg: getComputedStyle(document.querySelector('#loading')).backgroundImage,
    loadingBgBefore: getComputedStyle(document.querySelector('#loading'), '::before').backgroundImage,
    manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
  };
});
console.log('BOOT facts:', JSON.stringify(bootFacts, null, 2));
await delay(800);
await page.screenshot({ path: `${out}/boot.png`, timeout: 140000 });

// 2) Home screen brand (the boot gate auto-advances under Playwright).
await page.locator('.arena-home:not([hidden])').waitFor();
const homeFacts = await page.evaluate(() => ({
  brand: document.querySelector('.arcade-brand')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  homeAria: document.querySelector('.arena-home')?.getAttribute('aria-label') ?? null,
}));
console.log('HOME facts:', JSON.stringify(homeFacts));
await delay(400);
await page.screenshot({ path: `${out}/home.png`, timeout: 140000 });

// 3) Multiplayer screen eyebrow + help copy.
await page.locator('[data-home="play"]').click();
await page.locator('[data-home="casual"]').click();
await page.locator('.online-eyebrow').waitFor({ timeout: 20000 });
const p2pFacts = await page.evaluate(() => ({
  eyebrow: document.querySelector('.online-eyebrow')?.textContent.trim() ?? null,
  help: document.querySelector('.online-account-help')?.textContent ?? '',
}));
console.log('P2P eyebrow:', JSON.stringify(p2pFacts.eyebrow));
await page.locator('[data-p2p="back"]').click();
await delay(300);

// 4) Whole-document sweep: no Rocket League anywhere in the live DOM.
const domSweep = await page.evaluate(() => {
  const re = /rocket[ _-]?league/i;
  return {
    outerHTML: re.test(document.documentElement.outerHTML),
    innerText: re.test(document.body.innerText),
    title: re.test(document.title),
  };
});

// 5) PWA manifest + renamed promo asset over HTTP (Node side so the deliberate
//    404 probe of the old name never surfaces as a browser console error).
const httpFacts = {
  manifestName: null,
  manifestShortName: null,
  newPromoStatus: null,
  oldPromoStatus: null,
};
{
  const manifest = await (await fetch(`http://127.0.0.1:${PORT}/src/rocket-arena.webmanifest`)).json();
  httpFacts.manifestName = manifest.name;
  httpFacts.manifestShortName = manifest.short_name;
  httpFacts.newPromoStatus = (await fetch(`http://127.0.0.1:${PORT}/assets/ui/rocket-ball-promo.webp`)).status;
  httpFacts.oldPromoStatus = (await fetch(`http://127.0.0.1:${PORT}/assets/ui/rocket-league-promo.webp`)).status;
}
console.log('HTTP facts:', JSON.stringify(httpFacts));
console.log('page 404s:', notFound.length ? notFound.join(', ') : '(none)');

// 6) Reserved display names cover the new brand (real module, Node side).
const reserved = {
  'rocket ball': validName('rocket ball'),
  'RocketBall': validName('RocketBall'),
  'rocket-ball': validName('rocket-ball'),
  'Rocket Ball 7': validName('Rocket Ball 7'),
  baller: validName('baller'),
  player1: validName('player1'),
};
console.log('reserved names:', JSON.stringify(reserved));

await browser.close();
server.kill();

const failure = [];
if (bootFacts.docTitle !== 'Rocket Ball') failure.push(`document.title: ${bootFacts.docTitle}`);
if (bootFacts.wordmark !== 'ROCKET BALL') failure.push(`boot wordmark: ${bootFacts.wordmark}`);
if (bootFacts.regMark) failure.push('registered-trademark <sup> still present');
if (!/Fan-made tribute/.test(bootFacts.legalText ?? '')) failure.push(`legal footer: ${bootFacts.legalText}`);
if (/rocket[ _-]?league/i.test(bootFacts.legalText ?? '')) failure.push('legal footer mentions Rocket League');
if (!/rocket-ball-promo\.webp/.test(bootFacts.loadingBg)) failure.push(`#loading background: ${bootFacts.loadingBg}`);
if (!/rocket-ball-promo\.webp/.test(bootFacts.loadingBgBefore)) failure.push('#loading::before background missing new promo');
if (homeFacts.brand !== 'ROCKET BALL') failure.push(`home brand: ${homeFacts.brand}`);
if (homeFacts.homeAria !== 'Rocket Ball home') failure.push(`home aria-label: ${homeFacts.homeAria}`);
if (p2pFacts.eyebrow !== 'ROCKET BALL · PEER-TO-PEER') failure.push(`p2p eyebrow: ${p2pFacts.eyebrow}`);
if (!/Controls match Rocket Ball:/.test(p2pFacts.help)) failure.push('p2p help copy missing Rocket Ball');
if (domSweep.outerHTML || domSweep.innerText || domSweep.title) failure.push(`DOM sweep hit: ${JSON.stringify(domSweep)}`);
if (httpFacts.manifestName !== 'Rocket Ball') failure.push(`manifest name: ${httpFacts.manifestName}`);
if (httpFacts.manifestShortName !== 'Rocket Ball') failure.push(`manifest short_name: ${httpFacts.manifestShortName}`);
if (httpFacts.newPromoStatus !== 200) failure.push(`new promo asset status: ${httpFacts.newPromoStatus}`);
if (httpFacts.oldPromoStatus !== 404) failure.push(`old promo asset still served: ${httpFacts.oldPromoStatus}`);
if (reserved['rocket ball'] || reserved.RocketBall || reserved['rocket-ball'] || reserved['Rocket Ball 7']) failure.push('brand name not reserved');
if (!reserved.baller || !reserved.player1) failure.push('ordinary names rejected');
if (errors.length) failure.push(`page errors: ${errors[0]}`);
if (notFound.length) failure.push(`page 404s: ${notFound.join(', ')}`);
console.log(failure.length ? `FAIL: ${failure.join('; ')}` : 'REBRAND PASS');
process.exit(failure.length ? 1 : 0);
