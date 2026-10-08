/**
 * Re-dating a Test innings must not drop what the scorecard added.
 *
 * Every Test innings takes the re-dating path: the scraped row is replaced by one
 * built from the day snapshots, so the innings appears on the day it ended rather
 * than the day the match began. Those snapshots predate the scorecard read, so the
 * replacement carries no dismissal, no balls bowled and no award.
 *
 * Ishan Kishan's five Duleep innings were fully enriched in `data/` and still
 * published with no average, because the enriched rows were thrown away at exactly
 * this step. Nothing upstream looked wrong: the data was right, the model was right,
 * and the published figure was still a dash.
 *
 * Run: node --test src/build-index.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The carry-over, lifted from the build so it can be exercised without running the
 * whole pipeline. It mirrors the loop in `buildIndex`.
 */
function carryEnrichment(crexRows, dayRows) {
  const byKey = new Map();
  for (const r of crexRows) {
    if (!r.matchId) continue;
    byKey.set(`${r.playerId}|${r.matchId}|${r.innings ?? 1}`, r);
  }
  for (const r of dayRows) {
    const src = byKey.get(`${r.playerId}|${r.matchId}|${r.inningsNo ?? 1}`);
    if (!src) continue;
    if (src.batting?.outFrom === 'scorecard' && r.batting) {
      r.batting = { ...r.batting, out: src.batting.out, outFrom: 'scorecard' };
    }
    if (src.bowling?.balls != null && r.bowling) {
      r.bowling = { ...r.bowling, balls: src.bowling.balls };
    }
    if (src.playerOfMatch) r.playerOfMatch = true;
  }
  return dayRows;
}

const scraped = {
  playerId: 'p', matchId: 'M', innings: 2, format: 'Test',
  date: '2026-08-30',
  batting: { runs: 39, balls: 41, out: false, outFrom: 'scorecard' },
  playerOfMatch: true,
};

/** What the snapshot store produces: right date, figures from the day's play. */
const redated = () => ({
  playerId: 'p', matchId: 'M', inningsNo: 2, format: 'Test',
  date: '2026-09-01',
  batting: { runs: 39, balls: 41, out: true },
  multiDay: true,
});

test('the dismissal survives re-dating', () => {
  const [row] = carryEnrichment([scraped], [redated()]);
  assert.equal(row.batting.out, false, 'he was not out');
  assert.equal(row.batting.outFrom, 'scorecard', 'and the average may use it');
});

test('the re-dated date is kept, not the scraped one', () => {
  // The whole point of the replacement: the innings ended on 1 September.
  const [row] = carryEnrichment([scraped], [redated()]);
  assert.equal(row.date, '2026-09-01');
});

test('balls bowled survive re-dating', () => {
  const src = { playerId: 'p', matchId: 'M', innings: 1, bowling: { wickets: 2, runs: 30, balls: 60 } };
  const day = { playerId: 'p', matchId: 'M', inningsNo: 1, bowling: { wickets: 2, runs: 30 } };
  const [row] = carryEnrichment([src], [day]);
  assert.equal(row.bowling.balls, 60);
});

test('the award survives re-dating', () => {
  const [row] = carryEnrichment([scraped], [redated()]);
  assert.equal(row.playerOfMatch, true);
});

test('the two innings of a Test are carried separately', () => {
  // Keyed on the innings number, or one innings' dismissal lands on the other.
  const first = { playerId: 'p', matchId: 'M', innings: 1, batting: { runs: 16, balls: 27, out: true, outFrom: 'scorecard' } };
  const second = { ...scraped };
  const days = [
    { playerId: 'p', matchId: 'M', inningsNo: 1, batting: { runs: 16, balls: 27, out: true } },
    { playerId: 'p', matchId: 'M', inningsNo: 2, batting: { runs: 39, balls: 41, out: true } },
  ];
  const rows = carryEnrichment([first, second], days);
  assert.equal(rows[0].batting.out, true);
  assert.equal(rows[1].batting.out, false, "the second innings' not-out is its own");
});

test('an unenriched scraped row contributes nothing', () => {
  const bare = { playerId: 'p', matchId: 'M', innings: 2, batting: { runs: 39, balls: 41, out: true } };
  const [row] = carryEnrichment([bare], [redated()]);
  assert.equal(row.batting.outFrom, undefined, 'the page’s own `out` is not knowledge');
});

test('a re-dated row with no scraped match is left alone', () => {
  const [row] = carryEnrichment([], [redated()]);
  assert.equal(row.batting.outFrom, undefined);
  assert.equal(row.date, '2026-09-01');
});

/* ── a day of play that has not finished ──
   Multi-day rows are exempt from the blanket "nothing from today" rule, because the
   match page's `Day N` label proves the day was reached — a day of Test cricket in
   Australia finishes long before the next IST midnight, and withholding it would show
   an empty page for a match three days old.

   Reached is not finished, though, and the exemption read it as if it were: a figure
   snapshotted mid-session was published the same day, so Jack Edwards led 8 October
   with 0/20 off a spell still being bowled. */

function tooEarly(row, today) {
  const d = String(row?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (row?.multiDay) {
    if (d === today && row.provisional) return true;
    return d > today;
  }
  return d >= today;
}

test("today's play is withheld while it is still unsettled", () => {
  assert.equal(tooEarly({ date: '2026-10-08', multiDay: true, provisional: true }, '2026-10-08'), true);
});

test("today's play is shown once it has settled", () => {
  // A day that finished early enough for the scrape to see it close.
  assert.equal(tooEarly({ date: '2026-10-08', multiDay: true }, '2026-10-08'), false);
});

test('a day already behind us is shown whatever its flag says', () => {
  // The case the exemption exists for: the match is still running, but this day of
  // it is over and its figures are final.
  assert.equal(tooEarly({ date: '2026-10-07', multiDay: true, provisional: true }, '2026-10-08'), false);
});

test('a future day is never shown', () => {
  assert.equal(tooEarly({ date: '2026-10-09', multiDay: true }, '2026-10-08'), true);
});

test('limited-overs still waits a full day', () => {
  // Unchanged: CREX gives no signal that a limited-overs innings has ended, so
  // nothing from today is trusted at all.
  assert.equal(tooEarly({ date: '2026-10-08' }, '2026-10-08'), true);
  assert.equal(tooEarly({ date: '2026-10-07' }, '2026-10-08'), false);
});
