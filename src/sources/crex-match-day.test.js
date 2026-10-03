/**
 * Multi-day attribution tests.
 *
 * The HTML fixtures here are trimmed from real CREX pages, and the two cases that
 * matter are both real:
 *
 *   - The Irani Cup Test (match 13Q7) was live on 3 October 2026 with a startDate of
 *     1 October and a page reading "Day 3 - Session 3". That is the case the whole
 *     module exists for, and the arithmetic has to land on the 3rd.
 *   - The ENG v PAK 2nd Test (VSO) had finished, and its page carries no day-session
 *     element at all. A finished match returning `day: null` is correct behaviour,
 *     not a parse failure, and the test pins that so nobody "fixes" it later.
 *
 * Run: node --test src/sources/crex-match-day.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMatchDay,
  dateOfDay,
  dayOfDate,
  resolveDay,
  recordSnapshot,
  dailyRows,
  isMultiDay,
  stillCapturable,
} from './crex-match-day.js';

/** A live multi-day match: day marker present, five-day window. */
const LIVE = `
<h1><span>J&amp;K vs ROI, Only TEST, Irani Cup 2026  live</span></h1>
<div class="day-session"><span>Day 3</span><span>-</span><span>Session 3</span></div>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"SportsEvent",
"startDate":"2026-10-01T09:30:00+05:30","endDate":"2026-10-05T17:30:00+05:30",
"eventStatus":"Live","location":{"@type":"Place","name":"Srinagar''s Ground"}}</script>`;

/** A finished match: no day marker anywhere on the page. */
const DONE = `
<h1><span>ENG vs PAK, 2nd TEST</span></h1>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"SportsEvent",
"startDate":"2026-08-27T15:30:00+05:30","endDate":"2026-08-31T17:30:00+05:30",
"eventStatus":"Finished"}</script>`;

test('reads the day and session off a live multi-day match', () => {
  const d = parseMatchDay(LIVE);
  assert.equal(d.day, 3);
  assert.equal(d.session, 3);
  assert.equal(d.startDate, '2026-10-01');
  assert.equal(d.endDate, '2026-10-05');
  assert.equal(d.status, 'Live');
  // CREX doubles the apostrophe in venue names.
  assert.equal(d.venue, "Srinagar's Ground");
});

test('a finished match reports no day, which is expected not an error', () => {
  const d = parseMatchDay(DONE);
  assert.equal(d.day, null);
  // The span is still there, and is still the only thing bounding the match.
  assert.equal(d.startDate, '2026-08-27');
  assert.equal(d.status, 'Finished');
});

test('day three of a match starting 1 Oct is 3 Oct', () => {
  // The real observation: the page said Day 3 and the date was the 3rd.
  assert.equal(dateOfDay('2026-10-01', 3), '2026-10-03');
  assert.equal(dayOfDate('2026-10-01', '2026-10-03'), 3);
  // Day 1 is the start date itself, not the day after it.
  assert.equal(dateOfDay('2026-10-01', 1), '2026-10-01');
  assert.equal(dayOfDate('2026-10-01', '2026-10-01'), 1);
});

test('crossing a month boundary', () => {
  assert.equal(dateOfDay('2026-08-30', 4), '2026-09-02');
  assert.equal(dayOfDate('2026-08-30', '2026-09-02'), 4);
});

test('the page label beats the arithmetic, so a lost day is respected', () => {
  // Four days have passed but the page says it is only day 3: a day was washed out.
  // Arithmetic would say day 4 and put the figures on the wrong date.
  const r = resolveDay({ label: 3, startDate: '2026-10-01', observedOn: '2026-10-04' });
  assert.equal(r.day, 3);
  assert.equal(r.date, '2026-10-03');
  assert.equal(r.from, 'label');
});

test('without a label the observation date places itself', () => {
  const r = resolveDay({ label: null, startDate: '2026-10-01', observedOn: '2026-10-03' });
  assert.equal(r.day, 3);
  assert.equal(r.from, 'arithmetic');
});

test('an observation outside the five days is not attributed', () => {
  const r = resolveDay({ label: null, startDate: '2026-10-01', observedOn: '2026-10-20' });
  assert.equal(r.day, null);
  assert.equal(r.from, 'unknown');
});

/* ── completed matches ──
   The one case that cannot be solved. CREX removes the day marker when a match ends,
   so a Test that finished before this project first saw it has no recoverable day
   information. The requirement is that it says so rather than guessing. */

