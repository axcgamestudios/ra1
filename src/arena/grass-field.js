// Fine 3D turf blades for the park pitch — Rocket League style: very fine,
// very thin, very short. One draw call over the painted surface; per-blade
// colors are sampled from the painted turf canvas (converted to linear light)
// so the mow checker, team paint and markings keep showing through the grass.
// Blades: 1.4 UU wide, ~5 UU tall (cars clear the ground by ~17 UU), one
// tapered blade = 3 triangles, root-shade/tip-light baked in the fragment.
// Ball and car contact shadows are shared with the turf material's uniform
// arrays, so blades darken under subjects exactly like the surface does.
import { al as InstancedBufferGeometry, un as InstancedBufferAttribute, Ee as Mesh, Ke as Float32BufferAttribute, cn as MeshBasicMaterial, Ut as DoubleSide, F as Vector3, Cr as Sphere } from '../vendor/three.js';

const GRASS_BLADE_WIDTH = 1.4;   // UU at the root — reads as a fine thin blade
const GRASS_BLADE_HEIGHT = 5.0;  // UU average — "muy corto", like Rocket League
const GRASS_BASE_LIFT = 0.35;    // keeps the root line off the turf plane

// Per-preset spacing in UU: potato skips the geometry entirely.
const GRASS_SPACING = { High: 12, Balanced: 20, Potato: 0 };

// Tapered blade: root pair, tapered mid pair, single tip. z carries the
// natural forward curl; instances rotate, lean, scale and sway it.
const BLADE_VERTICES = [
  -GRASS_BLADE_WIDTH / 2, 0, 0,
  GRASS_BLADE_WIDTH / 2, 0, 0,
  -GRASS_BLADE_WIDTH * 0.24, 0.55, 0.1,
  GRASS_BLADE_WIDTH * 0.24, 0.55, 0.1,
  0, 1, 0.28,
];
const BLADE_INDICES = [0, 1, 2, 2, 1, 3, 2, 3, 4];

