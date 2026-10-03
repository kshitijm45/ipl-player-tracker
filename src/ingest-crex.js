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
import { isMultiDay, resolveDay, stillCapturable } from './sources/crex-match-day.js';
import { hasFeed, inningsDays } from './sources/crex-commentary.js';
import { loadStore, saveStore, observe } from './core/match-days.js';

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
export const POST_IPL = process.env.SEASON_START ?? '2026-06-01';

/**
 * How long a scraped player page stays usable.
 *
 * The daily job sets this just under 24 hours so a scheduled run refetches every
 * player once a day, while a re-run on the same day reuses what is already cached
 * rather than spending another ninety minutes on CREX.
 */
export const CACHE_MS = (Number(process.env.CACHE_HOURS) || 24) * 3600e3;

/**
 * How many player pages are read at once.
 *
 * Four was too many once each card had to be selected twice: pages timed out, and
 * because a failed fetch returned an empty list rather than throwing, a run reported
 * "259 players, 0 failed" while seventy of them — Archer, Rashid Khan, Shreyas Iyer —
 * had quietly lost every innings. Two is slower and finishes intact.
 */
export const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 2;

/**
 * How long one player's page may take before the worker gives up on him.
 *
 * A heavy page — seven tournaments, each needing its own card selection — measures at
 * about 75 seconds, so this is generous rather than tight. It exists because nothing
 * else bounds a single read: Playwright's own timeouts cover individual actions, but a
 * page that stops responding between them can hold a worker forever, and with two
 * workers that is half the scrape stalled behind one player. The run would then sit
 * until the job's six-hour cap with no indication which player was responsible.
 *
 * A player who times out is recorded as a failure, which puts him in the retry pass
 * rather than dropping him silently.
 */
export const PLAYER_TIMEOUT_MS = Number(process.env.PLAYER_TIMEOUT_MS) || 300e3;

/**
 * How much of a live match's commentary the daily scrape reads.
 *
 * The feed is ordered newest-first, so the current day's play sits in the first few
 * pages and that is all this needs: it is settling which day the innings being played
 * belongs to, not reconstructing the match. Thirty pages is ~300 entries, comfortably
 * more than a day's commentary.
 *
 * Reading the whole feed instead cost eight silent minutes on a run that had already
 * finished scraping — ~200 pages for every Test in the data, re-read daily, for days
 * that had not changed since the match ended. The unbounded walk belongs to the
 * backfill, which runs once per match.
 */
export const LIVE_FEED_PAGES = Number(process.env.LIVE_FEED_PAGES) || 30;

/** Reject if `p` has not settled within `ms`. The caller records which player. */
function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)),
        ms
      );
    }),
  ]);
}

