// Peer-to-peer online play over WebRTC (PeerJS). GitHub Pages has no backend,
// so the dedicated-server netcode is replaced by a host-authoritative model:
// the host browser runs the deterministic WASM arena at 120 Hz and streams the
// same binary snapshots the server used to send; the guest keeps the existing
// client prediction and rollback reconciliation unchanged.
import { Peer } from '../vendor/peerjs.mjs';
import { HostRoom } from './p2p-room.js';
import { Prediction } from './prediction.js';
import { controlsArray, decodeSnapshot, validName, NEUTRAL, PROTOCOL, PHYSICS_SHA256 } from './protocol.js';
import { NETWORK_CORE_SHA256 } from '../physics/network-core.js';

const ID_PREFIX = 'ra1-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT = 15000;
const READY_TIMEOUT = 90000;
const PING_INTERVAL = 2000;
const NAME_KEY = 'arena.p2p.name';

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

export function mountP2P(root, hooks) {
  let peer = null, conn = null, room = null, prediction = null;
  let role = null, active = false, preparing = false, lastResult = null;
  let code = '', guestReady = false, hostPrepared = false, guestJoined = false, roomReady = false, hostName = '';
  let generation = 0, rtt = null, lastSnapshotAt = 0, latestSnapshot = null, snapshotArrivals = [];
  let pingTimer = 0, readyTimer = 0, poll = 0, lastNetworkDisplay = 0;
  let oldButtons = [], lastDirection = 0, roster = null;

  const panel = document.createElement('section');
  panel.className = 'online-panel sheet-overlay';
  panel.hidden = true;
  panel.innerHTML = `<div class="online-dialog" role="dialog" aria-modal="true" aria-labelledby="p2p-title">
    <header class="online-heading"><div><p class="online-eyebrow">ROCKET ARENA · PEER-TO-PEER</p><h1 id="p2p-title">MULTIPLAYER</h1></div><button type="button" data-p2p="back" class="online-close" aria-label="Back to Play">×</button></header>
    <p class="online-subtitle">Direct 1v1 matches over WebRTC. Share a five-letter room code — no account, no game server.</p>
    <form class="online-form">
      <div class="online-account-row"><label class="online-name">DISPLAY NAME<input name="displayName" autocomplete="nickname" minlength="2" maxlength="24" value="Player" required></label><div class="online-identity">Guest · Host plays Blue, guest plays Orange</div></div>
      <p class="online-status" role="status" aria-live="polite">Create a room and share the code, or join a friend's room.</p>
      <div class="online-private-options"><button type="button" data-p2p="create" class="online-primary">CREATE ROOM</button><label class="online-name">ROOM CODE<input name="roomCode" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="5" placeholder="5-letter code"></label><button type="button" data-p2p="join">JOIN ROOM</button></div>
      <section class="online-private-lobby" hidden aria-label="Peer-to-peer room"><div class="online-invite"><span>ROOM CODE</span><output data-room-code></output><button type="button" data-p2p="copy">COPY CODE</button></div><p>Peer-to-peer casual · The host runs the authoritative arena in their browser.</p><div class="online-private-roster"></div><div class="online-actions"><button type="button" data-p2p="start" class="online-primary">START MATCH</button><button type="button" data-p2p="leave-room">LEAVE ROOM</button></div></section>
      <div class="online-results" hidden></div>
      <div class="online-actions"><button type="button" data-p2p="again" class="online-primary" hidden>PLAY AGAIN</button><button type="button" data-p2p="bots">PLAY BOTS OFFLINE</button></div>
      <p class="online-account-help">Both players must use the default (experimental) physics. Controls match Rocket League: W/S throttle, A/D steer, Left Click boost, Right Click jump, Shift powerslide/air roll, Space ball cam.</p>
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
    const pad = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
    if (pad) {
      const buttons = pad.buttons.map(button => button.pressed);
      const direction = buttons[13] || buttons[15] || pad.axes[1] > 0.55 || pad.axes[0] > 0.55 ? 1 : buttons[12] || buttons[14] || pad.axes[1] < -0.55 || pad.axes[0] < -0.55 ? -1 : 0;
      if (direction && now - lastDirection > 220) { moveFocus(direction); lastDirection = now; }
      if (buttons[0] && !oldButtons[0] && panel.contains(document.activeElement)) document.activeElement.click();
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

  function controls() {
    find('[data-p2p="create"]').disabled = !!role || preparing;
    find('[data-p2p="join"]').disabled = !!role || preparing;
    codeInput.disabled = !!role || preparing;
    input.disabled = !!role || preparing || active;
    find('.online-private-options').hidden = !!role || !!lastResult;
    // The host must see the room code as soon as the room exists — before the
    // guest joins — otherwise there is nothing to share with a friend.
    const inLobby = !lastResult && ((role === 'host' && roomReady) || (role === 'guest' && guestJoined));
    find('.online-private-lobby').hidden = !inLobby;
    find('[data-p2p="again"]').hidden = !lastResult;
    find('[data-p2p="start"]').hidden = role !== 'host';
    find('[data-p2p="start"]').disabled = !(role === 'host' && guestReady && hostPrepared && !preparing && !room?.active && !room?.terminal);
    find('[data-p2p="leave-room"]').disabled = preparing && !role;
    if (inLobby) {
      find('[data-room-code]').textContent = code;
      const list = find('.online-private-roster'); list.replaceChildren();
      for (const player of roster ?? []) {
        const row = document.createElement('p');
        row.className = player.team === 0 ? 'blue-team' : 'orange-team';
        const side = player.team === 0 ? 'BLUE' : 'ORANGE';
        const you = (role === 'host') === (player.team === 0) ? ' · YOU' : '';
        const ready = player.team === 1 ? (guestReady ? ' · READY' : ' · LOADING…') : ' · READY';
        row.textContent = `${side} · ${player.name}${you}${ready}`;
        list.append(row);
      }
      if (role === 'host' && !guestJoined) {
        const waiting = document.createElement('p');
        waiting.className = 'orange-team';
        waiting.textContent = 'ORANGE · Waiting for your friend to join…';
        list.append(waiting);
      } else if (role === 'guest' && !roster) {
        const waiting = document.createElement('p');
        waiting.className = 'blue-team';
        waiting.textContent = 'BLUE · Waiting for the host…';
        list.append(waiting);
      }
    }
  }

  async function open() {
    lastResult = null; find('.online-results').hidden = true;
    show(); setStatus('Create a room and share the code, or join a friend\'s room.'); controls();
  }

  function teardownSignaling() {
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(readyTimer); readyTimer = 0;
    try { conn?.close(); } catch {}
    try { peer?.destroy(); } catch {}
    conn = peer = null;
  }

  // ---------------------------------------------------------------- host ----
  function createRoom() {
    if (role || preparing) return;
    const name = playerName();
    if (!name) return;
    role = 'host'; roomReady = false; hostName = name; guestJoined = guestReady = hostPrepared = false;
    roster = [{ id: 'host', name, team: 0, visual: hooks.visual() }];
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
      setStatus('Room ready. Share the code with your friend and wait for them to join.');
      controls();
    });
    peer.on('connection', connection => {
      if (attempt !== generation) { connection.close(); return; }
      if (conn && (conn.open || !guestJoined)) { connection.close(); return; }
      acceptGuest(connection, attempt);
    });
    peer.on('error', error => {
      if (attempt !== generation) return;
      clearTimeout(createTimeout);
      if (error?.type === 'unavailable-id') { leaveToLobby(); createRoom(); return; }
      setStatus(explain(error));
      if (!conn) leaveToLobby();
    });
  }

  function acceptGuest(connection, attempt) {
    conn = connection; guestJoined = false; guestReady = false;
    let saidHello = false;
    setStatus('Opponent connecting…');
    const helloTimeout = setTimeout(() => { if (!saidHello) { try { connection.close(); } catch {} } }, CONNECT_TIMEOUT);
    connection.on('data', data => gate(() => {
      if (attempt !== generation) return;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
      if (data?.type === 'hello' && !saidHello) {
        saidHello = true; clearTimeout(helloTimeout);
        void onGuestHello(data, attempt);
        return;
      }
      onHostMessage(data);
    }, data?.type === 'input' || data?.type === 'ping'));
    connection.on('close', () => { if (attempt === generation) onGuestClose(); });
    connection.on('error', () => {});
  }

  async function onGuestHello(message, attempt) {
    if (message.protocol !== PROTOCOL || message.physics !== PHYSICS_SHA256) {
      sendPayload(conn, { type: 'cancelled', reason: 'update_required' });
      setStatus('The joining player runs a different game version. They must reload the latest build.');
      return;
    }
    if (!validName(message.name)) { try { conn.close(); } catch {} setStatus('The joining player sent an invalid name.'); return; }
    roster = [
      { id: 'host', name: hostName, team: 0, visual: hooks.visual() },
      { id: 'guest', name: message.name, team: 1, visual: typeof message.visual === 'string' ? message.visual : 'octane-original' }
    ];
    guestJoined = true;
    setStatus('Opponent joined. Preparing the shared arena…');
    controls();
    sendPayload(conn, { type: 'welcome', roster, self: 1, nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256, protocol: PROTOCOL, physics: PHYSICS_SHA256 });
    preparing = true; controls();
    try {
      await hooks.prepare(roster, [0, 1], () => attempt === generation, { nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256 });
      if (attempt !== generation) return;
      if (!conn?.open) {
        // The opponent disconnected while the arena was loading.
        active = false;
        hooks.restore();
        leaveToLobby();
        setStatus('The opponent left while the arena was loading. Share the code again to retry.');
        return;
      }
      room = new HostRoom({
        sim: hooks.sim, match: hooks.match, players: roster,
        send: payload => sendPayload(conn, payload),
        onEvent: event => {
          if (event.type === 'kickoff') hooks.kickoff?.();
          else if (event.type === 'ended') onMatchEnded(event);
        }
      });
      hostPrepared = true; active = true;
      root.classList.add('online-active'); hud.hidden = false;
      renderRosterHud();
      room.sendSnapshot();
      setStatus('Arena ready. Start the match when your opponent is ready.');
      startPings();
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        if (attempt === generation && !guestReady && !room.terminal) {
          setStatus('The opponent did not finish loading. They can rejoin with the same code.');
        }
      }, READY_TIMEOUT);
    } catch (error) {
      if (attempt === generation) {
        setStatus(`Could not prepare the match: ${error.message}`);
        sendPayload(conn, { type: 'cancelled', reason: 'prepare_failed' });
        if (active) { active = false; }
        hooks.restore();
        leaveToLobby();
      }
    } finally {
      preparing = false; controls();
    }
  }

  function onHostMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    room?.touch();
    if (message.type === 'ready') {
      guestReady = true;
      setStatus('Opponent is ready. Press START MATCH when you want to begin.');
      controls();
    } else if (message.type === 'input' && room) {
      try { room.input(message.seq, message.epoch, message.controls); } catch { /* ignore malformed input */ }
    } else if (message.type === 'ping') {
      sendPayload(conn, { type: 'pong', nonce: message.nonce });
    } else if (message.type === 'rematch' && room?.terminal && hostPrepared) {
      startMatch();
    } else if (message.type === 'leave') {
      onGuestClose('left_match');
    }
  }

  function onGuestClose(reason = 'connection_lost') {
    if (role !== 'host') return;
    guestJoined = guestReady = false;
    conn = null;
    if (room?.active && !room.terminal) {
      room.finish(0, reason === 'left_match' ? 'opponent_left' : 'opponent_stalled');
    } else if (room && !room.terminal) {
      // Opponent left before kickoff: back to the lobby, keep the room code.
      room.dispose(); room = null; hostPrepared = false;
      roster = [{ id: 'host', name: hostName, team: 0, visual: hooks.visual() }];
      if (active) { active = false; root.classList.remove('online-active'); hud.hidden = true; hooks.restore(); }
      setStatus('The opponent left before kickoff. Share the code again to retry.');
      controls();
    }
  }

  function startMatch() {
    if (role !== 'host' || !hostPrepared || !room) return;
    lastResult = null; find('.online-results').hidden = true;
    sendPayload(conn, { type: 'kickoff' });
    room.kickoff();
    hide(); hooks.resume();
    hud.hidden = false; root.classList.add('online-active');
    setStatus('Match in progress.');
    controls();
  }

  // --------------------------------------------------------------- guest ----
  function joinRoom() {
    if (role || preparing) return;
    const name = playerName();
    if (!name) return;
    const target = codeInput.value.trim().toUpperCase();
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(target)) {
      setStatus('Enter the five-letter room code shared by the host.'); return;
    }
    role = 'guest'; code = target; guestJoined = true; guestReady = false;
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
        sendPayload(conn, { type: 'hello', protocol: PROTOCOL, physics: PHYSICS_SHA256, nativeCheckpoint: 1, name, visual: hooks.visual() });
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
    if (data.type === 'welcome') {
      try {
        if (data.protocol !== PROTOCOL || data.physics !== PHYSICS_SHA256) throw Error('The host runs a different game version. Both players need the latest build.');
        if (!Array.isArray(data.roster) || data.roster.length !== 2 || data.self !== 1) throw Error('Invalid roster from host.');
        if (data.nativeCheckpoint !== 1 || data.nativePhysics !== NETWORK_CORE_SHA256) throw Error('Online physics version differs. Reload after both deployments are updated.');
        roster = data.roster;
        const order = [data.self, ...data.roster.map((_, index) => index).filter(index => index !== data.self)];
        preparing = true; controls(); setStatus('Match reserved. Loading the shared arena…');
        await hooks.prepare(data.roster, order, () => attempt === generation, { nativeCheckpoint: 1, nativePhysics: NETWORK_CORE_SHA256 });
        if (attempt !== generation) return;
        prediction?.dispose();
        prediction = new Prediction(hooks.sim, order);
        active = true;
        root.classList.add('online-active'); hud.hidden = false;
        renderRosterHud();
        if (latestSnapshot) prediction.receive(latestSnapshot, data.self);
        sendPayload(conn, { type: 'ready' });
        guestReady = true;
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
    } else if (data.type === 'result') {
      showResult(data);
    } else if (data.type === 'pong') {
      if (typeof data.nonce === 'number') rtt = Math.max(0, Math.round(performance.now() - data.nonce));
    } else if (data.type === 'cancelled') {
      setStatus(data.reason === 'update_required'
        ? 'Client and host versions differ. Reload after the game has been updated.'
        : 'The host cancelled the match.');
      leaveToLobby();
    }
  }

  function onSnapshot(buffer) {
    let snapshot;
    try { snapshot = decodeSnapshot(buffer); } catch { return; }
    latestSnapshot = snapshot; lastSnapshotAt = performance.now();
    snapshotArrivals.push(lastSnapshotAt);
    if (snapshotArrivals.length > 240) snapshotArrivals.splice(0, snapshotArrivals.length - 240);
    prediction?.receive(snapshot, 1);
    const remote = snapshot.inputStates?.[0]?.controls;
    if (remote) applyControlsValues(opponentControls, remote);
    if (!active) return;
    Object.assign(hooks.match.state, snapshot.match);
    root.dataset.onlineTick = snapshot.tick;
    root.dataset.onlinePhase = snapshot.match.phase;
    updateHudFromMatch(snapshot.match);
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

  function startPings() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (conn?.open) sendPayload(conn, { type: 'ping', nonce: performance.now() });
      else clearInterval(pingTimer);
    }, PING_INTERVAL);
  }

  function renderRosterHud() {
    const list = hud.querySelector('.online-roster'); list.replaceChildren();
    for (const player of roster ?? []) {
      const name = document.createElement('span');
      name.className = player.team === 0 ? 'blue-team' : 'orange-team';
      name.textContent = player.name;
      list.append(name);
    }
  }

  const hudCache = { key: '' };
  const opponentControls = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
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
    const own = role === 'host' ? 0 : 1;
    const box = find('.online-results'); box.hidden = false; box.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = result.status === 'cancelled'
      ? (result.reason === 'opponent_left' || result.reason === 'opponent_stalled') ? 'OPPONENT LEFT · VICTORY'
        : result.reason === 'host_left' ? 'HOST LEFT'
        : 'NO CONTEST'
      : result.winner === own ? 'VICTORY' : 'DEFEAT';
    box.append(title);
    const score = document.createElement('p');
    score.textContent = result.status === 'cancelled' ? 'The match did not complete.' : `${result.blueScore} – ${result.orangeScore}`;
    box.append(score);
    const note = document.createElement('p');
    note.textContent = 'Peer-to-peer casual · No ratings, placements or penalties.';
    box.append(note);
    show(); controls();
    setStatus(result.status === 'cancelled' ? 'Match ended early.' : 'Match complete.');
  }

  function leaveToLobby() {
    generation++;
    clearInterval(pingTimer); pingTimer = 0;
    clearTimeout(readyTimer); readyTimer = 0;
    room?.dispose(); room = null;
    prediction?.dispose(); prediction = null;
    const wasActive = active;
    active = false; role = null; hostPrepared = false; guestJoined = guestReady = false; roomReady = false;
    roster = null; latestSnapshot = null; rtt = null; snapshotArrivals = [];
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
    room?.dispose(); room = null;
    prediction?.dispose(); prediction = null;
    const wasActive = active;
    active = false; role = null; hostPrepared = false; guestJoined = guestReady = false; roomReady = false;
    roster = null; latestSnapshot = null; rtt = null; snapshotArrivals = [];
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
      try { await navigator.clipboard.writeText(code); setStatus(`Room code ${code} copied. Share it privately with your friend.`); }
      catch { setStatus(`Copy and share this code: ${code}`); }
    }
  });
  panel.querySelector('form').addEventListener('submit', event => { event.preventDefault(); });
  hud.querySelector('[data-leave]').onclick = () => { leave(); hide(); hooks.home(); };

  function escape() { back(); }

  return {
    open, leave, escape,
    restoreIntent() { /* Peer matches do not survive reloads; nothing to restore. */ },
    get active() { return active; },
    get visible() { return !panel.hidden; },
    get role() { return role; },
    get opponentControls() { return active ? opponentControls : null; },
    update(now, controls, clock, render = true) {
      if (!active) return;
      const neutral = document.hidden || !document.hasFocus() || !panel.hidden;
      if (role === 'host') {
        room.setLocalControls(neutral ? NEUTRAL : controlsArray(controls));
        applyControlsValues(opponentControls, room.guestControlsArray);
        clock.update(now, () => {}, () => room.step());
        if (room.guestStalled(now)) room.finish(0, 'opponent_stalled');
        if (render) {
          updateHudFromMatch(hooks.match.state);
          root.dataset.onlineTick = room.tick; root.dataset.onlinePhase = hooks.match.state.phase;
          if (now - lastNetworkDisplay > 500) {
            hud.querySelector('.online-network').textContent = conn?.open
              ? `Host authority · 120 Hz · ${rtt === null ? 'peer connected' : `${rtt} ms round trip`}`
              : 'Opponent connection lost · finishing the match';
            lastNetworkDisplay = now;
          }
        }
      } else if (prediction) {
        const usable = conn?.open && now - lastSnapshotAt < 1000;
        prediction.update(now, neutral ? NEUTRAL : controlsArray(controls),
          (seq, values, metadata) => {
            const message = { type: 'input', seq, epoch: metadata.epoch, controls: values };
            sendPayload(conn, message);
            // Loss immunity: a second copy rides a separate SCTP message a few
            // ms later; the host drops duplicates by sequence number.
            setTimeout(() => sendPayload(conn, message), 8);
          },
          clock, usable, { render });
        hooks.match.state.paused = false;
        if (render && now - lastNetworkDisplay > 500) {
          const stats = prediction.metrics();
          hud.querySelector('.online-network').textContent = conn?.open
            ? stats.predictionPaused && latestSnapshot?.match.phase === 'playing'
              ? 'Waiting for host updates · prediction paused'
              : `P2P guest · ${rtt === null ? 'connected' : `${rtt} ms round trip`} · jitter ${Math.round(stats.jitterMs)} ms${stats.frameTiming.p95Ms > 50 ? ' · slow rendering' : ''}`
            : 'Connection to the host lost';
          lastNetworkDisplay = now;
        }
      }
    },
    diagnostics() {
      const arrivals = snapshotArrivals;
      const span = arrivals.length > 1 ? (arrivals.at(-1) - arrivals[0]) / 1000 : 0;
      return { active, role, code, guestJoined, guestReady, hostPrepared, connected: !!conn?.open,
        snapshotRate: span > 0.25 ? Math.round((arrivals.length - 1) / span) : 0,
        prediction: role === 'guest' ? prediction?.metrics() ?? null : null,
        tick: role === 'host' ? room?.tick : latestSnapshot?.tick ?? 0,
        phase: role === 'host' ? hooks.match.state.phase : latestSnapshot?.match.phase,
        epoch: role === 'host' ? room?.epoch : latestSnapshot?.epoch,
        rtt, result: lastResult,
        inputSequence: prediction?.seq ?? 0, pendingInputs: prediction?.pending?.length ?? 0,
        bufferedSnapshots: prediction?.samples?.length ?? 0 };
    }
  };
}
