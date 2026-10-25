import { createSettingsStore, isRecord, readChoice, readNumber } from '../core/settings-store.js';

export const GARAGE_CARS = Object.freeze([
  { id: 'fennec', label: 'Fennec' },
  { id: 'octane-original', label: 'Octane Original' },
  { id: 'challenger', label: 'Dodge Challenger SRT8' },
  { id: 'spectre', label: 'Spectre' },
  { id: 'vesper', label: 'Vesper' },
  { id: 'amethyst', label: 'Amethyst' },
]);
export const CAR_FINISHES = Object.freeze({
  original: { label: 'Original pearl', roughness: .38, metalness: .73, clearcoat: 1 },
  glossy: { label: 'Glossy', roughness: .22, metalness: .3, clearcoat: 1 },
  metallic: { label: 'Metallic', roughness: .32, metalness: .92, clearcoat: .8 },
  matte: { label: 'Matte', roughness: .85, metalness: .08, clearcoat: 0 },
  custom: { label: 'Custom', roughness: .38, metalness: .73, clearcoat: 1 },
});
// Calcomanías: shader-drawn patterns in car-local space. The numeric ids map
// 1:1 to the decalPattern() branches in the car fragment shader.
export const CAR_DECALS = Object.freeze({
  none: { label: 'Clean', id: 0 },
  stripes: { label: 'Racing Stripes', id: 1 },
  twin: { label: 'Twin Stripe', id: 2 },
  hex: { label: 'Hex Tech', id: 3 },
  camo: { label: 'Camo', id: 4 },
  checker: { label: 'Checker', id: 5 },
  split: { label: 'Diagonal Split', id: 6 },
  flames: { label: 'Flames', id: 7 },
  circuit: { label: 'Circuit', id: 8 },
  wrap: { label: 'Roof Wrap', id: 9 },
});
export const DECAL_IDS = Object.freeze(Object.fromEntries(
  Object.entries(CAR_DECALS).map(([key, value]) => [key, value.id])));
export const GOAL_EXPLOSIONS = Object.freeze({
  classic: { label: 'Classic Burst' },
  fireworks: { label: 'Fireworks' },
  fountain: { label: 'Fountain' },
  rings: { label: 'Ring Ceremony' },
  nova: { label: 'Nova Flash' },
  confetti: { label: 'Confetti' },
});
const readColor = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
export const DEFAULT_CAR_MATERIAL = Object.freeze({ primary:'#007bff', pearl:'#007bff', finish:'glossy', roughness:.22, metalness:.35, clearcoat:1,
  decal:'none', decalColor:'#ffffff', decalScale:1 });
export const TEAM_CAR_COLORS = Object.freeze({
  blue: Object.freeze({ primary: '#007bff', pearl: '#007bff', boostColor: '#007bff' }),
  orange: Object.freeze({ primary: '#ff8c00', pearl: '#ff8c00', boostColor: '#ff8c00' }),
});
const defaultPaint = team => ({ ...DEFAULT_CAR_MATERIAL, ...TEAM_CAR_COLORS[team] });
const defaults = () => Object.fromEntries(GARAGE_CARS.map(({ id }) => [id, { blue: defaultPaint('blue'), orange: defaultPaint('orange') }]));
export const carCustomizationStore = createSettingsStore('rocket-arena.garage-paint.v2', defaults, (result, raw) => {
  for (const { id } of GARAGE_CARS) for (const team of ['blue', 'orange']) {
    const source = raw[id]?.[team], target = result[id][team];
    if (!isRecord(source)) continue;
    for (const key of ['primary', 'pearl', 'boostColor', 'decalColor']) target[key] = readColor(source[key], target[key]);
    target.finish = readChoice(source.finish, Object.keys(CAR_FINISHES), target.finish);
    target.decal = readChoice(source.decal, Object.keys(CAR_DECALS), target.decal);
    for (const key of ['roughness', 'metalness', 'clearcoat']) target[key] = readNumber(source[key], target[key], { min: key === 'roughness' ? .08 : 0, max: 1 });
    target.decalScale = readNumber(source.decalScale, target.decalScale, { min: .25, max: 3 });
  }
});
// Goal explosion customization is a per-team garage setting shared by every
// car: it describes the celebration, not the body.
export const TEAM_EXPLOSIONS = Object.freeze({
  blue: Object.freeze({ style: 'classic', primary: '#55baff', secondary: '#ffffff', intensity: 1 }),
  orange: Object.freeze({ style: 'classic', primary: '#ffab47', secondary: '#ffffff', intensity: 1 }),
});
const explosionDefaults = () => ({ blue: { ...TEAM_EXPLOSIONS.blue }, orange: { ...TEAM_EXPLOSIONS.orange } });
export const goalExplosionStore = createSettingsStore('rocket-arena.goal-explosion.v1', explosionDefaults, (result, raw) => {
  for (const team of ['blue', 'orange']) {
    const source = raw[team], target = result[team];
    if (!isRecord(source)) continue;
    target.style = readChoice(source.style, Object.keys(GOAL_EXPLOSIONS), target.style);
    for (const key of ['primary', 'secondary']) target[key] = readColor(source[key], target[key]);
    target.intensity = readNumber(source.intensity, target.intensity, { min: .4, max: 2 });
  }
});
const listeners = new Set();
const teamKey = team => team === 1 || team === 'orange' ? 'orange' : 'blue';
export const normalizeGarageCar = id => GARAGE_CARS.some(car => car.id === id) ? id : 'fennec';
export function getCarCustomization(carId, team = 'blue') {
  return { ...DEFAULT_CAR_MATERIAL, ...carCustomizationStore.load()[normalizeGarageCar(carId)][teamKey(team)] };
}
export function saveCarCustomization(carId, team, patch) {
  const id = normalizeGarageCar(carId), key = teamKey(team), saved = carCustomizationStore.load();
  Object.assign(saved[id][key], patch);
  carCustomizationStore.save(saved);
  const customization = getCarCustomization(id, key);
  // Save the validated form as well, so malformed values never persist.
  saved[id][key] = customization; carCustomizationStore.save(saved);
  for (const listener of listeners) listener({ carId: id, team: key, customization });
  return customization;
}
// Resolved explosion spec for the arena effects kit (numeric colors).
export function goalExplosionSpec(team = 0) {
  const saved = goalExplosionStore.load()[teamKey(team)];
  return {
    style: GOAL_EXPLOSIONS[saved.style] ? saved.style : 'classic',
    primary: Number.parseInt(saved.primary.slice(1), 16),
    secondary: Number.parseInt(saved.secondary.slice(1), 16),
    intensity: saved.intensity,
  };
}
// Raw saved record for the garage UI (hex strings intact).
export function getGoalExplosion(team = 0) {
  return { ...goalExplosionStore.load()[teamKey(team)] };
}
export function saveGoalExplosion(team, patch) {
  const key = teamKey(team), saved = goalExplosionStore.load();
  Object.assign(saved[key], patch);
  goalExplosionStore.save(saved);
  return goalExplosionSpec(key);
}
export function subscribeCarCustomization(listener) {
  listeners.add(listener); return () => listeners.delete(listener);
}