export async function ingest({ concurrency = CONCURRENCY, limit = Infinity, season = 2026, since = POST_IPL } = {}) {
  const file = JSON.parse(readFileSync(CREX_PATH, 'utf8'));
  const pins = file.pins ?? {};
  // Players with no Cricsheet id are keyed by name; their rows are stored under the
  // slug instead, which is the only identity they have.
  const slugPins = file.slugPins ?? {};
  const all = [
    ...Object.entries(pins),
    ...Object.entries(slugPins).map(([, pin]) => [pin.slug, pin]),
  ];
  const entries = Number.isFinite(limit) ? all.slice(0, limit) : all;
  if (!entries.length) {
    throw new Error(
      `crex ingest: nothing to scrape (${all.length} pins, limit=${limit}). Refusing to ` +
        'rewrite the existing file, which would report success for a run that fetched nothing.'
    );
  }

  const existing = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, 'utf8'))
    : { byPlayer: {}, updatedAt: null };

  const results = { ...existing.byPlayer };
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  const failures = [];

  // A pool of workers, each with its own page, walking the same queue.
  const queue = [...entries];
  const source = new CrexSource();

  async function worker(n) {
    while (queue.length) {
      const [playerId, pin] = queue.shift();
      try {
        const rows = await withTimeout(
          source.fetchMatches(pin.slug, { maxAgeMs: CACHE_MS, since }),
          PLAYER_TIMEOUT_MS
        );
        results[playerId] = rows
          .map((r) => ({
            ...r,
            date: resolveDate(r.date, r.competition, season) ?? r.date,
            playerId,
          }))
          // A tournament spanning the cutoff still yields earlier innings; drop them.
          .filter((r) => !since || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date >= since);
        done++;
      } catch (err) {
        // A swallowed error made a skipped player look like a scraped one: the run
        // reported "259 players, 0 failed" while thirteen — Boult, Jamieson,
        // Chameera, Shedge among them — had never been fetched at all. Record
        // which ones, and retry once before giving up on a player.
        failures.push({ playerId, slug: pin.slug, error: String(err?.message ?? err).slice(0, 120) });
        failed++;
      }
      report(pin.slug);
    }
  }

  /**
   * Progress, on every player rather than every tenth.
   *
   * The old line printed only when the count hit a multiple of ten, which with two
   * workers finishing at unrelated moments meant the tail usually skipped its last
   * multiple and printed nothing again: a healthy run sat on "240/256" for the final
   * ten minutes and looked wedged. Reporting each completion costs nothing and makes
   * the difference between slow and stuck visible.
   *
   * Written as a whole line with a newline, not `\r`, because CI captures a log file
   * rather than a terminal: a carriage return leaves one unterminated line that
   * appears frozen until the step ends. The player's slug is included so a run that
   * does stall names what it stalled on.
   */
  function report(slug) {
    const n = done + failed;
    const pct = Math.round((n / entries.length) * 100);
    const ago = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(
      `  ${n}/${entries.length} (${pct}%, ${failed} failed, ${ago}s) ${slug}\n`
    );
    // The partial result is still written every tenth player: a flush is a full
    // rewrite of the output file, and doing that 256 times is wasted work.
    if (n % 10 === 0) flush(results);
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  // The retries below call fetchMatches again, which reopens the browser. Closing it
  // here and never again left that second browser running, which kept the process
  // alive after the summary was printed. The single close now happens after the
  // retries, when the scrape is genuinely finished.
  if (failures.length) {
    console.log(`\n  retrying ${failures.length} failures`);
    for (const f of failures.splice(0)) {
      try {
        const rows = await source.fetchMatches(f.slug, { maxAgeMs: 0, since });
        results[f.playerId] = rows
          .map((r) => ({
            ...r,
            date: resolveDate(r.date, r.competition, season) ?? r.date,
            playerId: f.playerId,
          }))
          .filter((r) => !since || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date >= since);
        done++;
        failed--;
      } catch (err) {
        failures.push({ ...f, error: String(err?.message ?? err).slice(0, 120) });
      }
    }
  }

  // Multi-day attribution runs after the player sweep, once every innings is known.
  const multi = await recordMatchDays(source, results);

  await source.close();

  flush(results);
  const total = Object.values(results).reduce((n, r) => n + r.length, 0);
  console.log(`\n  ${done} players, ${total} innings, ${failed} failed`);
  if (multi.matches) {
    console.log(
      `  multi-day: ${multi.observed} innings dated across ${multi.matches} matches ` +
        `(${multi.live} in progress, ${multi.commentaryDated} settled by commentary` +
        `${multi.noFeed ? `, ${multi.noFeed} with no feed` : ''})` +
        (multi.unrecoverable
          ? `\n  ${multi.unrecoverable} innings could not be dated and keep the match start date`
          : '')
    );
  }
  if (failures.length) {
    console.log('  still failing:');
    for (const f of failures) console.log(`    ${f.slug} — ${f.error}`);
  }
  return { players: done, innings: total, failed, failures };
}

/**
 * Date every multi-day innings that can still be dated, and record it.
 *
 * Runs once per scrape, after the player sweep. For each Test match a tracked player
 * appeared in, the match page is read for its day of play, and every innings in that
 * match is snapshotted against that day. Differencing consecutive snapshots at build
 * time is what turns "145 on the 23rd" into "+75 on the 25th".
 *
 * Three things keep this cheap. Matches are fetched once each, not once per player —
 * twelve players in one Test is one request. The fetch is plain HTTP, because the day
 * marker is server-rendered. And a match CREX has marked finished is never re-read:
 * its cache entry is permanent, since nothing about it can change again.
 *
 * What it cannot do is recover a match that finished before this ran for the first
 * time. CREX removes the day marker when a match ends, so those innings have no day
 * to find and keep the match's start date — counted as `unrecoverable` so the number
 * is visible rather than silent.
 */
