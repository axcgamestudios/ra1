// Demolition respawn check: collide two cars at supersonic, then verify the
// DEMOED flag clears and the car REAPPEARS at a spawn point within a few
// seconds. If DEMOED sticks at 1, the car stays invisible forever — the
// reported bug.
import { NativeArena } from '../server/native.mjs';
import { STATE_LAYOUT as L, CAR_STATE as C, CAR_STATE_STRIDE as S } from '../src/physics/state-layout.js';

const roster = [{ team: 0, visual: 'fennec' }, { team: 1, visual: 'fennec' }];
const arena = await NativeArena.create(roster, { network: false });
const m = arena.module;
const NEUTRAL = [0, 0, 0, 0, 0, 0, 0, 0];
const fullDrive = (slot, boost) => m.HEAPF32.set([1, 0, 0, 0, 0, 0, 0, boost ? 1 : 0, 0], arena.controlsPtr / 4 + slot * 8);

function placeCar(slot, pos, yaw = 0, extra = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const values = [pos[0], pos[1], pos[2],
    c, s, 0, -s, c, 0, 0, 0, 1,
    extra.vx ?? 0, extra.vy ?? 0, extra.vz ?? 0, 0, 0, 0,
    extra.boost ?? 100, 1, 0, 0, 0, 0, 0];
  m.HEAPF32.set(values, arena.scratch / 4);
  if (m._physics_setCarState(slot, arena.scratch) !== 1) throw new Error('car placement failed');
}

const carState = slot => arena.state.subarray(L.CARS + slot * S, L.CARS + (slot + 1) * S);
const demoed = slot => carState(slot)[C.DEMOED];
const pos = slot => [...carState(slot).subarray(0, 3)].map(v => Math.round(v));

// Attacker supersonic heading -Y; victim parked in its path facing +Y.
placeCar(0, [0, 1500, 17], -Math.PI / 2, { vy: -2300 });
placeCar(1, [0, 0, 17], Math.PI / 2);
m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4);
m.HEAPF32.set(NEUTRAL, arena.controlsPtr / 4 + 8);

console.log('t=0   demoed0:', demoed(0), 'demoed1:', demoed(1), 'pos0:', pos(0), 'pos1:', pos(1));
let hit = -1;
for (let i = 0; i < 600; i++) {
  fullDrive(0, true); // keep boosting through the victim
  m._physics_step(1);
  if (demoed(1) === 1 && hit < 0) hit = i;
  if (i % 60 === 0 || (hit >= 0 && i - hit < 5))
    console.log(`tick ${String(i).padStart(3)}  demoed0: ${demoed(0)}  demoed1: ${demoed(1)}  pos0: [${pos(0)}]  pos1: [${pos(1)}]`);
}
console.log('demolition at tick:', hit);
console.log('final demoed1:', demoed(1), '— must be 0 (respawned)');
console.log(demoed(1) === 0 && hit >= 0 ? 'PASS: demolished car respawns' : (hit < 0 ? 'NOTE: no demolition occurred' : 'FAIL: car stuck demolished (invisible forever)'));
