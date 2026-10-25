// Animated speedometer, Rocket League style: an arcing gauge with a sweeping
// fill, big tabular digits that ease toward the true speed, and a SUPERSONIC
// state that flips the palette and pulses. Speed is car velocity magnitude in
// uu/s (the community "KPH" convention: supersonic = 2200-2310).
export function createSpeedMeter(root, { maxSpeed = 2310, supersonicSpeed = 2200 } = {}) {
  root.insertAdjacentHTML('beforeend', `
    <div class="speed-meter" data-el="speedMeter" role="meter" aria-label="Speed"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <svg class="speed-meter__arc" viewBox="0 0 100 60" aria-hidden="true">
        <path class="speed-meter__track" d="M 8 52 A 44 44 0 1 1 92 52"></path>
        <path class="speed-meter__ticks"></path>
        <path class="speed-meter__fill" data-el="speedFill" d="M 8 52 A 44 44 0 1 1 92 52"></path>
      </svg>
      <div class="speed-meter__readout">
        <b class="speed-meter__figure" data-el="speedFigure">0</b>
        <span class="speed-meter__unit">KPH</span>
      </div>
      <span class="speed-meter__supersonic" data-el="speedSupersonic">SUPERSONIC</span>
    </div>`);
  const element = root.querySelector('[data-el="speedMeter"]');
  const fill = element.querySelector('[data-el="speedFill"]');
  const figure = element.querySelector('[data-el="speedFigure"]');
  const supersonicLabel = element.querySelector('[data-el="speedSupersonic"]');
  // Tick marks along the same arc (10 segments, majors at boost thresholds).
  const ticksPath = element.querySelector('.speed-meter__ticks');
  if (ticksPath) {
    const center = { x: 50, y: 52 }, radius = 44;
    let path = '';
    for (let index = 0; index <= 10; index++) {
      const angle = Math.PI * (1 - index / 10);
      const major = index === 0 || index === 5 || index === 10;
      const outer = radius + (major ? 3 : 1.5), inner = radius - (major ? 5 : 2.5);
      path += `M ${(center.x + Math.cos(angle) * inner).toFixed(2)} ${(center.y - Math.sin(angle) * inner).toFixed(2)}`
        + ` L ${(center.x + Math.cos(angle) * outer).toFixed(2)} ${(center.y - Math.sin(angle) * outer).toFixed(2)} `;
    }
    ticksPath.setAttribute('d', path);
  }
  const arcLength = fill.getTotalLength?.() ?? 138;
  fill.style.strokeDasharray = String(arcLength);
  fill.style.strokeDashoffset = String(arcLength);
  let displayed = 0, lastSupersonic = null, lastRounded = -1;
  function update(speed, supersonic) {
    // Digits ease toward the true value: at 60 FPS this converges in ~100 ms,
    // which reads as a spinning needle instead of flickering numbers.
    displayed += (Math.max(0, speed) - displayed) * .3;
    if (Math.abs(speed - displayed) < 1) displayed = speed;
    const ratio = Math.min(1, Math.max(0, displayed / maxSpeed));
    fill.style.strokeDashoffset = String(arcLength * (1 - ratio));
    fill.style.setProperty('--speed-ratio', String(ratio));
    const rounded = Math.round(displayed);
    if (rounded !== lastRounded) {
      figure.textContent = String(rounded);
      lastRounded = rounded;
      element.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }
    if (supersonic !== lastSupersonic) {
      element.classList.toggle('is-supersonic', !!supersonic);
      supersonicLabel.setAttribute('aria-hidden', String(!supersonic));
      lastSupersonic = !!supersonic;
    }
  }
  return { update, get element() { return element; } };
}
