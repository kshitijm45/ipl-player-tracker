/**
 * Row parsing: keeping a bowling figure out of the batting column.
 *
 * The bug these pin is real and was visible on the published page. Mukesh Choudhary
 * took 5-78 in the Irani Cup Test and the site credited him with "78 (114)" as well —
 * a score he never made, 78 being the runs he conceded. CREX reads one innings twice,
 * once per discipline tab, and the Bowling view prints an economy figure in the same
 * "N (M)" shape a batting innings uses. Nothing recorded which view a row came from,
 * so the two were indistinguishable.
 *
 * Run: node --test src/sources/crex-row.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchRow } from './crex.js';

const series = { name: 'Irani Cup 2026', playedFor: 'ROI' };
const F = 'Only Match Test, 1st Inn';

test('a bowling-view "N (M)" is not stored as a batting innings', () => {
  // Mukesh Choudhary took 5-78 in the Irani Cup. The Bowling view also prints
  // "78 (114)", which was being parsed as a batting innings — a score he never
  // made, 78 being the runs he conceded. He actually batted 2 (14).
  const r = parseMatchRow({ match: F, date: '1 Oct', score: '78 (114)', series, discipline: 'Bowling' });
  assert.equal(r.batting, undefined);
});

test('the batting view still yields a batting innings', () => {
  const r = parseMatchRow({ match: F, date: '1 Oct', score: '2 (14)', series, discipline: 'Batting' });
  assert.deepEqual(r.batting, { runs: 2, out: true, balls: 14 });
});

test('a wickets figure is read from either view', () => {
  for (const d of ['Bowling', 'Batting', undefined]) {
    const r = parseMatchRow({ match: F, date: '1 Oct', score: '5-78', series, discipline: d });
    assert.deepEqual(r.bowling, { wickets: 5, runs: 78 });
  }
});

test('with no discipline given, "N (M)" is still a batting innings', () => {
  // Callers that do not know the view keep the old behaviour, so nothing that
  // worked before regresses.
  const r = parseMatchRow({ match: F, date: '1 Oct', score: '44 (28)', series });
  assert.deepEqual(r.batting, { runs: 44, out: true, balls: 28 });
});

test('the innings number is read off the fixture', () => {
  assert.equal(parseMatchRow({ match: 'Only Match Test, 2nd Inn', date: '1 Oct', score: '9* (47)', series, discipline: 'Batting' }).innings, 2);
});
