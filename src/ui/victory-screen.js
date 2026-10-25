import { scoreboardData } from './scoreboard.js';

// Rocket League style full-time screen: a huge VICTORY/DEFEAT banner in the
// team's colors over a dark glass panel, the final score flanked by team
// scores, the stats table, and the next-action buttons. Used by the offline
// match end; the online result screen reuses the same markup builder.
export function victoryContent({ outcome = 'victory', team = 0, blueScore = 0, orangeScore = 0,
  stats = null, roster = [], teams = [], selfSlot = 0, note = '' }) {
  const bannerText = outcome === 'victory' ? 'VICTORY' : outcome === 'defeat' ? 'DEFEAT'
    : outcome === 'draw' ? 'DRAW' : 'NO CONTEST';
  const data = scoreboardData(stats, roster, teams, { selfSlot, blueScore, orangeScore });
  const rows = (players, teamId) => players.slice().sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (b.goals ?? 0) - (a.goals ?? 0))
    .map(player => `
      <tr class="arena-scoreboard__player${player.you ? ' is-you' : ''}${player.left ? ' is-left' : ''}">
        <th>${player.you ? `${player.name} · YOU` : player.name}</th>
        <td>${player.goals ?? 0}</td><td>${player.assists ?? 0}</td>
        <td>${(player.saves ?? 0) + (player.epicSaves ?? 0)}</td><td>${player.shots ?? 0}</td>
        <td class="arena-scoreboard__cell--points">${player.points ?? 0}</td>
      </tr>`).join('');
  const header = `<tr class="arena-scoreboard__header"><th>PLAYER</th><td>G</td><td>A</td><td>SV</td><td>SH</td><td>PTS</td></tr>`;
  return `
    <div class="arena-victory__banner" data-outcome="${outcome}" data-team="${team === 1 ? 'orange' : 'blue'}">${bannerText}</div>
    <div class="arena-victory__score">
      <div class="arena-victory__team arena-victory__team--blue"><b>${blueScore}</b><span>BLUE</span></div>
      <div class="arena-victory__divider">FINAL</div>
      <div class="arena-victory__team arena-victory__team--orange"><b>${orangeScore}</b><span>ORANGE</span></div>
    </div>
    <div class="arena-victory__columns">
      <table class="arena-scoreboard__team arena-scoreboard__team--blue">${header}${rows(data.blue.players, 0)}</table>
      <table class="arena-scoreboard__team arena-scoreboard__team--orange">${header}${rows(data.orange.players, 1)}</table>
    </div>
    ${note ? `<p class="arena-victory__note">${note}</p>` : ''}`;
}

// Full-screen overlay for offline match end. Buttons are provided by the host
// integration (rematch / home) so the gameplay flow stays in startup.js.
export function createVictoryScreen(root, { onRematch, onHome } = {}) {
  const element = document.createElement('section');
  element.className = 'arena-victory';
  element.hidden = true;
  element.setAttribute('aria-label', 'Match result');
  element.innerHTML = `
    <div class="arena-victory__panel" role="dialog" aria-modal="true">
      <div class="arena-victory__content" data-el="content"></div>
      <div class="arena-victory__actions">
        <button type="button" class="arena-victory__button arena-victory__button--primary" data-el="rematch">REMATCH</button>
        <button type="button" class="arena-victory__button" data-el="home">HOME</button>
      </div>
      <p class="arena-victory__hint">ESC · BACK TO MENU</p>
    </div>`;
  (root ?? document.body).append(element);
  const content = element.querySelector('[data-el="content"]');
  const rematchButton = element.querySelector('[data-el="rematch"]');
  const homeButton = element.querySelector('[data-el="home"]');
  let visible = false;
  function show(data) {
    content.innerHTML = victoryContent(data);
    element.hidden = false;
    visible = true;
    rematchButton.focus({ preventScroll: true });
  }
  function hide() {
    if (!visible) return;
    visible = false;
    element.hidden = true;
  }
  const onKey = event => {
    if (!visible) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hide(); onHome?.(); }
  };
  window.addEventListener('keydown', onKey, true);
  rematchButton.addEventListener('click', () => { hide(); onRematch?.(); });
  homeButton.addEventListener('click', () => { hide(); onHome?.(); });
  return { show, hide, get visible() { return visible; }, victoryContent };
}
