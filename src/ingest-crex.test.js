/**
 * Cache-window parsing.
 *
 * One falsy zero cost four full rescrapes. `CACHE_HOURS=0` means "ignore the cache",
 * and `(Number('0') || 24)` turned it into twenty-four hours — so every run launched
 * with `full_rescrape=true` was served from cache, reproduced the same stale rows, and
 * made fixes that worked locally look broken in CI.
 *
 * Run: node --test src/ingest-crex.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheMs, keepRicher, SETTLED_AFTER_DAYS } from './ingest-crex.js';

const H = 3600e3;

test('zero means do not use the cache', () => {
  // The case the old expression got wrong, and the only one that matters for
  // `full_rescrape`. `readCache` already honours 0; it simply never received it.
  assert.equal(cacheMs('0'), 0);
  assert.equal(cacheMs(0), 0);
});

test('a real window is taken as given', () => {
  assert.equal(cacheMs('20'), 20 * H);
  assert.equal(cacheMs('24'), 24 * H);
  assert.equal(cacheMs('1'), 1 * H);
});

test('an absent or unparseable value falls back to a day', () => {
  assert.equal(cacheMs(undefined), 24 * H);
  assert.equal(cacheMs(''), 24 * H);
  assert.equal(cacheMs('   '), 24 * H);
  assert.equal(cacheMs('abc'), 24 * H);
});

/* ── short reads ──
   A player page is read through a sequence of tab clicks and card selections, each
   wrapped in a catch, so an incomplete read looks exactly like a player with fewer
   innings. It silently replaced good data with less: a genuinely cold scrape returned
   2,807 innings where the previous run held 2,832, and Kuldeep Yadav lost his three
   West Indies ODIs. */

test('a re-read with fewer rows keeps the fuller previous set', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  const previous = [{ date: '2026-10-03' }, { date: '2026-09-30' }, { date: '2026-09-27' }];
  const short = [{ date: '2026-09-27' }];
  assert.deepEqual(keepRicher(previous, short, 'kuldeep-yadav-75'), previous);
});

test('a re-read with the same or more rows wins', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  const previous = [{ date: '2026-09-27' }];
  const more = [{ date: '2026-10-03' }, { date: '2026-09-27' }];
  assert.deepEqual(keepRicher(previous, more, 'x'), more);
  // Equal counts take the fresh rows, so a corrected figure still lands.
  const same = [{ date: '2026-09-27', batting: { runs: 9 } }];
  assert.deepEqual(keepRicher(previous, same, 'x'), same);
});

test('a player with no previous rows takes whatever was read', async () => {
  const { keepRicher } = await import('./ingest-crex.js');
  assert.deepEqual(keepRicher(undefined, [{ date: '2026-10-03' }], 'x'), [{ date: '2026-10-03' }]);
  assert.deepEqual(keepRicher([], [], 'x'), []);
});

/* ── carrying the scorecard's fields across a re-scrape ──
   Balls bowled and the not-out flag come from the match scorecard, which the player
   page cannot produce. A nightly scrape returns rows without them, so without this
   the backfill is undone every evening — and the only symptom would be averages
   quietly turning back into dashes. */

test('a re-scrape keeps balls bowled', () => {
  const previous = [
    { date: '2026-10-02', format: 'T20', fixture: '15th T20 vs LIO',
      bowling: { wickets: 1, runs: 34, balls: 24, maidens: 0, econ: 8.5 } },
  ];
  const fresh = [
    { date: '2026-10-02', format: 'T20', fixture: '15th T20 vs LIO',
      bowling: { wickets: 1, runs: 34 } },
  ];
  const [row] = keepRicher(previous, fresh, 'x');
  assert.equal(row.bowling.balls, 24);
  assert.equal(row.bowling.econ, 8.5);
});

test('a re-scrape keeps a scorecard-established not-out', () => {
  const previous = [
    { date: '2026-09-30', format: 'ODI', fixture: '2nd ODI vs WI',
      batting: { runs: 223, balls: 133, out: false, outFrom: 'scorecard' } },
  ];
  // The page has no asterisk, so a fresh read always says "out".
  const fresh = [
    { date: '2026-09-30', format: 'ODI', fixture: '2nd ODI vs WI',
      batting: { runs: 223, balls: 133, out: true } },
  ];
  const [row] = keepRicher(previous, fresh, 'x');
  assert.equal(row.batting.out, false);
  assert.equal(row.batting.outFrom, 'scorecard');
});

test('a dismissal the page merely asserted is not carried', () => {
  // Only the scorecard's verdict is knowledge; carrying the page's own `out` would
  // make an un-backfilled innings look settled and let a wrong average through.
  const previous = [
    { date: '2026-09-30', format: 'ODI', fixture: '1st ODI vs WI',
      batting: { runs: 10, balls: 8, out: true } },
  ];
  const fresh = [
    { date: '2026-09-30', format: 'ODI', fixture: '1st ODI vs WI',
      batting: { runs: 10, balls: 8, out: true } },
  ];
  const [row] = keepRicher(previous, fresh, 'x');
  assert.equal(row.batting.outFrom, undefined);
});

