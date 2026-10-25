import { GARAGE_CARS, CAR_FINISHES, CAR_DECALS, GOAL_EXPLOSIONS } from '../settings/car-customization.js';
import { garageReferenceIcons } from './garage-reference-icons.js';
import { Vt } from './icons.js';

export const garageCategories = [
  { id: 'body', label: 'Body' },
  { id: 'paint', label: 'Paint finish' },
  { id: 'decal', label: 'Decals' },
  { id: 'boost', label: 'Rocket boost' },
  { id: 'explosion', label: 'Goal explosion' },
];
const swatches = ['#00bacb', '#0039f7', '#ff9910', '#ff05b9', '#ff3333', '#9d4cff', '#eeeeee', '#252936'];
const teamTabs = `<div class="garage-team-tabs" role="tablist" aria-label="Team customization">
  <button type="button" role="tab" data-garage-team-tab="blue">BLUE TEAM</button>
  <button type="button" role="tab" data-garage-team-tab="orange">ORANGE TEAM</button>
</div>`;

// Tiny inline previews so each decal card shows its own pattern.
const decalPreviews = {
  none: '',
  stripes: '<rect x="8.5" y="1" width="2.6" height="14"/><rect x="12.2" y="1" width="1.2" height="14"/>',
  twin: '<rect x="7.5" y="1" width="3.6" height="14"/><rect x="12.4" y="1" width="1" height="14"/>',
  hex: '<circle cx="6" cy="5" r="1.7"/><circle cx="12" cy="5" r="1.7"/><circle cx="18" cy="5" r="1.7"/><circle cx="9" cy="11" r="1.7"/><circle cx="15" cy="11" r="1.7"/>',
  camo: '<ellipse cx="6" cy="5" rx="3.4" ry="2.6"/><ellipse cx="15" cy="10" rx="4" ry="2.8"/><ellipse cx="19" cy="4" rx="2.4" ry="2"/>',
  checker: '<rect x="4" y="2" width="4" height="4"/><rect x="12" y="2" width="4" height="4"/><rect x="8" y="10" width="4" height="4"/><rect x="16" y="10" width="4" height="4"/>',
  split: '<path d="M2 15 L22 1 L22 15 Z"/>',
  flames: '<path d="M22 15 C18 9 16 12 13 7 C11 12 8 9 6 13 C4 10 3 12 2 15 Z"/>',
  circuit: '<path d="M3 4 H10 V12 H21" stroke-width="1.6" fill="none"/><circle cx="10" cy="4" r="1.5"/><circle cx="21" cy="12" r="1.5"/><path d="M3 12 H6 V8 H12" stroke-width="1.6" fill="none"/>',
  wrap: '<rect x="2" y="1" width="20" height="6" rx="1"/>',
};
const decalCard = key => `
  <button type="button" class="garage-style-card" data-decal-choice="${key}" aria-pressed="false">
    <svg viewBox="0 0 24 16" aria-hidden="true"><g fill="currentColor" stroke="currentColor">${decalPreviews[key] || '<rect x="2" y="2" width="20" height="12" rx="2" fill="none" stroke-opacity=".35" stroke-dasharray="3 3"/>'}</g></svg>
    <span>${CAR_DECALS[key].label}</span>
  </button>`;

