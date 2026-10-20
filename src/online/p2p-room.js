// Peer-to-peer host authority, ported from the dedicated server room.
// The host browser runs the same deterministic WASM physics at 120 Hz, streams
// binary snapshots at 60 Hz and only ever accepts inputs from the guest.
// Full native checkpoints ride every CHECKPOINT_EVERY-th snapshot (10 Hz) —
// reconciliation only needs one after a divergence, not one per packet.
import { encodeSnapshot, NEUTRAL, SIM_HZ, SNAPSHOT_HZ, INPUT_HZ, validControls, validSequence } from './protocol.js';
import { STATE_LAYOUT } from '../physics/state-layout.js';

const COMMAND_TICKS = SIM_HZ / INPUT_HZ;
const SNAPSHOT_EVERY = SIM_HZ / SNAPSHOT_HZ;
const CHECKPOINT_EVERY = 6;
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
        if (this.queue.length >= this.maxCommands) throw new Error('input_backlog');
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

// players: [{ id, name, team, visual }] with slot 0 = host (local) and slot 1 = guest.
// send(payload) dispatches either a JSON message or a binary snapshot to the guest.
export class HostRoom {
    constructor({ sim, match, players, send, onEvent }) {
        this.sim = sim;
        this.match = match;
        this.players = players;
        this.send = send;
        this.onEvent = onEvent;
        this.nativeCheckpoints = sim.module._physics_netStateVersion?.() === 1;
        this.active = false;
        this.terminal = false;
        this.tick = 0;
        this.epoch = 0;
        this.ack = 0;
        this.stream = new InputStream({ staleMs: 500 });
        this.lastGuestInput = -Infinity;
        this.result = null;
        this.localControls = [...NEUTRAL];
        this.hostSeq = 0;
        this.hostTicks = COMMAND_TICKS;
        this.hostControls = [...NEUTRAL];
        this.controlsScratch = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
        this.guestControls = [...NEUTRAL];
        this.snapshotCount = 0;
    }
    setLocalControls(values) {
        for (let i = 0; i < 8; i++) this.localControls[i] = values[i];
    }
    get guestControlsArray() { return this.stream.controls; }
    input(seq, epoch, values, now = performance.now()) {
        if (!this.active || this.terminal) return;
        if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > this.epoch) return;
        if (epoch !== this.epoch || this.match.state.phase !== 'playing') return;
        if (!validSequence(seq) || !validControls(values) || seq > this.stream.lastSequence + 2400) return;
        if (seq <= this.stream.lastSequence) return;
        this.stream.push(seq, values, now);
        this.lastGuestInput = now;
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
        this.lastGuestInput = performance.now();
        this.onEvent?.({ type: 'kickoff' });
        this.sendSnapshot(true);
    }
    resetArena() {
        this.sim.resetKickoff(-1);
        this.epoch++;
        this.stream.clear();
        this.ack = this.stream.seq;
        this.hostSeq = 0;
        this.hostTicks = COMMAND_TICKS;
        this.hostControls = [...NEUTRAL];
        this.applyControls(0, NEUTRAL);
        this.applyControls(1, NEUTRAL);
    }
    // One authoritative 120 Hz tick. Returns false only when the caller should
    // stop the current catch-up batch (never for regular play).
    step(now = performance.now()) {
        if (!this.active || this.terminal) return true;
        this.tick++;
        const state = this.match.state;
        if (state.phase === 'playing') {
            this.applyControls(0, this.localControls);
            const guest = now - this.lastGuestInput > STALL_MS ? NEUTRAL : this.stream.step(now);
            this.applyControls(1, guest);
            this.ack = this.stream.seq;
            if (this.hostTicks >= COMMAND_TICKS) {
                this.hostSeq++;
                this.hostControls = [...this.localControls];
                this.hostTicks = 0;
            }
            this.hostTicks++;
            this.sim.step(1);
            const native = this.sim.state;
            if (!native.every(Number.isFinite)) { this.finish(null, 'invalid_simulation'); return true; }
            const event = this.match.tick({
                goal: this.sim.pollGoal(),
                ballOnGround: this.sim.ballOnGround,
                kickoffTouched: Math.abs(native[STATE_LAYOUT.BALL]) + Math.abs(native[STATE_LAYOUT.BALL + 1]) > 1
                    || Math.hypot(native[STATE_LAYOUT.BALL + 12], native[STATE_LAYOUT.BALL + 13]) > 1
            });
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
            acknowledgements: [this.hostSeq, this.ack],
            inputStates: [this.hostMeta(), this.stream.metadata()]
        };
    }
    hostMeta() {
        return { seq: this.hostSeq, ticks: Math.min(this.hostTicks, COMMAND_TICKS), queued: 2, idle: 0, controls: this.hostControls };
    }
    sendSnapshot(forceCheckpoint = false) {
        if (!this.send) return;
        try {
            const values = this.snapshotValues();
            const withCheckpoint = this.nativeCheckpoints && (forceCheckpoint || this.snapshotCount % CHECKPOINT_EVERY === 0);
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
        try { this.send?.({ type: 'result', ...this.result }); } catch {}
        this.sendSnapshot(true);
        this.onEvent?.({ type: 'ended', ...this.result });
    }
    touch(now = performance.now()) { this.lastGuestInput = now; }
    guestStalled(now = performance.now()) {
        return this.active && !this.terminal && this.lastGuestInput !== -Infinity && now - this.lastGuestInput > STALL_MS;
    }
    dispose() {
        this.stream.clear();
        this.active = false;
    }
}
