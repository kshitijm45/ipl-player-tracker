/**
 * Pull every tracked player's innings from CREX.
 *
 * CREX is the primary performance source: it is fresher than Cricsheet (it had the
 * 19 Sep England–Sri Lanka T20 while Cricsheet stopped at 17 Sep), it prints the
 * common names fans use, and it covers domestic tournaments that no free dataset
 * carries. Cricsheet remains the backfill for ball-by-ball depth and for players
 * CREX has no slug for.
 *
 * Cost: a full read of one player is ~50s, because each tournament card needs its
 * own page load. Runs are therefore cached aggressively and parallelised across a
 * few browser contexts. Everything is keyed by canonical Cricsheet id — a scraped
 * row never reaches the site unless its slug was pinned to a real player first.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CrexSource } from './sources/crex.js';

const CREX_PATH = new URL('../data/crex-players.json', import.meta.url).pathname;
const OUT_PATH = new URL('../data/crex-performances.json', import.meta.url).pathname;

/**
 * "29 May" -> "2026-05-29". CREX omits the year on match rows, so it has to come
 * from the tournament label, which carries it: "IPL 2026", "VHT 2024-25",
 * "BBL 2025-26". A split season ("2024-25") runs Oct-Dec in the first year and
 * Jan-Sep in the second, so the month decides which half a row belongs to.
 *
 * Getting this wrong is not cosmetic: assuming the current year stamped December
 * 2024 innings as December 2026, which put them in the future and at the top of
 * every "most recent" list.
 */
export function resolveDate(dayMonth, competition, fallbackYear = 2026) {
  if (!dayMonth) return null;
  const m = dayMonth.match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = months.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return null;

  const year = seasonYearFor(competition, mi + 1, fallbackYear);
  return `${year}-${String(mi + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
}

/** Pick the calendar year a month belongs to, given the tournament label. */
export function seasonYearFor(competition, month, fallbackYear = 2026) {
  const label = String(competition ?? '');

  // Split season, e.g. "VHT 2024-25" or "BBL 2025-26".
  const split = label.match(/(\d{4})\s*[-/]\s*(\d{2,4})/);
  if (split) {
    const first = +split[1];
    const second = split[2].length === 2 ? Math.floor(first / 100) * 100 + +split[2] : +split[2];
    // Oct-Dec sit in the opening year; Jan-Sep in the closing one.
    return month >= 10 ? first : second;
  }

  const single = label.match(/\b(20\d{2})\b/);
  if (single) return +single[1];

  return fallbackYear;
}

/**
 * The IPL ended on 31 May 2026. Everything from that point is what this tracker
 * follows, so the scrape skips tournaments that finished earlier rather than
 * re-reading the IPL and the season before it on every run.
 */
export const POST_IPL = '2026-06-01';

export async function ingest({ concurrency = 4, limit = Infinity, season = 2026, since = POST_IPL } = {}) {
  const pins = JSON.parse(readFileSync(CREX_PATH, 'utf8')).pins ?? {};
  const entries = Object.entries(pins).slice(0, limit);

  const existing = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, 'utf8'))
    : { byPlayer: {}, updatedAt: null };

  const results = { ...existing.byPlayer };
  let done = 0;
  let failed = 0;

  // A pool of workers, each with its own page, walking the same queue.
  const queue = [...entries];
  const source = new CrexSource();

  async function worker(n) {
    while (queue.length) {
      const [playerId, pin] = queue.shift();
      try {
        const rows = await source.fetchMatches(pin.slug, { maxAgeMs: 24 * 3600e3, since });
        results[playerId] = rows
          .map((r) => ({
            ...r,
            date: resolveDate(r.date, r.competition, season) ?? r.date,
            playerId,
          }))
          // A tournament spanning the cutoff still yields earlier innings; drop them.
          .filter((r) => !since || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date >= since);
        done++;
      } catch {
        failed++;
      }
      if ((done + failed) % 10 === 0) {
        process.stdout.write(`\r  ${done + failed}/${entries.length} (${failed} failed)`);
        flush(results);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  await source.close();

  flush(results);
  const total = Object.values(results).reduce((n, r) => n + r.length, 0);
  console.log(`\n  ${done} players, ${total} innings, ${failed} failed`);
  return { players: done, innings: total, failed };
}

function flush(byPlayer) {
  mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), byPlayer }, null, 0)
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const limit = process.argv[2] ? +process.argv[2] : Infinity;
  await ingest({ limit });
}
