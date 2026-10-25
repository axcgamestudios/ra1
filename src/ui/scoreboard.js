// Rocket League-style scoreboard: per-player goals, assists, saves, shots and
// points in a dark glass panel with team rails. Manual only — hold TAB.
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
        <div class="arena-scoreboard__clockwrap">
          <span class="arena-scoreboard__clock" data-board="clock">5:00</span>
          <span class="arena-scoreboard__label">MATCH</span>
        </div>
        <div class="arena-scoreboard__team-score arena-scoreboard__team-score--orange">
          <b data-board="orange-score">0</b><span>ORANGE</span>
        </div>
      </header>
      <div class="arena-scoreboard__columns">
        <table class="arena-scoreboard__team arena-scoreboard__team--blue" data-board="blue-rows"></table>
        <table class="arena-scoreboard__team arena-scoreboard__team--orange" data-board="orange-rows"></table>
      </div>
      <footer class="arena-scoreboard__hint">HOLD TAB · G GOALS · A ASSISTS · SV SAVES · SH SHOTS · PTS</footer>
    </div>`;
  (root ?? document.body).append(element);
  const find = name => element.querySelector(`[data-board="${name}"]`);
  const blueScore = find('blue-score'), orangeScore = find('orange-score'), clock = find('clock');
  const rowLists = { 0: find('blue-rows'), 1: find('orange-rows') };

  let hideTimer = 0;
  let renderKey = '';

  function playerRow(player) {
    const row = document.createElement('tr');
    row.className = 'arena-scoreboard__player';
    if (player.you) row.classList.add('is-you');
    if (player.left) row.classList.add('is-left');
    const cells = [
      ['name', player.you ? `${player.name} · YOU` : player.left ? `${player.name} · LEFT` : player.name],
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
  function show({ blue, orange, clock: clockText = '', transient = 0 }) {
    const key = JSON.stringify({ blue, orange, clockText });
    if (key !== renderKey || element.hidden) {
      renderKey = key;
      blueScore.textContent = String(blue.score ?? 0);
      orangeScore.textContent = String(orange.score ?? 0);
      clock.textContent = clockText;
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
export function scoreboardData(summary, roster, teams, { selfSlot = null, blueScore = 0, orangeScore = 0, clockText = '' } = {}) {
  const columns = { 0: { score: blueScore, players: [] }, 1: { score: orangeScore, players: [] } };
  const slots = summary?.slots ?? [];
  for (let slot = 0; slot < Math.max(slots.length, roster?.length ?? 0); slot++) {
    const stats = slots[slot] ?? { goals: 0, assists: 0, saves: 0, epicSaves: 0, shots: 0, points: 0 };
    const team = teams?.[slot] ?? roster?.[slot]?.team ?? (slot % 2);
    const player = {
      name: roster?.[slot]?.name ?? (slot === 0 ? 'YOU' : `PLAYER ${slot + 1}`),
      goals: stats.goals ?? 0, assists: stats.assists ?? 0, saves: stats.saves ?? 0,
      epicSaves: stats.epicSaves ?? 0, shots: stats.shots ?? 0, points: stats.points ?? 0,
      you: selfSlot === null ? slot === 0 : slot === selfSlot,
      left: !!roster?.[slot]?.disconnected,
    };
    columns[team]?.players.push(player);
  }
  return { blue: columns[0], orange: columns[1], clock: clockText };
}
