import { getCarCustomization, DEFAULT_CAR_MATERIAL, TEAM_CAR_COLORS, DECAL_IDS } from '../settings/car-customization.js';

// Applies an already-resolved paint settings object (any source: the local
// garage store, or a roster entry that travelled over the wire) to every
// fennecV2 material under root. Returns the settings for callers that also
// need the boost color.
export function applyCarCustomizationSettings(root, settings) {
  root.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.userData?.fennecV2) continue;
      material.userData.garagePaint = { ...settings };
      const uniforms = material.uniforms;
      if (uniforms.uGaragePaint) uniforms.uGaragePaint.value = 1;
      uniforms.uFace?.value.set(settings.primary);
      uniforms.uPearl?.value.set(settings.pearl);
      if (uniforms.uRoughness) uniforms.uRoughness.value = settings.roughness;
      if (uniforms.uMetalness) uniforms.uMetalness.value = settings.metalness;
      if (uniforms.uClearcoat) uniforms.uClearcoat.value = settings.clearcoat;
      // Calcomanías: pattern id + color + density on the same bodywork pass.
      if (uniforms.uDecalStyle) {
        uniforms.uDecalStyle.value = DECAL_IDS[settings.decal] ?? 0;
        uniforms.uDecalColor?.value.set(settings.decalColor ?? '#ffffff');
        if (uniforms.uDecalScale) uniforms.uDecalScale.value = settings.decalScale ?? 1;
      }
    }
  });
  return settings;
}

export function applyCarCustomization(root, carId, team = 0) {
  return applyCarCustomizationSettings(root, getCarCustomization(carId, team));
}

// Paint for a REMOTE car: the owner's wire paint for their team when present,
// otherwise the stock team paint. Remote cars must never read the local
// garage store — that is what made every car wear the viewer's colors.
export function remoteCarPaint(player, team = 0) {
  const key = team === 1 || team === 'orange' ? 'orange' : 'blue';
  const wire = player?.paint?.[key];
  if (wire?.primary)
    return {
      ...DEFAULT_CAR_MATERIAL, ...TEAM_CAR_COLORS[key], ...wire,
      finish: wire.finish ?? 'glossy',
      decal: DECAL_IDS[wire.decal] !== undefined ? wire.decal : 'none',
      decalColor: wire.decalColor ?? '#ffffff',
      decalScale: wire.decalScale ?? 1,
    };
  return { ...DEFAULT_CAR_MATERIAL, ...TEAM_CAR_COLORS[key] };
}