export function garageMarkup() { return `
  <button id="car-button" class="car-tab" type="button" aria-label="Open garage" aria-haspopup="dialog">
    <span class="car-tab__icon" aria-hidden="true">${Vt('car-profile', 36)}</span>
    <span class="car-tab__copy"><span class="car-tab__label">Garage</span><span class="car-tab__ride"></span></span>
  </button>
  <div id="car-overlay" class="car-overlay rl-garage" hidden aria-hidden="true">
    <section class="garage-layout" role="dialog" aria-modal="true" aria-labelledby="car-dialog-title">
      <header class="garage-heading"><h2 id="car-dialog-title">GARAGE</h2><span>Customize your ride</span><button type="button" data-car-close aria-label="Close garage">${Vt('x', 24)}</button></header>
      <div class="garage-content">
        <section class="inventory-panel" aria-label="Garage inventory">
          <nav class="categories"><div class="category-tabs" role="tablist" aria-label="Garage category">
            ${garageCategories.map(category => `<button class="category-tab" type="button" role="tab" id="garage-tab-${category.id}" data-garage-category="${category.id}" aria-controls="garage-panel-${category.id}" aria-selected="false">${garageReferenceIcons[category.id]}<span>${category.label}</span></button>`).join('')}
          </div></nav>
          <header class="inventory-header"><h1 data-category-title>BODY</h1><span class="collected" data-category-note>${GARAGE_CARS.length} collected</span></header>
          <div class="inventory-viewport">
            <div id="garage-panel-body" role="tabpanel" aria-labelledby="garage-tab-body" data-garage-panel="body">
              <div class="inventory-grid car-grid" role="radiogroup" aria-label="Car body">${GARAGE_CARS.map(car => `
                <button class="inventory-item car-card ${car.id === 'octane' ? 'rarity-common' : 'rarity-import'}" type="button" role="radio" aria-checked="false" data-car-choice="${car.id}">
                  <span class="car-card__stage" data-car-stage="${car.id}"><span class="car-card__status" data-car-status="${car.id}">Loading…</span></span>
                  <span class="item-name car-card__name">${car.label}</span><span class="car-card__state"></span>
                </button>`).join('')}</div>
              <p class="garage-note">Select a body to preview it, then equip it for your next kickoff.</p>
            </div>
            <div id="garage-panel-paint" role="tabpanel" aria-labelledby="garage-tab-paint" data-garage-panel="paint" hidden>
              <div class="garage-paint-preview" aria-hidden="true"><span></span><span></span><strong>LIVE TEAM PAINT</strong></div>
              ${teamTabs}
              <div class="garage-color-grid">
                <label class="garage-color-row">Primary color<input type="color" data-paint-color="primary" aria-label="Primary car color"></label>
                <label class="garage-color-row">Pearl color<input type="color" data-paint-color="pearl" aria-label="Pearl car color"></label>
              </div>
              <div class="garage-swatches" aria-label="Primary color swatches">${swatches.map(color => `<button type="button" data-color-swatch="${color}" aria-label="Set primary color ${color}" aria-pressed="false" style="--swatch:${color}"></button>`).join('')}</div>
              <label class="garage-field">Car material<select data-car-finish>${Object.entries(CAR_FINISHES).map(([id, value]) => `<option value="${id}">${value.label}</option>`).join('')}</select></label>
              ${[['roughness', 'Roughness', '.08'], ['metalness', 'Metalness', '0'], ['clearcoat', 'Clearcoat', '0']].map(([id, label, min]) => `<label class="garage-field">${label}<output data-material-output="${id}"></output><input type="range" min="${min}" max="1" step=".01" data-car-material="${id}"></label>`).join('')}
              <p class="garage-note">Original pearl follows the graphics editor. Other finishes apply to this car and team.</p>
            </div>
            <div id="garage-panel-decal" role="tabpanel" aria-labelledby="garage-tab-decal" data-garage-panel="decal" hidden>
              <div class="garage-decal-preview" aria-hidden="true"><span data-decal-swatch></span><strong data-decal-title>RACING STRIPES</strong></div>
              ${teamTabs}
              <div class="garage-style-grid" role="radiogroup" aria-label="Decal pattern">${Object.keys(CAR_DECALS).map(decalCard).join('')}</div>
              <label class="garage-color-row">Decal color<input type="color" data-paint-color="decalColor" aria-label="Decal color"></label>
              <label class="garage-field">Decal size<output data-material-output="decalScale"></output><input type="range" min=".25" max="3" step=".05" data-car-material="decalScale"></label>
              <p class="garage-note">Calcomanías are drawn over this car and team's paint finish.</p>
            </div>
            <div id="garage-panel-boost" role="tabpanel" aria-labelledby="garage-tab-boost" data-garage-panel="boost" hidden>
              <div class="garage-boost-sample" aria-hidden="true"><span></span></div><h3 class="garage-section-label">ROCKET BOOST</h3>
              ${teamTabs}
              <label class="garage-color-row">Boost color<input type="color" data-paint-color="boostColor" aria-label="Boost color"></label>
              <button class="metal-button garage-reset-boost" type="button" data-reset-boost>Original golden boost</button>
              <p class="garage-note">Colors the flame, trail, exhaust and nozzle glow for this car and team.</p>
            </div>
            <div id="garage-panel-explosion" role="tabpanel" aria-labelledby="garage-tab-explosion" data-garage-panel="explosion" hidden>
              <div class="garage-explosion-sample" aria-hidden="true" data-explosion-sample><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
              <h3 class="garage-section-label">GOAL EXPLOSION</h3>
              ${teamTabs}
              <div class="garage-style-grid" role="radiogroup" aria-label="Goal explosion style">${Object.entries(GOAL_EXPLOSIONS).map(([id, value]) => `
                <button type="button" class="garage-style-card" data-explosion-choice="${id}" aria-pressed="false"><span>${value.label}</span></button>`).join('')}</div>
              <div class="garage-color-grid">
                <label class="garage-color-row">Main color<input type="color" data-explosion-color="primary" aria-label="Explosion main color"></label>
                <label class="garage-color-row">Spark color<input type="color" data-explosion-color="secondary" aria-label="Explosion spark color"></label>
              </div>
              <label class="garage-field">Blast size<output data-explosion-output="intensity"></output><input type="range" min=".4" max="2" step=".05" data-explosion-intensity></label>
              <button class="metal-button garage-reset-explosion" type="button" data-reset-explosion>Reset to team default</button>
              <p class="garage-note">Plays for this team every time it scores, offline and online.</p>
            </div>
          </div>
        </section>
        <section class="garage-showroom" aria-label="Live car preview">
          <aside class="item-details"><h2 data-detail-name>Fennec</h2><div class="detail-quality" data-detail-quality>Import Body</div><div class="detail-paint-row"><span class="paint-tag" data-detail-finish>Original pearl</span><span class="painted-word" data-detail-team>BLUE TEAM</span></div><div class="detail-rule"></div><p class="detail-description">Your paint. Your decals. Your blast.</p></aside>
          <canvas class="garage-hero" width="1280" height="720" aria-label="Selected car preview rendered at full scale"></canvas>
          <div class="garage-orbit-hint" aria-hidden="true"><span>↔</span> DRAG TO ORBIT CAMERA <b>·</b> SCROLL TO ZOOM</div>
          <button class="metal-button garage-equip" type="button" data-car-equip>Equipped</button>
        </section>
      </div>
      <footer class="garage-footer"><button class="footer-button" type="button" data-car-close>BACK</button><button class="footer-button team-toggle" type="button" data-garage-team>ORANGE TEAM</button><span role="status" data-car-result>Changes save automatically.</span></footer>
    </section>
  </div>`; }