test('the two innings of a Test are not conflated', () => {
  // Keyed on the innings number too, or a player's second-innings not-out would be
  // carried onto his first.
  const previous = [
    { date: '2026-08-30', format: 'Test', fixture: 'Test, 1st Inn', innings: 1,
      batting: { runs: 1, balls: 9, out: true, outFrom: 'scorecard' } },
    { date: '2026-08-30', format: 'Test', fixture: 'Test, 2nd Inn', innings: 2,
      batting: { runs: 25, balls: 36, out: false, outFrom: 'scorecard' } },
  ];
  const fresh = previous.map((r) => ({ ...r, batting: { runs: r.batting.runs, balls: r.batting.balls, out: true } }));
  const rows = keepRicher(previous, fresh, 'x');
  assert.equal(rows[0].batting.out, true);
  assert.equal(rows[1].batting.out, false, "the second innings' not-out is its own");
});

test('a newly scraped innings is untouched', () => {
  const previous = [
    { date: '2026-10-01', format: 'T20', fixture: 'a', batting: { runs: 5, balls: 4, out: false, outFrom: 'scorecard' } },
  ];
  const fresh = [
    ...previous.map((r) => ({ ...r, batting: { runs: 5, balls: 4, out: true } })),
    { date: '2026-10-03', format: 'T20', fixture: 'b', batting: { runs: 20, balls: 11, out: true } },
  ];
  const rows = keepRicher(previous, fresh, 'x');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].batting.outFrom, undefined, 'nothing is invented for a new row');
});

test('a short read still keeps the previous rows', () => {
  // The existing guard: a re-read that lost innings must not replace what we hold.
  const previous = [{ date: '2026-10-01', fixture: 'a' }, { date: '2026-10-02', fixture: 'b' }];
  assert.equal(keepRicher(previous, [{ date: '2026-10-01', fixture: 'a' }], 'x').length, 2);
});

/* ── losing settled innings ──
   The count check only catches a re-read that comes back smaller. It cannot see one
   that loses an old series while gaining new matches, because the total holds or
   rises — and that is not hypothetical: the series list is lazy-loaded, and reading
   it unscrolled capped every player at seven tournaments. A player who had played
   twice since would have had his July cricket quietly replaced by it. */

const DAY = 864e5;
const ago = (n, today = '2026-10-06') =>
  new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

test('a settled innings the re-read lost is put back', () => {
  const previous = [
    { date: ago(90), competition: 'TNPL 2026', fixture: 'a', batting: { runs: 50, balls: 30 } },
    { date: ago(2), competition: 'CSA T20 2026', fixture: 'c', batting: { runs: 10, balls: 8 } },
  ];
  // Same length, so the count guard passes — but July is gone and a new match is in.
  const fresh = [
    { date: ago(2), competition: 'CSA T20 2026', fixture: 'c', batting: { runs: 10, balls: 8 } },
    { date: ago(1), competition: 'CSA T20 2026', fixture: 'd', batting: { runs: 5, balls: 4 } },
  ];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.competition === 'TNPL 2026'), 'the July innings survived');
  assert.ok(rows.some((r) => r.fixture === 'd'), 'the new match was still added');
});

test('restored rows keep the newest-first order', () => {
  const previous = [{ date: ago(90), fixture: 'old', batting: { runs: 1, balls: 1 } }];
  const fresh = [{ date: ago(1), fixture: 'new', batting: { runs: 2, balls: 2 } }];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.deepEqual(rows.map((r) => r.fixture), ['new', 'old']);
});

test('a recent innings stays replaceable', () => {
  // The whole point of a re-read. Mukesh Kumar was stored at 84 (102) during an
  // innings he finished on 0 (0); protecting that figure would freeze the error in.
  const previous = [{ date: ago(0), fixture: 'live', batting: { runs: 84, balls: 102 } }];
  const fresh = [{ date: ago(0), fixture: 'live', batting: { runs: 0, balls: 1 } }];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batting.runs, 0, 'the corrected figure won');
});

test('an innings inside the settling window is not protected', () => {
  // Six days is still inside a week, so it can legitimately change or be corrected.
  const previous = [{ date: ago(6), fixture: 'recent', batting: { runs: 20, balls: 10 } }];
  const fresh = [{ date: ago(1), fixture: 'other', batting: { runs: 3, balls: 3 } }];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fixture, 'other');
});

test('a Test is well inside the window', () => {
  // Five days of play, so the cutoff has to be longer than any format can run.
  assert.ok(SETTLED_AFTER_DAYS > 5);
});

test('nothing is restored when the re-read is complete', () => {
  const previous = [{ date: ago(90), fixture: 'a', batting: { runs: 1, balls: 1 } }];
  const fresh = [
    { date: ago(90), fixture: 'a', batting: { runs: 1, balls: 1 } },
    { date: ago(1), fixture: 'b', batting: { runs: 2, balls: 2 } },
  ];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.equal(rows.length, 2, 'no duplicate of the row that was already there');
});

test('the two innings of a Test are restored separately', () => {
  // Keyed on the innings number too, or restoring one would mask the loss of the other.
  const previous = [
    { date: ago(90), fixture: 'Test', innings: 1, batting: { runs: 10, balls: 20 } },
    { date: ago(90), fixture: 'Test', innings: 2, batting: { runs: 30, balls: 40 } },
  ];
  const fresh = [
    { date: ago(90), fixture: 'Test', innings: 1, batting: { runs: 10, balls: 20 } },
    { date: ago(1), fixture: 'new', batting: { runs: 5, balls: 5 } },
  ];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-06' });
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.innings === 2), 'the second innings came back');
});