test('a finished match is never dated by arithmetic', () => {
  // Day 2 of the match by the calendar, but the match is over: the scrape is running
  // after the fact, and "today" says nothing about when the runs were scored.
  const r = resolveDay({
    label: null, startDate: '2026-08-27', observedOn: '2026-08-28', status: 'Finished',
  });
  assert.equal(r.day, null);
  assert.equal(r.from, 'finished');
});

test('a live match with no label still falls back to arithmetic', () => {
  // The label is the better signal, but a live match mid-run without one is still
  // placeable: the day being observed is the day it is.
  const r = resolveDay({
    label: null, startDate: '2026-10-01', observedOn: '2026-10-03', status: 'Live',
  });
  assert.equal(r.day, 3);
  assert.equal(r.from, 'arithmetic');
});

/* ── a match in progress ──
   The Irani Cup Test, live on 3 October: started 1 Oct, innings 1 closed on the 2nd,
   innings 2 still being batted on the 3rd. Both innings are in one live match, and
   they must not be treated the same way. */

test('an innings that closed earlier in a live match is already final', () => {
  // Day 1-2 innings, dismissed. The match continues, but this figure cannot move:
  // badging it "in progress" because the match is on would be wrong.
  let row;
  row = recordSnapshot(row, { day: 1, date: '2026-10-01', batting: { runs: 20, balls: 40, out: false }, provisional: true });
  row = recordSnapshot(row, { day: 2, date: '2026-10-02', batting: { runs: 51, balls: 60, out: true } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', batting: { runs: 51, balls: 60, out: true } });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-02');
  assert.equal(rows[0].batting.runs, 51);
  assert.equal(rows[0].provisional, undefined);
});

test('the innings being played right now is still provisional', () => {
  let row;
  row = recordSnapshot(row, {
    day: 3, date: '2026-10-03',
    batting: { runs: 126, balls: 131, out: false },
    provisional: true,
  });
  const rows = dailyRows(row);
  assert.equal(rows[0].date, '2026-10-03');
  assert.equal(rows[0].batting.runs, 126);
  assert.equal(rows[0].provisional, true);
});

test('only a live match is worth recording against', () => {
  assert.equal(stillCapturable({ status: 'Live' }), true);
  assert.equal(stillCapturable({ status: 'Finished' }), false);
  // A failed fetch is not evidence that a match is live.
  assert.equal(stillCapturable({ status: 'Live', error: 'http 500' }), false);
  assert.equal(stillCapturable(null), false);
});

test('a match observed live then finished dates the innings by its conclusion', () => {
  // The case that actually works: days 1-3 were captured while it was being played,
  // so the day the innings ended is known. This is every future Test.
  let row;
  row = recordSnapshot(row, { day: 1, date: '2026-10-01', batting: { runs: 20, balls: 50, out: false } });
  row = recordSnapshot(row, { day: 2, date: '2026-10-02', batting: { runs: 70, balls: 180, out: false } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', batting: { runs: 145, balls: 320, out: true } });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  // The 145 is a result on the day he was dismissed, and the figure is CREX's own.
  assert.equal(rows[0].date, '2026-10-03');
  assert.equal(rows[0].batting.runs, 145);
  assert.deepEqual(rows[0].spanned, [1, 2, 3]);
});

test('isMultiDay covers the names CREX uses', () => {
  assert.equal(isMultiDay('Test'), true);
  assert.equal(isMultiDay('First Class'), true);
  assert.equal(isMultiDay('ODI'), false);
  assert.equal(isMultiDay('T20'), false);
  assert.equal(isMultiDay(undefined), false);
});

/* ── the case the user asked about ── */

test('an innings spanning two days appears once, on the day it ended, in full', () => {
  // The real Irani Cup case: 51* at stumps on day 2, dismissed for 126 on day 3.
  // The whole 126 belongs to day 3. Splitting it into "+75" is arithmetic no
  // scorecard agrees with, and a hundred should read as a hundred.
  let row;
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02',
    batting: { runs: 51, balls: 60, out: false },
  });
  row = recordSnapshot(row, {
    day: 3, date: '2026-10-03',
    batting: { runs: 126, balls: 131, out: true },
  });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-03');
  assert.equal(rows[0].day, 3);
  assert.deepEqual(rows[0].batting, { runs: 126, balls: 131, out: true });
  // The innings is over, so it is a result rather than a running figure.
  assert.equal(rows[0].provisional, undefined);
  // And it is still recorded as having taken two days.
  assert.deepEqual(rows[0].spanned, [2, 3]);
});

test('an innings still in progress shows its running figure on the latest day', () => {
  // Stumps on day 2 with the batsman 51*. The reader following the Test should see
  // 51*, badged unfinished — not an empty page.
  let row;
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02',
    batting: { runs: 51, balls: 60, out: false },
    provisional: true,
  });
  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-02');
  assert.equal(rows[0].batting.runs, 51);
  assert.equal(rows[0].batting.out, false);
  assert.equal(rows[0].provisional, true);
});

