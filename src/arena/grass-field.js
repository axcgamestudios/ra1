// Fine 3D turf blades for the park pitch — Rocket League style: very fine,
// very thin, very short, and LOTS of them. One draw call over the painted
// surface. Per-blade colors come from a small baked color map that mirrors
// exactly what the surface shader shows at the same spot (painted canvas for
// markings/team zones, the user's pasto photo for green turf), so the carpet
// grows out of the ground it matches. Blades: 1.15 UU wide, ~4.6 UU tall
// (cars clear the ground by ~17 UU), one tapered blade = 3 triangles,
// root-shade/tip-light baked in the fragment.
// Only the root position is stored per blade (8 bytes); jitter, rotation,
// scale, lean and brightness variance are hash-derived on the GPU, and the
// color map is fetched once per blade in the vertex shader — which is what
// makes a 2.3M-blade lawn cheap to build, upload and draw.
// Ball and car contact shadows are shared with the turf material's uniform
// arrays, so blades darken under subjects exactly like the surface does.
import { al as InstancedBufferGeometry, un as InstancedBufferAttribute, Ee as Mesh, Ke as Float32BufferAttribute, cn as MeshBasicMaterial, Ut as DoubleSide, F as Vector3, Cr as Sphere, nl as DataTexture, Ht as SRGBColorSpace, qt as LinearFilter } from '../vendor/three.js';

const GRASS_BLADE_WIDTH = 1.15;  // UU at the root — reads as a fine thin blade
const GRASS_BLADE_HEIGHT = 4.6;  // UU average — "muy corto", like Rocket League
const GRASS_BASE_LIFT = 0.35;    // keeps the root line off the turf plane

// Per-preset spacing in UU: the closer the blades, the denser the carpet.
// High = 6 UU (2.3M blades), Balanced = 8 UU (1.3M), Potato skips geometry.
const GRASS_SPACING = { High: 6, Balanced: 8, Potato: 0 };

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

