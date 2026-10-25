// Peer-to-peer online play over WebRTC (PeerJS). GitHub Pages has no backend,
// so the dedicated-server netcode is replaced by a host-authoritative model:
// the host browser runs the deterministic WASM arena at 120 Hz and streams the
// same binary snapshots the server used to send; guests keep the existing
// client prediction and rollback reconciliation unchanged.
//
// Team matches: the host accepts up to five guests (2v2/3v3), assigns teams
// to keep them balanced, prepares the arena once on START and then feeds every
// guest the same snapshot stream. MatchEvents run on the host and the resulting
// announcer calls ("GOAL!", "What a save!") plus the stats table are broadcast
// to every guest.
import { Peer } from '../vendor/peerjs.mjs';
import { HostRoom } from './p2p-room.js';
import { Prediction } from './prediction.js';
import { MatchEvents } from '../match/match-events.js';
import { victoryContent } from '../ui/victory-screen.js';
import { controlsArray, decodeSnapshot, validName, NEUTRAL, PROTOCOL, PHYSICS_SHA256 } from './protocol.js';
import { NETWORK_CORE_SHA256 } from '../physics/network-core.js';
import { Ks } from '../input/controller-selection.js';

const ID_PREFIX = 'ra1-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 15000;
const READY_TIMEOUT = 150000;
const PING_INTERVAL = 2000;
const NAME_KEY = 'arena.p2p.name';
// Mode-aware snapshot cadence (Hz). A 6-car relayed link cannot carry 60 Hz
// snapshots; guests interpolate anyway, so lower cadence trades nothing the
// player can see for a large drop in queueing delay.
const SNAPSHOT_HZ_BY_MODE = { '1v1': 60, '2v2': 40, '3v3': 30 };
// Congestion valve threshold (SCTP bufferedAmount). 8 KB tripped on ordinary
// bursts and starved guests into prediction freezes; 32 KB only engages when
// the link is genuinely falling minutes behind on team rosters.
const CONGESTION_BYTES = 32768;
// Paint fields that travel with each player so every car wears its owner's
// garage colors instead of the viewer's local garage paint.
const PAINT_KEYS = ['primary', 'pearl', 'boostColor', 'roughness', 'metalness', 'clearcoat',
  'decal', 'decalColor', 'decalScale'];
const DECAL_CHOICES = ['none', 'stripes', 'twin', 'hex', 'camo', 'checker', 'split', 'flames', 'circuit', 'wrap'];
// Message flow version: 2 = lobby + welcome-at-START (team rosters). Clients
// with a different flow cannot understand each other's lobby messages.
const FLOW = 2;
const MODES = Object.freeze({ '1v1': 1, '2v2': 2, '3v3': 3 });
const GUEST_CAPACITY = { '1v1': 1, '2v2': 3, '3v3': 5 };

// ICE: several STUN servers first — a direct path always beats any relay. The
// PeerJS cloud TURN stays as the final fallback for hard NATs; a custom config
// REPLACES the default entirely, so those TURN entries must be repeated here.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
];
const PEER_OPTIONS = { debug: 0, config: { iceServers: ICE_SERVERS, sdpSemantics: 'unified-plan' } };

// Test-only network conditioning (?netSim=delayMs,jitterMs,lossPercent): applies
// one-way delay, jitter and loss to both sends and receives. Inactive otherwise.
const netSimRaw = new URLSearchParams(location.search).get('netSim');
const netSimValues = netSimRaw?.split(',').map(Number);
const NET_SIM = netSimValues?.length === 3 && netSimValues.every(Number.isFinite)
  ? { delay: Math.max(0, netSimValues[0] || 0), jitter: Math.max(0, netSimValues[1] || 0), loss: Math.min(0.5, Math.max(0, (netSimValues[2] || 0) / 100)) }
  : null;
function gate(task, droppable = true) {
  if (!NET_SIM) { task(); return; }
  // SCTP unordered-reliable retransmits control messages, so only loss-tolerant
  // traffic (snapshots, inputs with duplicates, pings) may be dropped here.
  if (droppable && Math.random() < NET_SIM.loss) return;
  setTimeout(task, NET_SIM.delay + Math.random() * NET_SIM.jitter);
}

const friendly = {
  peer_unavailable: 'Room not found. Check the code — rooms close when the host leaves.',
  unavailable_id: 'That room code is already taken. Generating a new one…',
  network: 'Cannot reach the PeerJS signaling server. Check your connection and retry.',
  browser_incompatible: 'This browser does not support WebRTC data channels.',
  webrtc: 'The WebRTC connection failed. Try creating the room again.',
  ssl_unavailable: 'Secure signaling is unavailable. Reload the page over HTTPS.',
  server_error: 'The signaling server is unreachable right now. Retry in a moment.'
};
function explain(error) {
  const type = String(error?.type ?? '').replaceAll('-', '_');
  return friendly[type] ?? (error?.message ? String(error.message) : 'Connection error. Retry in a moment.');
}
function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
}
function sendPayload(connection, payload) {
  if (!connection?.open) return;
  const droppable = payload instanceof ArrayBuffer || payload?.type === 'input' || payload?.type === 'ping';
  gate(() => { try { connection.send(payload); } catch { /* transient buffer full */ } }, droppable);
}
function applyControlsValues(target, values) {
  target.throttle = values[0];
  target.steer = values[1];
  target.pitch = values[2];
  target.yaw = values[3];
  target.roll = values[4];
  target.jump = !!values[5];
  target.boost = !!values[6];
  target.handbrake = !!values[7];
}
function neutralControls() {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
}
// Blue always fields first; guests fill the smaller team (ties go to blue).
function balancedTeam(roster) {
  const blue = roster.filter(player => player.team === 0).length;
  const orange = roster.filter(player => player.team === 1).length;
  return blue <= orange ? 0 : 1;
}
// {blue:{...},orange:{...}} with only the paint keys the arena applies;
// anything malformed falls back to null (the arena then uses team defaults).
function sanitizePaint(paint) {
  if (!paint || typeof paint !== 'object') return null;
  const clean = {};
  for (const team of ['blue', 'orange']) {
    const source = paint[team];
    if (!source || typeof source !== 'object') continue;
    const entry = {};
    for (const key of PAINT_KEYS) {
      if (key === 'boostColor' || key === 'primary' || key === 'pearl' || key === 'decalColor') {
        if (typeof source[key] === 'string' && /^#[0-9a-f]{6}$/i.test(source[key])) entry[key] = source[key].toLowerCase();
      } else if (key === 'decal') {
        if (DECAL_CHOICES.includes(source[key])) entry[key] = source[key];
      } else if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
        entry[key] = key === 'decalScale' ? Math.min(3, Math.max(.25, source[key])) : Math.min(1, Math.max(0, source[key]));
      }
    }
    if (entry.primary) clean[team] = entry;
  }
  return Object.keys(clean).length ? clean : null;
}