test('when the innings ends the row moves to the day it ended on', () => {
  // Day 2 alone would report 51* on the 2nd (above). Once day 3 is observed, the
  // innings is dated the 3rd and the 2nd no longer carries a row for it, so the
  // figure is never shown twice as a result.
  let row;
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02', batting: { runs: 51, balls: 60, out: false }, provisional: true,
  });
  row = recordSnapshot(row, {
    day: 3, date: '2026-10-03', batting: { runs: 126, balls: 131, out: true },
  });
  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-03');
  assert.equal(rows[0].batting.runs, 126);
});

test('a bowler who bowls across two days reports the full innings figure', () => {
  // 2-45 on day 2, finishing with 4-88. The 4-88 is the figure, dated to the last
  // day he bowled — not two rows of two wickets each.
  let row;
  row = recordSnapshot(row, { day: 2, date: '2026-10-02', bowling: { wickets: 2, runs: 45 } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', bowling: { wickets: 4, runs: 88 } });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-03');
  assert.deepEqual(rows[0].bowling, { wickets: 4, runs: 88 });
});

test('a not-out innings is dated by when its figure stopped moving', () => {
  // No dismissal to anchor on: declared on, or the match ended. The job runs daily
  // and only records days whose play is over, so a figure that has stopped moving has
  // stopped for good — day 2 is the answer, and the 112* is a result, not a running
  // score.
  let row;
  row = recordSnapshot(row, { day: 1, date: '2026-08-15', batting: { runs: 45, balls: 90, out: false }, provisional: true });
  row = recordSnapshot(row, { day: 2, date: '2026-08-16', batting: { runs: 112, balls: 210, out: false }, provisional: true });
  row = recordSnapshot(row, { day: 3, date: '2026-08-17', batting: { runs: 112, balls: 210, out: false }, provisional: true });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-08-16');
  assert.equal(rows[0].batting.runs, 112);
  assert.equal(rows[0].batting.out, false);
  // A later day saw it unchanged, which is the evidence it is final.
  assert.equal(rows[0].provisional, undefined);
});

test('a dismissed and a not-out innings are dated by the same rule', () => {
  const mk = (out) => {
    let r;
    r = recordSnapshot(r, { day: 1, date: '2026-08-15', batting: { runs: 45, balls: 90, out: false } });
    r = recordSnapshot(r, { day: 2, date: '2026-08-16', batting: { runs: 112, balls: 210, out } });
    r = recordSnapshot(r, { day: 3, date: '2026-08-17', batting: { runs: 112, balls: 210, out } });
    return dailyRows(r)[0];
  };
  assert.equal(mk(true).date, '2026-08-16');
  assert.equal(mk(false).date, '2026-08-16');
});

test('a bowling spell that does not change again is dated to its last active day', () => {
  // He bowled on days 1 and 2 and not again. The figure belongs to day 2, not to
  // day 4 when the match happened to finish.
  let row;
  row = recordSnapshot(row, { day: 1, date: '2026-10-01', bowling: { wickets: 1, runs: 20 } });
  row = recordSnapshot(row, { day: 2, date: '2026-10-02', bowling: { wickets: 3, runs: 55 } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', bowling: { wickets: 3, runs: 55 } });
  row = recordSnapshot(row, { day: 4, date: '2026-10-04', bowling: { wickets: 3, runs: 55 } });

  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-02');
  assert.deepEqual(rows[0].bowling, { wickets: 3, runs: 55 });
});

test('an innings completed on the day it began is dated that day', () => {
  let row;
  row = recordSnapshot(row, {
    day: 1, date: '2026-10-01', batting: { runs: 40, balls: 90, out: true },
  });
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02', batting: { runs: 40, balls: 90, out: true },
  });
  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-01');
  assert.deepEqual(rows[0].spanned, [1]);
});

test('re-observing a day overwrites it, keeping the read closest to stumps', () => {
  let row;
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', batting: { runs: 40, balls: 80, out: false } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', batting: { runs: 95, balls: 150, out: false } });
  const rows = dailyRows(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batting.runs, 95);
});

test('a player who did not bat produces no row', () => {
  let row;
  row = recordSnapshot(row, { day: 1, date: '2026-10-01', batting: { runs: 0, balls: 0, out: false } });
  assert.equal(dailyRows(row).length, 0);
});

