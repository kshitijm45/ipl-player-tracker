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

/* ── defence in depth ──
   The discipline label cannot be trusted on its own. The tab click is wrapped in a
   catch, the panel re-renders asynchronously, and a card re-selection can land before
   the switch takes effect — so the loop can believe it is on Batting while the Bowling
   table is still on screen. That is how Anshul Kamboj's 0-82 was published as a score
   of 82 (54) even after the label was being passed correctly. */

test('a batting figure equal to the runs conceded is dropped', async () => {
  // The signature of one number read twice: CREX's bowling view prints "0-82" and
  // "82 (54)" for the same spell. 82 runs off 54 balls alongside exactly 82 conceded
  // is not something a scorecard produces.
  const { CrexSource } = await import('./crex.js');
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./crex.js', import.meta.url), 'utf8'));
  const mergeViews = new Function('return ' + src.match(/function mergeViews[\s\S]*?\n\}/)[0])();

  const merged = mergeViews(
    { bowling: { wickets: 0, runs: 82 } },
    { batting: { runs: 82, out: true, balls: 54 } }
  );
  assert.equal(merged.batting, undefined);
  assert.deepEqual(merged.bowling, { wickets: 0, runs: 82 });
  assert.ok(CrexSource);
});

test('a genuine innings alongside a different bowling figure survives', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./crex.js', import.meta.url), 'utf8'));
  const mergeViews = new Function('return ' + src.match(/function mergeViews[\s\S]*?\n\}/)[0])();

  const merged = mergeViews(
    { bowling: { wickets: 0, runs: 82 } },
    { batting: { runs: 17, out: true, balls: 9 } }
  );
  assert.deepEqual(merged.batting, { runs: 17, out: true, balls: 9 });
  assert.deepEqual(merged.bowling, { wickets: 0, runs: 82 });
});

test('a wicketless maiden does not erase a genuine duck', async () => {
  // Both zero, so the runs match — but there is no figure being double-read here and
  // nothing should be dropped. The guard only fires on a non-zero concession.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./crex.js', import.meta.url), 'utf8'));
  const mergeViews = new Function('return ' + src.match(/function mergeViews[\s\S]*?\n\}/)[0])();

  const merged = mergeViews(
    { bowling: { wickets: 0, runs: 0 } },
    { batting: { runs: 0, out: true, balls: 3 } }
  );
  assert.deepEqual(merged.batting, { runs: 0, out: true, balls: 3 });
});