async function recordMatchDays(source, byPlayer) {
  const store = loadStore();
  if (store.corrupt) {
    console.warn(
      '\n  warning: data/crex-match-days.json could not be parsed and is being ' +
        'rebuilt empty. Day-by-day history for matches already finished is lost.'
    );
  }

  // Group every multi-day innings by the match it belongs to.
  const byMatch = new Map();
  for (const rows of Object.values(byPlayer)) {
    for (const r of rows ?? []) {
      if (!isMultiDay(r.format) || !r.matchId) continue;
      if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
      byMatch.get(r.matchId).push(r);
    }
  }
  if (!byMatch.size) return { matches: 0, live: 0, observed: 0, unrecoverable: 0 };

  // The scrape runs at 00:00 IST, which is mid-afternoon in England and before dawn
  // in Australia, so "today" in UTC is the only defensible observation date: it is
  // the day the figures were read, and the match page's own day label is what
  // actually places them.
  const observedOn = new Date().toISOString().slice(0, 10);

  let live = 0;
  let observed = 0;
  let unrecoverable = 0;
  let commentaryDated = 0;
  let noFeed = 0;

  let n = 0;
  for (const [matchId, rows] of byMatch) {
    n++;
    // A match settled by its commentary feed is final: the feed does not change once
    // the match is over, so it is read once per match ever.
    //
    // "Settled" is only trusted for a match the store also recorded as finished. A
    // run that marked a live match settled would otherwise freeze it forever: the
    // skip here means it is never re-read, so its figures stop updating and its
    // TEST IN PROGRESS badge never appears. The Irani Cup Test was stored as
    // `status: Live, settled: true` by an earlier build and went stale exactly that
    // way, which no amount of re-running would have fixed.
    const known = Object.values(store.rows).find((x) => x.matchId === matchId);
    if (known?.settled && known?.status === 'Finished') continue;

    const meta = await source.fetchMatchDay(matchId, { maxAgeMs: 0 });
    const capturable = stillCapturable(meta);
    if (capturable) live++;

    // The commentary feed is the authority on which day each innings ended, because
    // it states it outright and can be re-read at any time. The live `.day-session`
    // label only says which day the *match* is on and is deleted when the match ends,
    // so inferring a closing day from it requires every scheduled run to have landed
    // — and one missed run would freeze an innings at its overnight figure forever.
    //
    // The walk is capped here, though, and that cap is the difference between a
    // scrape that takes twelve minutes and one that takes twenty. A full feed is
    // ~200 pages and ~18 seconds, and doing that for every Test in the data adds
    // eight silent minutes to every run for information that does not change.
    //
    // Only the newest pages are needed to settle a match in progress: the feed is
    // ordered newest-first, so today's play is at the front. Anything older is the
    // backfill's job, which is where the unbounded walk belongs.
    // A match seen for the first time gets the full walk even while live, because
    // there is no snapshot history to date its earlier innings from: an innings that
    // closed on day 2 would otherwise be recorded against today. Once the store has
    // days for it, the capped read is enough — the history supplies the rest.
    const firstSight = !known;
    const feed = await settleFromCommentary(matchId, {
      maxPages: capturable ? (firstSight ? undefined : LIVE_FEED_PAGES) : 0,
    });
    if (feed?.dated) commentaryDated++;
    else if (feed === null) noFeed++;

    process.stdout.write(
      `  match ${n}/${byMatch.size} ${matchId}` +
        ` ${capturable ? 'live' : 'finished'}` +
        `${feed?.dated ? ', dated' : feed === null ? ', no feed' : ''}\n`
    );

    for (const r of rows) {
      const innings = r.innings ?? 1;
      // Prefer the feed's closing day. Fall back to the live label, which still
      // places a figure read mid-match on the day it was read.
      const ended = feed?.endedOn?.[innings] ?? null;
      const { day, date, from } = ended
        ? { day: dayNumber(meta?.startDate, ended), date: ended, from: 'commentary' }
        : resolveDay({
            label: meta?.day,
            startDate: meta?.startDate,
            observedOn,
            status: meta?.status,
          });

      if (!(day >= 1)) {
        // Nothing can date this innings: no feed, and either the match is over or
        // its page could not be read. It keeps the match start date.
        if (from === 'finished' || from === 'unknown') unrecoverable++;
        continue;
      }

      observe(store, {
        playerId: r.playerId,
        matchId,
        innings,
        day,
        date,
        batting: r.batting ?? null,
        bowling: r.bowling ?? null,
        // Which figures can still move, and it is not simply "all of them while the
        // match is on". An innings that closed on day 2 of a Test still being played
        // is finished — the batsman is out and the figure is final — so badging it
        // "in progress" because the match continues is wrong.
        //
        // The commentary feed says which day each innings ended, so an innings whose
        // closing day is already behind us is settled even mid-match. Only one dated
        // today, in a match still live, is genuinely unfinished.
        provisional: isStillMoving({ ended, capturable, observedOn }) || undefined,
        meta: {
          fixture: r.fixture ?? null,
          competition: r.competition ?? null,
          format: r.format ?? 'Test',
          team: r.team ?? null,
          opponent: r.opponent ?? null,
          startDate: meta?.startDate ?? null,
          endDate: meta?.endDate ?? null,
          venue: meta?.venue ?? null,
          status: meta?.status ?? null,
          // A finished match whose feed was walked end to end needs no further
          // reads, so it is never fetched again.
          settled: Boolean(feed?.complete) && !capturable,
        },
      });
      observed++;
    }
  }

  saveStore(store);
  return { matches: byMatch.size, live, observed, unrecoverable, commentaryDated, noFeed };
}

