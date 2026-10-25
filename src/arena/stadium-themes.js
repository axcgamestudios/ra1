// Two extra stadiums on top of the Park Day default. Each is a reversible
// look: a graphics settings overlay (sun, haze, exposure, palette blend) plus
// optional emissive accent meshes around the field and goals. The playable
// collision arena is untouched, so gameplay stays identical everywhere.
import { createSettingsStore, readChoice } from '../core/settings-store.js';
import { Group, Mesh, MeshBasicMaterial, BoxGeometry, CylinderGeometry, Ya as RingGeometry, AdditiveBlending, DoubleSide } from '../vendor/three.js';

export const STADIUMS = Object.freeze([
  { id: 'park', name: 'Park Day', blurb: 'Alpine daylight — the original arena.' },
  { id: 'neon', name: 'Neon Night', blurb: 'Night match: glowing goals, rails and center circle.' },
  { id: 'dusk', name: 'Golden Dusk', blurb: 'Golden hour: amber frames and warm field glow.' },
]);

const stadiumStore = createSettingsStore(
  'rocket-arena.stadium.v1',
  () => ({ stadium: 'park' }),
  (target, value) => { target.stadium = readChoice(value?.stadium, STADIUMS.map(s => s.id), target.stadium); },
);

const listeners = new Set();
function getStadium() { return stadiumStore.load().stadium; }
function setStadium(id) {
  if (!STADIUMS.some(s => s.id === id) || id === getStadium()) return false;
  stadiumStore.save({ stadium: id });
  for (const listener of listeners) listener(id);
  return true;
}
function subscribeStadium(listener) {
  listeners.add(listener);
  listener(getStadium());
  return () => listeners.delete(listener);
}

// Merged over the user's reference graphics settings; only the listed keys
// move so the graphics editor keeps working on top of every stadium.
export function stadiumGraphicsOverlay(id, settings) {
  if (id === 'neon') return {
    ...settings,
    sunset: 1, sunElevation: 16, sunAzimuth: -38, lightPower: 2.35,
    fog: 1.05, exposure: Math.max(0.7, settings.exposure * 0.9),
    makeupBloom: Math.min(2, settings.makeupBloom * 1.9 + 0.18),
    shadowBlur: 2.6,
  };
  if (id === 'dusk') return {
    ...settings,
    sunset: 1, sunElevation: 8, sunAzimuth: 118, lightPower: 4.1,
    fog: 0.9, exposure: Math.max(0.7, settings.exposure * 1.03),
    shadowBlur: 2.4,
  };
  return settings;
}

// Extra tint/horizon uniforms applied after the palette blend.
export function stadiumUniformOverlay(id) {
  if (id === 'neon') return {
    tint: [0.30, 0.34, 0.52],
    horizon: [0.34, 0.26, 0.62],
    sun: [0.60, 0.70, 1.0],
    background: 0x070a16,
  };
  if (id === 'dusk') return {
    tint: [1.06, 0.78, 0.55],
    horizon: [1.15, 0.72, 0.42],
    sun: [1.0, 0.60, 0.36],
    background: 0x38200f,
  };
  return null;
}

