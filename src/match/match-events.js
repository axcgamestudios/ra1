// Match events and scoring for the announcer/stats system ("GOAL!", "What a
// save!", "Shot on goal!", "Demolition!", Rocket Ball-style points). Consumed
// by every authority: offline bots, free play and the P2P host (which
// broadcasts events to guests).
//
// Physics coordinates: X/Y horizontal, Z up, so the goal axis is Y. Rocket
// Rocket Ball goal geometry in uu: goal line |Y| = 5120, mouth half width 893,
// crossbar 643, ball radius 92.75, ball gravity 650 uu/s².
import { STATE_LAYOUT, CAR_STATE, CAR_STATE_STRIDE } from '../physics/state-layout.js';

const GOAL_Y = 5120;
const GOAL_HALF_WIDTH = 893 + 30;   // a post-bound ball still reads "on target"
const GOAL_HEIGHT = 643 + 45;
const GRAVITY = 650;
const BALL_RADIUS = 92.75;
const BOUNCE_RESTITUTION = 0.6;     // RocketSim ball ground restitution
const ROLL_SPEED = 220;             // below this bounce speed the ball rolls
const ON_TARGET_MAX_TIME = 2.5;     // seconds of look-ahead
const ARENA_HALF_WIDTH = 4096;      // side walls: banked shots read off target
const ON_TARGET_MIN_SPEED = 600;    // uu/s along the goal axis
const EPIC_SAVE_TIME = 0.55;        // seconds to impact
const EPIC_SAVE_DISTANCE = 1800;    // uu from the goal plane
const ASSIST_WINDOW_TICKS = 1200;   // 10 s at 120 Hz

const POINTS = Object.freeze({ goal: 100, assist: 50, save: 50, epicSave: 75, shot: 20, demolition: 0 });

