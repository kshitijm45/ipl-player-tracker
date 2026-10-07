/**
 * Backfill: balls bowled, and whether each batsman was out.
 *
 * Two fields the player page cannot give, and without them two of the eight career
 * figures cannot be computed at all:
 *
 *   - **Balls bowled.** Never stored, because the player page's bowling view prints
 *     only "4-48" plus an economy figure the scraper must discard (a bowler's
 *     "78 (114)" is indistinguishable from a batting innings). No balls, no economy
 *     and no bowling strike rate — for every bowling innings in the data.
 *   - **Not out.** The page drops the asterisk, so every innings was recorded as a
 *     dismissal: 2,278 out of 2,278, which is impossible. Shubman Gill's 223* was
 *     stored as out, and that one player's average read 70.00 instead of 86.15.
 *
 * Both are stated plainly on the match scorecard. Its HTML is server-rendered, but only
 * for the innings the page opens on: the other sits behind a toggle with no URL of its
 * own, and 473 of the 750 matches here need players from both. So this drives a browser
 * after all, clicking through the innings as a reader would.
 *
 *   node src/backfill-scorecards.js            # every match in the data
 *   node src/backfill-scorecards.js --dry      # report without writing
 *   node src/backfill-scorecards.js --limit=5  # try a few first
 *   node src/backfill-scorecards.js --force    # re-read matches already done
 *   node src/backfill-scorecards.js --repair   # re-read multi-innings (Test) matches
 *
 * Safe to re-run and safe to interrupt: a match whose innings are already enriched is
 * skipped, so an interrupted run resumes rather than starting over. Writes happen
 * periodically rather than only at the end, so a run killed halfway keeps its work.
 *
 * Cost: ~750 matches at roughly 6s each — a page load plus a click per innings — so
 * about an hour and a quarter cold. A finished scorecard can never change, so it is a
 * one-time cost plus the few matches played each day.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchFullScorecard, fetchPlayerOfMatch } from './sources/crex-scorecard.js';
import { enrich, needsScorecard, matchesToBackfill } from './core/scorecard-merge.js';

const PERF = new URL('../data/crex-performances.json', import.meta.url).pathname;
const PLAYERS = new URL('../data/crex-players.json', import.meta.url).pathname;

/** Save every N matches, so an interrupted run does not throw away its work. */
const SAVE_EVERY = 25;

/**
 * Slug per player id, for matching a scorecard row to the player it belongs to.
 *
 * The scorecard keys players by slug and the performance store keys them by canonical
 * id, so the pin file is the bridge — the same contract the scrape already relies on.
 * No name matching: a scorecard row whose slug is not pinned is simply not ours.
 */
export function slugsById(raw) {
  const pins = raw?.pins ?? {};
  const out = new Map();
  for (const [playerId, pin] of Object.entries(pins)) {
    if (pin?.slug) out.set(playerId, pin.slug);
  }
  return out;
}

function loadSlugs() {
  if (!existsSync(PLAYERS)) return new Map();
  return slugsById(JSON.parse(readFileSync(PLAYERS, 'utf8')));
}

/**
 * A browser is needed, reluctantly.
 *
 * The scorecard's HTML is server-rendered, so a plain `fetch` was the obvious way to
 * read it — but it renders only the innings the page opens on and keeps the rest
 * behind a toggle with no URL of its own. 473 of the 750 matches here need players
 * from both innings, and on IND v WI eleven of the twelve tracked players sit in the
 * innings that does not render. A fetch-only backfill enriched one of them and
 * reported success.
 */
async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'backfill-scorecards: playwright is not installed. ' +
        'Run `npm i playwright && npx playwright install chromium`.'
    );
  }
  return chromium.launch();
}

/**
 * Chromium occasionally declines to exit after a long run of page opens, which would
 * leave a finished backfill hanging with its data already written. Same treatment as
 * the scrape: give the close a few seconds, then abandon it.
 */
async function closeBrowser(browser) {
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

export async function backfillScorecards({
  limit = Infinity,
  dry = false,
  force = false,
  repair = false,
  log = console.log,
} = {}) {
  if (!existsSync(PERF)) {
    log('no data/crex-performances.json — run `npm run scrape` first');
    return { matches: 0, enriched: 0 };
  }

  const store = JSON.parse(readFileSync(PERF, 'utf8'));
  const byPlayer = store.byPlayer ?? {};
  const slugs = loadSlugs();

  const pending = matchesToBackfill(byPlayer, { force, repair });
  const total = pending.length;
  const todo = pending.slice(0, limit === Infinity ? undefined : limit);

  log(
    `${total} match${total === 1 ? '' : 'es'} to read` +
      (todo.length < total ? `, trying ${todo.length}` : '') +
      (dry ? ' (dry run)' : '')
  );
  if (!todo.length) return { matches: 0, enriched: 0 };

  const browser = await launchBrowser();
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1500, height: 1000 },
  });

  let read = 0;
  let failed = 0;
  let enrichedRows = 0;
  let notOuts = 0;
  let ballsAdded = 0;
  let corrected = 0;
  let awards = 0;
  let sinceSave = 0;

  for (const [i, m] of todo.entries()) {
    const card = await fetchFullScorecard(page, { matchId: m.matchId, matchUrl: m.matchUrl });
    if (!card) {
      // Soft, as everywhere else CREX is read: the innings keeps what it has.
      failed++;
      log(`  ${i + 1}/${todo.length} ${m.matchId} — unreadable, left as is`);
      continue;
    }
    read++;

    // One extra request per match, for the award that sits on the match page rather
    // than its scorecard tab. Null where none is named, which is routine.
    const potm = await fetchPlayerOfMatch({ matchUrl: m.matchUrl ?? card.url });
    const result = enrich(byPlayer, card, { matchId: m.matchId, slugs, potm });
    enrichedRows += result.rows;
    notOuts += result.notOuts;
    ballsAdded += result.ballsAdded;
    corrected += result.corrected ?? 0;
    awards += result.awards ?? 0;

    log(
      `  ${i + 1}/${todo.length} ${m.matchId} — ${result.rows} innings` +
        `${result.notOuts ? `, ${result.notOuts} not out` : ''}` +
        `${result.ballsAdded ? `, ${result.ballsAdded} with balls bowled` : ''}` +
        `${result.corrected ? `, ${result.corrected} corrected` : ''}` +
        `${result.awards ? ', player of the match' : ''}`
    );

    if (!dry && ++sinceSave >= SAVE_EVERY) {
      save(store, byPlayer);
      sinceSave = 0;
    }
  }

  if (!dry) save(store, byPlayer);
  await page.close().catch(() => {});
  await closeBrowser(browser);

  log(
    `\nread ${read}/${todo.length} scorecards (${failed} unreadable), ` +
      `enriched ${enrichedRows} innings: ${notOuts} not-outs, ${ballsAdded} with balls bowled` +
      `${corrected ? `, ${corrected} corrected` : ''}`
  );
  return { matches: read, failed, enriched: enrichedRows, notOuts, ballsAdded, corrected };
}

function save(store, byPlayer) {
  writeFileSync(
    PERF,
    JSON.stringify({ ...store, byPlayer, scorecardsAt: new Date().toISOString() })
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const has = (name) => process.argv.includes(`--${name}`);
  backfillScorecards({
    limit: arg('limit') ? Number(arg('limit')) : Infinity,
    dry: has('dry'),
    force: has('force'),
    repair: has('repair'),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { needsScorecard };