// Emissive accent meshes for the non-default stadiums. This kit now reaches
// INSIDE the arena, not just the exterior: team-colored goal frames at the
// mouth of each goal, a glowing center circle with kickoff dot, light strips
// along the interior wall bases, corner floor accents and a subtle full-field
// color wash that regrades the turf per stadium. Applied to the world scene;
// call again with 'park' to strip everything. The collision arena is untouched
// so gameplay stays identical everywhere.
export function applyStadiumAccents(scene, id, world) {
  if (world.stadiumAccents) {
    scene.remove(world.stadiumAccents);
    for (const child of world.stadiumAccents.children) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    world.stadiumAccents = null;
  }
  if (id === 'park' || !scene) return;

  const group = new Group();
  group.name = 'Stadium accents';
  const addBox = (width, height, depth, x, y, z, color, emissive = 2.2) => {
    const material = new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
    material.color.multiplyScalar(emissive);
    const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  const addRing = (x, z, radius, color, emissive = 1.9) => {
    const material = new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    material.color.multiplyScalar(emissive);
    const ring = new Mesh(new CylinderGeometry(radius, radius, 34, 48, 1, true), material);
    ring.position.set(x, 330, z);
    group.add(ring);
    return ring;
  };
  // Flat emissive ring on the floor (interior decals: center circle, corners).
  const addFloorRing = (x, z, inner, outer, color, emissive = 1.5, opacity = 0.55) => {
    const material = new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    material.color.multiplyScalar(emissive);
    const ring = new Mesh(new RingGeometry(inner, outer, 64, 1), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 6, z);
    group.add(ring);
    return ring;
  };
  // Team-colored glowing frame around each goal mouth (interior).
  const addGoalFrame = (z, color, emissive = 2.4) => {
    const half = 893, height = 643, post = 36;
    addBox(post, height + post, post, -half - post / 2, (height + post) / 2, z, color, emissive);
    addBox(post, height + post, post, half + post / 2, (height + post) / 2, z, color, emissive);
    addBox(half * 2 + post * 2, post, post, 0, height + post / 2, z, color, emissive);
  };
  // Interior wall-base light strips, just inside the boards.
  const addWallStrips = (color, emissive = 1.4) => {
    addBox(26, 22, 10200, -4080, 16, 0, color, emissive);
    addBox(26, 22, 10200, 4080, 16, 0, color, emissive);
    addBox(8160, 22, 26, 0, 16, -5094, color, emissive);
    addBox(8160, 22, 26, 0, 16, 5094, color, emissive);
  };
  // Full-field color wash: regrades the turf without touching its shader.
  const addFieldWash = (color, opacity = 0.1) => {
    const material = new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false });
    const wash = new Mesh(new BoxGeometry(8180, 2, 10240), material);
    wash.position.set(0, 5, 0);
    group.add(wash);
    return wash;
  };

  if (id === 'neon') {
    // World coords: X across the field (±4096), Y up, Z along the field (±5120).
    const cyan = 0x27e5ff, magenta = 0xff4fd8, lime = 0x9dff4f;
    addBox(8192, 30, 46, 0, 60, -5120, magenta);
    addBox(8192, 30, 46, 0, 60, 5120, magenta);
    addBox(46, 30, 10240, -4096, 60, 0, cyan);
    addBox(46, 30, 10240, 4096, 60, 0, cyan);
    for (const x of [-4096, 4096]) for (const z of [-5120, 5120])
      addBox(90, 620, 90, x, 330, z, lime, 2.6);
    addRing(0, -5120, 1150, cyan, 2.1);
    addRing(0, 5120, 1150, 0xffa03c, 2.1);
    addRing(0, 0, 4400, cyan, 0.55);
    // Interior kit.
    addGoalFrame(-5120, cyan, 2.6);
    addGoalFrame(5120, 0xffa03c, 2.6);
    addFloorRing(0, 0, 1120, 1165, cyan, 1.7, 0.6);
    addFloorRing(0, 0, 60, 110, 0xffffff, 1.9, 0.7);
    addWallStrips(cyan, 1.5);
    for (const x of [-4096, 4096]) for (const z of [-5120, 5120])
      addFloorRing(x, z, 150, 210, magenta, 1.6, 0.5);
    addFieldWash(0x0a2f5e, 0.12);
  } else if (id === 'dusk') {
    const amber = 0xffb347, ember = 0xff7038;
    addBox(8192, 24, 36, 0, 40, -5120, ember, 1.6);
    addBox(8192, 24, 36, 0, 40, 5120, ember, 1.6);
    addBox(36, 24, 10240, -4096, 40, 0, amber, 1.3);
    addBox(36, 24, 10240, 4096, 40, 0, amber, 1.3);
    addRing(0, -5120, 1150, amber, 1.5);
    addRing(0, 5120, 1150, 0xff8c3c, 1.5);
    // Interior kit.
    addGoalFrame(-5120, 0x7ec8ff, 2.2);
    addGoalFrame(5120, amber, 2.2);
    addFloorRing(0, 0, 1120, 1165, amber, 1.5, 0.5);
    addFloorRing(0, 0, 60, 110, 0xfff0c8, 1.6, 0.6);
    addWallStrips(ember, 1.2);
    for (const x of [-4096, 4096]) for (const z of [-5120, 5120])
      addFloorRing(x, z, 150, 210, ember, 1.3, 0.45);
    addFieldWash(0x3d1f07, 0.1);
  }

  scene.add(group);
  world.stadiumAccents = group;
}

export { getStadium, setStadium, subscribeStadium, stadiumStore };
