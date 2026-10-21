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

/* ── a short read that still found something ──
   A re-read returning fewer innings than are held means the scrape did not see
   everything — a click that did not land, a lazily-loaded list that did not finish.
   It must not replace what is held: a run once reported "259 players, 0 failed" while
   seventy of them had silently lost every innings.

   But discarding it outright was its own bug. Tilak Varma played two T20s against the
   West Indies, his re-read came back 20 against 25 held, and the whole read went in
   the bin — the new innings with it. He sat four days behind, and eight other players
   with him, every one reported as a short read and none of them visibly wrong. */

test('a short read still contributes the innings it did find', () => {
  const previous = [
    { date: '2026-09-13', format: 'T20', fixture: '1st T20 vs AFG', batting: { runs: 8, balls: 5, out: true } },
    { date: '2026-09-15', format: 'T20', fixture: '2nd T20 vs AFG', batting: { runs: 11, balls: 11, out: true } },
    { date: '2026-09-17', format: 'T20', fixture: '3rd T20 vs AFG', batting: { runs: 29, balls: 20, out: true } },
  ];
  // Fewer rows than are held, but two of them are new.
  const fresh = [
    { date: '2026-09-13', format: 'T20', fixture: '1st T20 vs AFG', batting: { runs: 8, balls: 5, out: true } },
    { date: '2026-10-09', format: 'T20', fixture: '2nd T20 vs WI', batting: { runs: 44, balls: 18, out: true } },
  ];
  const rows = keepRicher(previous, fresh, 'tilak-varma-15Q', { today: '2026-10-13' });
  assert.equal(rows.length, 4, 'three held plus the one new');
  assert.ok(rows.some((r) => r.fixture === '2nd T20 vs WI'), 'the new innings arrived');
  for (const p of previous) {
    assert.ok(rows.some((r) => r.fixture === p.fixture), `${p.fixture} survived`);
  }
});

test('a short read with nothing new changes nothing', () => {
  const previous = [
    { date: '2026-09-13', format: 'T20', fixture: 'a', batting: { runs: 8, balls: 5, out: true } },
    { date: '2026-09-15', format: 'T20', fixture: 'b', batting: { runs: 11, balls: 11, out: true } },
  ];
  const rows = keepRicher(previous, [previous[0]], 'x', { today: '2026-10-13' });
  assert.deepEqual(rows, previous);
});

test('a short read keeps the rows newest first', () => {
  const previous = [
    { date: '2026-09-15', format: 'T20', fixture: 'b', batting: { runs: 11, balls: 11, out: true } },
    { date: '2026-09-13', format: 'T20', fixture: 'a', batting: { runs: 8, balls: 5, out: true } },
  ];
  const fresh = [{ date: '2026-10-11', format: 'T20', fixture: 'new', batting: { runs: 28, balls: 16, out: true } }];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-13' });
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-11', '2026-09-15', '2026-09-13']);
});

test('a short read does not resurrect an innings by its figures alone', () => {
  // Keyed on date, format, fixture and innings — the same key the rest of the
  // pipeline uses — so a Test's two innings stay distinct.
  const previous = [
    { date: '2026-08-30', format: 'Test', fixture: 'Test', innings: 1, batting: { runs: 16, balls: 27, out: true } },
  ];
  const fresh = [
    { date: '2026-08-30', format: 'Test', fixture: 'Test', innings: 2, batting: { runs: 39, balls: 41, out: false } },
  ];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-13' });
  assert.equal(rows.length, 2);
});

test('scorecard fields still carry across a short read', () => {
  const previous = [
    { date: '2026-09-13', format: 'T20', fixture: 'a',
      batting: { runs: 8, balls: 5, out: false, outFrom: 'scorecard' } },
    { date: '2026-09-15', format: 'T20', fixture: 'b', batting: { runs: 11, balls: 11, out: true } },
  ];
  const fresh = [{ date: '2026-10-11', format: 'T20', fixture: 'new', batting: { runs: 28, balls: 16, out: true } }];
  const rows = keepRicher(previous, fresh, 'x', { today: '2026-10-13' });
  const a = rows.find((r) => r.fixture === 'a');
  assert.equal(a.batting.out, false);
  assert.equal(a.batting.outFrom, 'scorecard');
});

