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
import { cacheMs, keepRicher } from './ingest-crex.js';

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
