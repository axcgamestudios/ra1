// Exterior stadium prop kits, replicated from the player's reference photos:
// Mannfield's blue/orange tiered crowd stands, the Sun Coliseum's colonnade
// and two-tone tiled roof ring, and the City Dusk skyline with construction
// cranes and light pylons. Every kit is a handful of draw calls (instanced
// where possible), built from plain geometry, and mounts inside the scenery
// root so the stadium tint applies to it like the rest of the backdrop.
import {
  Group, Mesh, MeshBasicMaterial, BoxGeometry, CylinderGeometry, SphereGeometry,
  Color, AdditiveBlending, DoubleSide, Matrix4, Vector3,
  Lm as InstancedMesh, It as Object3D,
} from '../vendor/three.js';

const SIDE = DoubleSide;

function disposeDeep(object) {
  object.traverse(child => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose?.();
  });
}

// One instanced draw per prop kit; per-instance colors bake the crowd and
// section variety so a whole grandstand renders as a single call.
function instancedProps({ geometry, place }) {
  const items = [];
  place(x => items.push(x));
  const material = new MeshBasicMaterial({ toneMapped: false });
  const mesh = new InstancedMesh(geometry, material, items.length);
  const marker = new Object3D(), tint = new Color();
  items.forEach((item, index) => {
    const [x, y, z, color, sx = 1, sy = sx, sz = sx, rotY = 0] = item;
    marker.position.set(x, y, z);
    marker.rotation.set(0, rotY, 0);
    marker.scale.set(sx, sy, sz);
    marker.updateMatrix();
    mesh.setMatrixAt(index, marker.matrix);
    tint.set(color);
    mesh.setColorAt(index, tint);
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function lightPylon(group, x, z, color = 0xf4f1de) {
  const mast = new Mesh(new BoxGeometry(70, 2600, 70), new MeshBasicMaterial({ color: 0x3a4148, toneMapped: false }));
  mast.position.set(x, 1300, z);
  const head = new Mesh(new BoxGeometry(560, 120, 60), new MeshBasicMaterial({ color, toneMapped: false }));
  head.position.set(x, 2680, z);
  head.lookAt(0, 900, 0);
  const glow = new Mesh(new BoxGeometry(640, 210, 100), new MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: .5, blending: AdditiveBlending, depthWrite: false }));
  glow.position.copy(head.position);
  group.add(mast, head, glow);
}

// ---------------------------------------------------------------- Mannfield --
// Tiered grandstands with alternating blue/orange sections and a sprinkled
// crowd, plus corner pylons — the classic open-air look from the photo.
function createMannfieldProps() {
  const group = new Group();
  group.name = 'Stadium / Mannfield tiered stands';
  const seats = [];
  const blue = 0x1d5fd4, orange = 0xd65b13;
  const crowd = [0xe8e4da, 0x8f9aa8, 0xc4574a, 0x3f6f52, 0xb9a24a];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 6; row++) {
      const x = side * (4850 + row * 240), y = 260 + row * 150;
      for (let z = -4000; z <= 4000; z += 260) {
        const section = Math.floor((z + 4000) / 780) % 2;
        seats.push([x, y, z, Math.random() < .16 ? crowd[Math.floor(Math.random() * crowd.length)] : section ? blue : orange]);
      }
    }
  }
  for (const end of [-1, 1]) {
    for (let row = 0; row < 6; row++) {
      const z = end * (6650 + row * 240), y = 260 + row * 150;
      for (let x = -3600; x <= 3600; x += 260) {
        const section = Math.floor((x + 3600) / 900) % 2;
        seats.push([x, y, z, Math.random() < .16 ? crowd[Math.floor(Math.random() * crowd.length)] : section ? orange : blue]);
      }
    }
  }
  group.add(instancedProps({
    geometry: new BoxGeometry(150, 130, 240),
    place: add => { for (const seat of seats) add(seat); },
  }));
  // Dark fascia band under the lowest row ties the ring together.
  for (const [w, d, x, z] of [[10800, 180, 0, -6450], [10800, 180, 0, 6450], [180, 9200, -5100, 0], [180, 9200, 5100, 0]]) {
    const band = new Mesh(new BoxGeometry(w, 210, d), new MeshBasicMaterial({ color: 0x232a33, toneMapped: false }));
    band.position.set(x, 105, z);
    group.add(band);
  }
  lightPylon(group, -5400, -5900); lightPylon(group, 5400, -5900);
  lightPylon(group, -5400, 5900); lightPylon(group, 5400, 5900);
  return group;
}