test('a scorecard reading is not carried onto an innings that moved on', () => {
  // Ayush Badoni was 115* when the scorecard was last read and went on to 217.
  // Carrying that reading forward put its dismissal, fours and sixes on the bigger
  // score — reinstating "not out" onto an innings that had since ended, and
  // crediting 11 fours to one that made 22.
  const previous = [{
    date: '2026-10-18', format: 'Test', fixture: '23rd Test, 1st Inn', matchId: '146Y',
    batting: { runs: 115, balls: 149, out: false, outFrom: 'scorecard', fours: 11, sixes: 2 },
  }];
  const fresh = [{
    date: '2026-10-18', format: 'Test', fixture: '23rd Test, 1st Inn', matchId: '146Y',
    batting: { runs: 217, balls: 246, out: true },
  }];
  const [row] = keepRicher(previous, fresh, 'ayush-badoni-5P9', { today: '2026-10-20' });
  assert.equal(row.batting.runs, 217);
  assert.equal(row.batting.out, true, 'the innings had ended');
  assert.equal(row.batting.outFrom, undefined, 'and needs reading again');
  assert.equal(row.batting.fours, undefined, 'the old boundary count belonged to 115');
});

test('a scorecard reading is kept while the innings is unchanged', () => {
  // The case the carry exists for: the page gives the same figure and no asterisk,
  // so the dismissal the scorecard established has to survive.
  const previous = [{
    date: '2026-10-18', format: 'Test', fixture: 'f', matchId: '146Y',
    batting: { runs: 115, balls: 149, out: false, outFrom: 'scorecard', fours: 11, sixes: 2 },
  }];
  const fresh = [{
    date: '2026-10-18', format: 'Test', fixture: 'f', matchId: '146Y',
    batting: { runs: 115, balls: 149, out: true },
  }];
  const [row] = keepRicher(previous, fresh, 'x', { today: '2026-10-20' });
  assert.equal(row.batting.out, false, 'he was not out');
  assert.equal(row.batting.outFrom, 'scorecard');
  assert.equal(row.batting.fours, 11);
});

test('a short read updates an innings whose figure advanced', () => {
  // The merge added innings the short read found but never updated ones already held,
  // so a figure that moved on could not land. Ayush Badoni went from 115 to 217, his
  // page said 217, and every run read it and discarded it because he read short —
  // sixteen rows against eighteen, for reasons nothing to do with that innings.
  const previous = [
    { date: '2026-10-18', format: 'Test', fixture: '23rd Test, 1st Inn', matchId: '146Y',
      batting: { runs: 115, balls: 149, out: true, outFrom: 'scorecard', fours: 11, sixes: 2 } },
    { date: '2026-09-01', format: 'T20', fixture: 'a', batting: { runs: 5, balls: 4, out: true } },
    { date: '2026-09-02', format: 'T20', fixture: 'b', batting: { runs: 6, balls: 5, out: true } },
  ];
  const fresh = [
    { date: '2026-10-18', format: 'Test', fixture: '23rd Test, 1st Inn', matchId: '146Y',
      batting: { runs: 217, balls: 246, out: true } },
  ];
  const [row] = keepRicher(previous, fresh, 'ayush-badoni-5P9', { today: '2026-10-21' });
  assert.equal(row.batting.runs, 217);
  assert.equal(row.batting.balls, 246);
  assert.equal(row.batting.fours, undefined, 'the reading taken at 115 does not follow');
});

test('a short read cannot shrink a figure it already holds', () => {
  // The guard the short-read rule exists for: a half-rendered page reporting less
  // must not overwrite the fuller figure.
  const previous = [
    { date: '2026-10-18', format: 'Test', fixture: 'f', matchId: '146Y',
      batting: { runs: 115, balls: 149, out: true } },
    { date: '2026-09-01', format: 'T20', fixture: 'a', batting: { runs: 5, balls: 4, out: true } },
  ];
  const fresh = [
    { date: '2026-10-18', format: 'Test', fixture: 'f', matchId: '146Y',
      batting: { runs: 50, balls: 60, out: true } },
  ];
  const [row] = keepRicher(previous, fresh, 'x', { today: '2026-10-21' });
  assert.equal(row.batting.runs, 115);
});

test('a short read updates an advancing bowling figure too', () => {
  const previous = [
    { date: '2026-10-18', format: 'Test', fixture: 'f', matchId: 'M', bowling: { wickets: 2, runs: 30 } },
    { date: '2026-09-01', format: 'T20', fixture: 'a', batting: { runs: 5, balls: 4, out: true } },
  ];
  const fresh = [
    { date: '2026-10-18', format: 'Test', fixture: 'f', matchId: 'M', bowling: { wickets: 5, runs: 48 } },
  ];
  const [row] = keepRicher(previous, fresh, 'x', { today: '2026-10-21' });
  assert.deepEqual(row.bowling, { wickets: 5, runs: 48 });
});
