// Boost gauge, Rocket Ball flavour: a gradient arc that sweeps with the
// tank level, a rotating dashed rim, a pulsing flare behind the figure,
// spark particles while firing, a low-boost warning state and a golden
// shimmer when the tank is full or unlimited. State changes alone update
// the DOM — every animation lives in CSS.
export class ArcadeBoostMeter {
  constructor(root) {
    root.insertAdjacentHTML("beforeend", `
      <div class="boost arcade-boost" data-el="boost" role="meter" aria-label="Boost"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <svg class="arcade-boost__dial" viewBox="0 0 200 200" aria-hidden="true">
          <defs>
            <linearGradient id="arcadeBoostFill" x1="4%" y1="96%" x2="96%" y2="4%">
              <stop offset="0%" style="stop-color:var(--boost-c1)"/>
              <stop offset="48%" style="stop-color:var(--boost-c2)"/>
              <stop offset="100%" style="stop-color:var(--boost-c3)"/>
            </linearGradient>
            <radialGradient id="arcadeBoostFlare" cx="50%" cy="46%" r="60%">
              <stop offset="0%" style="stop-color:var(--boost-c3)" stop-opacity=".85"/>
              <stop offset="55%" style="stop-color:var(--boost-c2)" stop-opacity=".38"/>
              <stop offset="100%" stop-color="#000" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <circle class="arcade-boost__orbit" cx="100" cy="100" r="93"/>
          <circle class="arcade-boost__track" cx="100" cy="100" r="76"/>
          <g class="arcade-boost__ticks" aria-hidden="true"></g>
          <circle class="arcade-boost__fill" data-el="boostFill" cx="100" cy="100" r="76" transform="rotate(135 100 100)"/>
          <circle class="arcade-boost__rim" cx="100" cy="100" r="76"/>
        </svg>
        <span class="arcade-boost__flare" aria-hidden="true"></span>
        <span class="arcade-boost__sparks" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i>
        </span>
        <span class="arcade-boost__number" data-el="boostFigure">0</span>
      </div>`);
    this.root = root.querySelector('[data-el="boost"]');
    this.fill = this.root.querySelector('[data-el="boostFill"]');
    this.figure = this.root.querySelector('[data-el="boostFigure"]');
    // Tick marks around the 270-degree sweep, majors every 25 boost.
    const ticks = this.root.querySelector('.arcade-boost__ticks');
    let marks = '';
    for (let index = 0; index <= 20; index++) {
      const angle = Math.PI * (1.25 - (index / 20) * 1.5);
      const major = index % 5 === 0;
      const outer = 63 - (major ? 0 : 3), inner = 56 - (major ? 0 : 3);
      marks += `<line x1="${(100 + Math.cos(angle) * inner).toFixed(1)}" y1="${(100 - Math.sin(angle) * inner).toFixed(1)}"
        x2="${(100 + Math.cos(angle) * outer).toFixed(1)}" y2="${(100 - Math.sin(angle) * outer).toFixed(1)}"
        class="arcade-boost__tick${major ? ' arcade-boost__tick--major' : ''}"/>`;
    }
    ticks.innerHTML = marks;
    // The arc sweeps 270 degrees starting from the lower-left.
    this.arc = 2 * Math.PI * 76 * (270 / 360);
    this.fill.style.strokeDasharray = `${this.arc} ${this.arc * 2}`;
    this.fill.style.strokeDashoffset = String(this.arc);
    this.lastValue = -1;
    this.lastUnlimited = null;
    this.lastSpendingBoost = null;
    this.gainTimer = 0;
  }
  update(value, spending, unlimited, deltaSeconds = 1 / 60) {
    const infinite = Boolean(unlimited);
    const amount = infinite ? 100 : Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    // Reward pickups with a flash: a fast rise of 8+ units reads as a pad.
    if (!infinite && this.lastValue >= 0 && amount - this.lastValue >= 8) {
      this.gainTimer = .45;
      this.root.classList.add('is-gaining');
    }
    if (this.gainTimer > 0) {
      this.gainTimer -= deltaSeconds;
      if (this.gainTimer <= 0) this.root.classList.remove('is-gaining');
    }
    if (amount !== this.lastValue || infinite !== this.lastUnlimited) {
      this.figure.textContent = infinite ? '∞' : String(amount);
      const level = amount / 100;
      this.fill.style.strokeDashoffset = String(this.arc * (1 - level));
      this.root.style.setProperty('--boost-level', level.toFixed(3));
      this.root.setAttribute('aria-valuenow', String(amount));
      this.root.classList.toggle('is-unlimited', infinite);
      this.root.classList.toggle('is-empty', amount === 0);
      this.root.classList.toggle('is-low', !infinite && amount > 0 && amount < 25);
      this.root.classList.toggle('is-full', !infinite && amount === 100);
      if (infinite) this.root.setAttribute('aria-valuetext', 'Unlimited');
      else this.root.removeAttribute('aria-valuetext');
      if (!infinite && this.lastValue >= 0 && amount !== this.lastValue) {
        // Figure pop on every change keeps the dial feeling alive.
        this.figure.classList.remove('is-pop');
        void this.figure.offsetWidth;
        this.figure.classList.add('is-pop');
      }
      this.lastValue = amount;
      this.lastUnlimited = infinite;
    }
    const firing = Boolean(spending) && !infinite && amount > 0;
    if (firing !== this.lastSpendingBoost) {
      this.root.classList.toggle('is-firing', firing);
      this.lastSpendingBoost = firing;
    }
  }
}
