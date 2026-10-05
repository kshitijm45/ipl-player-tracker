/**
 * Career aggregates: the arithmetic, and what is refused rather than guessed.
 *
 * The two rules these pin:
 *   - aggregate from summed totals, never by averaging per-match ratios
 *   - a figure that cannot be computed is absent, not zero
 *
 * Run: node --test src/core/career-stats.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, careerFor, dismissalKnown, isBallBased } from './career-stats.js';

/** An innings whose dismissal came from the scorecard, so the average may use it. */
const bat = (runs, balls, out) => ({
  batting: { runs, balls, out, outFrom: 'scorecard' },
});
/** An innings scraped before the scorecard backfill: the dismissal is unknown. */
const batUnknown = (runs, balls) => ({ batting: { runs, balls, out: true } });
const bowl = (wickets, runs, balls) => ({ bowling: { wickets, runs, balls } });

test('batting innings, runs and strike rate come off the totals', () => {
  const { batting } = summarise([bat(50, 25, true), bat(30, 30, true)]);
  assert.equal(batting.innings, 2);
  assert.equal(batting.runs, 80);
  // 80 off 55, not the mean of 200 and 100. Averaging per-match rates weights a
  // 25-ball innings the same as a 30-ball one and gives 150 instead.
  assert.equal(batting.strikeRate, 145.45);
});

test('average divides by dismissals, not innings', () => {
  // 100 runs, three innings, one not out -> 50, not 33.33.
  const { batting } = summarise([bat(40, 30, true), bat(50, 40, false), bat(10, 10, true)]);
  assert.equal(batting.innings, 3);
  assert.equal(batting.notOuts, 1);
  assert.equal(batting.average, 50);
});

test('a batsman never dismissed has no average', () => {
  // Not an average of zero, and not an average equal to his runs.
  const { batting } = summarise([bat(30, 20, false), bat(12, 9, false)]);
  assert.equal(batting.average, null);
  assert.equal(batting.runs, 42);
  assert.equal(batting.notOuts, 2);
});

test('an unknown dismissal suppresses the average entirely', () => {
  // This is the whole point of the backfill. The error runs one way — an unrecorded
  // not-out is counted as an out — so the figure would always flatter, and nothing
  // on the page would reveal it. Better absent.
  const { batting } = summarise([bat(40, 30, true), batUnknown(50, 40)]);
  assert.equal(batting.average, null);
  assert.equal(batting.averagePending, true);
  // The figures that do not depend on dismissals are still reported.
  assert.equal(batting.innings, 2);
  assert.equal(batting.runs, 90);
  assert.equal(batting.strikeRate, 128.57);
});

test('a complete set of dismissals is not marked pending', () => {
  const { batting } = summarise([bat(40, 30, true), bat(50, 40, false)]);
  assert.equal(batting.averagePending, false);
  assert.equal(batting.average, 90);
});

test('an innings facing no balls has no strike rate', () => {
  // Fifteen innings in the real data face zero balls. Dividing by that sum is an
  // infinite strike rate, which is how a run-out off a no-ball reads as perfection.
  const { batting } = summarise([bat(0, 0, true)]);
  assert.equal(batting.innings, 1);
  assert.equal(batting.strikeRate, null);
});

test('a player who did not bat has no batting innings', () => {
  // A DNB is not an innings; counting it would deflate every average on the page.
  const { batting, bowling } = summarise([bowl(2, 24, 24)]);
  assert.equal(batting.innings, 0);
  assert.equal(bowling.innings, 1);
});

test('economy is runs per over, from the summed balls', () => {
  // 50 runs off 60 balls = 10 overs -> 5.00
  const { bowling } = summarise([bowl(1, 20, 24), bowl(2, 30, 36)]);
  assert.equal(bowling.innings, 2);
  assert.equal(bowling.wickets, 3);
  assert.equal(bowling.economy, 5);
  assert.equal(bowling.economyUnit, 'over');
});

test('bowling strike rate is balls per wicket', () => {
  const { bowling } = summarise([bowl(2, 20, 24), bowl(2, 30, 36)]);
  assert.equal(bowling.strikeRate, 15);
});

test('a wicketless bowler has no strike rate, however long the spell', () => {
  const { bowling } = summarise([bowl(0, 60, 60)]);
  assert.equal(bowling.strikeRate, null);
  assert.equal(bowling.economy, 6);
});

