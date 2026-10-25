import { SIM_HZ } from './protocol.js';
import { clamp, interpolateState, extrapolateState } from './pose.js';
// A monotonic SERVER-tick playback timeline. Arrival jitter is a buffer-sizing
// signal, never the time coordinate used to interpolate between physics states.
export class SnapshotBuffer {
    constructor() { this.samples = []; this.epoch = -1; this.playhead = null; this.lastRender = null; this.jitterMs = 0; this.delayMs = 30; this.underflows = 0; this.rejected = 0; this.rebases = 0; this.ageMs = 0; this.extrapolations = 0; this.extrapolatedMs = 0; this.deviationRing = new Float32Array(32); this.deviationCount = 0; this.deviationCursor = 0; this.cadenceMs = 0; }
    add(snapshot, state, now) {
        const last = this.samples.at(-1), time = snapshot.tick * 1000 / SIM_HZ;
        if (last && (snapshot.epoch < this.epoch || snapshot.epoch === this.epoch && snapshot.tick <= last.tick)) {
            this.rejected++;
            return;
        }
        if (snapshot.epoch !== this.epoch) {
            this.samples.length = 0;
            this.epoch = snapshot.epoch;
            this.playhead = null;
            this.lastRender = null;
            this.jitterMs = 0;
            this.delayMs = 30;
            this.deviationCount = this.deviationCursor = 0;
            this.cadenceMs = 0;
        }
        else if (last) {
            // Inter-arrival deviation from the simulation-time gap: the true
            // jitter the buffer must absorb. An EMA alone forgets spikes too
            // slowly and never represents bursts; a recent-window percentile
            // captures them and fades after ~half a second.
            const deviation = Math.min(200, Math.abs((now - last.arrival) - (time - last.time)));
            this.jitterMs += .1 * (deviation - this.jitterMs);
            this.deviationRing[this.deviationCursor++ % this.deviationRing.length] = deviation;
            this.deviationCount = Math.min(this.deviationRing.length, this.deviationCount + 1);
            this.cadenceMs += .2 * ((time - last.time) - this.cadenceMs);
        }
        // Buffer depth follows the stream itself: one and a half snapshot
        // cadences of headroom (a 60 Hz stream needs ~30 ms, a 20 Hz stream
        // ~75 ms) plus twice the measured jitter, clamped to keep bad links
        // smooth-late instead of teleporting.
        this.delayMs = clamp(Math.max(30, this.cadenceMs * 1.5) + this.jitter() * 2, 30, 200);
        this.samples.push({ state, time, tick: snapshot.tick, arrival: now });
        if (this.samples.length > 48)
            this.samples.shift();
    }
    jitter() {
        // p90 of the recent deviations, never below the smoothed EMA.
        if (!this.deviationCount)
            return this.jitterMs;
        const window = Array.from(this.deviationRing.subarray(0, this.deviationCount)).sort((a, b) => a - b);
        return Math.max(this.jitterMs, window[Math.min(window.length - 1, Math.floor(window.length * .9))]);
    }
    render(now, out) {
        const newest = this.samples.at(-1);
        if (!newest)
            return false;
        const dt = this.lastRender === null ? 0 : clamp(now - this.lastRender, 0, 100);
        this.lastRender = now;
        const desired = newest.time + Math.max(0, now - newest.arrival) - this.delayMs;
        if (this.playhead === null)
            this.playhead = desired;
        else if (desired - this.playhead > Math.max(400, this.delayMs + 150)
            || this.playhead < this.samples[0].time - this.delayMs) {
            // Suspension/alt-tab recovery is an explicit rebase, not a hidden
            // many-second slowdown. Ordinary jitter still uses monotonic slew.
            this.playhead = Math.min(newest.time, desired); this.rebases++;
        }
        else {
            // Proportional catch-up: ±8 ms is on-time (exact speed); beyond
            // that the playhead slews up to 18% fast / 10% slow, so a burst of
            // snapshots recovers in about a second instead of either crawling
            // (5% cap) or snapping forward (rebase teleport).
            const error = desired - this.playhead;
            this.playhead += dt * (Math.abs(error) < 8 ? 1 : clamp(1 + error / 500, .9, 1.18));
        }
        // Starved timeline: rather than freezing on the newest sample (the
        // classic stutter-step), dead-reckon a short distance along confirmed
        // velocities. Long gaps still clamp — never blindly extrapolate rigid
        // bodies through walls. The budget scales with the buffer delay so
        // low-cadence (30 Hz team) streams keep moving through hiccups.
        if (this.playhead > newest.time) {
            const overshoot = this.playhead - newest.time, budget = Math.min(110, 45 + this.delayMs / 2);
            if (overshoot <= budget) {
                this.extrapolations++;
                this.extrapolatedMs += overshoot;
                extrapolateState(out, newest.state, overshoot / 1000);
                this.ageMs = 0;
                return true;
            }
            this.underflows++;
            this.playhead = newest.time;
        }
        this.ageMs = Math.max(0, newest.time - this.playhead);
        let lower = this.samples[0], upper = lower;
        for (let i = 1; i < this.samples.length; i++) {
            upper = this.samples[i];
            if (upper.time >= this.playhead)
                break;
            lower = upper;
        }
        const span = upper.time - lower.time, t = span > 0 ? clamp((this.playhead - lower.time) / span, 0, 1) : 1;
        interpolateState(out, lower.state, upper.state, t, span / 1000);
        return true;
    }
    clear() { this.samples.length = 0; this.playhead = this.lastRender = null; this.epoch = -1; this.jitterMs = 0; this.delayMs = 30; this.deviationCount = this.deviationCursor = 0; this.cadenceMs = 0; }
}
