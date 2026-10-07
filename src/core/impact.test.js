/**
 * Ordering performances.
 *
 * These pin comparisons rather than numbers, because the score is ordinal: what
 * matters is that the better performance sorts above the worse one, and the exact
 * value is never shown and free to change.
 *
 * Each case below is one the old `runs + wickets * 25` got wrong on the page.
 *
 * Run: node --test src/core/impact.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impact, describe, parFor, PAR } from './impact.js';

const bat = (runs, balls, format = 'T20', out = true) => ({ format, batting: { runs, balls, out } });
const bowl = (wickets, runs, balls, format = 'T20') => ({ format, bowling: { wickets, runs, balls } });

test('a faster innings beats a slower one of the same size', () => {
  // The old score could not tell these apart at all.
  assert.ok(impact(bat(50, 25)) > impact(bat(50, 60)));
});

test('a big ODI hundred beats an expensive five-for', () => {
  // 125 off 79 sat below 5/80 off 18.2 because a wicket was flatly worth 25 runs.
  const hundred = bat(125, 79, 'ODI');
  const fiveFor = { format: 'ODI', bowling: { wickets: 5, runs: 80, balls: 110 } };
  assert.ok(impact(hundred) > impact(fiveFor));
});

test('an economical spell beats an expensive one with the same wickets', () => {
  // 3/62 off twenty overs outranked a 76 before. Now it does not even match 3/20.
  assert.ok(impact(bowl(3, 20, 24)) > impact(bowl(3, 62, 120)));
});

test('a wicket is worth more in a Test than in a T10', () => {
  assert.ok(PAR.Test.wicket > PAR.T10.wicket);
  assert.ok(impact(bowl(2, 30, 60, 'Test')) > impact(bowl(2, 30, 60, 'T10')));
});

test('a strike rate is read against its own format', () => {
  // 60 off 60 is a poor T20 innings and a brisk Test one.
  const t20 = impact({ format: 'T20', batting: { runs: 60, balls: 60, out: true } });
  const test = impact({ format: 'Test', batting: { runs: 60, balls: 60, out: true } });
  assert.ok(test > t20);
});

test('an allrounder beats either half of himself', () => {
  const both = { format: 'T20', batting: { runs: 40, balls: 25, out: true }, bowling: { wickets: 2, runs: 20, balls: 24 } };
  assert.ok(impact(both) > impact(bat(40, 25)));
  assert.ok(impact(both) > impact(bowl(2, 20, 24)));
});

test('a substantial not-out is worth something, a trivial one is not', () => {
  assert.ok(impact(bat(40, 25, 'T20', false)) > impact(bat(40, 25, 'T20', true)));
  // 4 not out off 2 would otherwise push tail-enders up the list.
  assert.equal(impact(bat(4, 2, 'T20', false)), impact(bat(4, 2, 'T20', true)));
});

test('a wicketless spell can still beat a wicketless expensive one', () => {
  assert.ok(impact(bowl(0, 10, 24)) > impact(bowl(0, 50, 24)));
});

test('a figure with no balls bowled ranks on wickets alone', () => {
  // Pre-backfill rows have no balls; the economy term is skipped rather than guessed,
  // the same rule the career stats follow.
  const unknown = { format: 'T20', bowling: { wickets: 3, runs: 30 } };
  assert.equal(impact(unknown), 3 * parFor('T20').wicket);
});

test('a did-not-bat is worth nothing', () => {
  assert.equal(impact({ format: 'T20' }), 0);
  assert.equal(impact(null), 0);
});

test('an unknown format does not throw', () => {
  assert.ok(Number.isFinite(impact({ format: 'Hundred-ish', batting: { runs: 10, balls: 5, out: true } })));
});

test('a duck off one ball ranks below a duck off thirty', () => {
  // Surviving thirty balls for nothing is worth more than nicking off first ball,
  // which the runs-only version could not express either.
  assert.ok(impact(bat(0, 30, 'Test')) > impact(bat(0, 1, 'Test')));
});

test('the description says what happened, not what it scored', () => {
  assert.equal(describe(bat(66, 31)), '66 off 31');
  assert.equal(describe(bat(40, 25, 'T20', false)), '40* off 25');
  assert.equal(describe(bowl(3, 20, 24)), '3/20 in 4.0 ov');
  assert.equal(
    describe({ format: 'T20', batting: { runs: 40, balls: 25, out: true }, bowling: { wickets: 2, runs: 20, balls: 24 } }),
    '40 off 25 & 2/20 in 4.0 ov'
  );
});
