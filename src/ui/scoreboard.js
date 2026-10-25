// Rocket League-style scoreboard: per-player goals, assists, saves, shots and
// points in a dark glass panel with team rails, WINS/MVP side columns, mode
// line and an OVERTIME treatment. Manual only — hold TAB.
export function createScoreboard(root) {
  const element = document.createElement('section');
  element.className = 'arena-scoreboard';
  element.setAttribute('aria-label', 'Match scoreboard');
  element.hidden = true;
  element.innerHTML = `
    <div class="arena-scoreboard__panel">
      <header class="arena-scoreboard__head">
        <div class="arena-scoreboard__team-score arena-scoreboard__team-score--blue">
          <b data-board="blue-score">0</b><span>BLUE</span>
        </div>
        <div class="arena-scoreboard__clockwrap" data-board="clockwrap">
          <span class="arena-scoreboard__clock" data-board="clock">5:00</span>
          <span class="arena-scoreboard__label" data-board="phase-label">MATCH</span>
          <span class="arena-scoreboard__mode" data-board="mode-label">CASUAL</span>
        </div>
        <div class="arena-scoreboard__team-score arena-scoreboard__team-score--orange">
          <b data-board="orange-score">0</b><span>ORANGE</span>
        </div>
      </header>
      <div class="arena-scoreboard__body">
        <aside class="arena-scoreboard__side arena-scoreboard__side--blue" aria-label="Blue team wins">
          <b data-board="blue-wins">0</b><span>WINS</span>
          <i data-board="blue-mvp">MVP 0</i>
        </aside>
        <div class="arena-scoreboard__columns">
          <table class="arena-scoreboard__team arena-scoreboard__team--blue" data-board="blue-rows"></table>
          <table class="arena-scoreboard__team arena-scoreboard__team--orange" data-board="orange-rows"></table>
        </div>
        <aside class="arena-scoreboard__side arena-scoreboard__side--orange" aria-label="Orange team wins">
          <b data-board="orange-wins">0</b><span>WINS</span>
          <i data-board="orange-mvp">MVP 0</i>
        </aside>
      </div>
      <footer class="arena-scoreboard__hint">HOLD TAB · G GOALS · A ASSISTS · SV SAVES · SH SHOTS · PTS</footer>
    </div>`;
  (root ?? document.body).append(element);
  const find = name => element.querySelector(`[data-board="${name}"]`);
  const blueScore = find('blue-score'), orangeScore = find('orange-score'), clock = find('clock');
  const phaseLabel = find('phase-label'), modeLabel = find('mode-label'), clockwrap = find('clockwrap');
  const blueWins = find('blue-wins'), orangeWins = find('orange-wins');
  const blueMvp = find('blue-mvp'), orangeMvp = find('orange-mvp');
  const rowLists = { 0: find('blue-rows'), 1: find('orange-rows') };

  let hideTimer = 0;
  let renderKey = '';

  function playerRow(player) {
    const row = document.createElement('tr');
    row.className = 'arena-scoreboard__player';
    if (player.you) row.classList.add('is-you');
    if (player.left) row.classList.add('is-left');
    // Offline slot 0 is literally named "YOU" — never append the marker again.
    const youSuffix = player.you && !/^(you|player 1)$/i.test(player.name ?? '') ? ' · YOU' : '';
    const leftSuffix = player.left && !youSuffix ? ' · LEFT' : '';
    const cells = [
      ['name', `${player.name ?? ''}${youSuffix}${leftSuffix}`],
      ['goals', String(player.goals ?? 0)],
      ['assists', String(player.assists ?? 0)],
      ['saves', String((player.saves ?? 0) + (player.epicSaves ?? 0))],
      ['shots', String(player.shots ?? 0)],
      ['points', String(player.points ?? 0)],
    ];
    for (const [kind, text] of cells) {
      const cell = document.createElement(kind === 'name' ? 'th' : 'td');
      cell.className = `arena-scoreboard__cell arena-scoreboard__cell--${kind}`;
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }

  function headerRow() {
    const row = document.createElement('tr');
    row.className = 'arena-scoreboard__header';
    for (const [kind, text] of [['name', 'PLAYER'], ['goals', 'G'], ['assists', 'A'], ['saves', 'SV'], ['shots', 'SH'], ['points', 'PTS']]) {
      const cell = document.createElement(kind === 'name' ? 'th' : 'td');
      cell.className = `arena-scoreboard__cell arena-scoreboard__cell--${kind}`;
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }

  // teams: { blue: { score, players: [...] }, orange: { score, players: [...] }, clock }
  function show({ blue, orange, clock: clockText = '', transient = 0, overtime = false, mode = 'CASUAL', wins = null }) {
    const key = JSON.stringify({ blue, orange, clockText, overtime, mode, wins });
    if (key !== renderKey || element.hidden) {
      renderKey = key;
      blueScore.textContent = String(blue.score ?? 0);
      orangeScore.textContent = String(orange.score ?? 0);
      clock.textContent = clockText;
      // Overtime state: gold clock + phase label swap (Rocket League style).
      clockwrap.classList.toggle('is-overtime', !!overtime);
      phaseLabel.textContent = overtime ? 'OVERTIME' : 'MATCH';
      modeLabel.textContent = mode || 'CASUAL';
      const mvpOf = column => {
        const best = (column?.players ?? []).reduce((top, player) => (player.points ?? 0) > (top?.points ?? 0) ? player : top, null);
        return best ? `MVP ${best.points ?? 0}` : 'MVP 0';
      };
      blueMvp.textContent = mvpOf(blue);
      orangeMvp.textContent = mvpOf(orange);
      blueWins.textContent = String(wins?.blue ?? 0);
      orangeWins.textContent = String(wins?.orange ?? 0);
      for (const [team, list] of Object.entries(rowLists)) {
        list.replaceChildren(headerRow());
        const players = (team === '0' ? blue : orange).players ?? [];
        players.slice().sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (b.goals ?? 0) - (a.goals ?? 0));
        for (const player of players) list.append(playerRow(player));
      }
    }
    element.hidden = false;
    clearTimeout(hideTimer);
    if (transient > 0) hideTimer = setTimeout(() => { element.hidden = true; }, transient);
  }
  function hide() {
    clearTimeout(hideTimer);
    element.hidden = true;
  }
  function dispose() {
    clearTimeout(hideTimer);
    element.remove();
  }
  return { show, hide, dispose, get visible() { return !element.hidden; } };
}

// Formats a stats summary (MatchEvents.summary() + roster names) for the two
// team columns. roster: [{ name, team, disconnected }] indexed by physics slot.
export function scoreboardData(summary, roster, teams, { selfSlot = null, blueScore = 0, orangeScore = 0, clockText = '', overtime = false, mode = 'CASUAL', wins = null } = {}) {
  const columns = { 0: { score: blueScore, players: [] }, 1: { score: orangeScore, players: [] } };
  const slots = summary?.slots ?? [];
  for (let slot = 0; slot < Math.max(slots.length, roster?.length ?? 0); slot++) {
    const stats = slots[slot] ?? { goals: 0, assists: 0, saves: 0, epicSaves: 0, shots: 0, points: 0 };
    const team = teams?.[slot] ?? roster?.[slot]?.team ?? (slot % 2);
    const player = {
      name: roster?.[slot]?.name ?? (slot === 0 ? 'YOU' : `PLAYER ${slot + 1}`),
      goals: stats.goals ?? 0, assists: stats.assists ?? 0, saves: stats.saves ?? 0,
      epicSaves: stats.epicSaves ?? 0, shots: stats.shots ?? 0, points: stats.points ?? 0,
      // Extra flavor stats for the winner-screen nameplates (ignored by the
      // scoreboard tables themselves).
      demolitions: stats.demolitions ?? 0, ownGoals: stats.ownGoals ?? 0,
      you: selfSlot === null ? slot === 0 : slot === selfSlot,
      left: !!roster?.[slot]?.disconnected,
    };
    columns[team]?.players.push(player);
  }
  return { blue: columns[0], orange: columns[1], clock: clockText, overtime, mode, wins };
}
