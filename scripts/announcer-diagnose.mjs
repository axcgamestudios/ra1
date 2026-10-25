// Announcer event verification: run the REAL WASM physics + REAL MatchEvents
// and confirm every announcer event fires: shot, goal, nice_shot, save,
// epic_save, demolition. Node-side, no browser.
import { NativeArena } from '../server/native.mjs';
import { MatchEvents } from '../src/match/match-events.js';
import { STATE_LAYOUT as L, CAR_STATE as C, CAR_STATE_STRIDE as S } from '../src/physics/state-layout.js';

const roster = [{ team: 0, visual: 'fennec' }, { team: 1, visual: 'fennec' }];
const arena = await NativeArena.create(roster, { network: false });
const m = arena.module;
const NEUTRAL = [0, 0, 0, 0, 0, 0, 0, 0];
const drive = slot => m.HEAPF32.set([1, 0, 0, 0, 0, 0, 0, 0], arena.controlsPtr / 4 + slot * 8);
const boostDrive = slot => m.HEAPF32.set([1, 0, 0, 0, 0, 0, 1, 1], arena.controlsPtr / 4 + slot * 8);

const car = slot => arena.state.subarray(L.CARS + slot * S, L.CARS + (slot + 1) * S);
const ballPos = () => [...arena.state.subarray(L.BALL, L.BALL + 3)].map(v => v.toFixed(0));
const ballVel = () => [...arena.state.subarray(L.BALL + 12, L.BALL + 15)].map(v => v.toFixed(0));
const log = (...a) => console.log(...a);
const results = {};
const expect = (name, ok) => { results[name] = ok; log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); };

function placeCar(slot, pos, yaw = 0, extra = {}) {
  // fwd = (cos yaw, sin yaw, 0): yaw = PI/2 faces +Y (towards the orange goal).
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const values = [pos[0], pos[1], pos[2],
    c, s, 0, -s, c, 0, 0, 0, 1,
    extra.vx ?? 0, extra.vy ?? 0, extra.vz ?? 0, 0, 0, 0,
    extra.boost ?? 100, 1, 0, 0, 0, 0, 0];
  m.HEAPF32.set(values, arena.scratch / 4);
  if (m._physics_setCarState(slot, arena.scratch) !== 1) throw new Error('car placement failed');
}
function setBall(pos, vel) {
  arena.setBall([pos[0], pos[1], pos[2], 1, 0, 0, 0, 1, 0, 0, 0, 1, vel[0], vel[1], vel[2], 0, 0, 0]);
}

// ------------------------------------------------- A) low rolling shot + goal ----
log('\n=== A) LOW SHOT (z dips below 0, bounces/rolls in) -> shot + goal + nice_shot ===');
{
  const ev = new MatchEvents([0, 1]);
  placeCar(0, [0, -400, 17], Math.PI / 2);        // facing +Y, behind the ball
  placeCar(1, [900, 3500, 17], -Math.PI / 2);
  setBall([0, 0, 93], [0, 0, 0]);
  for (let i = 0; i < 90; i++) { drive(0); m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8); m._physics_step(1); ev.update(arena.state, 0, 'playing'); }
  log('  attacker touch:', ev.lastTouch);
  setBall([0, 1800, 300], [0, 3000, 0]);          // low shot, arc dips below ground
  const fired = [];
  for (let i = 0; i < 400; i++) {
    m._physics_step(1);
    const goal = arena.goal();
    const out = ev.update(arena.state, goal, 'playing');
    for (const e of out) fired.push(e.kind);
    if (goal) { log('  goal flag at tick', i, 'ball:', ballPos()); break; }
  }
  log('  events fired:', fired);
  expect('shot event (bounce-aware onTarget)', fired.includes('shot'));
  expect('goal event', fired.includes('goal'));
  expect('nice_shot survives until goal tick', fired.includes('nice_shot'));
  expect('shots stat counted', ev.slots[0].shots === 1);
}

