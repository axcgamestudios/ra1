// Peer-to-peer host authority, ported from the dedicated server room.
// The host browser runs the same deterministic WASM physics at 120 Hz, streams
// binary snapshots at 60 Hz to every guest and only ever accepts inputs from
// the guests. Full native checkpoints ride every CHECKPOINT_EVERY-th snapshot
// — 10 Hz for duel rosters, 5 Hz for team rosters (2v2/3v3) to halve the
// checkpoint bandwidth of 4-6 car states.
import { encodeSnapshot, NEUTRAL, SIM_HZ, SNAPSHOT_HZ, INPUT_HZ, validControls, validSequence } from './protocol.js';
import { STATE_LAYOUT } from '../physics/state-layout.js';

const COMMAND_TICKS = SIM_HZ / INPUT_HZ;
const SNAPSHOT_EVERY = SIM_HZ / SNAPSHOT_HZ;
const STALL_MS = 10000;

// The HOST assigns command duration, exactly like the dedicated server did:
// sending more commands can never buy simulation time, and a short startup
// buffer preserves press/release edges when packets arrive together.
export class InputStream {
    constructor({ staleMs = 250, maxCommands = 32 } = {}) {
        this.staleMs = staleMs;
        this.maxCommands = maxCommands;
        this.queue = [];
        this.lastSequence = 0;
        this.seq = 0;
        this.ticks = COMMAND_TICKS;
        this.controls = NEUTRAL;
        this.lastArrival = -Infinity;
        this.firstArrival = null;
        this.started = false;
        this.idle = 0;
    }
    push(seq, controls, now) {
        if (!validSequence(seq) || !validControls(controls) || seq > this.lastSequence + 2400)
            throw new Error('invalid_input');
        if (seq <= this.lastSequence) return false;
        // A burst after a transport stall legitimately fills the queue; drop the
        // stale middle and keep the newest press/release edges instead of
        // rejecting everything until the queue drains.
        if (this.queue.length >= this.maxCommands)
            this.queue.splice(0, this.queue.length - this.maxCommands + 1);
        this.lastSequence = seq;
        this.lastArrival = now;
        this.firstArrival ??= now;
        this.queue.push({ seq, controls: [...controls] });
        return true;
    }
    step(now) {
        if (now - this.lastArrival > this.staleMs) {
            this.clear();
            return NEUTRAL;
        }
        // After a transport stall, do not execute a long backlog of obsolete
        // steering; drop old commands rather than speeding up the authority.
        if (this.queue.length > 6) {
            const dropped = this.queue.splice(0, this.queue.length - 2);
            this.seq = dropped.at(-1).seq;
            this.ticks = COMMAND_TICKS;
        }
        if (!this.started) {
            if (this.queue.length < 2 && now - this.firstArrival < 1000 / INPUT_HZ)
                return NEUTRAL;
            this.started = true;
        }
        if (this.ticks >= COMMAND_TICKS && this.queue.length) {
            const command = this.queue.shift();
            this.seq = command.seq;
            this.controls = command.controls;
            this.ticks = 0;
            this.idle = 0;
        }
        if (this.ticks < COMMAND_TICKS)
            this.ticks++;
        else
            this.idle = Math.min(65535, this.idle + 1);
        return this.controls;
    }
    clear() {
        this.queue.length = 0;
        this.seq = this.lastSequence;
        this.ticks = COMMAND_TICKS;
        this.controls = NEUTRAL;
        this.firstArrival = null;
        this.started = false;
        this.idle = 0;
    }
    metadata() { return { seq: this.seq, ticks: this.ticks, queued: this.queue.length * COMMAND_TICKS + Math.max(0, COMMAND_TICKS - this.ticks), idle: this.idle, controls: this.controls }; }
}