// teams: array mapping physics slot -> team (0 blue / 1 orange).
export class MatchEvents {
  constructor(teams = [0, 1]) {
    this.reset(teams);
  }
  reset(teams = this.teams) {
    this.teams = [...teams];
    this.slots = this.teams.map((team, slot) => ({ slot, team, goals: 0, assists: 0, saves: 0, epicSaves: 0, shots: 0, demolitions: 0, ownGoals: 0, points: 0 }));
    this.serials = this.teams.map(() => -1);
    this.demoTimers = this.teams.map(() => 0);
    this.touches = [];        // [{ slot, tick }]
    this.lastTouch = null;
    this.pendingShot = null;  // { toward, shooter, shooterTeam, counted, timeToGoal }
    this.wasPhase = null;
    this.goalCount = 0;
  }
  // Returns the events produced this tick: [{ kind, slot, team, ownGoal?, tick }]
  update(state, goalFlag = 0, phase = 'playing') {
    const events = [];
    const tick = state[STATE_LAYOUT.TICK] ?? 0;
    const carCount = Math.min(this.slots.length, Math.max(0, state[STATE_LAYOUT.NUM_CARS] ?? this.slots.length));

    // 1) Car/ball touches: each slot's BALL_HIT_SERIAL increments on contact.
    let touched = false;
    for (let slot = 0; slot < carCount; slot++) {
      const serial = state[STATE_LAYOUT.CARS + slot * CAR_STATE_STRIDE + CAR_STATE.BALL_HIT_SERIAL];
      if (serial !== this.serials[slot]) {
        this.serials[slot] = serial;
        if (serial > 0) {
          this.touches.push({ slot, tick });
          if (this.touches.length > 12) this.touches.shift();
          this.lastTouch = slot;
          touched = true;
        }
      }
    }

    // 1b) Demolitions: DEMOED is the respawn countdown; a 0 -> positive edge
    //     means the car was just demolished. Credit the nearest supersonic
    //     rival (in practice the only car that can be there).
    for (let slot = 0; slot < carCount; slot++) {
      const timer = state[STATE_LAYOUT.CARS + slot * CAR_STATE_STRIDE + CAR_STATE.DEMOED];
      if (timer > 0 && this.demoTimers[slot] <= 0 && phase === 'playing') {
        const attacker = this.findDemolisher(state, slot, carCount);
        if (attacker !== null && attacker !== slot) {
          this.slots[attacker].demolitions++;
          this.slots[attacker].points += POINTS.demolition;
          events.push({ kind: 'demolition', slot: attacker, victim: slot, team: this.teams[attacker], tick });
        }
      }
      this.demoTimers[slot] = timer;
    }

    // 2) Is the ball on target, and towards whose goal?
    const target = phase === 'playing' ? onTarget(state) : null;

    // 3) Save: a defender touched while a shot threatened their goal and the
    //    ball is no longer on target afterwards. A deflection that still goes
    //    in (goalFlag set this tick) is NOT a save.
    if (this.pendingShot && touched && this.lastTouch !== null && this.teams[this.lastTouch] === this.pendingShot.toward && !goalFlag) {
      if (!target || target.toward !== this.pendingShot.toward) {
        const ballY = state[STATE_LAYOUT.BALL + 1];
        const nearPlane = GOAL_Y - Math.abs(ballY);
        const epic = this.pendingShot.timeToGoal <= EPIC_SAVE_TIME || nearPlane <= EPIC_SAVE_DISTANCE;
        const slot = this.slots[this.lastTouch];
        if (epic) { slot.epicSaves++; slot.points += POINTS.epicSave; }
        else { slot.saves++; slot.points += POINTS.save; }
        events.push({ kind: epic ? 'epic_save' : 'save', slot: this.lastTouch, team: slot.team, tick });
        this.pendingShot = null;
      }
    }

    // 4) Goal: pollGoal() -> 1 means blue scored (ball entered orange's goal),
    //    2 means orange scored. Runs BEFORE the pending-shot housekeeping so
    //    the shooter keeps "Nice shot!" credit on the very tick the ball
    //    leaves the on-target corridor.
    if ((goalFlag === 1 || goalFlag === 2) && phase === 'playing') {
      const scoringTeam = goalFlag === 1 ? 0 : 1;
      this.goalCount++;
      const scorer = this.lastTouch;
      if (scorer !== null && this.slots[scorer]) {
        if (this.teams[scorer] === scoringTeam) {
          this.slots[scorer].goals++;
          this.slots[scorer].points += POINTS.goal;
          events.push({ kind: 'goal', slot: scorer, team: scoringTeam, ownGoal: false, tick });
          if (this.pendingShot?.counted && this.pendingShot.shooter === scorer)
            events.push({ kind: 'nice_shot', slot: scorer, team: scoringTeam, tick });
          const assist = this.findAssist(scorer, scoringTeam, tick);
          if (assist !== null) {
            this.slots[assist].assists++;
            this.slots[assist].points += POINTS.assist;
            events.push({ kind: 'great_pass', slot: assist, team: scoringTeam, tick });
            if (events.some(event => event.kind === 'nice_shot'))
              events.push({ kind: 'what_a_play', slot: scorer, team: scoringTeam, tick });
          }
        } else {
          this.slots[scorer].ownGoals++;
          events.push({ kind: 'goal', slot: scorer, team: scoringTeam, ownGoal: true, tick });
        }
      } else {
        events.push({ kind: 'goal', slot: null, team: scoringTeam, ownGoal: false, tick });
      }
      this.pendingShot = null;
    }

    // 5) Register or refresh the pending shot while the ball is on target.
    if (target && this.lastTouch !== null && phase === 'playing') {
      if (!this.pendingShot || this.pendingShot.toward !== target.toward) {
        const shooterTeam = this.teams[this.lastTouch];
        const counted = shooterTeam !== target.toward;
        this.pendingShot = { toward: target.toward, shooter: this.lastTouch, shooterTeam, counted, timeToGoal: target.timeToGoal };
        if (counted) {
          this.slots[this.lastTouch].shots++;
          this.slots[this.lastTouch].points += POINTS.shot;
          events.push({ kind: 'shot', slot: this.lastTouch, team: shooterTeam, tick });
        }
      } else {
        // Redirect while still on target: credit moves to the latest toucher.
        if (this.pendingShot.shooter !== this.lastTouch) {
          this.pendingShot.shooter = this.lastTouch;
          this.pendingShot.shooterTeam = this.teams[this.lastTouch];
          if (!this.pendingShot.counted && this.pendingShot.shooterTeam !== target.toward) {
            this.pendingShot.counted = true;
            this.slots[this.lastTouch].shots++;
            this.slots[this.lastTouch].points += POINTS.shot;
            events.push({ kind: 'shot', slot: this.lastTouch, team: this.pendingShot.shooterTeam, tick });
          }
        }
        this.pendingShot.timeToGoal = target.timeToGoal;
      }
    } else if (this.pendingShot && !target) {
      // Off target without a save. Keep the shot alive while the ball is still
      // crossing the goal plane: the native goal flag lags the line crossing
      // by up to a ball radius, and clearing eagerly would strip the shooter
      // of the "Nice shot!" call on the goal tick itself.
      const ballY = state[STATE_LAYOUT.BALL + 1];
      const vy = state[STATE_LAYOUT.BALL + CAR_STATE.VEL + 1];
      const approaching = this.pendingShot.toward === 1 ? vy > 0 : vy < 0;
      const inGoalRegion = Math.abs(ballY) >= GOAL_Y - BALL_RADIUS;
      if (!approaching || !inGoalRegion) this.pendingShot = null;
    }

    // 6) Fresh kickoff clears the play: touch history and any pending shot.
    if (phase === 'kickoff' && this.wasPhase !== 'kickoff') {
      this.touches.length = 0;
      this.lastTouch = null;
      this.pendingShot = null;
    }
    this.wasPhase = phase;
    return events;
  }
  findAssist(scorer, scoringTeam, tick) {
    for (let index = this.touches.length - 1; index >= 0; index--) {
      const touch = this.touches[index];
      if (touch.slot === scorer) continue;
      if (tick - touch.tick > ASSIST_WINDOW_TICKS) return null;
      if (this.teams[touch.slot] === scoringTeam) return touch.slot;
    }
    return null;
  }
  // The demolisher is the closest other car, preferring supersonic ones (a
  // demolition requires a supersonic nose in Rocket Ball).
  findDemolisher(state, victim, carCount) {
    const vx = state[STATE_LAYOUT.CARS + victim * CAR_STATE_STRIDE + CAR_STATE.POS];
    const vy = state[STATE_LAYOUT.CARS + victim * CAR_STATE_STRIDE + CAR_STATE.POS + 1];
    let best = null, bestScore = Infinity;
    for (let slot = 0; slot < carCount; slot++) {
      if (slot === victim) continue;
      const base = STATE_LAYOUT.CARS + slot * CAR_STATE_STRIDE;
      const dx = state[base + CAR_STATE.POS] - vx, dy = state[base + CAR_STATE.POS + 1] - vy;
      const distance = Math.hypot(dx, dy);
      const supersonic = state[base + CAR_STATE.SUPERSONIC] === 1;
      const score = supersonic ? distance : distance + 5000; // prefer supersonic
      if (score < bestScore) { bestScore = score; best = slot; }
    }
    return best;
  }
  summary() {
    return { slots: this.slots.map(slot => ({ ...slot })) };
  }
}

