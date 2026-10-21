// Soft contact shadows that ground the ball and every car on ALL quality
// presets. Real shadow maps only cover a tight ortho box around each subject,
// so airborne play loses its ground shadow and the default Potato/Balanced
// presets have no shadow maps at all. These height-aware blobs keep a
// believable contact darkening at every height, offset toward the sun so they
// align with (and extend) the dynamic shadow on High.
import { Ee as Mesh, dt as Group, cn as MeshBasicMaterial, ui as PlaneGeometry, Zt as Texture } from "../vendor/three.js";

let sharedGradient;
let sharedGeometry;

function blobGradient() {
  if (sharedGradient) return sharedGradient;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(0,0,0,0.85)");
  gradient.addColorStop(0.42, "rgba(0,0,0,0.5)");
  gradient.addColorStop(0.72, "rgba(0,0,0,0.16)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  sharedGradient = new Texture(canvas);
  sharedGradient.needsUpdate = true;
  return sharedGradient;
}

function blobPlane() {
  sharedGeometry ??= new PlaneGeometry(2, 2);
  return sharedGeometry;
}

const FADE_SCALE = 620;

// A single reusable ground blob. `gap` is the subject height above the field;
// the blob darkens and tightens toward contact, then fades and spreads as the
// subject climbs, mirroring how a real penumbra behaves with distance.
export function createContactShadow(scene, renderOrder = 1) {
  const material = new MeshBasicMaterial({ map: blobGradient(), transparent: true, depthWrite: false, opacity: 0 });
  const mesh = new Mesh(blobPlane(), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = renderOrder;
  const object = new Group();
  object.add(mesh);
  object.visible = false;
  scene.add(object);
  return {
    object,
    place(x, z, yaw, gap, length, width, strength = 1) {
      const fade = Math.exp(-gap / FADE_SCALE);
      const opacity = strength * fade;
      if (opacity < 0.02) { object.visible = false; return; }
      object.visible = true;
      object.position.set(x, 2.5, z);
      object.rotation.y = yaw;
      const spread = 1 + Math.min(gap / FADE_SCALE, 3) * 0.5;
      mesh.scale.set(length * spread, width * spread, 1);
      material.opacity = opacity * 0.58;
    },
    hide() { object.visible = false; },
  };
}
