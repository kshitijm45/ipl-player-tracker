/**
 * The multi-day snapshot store.
 *
 * `data/crex-match-days.json` holds one row per (player, match, innings), recording
 * the figure observed on each day of play. The build reads the sequence to decide
 * which day the innings ended on — the last day its figure advanced — and shows the
 * innings once, on that day, with the whole figure CREX prints. The per-day snapshots
 * exist to identify that day, not to be split into daily contributions.
 *
 * Keeping every day's reading rather than only the latest is also what lets a
 * correction be told apart from a day's play: a figure that falls, or grows after the
 * batsman was out, is a re-reading of the same innings and must not move its date.
 *
 * This file is the project's only piece of genuinely accumulated state, and that is
 * deliberate: CREX removes a Test's day marker the moment the match ends. A day of
 * play never recorded can only be recovered where the match has a commentary feed
 * (see `../sources/crex-commentary.js`), and several domestic fixtures have none.
 * Everything else here can be rebuilt from a fresh scrape; this cannot, so it is
 * committed and never rewritten wholesale.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { snapKey, recordSnapshot, dailyRows } from '../sources/crex-match-day.js';

const STORE = new URL('../../data/crex-match-days.json', import.meta.url).pathname;

export function loadStore(path = STORE) {
  if (!existsSync(path)) return { updatedAt: null, rows: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { updatedAt: raw.updatedAt ?? null, rows: raw.rows ?? {} };
  } catch {
    // A corrupt store would otherwise take the scrape down with it. Starting empty
    // loses history, so it is reported loudly by the caller rather than silently.
    return { updatedAt: null, rows: {}, corrupt: true };
  }
}

export function saveStore(store, path = STORE) {
  mkdirSync(new URL('../../data', import.meta.url).pathname, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ updatedAt: new Date().toISOString(), rows: store.rows }, null, 0)
  );
}

/**
 * Fold one observed innings into the store.
 *
 * `day` is the day of play the observation belongs to, already resolved from the
 * match page's own label where it had one. An observation with no day is dropped: a
 * figure that cannot be dated is exactly the thing this store exists to avoid
 * inventing.
 */
export function observe(store, { playerId, matchId, innings, day, date, batting, bowling, provisional, meta }) {
  if (!playerId || !matchId || !(day >= 1)) return store;
  const k = snapKey(playerId, matchId, innings);
  const row = recordSnapshot(store.rows[k], { day, date, batting, bowling, provisional });
  // Match-level facts travel on the row so the build does not need the store and the
  // match cache both.
  const next = {
    ...row,
    playerId,
    matchId,
    innings: innings ?? 1,
    ...(meta ?? {}),
  };
  // A match still being played is never settled, whatever the caller passed. The two
  // together are contradictory, and the contradiction is self-perpetuating: the scrape
  // skips a settled match, so one bad write stops it ever being read again and the
  // figures freeze mid-match.
  if (next.settled && next.status && next.status !== 'Finished') next.settled = false;
  store.rows[k] = next;
  return store;
}

/**
 * Every dated innings the store can produce, flattened for the build.
 *
 * One row per innings, carrying the figure CREX prints and the date the innings
 * ended. The match's start date travels alongside as `matchDate`, because that is
 * what CREX stamped the innings with and what the site showed before this existed.
 */
export function expand(store) {
  const out = [];
  for (const row of Object.values(store.rows ?? {})) {
    for (const d of dailyRows(row)) {
      out.push({
        playerId: row.playerId,
        matchId: row.matchId,
        inningsNo: row.innings,
        fixture: row.fixture ?? null,
        competition: row.competition ?? null,
        format: row.format ?? 'Test',
        team: row.team ?? null,
        opponent: row.opponent ?? null,
        venue: row.venue ?? null,
        source: 'crex',
        matchDate: row.startDate ?? null,
        date: d.date,
        day: d.day,
        batting: d.batting,
        bowling: d.bowling,
        // Which days of the match the innings ran across, so a page can say an
        // overnight hundred took two days rather than implying one session.
        spanned: d.spanned,
        provisional: d.provisional,
        // Dated by this project rather than by CREX's own row, which is the thing
        // worth being able to distinguish later.
        multiDay: true,
      });
    }
  }
  return out;
}

/** Rows for matches still in progress, which are refetched on every run. */
export function liveMatchIds(store) {
  const ids = new Set();
  for (const row of Object.values(store.rows ?? {})) {
    if (row.status && row.status !== 'Finished') ids.add(row.matchId);
  }
  return ids;
}
