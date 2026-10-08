/**
 * Dropping a row filed under a series it cannot belong to.
 *
 * A row's tournament comes from the series card the table was read under, and where
 * two cards overlap in time the window guess can pick the wrong one. Jack Edwards's
 * Sheffield Shield innings for New South Wales was filed under "AUS vs SA 2026" —
 * whose card spans Sep 24 to Oct 31 and so contains the date — and the page showed a
 * domestic match as an international one.
 *
 * The existing guard cannot see it: it reads the opponent out of the fixture, and a
 * multi-day fixture names none. "2nd Test, 1st Inn" contradicts nothing.
 *
 * The match URL does. CREX builds it from the sides and the competition, so a
 * bilateral series whose own two codes appear nowhere in the URL is not this match's
 * series. Only bilateral labels can be checked this way — a tournament name says
 * nothing about who played.
 *
 * Run: node --test src/core/merge.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePerformances } from './merge.js';

const row = (over) => ({
  playerId: 'p', date: '2026-10-07', format: 'Test',
  batting: { runs: 20, balls: 40, out: true },
  ...over,
});

const keep = (r) => mergePerformances({ crexRows: [r], today: '2026-10-09' }).length;

test('a Sheffield Shield innings is not kept under a touring series', () => {
  assert.equal(
    keep(row({
      competition: 'AUS vs SA 2026',
      fixture: '2nd Test, 1st Inn',
      matchUrl: '/cricket-live-score/nsw-vs-tas-2nd-match-sheffield-shield-2026-27-match-updates-133V',
    })),
    0
  );
});

test('a genuine bilateral Test survives', () => {
  assert.equal(
    keep(row({
      competition: 'PAK vs ENG 2026',
      fixture: '2nd Test, 1st Inn',
      matchUrl: '/cricket-live-score/pak-vs-eng-2nd-test-england-tour-of-pakistan-2026-match-updates-X1',
    })),
    1
  );
});

test('the side order in the url does not matter', () => {
  // CREX lists the sides alphabetically, not in the label's order.
  assert.equal(
    keep(row({
      competition: 'IND vs WI 2026',
      fixture: '2nd Test, 1st Inn',
      matchUrl: '/cricket-live-score/wi-vs-ind-2nd-test-west-indies-tour-of-india-2026-match-updates-X2',
    })),
    1
  );
});

test('an A-team series matches its own codes', () => {
  assert.equal(
    keep(row({
      competition: 'AUS-A vs IND-A 2026',
      fixture: '1st Test, 1st Inn',
      matchUrl: '/cricket-live-score/aus-a-vs-ind-a-1st-match-india-a-tour-of-australia-2026-match-updates-X3',
    })),
    1
  );
});

test('a tournament label is never contradicted this way', () => {
  // "CSA T20 2026" names no sides, so the URL cannot disagree with it.
  assert.equal(
    keep(row({
      competition: 'CSA T20 2026',
      format: 'T20',
      fixture: '15th T20 vs LIO',
      matchUrl: '/cricket-live-score/lio-vs-nwd-15th-match-csa-pro-t20-cup-2026-match-updates-X4',
    })),
    1
  );
});

test('a row with no match url is left alone', () => {
  // Rows scraped before the href was kept cannot be checked, and an unverifiable row
  // is not a wrong one.
  assert.equal(keep(row({ competition: 'AUS vs SA 2026', fixture: '2nd Test, 1st Inn' })), 1);
});

test('the opponent check still works where the fixture names one', () => {
  // The original guard, unchanged: a fixture naming a side its competition never
  // mentions is self-inconsistent.
  assert.equal(
    keep(row({ competition: 'IND vs JPN 2026', format: 'T20', fixture: '1st T20 vs AFG' })),
    0
  );
});
