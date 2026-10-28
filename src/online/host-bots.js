// Host-side bot drivers for online team matches ("fill with bots"). One
// shared ONNX worker runs every bot — the worker protocol is multi-tenant
// (sessions keyed by botId, messages serialized by id, loads idempotent) —
// so three bots cost one model download and one worker thread, not three.
// Mirrors the offline bot loop: scripted kickoff while available, one async
// inference per tickSkip ticks, and the last action is held while the
// inference is in flight so the 120 Hz authority never stalls.
import { BotController } from '../bots/controller.js';
import { wA } from '../bots/actions.js';
import { controlsArray } from './protocol.js';

export class HostBots {
    constructor() {
        this.states = new Map();   // bot roster id -> driver state
        this.entries = new Map();  // wire slot -> driver state (rebuilt by sync)
        this.worker = null;        // shared worker owned by the first controller
        this.workerOwner = null;   // controller that created (and can kill) the worker
        this.pads = null;          // cached pad info (positions are static)
        this.generation = 0;
    }

    get size() { return this.states.size; }
    // Bots finish loading their policy in the background; the lobby blocks
    // START until this is true so a match never kicks off with frozen cars.
    get ready() {
        for (const state of this.states.values()) if (!state.controller.isReady) return false;
        return true;
    }
    get loadingCount() {
        let count = 0;
        for (const state of this.states.values()) if (!state.controller.isReady && !state.error) count++;
        return count;
    }
    get hasErrors() {
        for (const state of this.states.values()) if (state.error) return true;
        return false;
    }

    // Create the driver state for a roster bot entry. `id` is the stable
    // roster identity so lobby re-ordering never reloads a model.
    add(id, { botId = 'nexto', team = 1 } = {}) {
        if (this.states.has(id)) return false;
        const controller = this.worker
            ? new BotController(botId, { worker: this.worker })
            : new BotController(botId);
        const state = {
            id, botId, team, slot: null, controller,
            action: { ...wA }, array: controlsArray(wA),
            ticks: 0, pending: false, kickTick: 0, generation: this.generation,
            error: null
        };
        this.states.set(id, state);
        // Model load starts immediately (lobby time); loadPolicy creates the
        // worker synchronously, so the FIRST controller's worker is captured
        // here and every later bot reuses it (one model load, one thread).
        const loading = controller.load();
        if (!this.worker && controller.worker) { this.worker = controller.worker; this.workerOwner = controller; }
        if (loading?.catch) loading.catch(error => { state.error = String(error?.message ?? error); });
        return true;
    }

    remove(id) {
        const state = this.states.get(id);
        if (!state) return false;
        this.states.delete(id);
        for (const [slot, entry] of this.entries) if (entry === state) this.entries.delete(slot);
        // Only reset: disposing would terminate a worker other bots still
        // share. The shared worker dies in dispose(), with the whole session.
        try { state.controller.reset(); } catch {}
        return true;
    }

    // Rebuild the slot -> state mapping after any roster mutation. Wire slots
    // are array positions in the (re-indexed) roster.
    sync(roster) {
        this.entries = new Map();
        for (const player of roster ?? []) {
            if (!player?.bot) continue;
            const state = this.states.get(player.id);
            if (state) { state.team = player.team; state.slot = player.slot; this.entries.set(player.slot, state); }
        }
    }

    // One 120 Hz tick for a bot slot: returns the controls array to apply.
    // `sim` is the authoritative online simulation.
    tick(slot, sim) {
        const state = this.entries.get(slot);
        if (!state) return null;
        if (!state.controller.isReady) return state.array; // hold neutral until the policy loads
        const scripted = state.controller.getKickoffControls(sim.state, state.kickTick);
        if (scripted) {
            state.action = scripted;
            state.array = controlsArray(scripted);
            state.controller.overrideControls(scripted);
            state.kickTick++;
            return state.array;
        }
        if (state.ticks === 0 && !state.pending) this.decide(state, sim);
        if (state.ticks > 0) state.ticks--;
        return state.array;
    }

    decide(state, sim) {
        state.pending = true;
        const generation = this.generation;
        if (!this.pads) this.pads = sim.getPads();
        state.controller.decide(sim.state, this.pads, state.slot, state.team)
            .then(controls => {
                if (generation === this.generation && this.states.get(state.id) === state) {
                    state.action = controls;
                    state.array = controlsArray(controls);
                    state.ticks = state.controller.option.tickSkip;
                }
            })
            .catch(() => { state.error = state.controller.error; })
            .finally(() => { state.pending = false; });
    }

    // Snapshot metadata: guests read these controls to animate bot boost
    // flames and audio exactly like any remote player.
    controlsArrayAt(slot) {
        return this.entries.get(slot)?.array ?? controlsArray(wA);
    }

    onReset() {
        this.generation++;
        for (const state of this.states.values()) {
            state.action = { ...wA };
            state.array = controlsArray(wA);
            state.ticks = 0;
            state.kickTick = 0;
            state.pending = false;
        }
    }

    dispose() {
        for (const state of this.states.values()) {
            try { state.controller.dispose(); } catch {}
        }
        // Sharing controllers leave the worker alive on dispose; make sure
        // the one shared worker always dies with this session.
        try { this.worker?.terminate(); } catch {}
        this.states.clear();
        this.entries.clear();
        this.worker = null;
        this.workerOwner = null;
        this.pads = null;
    }
}
