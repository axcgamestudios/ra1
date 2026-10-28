// A small menu above the frozen arena; simulation ownership stays with the game.
// Rocket League pause layout: PAUSED title, five stacked menu rows (RESUME GAME
// first, highlighted), a contextual hint top-left ("PRESS BACKSPACE TO RESET
// BALL" in free play) and the player card with CREATE PARTY bottom-left.
import { Ks } from '../input/controller-selection.js';
import { playerLevel } from '../core/player-progress.js';
import { accountPlayerName, onAxAuth, axcModalOpen } from '../online/axc-account.js';

const MENU_ROWS = [
  ['resume', 'RESUME GAME'],
  ['training', 'CHANGE TRAINING'],
  ['online', 'FIND ONLINE MATCH'],
  ['settings', 'OPTIONS'],
  ['home', 'EXIT TO MAIN MENU'],
];

export function mountPauseMenu(root, actions) {
  const panel = document.createElement('section');
  panel.className = 'arena-pause';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'arena-pause-title');
  panel.innerHTML = `
    <p class="arena-pause__hint" data-pause-hint hidden>PRESS BACKSPACE TO RESET BALL</p>
    <div class="arena-pause__menu">
      <h2 id="arena-pause-title">PAUSED</h2>
      <nav aria-label="Pause menu">
        ${MENU_ROWS.map(([key, label]) => `<button type="button" data-pause="${key}">${label}</button>`).join('')}
      </nav>
    </div>
    <footer class="arena-pause__player">
      <span class="arena-pause__avatar" data-pause-avatar aria-hidden="true">P</span>
      <span class="arena-pause__id">
        <b class="arena-pause__name" data-pause-name>PLAYER</b>
        <i class="arena-pause__level" data-pause-level>LVL 1</i>
      </span>
      <button type="button" class="arena-pause__party" data-pause="party">
        <svg viewBox="0 0 20 14" aria-hidden="true"><circle cx="6.5" cy="4.5" r="3.2"/><path d="M1 13.2c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M13.6 4.2a3 3 0 0 1 0 5.9M15.2 12.9c0-1.9-.6-3.3-1.7-4.3"/></svg>
        CREATE PARTY
      </button>
    </footer>`;
  root.append(panel);
  const buttons = [...panel.querySelectorAll('[data-pause]')];
  const hint = panel.querySelector('[data-pause-hint]');
  let open = false, poll = 0, previousConfirm = false, previousCancel = false, previousDirection = 0;
  const activePad = () => Ks();
  const directionOf = pad => pad?.buttons[12]?.pressed || (pad?.axes[1] ?? 0) < -0.55 ? -1 : pad?.buttons[13]?.pressed || (pad?.axes[1] ?? 0) > 0.55 ? 1 : 0;
  // The hint and the two session rows follow the live game state, RL style:
  // free play shows the ball-reset hint, online sessions hide the rows that
  // would restart or replace the current match.
  function syncState() {
    const state = actions.state?.() ?? {};
    hint.hidden = state.mode !== 'freeplay';
    panel.querySelector('[data-pause="training"]')?.toggleAttribute('hidden', !!state.online);
    panel.querySelector('[data-pause="online"]')?.toggleAttribute('hidden', !!state.online);
    try { panel.querySelector('[data-pause-name]').textContent = (accountPlayerName() || 'PLAYER').toUpperCase(); } catch {}
    try { panel.querySelector('[data-pause-level]').textContent = 'LVL ' + playerLevel(); } catch {}
    try {
      const name = (accountPlayerName() || 'PLAYER').trim().toUpperCase();
      panel.querySelector('[data-pause-avatar]').textContent = (name[0] || 'P');
    } catch {}
  }
  // The card mirrors the axc account name the moment a session starts.
  onAxAuth(() => { if (open) syncState(); });
  function moveFocus(direction) {
    const focusables = buttons.filter(button => !button.hidden);
    const index = focusables.indexOf(document.activeElement);
    focusables[index < 0 ? (direction < 0 ? focusables.length - 1 : 0) : (index + direction + focusables.length) % focusables.length].focus({ preventScroll: true });
  }
  function hide() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    root.classList.remove('pause-open');
    cancelAnimationFrame(poll); poll = 0;
    // document.activeElement is null when the document itself lost focus
    // (tab switch, headless window) — contains(null) throws.
    const active = document.activeElement;
    if (active instanceof Element && panel.contains(active)) active.blur();
    actions.pause(false);
  }
  function choose(action) {
    if (!open) return;
    hide();
    actions[action]?.();
  }
  function gamepad() {
    if (!open) return;
    // The axc account modal owns the input while it is open.
    if (axcModalOpen()) { previousDirection = 0; previousConfirm = previousCancel = false; poll = requestAnimationFrame(gamepad); return; }
    const pad = activePad();
    const direction = directionOf(pad);
    const confirm = !!pad?.buttons[0]?.pressed, cancel = !!pad?.buttons[1]?.pressed;
    if (direction && direction !== previousDirection) moveFocus(direction);
    previousDirection = direction;
    if (confirm && !previousConfirm) {
      const active = document.activeElement;
      const button = active instanceof Element && panel.contains(active) ? active : buttons[0];
      choose(button.dataset.pause);
    } else if (cancel && !previousCancel) choose('resume');
    previousConfirm = confirm; previousCancel = cancel;
    if (open) poll = requestAnimationFrame(gamepad);
  }
  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    syncState();
    root.classList.add('pause-open');
    actions.pause(true);
    buttons.find(button => !button.hidden)?.focus({ preventScroll: true });
    const pad = activePad();
    previousDirection = directionOf(pad);
    previousConfirm = !!pad?.buttons[0]?.pressed;
    previousCancel = !!pad?.buttons[1]?.pressed;
    poll = requestAnimationFrame(gamepad);
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-pause]');
    if (button && !button.hidden) choose(button.dataset.pause);
  });
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); choose('resume'); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveFocus(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Tab') { event.preventDefault(); moveFocus(event.shiftKey ? -1 : 1); }
  });
  // Pointer interaction with the menu must not reach gameplay input handlers.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  return { show, hide, get isOpen() { return open; } };
}