// Exact sRGB -> linear LUT; canvas samples must match the GPU-decoded turf.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Mirror of the turf shader's vivid-green lift (park-lighting.js) so blades
// sit in the same light as the surface they grow from.
function vividTurfColor(r, g, b) {
  const greenMask = smoothstep(0.01, 0.055, g - Math.max(r, b))
    * smoothstep(0.22, 0.4, (g - Math.min(r, b)) / Math.max(g, 0.001));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const vr = Math.max(0, luminance + (r - luminance) * 1.32) * 1.22;
  const vg = Math.max(0, luminance + (g - luminance) * 1.32) * 1.22;
  const vb = Math.max(0, luminance + (b - luminance) * 1.32) * 1.22;
  return [
    r + (vr - r) * greenMask,
    g + (vg - g) * greenMask,
    b + (vb - b) * greenMask,
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function createGrassField(quality, turfCanvas, turfState) {
  const label = quality?.label ?? 'Balanced';
  const spacing = GRASS_SPACING[label] ?? GRASS_SPACING.Balanced;
  if (!spacing || !turfCanvas) return null;

  const fieldWidth = 8192, fieldDepth = 10240;
  const columns = Math.floor(fieldWidth / spacing);
  const rows = Math.floor(fieldDepth / spacing);
  const count = columns * rows;

  // Deterministic LCG so every player sees the identical lawn.
  let seed = 0x2f6e2b1 >>> 0;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

  const positions = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const rotations = new Float32Array(count);

  // Sample the painted turf so blades inherit the field's pattern. The plane
  // maps canvas column 0 to x=-4096 and canvas row 0 to z=-5120 (blue goal).
  const context = turfCanvas.getContext('2d');
  const pixels = context?.getImageData(0, 0, turfCanvas.width, turfCanvas.height).data ?? null;
  const canvasWidth = turfCanvas.width, canvasHeight = turfCanvas.height;

  let written = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      // Jittered grid: uniform coverage without moire rows.
      const x = -fieldWidth / 2 + (column + (random() - 0.5)) * spacing;
      const z = -fieldDepth / 2 + (row + (random() - 0.5)) * spacing;
      let r = 0.055, g = 0.13, b = 0.032;
      if (pixels) {
        const px = Math.min(canvasWidth - 1, Math.max(0, Math.round((x + fieldWidth / 2) / fieldWidth * canvasWidth)));
        const py = Math.min(canvasHeight - 1, Math.max(0, Math.round((z + fieldDepth / 2) / fieldDepth * canvasHeight)));
        const offset = (py * canvasWidth + px) * 4;
        const linear = vividTurfColor(
          SRGB_TO_LINEAR[pixels[offset]], SRGB_TO_LINEAR[pixels[offset + 1]], SRGB_TO_LINEAR[pixels[offset + 2]]);
        r = linear[0]; g = linear[1]; b = linear[2];
      }
      // Per-blade brightness variance: natural lawn patchiness.
      const variance = 0.84 + random() * 0.32;
      positions[written * 2] = x;
      positions[written * 2 + 1] = z;
      colors[written * 3] = r * variance;
      colors[written * 3 + 1] = g * variance;
      colors[written * 3 + 2] = b * variance;
      rotations[written] = random() * Math.PI * 2;
      written++;
    }
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(BLADE_VERTICES, 3));
  geometry.setIndex(BLADE_INDICES);
  geometry.setAttribute('iPos', new InstancedBufferAttribute(positions.subarray(0, written * 2), 2));
  geometry.setAttribute('iColor', new InstancedBufferAttribute(colors.subarray(0, written * 3), 3));
  geometry.setAttribute('iRot', new InstancedBufferAttribute(rotations.subarray(0, written), 1));
  geometry.instanceCount = written;
  geometry.boundingSphere = new Sphere(new Vector3(0, 4, 0), Math.hypot(fieldWidth, fieldDepth) / 2 + 8);

  const state = { time: { value: 0 } };
  const material = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false, precision: 'highp' });
  material.onBeforeCompile = shader => {
    shader.uniforms.parkGrassTime = state.time;
    // Share the turf's contact-shadow uniform storage: one writer (the
    // surface's onBeforeRender), two readers (turf + blades). The fallback
    // parks every subject at altitude 1e7, i.e. no shadow at all.
    const idleContacts = new Float32Array(12);
    for (let i = 0; i < 3; i++) idleContacts[i * 4 + 2] = 1e7;
    shader.uniforms.parkContact = { value: turfState?.contacts ?? idleContacts };
    shader.uniforms.parkBallRadius = turfState?.ballRadius ?? { value: 92.75 };
    shader.uniforms.parkLightDirection = turfState?.lightDirection ?? { value: new Vector3(-.48, .83, .29).normalize() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>
attribute vec2 iPos;attribute vec3 iColor;attribute float iRot;
uniform float parkGrassTime;
varying vec3 parkBladeColor;varying float parkBladeHeight;varying vec2 parkBladeGround;
float parkBladeHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
float parkBladeSeed=parkBladeHash(iPos);
float parkBladeScale=.72+.62*parkBladeSeed;
float parkBladeLeanA=parkBladeHash(iPos+vec2(17.17,3.31))*6.28318;
vec2 parkBladeLean=vec2(cos(parkBladeLeanA),sin(parkBladeLeanA));
float parkBladeBend=position.y*position.y;
float parkBladeSway=sin(parkGrassTime*1.6+parkBladeSeed*6.28318+(iPos.x+iPos.y)*.04);
vec3 parkBladeLocal=vec3(position.x,position.y*${GRASS_BLADE_HEIGHT.toFixed(1)}*parkBladeScale,position.z+parkBladeBend*.5);
parkBladeLocal.xz+=parkBladeLean*parkBladeBend*.6+vec2(parkBladeSway,parkBladeSway*.6)*parkBladeBend*.22;
float parkBladeCos=cos(iRot),parkBladeSin=sin(iRot);
transformed=vec3(iPos.x+parkBladeLocal.x*parkBladeCos-parkBladeLocal.z*parkBladeSin,
${GRASS_BASE_LIFT}+parkBladeLocal.y,
iPos.y+parkBladeLocal.x*parkBladeSin+parkBladeLocal.z*parkBladeCos);
parkBladeColor=iColor;parkBladeHeight=position.y;parkBladeGround=iPos;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
uniform vec4 parkContact[3];uniform float parkBallRadius;uniform vec3 parkLightDirection;
varying vec3 parkBladeColor;varying float parkBladeHeight;varying vec2 parkBladeGround;
float parkBladeContact(vec2 point,vec4 subject,bool ball){
float altitude=max(0.,subject.z-(ball?parkBallRadius:17.));
float visibility=1.-smoothstep(120.,1800.,altitude);
vec2 center=subject.xy-parkLightDirection.xz/max(parkLightDirection.y,.1)*altitude;
vec2 offset=point-center;
float c=cos(subject.w),s=sin(subject.w);
offset=mat2(c,-s,s,c)*offset;
vec2 radius=ball?vec2(parkBallRadius*1.12):vec2(92.,55.);
radius+=altitude*.19;
float d=length(offset/radius);
return (1.-smoothstep(.12,1.55,d))*visibility*(ball?.53:.58);}`)
      .replace('#include <color_fragment>',
        `#include <color_fragment>
{
float parkBladeShadow=0.;
parkBladeShadow=max(parkBladeShadow,parkBladeContact(parkBladeGround,parkContact[0],true));
parkBladeShadow=max(parkBladeShadow,parkBladeContact(parkBladeGround,parkContact[1],false));
parkBladeShadow=max(parkBladeShadow,parkBladeContact(parkBladeGround,parkContact[2],false));
vec3 parkBladeTint=mix(vec3(1.),vec3(.39,.49,.57),parkBladeShadow);
diffuseColor.rgb=parkBladeColor*mix(.58,1.34,parkBladeHeight)*parkBladeTint;}`);
  };
  material.customProgramCacheKey = () => turfState ? 'park-fine-grass-blades-v2' : 'park-fine-grass-blades-v2-plain';

  const mesh = new Mesh(geometry, material);
  mesh.name = 'Park / fine 3D grass blades';
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  // Wind clock: advanced only when the blades actually render.
  mesh.onBeforeRender = () => { state.time.value = performance.now() * 0.001; };
  mesh.userData.grassSpacing = spacing;
  mesh.userData.bladeCount = written;
  return mesh;
}
