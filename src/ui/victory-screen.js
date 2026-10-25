import { scoreboardData } from './scoreboard.js';

// RL-style post-match titles for the winner nameplates. Ordered by priority;
// each entry maps a stat line to the arena flavor titles (PRODIGY, TRAITOR,
// ENFORCER... exactly like the reference winner screen).
const TITLE_RULES = [
  ['goals', 3, 'PRODIGY', stats => `${stats.goals} GOAL${stats.goals === 1 ? '' : 'S'}`],
  ['ownGoals', 1, 'TRAITOR', stats => `${stats.ownGoals} OWN GOAL${stats.ownGoals === 1 ? '' : 'S'}`],
  ['epicSaves', 1, 'CLUTCH', stats => `${stats.epicSaves} EPIC SAVE${stats.epicSaves === 1 ? '' : 'S'}`],
  ['saves', 2, 'GUARDIAN', stats => `${stats.saves} SAVE${stats.saves === 1 ? '' : 'S'}`],
  ['demolitions', 1, 'ENFORCER', stats => `${stats.demolitions} DEMOLITION${stats.demolitions === 1 ? '' : 'S'}`],
  ['assists', 2, 'PLAYMAKER', stats => `${stats.assists} ASSIST${stats.assists === 1 ? '' : 'S'}`],
  ['goals', 1, 'SNIPER', stats => `${stats.goals} GOAL${stats.goals === 1 ? '' : 'S'}`],
  ['shots', 2, 'SHARPSHOOTER', stats => `${stats.shots} SHOT${stats.shots === 1 ? '' : 'S'}`],
  ['assists', 1, 'SETUP MAN', stats => `${stats.assists} ASSIST`],
  ['saves', 1, 'SAVIOR', stats => `${stats.saves} SAVE`],
  ['points', 200, 'VETERAN', stats => `${stats.points} PTS`],
];

function plateTitles(stats) {
  const lines = [];
  for (const [key, minimum, title, format] of TITLE_RULES) {
    if ((stats[key] ?? 0) >= minimum) lines.push([title, format(stats)]);
    if (lines.length === 2) break;
  }
  if (!lines.length) lines.push(['ROOKIE', `${stats.points ?? 0} PTS`]);
  return lines;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

// Nameplate card: angled parallelogram with a silver-framed avatar, the player
// name and two title/stat lines; the MVP card carries the team-color wash.
function plateCard(player, { mvp = false, team = 0 } = {}) {
  const titles = plateTitles(player);
  const initial = escapeHTML((player.name ?? 'P').trim().charAt(0).toUpperCase() || 'P');
  return `
    <div class="arena-victory__plate${mvp ? ' is-mvp' : ''}" data-team="${team === 1 ? 'orange' : 'blue'}">
      <span class="arena-victory__plate-avatar" aria-hidden="true">${initial}</span>
      <div class="arena-victory__plate-info">
        <b>${escapeHTML(player.name ?? 'PLAYER')}${player.you ? ' · YOU' : ''}</b>
        ${titles.map(([title, stat]) => `<span class="arena-victory__plate-line"><i>${title}</i><em>${escapeHTML(stat)}</em></span>`).join('')}
      </div>
      ${mvp ? '<span class="arena-victory__plate-mvp">MVP</span>' : ''}
    </div>`;
}

// Drifting confetti in the winning team's color, like the reference video.
function confetti(team, count = 18) {
  let pieces = '';
  for (let index = 0; index < count; index++) {
    const left = 4 + Math.random() * 92;
    const delay = Math.random() * 2.6;
    const duration = 2.6 + Math.random() * 2.4;
    const size = 4 + Math.random() * 6;
    pieces += `<i style="--left:${left.toFixed(1)}%;--delay:${delay.toFixed(2)}s;--duration:${duration.toFixed(2)}s;--size:${size.toFixed(1)}px"></i>`;
  }
  return `<div class="arena-victory__confetti" data-team="${team === 1 ? 'orange' : 'blue'}" aria-hidden="true">${pieces}</div>`;
}

// Rocket League style full-time screen copied from the winner-screen video:
// a small WINNER caption over the huge glowing team name, the MVP line, angled
// player nameplates with RL flavor titles, the final score, and the stats
// tables below. Used by the offline match end; the online result screen
// reuses the same markup builder.
export function victoryContent({ outcome = 'victory', team = 0, blueScore = 0, orangeScore = 0,
  stats = null, roster = [], teams = [], selfSlot = 0, note = '' }) {
  const data = scoreboardData(stats, roster, teams, { selfSlot, blueScore, orangeScore });
  const winnerTeam = outcome === 'victory' ? team : outcome === 'defeat' ? (team === 1 ? 0 : 1) : null;
  const teamName = winnerTeam === 0 ? 'BLUE' : winnerTeam === 1 ? 'ORANGE' : outcome === 'draw' ? 'DRAW' : 'NO CONTEST';
  const rows = (players, teamId) => players.slice().sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (b.goals ?? 0) - (a.goals ?? 0))
    .map(player => `
      <tr class="arena-scoreboard__player${player.you ? ' is-you' : ''}${player.left ? ' is-left' : ''}">
        <th>${player.you ? `${escapeHTML(player.name)} · YOU` : escapeHTML(player.name)}</th>
        <td>${player.goals ?? 0}</td><td>${player.assists ?? 0}</td>
        <td>${(player.saves ?? 0) + (player.epicSaves ?? 0)}</td><td>${player.shots ?? 0}</td>
        <td class="arena-scoreboard__cell--points">${player.points ?? 0}</td>
      </tr>`).join('');
  const header = `<tr class="arena-scoreboard__header"><th>PLAYER</th><td>G</td><td>A</td><td>SV</td><td>SH</td><td>PTS</td></tr>`;
  // Winner podium: the winning team's players by points, MVP first.
  const podium = (winnerTeam === null ? [] : (data[winnerTeam === 0 ? 'blue' : 'orange'].players ?? []))
    .slice().sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (b.goals ?? 0) - (a.goals ?? 0));
  const mvpSlot = podium[0] ?? null;
  const mvpName = mvpSlot ? escapeHTML(mvpSlot.name) : '';
  const podiumCards = podium.slice(0, 4).map((player, index) => plateCard(player, {
    mvp: index === 0,
    team: winnerTeam ?? 0,
  })).join('');
  return `
    ${winnerTeam !== null ? confetti(winnerTeam) : ''}
    <div class="arena-victory__banner" data-outcome="${outcome}" data-team="${winnerTeam === 1 ? 'orange' : 'blue'}">
      ${winnerTeam !== null ? '<span class="arena-victory__caption">WINNER</span>' : ''}
      <span class="arena-victory__word">${teamName}</span>
      ${mvpName ? `<span class="arena-victory__mvp">MVP · ${mvpName}</span>` : ''}
    </div>
    ${outcome === 'defeat' ? `<span class="arena-victory__chip" data-outcome="defeat">DEFEAT</span>` : ''}
    <div class="arena-victory__podium">${podiumCards}</div>
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
