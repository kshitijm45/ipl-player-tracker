/**
 * Placing a player in the right line-up.
 *
 * Run: node --test src/ingest-fixtures.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchLink, orderCodes, isoDate, istDate } from './ingest-fixtures.js';

test('an A-team fixture yields both side codes', () => {
  // The side tokens carry a hyphen of their own ("aus-a-vs-ind-a"), which the match
  // link pattern did not allow — so the fixture yielded no codes at all, and with no
  // codes a squad cannot be placed. Every India A player was listed under Australia A
  // as well.
  const p = parseMatchLink('/cricket-live-score/aus-a-vs-ind-a-1st-match-x-2026-match-updates-Z1');
  assert.deepEqual(p.codes, ['AUS-A', 'IND-A']);
});

test('a plain fixture still yields its codes', () => {
  const p = parseMatchLink('/cricket-live-score/ind-vs-wi-2nd-odi-x-2026-match-updates-Z2');
  assert.deepEqual(p.codes, ['IND', 'WI']);
  assert.equal(p.id, 'Z2');
});

test('codes are matched to the names, not zipped by position', () => {
  // CREX lists the sides alphabetically in the URL, so the order rarely matches the
  // display order.
  assert.deepEqual(
    orderCodes(['IND', 'WI'], 'West Indies', 'India'),
    { codeA: 'WI', codeB: 'IND' }
  );
});

test('an association code is matched to its state', () => {
  // Western Australia plays as "WACA", whose C and A come from "Cricket Association"
  // and appear nowhere in the team name — so the ordered letter test fails, both
  // codes come back null, and a squad that cannot be placed was attributed to both
  // sides.
  assert.deepEqual(
    orderCodes(['QLD', 'WACA'], 'Western Australia', 'Queensland'),
    { codeA: 'WACA', codeB: 'QLD' }
  );
});

test('A-team codes are matched to A-team names', () => {
  assert.deepEqual(
    orderCodes(['AUS-A', 'IND-A'], 'India A', 'Australia A'),
    { codeA: 'IND-A', codeB: 'AUS-A' }
  );
});

test('an ambiguous pair places neither side', () => {
  // Guessing is worse than saying nothing: a wrong side puts a player in the opposing
  // line-up, which reads as fact.
  assert.deepEqual(orderCodes(['AAA', 'AAA'], 'Alpha', 'Alpha'), { codeA: null, codeB: null });
});

test('a code that abbreviates neither name places neither', () => {
  assert.deepEqual(orderCodes(['XYZ', 'PQR'], 'India', 'Australia'), { codeA: null, codeB: null });
});

test('the initials fallback does not fire on a one-word name', () => {
  // One letter matches far too loosely to place anyone on.
  assert.deepEqual(orderCodes(['QQQ', 'ZZZ'], 'Queensland', 'Zimbabwe'), { codeA: null, codeB: null });
});

test('a date heading becomes an iso date', () => {
  assert.equal(isoDate('Fri, 2 Oct 2026'), '2026-10-02');
  assert.equal(isoDate('nonsense'), null);
});

test('today is read on the IST clock', () => {
  assert.match(istDate(), /^\d{4}-\d{2}-\d{2}$/);
});