test('the two innings of one Test are dated independently', () => {
  // Same player, same match, different innings: each is its own row with its own
  // end day, so a first-innings 80 on day 2 and a second-innings 20 on day 4 both
  // land where they belong.
  let first;
  first = recordSnapshot(first, { day: 1, date: '2026-10-01', batting: { runs: 30, balls: 70, out: false } });
  first = recordSnapshot(first, { day: 2, date: '2026-10-02', batting: { runs: 80, balls: 150, out: true } });
  let second;
  second = recordSnapshot(second, { day: 4, date: '2026-10-04', batting: { runs: 20, balls: 30, out: true } });

  const a = dailyRows(first)[0];
  const b = dailyRows(second)[0];
  assert.equal(a.date, '2026-10-02');
  assert.equal(a.batting.runs, 80);
  assert.equal(b.date, '2026-10-04');
  assert.equal(b.batting.runs, 20);
});

/* ── the store must not contradict itself ──
   A live match marked settled is self-perpetuating: the scrape skips a settled match,
   so it is never re-read, its figures stop updating and its TEST IN PROGRESS badge
   never appears. The Irani Cup Test was stored `status: Live, settled: true` and went
   stale exactly that way. */

test('a live match cannot be stored as settled', async () => {
  const { observe, expand } = await import('../core/match-days.js');
  const store = { rows: {} };
  observe(store, {
    playerId: 'P', matchId: '13Q7', innings: 2, day: 3, date: '2026-10-03',
    batting: { runs: 126, balls: 131, out: false },
    provisional: true,
    // A caller that gets this wrong must not be able to poison the store.
    meta: { status: 'Live', settled: true, format: 'Test', startDate: '2026-10-01' },
  });
  const row = Object.values(store.rows)[0];
  assert.equal(row.status, 'Live');
  assert.equal(row.settled, false);
  // And the badge survives to the built row.
  assert.equal(expand(store)[0].provisional, true);
});

test('a finished match keeps its settled flag', async () => {
  const { observe } = await import('../core/match-days.js');
  const store = { rows: {} };
  observe(store, {
    playerId: 'P', matchId: 'VSO', innings: 1, day: 2, date: '2026-08-28',
    batting: { runs: 80, balls: 150, out: true },
    meta: { status: 'Finished', settled: true, format: 'Test', startDate: '2026-08-27' },
  });
  assert.equal(Object.values(store.rows)[0].settled, true);
});

/* ── corrections ──
   A snapshot can change for a reason other than play: the scrape that wrote it was
   wrong and a later run corrected it. Manav Suthar's first Irani Cup innings was
   stored as "32 (54)" by a buggy parse and later read correctly as "2 (13)", which a
   plain comparison read as an overnight advance and dated to the wrong day. */

test('a corrected figure does not move the innings to a later day', () => {
  let row;
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02',
    batting: { runs: 32, balls: 54, out: true },
    bowling: { wickets: 0, runs: 32 },
  });
  row = recordSnapshot(row, {
    day: 3, date: '2026-10-03',
    batting: { runs: 2, balls: 13, out: true },
    bowling: { wickets: 0, runs: 32 },
    provisional: true,
  });

  const r = dailyRows(row)[0];
  // He was dismissed on the 2nd, so that is where the innings belongs.
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.day, 2);
  // And the figure is the corrected reading, not the one it replaced.
  assert.deepEqual(r.batting, { runs: 2, balls: 13, out: true });
  assert.deepEqual(r.bowling, { wickets: 0, runs: 32 });
});

test('a figure cannot grow after the batsman is out', () => {
  // Another reading of the same innings, not more of it.
  let row;
  row = recordSnapshot(row, { day: 2, date: '2026-10-02', batting: { runs: 40, balls: 80, out: true } });
  row = recordSnapshot(row, { day: 3, date: '2026-10-03', batting: { runs: 44, balls: 86, out: true } });
  const r = dailyRows(row)[0];
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.batting.runs, 44);
});

test('a bowler adding wickets after the batsman is out still advances the day', () => {
  // He was dismissed on day 2 but bowled on day 3: the row belongs to day 3, because
  // bowling is real new play rather than a re-reading.
  let row;
  row = recordSnapshot(row, {
    day: 2, date: '2026-10-02',
    batting: { runs: 20, balls: 40, out: true }, bowling: { wickets: 1, runs: 30 },
  });
  row = recordSnapshot(row, {
    day: 3, date: '2026-10-03',
    batting: { runs: 20, balls: 40, out: true }, bowling: { wickets: 4, runs: 72 },
  });
  const r = dailyRows(row)[0];
  assert.equal(r.date, '2026-10-03');
  assert.deepEqual(r.bowling, { wickets: 4, runs: 72 });
});