// players: [{ id, name, team, visual }] with slot 0 = host (local) and slots
// 1..N-1 = guests. send(payload) is the legacy broadcast for one guest; for
// team matches pass guests: Map(slot -> { send(payload), congested? }) so each
// data channel gets its own congestion valve.
export class HostRoom {
    constructor({ sim, match, players, send, guests, onEvent, congested, events }) {
        this.sim = sim;
        this.match = match;
        this.players = players;
        this.onEvent = onEvent;
        this.events = events ?? null; // optional MatchEvents authority (stats/announcer)
        // Optional backpressure probe (SCTP bufferedAmount): when a link cannot
        // carry the full snapshot stream, disposable snapshots are skipped so
        // latency stops compounding; the next snapshot carries the full state.
        this.congested = congested ?? (() => false);
        this.guestSlots = players.slice(1).map((_, index) => index + 1);
        this.guests = new Map();
        if (guests) {
            for (const [slot, channel] of guests) this.guests.set(slot, channel);
        } else if (send) {
            this.guests.set(1, { send, congested: this.congested });
        }
        this.streams = new Map(this.guestSlots.map(slot => [slot, new InputStream({ staleMs: 2000 })]));
        this.lastGuestInput = new Map(this.guestSlots.map(slot => [slot, -Infinity]));
        this.nativeCheckpoints = sim.module._physics_netStateVersion?.() === 1;
        this.checkpointEvery = this.guestSlots.length > 1 ? 12 : 6;
        this.active = false;
        this.terminal = false;
        this.tick = 0;
        this.epoch = 0;
        this.acks = this.guestSlots.map(() => 0);
        this.result = null;
        this.localControls = [...NEUTRAL];
        this.hostSeq = 0;
        this.hostTicks = COMMAND_TICKS;
        this.hostControls = [...NEUTRAL];
        this.controlsScratch = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
        this.snapshotCount = 0;
    }
    setLocalControls(values) {
        for (let i = 0; i < 8; i++) this.localControls[i] = values[i];
    }
    guestControlsArray(slot = 1) {
        return this.streams.get(slot)?.controls ?? NEUTRAL;
    }
    touch(slot, now = performance.now()) {
        if (slot === undefined) { for (const s of this.guestSlots) this.lastGuestInput.set(s, now); }
        else if (this.lastGuestInput.has(slot)) this.lastGuestInput.set(slot, now);
    }
    input(slot, seq, epoch, values, now = performance.now()) {
        if (!this.active || this.terminal) return;
        if (Array.isArray(epoch)) { // legacy single-guest call: input(seq, epoch, values)
            values = epoch; epoch = seq; seq = slot; slot = 1;
        }
        if (!this.streams.has(slot)) return;
        if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > this.epoch) return;
        if (epoch !== this.epoch || this.match.state.phase !== 'playing') return;
        if (!validSequence(seq) || !validControls(values)) return;
        const stream = this.streams.get(slot);
        if (seq <= stream.lastSequence || seq > stream.lastSequence + 2400) return;
        try { stream.push(seq, values, now); } catch { return; }
        this.lastGuestInput.set(slot, now);
    }
    applyControls(slot, values) {
        const controls = this.controlsScratch;
        controls.throttle = values[0];
        controls.steer = values[1];
        controls.pitch = values[2];
        controls.yaw = values[3];
        controls.roll = values[4];
        controls.jump = !!values[5];
        controls.boost = !!values[6];
        controls.handbrake = !!values[7];
        this.sim.setControls(slot, controls);
    }
    kickoff() {
        this.active = true;
        this.terminal = false;
        this.result = null;
        this.match.start();
        this.resetArena();
        this.touch();
        this.onEvent?.({ type: 'kickoff' });
        this.sendSnapshot(true);
    }
    resetArena() {
        this.sim.resetKickoff(-1);
        this.epoch++;
        for (const stream of this.streams.values()) stream.clear();
        this.acks = this.guestSlots.map(slot => this.streams.get(slot).seq);
        this.hostSeq = 0;
        this.hostTicks = COMMAND_TICKS;
        this.hostControls = [...NEUTRAL];
        for (let slot = 0; slot < this.players.length; slot++) this.applyControls(slot, NEUTRAL);
    }
    // One authoritative 120 Hz tick. Returns false only when the caller should
    // stop the current catch-up batch (never for regular play).
    step(now = performance.now()) {
        if (!this.active || this.terminal) return true;
        this.tick++;
        const state = this.match.state;
        if (state.phase === 'playing') {
            this.applyControls(0, this.localControls);
            for (const slot of this.guestSlots) {
                const stalled = now - this.lastGuestInput.get(slot) > STALL_MS;
                this.applyControls(slot, stalled ? NEUTRAL : this.streams.get(slot).step(now));
            }
            this.acks = this.guestSlots.map(slot => this.streams.get(slot).seq);
            if (this.hostTicks >= COMMAND_TICKS) {
                this.hostSeq++;
                this.hostControls = [...this.localControls];
                this.hostTicks = 0;
            }
            this.hostTicks++;
            this.sim.step(1);
            const native = this.sim.state;
            if (!native.every(Number.isFinite)) { this.finish(null, 'invalid_simulation'); return true; }
            const goal = this.sim.pollGoal();
            const event = this.match.tick({
                goal,
                ballOnGround: this.sim.ballOnGround,
                kickoffTouched: Math.abs(native[STATE_LAYOUT.BALL]) + Math.abs(native[STATE_LAYOUT.BALL + 1]) > 1
                    || Math.hypot(native[STATE_LAYOUT.BALL + 12], native[STATE_LAYOUT.BALL + 13]) > 1
            });
            if (this.events) {
                const announced = this.events.update(native, goal, state.phase);
                if (announced.length) this.onEvent?.({ type: 'events', events: announced, stats: this.events.summary() });
            }
            if (event === 'kickoff') this.afterGoal();
        } else {
            const event = this.match.tick();
            if (event === 'kickoff') this.afterGoal();
        }
        if (state.phase === 'ended') this.finish(state.winner, 'full_time');
        if (this.tick % SNAPSHOT_EVERY === 0) this.sendSnapshot(false);
        return true;
    }
    afterGoal() {
        this.resetArena();
        this.onEvent?.({ type: 'kickoff' });
        this.sendSnapshot(true);
    }
    snapshotValues() {
        return {
            tick: this.tick,
            epoch: this.epoch,
            time: performance.now(),
            state: this.sim.state,
            match: this.match.state,
            acknowledgements: [this.hostSeq, ...this.acks],
            inputStates: [this.hostMeta(), ...this.guestSlots.map(slot => this.streams.get(slot).metadata())]
        };
    }
    hostMeta() {
        return { seq: this.hostSeq, ticks: Math.min(this.hostTicks, COMMAND_TICKS), queued: 2, idle: 0, controls: this.hostControls };
    }
    sendSnapshot(forceCheckpoint = false) {
        if (!this.guests.size && !this.send) return;
        try {
            const values = this.snapshotValues();
            const withCheckpoint = this.nativeCheckpoints && (forceCheckpoint || this.snapshotCount % this.checkpointEvery === 0);
            // Congestion valve: never queue a plain snapshot behind a backed-up
            // send buffer — that only converts bandwidth shortage into delay.
            // Checkpoint snapshots always pass: reconciliation after the gap
            // needs one.
            if (this.guests.size) {
                this.snapshotCount++;
                const binary = encodeSnapshot(withCheckpoint ? { ...values, checkpoint: this.checkpoint() } : values);
                for (const channel of this.guests.values()) {
                    if (!withCheckpoint && (channel.congested?.() ?? false)) continue;
                    try { channel.send(binary); } catch { /* transient buffer full */ }
                }
                return;
            }
            if (!withCheckpoint && this.congested()) { this.snapshotCount++; return; }
            this.snapshotCount++;
            const binary = encodeSnapshot(withCheckpoint ? { ...values, checkpoint: this.checkpoint() } : values);
            this.send(binary);
        } catch (error) {
            console.warn('p2p snapshot failed', error);
        }
    }
    checkpoint() {
        const module = this.sim.module;
        const pointer = module._physics_captureNetState?.();
        if (!pointer) return null;
        return new Float32Array(module.HEAPF32.buffer, pointer, module._physics_getNetStateSize());
    }
    // A guest's data channel died mid-match: their car stays in the arena and
    // simply goes idle (neutral input) so the remaining players keep playing.
    removeGuest(slot) {
        this.guests.delete(slot);
        this.streams.get(slot)?.clear();
    }
    get guestCount() { return this.guests.size; }
    stalledSlots(now = performance.now()) {
        return this.guestSlots.filter(slot => this.lastGuestInput.get(slot) !== -Infinity && now - this.lastGuestInput.get(slot) > STALL_MS && this.guests.has(slot));
    }
    finish(winner, reason) {
        if (this.terminal) return;
        this.terminal = true;
        if (winner === 0 || winner === 1) {
            this.match.state.phase = 'ended';
            this.match.state.winner = winner;
        }
        this.result = {
            status: winner === 0 || winner === 1 ? 'completed' : 'cancelled',
            winner: winner === 0 || winner === 1 ? winner : null,
            reason,
            blueScore: this.match.state.blueScore,
            orangeScore: this.match.state.orangeScore
        };
        this.active = false;
        if (this.events) {
            try { this.onEvent?.({ type: 'stats', stats: this.events.summary(), final: true }); } catch {}
        }
        try { this.broadcast({ type: 'result', ...this.result, stats: this.events?.summary() ?? null }); } catch {}
        this.sendSnapshot(true);
        this.onEvent?.({ type: 'ended', ...this.result });
    }
    broadcast(payload) {
        if (this.guests.size) {
            for (const channel of this.guests.values()) {
                try { channel.send(payload); } catch {}
            }
        } else {
            try { this.send?.(payload); } catch {}
        }
    }
    guestStalled(now = performance.now()) {
        // Legacy single-guest semantics: true when every connected guest stalled.
        const connected = this.guestSlots.filter(slot => this.guests.has(slot));
        return this.active && !this.terminal && connected.length > 0 && connected.every(slot => {
            const last = this.lastGuestInput.get(slot);
            return last !== -Infinity && now - last > STALL_MS;
        });
    }
    dispose() {
        for (const stream of this.streams.values()) stream.clear();
        this.active = false;
    }
}
