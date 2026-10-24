// Match events and scoring for the announcer/stats system ("GOAL!", "What a
// save!", Rocket League-style points). Consumed by every authority: offline
// bots, free play and the P2P host (which broadcasts events to guests).
//
// Physics coordinates: X/Y horizontal, Z up, so the goal axis is Y. Rocket
// League goal geometry in uu: goal line |Y| = 5120, mouth half width 893,
// crossbar 643, ball radius 92.75, ball gravity 650 uu/s².
import { STATE_LAYOUT, CAR_STATE, CAR_STATE_STRIDE } from '../physics/state-layout.js';

const GOAL_Y = 5120;
const GOAL_HALF_WIDTH = 893 + 30;   // a post-bound ball still reads "on target"
const GOAL_HEIGHT = 643 + 45;
const GRAVITY = 650;
const ON_TARGET_MAX_TIME = 1.75;    // seconds of look-ahead
const ON_TARGET_MIN_SPEED = 600;    // uu/s along the goal axis
const EPIC_SAVE_TIME = 0.55;        // seconds to impact
const EPIC_SAVE_DISTANCE = 1800;    // uu from the goal plane
const ASSIST_WINDOW_TICKS = 1200;   // 10 s at 120 Hz

const POINTS = Object.freeze({ goal: 100, assist: 50, save: 50, epicSave: 75, shot: 20 });

// teams: array mapping physics slot -> team (0 blue / 1 orange).
export class MatchEvents {
  constructor(teams = [0, 1]) {
    this.reset(teams);
  }
  reset(teams = this.teams) {
    this.teams = [...teams];
    this.slots = this.teams.map((team, slot) => ({ slot, team, goals: 0, assists: 0, saves: 0, epicSaves: 0, shots: 0, ownGoals: 0, points: 0 }));
    this.serials = this.teams.map(() => -1);
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

    // 2) Is the ball on target, and towards whose goal?
    const target = phase === 'playing' ? onTarget(state) : null;

    // 3) Save: a defender touched while a shot threatened their goal and the
    //    ball is no longer on target afterwards.
    if (this.pendingShot && touched && this.lastTouch !== null && this.teams[this.lastTouch] === this.pendingShot.toward) {
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

    // 4) Register or refresh the pending shot while the ball is on target.
    if (target && this.lastTouch !== null && phase === 'playing') {
      if (!this.pendingShot || this.pendingShot.toward !== target.toward) {
        const shooterTeam = this.teams[this.lastTouch];
        const counted = shooterTeam !== target.toward;
        this.pendingShot = { toward: target.toward, shooter: this.lastTouch, shooterTeam, counted, timeToGoal: target.timeToGoal };
        if (counted) { this.slots[this.lastTouch].shots++; this.slots[this.lastTouch].points += POINTS.shot; }
      } else {
        // Redirect while still on target: credit moves to the latest toucher.
        if (this.pendingShot.shooter !== this.lastTouch) {
          this.pendingShot.shooter = this.lastTouch;
          this.pendingShot.shooterTeam = this.teams[this.lastTouch];
          if (!this.pendingShot.counted && this.pendingShot.shooterTeam !== target.toward) {
            this.pendingShot.counted = true;
            this.slots[this.lastTouch].shots++;
            this.slots[this.lastTouch].points += POINTS.shot;
          }
        }
        this.pendingShot.timeToGoal = target.timeToGoal;
      }
    } else if (this.pendingShot && !target) {
      // Off target without a save: the shot stat stands, nothing to announce.
      this.pendingShot = null;
    }

    // 5) Goal: pollGoal() -> 1 means blue scored (ball entered orange's goal),
    //    2 means orange scored.
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
  summary() {
    return { slots: this.slots.map(slot => ({ ...slot })) };
  }
}

// Ballistic "would it cross the goal line inside the mouth" test.
function onTarget(state) {
  const ball = STATE_LAYOUT.BALL;
  const y = state[ball + 1], vy = state[ball + CAR_STATE.VEL + 1] * 1; // uu/s
  if (Math.abs(vy) < ON_TARGET_MIN_SPEED) return null;
  const targetY = vy > 0 ? GOAL_Y : -GOAL_Y;
  const time = (targetY - y) / vy;
  if (time < 0 || time > ON_TARGET_MAX_TIME) return null;
  const x = state[ball] + state[ball + CAR_STATE.VEL] * time;
  if (Math.abs(x) > GOAL_HALF_WIDTH) return null;
  const z = state[ball + 2] + state[ball + CAR_STATE.VEL + 2] * time - 0.5 * GRAVITY * time * time;
  if (z < 0 || z > GOAL_HEIGHT) return null;
  return { toward: vy > 0 ? 1 : 0, timeToGoal: time };
}