test('The Hundred reports runs per ball', () => {
  // A five-ball over makes "per over" meaningless, and CREX's own printed figure is
  // per five balls — recomputing per six would silently contradict the source.
  const { bowling } = summarise([bowl(1, 42, 20)], { format: '100B' });
  assert.equal(bowling.economy, 2.1);
  assert.equal(bowling.economyUnit, 'ball');
  // Strike rate is already ball-based and needs no special case.
  assert.equal(bowling.strikeRate, 20);
});

test('bowling innings with unknown balls do not corrupt the rates', () => {
  // Pre-backfill rows have no balls. They still count as innings and their wickets
  // still count, but they cannot contribute to a rate.
  const { bowling } = summarise([bowl(2, 30, 36), { bowling: { wickets: 1, runs: 20 } }]);
  assert.equal(bowling.innings, 2);
  assert.equal(bowling.wickets, 3);
  assert.equal(bowling.ratesFrom, 1);
  assert.equal(bowling.ratesPending, true);
  // 30 off 36 balls, not 50 off 36.
  assert.equal(bowling.economy, 5);
});

test('fully backfilled bowling is not marked pending', () => {
  const { bowling } = summarise([bowl(2, 30, 36)]);
  assert.equal(bowling.ratesPending, false);
  assert.equal(bowling.ratesFrom, 1);
});

test('a bowler who never bowled has no economy', () => {
  const { bowling } = summarise([bat(10, 10, true)]);
  assert.equal(bowling.innings, 0);
  assert.equal(bowling.economy, null);
  assert.equal(bowling.strikeRate, null);
});

test('highest score is reported, and not-outs count toward it', () => {
  const { batting } = summarise([bat(40, 30, true), bat(87, 50, false)]);
  assert.equal(batting.highScore, 87);
});

/* ── grouping ── */

const rows = [
  { playerId: 'p', format: 'T20', competition: 'CSA T20 2026', date: '2026-10-02', team: 'NWD', ...bat(51, 28, true) },
  { playerId: 'p', format: 'T20', competition: 'CSA T20 2026', date: '2026-09-28', team: 'NWD', ...bat(9, 7, true) },
  { playerId: 'p', format: 'T20', competition: 'The Hundred 2026', date: '2026-08-10', team: 'LDN', ...bat(20, 10, false) },
  { playerId: 'p', format: 'Test', competition: 'Duleep Trophy 2026', date: '2026-08-30', team: 'CZ', ...bat(25, 36, true) },
];

test('a career splits by format, then by tournament', () => {
  const career = careerFor(rows);
  assert.deepEqual(career.map((f) => f.format), ['T20', 'Test']);
  const t20 = career.find((f) => f.format === 'T20');
  assert.equal(t20.tournaments.length, 2);
  assert.equal(t20.total.batting.innings, 3);
  assert.equal(t20.total.batting.runs, 80);
});

test('a format total spans its tournaments', () => {
  const t20 = careerFor(rows).find((f) => f.format === 'T20');
  const csa = t20.tournaments.find((t) => t.competition === 'CSA T20 2026');
  assert.equal(csa.batting.innings, 2);
  assert.equal(csa.batting.runs, 60);
  assert.equal(csa.from, '2026-09-28');
  assert.equal(csa.to, '2026-10-02');
  assert.deepEqual(csa.teams, ['NWD']);
});

test('formats are ordered by most recent play', () => {
  // A reader wants this week's cricket first.
  assert.equal(careerFor(rows)[0].format, 'T20');
  assert.equal(careerFor(rows)[0].lastPlayed, '2026-10-02');
});

test('tournaments are ordered by most recent play', () => {
  const t20 = careerFor(rows).find((f) => f.format === 'T20');
  assert.deepEqual(t20.tournaments.map((t) => t.competition), ['CSA T20 2026', 'The Hundred 2026']);
});

test('no all-format total is produced', () => {
  // Adding a Test innings to a Hundred innings gives a number no scorecard agrees
  // with, and an economy mixing five- and six-ball overs is not a rate.
  const career = careerFor(rows);
  assert.ok(Array.isArray(career));
  assert.ok(career.every((f) => f.format && f.format !== 'All'));
});

test('a row with no format is left out rather than bucketed', () => {
  const career = careerFor([...rows, { playerId: 'p', competition: 'X', date: '2026-01-01', ...bat(5, 5, true) }]);
  assert.deepEqual(career.map((f) => f.format).sort(), ['T20', 'Test']);
});

test('the helpers say what they mean', () => {
  assert.equal(dismissalKnown({ out: true, outFrom: 'scorecard' }), true);
  assert.equal(dismissalKnown({ out: true }), false);
  assert.equal(isBallBased('100B'), true);
  assert.equal(isBallBased('T20'), false);
});