/**
 * Can this figure still change?
 *
 * Only if the match is still being played *and* this innings has not already closed.
 * Where the commentary feed gave a closing day, an earlier one means the innings is
 * over whatever the match is doing. Without a closing day, the match's own state is
 * all there is to go on.
 */
function isStillMoving({ ended, capturable, observedOn }) {
  if (!capturable) return false;
  if (!ended) return true;
  return ended >= observedOn;
}

/** Which day of the match is this date? Day 1 is the start date itself. */
function dayNumber(startDate, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? ''))) return 1;
  const n = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 864e5
  );
  return n >= 0 ? n + 1 : 1;
}

/**
 * Ask the commentary feed when each innings of this match ended.
 *
 * Returns null when the match has no feed at all — coverage is per match, not per
 * tier, so a one-request probe decides it before spending a 200-page walk. Every
 * failure is soft: the caller falls back to the live label, and an innings that
 * cannot be dated keeps the match start date, exactly as before this existed.
 */
async function settleFromCommentary(matchId, { maxPages } = {}) {
  try {
    if (!(await hasFeed(matchId))) return null;
    // `maxPages: 0` means do not walk at all — the match is finished, so its days are
    // the backfill's business and the daily scrape has nothing to add.
    if (maxPages === 0) return undefined;
    const r = await inningsDays(matchId, maxPages ? { maxPages } : {});
    return { ...r, dated: Object.keys(r.endedOn).length > 0 };
  } catch {
    return undefined;
  }
}

function flush(byPlayer) {
  mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), byPlayer }, null, 0)
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Named flags, and a bare number still means --limit. A positional string used to
  // be coerced with `+`, so `--since=2026-06-01` became NaN, `slice(0, NaN)` emptied
  // the queue, and the run rewrote the previous file reporting "0 players" — a
  // no-op that looked like a successful scrape.
  const argv = process.argv.slice(2);
  const opts = {};
  for (const a of argv) {
    const flag = a.match(/^--([a-z]+)=(.+)$/);
    if (flag) {
      const [, k, v] = flag;
      opts[k] = /^\d+$/.test(v) ? +v : v;
    } else if (/^\d+$/.test(a)) {
      opts.limit = +a;
    } else {
      console.error(`ingest-crex: unrecognised argument "${a}"`);
      process.exit(1);
    }
  }
  const result = await ingest(opts);

  // Exit explicitly rather than waiting for the event loop to drain.
  //
  // Everything is already written to disk by this point, but the run opens a browser
  // per worker and another for each retry, and a fetch that failed part-way can leave
  // a page or a pipe behind. Any one of those keeps Node alive indefinitely: the
  // summary prints, the function returns, and the process simply never ends. At a
  // terminal that looks like a pause; in CI the step sat for an hour past the end of
  // the work before the job timed out.
  //
  // There is nothing left to wait for, so say so — after stdout has drained, since
  // process.exit() would otherwise cut off the summary that was just written.
  const code = result.failed && !result.players ? 1 : 0;
  if (process.stdout.writableLength) process.stdout.once('drain', () => process.exit(code));
  else process.exit(code);
}