// Ballistic "would it cross the goal line inside the mouth" test, bounce and
// roll aware: a low shot dips below ground before the line, bounces and still
// goes in, so the straight arc alone would wrongly reject most real shots.
function onTarget(state) {
  const ball = STATE_LAYOUT.BALL;
  const y = state[ball + 1], vy = state[ball + CAR_STATE.VEL + 1]; // uu/s
  if (Math.abs(vy) < ON_TARGET_MIN_SPEED) return null;
  const targetY = vy > 0 ? GOAL_Y : -GOAL_Y;
  const time = (targetY - y) / vy;
  if (time < 0 || time > ON_TARGET_MAX_TIME) return null;
  const x = state[ball], vx = state[ball + CAR_STATE.VEL];
  // A ball that banks off a side wall first is not a straight shot on goal.
  if (Math.abs(vx) > 1) {
    const wallX = vx > 0 ? ARENA_HALF_WIDTH : -ARENA_HALF_WIDTH;
    const tWall = (wallX - x) / vx;
    if (tWall > 0 && tWall < time) return null;
  }
  const crossX = x + vx * time;
  if (Math.abs(crossX) > GOAL_HALF_WIDTH) return null;
  // Integrate the vertical arc in coarse steps, clamping ground bounces.
  const dt = 1 / 30;
  let z = state[ball + 2], vz = state[ball + CAR_STATE.VEL + 2];
  for (let t = 0; t < time; t += dt) {
    vz -= GRAVITY * dt;
    z += vz * dt;
    if (z < BALL_RADIUS) {
      z = BALL_RADIUS;
      vz = -vz * BOUNCE_RESTITUTION;
      if (Math.abs(vz) < ROLL_SPEED) vz = 0; // settles into a roll
    }
  }
  if (z < 0 || z > GOAL_HEIGHT) return null;
  return { toward: vy > 0 ? 1 : 0, timeToGoal: time };
}