export function mountP2P(root, hooks) {
  let peer = null, room = null, prediction = null;
  let role = null, active = false, preparing = false, lastResult = null;
  let code = '', hostName = '', mode = '1v1';
  let roomReady = false, hostPrepared = false, starting = false;
  let generation = 0, lastSnapshotAt = 0, latestSnapshot = null, snapshotArrivals = [];
  let pingTimer = 0, readyTimer = 0, statsTimer = 0, poll = 0, lastNetworkDisplay = 0;
  let oldButtons = [], lastDirection = 0, roster = null, matchEvents = null, matchStats = null;
  let lobbyReadySent = false;
  // Host-side guest book: wire slot -> { conn, name, visual, ready, hello }.
  let guests = new Map();
  // Guest-side identity: wire slot of this player and the local render order.
  let selfSlot = 1, order = [1, 0];
  let guestRtt = null;
  let hostRtts = new Map();
  let readyWaiter = null;

  const panel = document.createElement('section');
  panel.className = 'online-panel sheet-overlay';
  panel.hidden = true;
  panel.innerHTML = `<div class="online-dialog" role="dialog" aria-modal="true" aria-labelledby="p2p-title">
    <header class="online-heading"><div><p class="online-eyebrow">ROCKET LEAGUE · PEER-TO-PEER</p><h1 id="p2p-title">MULTIPLAYER</h1></div><button type="button" data-p2p="back" class="online-close" aria-label="Back to Play">×</button></header>
    <p class="online-subtitle">Direct matches over WebRTC — 1v1, 2v2 or 3v3. Share a five-letter room code — no account, no game server.</p>
    <form class="online-form">
      <div class="online-account-row"><label class="online-name">DISPLAY NAME<input name="displayName" autocomplete="nickname" minlength="2" maxlength="24" value="Player" required></label><div class="online-identity">Host plays Blue · Teams auto-balance</div></div>
      <div class="online-mode-picker" role="radiogroup" aria-label="Team size">
        <span class="online-mode-label">MODE</span>
        <button type="button" data-mode="1v1" class="online-mode is-active" aria-pressed="true">1v1</button>
        <button type="button" data-mode="2v2" class="online-mode" aria-pressed="false">2v2</button>
        <button type="button" data-mode="3v3" class="online-mode" aria-pressed="false">3v3</button>
      </div>
      <p class="online-status" role="status" aria-live="polite">Create a room and share the code, or join a friend's room.</p>
      <div class="online-private-options"><button type="button" data-p2p="create" class="online-primary">CREATE ROOM</button><label class="online-name">ROOM CODE<input name="roomCode" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="5" placeholder="5-letter code"></label><button type="button" data-p2p="join">JOIN ROOM</button></div>
      <section class="online-private-lobby" hidden aria-label="Peer-to-peer room"><div class="online-invite"><span>ROOM CODE</span><output data-room-code></output><button type="button" data-p2p="copy">COPY CODE</button></div><p data-lobby-note>Peer-to-peer casual · The host runs the authoritative arena in their browser.</p><div class="online-private-roster"></div><div class="online-actions"><button type="button" data-p2p="start" class="online-primary">START MATCH</button><button type="button" data-p2p="leave-room">LEAVE ROOM</button></div></section>
      <div class="online-results" hidden></div>
      <div class="online-actions"><button type="button" data-p2p="again" class="online-primary" hidden>PLAY AGAIN</button><button type="button" data-p2p="bots">PLAY BOTS OFFLINE</button></div>
      <p class="online-account-help">All players must use the default (experimental) physics. Controls match Rocket League: W/S throttle, A/D steer, Left Click boost, Right Click jump, Shift powerslide/air roll, Space ball cam.</p>
    </form>
  </div>`;
  const hud = document.createElement('section');
  hud.className = 'online-hud';
  hud.hidden = true;
  hud.innerHTML = '<div class="online-score"><b data-score="blue">0</b><span data-clock>5:00</span><b data-score="orange">0</b></div><p class="online-banner"></p><div class="online-roster"></div><div class="online-network"></div><button type="button" data-leave>LEAVE MATCH</button>';
  root.append(panel, hud);

  const find = selector => panel.querySelector(selector), status = find('.online-status');
  const input = find('[name="displayName"]'), codeInput = find('[name="roomCode"]');
  try { input.value = localStorage.getItem(NAME_KEY) || 'Player'; } catch {}

  function show() {
    panel.hidden = false; hooks.modal(true); root.classList.add('online-menu');
    cancelAnimationFrame(poll); poll = requestAnimationFrame(gamepadPoll);
    input.focus();
  }
  function hide() { panel.hidden = true; hooks.modal(false); root.classList.remove('online-menu'); cancelAnimationFrame(poll); }
  const setStatus = text => { status.textContent = text; };

  function gamepadPoll(now) {
    if (panel.hidden) return;
    // Follow the SELECTED controller so the P2P room menus match gameplay
    // input when several gamepads are connected.
    const pad = Ks();
    if (pad) {
      const buttons = pad.buttons.map(button => button.pressed);
      const direction = buttons[13] || buttons[15] || pad.axes[1] > 0.55 || pad.axes[0] > 0.55 ? 1 : buttons[12] || buttons[14] || pad.axes[1] < -0.55 || pad.axes[0] < -0.55 ? -1 : 0;
      if (direction && now - lastDirection > 220) { moveFocus(direction); lastDirection = now; }
      if (buttons[0] && !oldButtons[0] && document.activeElement instanceof Element && panel.contains(document.activeElement)) document.activeElement.click();
      if (buttons[1] && !oldButtons[1]) back();
      oldButtons = buttons;
    }
    poll = requestAnimationFrame(gamepadPoll);
  }
  function focusables() { return [...panel.querySelectorAll('button,input')].filter(element => !element.disabled && !element.closest('[hidden]')); }
  function moveFocus(direction) { const options = focusables(); options[(options.indexOf(document.activeElement) + direction + options.length) % options.length]?.focus(); }
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); back(); }
    else if (event.key === 'Tab') { event.preventDefault(); moveFocus(event.shiftKey ? -1 : 1); }
    else if (!(event.target instanceof HTMLInputElement) && event.key.startsWith('Arrow')) { event.preventDefault(); moveFocus(['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1); }
  });

  function lobbyCapacity() { return GUEST_CAPACITY[mode] ?? 1; }
  function allGuestsReady() { return guests.size > 0 && [...guests.values()].every(entry => entry.ready); }
  function allGuestsPrepared() { return guests.size > 0 && [...guests.values()].every(entry => entry.prepared); }

  function controls() {
    find('[data-p2p="create"]').disabled = !!role || preparing;
    find('[data-p2p="join"]').disabled = !!role || preparing;
    codeInput.disabled = !!role || preparing;
    input.disabled = !!role || preparing || active;
    for (const button of panel.querySelectorAll('[data-mode]')) {
      const activeMode = !role && !lastResult;
      button.disabled = !activeMode || preparing;
      button.classList.toggle('is-active', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    find('.online-private-options').hidden = !!role || !!lastResult;
    // The host must see the room code as soon as the room exists — before the
    // guests join — otherwise there is nothing to share with friends.
    const inLobby = !lastResult && ((role === 'host' && roomReady) || (role === 'guest' && guestJoined()));
    find('.online-private-lobby').hidden = !inLobby;
    find('[data-p2p="again"]').hidden = !lastResult;
    find('[data-p2p="start"]').hidden = role !== 'host';
    find('[data-p2p="start"]').disabled = !(role === 'host' && allGuestsReady() && !starting && !room?.active && !room?.terminal);
    find('[data-p2p="leave-room"]').disabled = preparing && !role;
    if (inLobby) {
      find('[data-room-code]').textContent = code;
      find('[data-lobby-note]').textContent = role === 'host'
        ? `${mode} · ${guests.size}/${lobbyCapacity()} players joined · host runs the authoritative arena`
        : `Waiting for the host to start${mode !== '1v1' ? ` · ${mode}` : ''}`;
      const list = find('.online-private-roster'); list.replaceChildren();
      for (const player of roster ?? []) {
        const row = document.createElement('p');
        row.className = player.team === 0 ? 'blue-team' : 'orange-team';
        const side = player.team === 0 ? 'BLUE' : 'ORANGE';
        const you = player.id === 'host' || player.host ? (role === 'host' ? ' · YOU' : '') : (role === 'guest' && player.slot === selfSlot ? ' · YOU' : '');
        const ready = player.id === 'host' || player.host ? ' · READY' : (guests.get(player.slot)?.ready ? ' · READY' : ' · LOADING…');
        row.textContent = `${side} · ${player.name}${you}${ready}`;
        list.append(row);
      }
      if (role === 'host') {
        for (let extra = (roster?.length ?? 1); extra < lobbyCapacity() + 1; extra++) {
          const waiting = document.createElement('p');
          waiting.className = 'online-empty-slot';
          waiting.textContent = extra % 2 === 0 ? 'BLUE · open slot — share the code' : 'ORANGE · open slot — share the code';
          list.append(waiting);
        }
      } else if (!roster) {
        const waiting = document.createElement('p');
        waiting.className = 'blue-team';
        waiting.textContent = 'BLUE · Waiting for the host…';
        list.append(waiting);
      }
    }
  }

  async function open(focus = '') {
    lastResult = null; find('.online-results').hidden = true;
    show();
    setStatus(focus === 'host' ? 'Create a room and share the five-letter code with your friends.'
      : focus === 'join' ? 'Enter the five-letter room code shared by the host.'
      : 'Create a room and share the code, or join a friend\'s room.');
    controls();
    // Host/Join quick-entry from the home play menu: land focus on the action.
    if (focus === 'host') find('[data-p2p="create"]').focus?.();
    else if (focus === 'join') { codeInput.focus?.(); codeInput.select?.(); }
  }

  function teardownSignaling() {
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(readyTimer); readyTimer = 0;
    clearInterval(statsTimer); statsTimer = 0;
    for (const entry of guests.values()) { try { entry.conn.close(); } catch {} }
    guests.clear();
    try { conn?.close(); } catch {}
    try { peer?.destroy(); } catch {}
    conn = peer = null;
  }

  // ---------------------------------------------------------------- host ----
  function createRoom() {
    if (role || preparing) return;
    const name = playerName();
    if (!name) return;
    role = 'host'; roomReady = false; hostName = name; hostPrepared = false; starting = false;
    guests = new Map(); hostRtts = new Map();
    roster = [{ id: 'host', name, team: 0, visual: hooks.visual(), paint: sanitizePaint(hooks.paint?.()) ?? null }];
    controls(); setStatus('Creating your room on the signaling server…');
    code = generateCode();
    peer = new Peer(ID_PREFIX + code, PEER_OPTIONS);
    const attempt = ++generation;
    const createTimeout = setTimeout(() => {
      if (attempt === generation && !roomReady) {
        setStatus(explain({ type: 'network' }));
        leaveToLobby();
      }
    }, CONNECT_TIMEOUT);
    peer.on('open', () => {
      if (attempt !== generation) return;
      clearTimeout(createTimeout);
      roomReady = true;
      setStatus(`Room ready for ${mode}. Share the code with your friends — up to ${lobbyCapacity()} can join.`);
      controls();
    });
    peer.on('connection', connection => {
      if (attempt !== generation) { connection.close(); return; }
      if (starting || room) {
        // The arena is prepared (or being prepared) for a fixed roster: the
        // room stays closed to newcomers until the host leaves and reopens.
        connection.on('open', () => { sendPayload(connection, { type: 'cancelled', reason: 'match_in_progress' }); setTimeout(() => { try { connection.close(); } catch {} }, 250); });
        return;
      }
      if (guests.size >= lobbyCapacity()) {
        connection.on('open', () => { sendPayload(connection, { type: 'cancelled', reason: 'room_full' }); setTimeout(() => { try { connection.close(); } catch {} }, 250); });
        return;
      }
      acceptGuest(connection, attempt);
    });
    peer.on('error', error => {
      if (attempt !== generation) return;
      clearTimeout(createTimeout);
      if (error?.type === 'unavailable-id') { leaveToLobby(); createRoom(); return; }
      setStatus(explain(error));
      if (!guests.size && !conn) leaveToLobby();
    });
  }

  function acceptGuest(connection, attempt) {
    const entry = { conn: connection, name: '', visual: 'octane-original', ready: false, saidHello: false, slot: null };
    let closed = false;
    connection.on('data', data => gate(() => {
      if (attempt !== generation) return;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
      if (data?.type === 'hello' && !entry.saidHello) {
        entry.saidHello = true;
        void onGuestHello(entry, data, attempt);
        return;
      }
      onHostMessage(entry, data);
    }, data?.type === 'input' || data?.type === 'ping'));
    connection.on('close', () => { if (!closed) { closed = true; if (attempt === generation) onGuestClose(entry); } });
    connection.on('error', () => {});
    setStatus('Player connecting…');
  }

  async function onGuestHello(entry, message, attempt) {
    if (message.protocol !== PROTOCOL || message.physics !== PHYSICS_SHA256 || message.flow !== FLOW) {
      sendPayload(entry.conn, { type: 'cancelled', reason: 'update_required' });
      setStatus('A joining player runs a different game version. They must reload the latest build.');
      return;
    }
    if (!validName(message.name)) { try { entry.conn.close(); } catch {} setStatus('A joining player sent an invalid name.'); return; }
    const slot = roster.length;
    entry.slot = slot;
    entry.name = message.name;
    entry.visual = typeof message.visual === 'string' ? message.visual : 'octane-original';
    entry.paint = sanitizePaint(message.paint);
    roster = [...roster, { id: 'guest' + slot, slot, name: entry.name, team: balancedTeam(roster), visual: entry.visual, paint: entry.paint }];
    guests.set(slot, entry);
    setStatus(`${entry.name} joined (${roster.length}/${lobbyCapacity() + 1} players). Waiting for everyone to be ready.`);
    // Everyone already in the lobby hears about the new player.
    broadcastToGuests({ type: 'lobby', roster: publicRoster(), mode });
    controls();
  }

  function publicRoster() {
    return (roster ?? []).map((player, slot) => ({ name: player.name, team: player.team, slot, host: player.id === 'host' || slot === 0, disconnected: player.disconnected ?? false }));
  }

  function broadcastToGuests(payload) {
    for (const entry of guests.values()) sendPayload(entry.conn, payload);
  }

  function onHostMessage(entry, message) {
    if (!message || typeof message.type !== 'string') return;
    room?.touch(entry.slot);
    if (message.type === 'ready') {
      // Lobby ready: the guest UI is up and waiting (arena not loaded yet).
      entry.ready = true;
      setStatus(allGuestsReady()
        ? 'Everyone is in the lobby. Press START MATCH when you want to begin.'
        : `${entry.name} is ready. Waiting for the remaining players…`);
      controls();
    } else if (message.type === 'prepared') {
      // Arena loaded after the welcome; kickoff waits for this.
      entry.prepared = true;
      setStatus(`${entry.name} loaded the arena.`);
      readyWaiter?.();
      controls();
    } else if (message.type === 'input' && room) {
      room.input(entry.slot, message.seq, message.epoch, message.controls);
    } else if (message.type === 'ping') {
      sendPayload(entry.conn, { type: 'pong', nonce: message.nonce });
    } else if (message.type === 'pong') {
      if (typeof message.nonce === 'number') hostRtts.set(entry.slot, Math.max(0, Math.round(performance.now() - message.nonce)));
    } else if (message.type === 'rematch' && room?.terminal && hostPrepared) {
      startMatch();
    } else if (message.type === 'leave') {
      onGuestClose(entry, 'left_match');
    }
  }

  function onGuestClose(entry, reason = 'connection_lost') {
    if (role !== 'host' || entry.slot === null) return;
    guests.delete(entry.slot);
    hostRtts.delete(entry.slot);
    if (!room?.active && !starting) {
      // Lobby departure: free the slot and tell the remaining guests.
      roster = roster.filter(player => player.slot !== entry.slot);
      broadcastToGuests({ type: 'lobby', roster: publicRoster(), mode });
      setStatus(`${entry.name || 'A player'} left the lobby. ${guests.size ? 'Share the code to fill the slot.' : 'Waiting for players to join.'}`);
      controls();
      return;
    }
    if (room && !room.terminal) {
      room.removeGuest(entry.slot);
      const player = roster.find(candidate => candidate.slot === entry.slot);
      if (player) player.disconnected = true;
      broadcastToGuests({ type: 'lobby', roster: publicRoster(), mode });
      if (guests.size === 0) room.finish(0, reason === 'left_match' ? 'opponent_left' : 'opponent_stalled');
      else setStatus(`${entry.name} left the match. The remaining players keep playing.`);
    }
    readyWaiter?.();
    controls();
  }

  function waitForGuestsPrepared(attempt) {
    return new Promise(resolve => {
      const done = () => {
        if (attempt !== generation) return resolve(true);
        resolve(allGuestsPrepared() || guests.size === 0);
      };
      readyWaiter = done;
      readyTimer = setTimeout(done, READY_TIMEOUT);
    });
  }

  async function startMatch() {
    if (role !== 'host' || starting) return;
    if (room && hostPrepared) {
      // Rematch: arena already prepared with the same roster.
      lastResult = null; find('.online-results').hidden = true;
      matchEvents?.reset((roster ?? []).map(player => player.team));
      broadcastToGuests({ type: 'kickoff' });
      room.kickoff();
      hide(); hooks.resume();
      hud.hidden = false; root.classList.add('online-active');
      setStatus('Match in progress.');
      controls();
      return;
    }
    if (!guests.size || !allGuestsReady()) return;
    const attempt = generation;
    starting = true; lastResult = null; find('.online-results').hidden = true;
    controls(); setStatus('Preparing the shared arena…');
    const startRoster = [...roster];
    matchEvents = new MatchEvents(startRoster.map(player => player.team));
    // Everyone loads the same arena in parallel; each welcome carries the
    // guest's own slot so prediction reorders the wire state correctly.
    for (const [slot, entry] of guests) {
      sendPayload(entry.conn, { type: 'welcome', roster: startRoster, self: slot, mode, flow: FLOW, nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256, protocol: PROTOCOL, physics: PHYSICS_SHA256 });
    }
    try {
      await hooks.prepare(startRoster, startRoster.map((_, index) => index), () => attempt === generation, { nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256 });
      if (attempt !== generation) return;
      const ok = await waitForGuestsPrepared(attempt);
      clearTimeout(readyTimer); readyTimer = 0; readyWaiter = null;
      if (attempt !== generation) return;
      const prepared = [...guests.values()].filter(entry => entry.prepared);
      if (prepared.length === 0) throw new Error('No player finished loading. Share the code and retry.');
      // Every connected guest keeps a channel: a slow loader catches up the
      // moment it finishes because snapshots already flow to its slot.
      const channels = new Map([...guests.entries()].map(([slot, entry]) => [slot, {
        send: payload => sendPayload(entry.conn, payload),
        congested: () => (entry.conn?.dataChannel?.bufferedAmount ?? 0) > CONGESTION_BYTES
      }]));
      room = new HostRoom({
        sim: hooks.sim, match: hooks.match, players: startRoster,
        guests: channels,
        snapshotHz: SNAPSHOT_HZ_BY_MODE[mode] ?? 60,
        events: matchEvents,
        onEvent: event => {
          if (event.type === 'kickoff') hooks.kickoff?.();
          else if (event.type === 'events') {
            broadcastToGuests({ type: 'events', events: event.events, stats: event.stats });
            hooks.onEvents?.(event.events, event.stats, startRoster.map(player => player.team));
          } else if (event.type === 'stats') {
            broadcastToGuests({ type: 'stats', stats: event.stats });
          } else if (event.type === 'ended') onMatchEnded(event);
        }
      });
      hostPrepared = true; active = true;
      root.classList.add('online-active'); hud.hidden = false;
      renderRosterHud();
      room.sendSnapshot();
      setStatus('Match in progress.');
      startPings();
      broadcastToGuests({ type: 'kickoff' });
      room.kickoff();
      hide(); hooks.resume();
    } catch (error) {
      if (attempt === generation) {
        setStatus(`Could not prepare the match: ${error.message}`);
        broadcastToGuests({ type: 'cancelled', reason: 'prepare_failed' });
        if (active) active = false;
        hooks.restore();
        // Back to the lobby with whoever is still connected.
        hostPrepared = false; room = null; matchEvents = null;
      }
    } finally {
      starting = false; readyWaiter = null; controls();
    }
  }

  function startPings() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (role === 'host') {
        if (!guests.size && !conn?.open) { clearInterval(pingTimer); return; }
        for (const entry of guests.values()) sendPayload(entry.conn, { type: 'ping', nonce: performance.now() });
        if (conn?.open) sendPayload(conn, { type: 'ping', nonce: performance.now() });
      } else if (conn?.open) sendPayload(conn, { type: 'ping', nonce: performance.now() });
      else clearInterval(pingTimer);
    }, PING_INTERVAL);
    // Periodic stats keep guest TAB scoreboards fresh between events.
    clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (role === 'host' && room?.active && matchEvents) broadcastToGuests({ type: 'stats', stats: matchEvents.summary() });
    }, 5000);
  }

  // --------------------------------------------------------------- guest ----
  let conn = null;
  let guestJoinedFlag = false;
  function guestJoined() { return guestJoinedFlag; }

  function joinRoom() {
    if (role || preparing) return;
    const name = playerName();
    if (!name) return;
    const target = codeInput.value.trim().toUpperCase();
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(target)) {
      setStatus('Enter the five-letter room code shared by the host.'); return;
    }
    role = 'guest'; code = target; guestJoinedFlag = true; lobbyReadySent = false;
    controls(); setStatus(`Connecting to room ${target}…`);
    const attempt = ++generation;
    peer = new Peer(undefined, PEER_OPTIONS);
    const connectTimeout = setTimeout(() => {
      if (attempt === generation && !conn?.open) { setStatus('Could not reach that room. Check the code and retry.'); leaveToLobby(); }
    }, CONNECT_TIMEOUT);
    peer.on('open', () => {
      if (attempt !== generation) { clearTimeout(connectTimeout); return; }
      // Unordered delivery: a lost packet never blocks newer snapshots (no
      // head-of-line stall). Duplicates and reordering are dropped by tick/seq.
      conn = peer.connect(ID_PREFIX + target, { reliable: false });
      conn.on('open', () => {
        clearTimeout(connectTimeout);
        setStatus('Connected. Introducing your car…');
        sendPayload(conn, { type: 'hello', protocol: PROTOCOL, physics: PHYSICS_SHA256, flow: FLOW, nativeCheckpoint: 1, name, visual: hooks.visual(), paint: hooks.paint?.() ?? null });
      });
      conn.on('data', data => gate(() => { if (attempt === generation) onGuestData(data, attempt); }, data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data?.type === 'pong'));
      conn.on('close', () => { if (attempt === generation) onHostLost(); });
      conn.on('error', () => {});
    });
    peer.on('error', error => {
      if (attempt !== generation) return;
      clearTimeout(connectTimeout);
      setStatus(explain(error));
      if (!conn?.open) leaveToLobby();
    });
  }

  async function onGuestData(data, attempt) {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) { onSnapshot(data); return; }
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'lobby') {
      if (Array.isArray(data.roster)) { roster = data.roster; if (data.mode) mode = data.mode; }
      setStatus(`In the lobby — ${roster?.length ?? 1} player(s) joined. Waiting for the host to start…`);
      // Lobby ready signal: lets the host enable START MATCH.
      if (!lobbyReadySent && conn?.open) { lobbyReadySent = true; sendPayload(conn, { type: 'ready' }); }
      controls();
    } else if (data.type === 'welcome') {
      try {
        if (data.protocol !== PROTOCOL || data.physics !== PHYSICS_SHA256 || data.flow !== FLOW) throw Error('The host runs a different game version. Both players need the latest build.');
        if (!Array.isArray(data.roster) || data.roster.length < 2 || data.roster.length > 6) throw Error('Invalid roster from host.');
        if (!Number.isInteger(data.self) || data.self < 1 || data.self >= data.roster.length) throw Error('Invalid slot from host.');
        if (data.nativeCheckpoint !== 1 || data.nativePhysics !== NETWORK_CORE_SHA256) throw Error('Online physics version differs. Reload after both deployments are updated.');
        roster = data.roster;
        selfSlot = data.self;
        mode = data.mode ?? '1v1';
        order = [selfSlot, ...data.roster.map((_, index) => index).filter(index => index !== selfSlot)];
        preparing = true; controls(); setStatus('Match reserved. Loading the shared arena…');
        await hooks.prepare(data.roster, order, () => attempt === generation, { nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256 });
        if (attempt !== generation) return;
        prediction?.dispose();
        prediction = new Prediction(hooks.sim, order);
        matchStats = null;
        active = true;
        root.classList.add('online-active'); hud.hidden = false;
        renderRosterHud();
        if (latestSnapshot) prediction.receive(latestSnapshot, selfSlot);
        sendPayload(conn, { type: 'prepared' });
        startPings();
        setStatus('Connected. Waiting for the host to start the match…');
        controls();
      } catch (error) {
        if (attempt === generation) {
          setStatus(`Could not load this match: ${error.message}`);
          sendPayload(conn, { type: 'leave' });
          hooks.restore();
          leaveToLobby();
        }
      } finally { preparing = false; controls(); }
    } else if (data.type === 'kickoff') {
      lastResult = null; find('.online-results').hidden = true;
      hide(); hooks.resume();
      hud.hidden = false; root.classList.add('online-active');
    } else if (data.type === 'events') {
      handleWireEvents(data.events, data.stats);
    } else if (data.type === 'stats') {
      const local = data.stats ? remapStats(data.stats) : null;
      matchStats = () => local;
      hooks.onStats?.(local);
    } else if (data.type === 'result') {
      showResult(data);
    } else if (data.type === 'pong') {
      if (typeof data.nonce === 'number') guestRtt = Math.max(0, Math.round(performance.now() - data.nonce));
    } else if (data.type === 'cancelled') {
      setStatus(data.reason === 'update_required'
        ? 'Client and host versions differ. Reload after the game has been updated.'
        : data.reason === 'room_full' ? 'That room is full. Ask the host for a 1v1 code or a bigger mode.'
        : data.reason === 'match_in_progress' ? 'The match already started. Ask the host to finish first.'
        : 'The host cancelled the match.');
      leaveToLobby();
    }
  }

  // Wire-slot events/stats -> local render order (slot 0 is always "you").
  function localSlotFor(wireSlot) {
    if (!Number.isInteger(wireSlot)) return null;
    return order.indexOf(wireSlot);
  }
  function remapStats(stats) {
    if (!stats?.slots) return stats;
    const slots = order.map((wireSlot, index) => ({ ...(stats.slots[wireSlot] ?? { slot: index, goals: 0, assists: 0, saves: 0, epicSaves: 0, shots: 0, ownGoals: 0, points: 0 }), slot: index }));
    return { slots };
  }
  function handleWireEvents(events, stats) {
    const localStats = remapStats(stats);
    matchStats = () => localStats;
    const localEvents = (events ?? []).map(event => ({ ...event, slot: localSlotFor(event.slot) }));
    hooks.onEvents?.(localEvents, localStats, order.map(wireSlot => roster?.[wireSlot]?.team ?? (wireSlot % 2)));
  }

  let snapshotWarnings = 0;
  function onSnapshot(buffer) {
    let snapshot;
    try { snapshot = decodeSnapshot(buffer); } catch { return; }
    try {
      latestSnapshot = snapshot; lastSnapshotAt = performance.now();
      snapshotArrivals.push(lastSnapshotAt);
      if (snapshotArrivals.length > 240) snapshotArrivals.splice(0, snapshotArrivals.length - 240);
      prediction?.receive(snapshot, selfSlot);
      if (!active) return;
      Object.assign(hooks.match.state, snapshot.match);
      root.dataset.onlineTick = snapshot.tick;
      root.dataset.onlinePhase = snapshot.match.phase;
      updateHudFromMatch(snapshot.match);
    } catch (error) {
      // One bad snapshot must never kill the whole data-channel stream.
      if (snapshotWarnings++ < 5) console.warn('p2p snapshot processing failed', error);
      (globalThis.__p2pSnapshotErrors ??= []).push(String(error?.stack ?? error));
    }
  }

  function onHostLost() {
    if (role !== 'guest') return;
    if (active && !lastResult) {
      showResult({ status: 'cancelled', winner: null, reason: 'host_left', blueScore: hooks.match.state.blueScore, orangeScore: hooks.match.state.orangeScore });
      setStatus('Connection to the host was lost. The match did not complete.');
    } else {
      setStatus('The host disconnected before the match started.');
      leaveToLobby();
    }
  }

  // -------------------------------------------------------------- shared ----
  function playerName() {
    const name = input.value.trim();
    if (!validName(name)) {
      setStatus('Use 2–24 letters, numbers, spaces, underscores or hyphens.');
      input.focus();
      return null;
    }
    try { localStorage.setItem(NAME_KEY, name); } catch {}
    return name;
  }

  function renderRosterHud() {
    const list = hud.querySelector('.online-roster'); list.replaceChildren();
    const youSlot = role === 'host' ? 0 : selfSlot;
    for (const [slot, player] of (roster ?? []).entries()) {
      const name = document.createElement('span');
      name.className = player.team === 0 ? 'blue-team' : 'orange-team';
      name.textContent = `${player.name}${slot === youSlot ? ' · YOU' : ''}${player.disconnected ? ' · LEFT' : ''}`;
      list.append(name);
    }
  }

  const hudCache = { key: '' };
  // Per-local-slot opponent controls for visuals/audio (slot 0 is the local car).
  const remoteControls = [];
  function collectRemoteControls(values) {
    while (remoteControls.length < values.length) remoteControls.push(neutralControls());
    for (let index = 0; index < values.length; index++) applyControlsValues(remoteControls[index], values[index]);
    return remoteControls;
  }

  function updateHudFromMatch(match) {
    const seconds = Math.ceil(match.overtime ? match.overtimeSeconds : match.remainingSeconds);
    const banner = match.phase === 'kickoff' ? String(Math.max(1, Math.ceil(match.countdown)))
      : match.phase === 'goal' ? 'GOAL!' : match.phase === 'waiting' ? 'WAITING FOR PLAYERS'
      : match.phase === 'ended' ? 'FULL TIME' : '';
    const key = `${match.blueScore}|${match.orangeScore}|${seconds}|${match.overtime ? 1 : 0}|${banner}`;
    if (key === hudCache.key) return;
    hudCache.key = key;
    hud.querySelector('[data-score="blue"]').textContent = match.blueScore;
    hud.querySelector('[data-score="orange"]').textContent = match.orangeScore;
    hud.querySelector('[data-clock]').textContent = `${match.overtime ? '+' : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    hud.querySelector('.online-banner').textContent = banner;
  }

  function onMatchEnded(result) {
    showResult(result);
  }

  function showResult(result) {
    lastResult = result;
    // Local progression (player level on the home card) counts finished
    // matches, including online ones, but not cancelled sessions.
    if (result.status !== 'cancelled') { try { hooks.onMatchEnd?.(); } catch {} }
    const own = role === 'host' ? 0 : selfSlot;
    const ownTeam = roster?.[own]?.team ?? (role === 'host' ? 0 : 1);
    const stats = role === 'guest' && result.stats ? remapStats(result.stats) : (result.stats ?? (role === 'host' ? matchEvents?.summary() ?? null : null));
    if (stats) matchStats = () => stats;
    const box = find('.online-results'); box.hidden = false; box.replaceChildren();
    const template = document.createElement('div');
    template.className = 'arena-victory__content';
    const outcome = result.status === 'cancelled'
      ? (result.reason === 'opponent_left' || result.reason === 'opponent_stalled') ? 'victory'
        : result.reason === 'host_left' ? 'no-contest' : 'no-contest'
      : result.winner === ownTeam ? 'victory' : result.winner === null ? 'draw' : 'defeat';
    const localRoster = () => role === 'host'
      ? (roster ?? []).map(player => ({ name: player.name, team: player.team, disconnected: !!player.disconnected }))
      : order.map(wireSlot => {
          const player = roster?.[wireSlot];
          return { name: player?.name ?? `PLAYER ${wireSlot + 1}`, team: player?.team ?? (wireSlot % 2), disconnected: !!player?.disconnected };
        });
    template.innerHTML = victoryContent({
      outcome, team: ownTeam,
      blueScore: result.blueScore ?? 0, orangeScore: result.orangeScore ?? 0,
      stats, roster: localRoster(), teams: localRoster().map(player => player.team), selfSlot: 0,
      note: result.status === 'cancelled'
        ? (result.reason === 'opponent_left' || result.reason === 'opponent_stalled') ? 'The other team left the match.'
          : result.reason === 'host_left' ? 'The host disconnected before the match completed.' : 'The match did not complete.'
        : 'Peer-to-peer casual · No ratings, placements or penalties.',
    });
    // The scoreboard tables already carry team styling; move them in as-is.
    box.append(template);
    show(); controls();
    setStatus(result.status === 'cancelled' ? 'Match ended early.' : 'Match complete.');
  }

  function leaveToLobby() {
    generation++;
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(readyTimer); readyTimer = 0;
    clearInterval(statsTimer); statsTimer = 0;
    readyWaiter = null; lobbyReadySent = false;
    room?.dispose(); room = null;
    prediction?.dispose(); prediction = null;
    const wasActive = active;
    active = false; role = null; hostPrepared = false; starting = false;
    guestJoinedFlag = false; roomReady = false;
    roster = null; latestSnapshot = null; guestRtt = null; snapshotArrivals = [];
    matchEvents = null; matchStats = null; guests = new Map(); hostRtts = new Map();
    selfSlot = 1; order = [1, 0];
    teardownSignaling();
    if (wasActive) hooks.restore();
    root.classList.remove('online-active');
    delete root.dataset.onlineTick; delete root.dataset.onlinePhase;
    hud.hidden = true;
    lastResult = null; find('.online-results').hidden = true;
    controls();
  }

  function leave() {
    // Mirrors the legacy leave(): active is cleared before hooks.restore() so
    // the offline restore path never re-enters leave().
    generation++;
    if (role === 'guest' && conn?.open) sendPayload(conn, { type: 'leave' });
    if (role === 'host' && room?.active && !room.terminal) room.finish(1, 'forfeit');
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(readyTimer); readyTimer = 0;
    clearInterval(statsTimer); statsTimer = 0;
    readyWaiter = null; lobbyReadySent = false;
    room?.dispose(); room = null;
    prediction?.dispose(); prediction = null;
    const wasActive = active;
    active = false; role = null; hostPrepared = false; starting = false;
    guestJoinedFlag = false; roomReady = false;
    roster = null; latestSnapshot = null; guestRtt = null; snapshotArrivals = [];
    matchEvents = null; matchStats = null; guests = new Map(); hostRtts = new Map();
    selfSlot = 1; order = [1, 0];
    teardownSignaling();
    root.classList.remove('online-active');
    delete root.dataset.onlineTick; delete root.dataset.onlinePhase;
    hud.hidden = true;
    if (wasActive) hooks.restore();
    lastResult = null; find('.online-results').hidden = true;
    controls();
  }

  function back() {
    if (active && !lastResult) { hide(); hooks.resume(); return; }
    leave(); hide(); hooks.home();
  }

  panel.addEventListener('click', async event => {
    const modeButton = event.target.closest('[data-mode]');
    if (modeButton && !modeButton.disabled) {
      mode = modeButton.dataset.mode;
      controls();
      setStatus(`${mode} — ${lobbyCapacity() + 1} player${lobbyCapacity() ? 's' : ''} per match. Create a room and share the code.`);
      return;
    }
    const action = event.target.closest('[data-p2p]')?.dataset.p2p;
    if (action === 'back') back();
    else if (action === 'create') createRoom();
    else if (action === 'join') joinRoom();
    else if (action === 'start') startMatch();
    else if (action === 'bots') { leave(); hide(); hooks.bots(); }
    else if (action === 'again') {
      if (role === 'host') { startMatch(); }
      else if (role === 'guest') {
        lastResult = null; find('.online-results').hidden = true; hide(); hooks.resume();
        sendPayload(conn, { type: 'rematch' });
        setStatus('Rematch requested. Waiting for the host…');
      }
    } else if (action === 'leave-room') {
      leave();
      setStatus('Left the room. Create another room or join a friend.');
      controls();
    } else if (action === 'copy' && code) {
      try { await navigator.clipboard.writeText(code); setStatus(`Room code ${code} copied. Share it privately with your friends.`); }
      catch { setStatus(`Copy and share this code: ${code}`); }
    }
  });
  panel.querySelector('form').addEventListener('submit', event => { event.preventDefault(); });
  hud.querySelector('[data-leave]').onclick = () => { leave(); hide(); hooks.home(); };

  function escape() { back(); }

  function hostNetworkText() {
    if (!guests.size) return conn?.open ? 'Host authority · 120 Hz' : 'No peers connected';
    const rtts = [...hostRtts.values()];
    const worst = rtts.length ? Math.max(...rtts) : null;
    return `Host authority · 120 Hz · ${guests.size} peer${guests.size > 1 ? 's' : ''}${worst === null ? '' : ` · worst ${worst} ms`}`;
  }

  return {
    open, leave, escape,
    restoreIntent() { /* Peer matches do not survive reloads; nothing to restore. */ },
    get active() { return active; },
    get visible() { return !panel.hidden; },
    get role() { return role; },
    get mode() { return mode; },
    get roster() { return roster; },
    get selfSlot() { return role === 'host' ? 0 : selfSlot; },
    get ownTeam() {
      if (!roster) return 0;
      return role === 'host' ? roster[0]?.team ?? 0 : roster[selfSlot]?.team ?? 1;
    },
    // Local render order (slot 0 = you): names, teams and stats all line up.
    localRoster() {
      if (!roster) return [];
      return role === 'host'
        ? roster.map(player => ({ name: player.name, team: player.team, disconnected: !!player.disconnected }))
        : order.map(wireSlot => {
            const player = roster[wireSlot];
            return { name: player?.name ?? `PLAYER ${wireSlot + 1}`, team: player?.team ?? (wireSlot % 2), disconnected: !!player?.disconnected };
          });
    },
    teams() {
      if (!roster) return [0, 1];
      return role === 'host'
        ? roster.map(player => player.team)
        : order.map(wireSlot => roster[wireSlot]?.team ?? (wireSlot % 2));
    },
    // Latest stats in LOCAL slot order (slot 0 = you); null until known.
    stats() {
      if (role === 'host') return matchEvents?.summary() ?? null;
      return matchStats?.() ?? null;
    },
    // Kept for compatibility with the single-rival effects path.
    get opponentControls() {
      if (!active) return null;
      return remoteControls[0] ?? neutralControls();
    },
    get remoteControls() { return active ? remoteControls : null; },
    update(now, controls, clock, render = true) {
      if (!active) return;
      const neutral = document.hidden || !document.hasFocus() || !panel.hidden;
      if (role === 'host') {
        room.setLocalControls(neutral ? NEUTRAL : controlsArray(controls));
        collectRemoteControls(room.guestSlots.map(slot => room.guestControlsArray(slot)));
        clock.update(now, () => {}, () => room.step());
        // One snapshot per frame, newest state only: catch-up batches must not
        // emit bursts of back-to-back packets into every guest's queue.
        room.flushSnapshots();
        if (room.guestStalled(now)) room.finish(0, 'opponent_stalled');
        if (render) {
          updateHudFromMatch(hooks.match.state);
          root.dataset.onlineTick = room.tick; root.dataset.onlinePhase = hooks.match.state.phase;
          if (now - lastNetworkDisplay > 500) {
            hud.querySelector('.online-network').textContent = hostNetworkText();
            lastNetworkDisplay = now;
          }
        }
      } else if (prediction) {
        const usable = conn?.open && now - lastSnapshotAt < 1250;
        prediction.update(now, neutral ? NEUTRAL : controlsArray(controls),
          (seq, values, metadata) => {
            const message = { type: 'input', seq, epoch: metadata.epoch, controls: values };
            sendPayload(conn, message);
            // Loss immunity: a second copy rides a separate SCTP message a few
            // ms later; the host drops duplicates by sequence number. Skipped
            // when the send queue is backed up — a duplicate is pure overhead.
            setTimeout(() => {
              if ((conn?.dataChannel?.bufferedAmount ?? 0) < CONGESTION_BYTES) sendPayload(conn, message);
            }, 8);
          },
          clock, usable, { render });
        hooks.match.state.paused = false;
        if (render && latestSnapshot) {
          // Per-slot controls of every remote car, in local render order.
          collectRemoteControls(order.slice(1).map(wireSlot => latestSnapshot.inputStates?.[wireSlot]?.controls ?? NEUTRAL));
        }
        if (render && now - lastNetworkDisplay > 500) {
          const stats = prediction.metrics();
          hud.querySelector('.online-network').textContent = conn?.open
            ? stats.predictionPaused && latestSnapshot?.match.phase === 'playing'
              ? 'Waiting for host updates · prediction paused'
              : `P2P guest · ${guestRtt === null ? 'connected' : `${guestRtt} ms round trip`} · jitter ${Math.round(stats.jitterMs)} ms · buffer ${Math.round(stats.interpolationMs)} ms${stats.frameTiming.p95Ms > 50 ? ' · slow rendering' : ''}`
            : 'Connection to the host lost';
          lastNetworkDisplay = now;
        }
      }
    },
    diagnostics() {
      const arrivals = snapshotArrivals;
      const span = arrivals.length > 1 ? (arrivals.at(-1) - arrivals[0]) / 1000 : 0;
      return { active, role, code, mode, guests: guests.size, selfSlot, guestReady: [...guests.values()].map(entry => entry.ready), hostPrepared, connected: guests.size > 0 || !!conn?.open,
        snapshotRate: span > 0.25 ? Math.round((arrivals.length - 1) / span) : 0,
        prediction: role === 'guest' ? prediction?.metrics() ?? null : null,
        tick: role === 'host' ? room?.tick : latestSnapshot?.tick ?? 0,
        phase: role === 'host' ? hooks.match.state.phase : latestSnapshot?.match.phase,
        epoch: role === 'host' ? room?.epoch : latestSnapshot?.epoch,
        rtt: role === 'host' ? Math.max(0, ...[...hostRtts.values()]) : guestRtt, result: lastResult,
        inputSequence: prediction?.seq ?? 0, pendingInputs: prediction?.pending?.length ?? 0,
        bufferedSnapshots: prediction?.samples?.length ?? 0 };
    }
  };
}
