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
export function expand(store, { today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) } = {}) {
  const out = [];

  // Whether a match is still being played is a fact about the match, so it is read
  // once per match and applied to every innings in it.
  //
  // It used to come from the per-snapshot `provisional` flag, which made the badge
  // depend on which run happened to write each row: in the Irani Cup Test, Akash
  // Deep's innings carried TEST IN PROGRESS while Ravichandran Smaran's — same match,
  // same day — did not, because their rows were written on different runs with
  // different commentary state. Two players in one match cannot disagree about
  // whether that match has finished.
  // `status` alone cannot answer this. It is written when the match page is read and
  // never revisited, so a match observed while live keeps "Live" in the store for
  // good: the Irani Cup final ended on 5 October and its innings still read TEST IN
  // PROGRESS two days later. The end date CREX prints on the same page is the fact
  // that settles it, and unlike the status it cannot go stale — a day that has passed
  // stays passed.
  const liveMatch = new Set();
  const ended = new Set();
  // The furthest day of play the store has seen for each match, which is how far the
  // match had got. An innings whose last day is behind that has closed.
  const latestDay = new Map();
  for (const row of Object.values(store.rows ?? {})) {
    if (!row.matchId) continue;
    if (row.status && row.status !== 'Finished') liveMatch.add(row.matchId);
    // A match whose last day has gone by is over, whatever the stored status says.
    // Collected rather than applied here: rows for one match arrive in no particular
    // order, so a later row still marked "Live" would otherwise re-add a match an
    // earlier one had already settled.
    if (row.endDate && row.endDate < today) ended.add(row.matchId);
    for (const day of Object.keys(row.days ?? {}).map(Number)) {
      if (day >= 1) latestDay.set(row.matchId, Math.max(latestDay.get(row.matchId) ?? 0, day));
    }
  }

  for (const id of ended) liveMatch.delete(id);

  for (const row of Object.values(store.rows ?? {})) {
    for (const d of dailyRows(row)) {
      out.push({
        playerId: row.playerId,
        matchId: row.matchId,
        inningsNo: row.innings,
        fixture: row.fixture ?? null,
        competition: row.competition ?? null,
        matchUrl: row.matchUrl ?? null,
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
        // Still moving only if the match is unfinished *and* this innings has not
        // closed on an earlier day. An innings that ended on day 2 of a Test still
        // being played is a result, not a running figure.
        provisional:
          (liveMatch.has(row.matchId) && d.day >= (latestDay.get(row.matchId) ?? d.day)) ||
          undefined,
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

/**
 * Multi-day matches still being played, with the tracked players in each.
 *
 * A Test is the match most worth knowing is on, and it is the one the fixtures scrape
 * cannot show: `/schedule` carries only upcoming limited-overs cards, so a five-day
 * match is absent for its whole duration — not filtered out, simply never listed.
 * Everything needed is already here, because the scrape reads each live match's page
 * to date its innings.
 *
 * Which matches count is decided by `status`, refreshed on the run that produced the
 * store, and never by the calendar. A Test can finish inside three days — the Irani
 * Cup ended on day five of a window that ran to the 5th, and a Sheffield Shield match
 * finished four days into a five-day window — so anything derived from `endDate`
 * would leave a decided match sitting on the page as though it were still on.
 *
 * `asOf` only guards against a store that has gone stale without being refreshed: a
 * match whose last day has passed cannot still be in progress whatever its status
 * says, which is the same reasoning `expand` applies to the badge.
 */
export function inProgressMatches(store, { asOf = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) } = {}) {
  const byMatch = new Map();

  for (const row of Object.values(store?.rows ?? {})) {
    if (!row?.matchId) continue;
    // Only what the latest read said: a match recorded Finished is over, and one
    // whose final day has gone by is over whether or not the store caught it.
    if (row.status === 'Finished') continue;
    if (row.endDate && row.endDate < asOf) continue;
    if (!row.status) continue;

    const m = byMatch.get(row.matchId) ?? {
      matchId: row.matchId,
      competition: row.competition ?? null,
      format: row.format ?? 'Test',
      venue: row.venue ?? null,
      startDate: row.startDate ?? null,
      endDate: row.endDate ?? null,
      matchUrl: row.matchUrl ?? null,
      day: null,
      players: new Map(),
    };
    m.competition ??= row.competition ?? null;
    m.venue ??= row.venue ?? null;
    m.matchUrl ??= row.matchUrl ?? null;

    // The furthest day any innings of this match has reached, which is the day the
    // match is on. Read per match rather than per player, because two players in one
    // match cannot be on different days of it.
    for (const d of Object.keys(row.days ?? {}).map(Number)) {
      if (d >= 1) m.day = Math.max(m.day ?? 0, d);
    }

    // One entry per player, with whatever he has done so far. A player named in the
    // match but yet to bat or bowl still belongs here: that he is playing is the
    // point.
    const existing = m.players.get(row.playerId) ?? { playerId: row.playerId, team: row.team ?? null, innings: [] };
    const latest = latestSnapshot(row);
    if (latest) existing.innings.push({ innings: row.innings ?? 1, ...latest });
    existing.team ??= row.team ?? null;
    m.players.set(row.playerId, existing);

    byMatch.set(row.matchId, m);
  }

  return [...byMatch.values()]
    .map((m) => ({ ...m, players: [...m.players.values()] }))
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
}

/** The most recent reading of one stored innings, whatever day it came from. */
function latestSnapshot(row) {
  const days = Object.keys(row?.days ?? {})
    .map(Number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);
  if (!days.length) return null;
  const s = row.days[days[days.length - 1]];
  if (!s) return null;
  if (!s.batting && !s.bowling) return null;
  return { day: days[days.length - 1], batting: s.batting ?? null, bowling: s.bowling ?? null };
}
