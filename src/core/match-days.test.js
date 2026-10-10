/**
 * When a Test stops being "in progress".
 *
 * The badge used to be decided by the `status` the store recorded, which is written
 * when the match page is read and never revisited. A match observed while live kept
 * "Live" for good: the Irani Cup final ended on 5 October and its innings still read
 * TEST IN PROGRESS on the 7th, two days after the result.
 *
 * The end date CREX prints on the same page cannot go stale that way — a day that has
 * passed stays passed — so it is what settles the question.
 *
 * Run: node --test src/core/match-days.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand } from './match-days.js';

/** One stored innings, in the shape the snapshot store holds. */
const row = (over) => ({
  rows: {
    k: {
      playerId: 'p', matchId: 'M', innings: 1,
      fixture: 'Only Match Test, 1st Inn', competition: 'Irani Cup 2026',
      format: 'Test', startDate: '2026-10-01',
      days: { 2: { date: '2026-10-02', batting: { runs: 45, out: true, balls: 97 } } },
      ...over,
    },
  },
});

test('a match whose last day has passed is not in progress', () => {
  // The Irani Cup case exactly: status frozen at "Live", end date two days gone.
  const rows = expand(row({ status: 'Live', endDate: '2026-10-05' }), { today: '2026-10-07' });
  assert.equal(rows.filter((r) => r.provisional).length, 0);
});

test('a match still inside its end date stays in progress', () => {
  const rows = expand(row({ status: 'Live', endDate: '2026-10-05' }), { today: '2026-10-04' });
  assert.ok(rows.some((r) => r.provisional), 'still being played on the 4th');
});

test('the end date is inclusive — the last day is still play', () => {
  const rows = expand(row({ status: 'Live', endDate: '2026-10-05' }), { today: '2026-10-05' });
  assert.ok(rows.some((r) => r.provisional), "a result is not assumed before the day is out");
});

test('a finished status settles it with no end date', () => {
  const rows = expand(row({ status: 'Finished' }), { today: '2026-10-07' });
  assert.equal(rows.filter((r) => r.provisional).length, 0);
});

test('with neither signal, nothing is claimed to be live', () => {
  const rows = expand(row({}), { today: '2026-10-07' });
  assert.equal(rows.filter((r) => r.provisional).length, 0);
});

test('one stale row cannot revive a match another row settled', () => {
  // Rows for one match arrive in no order, and only some carry the end date. A later
  // row still marked "Live" must not re-open a match an earlier one closed.
  const store = {
    rows: {
      a: {
        playerId: 'p1', matchId: 'M', innings: 1, format: 'Test', startDate: '2026-10-01',
        status: 'Finished', endDate: '2026-10-05',
        days: { 2: { date: '2026-10-02', batting: { runs: 10, out: true, balls: 20 } } },
      },
      b: {
        playerId: 'p2', matchId: 'M', innings: 1, format: 'Test', startDate: '2026-10-01',
        status: 'Live',
        days: { 2: { date: '2026-10-02', batting: { runs: 30, out: true, balls: 40 } } },
      },
    },
  };
  assert.equal(expand(store, { today: '2026-10-07' }).filter((r) => r.provisional).length, 0);
});

test('two players in one match agree about whether it finished', () => {
  // Akash Deep's innings carried the badge while Ravichandran Smaran's did not —
  // same match, same day, rows written on different runs.
  const store = {
    rows: {
      a: {
        playerId: 'p1', matchId: 'M', innings: 1, format: 'Test', startDate: '2026-10-06',
        status: 'Live',
        days: { 1: { date: '2026-10-06', batting: { runs: 10, out: true, balls: 20 } } },
      },
      b: {
        playerId: 'p2', matchId: 'M', innings: 1, format: 'Test', startDate: '2026-10-06',
        days: { 1: { date: '2026-10-06', batting: { runs: 30, out: true, balls: 40 } } },
      },
    },
  };
  const flags = expand(store, { today: '2026-10-06' }).map((r) => Boolean(r.provisional));
  assert.equal(new Set(flags).size, 1, 'both innings say the same thing');
});