// ----------------------------------------------------------------- Coliseum --
// Colonnade ring, entablature, two-tone tiled roof (blue half / terracotta
// half) and topiary — the Mediterranean arena from the photo.
function createColiseumProps() {
  const group = new Group();
  group.name = 'Stadium / Sun Coliseum colonnade';
  const columns = 40, radius = 7350;
  const stone = 0xcfc4ae, stoneDark = 0xa89a7d;
  group.add(instancedProps({
    geometry: new CylinderGeometry(62, 74, 1150, 10),
    place: add => {
      for (let index = 0; index < columns; index++) {
        const angle = index / columns * Math.PI * 2;
        add([Math.cos(angle) * radius, 575, Math.sin(angle) * radius, index % 2 ? stone : stoneDark]);
      }
    },
  }));
  const entablature = new Mesh(
    new CylinderGeometry(radius + 40, radius + 40, 190, 48, 1, true),
    new MeshBasicMaterial({ color: 0xd8cdb4, toneMapped: false, side: SIDE }));
  entablature.position.y = 1290;
  group.add(entablature);
  for (const [start, color] of [[Math.PI * .5, 0x3d5a8f], [Math.PI * 1.5, 0xb5651d]]) {
    const roof = new Mesh(
      new CylinderGeometry(radius + 260, radius + 260, 340, 32, 1, true, start, Math.PI),
      new MeshBasicMaterial({ color, toneMapped: false, side: SIDE }));
    roof.position.y = 1560;
    group.add(roof);
  }
  const tier = new Mesh(
    new CylinderGeometry(radius - 150, radius - 150, 620, 48, 1, true),
    new MeshBasicMaterial({ color: 0xbfb298, toneMapped: false, side: SIDE }));
  tier.position.y = 900;
  group.add(tier);
  const shrubs = 26;
  group.add(instancedProps({
    geometry: new SphereGeometry(95, 8, 6),
    place: add => {
      for (let index = 0; index < shrubs; index++) {
        const angle = index / shrubs * Math.PI * 2;
        add([Math.cos(angle) * 4650, 95, Math.sin(angle) * 4650, index % 2 ? 0x2f6b38 : 0x3c7d43]);
      }
    },
  }));
  return group;
}

// ------------------------------------------------------------------- Urban --
// Downtown silhouette ring with lit towers and construction cranes under a
// purple-orange sunset, plus corner light pylons — from the dusk city photo.
function createUrbanProps() {
  const group = new Group();
  group.name = 'Stadium / City Dusk skyline';
  const towers = 64;
  const dark = 0x2a3048, lit = 0x51607e;
  const matrix = new Matrix4(), scale = new Vector3();
  const material = new MeshBasicMaterial({ toneMapped: false });
  const blocks = new InstancedMesh(new BoxGeometry(1, 1, 1), material, towers);
  const tint = new Color();
  for (let index = 0; index < towers; index++) {
    const angle = index / towers * Math.PI * 2 + (index % 3) * .06;
    const radius = 13500 + (index % 7) * 950;
    const width = 800 + (index % 5) * 420;
    const height = 2400 + ((index * 137) % 13) * 430;
    const depth = 800 + ((index * 61) % 4) * 380;
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    scale.set(width, height, depth);
    matrix.makeRotationY(-angle);
    matrix.scale(scale);
    matrix.setPosition(x, height / 2, z);
    blocks.setMatrixAt(index, matrix);
    tint.set(index % 4 === 0 ? lit : dark);
    blocks.setColorAt(index, tint);
  }
  blocks.instanceMatrix.needsUpdate = true;
  if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  blocks.frustumCulled = false;
  group.add(blocks);
  // Cranes: tower + jib + counter-jib, warm yellow against the dusk.
  const steel = new MeshBasicMaterial({ color: 0xd9a13b, toneMapped: false });
  for (const [angle, radius] of [[.4, 11200], [1.7, 12500], [3.6, 11800], [5.1, 13000]]) {
    const crane = new Group();
    const tower = new Mesh(new BoxGeometry(190, 5600, 190), steel);
    tower.position.y = 2800;
    const jib = new Mesh(new BoxGeometry(2600, 150, 150), steel);
    jib.position.set(1180, 5480, 0);
    const counter = new Mesh(new BoxGeometry(900, 170, 170), steel);
    counter.position.set(-480, 5420, 0);
    const cabin = new Mesh(new BoxGeometry(240, 220, 240), steel);
    cabin.position.y = 5280;
    crane.add(tower, jib, counter, cabin);
    crane.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    crane.lookAt(0, 0, 0);
    group.add(crane);
  }
  lightPylon(group, -5100, -6300, 0xffe9b8); lightPylon(group, 5100, -6300, 0xffe9b8);
  lightPylon(group, -5100, 6300, 0xffe9b8); lightPylon(group, 5100, 6300, 0xffe9b8);
  return group;
}

export function createStadiumProps(id) {
  if (id === 'mannfield') return createMannfieldProps();
  if (id === 'coliseum') return createColiseumProps();
  if (id === 'urban') return createUrbanProps();
  return null;
}

export function disposeStadiumProps(object) { if (object) disposeDeep(object); }