// Exact sRGB <-> linear LUTs; the bake must match what the GPU decodes.
const FIELD_WIDTH = 8192, FIELD_DEPTH = 10240;
const SRGB_TO_LINEAR = new Float32Array(256);
const LINEAR_TO_SRGB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  LINEAR_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))));
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// World-space value noise, mirroring the turf fragment shader: rotates the
// octave blend weight (.25 to .75) so the tiled photo never beats into a grid.
function octaveWeight(x, z) {
  const cellX = Math.floor(x / 192), cellZ = Math.floor(z / 192);
  const fx = x / 192 - cellX, fz = z / 192 - cellZ;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const hash = (cx, cz) => {
    const s = Math.sin(cx * 127.1 + cz * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = hash(cellX, cellZ) * (1 - sx) * (1 - sz) + hash(cellX + 1, cellZ) * sx * (1 - sz)
    + hash(cellX, cellZ + 1) * (1 - sx) * sz + hash(cellX + 1, cellZ + 1) * sx * sz;
  return 0.25 + 0.5 * noise;
}

// Bakes the blade base color for every 16 UU cell of the field: the painted
// canvas color where the pitch is marked/painted, and the pasto photo (same
// two-octave world-space blend as the surface shader, same vivid lift, same
// gain) where the pitch is green. 512x640 bytes, built once at load.
function bakeBladeColorMap(canvasTexture, photoTexture, gain) {
  const cellsX = 512, cellsZ = 640;
  const canvas = document.createElement('canvas');
  canvas.width = cellsX; canvas.height = cellsZ;
  const context = canvas.getContext('2d');
  context.drawImage(canvasTexture.image, 0, 0, cellsX, cellsZ);
  const painted = context.getImageData(0, 0, cellsX, cellsZ).data;

  const photoCanvas = document.createElement('canvas');
  const photoImage = photoTexture.image;
  const photoSize = Math.min(1024, photoImage.width || 1024);
  photoCanvas.width = photoCanvas.height = photoSize;
  const photoContext = photoCanvas.getContext('2d');
  photoContext.drawImage(photoImage, 0, 0, photoSize, photoSize);
  const photo = photoContext.getImageData(0, 0, photoSize, photoSize).data;

  const data = new Uint8Array(cellsX * cellsZ * 4);
  for (let cell = 0; cell < cellsX * cellsZ; cell++) {
    const cx = cell % cellsX, cz = (cell / cellsX) | 0;
    // Cell centre in world UU; canvas row 0 maps to z = -5120.
    const x = -FIELD_WIDTH / 2 + (cx + 0.5) * (FIELD_WIDTH / cellsX);
    const z = -FIELD_DEPTH / 2 + (cz + 0.5) * (FIELD_DEPTH / cellsZ);
    const paintedOffset = cell * 4;
    const pr = SRGB_TO_LINEAR[painted[paintedOffset]];
    const pg = SRGB_TO_LINEAR[painted[paintedOffset + 1]];
    const pb = SRGB_TO_LINEAR[painted[paintedOffset + 2]];
    const greenMask = smoothstep(0.01, 0.055, pg - Math.max(pr, pb))
      * smoothstep(0.22, 0.4, (pg - Math.min(pr, pb)) / Math.max(pg, 0.001));
    // Photo octave A: world / 256; octave B: rotated world / 469.
    let r, g, b;
    if (greenMask > 0.004) {
      const sampleOctave = (u, v) => {
        const px = Math.min(photoSize - 1, Math.max(0, Math.round(((u % 1) + 1) % 1 * photoSize)));
        const py = Math.min(photoSize - 1, Math.max(0, Math.round(((v % 1) + 1) % 1 * photoSize)));
        const offset = (py * photoSize + px) * 4;
        return [SRGB_TO_LINEAR[photo[offset]], SRGB_TO_LINEAR[photo[offset + 1]], SRGB_TO_LINEAR[photo[offset + 2]]];
      };
      const a = sampleOctave(x / 256, z / 256);
      const rx = (x * .70710678 - z * .70710678) / 469;
      const rz = (x * .70710678 + z * .70710678) / 469;
      const b2 = sampleOctave(rx, rz);
      const mixA = octaveWeight(x, z);
      const photoR = a[0] + (b2[0] - a[0]) * mixA;
      const photoG = a[1] + (b2[1] - a[1]) * mixA;
      const photoB = a[2] + (b2[2] - a[2]) * mixA;
      const luma = 0.2126 * photoR + 0.7152 * photoG + 0.0722 * photoB;
      const vivid = [
        Math.max(0, luma + (photoR - luma) * 1.32) * 1.22 * gain,
        Math.max(0, luma + (photoG - luma) * 1.32) * 1.22 * gain,
        Math.max(0, luma + (photoB - luma) * 1.32) * 1.22 * gain,
      ];
      r = pr + (vivid[0] - pr) * greenMask;
      g = pg + (vivid[1] - pg) * greenMask;
      b = pb + (vivid[2] - pb) * greenMask;
    } else {
      r = pr; g = pg; b = pb;
    }
    data[paintedOffset] = LINEAR_TO_SRGB[Math.min(255, Math.max(0, Math.round(r * 255)))];
    data[paintedOffset + 1] = LINEAR_TO_SRGB[Math.min(255, Math.max(0, Math.round(g * 255)))];
    data[paintedOffset + 2] = LINEAR_TO_SRGB[Math.min(255, Math.max(0, Math.round(b * 255)))];
    data[paintedOffset + 3] = 255;
  }
  const texture = new DataTexture(data, cellsX, cellsZ);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createGrassField(quality, turfState, canvasTexture, photoTexture) {
  const label = quality?.label ?? 'Balanced';
  const spacing = GRASS_SPACING[label] ?? GRASS_SPACING.Balanced;
  if (!spacing || !canvasTexture?.image || !photoTexture?.image) return null;

  // ceil() so the lawn reaches the walls on both ends (no bare border strip).
  const columns = Math.ceil(FIELD_WIDTH / spacing);
  const rows = Math.ceil(FIELD_DEPTH / spacing);
  const count = columns * rows;

  // Only the lattice root is stored; every other property is derived on the
  // GPU from a hash of the root, so the whole lawn is 8 bytes per blade.
  const positions = new Float32Array(count * 2);
  let written = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      positions[written * 2] = -FIELD_WIDTH / 2 + column * spacing;
      positions[written * 2 + 1] = -FIELD_DEPTH / 2 + row * spacing;
      written++;
    }
  }

  const colorMap = bakeBladeColorMap(canvasTexture, photoTexture, turfState?.grassGain?.value ?? 1);

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(BLADE_VERTICES, 3));
  geometry.setIndex(BLADE_INDICES);
  geometry.setAttribute('iPos', new InstancedBufferAttribute(positions, 2));
  geometry.instanceCount = written;
  geometry.boundingSphere = new Sphere(new Vector3(0, 4, 0), Math.hypot(FIELD_WIDTH, FIELD_DEPTH) / 2 + 8);

  const state = { time: { value: 0 } };
  const material = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false, precision: 'highp' });
  material.onBeforeCompile = shader => {
    shader.uniforms.parkGrassTime = state.time;
    shader.uniforms.parkBladeColorMap = { value: colorMap };
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
attribute vec2 iPos;
uniform float parkGrassTime;
uniform sampler2D parkBladeColorMap;
varying vec3 parkBladeColor;
varying float parkBladeHeight;
varying vec2 parkBladeGround;
float parkBladeHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>
float parkBladeSeedA=parkBladeHash(iPos);
float parkBladeSeedB=parkBladeHash(iPos+vec2(17.17,3.31));
float parkBladeSeedC=parkBladeHash(iPos+vec2(31.7,11.3));
float parkBladeSeedD=parkBladeHash(iPos+vec2(7.7,23.1));
vec2 parkBladeRoot=iPos+vec2(parkBladeSeedA-.5,parkBladeSeedB-.5)*${spacing.toFixed(1)};
float parkBladeScale=.72+.62*parkBladeSeedC;
float parkBladeLeanA=parkBladeSeedD*6.28318;
vec2 parkBladeLean=vec2(cos(parkBladeLeanA),sin(parkBladeLeanA));
float parkBladeBend=position.y*position.y;
float parkBladeSway=sin(parkGrassTime*1.6+parkBladeSeedA*6.28318+(iPos.x+iPos.y)*.04);
vec3 parkBladeLocal=vec3(position.x,position.y*${GRASS_BLADE_HEIGHT.toFixed(1)}*parkBladeScale,position.z+parkBladeBend*.5);
parkBladeLocal.xz+=parkBladeLean*parkBladeBend*.6+vec2(parkBladeSway,parkBladeSway*.6)*parkBladeBend*.22;
float parkBladeRot=parkBladeSeedB*6.28318;
float parkBladeCos=cos(parkBladeRot),parkBladeSin=sin(parkBladeRot);
transformed=vec3(parkBladeRoot.x+parkBladeLocal.x*parkBladeCos-parkBladeLocal.z*parkBladeSin,
${GRASS_BASE_LIFT}+parkBladeLocal.y,
parkBladeRoot.y+parkBladeLocal.x*parkBladeSin+parkBladeLocal.z*parkBladeCos);
vec2 parkBladeColorUv=vec2((parkBladeRoot.x+4096.)/8192.,(5120.-parkBladeRoot.y)/10240.);
parkBladeColor=texture2D(parkBladeColorMap,parkBladeColorUv).rgb*(.84+.32*parkBladeSeedC);
parkBladeHeight=position.y;
parkBladeGround=parkBladeRoot;`);
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
  material.customProgramCacheKey = () => turfState ? 'park-fine-grass-blades-v3' : 'park-fine-grass-blades-v3-plain';

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