/* ── matches still being played ──
   A Test is the match most worth knowing is on, and the one the fixtures scrape
   cannot show: CREX's schedule carries only upcoming limited-overs cards, so a
   five-day match is absent for its whole duration. The store already has what is
   needed, because the scrape reads each live match's page to date its innings. */

import { inProgressMatches } from './match-days.js';

const liveRow = (over) => ({
  playerId: 'p', matchId: 'M', innings: 1, format: 'Test',
  competition: 'AUS vs SA 2026', team: 'AUS', venue: 'Kingsmead',
  startDate: '2026-10-09', endDate: '2026-10-13', status: 'Live',
  days: { 1: { date: '2026-10-09', batting: { runs: 33, out: false, balls: 72 }, provisional: true } },
  ...over,
});

test('a match being played is reported', () => {
  const m = inProgressMatches({ rows: { a: liveRow() } }, { asOf: '2026-10-10' });
  assert.equal(m.length, 1);
  assert.equal(m[0].matchId, 'M');
  assert.equal(m[0].day, 1);
  assert.equal(m[0].players.length, 1);
});

test('a finished match is dropped the moment it finishes', () => {
  // Not after five days. A Test can finish inside three, and a Sheffield Shield
  // match in the data finished four days into a five-day window — anything keyed on
  // the calendar would leave a decided match on the page as though it were still on.
  const m = inProgressMatches(
    { rows: { a: liveRow({ status: 'Finished' }) } },
    { asOf: '2026-10-10' }
  );
  assert.equal(m.length, 0);
});

test('a match whose last day has passed is dropped even if the status is stale', () => {
  // `status` is written when the page is read; a store that missed a refresh would
  // otherwise keep a long-decided match listed for ever.
  const m = inProgressMatches({ rows: { a: liveRow() } }, { asOf: '2026-10-14' });
  assert.equal(m.length, 0);
});

test('the last day of the window still counts as in progress', () => {
  const m = inProgressMatches({ rows: { a: liveRow() } }, { asOf: '2026-10-13' });
  assert.equal(m.length, 1);
});

test('a row with no status is not claimed to be live', () => {
  const m = inProgressMatches(
    { rows: { a: liveRow({ status: undefined }) } },
    { asOf: '2026-10-10' }
  );
  assert.equal(m.length, 0);
});

test('every tracked player in one match is listed under it', () => {
  const rows = {
    a: liveRow({ playerId: 'p1' }),
    b: liveRow({ playerId: 'p2', team: 'SA' }),
  };
  const [m] = inProgressMatches({ rows }, { asOf: '2026-10-10' });
  assert.equal(m.players.length, 2);
  assert.deepEqual(m.players.map((x) => x.playerId).sort(), ['p1', 'p2']);
});

test('the match day is the furthest any innings has reached', () => {
  // Two players in one match cannot be on different days of it.
  const rows = {
    a: liveRow({ playerId: 'p1', days: { 1: { date: '2026-10-09', batting: { runs: 10, balls: 20 } } } }),
    b: liveRow({ playerId: 'p2', days: { 2: { date: '2026-10-10', batting: { runs: 40, balls: 60 } } } }),
  };
  assert.equal(inProgressMatches({ rows }, { asOf: '2026-10-10' })[0].day, 2);
});

test("a player's latest figure is carried", () => {
  const [m] = inProgressMatches({ rows: { a: liveRow() } }, { asOf: '2026-10-10' });
  assert.deepEqual(m.players[0].innings[0].batting, { runs: 33, out: false, balls: 72 });
});

test('an empty store reports nothing', () => {
  assert.deepEqual(inProgressMatches({ rows: {} }, { asOf: '2026-10-10' }), []);
  assert.deepEqual(inProgressMatches(null, { asOf: '2026-10-10' }), []);
});
