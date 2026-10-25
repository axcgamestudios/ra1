// Stadium variety on top of the shared arena. Each look is three reversible
// layers: a graphics settings overlay (sun, haze, exposure), a scenery tint
// overlay (sky, horizon, distance haze) and additive accent meshes plus a
// turf overlay that reach INSIDE the arena. Exterior prop kits (stands,
// colonnade, skyline) mount into the scenery root so the tint covers them.
// Nothing is placed across a goal mouth: accents frame goals from outside
// the posts, above the crossbar or behind the net, and the collision arena
// is untouched so gameplay stays identical everywhere.
import { createSettingsStore, readChoice } from '../core/settings-store.js';
import { Group, Mesh, MeshBasicMaterial, BoxGeometry, CylinderGeometry, Ya as RingGeometry, AdditiveBlending, DoubleSide, Zt as Texture, Ht as SRGBColorSpace } from '../vendor/three.js';
import { createStadiumProps, disposeStadiumProps } from './stadium-props.js';

export const STADIUMS = Object.freeze([
  { id: 'park', name: 'Park Day', blurb: 'Alpine daylight — the original arena.' },
  { id: 'mannfield', name: 'Mannfield', blurb: 'Classic striped pitch, blue and orange tiers.' },
  { id: 'coliseum', name: 'Sun Coliseum', blurb: 'Mediterranean arches and terracotta roofs.' },
  { id: 'neon', name: 'Neon Night', blurb: 'Night match: glowing goals, rails and center circle.' },
  { id: 'dusk', name: 'Golden Dusk', blurb: 'Golden hour: amber frames and warm field glow.' },
  { id: 'urban', name: 'City Dusk', blurb: 'Downtown skyline, cranes and a purple sunset.' },
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
  if (id === 'mannfield') return {
    ...settings,
    sunElevation: 62, sunAzimuth: -52, lightPower: 4.6, fog: .5,
    exposure: Math.min(1.55, settings.exposure * 1.02), shadowBlur: 2,
  };
  if (id === 'coliseum') return {
    ...settings,
    sunElevation: 54, sunAzimuth: 34, lightPower: 4.2, fog: .62,
    exposure: Math.min(1.55, settings.exposure * 1.03), shadowBlur: 2.1,
  };
  if (id === 'urban') return {
    ...settings,
    sunset: 1, sunElevation: 11, sunAzimuth: -122, lightPower: 3.7,
    fog: 1.15, exposure: Math.max(.7, settings.exposure * .97),
    makeupBloom: Math.min(2, settings.makeupBloom * 1.6 + .12), shadowBlur: 2.5,
  };
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

// Tint/horizon applied to the painted backdrop, turf and exterior props.
// Park-style looks return null (no tint, original artwork untouched).
export function stadiumUniformOverlay(id) {
  if (id === 'mannfield') return {
    tint: [1.04, 1.02, .97],
    horizon: [.94, .95, .97],
    sun: [1.0, .98, .92],
    background: 0x9ccbee,
  };
  if (id === 'coliseum') return {
    tint: [1.06, .99, .88],
    horizon: [1.05, .93, .78],
    sun: [1.0, .94, .80],
    background: 0xa8cfe0,
  };
  if (id === 'urban') return {
    tint: [.90, .70, .70],
    horizon: [1.20, .62, .46],
    sun: [1.0, .56, .40],
    background: 0x2a1830,
  };
  if (id === 'neon') return {
    tint: [0.24, 0.28, 0.46],
    horizon: [0.30, 0.24, 0.58],
    sun: [0.60, 0.70, 1.0],
    background: 0x070a16,
  };
  if (id === 'dusk') return {
    tint: [1.10, .80, .58],
    horizon: [1.25, .68, .40],
    sun: [1.0, .60, .36],
    background: 0x38200f,
  };
  return null;
}

// Goal mouth (uu): half width 893, height 643, goal line |z| = 5120, goal
// depth ~5970. Accent strips that run along an end wall are split so they
// never cross the opening; halos sit behind the net, never inside it.
const MOUTH_CLEAR = 1010;

function makeTurfTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 1024);
  if (kind === 'stripes') {
    // Longitudinal mowing stripes goal-to-goal: alternating dark bands.
    for (let x = 0; x < 512; x += 64) {
      ctx.fillStyle = 'rgba(8,44,10,0.34)';
      ctx.fillRect(x, 0, 32, 1024);
    }
  } else if (kind === 'sandy') {
    // Sandy stone paths: border, center circle and goal boxes.
    ctx.strokeStyle = 'rgba(228,208,162,0.8)';
    ctx.lineWidth = 24; ctx.strokeRect(12, 12, 488, 1000);
    ctx.lineWidth = 20;
    ctx.beginPath(); ctx.arc(256, 512, 96, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 18;
    ctx.strokeRect(12, 328, 158, 368); ctx.strokeRect(342, 328, 158, 368);
    ctx.fillStyle = 'rgba(228,208,162,0.55)';
    ctx.fillRect(12, 12, 488, 10); ctx.fillRect(12, 1002, 488, 10);
  } else if (kind === 'urban') {
    // Downtown hex-plate floor: faint cyan seams and a center emblem.
    ctx.strokeStyle = 'rgba(90,190,220,0.30)';
    ctx.lineWidth = 4;
    for (let z = 0; z <= 1024; z += 128) { ctx.beginPath(); ctx.moveTo(0, z); ctx.lineTo(512, z); ctx.stroke(); }
    for (let x = 0; x <= 512; x += 128) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1024); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,150,60,0.5)'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(256, 512, 110, 0, Math.PI * 2); ctx.stroke();
  }
  const texture = new Texture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function applyStadiumAccents(scene, id, world) {
  if (world.stadiumAccents) {
    scene.remove(world.stadiumAccents);
    for (const child of world.stadiumAccents.children) {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    world.stadiumAccents = null;
  }
  if (world.stadiumProps) {
    (world.sky ?? scene).remove(world.stadiumProps);
    disposeStadiumProps(world.stadiumProps);
    world.stadiumProps = null;
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
  // Team-colored glowing frame AROUND each goal mouth: posts sit outside the
  // posts, crossbar above the bar — the opening itself stays completely clear.
  const addGoalFrame = (z, color, emissive = 2.4) => {
    const half = 893, height = 643, post = 30;
    addBox(post, height + post, post, -half - post / 2 - 6, (height + post) / 2, z, color, emissive);
    addBox(post, height + post, post, half + post / 2 + 6, (height + post) / 2, z, color, emissive);
    addBox(half * 2 + post * 2 + 12, post, post, 0, height + post / 2 + 6, z, color, emissive);
  };
  // Interior wall-base light strips. The end-wall strips are SPLIT around the
  // goal mouth so nothing ever glows across the opening.
  const addWallStrips = (color, emissive = 1.4) => {
    addBox(26, 22, 10200, -4080, 16, 0, color, emissive);
    addBox(26, 22, 10200, 4080, 16, 0, color, emissive);
    const span = 4080 - MOUTH_CLEAR;
    for (const z of [-5094, 5094]) for (const side of [-1, 1])
      addBox(span, 22, 26, side * (MOUTH_CLEAR + span / 2), 16, z, color, emissive);
  };
  // Full-field color wash: regrades the turf without touching its shader.
  const addFieldWash = (color, opacity = 0.1) => {
    const material = new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false });
    const wash = new Mesh(new BoxGeometry(8180, 2, 10240), material);
    wash.position.set(0, 5, 0);
    group.add(wash);
    return wash;
  };
  // Turf regrade overlay: mowing stripes / sandy paths / hex seams.
  const addTurfOverlay = kind => {
    const plane = new Mesh(new BoxGeometry(8192, 0.1, 10240), new MeshBasicMaterial({ map: makeTurfTexture(kind), transparent: true, depthWrite: false, toneMapped: false }));
    plane.position.set(0, 7, 0);
    group.add(plane);
    return plane;
  };

  if (id === 'mannfield') {
    const orange = 0xff7a1a;
    addTurfOverlay('stripes');
    addGoalFrame(-5120, 0x2f8fff, 1.9);
    addGoalFrame(5120, orange, 1.9);
    addFloorRing(0, 0, 1120, 1165, 0xffffff, 1.25, .5);
    addFloorRing(0, 0, 60, 110, 0xffffff, 1.5, .55);
    addWallStrips(0x9fc4e8, .8);
    for (const z of [-6150, 6150]) addFloorRing(0, z, 1050, 1330, z < 0 ? 0x2f8fff : orange, 1.2, .5);
  } else if (id === 'coliseum') {
    const sand = 0xe8c98a, clay = 0xb5651d;
    addTurfOverlay('sandy');
    addGoalFrame(-5120, 0x3d5a8f, 1.6);
    addGoalFrame(5120, clay, 1.6);
    addFloorRing(0, 0, 1120, 1165, sand, 1.1, .5);
    addFloorRing(0, 0, 60, 110, 0xffffff, 1.3, .5);
    addWallStrips(sand, .9);
    for (const z of [-6150, 6150]) addFloorRing(0, z, 1050, 1330, z < 0 ? 0x3d5a8f : clay, 1.1, .5);
    addFieldWash(0x2a1c08, .07);
  } else if (id === 'neon') {
    const cyan = 0x27e5ff, magenta = 0xff4fd8, lime = 0x9dff4f;
    const span = 4080 - MOUTH_CLEAR;
    for (const z of [-5120, 5120]) for (const side of [-1, 1])
      addBox(span, 30, 46, side * (MOUTH_CLEAR + span / 2), 60, z, magenta);
    addBox(46, 30, 10240, -4096, 60, 0, cyan);
    addBox(46, 30, 10240, 4096, 60, 0, cyan);
    for (const x of [-4096, 4096]) for (const z of [-5120, 5120])
      addBox(90, 620, 90, x, 330, z, lime, 2.6);
    // Halo over the center circle instead of rings through the goal mouths.
    const halo = new Mesh(new CylinderGeometry(2100, 2100, 26, 48, 1, true), new MeshBasicMaterial({ color: cyan, toneMapped: false, transparent: true, opacity: .5, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
    halo.material.color.multiplyScalar(1.6);
    halo.position.set(0, 460, 0);
    group.add(halo);
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
    const span = 4080 - MOUTH_CLEAR;
    for (const z of [-5120, 5120]) for (const side of [-1, 1])
      addBox(span, 24, 36, side * (MOUTH_CLEAR + span / 2), 40, z, ember, 1.6);
    addBox(36, 24, 10240, -4096, 40, 0, amber, 1.3);
    addBox(36, 24, 10240, 4096, 40, 0, amber, 1.3);
    addGoalFrame(-5120, 0x7ec8ff, 2.2);
    addGoalFrame(5120, amber, 2.2);
    addFloorRing(0, 0, 1120, 1165, amber, 1.5, 0.5);
    addFloorRing(0, 0, 60, 110, 0xfff0c8, 1.6, 0.6);
    addWallStrips(ember, 1.2);
    for (const x of [-4096, 4096]) for (const z of [-5120, 5120])
      addFloorRing(x, z, 150, 210, ember, 1.3, 0.45);
    addFieldWash(0x3d1f07, 0.1);
  } else if (id === 'urban') {
    const purple = 0xb44cff, orange = 0xff8c3c;
    addTurfOverlay('urban');
    addGoalFrame(-5120, 0x8fb4ff, 2.2);
    addGoalFrame(5120, orange, 2.2);
    addFloorRing(0, 0, 1120, 1165, purple, 1.5, .5);
    addFloorRing(0, 0, 60, 110, 0xffffff, 1.6, .55);
    addWallStrips(0x6fd0ff, 1.2);
    for (const z of [-6150, 6150]) addFloorRing(0, z, 1050, 1330, z < 0 ? purple : orange, 1.3, .5);
    addFieldWash(0x14082a, .12);
  }

  scene.add(group);
  world.stadiumAccents = group;

  // Exterior prop kits ride inside the scenery root (tint + haze apply).
  const props = createStadiumProps(id);
  if (props && (world.sky ?? scene)) {
    (world.sky ?? scene).add(props);
    world.stadiumProps = props;
  }
  world.markRenderTreeChanged?.();
}

export { getStadium, setStadium, subscribeStadium, stadiumStore };
