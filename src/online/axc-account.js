// axc SSO account system — one account for every axc page
// (https://axcgamestudios.github.io/axcStudios/).
//
// The system ships two classic scripts that expose window.AXC (accounts on
// the shared textdb.dev server) and window.AXC_UI (auth modal, chip, toasts).
// They are loaded OFF the critical path: a hanging CDN request must never
// delay the boot/loading screen, so the scripts are injected dynamically
// (CDN first, then the same-origin copies shipped in /assets/axc/ when the
// network is unreachable). Every consumer degrades gracefully — without the
// system the game keeps its plain display-name flow.
//
// Account names become the in-game identity: the P2P display name locks to
// the signed-in username, and the home/pause player cards mirror it.

const CDN_AUTH = 'https://axcgamestudios.github.io/axcStudios/axc-auth.js';
const CDN_UI = 'https://axcgamestudios.github.io/axcStudios/axc-ui.js';
const LOCAL_AUTH = '/assets/axc/axc-auth.js';
const LOCAL_UI = '/assets/axc/axc-ui.js';
const NAME_KEY = 'arena.p2p.name';

let bootPromise = null;
let user = null;
const authListeners = new Set();
const presenceListeners = new Set();
const statusListeners = new Set();

function libraries() {
  return window.AXC && window.AXC_UI ? { AXC: window.AXC, UI: window.AXC_UI } : null;
}

function loadScript(src) {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.addEventListener('load', () => resolve(true), { once: true });
    script.addEventListener('error', () => { script.remove(); resolve(false); }, { once: true });
    document.head.append(script);
  });
}

async function loadLibraries() {
  // axc-ui captures window.AXC while it executes, so the order is fixed:
  // the auth core first, the interface second.
  if (!window.AXC) await loadScript(CDN_AUTH);
  if (!window.AXC) await loadScript(LOCAL_AUTH);
  if (!window.AXC) return null;
  if (!window.AXC_UI) await loadScript(CDN_UI);
  if (!window.AXC_UI) await loadScript(LOCAL_UI);
  return libraries();
}

function emitAuth(next) {
  user = next?.u ? { u: next.u, m: next.m ?? null } : null;
  // Keep the offline flow in sync: the last account name survives sign-out
  // as the local display name (pause card, home card, next session).
  if (user) { try { localStorage.setItem(NAME_KEY, user.u); } catch {} }
  for (const listener of authListeners) { try { listener(user); } catch {} }
}

/** Boots the account system exactly once. Resolves with the user (or null). */
export function initAxAccount() {
  bootPromise ??= (async () => {
    if (typeof window === 'undefined') return null;
    const loaded = await loadLibraries();
    if (!loaded) return null;
    const { AXC, UI } = loaded;
    AXC.on('auth', emitAuth);
    AXC.on('presence', count => { for (const listener of presenceListeners) { try { listener(count); } catch {} } });
    AXC.on('status', state => { for (const listener of statusListeners) { try { listener(state); } catch {} } });
    try { await UI.init({}); } catch { try { await AXC.init(); } catch {} }
    if (AXC.state?.user) user = { u: AXC.state.user.u, m: AXC.state.user.m ?? null };
    installModalKeyShield();
    return user;
  })();
  return bootPromise;
}

// While an axc modal is open it owns the keyboard. Keys aimed at the game
// (focus stuck on a menu button or the body) never reach the game's own
// window-level handlers, and Escape closes the modal itself — the dialogs
// underneath must not react. Keys aimed INSIDE the modal travel untouched so
// its inputs, tabs and Enter-to-submit keep working; a flag tells the game
// that the in-flight keydown belongs to the modal even after it closes.
let modalOwnsKey = false;
function installModalKeyShield() {
  document.addEventListener('keydown', event => {
    modalOwnsKey = false;
    const modal = document.querySelector('.axcui-root.open');
    if (!modal) return;
    if (modal.contains(event.target)) {
      modalOwnsKey = event.key === 'Escape'; // axc closes itself on this one
      return;
    }
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      modalOwnsKey = true;
      closeModal();
    } else if (event.key === 'Tab') event.preventDefault();
    else modalOwnsKey = true;
  }, true);
}
function closeModal() {
  const UI = window.AXC_UI;
  if (!UI) return;
  try {
    if (document.getElementById('axc-auth-modal')?.classList.contains('open')) UI.closeAuth();
    else if (document.getElementById('axc-install-modal')?.classList.contains('open')) UI.closeInstall();
  } catch {}
}

/** True when the in-flight keydown belongs to an open axc modal. */
export function axcModalOwnsKeys() { return modalOwnsKey; }

/** True once both libraries are loaded (the system is usable). */
export function axcReady() { return !!libraries(); }

/** Signed-in account: { u, m } or null. */
export function axcAccount() {
  const AXC = window.AXC;
  const current = AXC?.state?.user ?? user;
  return current?.u ? { u: current.u, m: current.m ?? null } : null;
}

/** Signed-in username, or null. */
export function axcName() { return axcAccount()?.u ?? null; }

/** In-game player name: the account name wins, else the saved local name. */
export function accountPlayerName() {
  return axcName() ?? (() => { try { return localStorage.getItem(NAME_KEY) || null; } catch { return null; } })();
}

/** Subscribes to sign-in/out; fires immediately with the current state. */
export function onAxAuth(listener) {
  authListeners.add(listener);
  try { listener(user); } catch {}
  return () => authListeners.delete(listener);
}

/** Subscribes to axc network presence updates ("N online"). */
export function onAxPresence(listener) { presenceListeners.add(listener); return () => presenceListeners.delete(listener); }

/** Subscribes to axc network status ({ ws: 'off'|'connecting'|'online', … }). */
export function onAxStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); }

/** Live network state: presence count plus WebSocket status. */
export function axcNetwork() {
  const AXC = window.AXC;
  return { presence: AXC?.state?.presence ?? 0, ws: AXC?.state?.ws ?? 'off' };
}

/** Opens the account modal ('login' or 'signup'). False when unavailable. */
export function axcOpenAuth(mode = 'login') {
  const loaded = libraries();
  if (!loaded) return false;
  try { loaded.UI.openAuth(mode); return true; } catch { return false; }
}

/** Mounts the account chip (sign-in button / avatar + menu) into an element. */
export function mountAxChip(element) {
  const loaded = libraries();
  if (!loaded || !element) return false;
  try { loaded.UI.mountChip(element); return true; } catch { return false; }
}

/** True while any axc modal (auth/install/player) is open on this page. */
export function axcModalOpen() { return !!document.querySelector('.axcui-root.open'); }
