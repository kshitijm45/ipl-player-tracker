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
