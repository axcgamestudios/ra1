// Local player progression: counts finished matches and team wins, derives a
// Rocket Ball style level for the home player card, and feeds the
// scoreboard's WINS rails. Purely cosmetic, stored locally.
import { createSettingsStore } from './settings-store.js';

const PROGRESS_KEY = 'rocket-arena.player-progress.v1';

const store = createSettingsStore(PROGRESS_KEY, () => ({ played: 0, blueWins: 0, orangeWins: 0 }), (target, saved) => {
  target.played = Number.isFinite(saved?.played) && saved.played > 0 ? Math.floor(saved.played) : 0;
  target.blueWins = Number.isFinite(saved?.blueWins) && saved.blueWins > 0 ? Math.floor(saved.blueWins) : 0;
  target.orangeWins = Number.isFinite(saved?.orangeWins) && saved.orangeWins > 0 ? Math.floor(saved.orangeWins) : 0;
});

// RL-style curve: brisk early levels, steadier afterwards.
export function playerLevel() {
  const { played } = store.load();
  return Math.max(1, Math.floor(1 + Math.sqrt(played * 1.6)));
}

export function playerMatches() {
  return store.load().played;
}

export function teamWins() {
  const { blueWins, orangeWins } = store.load();
  return { blue: blueWins, orange: orangeWins };
}

export function recordFinishedMatch({ winnerTeam = null } = {}) {
  const current = store.load();
  const next = { played: Math.min(current.played + 1, 100000), blueWins: current.blueWins, orangeWins: current.orangeWins };
  if (winnerTeam === 0) next.blueWins = Math.min(next.blueWins + 1, 100000);
  else if (winnerTeam === 1) next.orangeWins = Math.min(next.orangeWins + 1, 100000);
  store.save(next);
}
