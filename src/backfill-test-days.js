/**
 * One-time backfill: date every Test innings already in the data.
 *
 * CREX stamps each innings of a Test with the match's *start* date, so the 393 Test
 * innings scraped before day attribution existed are piled onto 29 dates — 55 of them
 * on 23 August alone, with the four days behind it empty. This walks each match's
 * commentary feed, which states the day each innings ended, and writes the result into
 * the same store the daily scrape uses.
 *
 * Run once, by hand, not in CI:
 *
 *   node src/backfill-test-days.js            # every Test match
 *   node src/backfill-test-days.js --dry      # report what it would do
 *   node src/backfill-test-days.js --limit=5  # try a few first
 *
 * Cost is about 18 seconds and ~200 requests per match, so roughly 20 minutes for all
 * of them. A single-page probe runs first and skips matches with no feed, which is
 * cheap and worth it: coverage is per match rather than per tier, and several domestic
 * fixtures have none.
 *
 * It is safe to re-run. A match already settled in the store is skipped, so an
 * interrupted backfill resumes rather than starting over.
 *
 * It depends on the scrape having recorded `matchId` against each innings, which only
 * started when day attribution was added. If no Test row carries one, run `npm run
 * scrape` first and the ids will be there.
 */

import { readFileSync, existsSync } from 'node:fs';
import { hasFeed, inningsDays } from './sources/crex-commentary.js';
import { isMultiDay } from './sources/crex-match-day.js';
import { loadStore, saveStore, observe } from './core/match-days.js';

const PERF = new URL('../data/crex-performances.json', import.meta.url).pathname;

/** Every multi-day innings in the scrape, grouped by the match it belongs to. */
function testMatches() {
  if (!existsSync(PERF)) return new Map();
  const byPlayer = JSON.parse(readFileSync(PERF, 'utf8')).byPlayer ?? {};
  const byMatch = new Map();
  for (const rows of Object.values(byPlayer)) {
    for (const r of rows ?? []) {
      if (!isMultiDay(r.format) || !r.matchId) continue;
      if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
      byMatch.get(r.matchId).push(r);
    }
  }
  return byMatch;
}

export async function backfill({ limit = Infinity, dry = false } = {}) {
  const byMatch = testMatches();
  const store = loadStore();

  if (!byMatch.size) {
    const total = existsSync(PERF)
      ? Object.values(JSON.parse(readFileSync(PERF, 'utf8')).byPlayer ?? {})
          .flat()
          .filter((r) => isMultiDay(r.format)).length
      : 0;
    console.log(
      total
        ? `No Test innings carries a matchId yet (${total} Test rows found).\n` +
            'The scrape records it from the "View >" link on each row, so run ' +
            '`npm run scrape` once and then re-run this.'
        : 'No Test innings in data/crex-performances.json.'
    );
    return { matches: 0, dated: 0, skipped: 0, noFeed: 0 };
  }

  const settled = new Set(
    Object.values(store.rows ?? {}).filter((r) => r.settled).map((r) => r.matchId)
  );

  const todo = [...byMatch].filter(([id]) => !settled.has(id)).slice(0, limit);
  console.log(
    `${byMatch.size} Test matches, ${settled.size} already settled, ${todo.length} to do` +
      (dry ? ' (dry run)' : '')
  );

  let dated = 0;
  let noFeed = 0;
  let undatedInnings = 0;
  let n = 0;

  for (const [matchId, rows] of todo) {
    n++;
    const label = `${rows[0]?.competition ?? '?'} ${rows[0]?.fixture?.split(',')[0] ?? ''}`.trim();
    process.stdout.write(`\r  ${n}/${todo.length} ${matchId} ${label.slice(0, 44).padEnd(44)}`);

    if (!(await hasFeed(matchId))) {
      noFeed++;
      continue;
    }

    const feed = await inningsDays(matchId);
    const days = Object.keys(feed.endedOn).length;
    if (!days) continue;

    if (dry) {
      console.log(`\n    ${label}: innings ${JSON.stringify(feed.endedOn)}`);
      dated++;
      continue;
    }

    // The match's own start date, which is what every row currently carries.
    const startDate = rows[0]?.date ?? null;

    for (const r of rows) {
      const innings = r.innings ?? 1;
      const ended = feed.endedOn[innings];
      if (!ended) { undatedInnings++; continue; }
      observe(store, {
        playerId: r.playerId,
        matchId,
        innings,
        day: dayNumber(startDate, ended),
        date: ended,
        batting: r.batting ?? null,
        bowling: r.bowling ?? null,
        meta: {
          fixture: r.fixture ?? null,
          competition: r.competition ?? null,
          format: r.format ?? 'Test',
          team: r.team ?? null,
          opponent: r.opponent ?? null,
          startDate,
          // Walked end to end and the match is long over, so this never needs
          // reading again.
          settled: feed.complete,
        },
      });
    }
    dated++;
    // Written as it goes, so an interrupted run keeps the matches it finished.
    saveStore(store);
  }

  console.log(
    `\n  ${dated} matches dated, ${noFeed} with no commentary feed` +
      (undatedInnings ? `, ${undatedInnings} innings not covered by their feed` : '')
  );
  return { matches: todo.length, dated, noFeed, undatedInnings };
}

function dayNumber(startDate, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? ''))) return 1;
  const n = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 864e5
  );
  return n >= 0 ? n + 1 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = {};
  for (const a of process.argv.slice(2)) {
    if (a === '--dry') opts.dry = true;
    else {
      const m = a.match(/^--limit=(\d+)$/);
      if (m) opts.limit = +m[1];
      else {
        console.error(`backfill-test-days: unrecognised argument "${a}"`);
        process.exit(1);
      }
    }
  }
  await backfill(opts);
  process.exit(0);
}