// ------------------------------------------------------ B) high shot + goal ----
log('\n=== B) HIGH SHOT (clean arc, no ground) -> shot + goal + nice_shot ===');
{
  const ev = new MatchEvents([0, 1]);
  placeCar(0, [0, -400, 17], Math.PI / 2);
  placeCar(1, [900, 3500, 17], -Math.PI / 2);
  setBall([0, 0, 93], [0, 0, 0]);
  for (let i = 0; i < 90; i++) { drive(0); m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8); m._physics_step(1); ev.update(arena.state, 0, 'playing'); }
  setBall([0, 1800, 900], [0, 3000, 0]);          // airborne arc stays > 0
  const fired = [];
  for (let i = 0; i < 400; i++) {
    m._physics_step(1);
    const goal = arena.goal();
    const out = ev.update(arena.state, goal, 'playing');
    for (const e of out) fired.push(e.kind);
    if (goal) break;
  }
  log('  events fired:', fired);
  expect('shot event (air shot)', fired.includes('shot'));
  expect('nice_shot (air shot)', fired.includes('nice_shot'));
}

// ----------------------------------------------------------------- C) save ----
log('\n=== C) SAVE (defender blocks an on-target shot) ===');
{
  const ev = new MatchEvents([0, 1]);
  placeCar(0, [0, -400, 17], Math.PI / 2);        // attacker behind ball
  placeCar(1, [0, 4700, 17], Math.PI / 2);        // defender in front of own goal
  setBall([0, 0, 93], [0, 0, 0]);
  for (let i = 0; i < 90; i++) { drive(0); m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8); m._physics_step(1); ev.update(arena.state, 0, 'playing'); }
  log('  attacker touch:', ev.lastTouch);
  setBall([0, 2200, 120], [0, 3500, 0]);          // low blast on target
  const fired = [];
  for (let i = 0; i < 300; i++) {
    m._physics_step(1);
    const goal = arena.goal();
    const out = ev.update(arena.state, goal, 'playing');
    for (const e of out) fired.push(`${e.kind}@${i}`);
    if (out.length) log('  tick', i, 'ball:', ballPos(), 'vel:', ballVel());
    if (out.some(e => e.kind === 'save' || e.kind === 'epic_save')) break;
  }
  log('  events fired:', fired);
  expect('save or epic_save fires', fired.some(k => k.startsWith('save') || k.startsWith('epic_save')));
  log('  slot1 saves:', ev.slots[1].saves, 'epicSaves:', ev.slots[1].epicSaves, 'points:', ev.slots[1].points);
}

// ------------------------------------------------------------ D) demolition ----
log('\n=== D) DEMOLITION (supersonic nose hit) ===');
{
  const ev = new MatchEvents([0, 1]);
  placeCar(1, [0, 200, 17], -Math.PI / 2);        // victim stationary
  placeCar(0, [0, -2300, 17], Math.PI / 2);       // attacker charging with boost
  setBall([2560, 2560, 93], [0, 0, 0]);           // ball parked far away
  const fired = [];
  for (let i = 0; i < 600; i++) {
    boostDrive(0); m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8);
    m._physics_step(1);
    const out = ev.update(arena.state, 0, 'playing');
    for (const e of out) fired.push(`${e.kind}@${i}`);
  }
  log('  events fired:', fired);
  expect('demolition event', fired.some(k => k.startsWith('demolition')));
  log('  slot0 demolitions:', ev.slots[0].demolitions, 'points:', ev.slots[0].points, '(0 pts, RL style)');
}

// ---------------------------------------------------------- E) wide = no shot ----
log('\n=== E) WIDE SHOT (misses the mouth) -> no shot event ===');
{
  const ev = new MatchEvents([0, 1]);
  placeCar(0, [0, -400, 17], Math.PI / 2);
  placeCar(1, [900, 3500, 17], -Math.PI / 2);
  setBall([0, 0, 93], [0, 0, 0]);
  for (let i = 0; i < 90; i++) { drive(0); m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8); m._physics_step(1); ev.update(arena.state, 0, 'playing'); }
  setBall([1500, 1800, 900], [1200, 3000, 0]);    // aimed wide of the post
  let shotFired = false;
  for (let i = 0; i < 200; i++) { m._physics_step(1); if (ev.update(arena.state, 0, 'playing').some(e => e.kind === 'shot')) shotFired = true; }
  expect('no shot for a wide ball', !shotFired);
  log('  shots stat:', ev.slots[0].shots);
}

arena.dispose();
log('\n=== RESULTS ===');
const failed = Object.entries(results).filter(([, ok]) => !ok);
log(failed.length === 0 ? 'ALL PASS' : `FAILURES: ${failed.map(([k]) => k).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
